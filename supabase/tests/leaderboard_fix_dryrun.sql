-- Safe dry run: paste this AFTER the migration into the Supabase SQL editor. It creates throwaway test rows,
-- prints the results inside an error message ('RESULT [...]'), and rolls everything back.
-- Expected: first_exit_25M accepted:true; first_exit_5T_rejected networth_implausible; second_exit_ok accepted:true;
-- second_exit_jump_rejected networth_implausible; decrease_rejected networth_decreased; prior_rejected_player_now_ok accepted:true;
-- claim_merge merged:true, merged_row best 12000000, name OldRejected, old_row_gone true.
do $t$
declare u uuid := gen_random_uuid(); a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); r jsonb; out jsonb := '[]'::jsonb;
begin
  -- brand-new player: first exit of $25.6M must be accepted, fastest stays null
  r := public.dso_submit_event(a,'Tester','exit',25630850.97,null);
  out := out || jsonb_build_array(jsonb_build_object('first_exit_25M', r));
  out := out || jsonb_build_array(jsonb_build_object('row_after_first', (select jsonb_build_object('best',best_net_worth,'fastest',fastest_exit_ms) from dso_players where id=a)));
  -- first exit absurd (> $1B) still rejected
  r := public.dso_submit_event(b,'Cheat','exit',5e12,null);
  out := out || jsonb_build_array(jsonb_build_object('first_exit_5T_rejected', r));
  -- second exit 10 min later, modest increase -> accepted; implausible jump -> rejected
  update dso_players set last_event_at = now() - interval '10 minutes', created_at = now() - interval '2 hours' where id=a;
  r := public.dso_submit_event(a,'Tester','exit',26500000,null);
  out := out || jsonb_build_array(jsonb_build_object('second_exit_ok', r));
  update dso_players set last_event_at = now() - interval '10 minutes' where id=a;
  r := public.dso_submit_event(a,'Tester','exit',900000000,null);
  out := out || jsonb_build_array(jsonb_build_object('second_exit_jump_rejected', r));
  update dso_players set last_event_at = now() - interval '10 minutes' where id=a;
  r := public.dso_submit_event(a,'Tester','exit',1000,null);
  out := out || jsonb_build_array(jsonb_build_object('decrease_rejected', r));
  out := out || jsonb_build_array(jsonb_build_object('row_after', (select jsonb_build_object('best',best_net_worth,'fastest',fastest_exit_ms) from dso_players where id=a)));
  -- existing-style row: first event rejected earlier (best=0, last_event_at recent): now accepted
  insert into dso_players(id,display_name,created_at,last_event_at) values (c,'OldRejected', now()-interval '3 days', now()-interval '1 minute');
  r := public.dso_submit_event(c,'OldRejected','exit',12000000,null);
  out := out || jsonb_build_array(jsonb_build_object('prior_rejected_player_now_ok', r));
  -- merge on claim
  insert into auth.users(id,aud,role,email) values (u,'authenticated','authenticated','m@example.test');
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  insert into dso_players(id,display_name,user_id,best_net_worth) values (gen_random_uuid(),'Anonymous DSO',u,0);
  perform 1;
  r := public.dso_claim_player(c);
  out := out || jsonb_build_array(jsonb_build_object('claim_merge', r - 'player_id', 'merged_row', (select jsonb_build_object('best',best_net_worth,'name',display_name,'linked',user_id=u) from dso_players where user_id=u), 'old_row_gone', not exists(select 1 from dso_players where id=c), 'events_moved', (select count(*) from dso_events_log e join dso_players p on p.id=e.player_id where p.user_id=u)));
  raise exception 'RESULT %', out::text;
end $t$;
