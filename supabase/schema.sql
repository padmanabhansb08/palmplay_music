-- PalmPlay cloud library (run in Supabase SQL Editor)
-- Auth: enable Email provider in Authentication → Providers

-- Playlists (streaming saves; local file blobs stay on-device in Dexie only)
create table if not exists public.user_playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.playlist_tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  playlist_id uuid not null references public.user_playlists (id) on delete cascade,
  source text,
  external_id text,
  name text not null,
  artist text not null,
  album text,
  duration numeric default 0,
  stream_url text,
  art_url text,
  date_added timestamptz not null default now(),
  sort_order int not null default 0
);

create table if not exists public.user_liked_songs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  track_name text not null,
  artist text not null,
  album text,
  duration numeric default 0,
  stream_url text,
  art_url text,
  source text,
  external_id text,
  is_catalog boolean default false,
  date_added timestamptz not null default now(),
  unique (user_id, track_name, artist)
);

create index if not exists idx_user_playlists_user on public.user_playlists (user_id);
create index if not exists idx_playlist_tracks_playlist on public.playlist_tracks (playlist_id);
create index if not exists idx_playlist_tracks_user on public.playlist_tracks (user_id);
create index if not exists idx_liked_user on public.user_liked_songs (user_id);

alter table public.user_playlists enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.user_liked_songs enable row level security;

create policy "playlists_select_own" on public.user_playlists for select using (auth.uid() = user_id);
create policy "playlists_insert_own" on public.user_playlists for insert with check (auth.uid() = user_id);
create policy "playlists_update_own" on public.user_playlists for update using (auth.uid() = user_id);
create policy "playlists_delete_own" on public.user_playlists for delete using (auth.uid() = user_id);

create policy "tracks_select_own" on public.playlist_tracks for select using (auth.uid() = user_id);
create policy "tracks_insert_own" on public.playlist_tracks for insert with check (auth.uid() = user_id);
create policy "tracks_update_own" on public.playlist_tracks for update using (auth.uid() = user_id);
create policy "tracks_delete_own" on public.playlist_tracks for delete using (auth.uid() = user_id);

create policy "likes_select_own" on public.user_liked_songs for select using (auth.uid() = user_id);
create policy "likes_insert_own" on public.user_liked_songs for insert with check (auth.uid() = user_id);
create policy "likes_update_own" on public.user_liked_songs for update using (auth.uid() = user_id);
create policy "likes_delete_own" on public.user_liked_songs for delete using (auth.uid() = user_id);
