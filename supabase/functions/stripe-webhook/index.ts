// Single Stripe webhook endpoint for this platform. Configure it in the
// Stripe Dashboard to listen to events on the platform account (for none,
// currently) AND on connected accounts (for account.updated,
// checkout.session.completed, checkout.session.expired) — see
// supabase/README.md for the exact setup steps.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const adminClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response(`Webhook signature verification failed`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const transactionId = session.metadata?.transaction_id;
        if (transactionId) {
          const { error } = await adminClient
            .from("transactions")
            .update({
              status: "paid",
              paid_at: new Date().toISOString(),
              stripe_payment_intent_id:
                typeof session.payment_intent === "string" ? session.payment_intent : null,
            })
            .eq("id", transactionId)
            .eq("stripe_checkout_session_id", session.id);
          if (error) console.error("Failed to mark transaction paid:", error);
        }
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        const transactionId = session.metadata?.transaction_id;
        if (transactionId) {
          const { error } = await adminClient
            .from("transactions")
            .update({ status: "failed" })
            .eq("id", transactionId)
            .eq("stripe_checkout_session_id", session.id);
          if (error) console.error("Failed to mark transaction failed:", error);
        }
        break;
      }

      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        const { error } = await adminClient
          .from("businesses")
          .update({
            stripe_onboarding_complete: Boolean(account.charges_enabled && account.details_submitted),
          })
          .eq("stripe_account_id", account.id);
        if (error) console.error("Failed to update business onboarding status:", error);
        break;
      }

      default:
        // Ignore anything we don't act on.
        break;
    }
  } catch (err) {
    console.error("Error handling webhook event:", err);
    return new Response("Webhook handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
