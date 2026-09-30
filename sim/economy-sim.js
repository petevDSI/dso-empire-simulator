/* DSO Empire Simulator — economy pacing simulation.
 *
 *   node sim/economy-sim.js [seasons=100] [profile=active|casual|both] [policy=full|exit]
 *   env: MAX_SEASON_HOURS (stall cutoff, default 72), REAL_BUDGET_MIN (wall-clock limit, default 60)
 *
 * Runs the REAL game (not a re-implementation of its formulas) in headless Chromium on a fake
 * clock, driven by a simple greedy bot, and reports how many simulated minutes each season
 * takes. Because it uses the shipped index.html, every future balance change is measured the
 * same way with no formulas to keep in sync.
 *
 * To make hours of play run in seconds it patches a TEMP COPY (never the real file):
 * the 100ms game tick becomes 1s (the game scales each tick by TICK_MS, so production is
 * identical, only coarser) and the audio scheduler timer is disabled.
 *
 * Bot profiles:
 *   active — checks in every 5s of game time, clicks 2x/sec, spends everything it can.
 *   casual — checks in every 15 min, no clicking (a player who returns a few times a day).
 * Bot rules (deliberately simple, so results are a *baseline*, not an optimal-play ceiling):
 * collect ready cash, buy every affordable Initiative, hire the highest-tier affordable role
 * until none are, Exit the moment it is offered.
 */
const fs = require("fs"), path = require("path"), http = require("http");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright")); }

const ROOT = path.resolve(__dirname, "..");
const SEASONS = parseInt(process.argv[2] || "100", 10);
const PROFILE = process.argv[3] || "both";
const POLICY = process.argv[4] || "full"; // full | exit
const SAVE_KEY = "dso-empire-simulator-save-v2";
const MAX_SEASON_SIM_HOURS = parseInt(process.env.MAX_SEASON_HOURS || "72", 10);
const REAL_BUDGET_MIN = parseInt(process.env.REAL_BUDGET_MIN || "60", 10);

function buildPatchedCopy() {
  let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const before = html.length;
  html = html.replace("var TICK_MS = 100;", "var TICK_MS = 1000;");
  html = html.replace("musicTimer = setInterval(musicSchedulerTick, 60);", "musicTimer = setInterval(musicSchedulerTick, 3600000);");
  if (!html.includes("var TICK_MS = 1000;")) throw new Error("could not patch TICK_MS — has the tick constant been renamed?");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "dso-sim-"));
  fs.writeFileSync(path.join(dir, "index.html"), html);
  const assets = path.join(ROOT, "assets");
  if (fs.existsSync(assets)) fs.symlinkSync(assets, path.join(dir, "assets"));
  return dir;
}

