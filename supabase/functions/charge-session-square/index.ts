// supabase/functions/charge-session-square/index.ts
//
// Square's own Web Payments SDK tokenizes the card entirely client-side.
// By the time this function runs, the caller's browser has already
// produced a one-time payment token (square_payment_token on the session
// row). This re-verifies the session is legitimately approved, then hands
// that token to Square's CreatePayment API.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SQUARE_ENV = Deno.env.get("SQUARE_ENVIRONMENT") || "sandbox";
const SQUARE_API_HOST = SQUARE_ENV === "production"
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";
const SQUARE_VERSION = "2025-01-23";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const { session_id } = await req.json();
    if (!session_id) {
      return new Response(JSON.stringify({ error: "session_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: session, error: sessionErr } = await supabaseAdmin
      .from("sessions")
      .select("*")
      .eq("id", session_id)
      .single();

    if (sessionErr || !session) {
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (session.business_id !== user.id) {
      return new Response(JSON.stringify({ error: "Not your session" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (session.payment_processor !== "square") {
      return new Response(JSON.stringify({ error: "This session isn't set up for Square" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (session.session_type !== "payment" || !session.amount_cents || session.amount_cents <= 0) {
      return new Response(JSON.stringify({ error: "Not a chargeable payment session" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (session.status !== "resolved" || session.resolution_status !== "approved") {
      return new Response(JSON.stringify({ error: "Session was not approved by the caller" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (session.payment_status === "succeeded" || session.payment_status === "processing") {
      return new Response(JSON.stringify({ error: "Already processed", status: session.payment_status }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!session.square_payment_token) {
      return new Response(JSON.stringify({ error: "No Square payment token was captured for this session" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: connection } = await supabaseAdmin
      .from("business_payment_connections")
      .select("square_access_token, square_location_id, charges_enabled")
      .eq("business_id", user.id)
      .eq("provider", "square")
      .maybeSingle();

    if (!connection || !connection.charges_enabled || !connection.square_location_id) {
      return new Response(JSON.stringify({ error: "Square account not connected or not yet enabled" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    await supabaseAdmin.from("sessions").update({ payment_status: "processing" }).eq("id", session_id);

    const squareResp = await fetch(`${SQUARE_API_HOST}/v2/payments`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${connection.square_access_token}`,
        "Square-Version": SQUARE_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_id: session.square_payment_token,
        idempotency_key: session_id,
        amount_money: { amount: session.amount_cents, currency: (session.currency || "usd").toUpperCase() },
        location_id: connection.square_location_id,
      }),
    });

    const result = await squareResp.json();

    if (!squareResp.ok) {
      const message = result?.errors?.[0]?.detail || "Charge failed";
      await supabaseAdmin.from("sessions").update({
        payment_status: "failed",
        payment_error: message,
      }).eq("id", session_id);
      return new Response(JSON.stringify({ error: message }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    await supabaseAdmin.from("sessions").update({
      payment_status: "succeeded",
      square_payment_id: result.payment?.id || null,
    }).eq("id", session_id);

    return new Response(JSON.stringify({ success: true, payment_id: result.payment?.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[charge-session-square]", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
