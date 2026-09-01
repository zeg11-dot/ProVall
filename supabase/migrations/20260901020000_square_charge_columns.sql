-- Columns charge-session-square reads/writes: the long-lived Square access
-- token obtained during OAuth (square-oauth-callback), and the resulting
-- Square payment id once a charge succeeds.

alter table public.business_payment_connections add column if not exists square_access_token text;
alter table public.sessions add column if not exists square_payment_id text;
