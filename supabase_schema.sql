-- Reef Fortune — Supabase schema
-- Run this once in the Supabase SQL editor.

-- 1. profiles table: one row per user, stores the persistent balance
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  balance    bigint not null default 2000,
  total_win  bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- 2. auto-create a profile row whenever a new auth.users row is inserted
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id)
    on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. Row Level Security: a user can read/update only their own row
alter table public.profiles enable row level security;

drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own"
  on public.profiles for select
  using (auth.uid() = user_id);

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
  on public.profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- (inserts are handled by the trigger, which runs as security definer,
--  so normal clients never need insert rights on profiles.)
revoke insert on public.profiles from anon, authenticated;

-- 4. Atomic RPCs for balance changes (race-safe, RLS-enforced)
-- debit_balance: subtract if funds sufficient; return new balance or null
create or replace function public.debit_balance(amt bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare new_bal bigint;
begin
  -- atomic conditional decrement
  update public.profiles
     set balance = balance - amt,
         updated_at = now()
   where user_id = auth.uid()
     and balance >= amt
  returning balance into new_bal;
  return new_bal;
end;
$$;

-- credit_balance: add to balance + total_win; return new balance or null
create or replace function public.credit_balance(amt bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare new_bal bigint;
begin
  update public.profiles
     set balance = balance + amt,
         total_win = total_win + amt,
         updated_at = now()
   where user_id = auth.uid()
  returning balance into new_bal;
  return new_bal;
end;
$$;

-- grant_balance: free-coin top-up (adds to balance only); returns new balance or null
create or replace function public.grant_balance(amt bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare new_bal bigint;
begin
  update public.profiles
     set balance = balance + amt,
         updated_at = now()
   where user_id = auth.uid()
  returning balance into new_bal;
  return new_bal;
end;
$$;

-- allow authenticated users to call these RPCs
grant execute on function public.debit_balance(bigint) to authenticated;
grant execute on function public.credit_balance(bigint) to authenticated;
grant execute on function public.grant_balance(bigint) to authenticated;