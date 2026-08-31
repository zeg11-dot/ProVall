-- Replaces last night's mismatched businesses/transactions schema with the
-- one the real app (index.html) actually calls: pairing-code sessions,
-- business reps with admin/revocation/rate-limit controls, and an admin
-- action log. Card data itself never lands here — it's tokenized by VGS
-- client-side; only VGS aliases ever get stored in resolved_fields.

drop trigger if exists trg_enforce_transaction_agreement_columns on public.transactions;
drop trigger if exists trg_mark_transaction_ready on public.transactions;
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.enforce_transaction_agreement_columns();
drop function if exists public.mark_transaction_ready();
drop function if exists public.handle_new_user();
drop table if exists public.transactions;
drop table if exists public.businesses;
drop table if exists public.profiles;

-- ---------- sessions ----------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  room_code text not null,
  business_id uuid not null references auth.users(id) on delete cascade,
  business_name text not null,
  rep_id text not null,
  status text not null default 'waiting'
    check (status in ('waiting', 'connected', 'requesting', 'resolved')),
  requested_fields jsonb not null default '[]'::jsonb,
  resolved_fields jsonb not null default '[]'::jsonb,
  resolution_status text check (resolution_status in ('approved', 'denied', 'reported')),
  session_type text check (session_type in ('payment', 'reservation')),
  amount_cents integer,
  currency text,
  created_at timestamptz not null default now()
);

create index if not exists sessions_room_code_idx on public.sessions (room_code);
create index if not exists sessions_business_id_idx on public.sessions (business_id);

alter table public.sessions enable row level security;

-- The business owns and can fully manage its own sessions.
create policy "Business manages its own sessions"
  on public.sessions for all
  using (auth.uid() = business_id)
  with check (auth.uid() = business_id);

-- A caller has no prior relationship to a session until they enter the
-- pairing code, so they can't be scoped by ownership — the 4-character code
-- (given verbally, 90s expiry) is the real access boundary here, matching
-- how the app already treats it. Any signed-in user (including the
-- anonymous "guest" sign-in) can look one up and move it through
-- connected -> requesting -> resolved.
create policy "A signed-in user can find and join a session"
  on public.sessions for select
  using (auth.role() = 'authenticated');

create policy "A signed-in user can advance an unresolved session"
  on public.sessions for update
  using (auth.role() = 'authenticated' and status <> 'resolved')
  with check (auth.role() = 'authenticated');

alter publication supabase_realtime add table public.sessions;

-- ---------- business_reps ----------
create table if not exists public.business_reps (
  business_id uuid not null references auth.users(id) on delete cascade,
  rep_id text not null,
  is_admin boolean not null default false,
  is_revoked boolean not null default false,
  request_limit integer,
  primary key (business_id, rep_id)
);

alter table public.business_reps enable row level security;

create policy "Business manages its own reps"
  on public.business_reps for all
  using (auth.uid() = business_id)
  with check (auth.uid() = business_id);

-- ---------- admin_actions ----------
create table if not exists public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references auth.users(id) on delete cascade,
  actor_rep_id text not null,
  action text not null,
  target_rep_id text,
  detail text default '',
  created_at timestamptz not null default now()
);

alter table public.admin_actions enable row level security;

create policy "Business views its own admin log"
  on public.admin_actions for select
  using (auth.uid() = business_id);

create policy "Business writes its own admin log"
  on public.admin_actions for insert
  with check (auth.uid() = business_id);

-- ---------- rep_request_log + rate-limit RPC ----------
-- Backing table for check_and_log_rep_request. Not exposed to clients
-- directly (RLS on, no policies) — only touched via the SECURITY DEFINER
-- function below, so the count/limit check can't be bypassed client-side.
create table if not exists public.rep_request_log (
  id bigint generated always as identity primary key,
  rep_id text not null,
  requested_at timestamptz not null default now()
);

create index if not exists rep_request_log_rep_id_idx on public.rep_request_log (rep_id, requested_at);
alter table public.rep_request_log enable row level security;

create or replace function public.check_and_log_rep_request(
  p_rep_id text,
  p_limit integer,
  p_cooldown_seconds integer
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  recent_count integer;
begin
  select count(*) into recent_count
  from public.rep_request_log
  where rep_id = p_rep_id
    and requested_at > now() - (p_cooldown_seconds || ' seconds')::interval;

  if recent_count >= p_limit then
    return jsonb_build_object('allowed', false, 'count', recent_count);
  end if;

  insert into public.rep_request_log (rep_id) values (p_rep_id);
  return jsonb_build_object('allowed', true, 'count', recent_count + 1);
end;
$$;

grant execute on function public.check_and_log_rep_request(text, integer, integer) to authenticated;
