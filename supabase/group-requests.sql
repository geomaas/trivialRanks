-- trivialRANKS group search and join requests. Run in Supabase → SQL Editor after groups.sql.
-- Safe to run again.
--
-- * Groups are listed in search unless their owner hides them (groups.listed).
-- * Search shows a listed group's name and size, never its invite code or members.
-- * Anyone signed in can ask to join a listed group; its owner approves or declines.
-- * Joining by invite link still works for listed and hidden groups alike.
-- All changes go through the functions below; the tables have no write policies.

alter table public.groups add column if not exists listed boolean not null default true;

create table if not exists public.group_join_requests (
  group_id   uuid not null references public.groups(id) on delete cascade,
  player_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, player_id)
);
create index if not exists group_join_requests_player_idx on public.group_join_requests (player_id);
alter table public.group_join_requests enable row level security;
revoke all on public.group_join_requests from anon;

create or replace function public.is_group_owner(gid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.group_members m
                 where m.group_id = gid and m.player_id = (select auth.uid()) and m.role = 'owner');
$$;

-- You see your own requests; owners see the requests for their groups.
drop policy if exists "requesters and owners read requests" on public.group_join_requests;
create policy "requesters and owners read requests" on public.group_join_requests
  for select to authenticated using (player_id = (select auth.uid()) or public.is_group_owner(group_id));

-- Listed groups whose name contains the query (2+ characters), most members first, up to 20.
-- Returns [{id, name, members, member, requested}].
create or replace function public.search_groups(p_query text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); q text := btrim(coalesce(p_query, ''));
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if char_length(q) < 2 then return '[]'::jsonb; end if;
  q := replace(replace(replace(left(q, 40), '\', '\\'), '%', '\%'), '_', '\_');
  return coalesce((
    select jsonb_agg(r order by r.members desc, r.name) from (
      select g.id, g.name,
        (select count(*) from public.group_members m where m.group_id = g.id) as members,
        exists (select 1 from public.group_members m where m.group_id = g.id and m.player_id = me) as member,
        exists (select 1 from public.group_join_requests j where j.group_id = g.id and j.player_id = me) as requested
      from public.groups g
      where g.listed and g.name ilike '%' || q || '%'
      order by members desc, g.name
      limit 20) r), '[]'::jsonb);
end $$;

-- Asks to join a listed group. Returns 'requested', or 'member' if you're already in it.
create or replace function public.request_join(p_group uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if not exists (select 1 from public.groups g where g.id = p_group and g.listed) then
    raise exception 'That group isn''t taking requests. Ask a member for an invite link.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.group_members m where m.group_id = p_group and m.player_id = me) then return 'member'; end if;
  if (select count(*) from public.group_members m where m.player_id = me) >= 10 then
    raise exception 'You can be in up to 10 groups.' using errcode = '54000';
  end if;
  if (select count(*) from public.group_join_requests j where j.player_id = me) >= 20 then
    raise exception 'You have 20 requests waiting. Cancel some first.' using errcode = '54000';
  end if;
  insert into public.group_join_requests (group_id, player_id) values (p_group, me) on conflict do nothing;
  return 'requested';
end $$;

create or replace function public.cancel_join_request(p_group uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.group_join_requests where group_id = p_group and player_id = (select auth.uid());
end $$;

create or replace function public.approve_join_request(p_group uuid, p_player uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_owner(p_group);
  if not exists (select 1 from public.group_join_requests j where j.group_id = p_group and j.player_id = p_player) then
    raise exception 'That request was cancelled.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.group_members m where m.group_id = p_group and m.player_id = p_player) then
    if (select count(*) from public.group_members m where m.group_id = p_group) >= 50 then
      raise exception 'The group is full (50 players).' using errcode = '54000';
    end if;
    if (select count(*) from public.group_members m where m.player_id = p_player) >= 10 then
      delete from public.group_join_requests where group_id = p_group and player_id = p_player;
      raise exception 'They''re already in 10 groups, so they can''t join another.' using errcode = '54000';
    end if;
    insert into public.group_members (group_id, player_id) values (p_group, p_player);
  end if;
  delete from public.group_join_requests where group_id = p_group and player_id = p_player;
end $$;

create or replace function public.decline_join_request(p_group uuid, p_player uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_owner(p_group);
  delete from public.group_join_requests where group_id = p_group and player_id = p_player;
end $$;

-- Shows or hides a group in search. Hiding it also clears its waiting requests.
create or replace function public.set_group_listed(p_group uuid, p_listed boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_owner(p_group);
  update public.groups set listed = coalesce(p_listed, true) where id = p_group;
  if not coalesce(p_listed, true) then delete from public.group_join_requests where group_id = p_group; end if;
end $$;

-- Joining by invite link settles any request waiting for the same group.
create or replace function public.clear_request_on_join()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.group_join_requests where group_id = new.group_id and player_id = new.player_id;
  return new;
end $$;
drop trigger if exists clear_request_on_join on public.group_members;
create trigger clear_request_on_join after insert on public.group_members
  for each row execute function public.clear_request_on_join();

revoke execute on function
  public.is_group_owner(uuid), public.search_groups(text), public.request_join(uuid), public.cancel_join_request(uuid),
  public.approve_join_request(uuid, uuid), public.decline_join_request(uuid, uuid), public.set_group_listed(uuid, boolean),
  public.clear_request_on_join()
  from public, anon, authenticated;
grant execute on function
  public.is_group_owner(uuid), public.search_groups(text), public.request_join(uuid), public.cancel_join_request(uuid),
  public.approve_join_request(uuid, uuid), public.decline_join_request(uuid, uuid), public.set_group_listed(uuid, boolean)
  to authenticated;

-- Your waiting requests with the group names (you can't read a group's row until you're in it).
-- Returns [{groupId, name, at}].
create or replace function public.my_join_requests()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('groupId', j.group_id, 'name', g.name, 'at', j.created_at) order by j.created_at), '[]'::jsonb)
  from public.group_join_requests j join public.groups g on g.id = j.group_id
  where j.player_id = (select auth.uid());
$$;
revoke execute on function public.my_join_requests() from public, anon, authenticated;
grant execute on function public.my_join_requests() to authenticated;
