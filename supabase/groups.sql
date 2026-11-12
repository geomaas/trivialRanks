-- trivialRANKS groups. Run in Supabase → SQL Editor after schema.sql. Safe to run again.
--
-- A group is a set of players who see their own board. Results stay on each player's row
-- (players table), so a result logged once counts in every group and on the global board.
--
-- Who sees what:
--   * Group names, members and invite codes: members of that group only.
--   * Anyone holding an invite code can see the group's name and size (preview_group) and join.
-- All changes go through the functions below; the tables have no write policies.
-- Limits: 10 groups per player, 50 players per group.

create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  invite_code text not null unique,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id  uuid not null references public.groups(id) on delete cascade,
  player_id uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, player_id)
);
create index if not exists group_members_player_idx on public.group_members (player_id);

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
revoke all on public.groups, public.group_members from anon;

-- True when the signed-in player belongs to the group. Security definer so the policies
-- below can check membership without tripping over their own rules.
create or replace function public.is_group_member(gid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.group_members m where m.group_id = gid and m.player_id = (select auth.uid()));
$$;

drop policy if exists "members read their groups" on public.groups;
create policy "members read their groups" on public.groups
  for select to authenticated using (public.is_group_member(id));

drop policy if exists "members read their group's members" on public.group_members;
create policy "members read their group's members" on public.group_members
  for select to authenticated using (public.is_group_member(group_id));

-- 10 characters from an alphabet without look-alikes (no 0/O, 1/I/L): about 8 × 10^14 codes.
create or replace function public.new_invite_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  code text := '';
  i int;
begin
  -- Skip the UUID version and variant bytes (6 and 8), which aren't random.
  foreach i in array array[0,1,2,3,4,5,7,9,10,11] loop
    code := code || substr(alphabet, get_byte(b, i) % 31 + 1, 1);
  end loop;
  return code;
end $$;

create or replace function public.require_owner(gid uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.group_members m
                 where m.group_id = gid and m.player_id = (select auth.uid()) and m.role = 'owner') then
    raise exception 'Only the group''s owner can do that.' using errcode = '42501';
  end if;
end $$;

create or replace function public.clean_group_name(p_name text)
returns text language plpgsql immutable set search_path = '' as $$
declare n text := btrim(coalesce(p_name, ''));
begin
  if char_length(n) not between 1 and 40 then
    raise exception 'Group names are 1 to 40 characters.' using errcode = '22023';
  end if;
  return n;
end $$;

-- Creates a group with the caller as its owner. Returns {id, name, code}.
create or replace function public.create_group(p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); g public.groups;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if (select count(*) from public.group_members m where m.player_id = me) >= 10 then
    raise exception 'You can be in up to 10 groups.' using errcode = '54000';
  end if;
  insert into public.groups (name, invite_code, created_by)
    values (public.clean_group_name(p_name), public.new_invite_code(), me) returning * into g;
  insert into public.group_members (group_id, player_id, role) values (g.id, me, 'owner');
  return jsonb_build_object('id', g.id, 'name', g.name, 'code', g.invite_code);
end $$;

-- What an invite link points to, so the page can ask "Join <name>?". Null if the code is wrong.
create or replace function public.preview_group(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare g public.groups;
begin
  select * into g from public.groups where invite_code = upper(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  return jsonb_build_object(
    'id', g.id, 'name', g.name,
    'members', (select count(*) from public.group_members m where m.group_id = g.id),
    'member', exists (select 1 from public.group_members m where m.group_id = g.id and m.player_id = (select auth.uid())));
end $$;

-- Joins the group an invite code belongs to. Returns {id, name}. Joining twice is a no-op.
create or replace function public.join_group(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); g public.groups;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  select * into g from public.groups where invite_code = upper(btrim(coalesce(p_code, '')));
  if not found then raise exception 'That invite link doesn''t work anymore. Ask for a new one.' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.group_members m where m.group_id = g.id and m.player_id = me) then
    if (select count(*) from public.group_members m where m.player_id = me) >= 10 then
      raise exception 'You can be in up to 10 groups.' using errcode = '54000';
    end if;
    if (select count(*) from public.group_members m where m.group_id = g.id) >= 50 then
      raise exception 'That group is full (50 players).' using errcode = '54000';
    end if;
    insert into public.group_members (group_id, player_id) values (g.id, me);
  end if;
  return jsonb_build_object('id', g.id, 'name', g.name);
end $$;

-- Leaves a group. An owner who leaves hands the group to the longest-standing member;
-- the last player out deletes it.
create or replace function public.leave_group(p_group uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); was text; heir uuid;
begin
  delete from public.group_members where group_id = p_group and player_id = me returning role into was;
  if was is null then return; end if;
  select m.player_id into heir from public.group_members m where m.group_id = p_group order by m.joined_at limit 1;
  if heir is null then
    delete from public.groups where id = p_group;
  elsif was = 'owner' then
    update public.group_members set role = 'owner' where group_id = p_group and player_id = heir;
  end if;
end $$;

create or replace function public.rename_group(p_group uuid, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_owner(p_group);
  update public.groups set name = public.clean_group_name(p_name) where id = p_group;
end $$;

-- Swaps in a new invite code; the old link stops working. Returns the new code.
create or replace function public.reset_invite(p_group uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare code text := public.new_invite_code();
begin
  perform public.require_owner(p_group);
  update public.groups set invite_code = code where id = p_group;
  return code;
end $$;

create or replace function public.remove_member(p_group uuid, p_player uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_owner(p_group);
  if p_player = (select auth.uid()) then
    raise exception 'To leave your own group, use Leave group.' using errcode = '22023';
  end if;
  delete from public.group_members where group_id = p_group and player_id = p_player;
end $$;

-- Supabase lets anyone call public functions by default; narrow that down.
revoke execute on function
  public.is_group_member(uuid), public.new_invite_code(), public.require_owner(uuid), public.clean_group_name(text),
  public.create_group(text), public.preview_group(text), public.join_group(text), public.leave_group(uuid),
  public.rename_group(uuid, text), public.reset_invite(uuid), public.remove_member(uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  public.is_group_member(uuid), public.create_group(text), public.join_group(text), public.leave_group(uuid),
  public.rename_group(uuid, text), public.reset_invite(uuid), public.remove_member(uuid, uuid)
  to authenticated;
grant execute on function public.preview_group(text) to anon, authenticated;
