-- Phase 2: Auth / Room schema
-- Tables: plans, user_profiles, rooms, participants, invites
-- RLS is enabled here (fail-safe, deny by default). Policies are implemented in a separate task (bd-882).

-- ============================================================
-- plans（プラン・器のみ / 課金処理なし）
-- ============================================================
create table if not exists public.plans (
  id text primary key,
  max_participants int not null,
  created_at timestamptz not null default now()
);

alter table public.plans enable row level security;

-- 初期データ（free プラン）は supabase/seed.sql で投入する。

-- ============================================================
-- user_profiles（オーナー、auth.users と 1:1）
-- ============================================================
create table if not exists public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  default_language text not null default 'ja-JP',
  plan_id text not null default 'free' references public.plans (id),
  created_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

-- サインアップ時に user_profiles を自動作成するトリガー
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, email, default_language, plan_id)
  values (new.id, new.email, 'ja-JP', 'free')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- rooms（トークルーム）
-- ============================================================
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.user_profiles (id) on delete cascade,
  status text not null default 'active',
  max_participants int not null,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint rooms_status_check check (status in ('active', 'ended'))
);

alter table public.rooms enable row level security;

create index if not exists rooms_owner_user_id_created_at_idx
  on public.rooms (owner_user_id, created_at desc);

-- ============================================================
-- participants（参加者、owner/guest 共通）
-- ============================================================
create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  role text not null,
  user_id uuid references public.user_profiles (id) on delete cascade,
  guest_cookie_id text,
  display_name text,
  language text not null,
  tts_enabled boolean not null default true,
  present boolean not null default false,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  constraint participants_role_check check (role in ('owner', 'guest')),
  constraint participants_role_identity_check check (
    (role = 'owner' and user_id is not null and guest_cookie_id is null)
    or (role = 'guest' and guest_cookie_id is not null and user_id is null)
  )
);

alter table public.participants enable row level security;

create index if not exists participants_room_id_idx
  on public.participants (room_id);

create index if not exists participants_room_id_guest_cookie_id_idx
  on public.participants (room_id, guest_cookie_id);

-- ============================================================
-- invites（QR招待）
-- ============================================================
create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.invites enable row level security;
