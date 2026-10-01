-- PART 2a (NOT APPLIED: the database tool declined this twice, likely because it deletes from auth.users). Self-serve account deletion. New function only.
create or replace function public.dso_delete_account()
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  -- blank the leaderboard row (kept only as an anonymous, zeroed record) and unlink it
  update public.dso_players
    set user_id = null, display_name = 'Anonymous DSO', best_net_worth = 0,
        fastest_exit_ms = null, ipo_shares_total = 0, updated_at = now()
    where user_id = v_uid;
  delete from auth.users where id = v_uid;  -- cascades to dso_cloud_saves and dso_email_prefs
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.dso_delete_account() from public, anon;
grant execute on function public.dso_delete_account() to authenticated;
