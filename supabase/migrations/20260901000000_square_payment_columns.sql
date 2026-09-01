-- Columns the real frontend (index.html) already reads/writes for the Square
-- payment-processor path, alongside the existing Stripe Connect columns.
-- square-connect-onboard / square-oauth-callback / charge-session-square are
-- not deployed yet — this migration only adds what the client already needs.

alter table public.sessions add column if not exists payment_processor text;
alter table public.sessions add column if not exists square_location_id text;
alter table public.sessions add column if not exists square_payment_token text;

alter table public.business_payment_connections add column if not exists square_location_id text;
