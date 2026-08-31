-- Run this in Supabase Dashboard > SQL Editor
-- Creates admin_users table for OpenWA hardcoded + additional admins
-- User: infyle@infyle.com / infyle@90 (also hardcoded in code as fallback)

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  role text not null default 'admin' check (role in ('admin','super_admin')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- Enable RLS but allow anon to read for login (or use service_role key)
alter table public.admin_users enable row level security;

drop policy if exists "Allow anon read for login" on public.admin_users;
create policy "Allow anon read for login"
  on public.admin_users for select
  using (true);

drop policy if exists "Allow anon update last_login" on public.admin_users;
create policy "Allow anon update last_login"
  on public.admin_users for update
  using (true) with check (true);

drop policy if exists "Allow anon insert" on public.admin_users;
create policy "Allow anon insert"
  on public.admin_users for insert
  with check (true);

-- Seed the default admin (plain password — backend also accepts hardcoded fallback)
-- For production, replace password_hash with bcrypt hash: use backend to hash via bcryptjs
insert into public.admin_users (email, password_hash, role, is_active)
values ('infyle@infyle.com', 'infyle@90', 'super_admin', true)
on conflict (email) do update set password_hash = excluded.password_hash, is_active = true;

-- Example: add another admin (uncomment and edit)
-- insert into public.admin_users (email, password_hash, role) values ('other@example.com', 'yourpassword', 'admin');

-- Optional: index for fast lookup
create index if not exists admin_users_email_idx on public.admin_users (email);
