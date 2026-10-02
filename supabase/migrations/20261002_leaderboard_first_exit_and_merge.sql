-- Fix: every player's FIRST leaderboard submission was rejected as "networth_implausible".
-- Cause: the plausibility cap was (seconds since the player's row was created) * 25,000/s, and the row is
-- created by that very first submission, so the cap was always the $5,000 floor.
-- Fix 1: until a player has an accepted net-worth score, allow up to a generous one-time ceiling ($1B);
--        after that the cap is (best score so far) + (seconds since last event) * 25,000/s. The first
--        submission also no longer sets fastest_exit_ms (it would be meaningless: 0 seconds).
-- Fix 2: when an account that already owns a player signs in from a browser with a different anonymous
--        player, merge them (best net worth, fastest exit, most IPO shares) instead of abandoning it.

create or replace function public.dso_submit_event(
  p_player_id uuid, p_name text, p_event_type text,
  p_net_worth numeric default null, p_ipo_shares integer default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_player public.dso_players;
  v_first boolean;
  v_now timestamptz := now();
  v_elapsed_ms bigint;
  v_since_last_s numeric;
  v_clean_name text;
  v_name_flagged boolean := false;
  v_reason text := null;
  v_accepted boolean := true;
  v_max_net_worth numeric;
  v_max_ipo_delta integer := 25;
  v_min_exit_ms bigint := 60000;
  v_rate_limit_ms bigint := 2000;
  v_net_worth_rate numeric := 25000;
  v_first_ceiling numeric := 1000000000;
begin
  if p_event_type not in ('exit','fundraise','ipo') then
    return jsonb_build_object('accepted', false, 'reason', 'bad_event_type');
  end if;
  if p_player_id is null then
    return jsonb_build_object('accepted', false, 'reason', 'missing_player_id');
  end if;

  v_clean_name := trim(substring(regexp_replace(coalesce(p_name,''), '[[:cntrl:]]', '', 'g'), 1, 24));
  if v_clean_name = '' then
    v_clean_name := 'Anonymous DSO';
  elsif public.dso_contains_profanity(v_clean_name) then
    v_clean_name := 'Anonymous DSO';
    v_name_flagged := true;
  end if;

  insert into public.dso_players (id, display_name, created_at, updated_at)
  values (p_player_id, v_clean_name, v_now, v_now)
  on conflict (id) do update set display_name = v_clean_name, updated_at = v_now
  returning * into v_player;

  if v_player.last_event_at is not null and (v_now - v_player.last_event_at) < (v_rate_limit_ms::text || ' milliseconds')::interval then
    return jsonb_build_object('accepted', false, 'reason', 'rate_limited', 'name_flagged', v_name_flagged);
  end if;

  v_first := coalesce(v_player.best_net_worth, 0) = 0;
  v_elapsed_ms := floor(extract(epoch from (v_now - v_player.created_at)) * 1000);

  if p_net_worth is not null then
    if v_first then
      v_max_net_worth := v_first_ceiling;
    else
      v_since_last_s := extract(epoch from (v_now - coalesce(v_player.last_event_at, v_player.created_at)));
      v_max_net_worth := greatest(5000, v_player.best_net_worth + v_since_last_s * v_net_worth_rate);
    end if;
    if p_net_worth < v_player.best_net_worth then
      v_accepted := false; v_reason := 'networth_decreased';
    elsif p_net_worth > v_max_net_worth then
      v_accepted := false; v_reason := 'networth_implausible';
    else
      update public.dso_players set best_net_worth = p_net_worth where id = p_player_id;
    end if;
  end if;

  if v_accepted and not v_first and p_event_type = 'exit' and v_player.fastest_exit_ms is null then
    if v_elapsed_ms < v_min_exit_ms then
      v_accepted := false; v_reason := 'exit_too_fast';
    else
      update public.dso_players set fastest_exit_ms = v_elapsed_ms where id = p_player_id;
    end if;
  end if;

  if v_accepted and p_ipo_shares is not null then
    if p_ipo_shares < v_player.ipo_shares_total then
      v_accepted := false; v_reason := 'ipo_decreased';
    elsif (p_ipo_shares - v_player.ipo_shares_total) > v_max_ipo_delta then
      v_accepted := false; v_reason := 'ipo_jump_implausible';
    else
      update public.dso_players set ipo_shares_total = p_ipo_shares where id = p_player_id;
    end if;
  end if;

  update public.dso_players set last_event_at = v_now, updated_at = v_now where id = p_player_id;

  insert into public.dso_events_log(player_id, event_type, submitted, accepted, reject_reason)
  values (p_player_id, p_event_type, jsonb_build_object('net_worth', p_net_worth, 'ipo_shares', p_ipo_shares, 'name_flagged', v_name_flagged), v_accepted, v_reason);

  return jsonb_build_object('accepted', v_accepted, 'reason', v_reason, 'elapsed_ms', v_elapsed_ms, 'name_flagged', v_name_flagged);
end;
$function$;

create or replace function public.dso_claim_player(p_player_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_owned public.dso_players;
  v_target public.dso_players;
  v_merged boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;
  select * into v_owned from public.dso_players where user_id = v_uid;
  if found then
    if p_player_id is not null and p_player_id <> v_owned.id then
      select * into v_target from public.dso_players where id = p_player_id for update;
      if found and v_target.user_id is null then
        update public.dso_players set
          best_net_worth = greatest(v_owned.best_net_worth, v_target.best_net_worth),
          fastest_exit_ms = case when v_owned.fastest_exit_ms is null then v_target.fastest_exit_ms
                                 when v_target.fastest_exit_ms is null then v_owned.fastest_exit_ms
                                 else least(v_owned.fastest_exit_ms, v_target.fastest_exit_ms) end,
          ipo_shares_total = greatest(v_owned.ipo_shares_total, v_target.ipo_shares_total),
          display_name = case when v_owned.display_name = 'Anonymous DSO' then v_target.display_name else v_owned.display_name end,
          created_at = least(v_owned.created_at, v_target.created_at),
          updated_at = now()
        where id = v_owned.id;
        update public.dso_events_log set player_id = v_owned.id where player_id = p_player_id;
        delete from public.dso_players where id = p_player_id;
        v_merged := true;
      end if;
    end if;
    return jsonb_build_object('ok', true, 'player_id', v_owned.id,
      'adopted', v_owned.id is distinct from p_player_id, 'linked_now', false, 'merged', v_merged);
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
  return jsonb_build_object('ok', true, 'player_id', p_player_id, 'adopted', false, 'linked_now', true, 'merged', false);
exception when unique_violation then
  select * into v_owned from public.dso_players where user_id = v_uid;
  return jsonb_build_object('ok', true, 'player_id', v_owned.id,
    'adopted', v_owned.id is distinct from p_player_id, 'linked_now', false, 'merged', false);
end $$;
