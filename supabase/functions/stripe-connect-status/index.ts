// supabase/functions/stripe-connect-status/index.ts
//
// Called when the business console loads, and right after a rep returns
// from Stripe's hosted onboarding. Pulls the live status directly from
// Stripe and syncs it into business_payment_connections.

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

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

    const { data: connection } = await supabaseAdmin
      .from("business_payment_connections")
      .select("stripe_account_id")
      .eq("business_id", user.id)
      .eq("provider", "stripe")
      .maybeSingle();

    if (!connection) {
      return new Response(JSON.stringify({ connected: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const account = await stripe.accounts.retrieve(connection.stripe_account_id);
    const status = account.charges_enabled ? "complete"
      : account.requirements?.disabled_reason ? "restricted"
      : "pending";

    await supabaseAdmin
      .from("business_payment_connections")
      .update({
        onboarding_status: status,
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        updated_at: new Date().toISOString(),
      })
      .eq("business_id", user.id)
      .eq("provider", "stripe");

    return new Response(JSON.stringify({
      connected: true,
      status,
      chargesEnabled: account.charges_enabled,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[stripe-connect-status]", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
