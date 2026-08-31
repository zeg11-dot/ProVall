-- A minimal public profile per user so a business can look up a customer by
-- email (auth.users itself isn't queryable by anon/authenticated clients).
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

create index if not exists profiles_email_idx on public.profiles (lower(email));

alter table public.profiles enable row level security;

create policy "Any signed-in user can look up profiles by email"
  on public.profiles for select
  using (auth.role() = 'authenticated');

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for anyone who already signed up before this migration.
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- A customer needs to see the business's name on their own transaction
-- (the original policy only let a business see its own row).
create policy "Any signed-in user can view basic business info"
  on public.businesses for select
  using (auth.role() = 'authenticated');
