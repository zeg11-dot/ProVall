# ProVall payments backend (real app: pairing-code sessions + VGS/Square + Stripe Connect/Square)

`index.html` is the real ProVall app. A business opens a "room" with a
4-character pairing code, reads it to a caller, the caller joins (as a
guest or a signed-in individual), the business requests specific fields
(including, optionally, a card + a dollar amount), and the caller approves
with one tap. A business can connect **either or both** Stripe and Square;
whichever is connected charges automatically the moment the caller
approves — a rep never sees or types the card.

- **Stripe path**: card data is tokenized client-side by **VGS Collect.js**
  before it ever leaves the browser. `charge-session` swaps the VGS alias
  for the real card via a VGS outbound proxy when it calls Stripe, so this
  backend never sees a raw PAN.
- **Square path**: Square's own Web Payments SDK tokenizes the card
  client-side instead (Square's API rejects raw card data from any source,
  even a compliant vault like VGS). `charge-session-square` takes that
  one-time token and charges it via Square's CreatePayment API.

## What's here

- `migrations/20260831000000_real_session_schema.sql` — `sessions`,
  `business_reps`, `admin_actions`, `rep_request_log` tables, RLS, and the
  `check_and_log_rep_request` rate-limit RPC.
- `migrations/20260831010000_payment_connections.sql` — `business_payment_connections`
  (keyed on `business_id, provider`) and the `payment_status`/`payment_error`/
  `stripe_payment_intent_id` columns on `sessions`.
- `migrations/20260901000000_square_payment_columns.sql` — `sessions.payment_processor`,
  `sessions.square_location_id`, `sessions.square_payment_token`, and
  `business_payment_connections.square_location_id`.
- `migrations/20260901010000_oauth_states.sql` — `oauth_states`, short-lived
  CSRF state for the Square OAuth Connect flow.
- `migrations/20260901020000_square_charge_columns.sql` — `business_payment_connections.square_access_token`,
  `sessions.square_payment_id`.
- `migrations/20260901030000_square_oauth_columns.sql` — `business_payment_connections.square_merchant_id`,
  `square_refresh_token`, `square_token_expires_at`.
- `functions/stripe-connect-status` / `functions/stripe-connect-onboarding` —
  Stripe Express Connect: check status / create account + hosted onboarding
  link. Stores `stripe_account_id` etc. on `business_payment_connections`.
- `functions/charge-session` — charges a resolved, approved payment session
  through the business's connected Stripe account via the VGS outbound
  proxy.
- `functions/square-connect-onboard` — starts the Square OAuth flow, writes
  a row to `oauth_states`, returns Square's hosted authorization URL.
- `functions/square-oauth-callback` — Square redirects the browser here
  directly (no Supabase auth token) after the business approves or denies
  access. Exchanges the code for access/refresh tokens, looks up the
  seller's Square location, and upserts the connection. Deployed with
  `--no-verify-jwt`.
- `functions/charge-session-square` — charges a resolved, approved payment
  session through the business's connected Square account using the
  one-time token their browser already produced.
- `functions/delete-account` — pre-existing, not touched here.

## Known gap: Square token refresh

Square access tokens expire (Square sends `expires_at` on the OAuth
response, stored in `square_token_expires_at`); Stripe's `stripe_account_id`
does not. There is currently **no refresh flow** — once a business's
`square_access_token` expires, `charge-session-square` will start failing
for them until they reconnect Square from the business console. Worth
building a scheduled function that refreshes tokens nearing expiry before
this ships for real.

## One-time setup

1. **Apply migrations:**

   ```bash
   supabase db push
   ```

2. **Deploy the functions:**

   ```bash
   supabase functions deploy stripe-connect-status
   supabase functions deploy stripe-connect-onboarding
   supabase functions deploy charge-session
   supabase functions deploy square-connect-onboard
   supabase functions deploy charge-session-square
   supabase functions deploy square-oauth-callback --no-verify-jwt
   ```

3. **Secrets** — `STRIPE_SECRET_KEY` and `VGS_OUTBOUND_BASE_URL` are already
   set. For Square, set:

   ```bash
   supabase secrets set SQUARE_APP_ID=<your Square application id>
   supabase secrets set SQUARE_APP_SECRET=<your Square application secret>
   ```

   Both come from your own Provall application at developer.squareup.com
   (not an individual business's account — this is the platform app that
   every connected business authorizes against). `SQUARE_ENVIRONMENT`
   defaults to `sandbox` if unset; set it to `production` when going live.

4. **Enable anonymous sign-ins** (needed for guests who join a session
   without an account): Supabase Dashboard → Authentication → Sign In /
   Providers → turn on **Anonymous Sign-Ins**. This is a project setting,
   not something `config.toml` controls for a hosted project.

5. **Square redirect URL**: in your Square application's dashboard, add
   this project's `square-oauth-callback` function URL as an allowed OAuth
   redirect URL, or Square will refuse to redirect back to it.
