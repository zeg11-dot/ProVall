# ProVall payments backend (Stripe Connect on Supabase)

This is a marketplace payments setup, not a single-merchant checkout:

- Each **business** on ProVall onboards its own Stripe **Express connected
  account**. They are the merchant of record for their own customers.
- A **transaction** is created between a business and a customer for an
  agreed dollar amount. It only becomes chargeable once **both**
  `business_agreed` and `customer_agreed` are true (enforced in the
  database, not just the app).
- Once ready, the customer is sent to a Stripe Checkout session created
  directly on the business's connected account, so the money settles to
  the business's own Stripe balance — ProVall never holds the funds.

## What's here

- `migrations/` — `businesses` and `transactions` tables, RLS policies, and
  triggers that enforce the two-sided agreement.
- `functions/stripe-connect-onboard` — creates/resumes a business's Stripe
  Express account and returns a hosted onboarding link.
- `functions/create-transaction-checkout` — once a transaction is
  `ready_to_charge`, creates the Stripe Checkout session for the customer.
- `functions/stripe-webhook` — single webhook endpoint: marks a
  transaction `paid`/`failed` and updates a business's onboarding status.

## One-time setup

1. **Link this repo to the Supabase project** (project ref
   `kdsjgzroyrcycckgkumb`, already visible in your Supabase dashboard):

   ```bash
   supabase login
   supabase link --project-ref kdsjgzroyrcycckgkumb
   ```

2. **Apply the database migration:**

   ```bash
   supabase db push
   ```

3. **Set secrets** (use your real Stripe **platform account** keys — this
   is the account that owns the connected businesses, found in the Stripe
   Dashboard under Developers → API keys). Use a restricted/test key while
   developing, then swap to live keys for production:

   ```bash
   supabase secrets set STRIPE_SECRET_KEY=sk_live_your_actual_key_here
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_your_webhook_signing_secret
   ```

   `STRIPE_WEBHOOK_SECRET` comes from step 5 below — you'll circle back
   here after creating the webhook endpoint.

4. **Deploy the functions:**

   ```bash
   supabase functions deploy stripe-connect-onboard
   supabase functions deploy create-transaction-checkout
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```

5. **Create the Stripe webhook endpoint** (Stripe Dashboard → Developers →
   Webhooks → Add endpoint):

   - URL: `https://kdsjgzroyrcycckgkumb.supabase.co/functions/v1/stripe-webhook`
   - Listen to: **events on Connected accounts** (this platform never
     charges its own account directly)
   - Events: `checkout.session.completed`, `checkout.session.expired`,
     `account.updated`
   - Copy the generated **Signing secret** and run the
     `STRIPE_WEBHOOK_SECRET` command from step 3.

## Application flow

1. A business owner signs up (Supabase Auth) and calls
   `stripe-connect-onboard` with `{ business_name, return_url, refresh_url }`
   (or `{ business_id, return_url, refresh_url }` to resume onboarding).
   Redirect them to the returned `url` to complete Stripe's hosted
   onboarding. `businesses.stripe_onboarding_complete` flips to `true`
   automatically once Stripe confirms the account can accept charges
   (via the `account.updated` webhook).
2. The business creates a `transactions` row for the agreed amount
   (`amount_cents`, `currency`, `description`, `customer_id`) and sets
   `business_agreed = true`.
3. The customer reviews it and sets `customer_agreed = true`. The
   database trigger flips `status` to `ready_to_charge` the instant both
   flags are true — neither side can set the other's flag (enforced by a
   trigger, not just app logic).
4. The customer calls `create-transaction-checkout` with
   `{ transaction_id, success_url, cancel_url }` and is redirected to the
   returned Stripe Checkout `url` to pay with their card.
5. Stripe charges the card **on the business's connected account** and
   sends `checkout.session.completed` to `stripe-webhook`, which marks the
   transaction `paid`.

## Known limitations / next steps

- No email/notification flow yet (e.g. notifying the business when a
  customer agrees, or the customer when payment succeeds).
- No refund/dispute handling beyond what's needed to mark a transaction
  paid.
- `create-transaction-checkout` assumes the customer already has a
  Supabase account; there's no guest-checkout path.
