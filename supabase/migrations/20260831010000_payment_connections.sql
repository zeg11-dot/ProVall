-- business_payment_connections: what charge-session, stripe-connect-status,
-- and stripe-connect-onboarding actually read/write. Never touched by the
-- frontend directly (only via these service-role functions), so RLS is on
-- with no policies — nothing but the service role can reach it.
create table if not exists public.business_payment_connections (
  business_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  stripe_account_id text,
  onboarding_status text,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, provider)
);

alter table public.business_payment_connections enable row level security;

-- sessions needs a few more columns for the real charge-session flow.
alter table public.sessions add column if not exists payment_status text;
alter table public.sessions add column if not exists payment_error text;
alter table public.sessions add column if not exists stripe_payment_intent_id text;
