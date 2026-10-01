-- DSO Empire Simulator: optional accounts, cloud save, email preferences (PART 1: additive only).
-- New tables/functions only. Does not touch any function the live game already calls.
-- Tables are locked (RLS on, no policies); the browser reaches them only through SECURITY DEFINER
-- functions keyed to auth.uid().

alter table public.dso_players
  add column if not exists user_id uuid references auth.users(id) on delete set null;
create unique index if not exists dso_players_user_id_key
  on public.dso_players(user_id) where user_id is not null;

create table if not exists public.dso_cloud_saves (
  user_id uuid primary key references auth.users(id) on delete cascade,
  save jsonb not null,
  progress numeric not null default 0,
  summary jsonb,
  updated_at timestamptz not null default now()
);
alter table public.dso_cloud_saves enable row level security;
revoke all on table public.dso_cloud_saves from anon, authenticated;

create table if not exists public.dso_email_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  marketing_opt_in boolean not null default false,
  marketing_changed_at timestamptz,
  marketing_consent_version text,
  notify_events boolean not null default false,
  notify_outranked boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.dso_email_prefs enable row level security;
revoke all on table public.dso_email_prefs from anon, authenticated;

create or replace function public.dso_claim_player(p_player_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_owned public.dso_players;
  v_target public.dso_players;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;
  select * into v_owned from public.dso_players where user_id = v_uid;
  if found then
    return jsonb_build_object('ok', true, 'player_id', v_owned.id,
      'adopted', v_owned.id is distinct from p_player_id, 'linked_now', false);
  end if;
  if p_player_id is null then
    p_player_id := gen_random_uuid();
  end if;
  select * into v_target from public.dso_players where id = p_player_id for update;
  if found then
    if v_target.user_id is not null and v_target.user_id <> v_uid then
      return jsonb_build_object('ok', false, 'reason', 'owned_by_other');
    end if;
    update public.dso_players set user_id = v_uid, updated_at = now() where id = p_player_id;
  else
    insert into public.dso_players(id, display_name, user_id) values (p_player_id, 'Anonymous DSO', v_uid);
  end if;
  return jsonb_build_object('ok', true, 'player_id', p_player_id, 'adopted', false, 'linked_now', true);
exception when unique_violation then
  select * into v_owned from public.dso_players where user_id = v_uid;
  return jsonb_build_object('ok', true, 'player_id', v_owned.id,
    'adopted', v_owned.id is distinct from p_player_id, 'linked_now', false);
end $$;

create or replace function public.dso_cloud_save_get()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.dso_cloud_saves;
  v_pid uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select id into v_pid from public.dso_players where user_id = v_uid;
  select * into v_row from public.dso_cloud_saves where user_id = v_uid;
  if not found then
    return jsonb_build_object('ok', true, 'found', false, 'player_id', v_pid);
  end if;
  return jsonb_build_object('ok', true, 'found', true, 'save', v_row.save, 'progress', v_row.progress,
    'summary', v_row.summary, 'updated_at', v_row.updated_at, 'player_id', v_pid);
end $$;

create or replace function public.dso_cloud_save_put(
  p_save jsonb, p_progress numeric, p_summary jsonb, p_base text, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.dso_cloud_saves;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  if p_save is null or jsonb_typeof(p_save) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'bad_save');
  end if;
  if octet_length(p_save::text) > 600000 then
    return jsonb_build_object('ok', false, 'reason', 'too_large');
  end if;
  select * into v_row from public.dso_cloud_saves where user_id = v_uid for update;
  if found then
    if (v_now - v_row.updated_at) < interval '3 seconds' and not p_force then
      return jsonb_build_object('ok', false, 'reason', 'rate_limited');
    end if;
    if not p_force and (p_base is null or p_base::timestamptz is distinct from v_row.updated_at) then
      return jsonb_build_object('ok', false, 'conflict', true, 'progress', v_row.progress,
        'summary', v_row.summary, 'updated_at', v_row.updated_at);
    end if;
    update public.dso_cloud_saves
      set save = p_save, progress = coalesce(p_progress, 0), summary = p_summary, updated_at = v_now
      where user_id = v_uid;
  else
    insert into public.dso_cloud_saves(user_id, save, progress, summary, updated_at)
    values (v_uid, p_save, coalesce(p_progress, 0), p_summary, v_now);
  end if;
  return jsonb_build_object('ok', true, 'updated_at', v_now);
end $$;

create or replace function public.dso_prefs_get()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_row public.dso_email_prefs;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select * into v_row from public.dso_email_prefs where user_id = v_uid;
  if not found then
    return jsonb_build_object('ok', true, 'marketing_opt_in', false, 'notify_events', false, 'notify_outranked', false);
  end if;
  return jsonb_build_object('ok', true, 'marketing_opt_in', v_row.marketing_opt_in,
    'notify_events', v_row.notify_events, 'notify_outranked', v_row.notify_outranked);
end $$;

create or replace function public.dso_prefs_set(
  p_marketing boolean, p_events boolean, p_outranked boolean, p_consent_version text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  insert into public.dso_email_prefs(user_id, marketing_opt_in, marketing_changed_at, marketing_consent_version,
      notify_events, notify_outranked, updated_at)
  values (v_uid, coalesce(p_marketing,false), case when coalesce(p_marketing,false) then now() end,
      case when coalesce(p_marketing,false) then left(p_consent_version, 40) end,
      coalesce(p_events,false), coalesce(p_outranked,false), now())
  on conflict (user_id) do update set
    marketing_opt_in = excluded.marketing_opt_in,
    marketing_changed_at = case when public.dso_email_prefs.marketing_opt_in is distinct from excluded.marketing_opt_in
                                then now() else public.dso_email_prefs.marketing_changed_at end,
    marketing_consent_version = case when excluded.marketing_opt_in then left(p_consent_version, 40) else null end,
    notify_events = excluded.notify_events,
    notify_outranked = excluded.notify_outranked,
    updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.dso_claim_player(uuid) from public, anon;
revoke execute on function public.dso_cloud_save_get() from public, anon;
revoke execute on function public.dso_cloud_save_put(jsonb, numeric, jsonb, text, boolean) from public, anon;
revoke execute on function public.dso_prefs_get() from public, anon;
revoke execute on function public.dso_prefs_set(boolean, boolean, boolean, text) from public, anon;
grant execute on function public.dso_claim_player(uuid) to authenticated;
grant execute on function public.dso_cloud_save_get() to authenticated;
grant execute on function public.dso_cloud_save_put(jsonb, numeric, jsonb, text, boolean) to authenticated;
grant execute on function public.dso_prefs_get() to authenticated;
grant execute on function public.dso_prefs_set(boolean, boolean, boolean, text) to authenticated;
