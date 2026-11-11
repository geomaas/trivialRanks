-- trivialRANKS database setup for Supabase.
-- Run once in the Supabase dashboard: SQL Editor → New query → paste this file → Run.
-- Safe to run again; it only creates what's missing and replaces the functions and policies.

-- One row per signed-in player. `data` holds {name, results:{<day>:{<game>:{score, display, ...}}}},
-- the same shape the page stored on claude.ai.
create table if not exists public.players (
  id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint players_data_is_object check (jsonb_typeof(data) = 'object'),
  constraint players_data_size check (pg_column_size(data) < 1000000)
);

-- Nested objects merge recursively; anything else (arrays included) replaces the field.
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  result jsonb;
  k text;
  v jsonb;
begin
  if jsonb_typeof(a) <> 'object' or jsonb_typeof(b) <> 'object' then
    return b;
  end if;
  result := a;
  for k, v in select * from jsonb_each(b) loop
    if result ? k and jsonb_typeof(result -> k) = 'object' and jsonb_typeof(v) = 'object' then
      result := jsonb_set(result, array[k], public.jsonb_deep_merge(result -> k, v));
    else
      result := jsonb_set(result, array[k], v);
    end if;
  end loop;
  return result;
end;
$$;

-- Merge a patch into the caller's own row. Fails if the row doesn't exist yet,
-- matching the page's update() semantics. Runs with the caller's permissions (RLS applies).
create or replace function public.update_player(patch jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  update public.players
     set data = public.jsonb_deep_merge(data, patch), updated_at = now()
   where id = auth.uid();
  if not found then
    raise exception 'document does not exist' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.update_player(jsonb) from public, anon;
grant execute on function public.update_player(jsonb) to authenticated;

-- Row-level security: everyone can read the board; each player writes only their own row.
alter table public.players enable row level security;

drop policy if exists "players are readable by everyone" on public.players;
create policy "players are readable by everyone" on public.players
  for select to anon, authenticated using (true);

drop policy if exists "players insert their own row" on public.players;
create policy "players insert their own row" on public.players
  for insert to authenticated with check (id = (select auth.uid()));

drop policy if exists "players update their own row" on public.players;
create policy "players update their own row" on public.players
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "players delete their own row" on public.players;
create policy "players delete their own row" on public.players
  for delete to authenticated using (id = (select auth.uid()));

-- Live updates: send row changes to open pages.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players'
  ) then
    alter publication supabase_realtime add table public.players;
  end if;
end;
$$;
