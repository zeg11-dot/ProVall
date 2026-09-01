-- Columns square-oauth-callback writes once Square's OAuth token exchange
-- completes: the merchant id, the refresh token needed to renew
-- square_access_token before it expires, and that expiry timestamp.

alter table public.business_payment_connections add column if not exists square_merchant_id text;
alter table public.business_payment_connections add column if not exists square_refresh_token text;
alter table public.business_payment_connections add column if not exists square_token_expires_at timestamptz;
