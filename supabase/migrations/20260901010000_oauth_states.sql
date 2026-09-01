-- CSRF state for the Square OAuth Connect flow: square-connect-onboard
-- writes a row before redirecting to Square, square-oauth-callback reads
-- (and should delete) it when Square redirects back with that state.
-- Service-role only — the client never touches this table directly.

create table if not exists public.oauth_states (
  state uuid primary key,
  business_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  return_url text,
  created_at timestamptz not null default now()
);

alter table public.oauth_states enable row level security;