function serve(dir) {
  return new Promise(r => { const s = http.createServer((q, res) => {
    let p = q.url.split("?")[0]; if (p === "/") p = "/index.html";
    const f = path.join(dir, p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : f.endsWith(".jpg") ? "image/jpeg" : f.endsWith(".png") ? "image/png" : f.endsWith(".webp") ? "image/webp" : "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  }).listen(0, () => r(s)); });
}

// Runs inside the page: one "turn" of the bot. Returns what it did.
// policy "exit"  — only Exits (baseline; ignores Fund Raise, IPO, Office equipment).
// policy "full"  — also raises a fund when it has no LP, waits for IPO once one is possible,
//                  rings the bell, spends IPO shares on perks and buys Office equipment.
function botTurn(opts) {
  const out = { exited: false, kind: null, buys: 0 };
  const isOpen = () => { const o = document.getElementById("modal-overlay"); return o && !o.hidden; };
  const okModal = () => { if (isOpen()) { document.getElementById("modal-confirm").click(); return true; } return false; };
  okModal();
  const intro = document.getElementById("logo-intro"); if (intro) intro.remove();
  for (let i = 0; i < opts.clicks; i++) document.getElementById("click-btn").click();
  document.querySelectorAll("button[data-collect]").forEach(b => { if (!b.disabled) b.click(); });
  const opt = document.querySelector("[data-board-opt]:not([disabled])"); if (opt) opt.click();
  const canClick = b => !b.disabled && !/owned-btn|capped-btn|locked-btn/.test(b.className);
  for (let guard = 0; guard < 300; guard++) {
    const up = Array.from(document.querySelectorAll("#upgrade-rows .row-buy")).find(canClick);
    if (up) { up.click(); out.buys++; okModal(); continue; }
    const gens = Array.from(document.querySelectorAll("button[data-gen]")).filter(canClick);
    if (gens.length) { gens[gens.length - 1].click(); out.buys++; okModal(); continue; }
    if (opts.policy === "full") {
      const perk = Array.from(document.querySelectorAll("[data-ipo-perk]")).find(canClick);
      if (perk) { perk.click(); out.buys++; okModal(); continue; }
      const eq = Array.from(document.querySelectorAll(".office-buy-btn")).find(b => canClick(b) && !b.closest(".ceo-slot"));
      if (eq) { eq.click(); out.buys++; okModal(); continue; }
    }
    break;
  }
  const finish = kind => { if (isOpen()) { document.getElementById("modal-confirm").click(); out.exited = true; out.kind = kind; } };
  const save = JSON.parse(localStorage.getItem(opts.saveKey) || "{}");
  const ex = document.getElementById("exit-btn");
  const exitReady = ex && ex.getAttribute("aria-disabled") === "false";
  if (opts.policy === "full") {
    const ipoBtn = document.getElementById("ipo-btn");
    if (ipoBtn && !ipoBtn.disabled) { ipoBtn.click(); finish("ipo"); return out; }
    const fundBtn = document.getElementById("fund-btn");
    const ipoPossible = (save.ipoCount || 0) > 0 || ((save.seasonsCompleted || 0) >= 7 && (save.lpPoints || 0) >= 1);
    if (exitReady) {
      if ((save.lpPoints || 0) < 1 && fundBtn && !fundBtn.disabled) { fundBtn.click(); finish("fund"); return out; }
      if (ipoPossible && (save.lpPoints || 0) >= 1) return out; // hold the run until the valuation reaches IPO level
      ex.click(); finish("exit");
    }
    return out;
  }
  if (exitReady) { ex.click(); finish("exit"); }
  return out;
}

async function runProfile(browser, base, name, stepMs, clicksPerStep) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await ctx.addInitScript(([k]) => {
    localStorage.setItem("dso-empire-simulator-splash-seen-v1", "1");
    try { const s = JSON.parse(localStorage.getItem(k) || "null"); if (!s) localStorage.setItem(k, JSON.stringify({ flagshipAsked: true, tutorialStep: 99, flagshipName: "Sim Dental" })); } catch (e) {}
  }, [SAVE_KEY]);
  await page.clock.install({ time: new Date() });
  await page.goto(base + "/index.html");
  await page.clock.runFor(4000);
  // Mark tutorial/flagship modals as done on the freshly created default state
  await page.evaluate(k => { const s = JSON.parse(localStorage.getItem(k)); s.flagshipAsked = true; s.tutorialStep = 99; localStorage.setItem(k, JSON.stringify(s)); }, SAVE_KEY);
  await page.reload(); await page.clock.runFor(4000);

  const rows = []; let seasonStartMs = 0, simMs = 0;
  let season = 0;
  const t0 = Date.now();
  while (season < SEASONS) {
    const cap = MAX_SEASON_SIM_HOURS * 3600 * 1000;
    let turnResult;
    // adaptive step: fine-grained early in a season, coarser as seasons stretch into hours,
    // so a 100-season run finishes in reasonable real time (max 30 game-minutes per bot turn)
    const thisStep = Math.max(stepMs, Math.min(30 * 60 * 1000, Math.floor((simMs - seasonStartMs) / 400)));
    await page.clock.runFor(thisStep); simMs += thisStep;
    turnResult = await page.evaluate(botTurn, { clicks: clicksPerStep, policy: POLICY, saveKey: SAVE_KEY });
    if (turnResult.exited) {
      season++;
      const save = await page.evaluate(k => { const s = JSON.parse(localStorage.getItem(k) || "{}"); return { seasons: s.seasonsCompleted, np: s.prestigePoints }; }, SAVE_KEY);
      rows.push({ season, kind: turnResult.kind, minutes: +((simMs - seasonStartMs) / 60000).toFixed(1), realSec: +((Date.now() - t0) / 1000).toFixed(0) });
      process.stdout.write(`  [${name}] season ${season} (${turnResult.kind}) after ${((simMs - seasonStartMs) / 60000).toFixed(1)} sim-min\n`);
      fs.writeFileSync(path.join(__dirname, "last-run-" + name + "-" + POLICY + ".json"), JSON.stringify(rows, null, 2));
      seasonStartMs = simMs;
    } else if (simMs - seasonStartMs > cap) {
      rows.push({ season: season + 1, minutes: null, stalled: true });
      process.stdout.write(`  [${name}] season ${season + 1} did NOT finish within ${MAX_SEASON_SIM_HOURS} sim-hours (stalled)\n`);
      break;
    }
    if (Date.now() - t0 > REAL_BUDGET_MIN * 60 * 1000) { process.stdout.write("  (real-time budget hit)\n"); break; }
  }
  await ctx.close();
  return rows;
}

(async () => {
  const dir = buildPatchedCopy(); const srv = await serve(dir); const base = "http://localhost:" + srv.address().port;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const results = {};
  if (PROFILE === "active" || PROFILE === "both") results.active = await runProfile(browser, base, "active", 5000, 10);
  if (PROFILE === "casual" || PROFILE === "both") results.casual = await runProfile(browser, base, "casual", 15 * 60 * 1000, 0);
  await browser.close(); srv.close();
  console.log("\nSimulated minutes per season (Exit to Exit):");
  console.log("season | " + Object.keys(results).map(k => k.padEnd(10)).join(" | "));
  for (let i = 0; i < SEASONS; i++) {
    console.log(String(i + 1).padStart(6) + " | " + Object.keys(results).map(k => { const r = results[k][i]; return (r ? (r.stalled ? "STALLED" : String(r.minutes)) : "-").padEnd(10); }).join(" | "));
  }
  fs.writeFileSync(path.join(__dirname, "last-run.json"), JSON.stringify(results, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
