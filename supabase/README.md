# ProVall payments backend (real app: pairing-code sessions + VGS + Stripe Connect)

`index.html` is the real ProVall app. A business opens a "room" with a
4-character pairing code, reads it to a caller, the caller joins (as a
guest or a signed-in individual), the business requests specific fields
(including, optionally, a card + a dollar amount), and the caller approves
with one tap. Card data is tokenized client-side by **VGS Collect.js**
before it ever leaves the browser — this backend never sees a raw card
number.

## What's here

- `migrations/20260831000000_real_session_schema.sql` — `sessions`,
  `business_reps`, `admin_actions`, `rep_request_log` tables, RLS, and the
  `check_and_log_rep_request` rate-limit RPC. This **replaces** the
  `businesses`/`transactions` schema from an earlier, mismatched attempt at
  this feature — that schema didn't match what `index.html` actually calls
  and has been dropped.
- `functions/stripe-connect-status` — tells the business console whether
  Stripe is connected yet (queries Stripe live).
- `functions/stripe-connect-onboarding` — creates/resumes a business's
  Stripe Express account and returns a hosted onboarding link. The account
  id is stored on the business's own user account (`app_metadata`) — there
  is no separate `businesses` table; a business is just a user account.
- `functions/delete-account` — **already existed before this work**, not
  touched here.

## Not yet built: `charge-session`

`index.html` calls `sbClient.functions.invoke('charge-session', { body: { session_id } })`
once a payment session is approved. Building this requires your actual
**VGS vault configuration** (vault id `tntcc06gjt7`, `sandbox` environment):

- A VGS **Outbound Route** proxying to `api.stripe.com`, so a request
  containing the VGS aliases for the card fields gets transparently
  substituted with the real card data before Stripe ever sees it — the
  edge function itself never touches a raw PAN.
- VGS API credentials to authenticate that outbound proxy call (from the
  VGS dashboard → your vault → API keys), stored as Supabase secrets.

Until `charge-session` is deployed, the app already degrades gracefully —
the business console shows *"Card info received, but automatic charging
isn't set up yet."*

## One-time setup

1. **Apply the migration** (adds `sessions`/`business_reps`/`admin_actions`,
   drops the old mismatched tables):

   ```bash
   supabase db push
   ```

2. **Deploy the two functions:**

   ```bash
   supabase functions deploy stripe-connect-status
   supabase functions deploy stripe-connect-onboarding
   ```

3. **`STRIPE_SECRET_KEY`** is already set from earlier — no change needed
   unless you rotate it.

4. **Enable anonymous sign-ins** (needed for guests who join a session
   without an account): Supabase Dashboard → Authentication → Sign In /
   Providers → turn on **Anonymous Sign-Ins**. This is a project setting,
   not something `config.toml` controls for a hosted project.

5. **Old Stripe webhook destination**: the one created earlier (pointed at
   a now-deleted `stripe-webhook` function) can be removed from the Stripe
   Dashboard → Developers → Webhooks — this app doesn't need a webhook
   for the flows built so far.

## Next step

Send over your VGS outbound-route/API details (or confirm the route to
Stripe isn't set up yet) so `charge-session` can be built to match.
