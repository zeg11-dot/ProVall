// Once both the business and the customer have agreed on a transaction,
// the customer calls this to get a Stripe Checkout link. The session is
// created directly on the business's connected account (a "direct charge"),
// so the business is the merchant of record and funds settle straight to
// their own Stripe balance.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

    // Scoped to the caller's JWT: RLS guarantees they can only read
    // transactions they are actually a party to.
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = userData.user;

    const { transaction_id, success_url, cancel_url } = await req.json();
    if (!transaction_id || !success_url || !cancel_url) {
      return new Response(
        JSON.stringify({ error: "transaction_id, success_url and cancel_url are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: transaction, error: txError } = await userClient
      .from("transactions")
      .select("*")
      .eq("id", transaction_id)
      .single();
    if (txError || !transaction) {
      return new Response(JSON.stringify({ error: "Transaction not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (transaction.customer_id !== user.id) {
      return new Response(
        JSON.stringify({ error: "Only the customer on this transaction can pay it" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (transaction.status !== "ready_to_charge") {
      return new Response(
        JSON.stringify({
          error: `Transaction is not ready to charge (status: ${transaction.status}). Both parties must agree first.`,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Service role: needed to read the business's Stripe account id (the
    // customer has no direct SELECT access to the businesses table) and to
    // record the checkout session id back on the transaction.
    const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: business, error: bizError } = await adminClient
      .from("businesses")
      .select("stripe_account_id, stripe_onboarding_complete, name")
      .eq("id", transaction.business_id)
      .single();
    if (bizError || !business?.stripe_account_id || !business.stripe_onboarding_complete) {
      return new Response(
        JSON.stringify({ error: "Business has not completed Stripe onboarding yet" }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: transaction.currency,
              unit_amount: transaction.amount_cents,
              product_data: {
                name: transaction.description || `Payment to ${business.name}`,
              },
            },
            quantity: 1,
          },
        ],
        success_url,
        cancel_url,
        metadata: { transaction_id: transaction.id },
      },
      { stripeAccount: business.stripe_account_id },
    );

    const { error: updateError } = await adminClient
      .from("transactions")
      .update({
        status: "checkout_created",
        stripe_checkout_session_id: session.id,
      })
      .eq("id", transaction.id);
    if (updateError) {
      console.error("Failed to record checkout session on transaction:", updateError);
    }

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
