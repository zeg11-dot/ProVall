-- business_payment_connections had RLS enabled with zero policies, written
-- back when the only reader was stripe-connect-status (a service-role
-- function that bypasses RLS). The real frontend actually queries this
-- table directly from the browser too (loadSquareConnectionStatus, and the
-- "which processors are connected" check on session creation) — with no
-- policy those reads always return nothing, regardless of whether a row
-- exists. Add a policy for a business to read its own row, but restrict it
-- to the columns the client actually needs — square_access_token,
-- square_refresh_token, and stripe_account_id stay service-role only.

drop policy if exists "Business can view its own payment connections" on public.business_payment_connections;
create policy "Business can view its own payment connections"
on public.business_payment_connections
for select
to authenticated
using (auth.uid() = business_id);

revoke select on public.business_payment_connections from authenticated;
grant select (business_id, provider, onboarding_status, charges_enabled, payouts_enabled, square_location_id)
  on public.business_payment_connections to authenticated;
