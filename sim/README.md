# Economy simulation notes

`node sim/economy-sim.js 100 active full` plays the real game with a greedy bot on a fake clock
(see the header of economy-sim.js). Results are saved to `sim/last-run-*.json`.

## Finding (Sept 29, 2026 run, active bot, Exit + Fund Raise + IPO + Office equipment)

| Seasons | Minutes per season |
|---|---|
| 1-7 | flat, about 7-9 |
| 8 (first IPO) | 15 |
| 12 / 15 / 19 | 23 / 109 / 212 |

From about Season 10 on, each season takes a fixed multiple of the last: **t(n) = t(12) x 1.37^(n-12)**.
Fit on seasons 12-17, it predicted 18 and 19 within 3-4% (160 vs 155, 220 vs 212).

## Why (derivation from the code)

- Exit target is exactly `10M x SEASON_DIFFICULTY_GROWTH^n` (1.6^n).
- Season time = target / average income, so time ratio per season k = D / G, where D = 1.6 and
  G = how fast income grows per season from Serial/LP/IPO bonuses (polynomial, not exponential).
- Measured k = 1.37 gives G = 1.6 / 1.37 = **1.17 per season**.
- Because D is exponential and G is not, k never falls below D/G: seasons get longer forever.

## What that means for the 100-season plan (at k = 1.37)

Season length reaches 1 hour at S15, 1 day at S25, 1 week at S31, 1 month at S36, 1 year at S44.
Rooms unlocking at S8-38 and luxury items at S42-58 are past what a player can reach.

## Fix: choose the pacing, then solve for the constant

`SEASON_DIFFICULTY_GROWTH = desired_k x 1.17`. For example desired_k 1.05 gives D about 1.23
(Season 100 about a week long); 1.08 gives about 1.26 (about 75 days); 1.10 gives about 1.28.
Caveat: G was measured over seasons 10-19 only. Later unlocks (equipment, cards) change it, so
re-run the sim after any change and adjust.

## After the change: SEASON_DIFFICULTY_GROWTH 1.6 -> 1.23 (target ~5% longer per season)

Active bot, same policy, 32 seasons run. Seasons 1-25 stay at 3-10 minutes, Season 29 (an IPO season)
22 min, Season 32 25 min. A log-linear fit over seasons 12-32 gives k = 1.095 per season (steeper than the
1.05 target because income growth slows a little as caps and one-time boosts run out).
Projection: Season 50 about 2 hours, Season 75 about 17 hours, Season 100 about 7 days;
about 77 days of active play in total. To flatten further, lower the constant toward 1.20-1.21
and re-run: `node sim/economy-sim.js 45 active full`.
