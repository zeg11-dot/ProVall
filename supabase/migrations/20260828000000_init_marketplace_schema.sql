-- Marketplace schema: businesses (Stripe Connect merchants) and the
-- transactions they agree on with their customers.

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  stripe_account_id text unique,
  stripe_onboarding_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists businesses_owner_id_idx on public.businesses(owner_id);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references auth.users(id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'usd',
  description text,
  business_agreed boolean not null default false,
  customer_agreed boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'ready_to_charge', 'checkout_created', 'paid', 'failed', 'canceled')),
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  finalized_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists transactions_business_id_idx on public.transactions(business_id);
create index if not exists transactions_customer_id_idx on public.transactions(customer_id);

-- Once both sides agree, the transaction becomes chargeable exactly once.
create or replace function public.mark_transaction_ready()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();

  if new.business_agreed and new.customer_agreed and new.status = 'pending' then
    new.status := 'ready_to_charge';
    new.finalized_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_mark_transaction_ready on public.transactions;
create trigger trg_mark_transaction_ready
  before insert or update on public.transactions
  for each row
  execute function public.mark_transaction_ready();

alter table public.businesses enable row level security;
alter table public.transactions enable row level security;

-- Businesses: owners manage their own business record.
create policy "Business owners can view their business"
  on public.businesses for select
  using (auth.uid() = owner_id);

create policy "Business owners can create their business"
  on public.businesses for insert
  with check (auth.uid() = owner_id);

create policy "Business owners can update their business"
  on public.businesses for update
  using (auth.uid() = owner_id);

-- Transactions: visible to the business owner and the customer involved.
create policy "Participants can view their transactions"
  on public.transactions for select
  using (
    auth.uid() = customer_id
    or auth.uid() in (select owner_id from public.businesses where id = business_id)
  );

create policy "Business owners can create transactions"
  on public.transactions for insert
  with check (auth.uid() in (select owner_id from public.businesses where id = business_id));

-- Each side may only flip their own agreement flag, and only before payment.
create policy "Business owner can set business_agreed"
  on public.transactions for update
  using (
    status in ('pending', 'ready_to_charge')
    and auth.uid() in (select owner_id from public.businesses where id = business_id)
  )
  with check (
    auth.uid() in (select owner_id from public.businesses where id = business_id)
  );

create policy "Customer can set customer_agreed"
  on public.transactions for update
  using (
    status in ('pending', 'ready_to_charge')
    and auth.uid() = customer_id
  )
  with check (
    auth.uid() = customer_id
  );

-- RLS above only decides *who* may touch a row; it does not stop a business
-- owner from also flipping customer_agreed (or vice versa). Enforce that
-- each side can only ever change their own flag, so a charge genuinely
-- requires both parties to agree. The service role (used by the webhook
-- and trusted server-side functions) is exempt.
create or replace function public.enforce_transaction_agreement_columns()
returns trigger
language plpgsql
as $$
declare
  is_business boolean;
  is_customer boolean;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  is_business := auth.uid() in (select owner_id from public.businesses where id = old.business_id);
  is_customer := auth.uid() = old.customer_id;

  if is_business and not is_customer then
    if new.customer_agreed is distinct from old.customer_agreed then
      raise exception 'Business cannot set customer_agreed';
    end if;
  elsif is_customer and not is_business then
    if new.business_agreed is distinct from old.business_agreed
      or new.amount_cents is distinct from old.amount_cents
      or new.currency is distinct from old.currency
      or new.description is distinct from old.description then
      raise exception 'Customer can only set customer_agreed';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_transaction_agreement_columns on public.transactions;
create trigger trg_enforce_transaction_agreement_columns
  before update on public.transactions
  for each row
  execute function public.enforce_transaction_agreement_columns();
