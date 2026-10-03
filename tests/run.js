/* DSO Empire Simulator — regression suite.
 *
 *   node tests/run.js
 *
 * Needs Playwright (npm i -D playwright) and a Chromium build. Set CHROMIUM_PATH if Playwright
 * can't find its own browser. Serves the repo root on a random local port, then drives the real
 * page: it seeds localStorage with a crafted save BEFORE the page's own scripts run, clicks real
 * buttons, and reads the DOM / saved state back. The game's functions live inside an IIFE, so
 * nothing here calls internals directly.
 *
 * Covers: purchase flow, offline earnings + the x2 sponsor option, streak + grace day,
 * reset carry-over (Exit), analytics events. Add a test by pushing onto `tests` below.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); }
catch (e) { ({ chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright")); }

const ROOT = path.resolve(__dirname, "..");
const SAVE_KEY = "dso-empire-simulator-save-v2";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain" };

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/index.html";
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
      fs.createReadStream(f).pipe(res);
    }).listen(0, () => resolve(srv));
  });
}

function dayStr(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

let browser, base;

// Opens a fresh page. `mutate(save)` edits the default save before the game's own scripts run.
async function openGame(defaultSave, mutate, query) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.emulateMedia?.({ colorScheme: "light" }).catch(() => {});
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/favicon|net::ERR|Failed to load resource|googletag|doubleclick|supabase/i.test(m.text())) errors.push(m.text()); });
  if (mutate) {
    const save = JSON.parse(JSON.stringify(defaultSave));
    save.lastSeen = Date.now(); // a stale timestamp from the captured default would trigger a welcome-back modal
    mutate(save);
    await ctx.addInitScript(([k, v]) => {
      localStorage.setItem(k, v);
      localStorage.setItem("dso-empire-simulator-splash-seen-v1", "1");
    }, [SAVE_KEY, JSON.stringify(save)]);
  }
  await page.goto(base + "/index.html" + (query || ""));
  await page.waitForTimeout(1800);
  // The boot logo intro plays on every load and swallows clicks; dismiss it like a player would.
  await page.evaluate(() => { const i = document.getElementById("logo-intro"); if (i) i.remove(); });
  return { page, ctx, errors };
}
const readSave = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) || "null"), SAVE_KEY);
const modalText = page => page.evaluate(() => {
  const o = document.getElementById("modal-overlay");
  return o && !o.hidden ? { title: document.getElementById("modal-title").textContent, body: document.getElementById("modal-body").textContent,
    confirm: document.getElementById("modal-confirm").textContent, cancelShown: document.getElementById("modal-cancel").style.display !== "none" } : null;
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

let DEFAULT;

test("default save loads with no console errors and fires session_start", async () => {
  const { page, ctx, errors } = await openGame(DEFAULT, s => s, "?debug=analytics");
  const ev = await page.evaluate(() => (window.__dsoEvents || []).map(e => e.e));
  assert(ev.includes("session_start"), "no session_start event, got " + JSON.stringify(ev));
  assert(errors.length === 0, "console errors: " + errors.join(" | "));
  await ctx.close();
});

test("purchase flow: hiring the first hygienist spends cash and raises the next price", async () => {
  const { page, ctx } = await openGame(DEFAULT, s => { s.revenue = 5000; s.lifetimeRevenue = 5000; s.flagshipAsked = true; s.tutorialStep = 99; });
  // purchases only hit localStorage on the next autosave, so read the live DOM instead
  const read = () => page.evaluate(() => ({ cost: document.querySelector('button[data-gen="chair"] .buy-cost').textContent,
    cash: document.getElementById("stat-revenue").textContent }));
  const before = await read();
  await page.click('button[data-gen="chair"]');
  await page.waitForTimeout(500);
  const after = await read();
  assert(after.cost !== before.cost, "next hire price unchanged: " + before.cost);
  assert(after.cash !== before.cash, "cash display unchanged: " + before.cash);
  await ctx.close();
});

test("offline 2h away: welcome-back offers a sponsor double and doubling adds the earnings", async () => {
  const mk = s => { s.staff.chair = 10; s.upgrades.manager = true; s.revenue = 0; s.lifetimeRevenue = 1000; s.flagshipAsked = true; s.tutorialStep = 99;
    s.lastSeen = Date.now() - 2 * 3600 * 1000; };
  const { page, ctx } = await openGame(DEFAULT, mk);
  const m = await modalText(page);
  assert(m && m.title === "Welcome back", "no welcome-back modal");
  assert(/double it/i.test(m.confirm) && m.cancelShown, "double option missing: " + JSON.stringify(m));
  const before = (await readSave(page)).revenue;
  assert(before > 0, "offline earned nothing");
  await page.click("#modal-confirm");
  await page.waitForTimeout(5500); // simulated sponsor message
  const after = (await readSave(page)).revenue;
  assert(after > before * 1.8, "revenue " + before + " -> " + after + " (expected about 2x)");
  await ctx.close();
});

test("offline 2h away: declining leaves earnings untouched and restores the Cancel label", async () => {
  const mk = s => { s.staff.chair = 10; s.upgrades.manager = true; s.lifetimeRevenue = 1000; s.flagshipAsked = true; s.tutorialStep = 99; s.lastSeen = Date.now() - 2 * 3600 * 1000; };
  const { page, ctx } = await openGame(DEFAULT, mk);
  const before = (await readSave(page)).revenue;
  await page.click("#modal-cancel");
  await page.waitForTimeout(800);
  const after = (await readSave(page)).revenue;
  assert(after >= before && after < before * 1.2, "revenue changed unexpectedly " + before + " -> " + after);
  const label = await page.textContent("#modal-cancel");
  assert(label === "Cancel", "cancel label left as '" + label + "'");
  await ctx.close();
});

test("offline 5 min away: plain welcome-back (no double offer)", async () => {
  const mk = s => { s.staff.chair = 10; s.upgrades.manager = true; s.lifetimeRevenue = 1000; s.flagshipAsked = true; s.tutorialStep = 99; s.lastSeen = Date.now() - 5 * 60 * 1000; };
  const { page, ctx } = await openGame(DEFAULT, mk);
  const m = await modalText(page);
  assert(m && m.confirm === "Nice", "expected plain modal, got " + JSON.stringify(m));
  await ctx.close();
});

test("offline is capped at 8 hours", async () => {
  const run = async hours => {
    const { page, ctx } = await openGame(DEFAULT, s => { s.staff.chair = 10; s.upgrades.manager = true; s.lifetimeRevenue = 1000; s.flagshipAsked = true; s.tutorialStep = 99; s.lastSeen = Date.now() - hours * 3600 * 1000; });
    const r = (await readSave(page)).revenue; await ctx.close(); return r;
  };
  const r8 = await run(8), r48 = await run(48);
  assert(Math.abs(r48 - r8) / r8 < 0.05, "8h=" + r8 + " 48h=" + r48);
});

test("streak: consecutive day grows, one missed day is forgiven, grace is not repeatable, longer gap resets", async () => {
  const cases = [
    { name: "yesterday", last: dayStr(-1), count: 3, grace: "", expect: 4 },
    { name: "missed one day", last: dayStr(-2), count: 3, grace: "", expect: 3, graceSet: true },
    { name: "missed one day, grace used recently", last: dayStr(-2), count: 3, grace: dayStr(-3), expect: 1 },
    { name: "missed three days", last: dayStr(-4), count: 5, grace: "", expect: 1 },
  ];
  for (const c of cases) {
    const { page, ctx } = await openGame(DEFAULT, s => { s.streakCount = c.count; s.streakLastDate = c.last; s.streakGraceDate = c.grace; s.flagshipAsked = true; s.tutorialStep = 99; });
    const s = await readSave(page);
    assert(s.streakCount === c.expect, c.name + ": streak " + s.streakCount + ", expected " + c.expect);
    if (c.graceSet) assert(s.streakGraceDate === dayStr(0), c.name + ": grace date not recorded");
    await ctx.close();
  }
});

test("Exit: resets the run but keeps permanent fields (streak, grace, equipment, cards, net worth) and logs a prestige event", async () => {
  const mk = s => { s.revenue = 1e9; s.lifetimeRevenue = 1e10; s.staff.chair = 5; s.flagshipAsked = true; s.tutorialStep = 99;
    s.streakCount = 4; s.streakLastDate = dayStr(0); s.streakGraceDate = dayStr(-1); s.streakBonusPct = 0.2;
    s.equipTier = { operatory: { chair: 2 } }; s.desksUnlocked = ["desk-vending"]; s.netWorth = 123; };
  const { page, ctx } = await openGame(DEFAULT, mk, "?debug=analytics");
  await page.evaluate(() => { const t = document.querySelector('[data-tab="exit"]'); t && t.click(); });
  await page.click("#exit-btn");
  await page.waitForTimeout(400);
  const m = await modalText(page);
  assert(m && /Exit to Private Equity/.test(m.title), "exit modal did not open: " + JSON.stringify(m));
  await page.click("#modal-confirm");
  await page.waitForTimeout(1500);
  const s = await readSave(page);
  assert(s.seasonsCompleted === 1, "seasonsCompleted " + s.seasonsCompleted);
  assert(s.staff.chair === 0, "staff not reset: " + s.staff.chair);
  assert(s.streakCount === 4 && s.streakGraceDate === dayStr(-1), "streak/grace lost: " + s.streakCount + "/" + s.streakGraceDate);
  assert(s.equipTier && s.equipTier.operatory && s.equipTier.operatory.chair === 2, "equipment lost");
  assert(s.desksUnlocked.includes("desk-vending"), "desk card lost");
  assert(s.netWorth > 123, "net worth not increased: " + s.netWorth);
  const ev = await page.evaluate(() => (window.__dsoEvents || []).filter(e => e.e === "prestige"));
  assert(ev.length === 1 && ev[0].p.kind === "exit" && ev[0].p.first === true, "prestige event wrong: " + JSON.stringify(ev));
  await ctx.close();
});

test("beta: real-money Legendary Pack is hidden and never calls checkout", async () => {
  const { page, ctx } = await openGame(DEFAULT, s => s);
  const calls = [];
  page.on("request", r => { if (/create-checkout-session|stripe\.com/.test(r.url())) calls.push(r.url()); });
  for (const tab of ["collection", "ops", "exit", "office", "bonuses"]) {
    await page.evaluate(t => { const b = document.querySelector('[data-tab="' + t + '"]'); if (b) b.click(); }, tab);
    await page.waitForTimeout(150);
  }
  const rendered = await page.evaluate(() => !!document.querySelector("#xchg-pack-btn, #xchg-pack-row"));
  assert(!rendered, "pack row is rendered");
  assert(!/REAL MONEY/i.test(await page.evaluate(() => document.body.innerText)), "REAL MONEY label is visible");
  assert(calls.length === 0, "checkout was contacted: " + calls.join(", "));
  await ctx.close();
});

test("analytics stays silent on the network while disabled", async () => {
  const { page, ctx } = await openGame(DEFAULT, s => s);
  const sent = [];
  page.on("request", r => { if (r.method() === "POST") sent.push(r.url()); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  assert(sent.filter(u => !/supabase|stripe/.test(u)).length === 0, "unexpected POSTs: " + sent.join(", "));
  await ctx.close();
});

(async () => {
  const srv = await serve();
  base = "http://localhost:" + srv.address().port;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  // grab a real default save once
  const boot = await browser.newContext(); const bp = await boot.newPage();
  await bp.goto(base + "/index.html"); await bp.waitForTimeout(2000);
  DEFAULT = await bp.evaluate(k => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
  await boot.close();
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("PASS  " + t.name); }
    catch (e) { failed++; console.log("FAIL  " + t.name + "\n      " + e.message); }
  }
  await browser.close(); srv.close();
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
  process.exit(failed ? 1 : 0);
})();
