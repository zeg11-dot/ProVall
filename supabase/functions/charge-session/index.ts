// supabase/functions/charge-session/index.ts
//
// Triggered by the BUSINESS side the moment a session flips to
// status:'resolved' with resolution_status:'approved' and
// session_type:'payment'. Takes only a session_id — everything else is
// re-verified server-side against the database directly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const VGS_OUTBOUND_BASE_URL = Deno.env.get("VGS_OUTBOUND_BASE_URL")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;

function findField(fields: { label: string; value: string }[], label: string) {
  return fields.find((f) => f.label === label)?.value || "";
}

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
    if (session.session_type !== "payment" || !session.amount_cents || session.amount_cents <= 0) {
      return new Response(JSON.stringify({ error: "Not a chargeable payment session" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (session.status !== "resolved" || session.resolution_status !== "approved") {
      return new Response(JSON.stringify({ error: "Session was not approved by the caller" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (session.payment_status === "succeeded" || session.payment_status === "processing") {
      return new Response(JSON.stringify({ error: "Already processed", status: session.payment_status }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: connection } = await supabaseAdmin
      .from("business_payment_connections")
      .select("stripe_account_id, charges_enabled")
      .eq("business_id", user.id)
      .eq("provider", "stripe")
      .maybeSingle();

    if (!connection || !connection.charges_enabled) {
      return new Response(JSON.stringify({ error: "Stripe account not connected or not yet enabled" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    await supabaseAdmin.from("sessions").update({ payment_status: "processing" }).eq("id", session_id);

    const fields = session.resolved_fields || [];
    const cardNumberAlias = findField(fields, "Card number");
    const cardExpAlias = findField(fields, "Card expiration");
    const cvvAlias = findField(fields, "CVV");
    const nameOnCard = findField(fields, "Name on card");
    const zip = findField(fields, "ZIP code");

    if (!cardNumberAlias || !cardExpAlias || !cvvAlias) {
      await supabaseAdmin.from("sessions").update({
        payment_status: "failed",
        payment_error: "Card fields were not part of this session's approved request.",
      }).eq("id", session_id);
      return new Response(JSON.stringify({ error: "Missing card fields on this session" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // NOTE: Stripe wants exp_month/exp_year separately; your vault stores one
    // combined "Card expiration" value. The VGS outbound route must be
    // configured to reveal that one alias into both fields — confirm this
    // with VGS support if it isn't self-serve on your plan.

    const body = new URLSearchParams({
      amount: String(session.amount_cents),
      currency: session.currency || "usd",
      "payment_method_data[type]": "card",
      "payment_method_data[card][number]": cardNumberAlias,
      "payment_method_data[card][exp_month]": cardExpAlias,
      "payment_method_data[card][exp_year]": cardExpAlias,
      "payment_method_data[card][cvc]": cvvAlias,
      "payment_method_data[billing_details][name]": nameOnCard,
      "payment_method_data[billing_details][address][postal_code]": zip,
      confirm: "true",
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
    });

    const stripeResp = await fetch(`${VGS_OUTBOUND_BASE_URL}/v1/payment_intents`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
        "Stripe-Account": connection.stripe_account_id,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const result = await stripeResp.json();

    if (!stripeResp.ok) {
      await supabaseAdmin.from("sessions").update({
        payment_status: "failed",
        payment_error: result?.error?.message || "Charge failed",
      }).eq("id", session_id);
      return new Response(JSON.stringify({ error: result?.error?.message || "Charge failed" }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    await supabaseAdmin.from("sessions").update({
      payment_status: "succeeded",
      stripe_payment_intent_id: result.id,
    }).eq("id", session_id);

    return new Response(JSON.stringify({ success: true, payment_intent_id: result.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[charge-session]", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
