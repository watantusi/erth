#!/usr/bin/env node
/*
 * 分身便利店 CLONE MART — automated test suite
 *
 * Run (Playwright is taken from the global npm install):
 *   NODE_PATH=$(npm root -g) node clone-mart/tests/run.js
 *
 * Environment:
 *   THREE_JS=/path/to/three.min.js  serve this file for any request ending in three.min.js
 *                                  (use when the CDN is unreachable; default: real CDN)
 *   OUT_DIR=/some/dir               where screenshots go (default: <tmp>/clone-mart-tests-<time>)
 *   ONLY=regex                      run only groups whose name matches (smoke|input|logic|edge|path|save)
 *   FULL_DPR=1                      emulate the real device pixel ratio on iPhone/iPad (slow under SwiftShader;
 *                                  default renders mobile devices at DPR 1, layout/touch/UA unchanged)
 *   SUITE_TIMEOUT=secs              hard cap for the whole run (default 480)
 *   GAME_HTML=path                  test another copy of the game (default: ../index.html)
 *
 * The three device tracks (desktop / iPhone 13 / iPad) run in parallel, each in its own browser.
 * Logic tests drive the game through window.__cloneMart.sim() (1/30 s steps, no rendering), so they
 * are fast and deterministic; only smoke and input tests depend on real-time frames, and those poll
 * until the expected effect happens (so a slow software renderer only makes them slower, not flaky).
 *
 * Exit code: 0 = all PASS, 1 = at least one FAIL, 2 = suite crashed / timed out.
 * Google Fonts requests are always answered with empty CSS so the run is offline-safe.
 * Failed loads of other external URLs and failed screenshots are reported as WARN (not FAIL);
 * page errors and console errors are FAIL.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let playwright;
try { playwright = require('playwright'); }
catch (e) {
  console.error('Cannot load playwright. Run with: NODE_PATH=$(npm root -g) node clone-mart/tests/run.js');
  process.exit(2);
}
const { chromium, devices } = playwright;

const GAME = process.env.GAME_HTML ? path.resolve(process.env.GAME_HTML) : path.resolve(__dirname, '..', 'index.html');
const GAME_URL = pathToFileURL(GAME).href;
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'clone-mart-tests-' + Date.now());
const THREE_JS = process.env.THREE_JS && fs.existsSync(process.env.THREE_JS) ? fs.readFileSync(process.env.THREE_JS) : null;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
const SUITE_TIMEOUT_MS = (+process.env.SUITE_TIMEOUT || 480) * 1000;
const FULL_DPR = process.env.FULL_DPR === '1';
const CHROME_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const warnings = [];
const T0 = Date.now();

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const want = g => !ONLY || ONLY.test(g);

// One "track" per device; tests inside a track run sequentially, tracks run in parallel.
function makeTrack(order, label) {
  return async function test(group, name, fn) {
    if (!want(group)) return;
    const t = Date.now();
    let pass = false, detail = '';
    try {
      const r = await fn();
      pass = true; detail = typeof r === 'string' ? r : '';
    } catch (e) {
      detail = (e && e.message ? e.message : String(e)).split('\n')[0];
    }
    results.push({ order, seq: results.length, group, name, pass, detail, ms: Date.now() - t });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${label}/${group}] ${name}${detail ? ' — ' + detail : ''}`);
  };
}

/* ------------------------------------------------------------------ page helpers */
async function openGame(browser, label, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  const isFontUrl = u => /fonts\.(googleapis|gstatic)\.com/.test(u || '');
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    const text = m.text();
    if (isFontUrl(url) || isFontUrl(text) || (/font/i.test(text) && /fail|load/i.test(text))) return;
    if (/^Failed to load resource/.test(text) && /^https?:/.test(url)) { warnings.push(`${label}: network ${url}`); return; }
    errors.push('console: ' + text + (url ? ' @' + url : ''));
  });
  page.on('requestfailed', r => {
    const u = r.url();
    if (isFontUrl(u)) return;
    if (u.startsWith('file:')) errors.push('local file failed to load: ' + u);
    else warnings.push(`${label}: request failed ${u} (${r.failure() && r.failure().errorText})`);
  });
  if (THREE_JS) await page.route('**/three.min.js', r => r.fulfill({ body: THREE_JS, contentType: 'application/javascript' }));
  await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.route(/fonts\.gstatic\.com/, r => r.fulfill({ body: '', contentType: 'font/woff2' }));
  await page.goto(GAME_URL, { waitUntil: 'load', timeout: 45000 });
  await waitHook(page);
  return { ctx, page, errors, label };
}
async function waitHook(page) {
  await page.waitForFunction(() => window.__cloneMart && typeof window.__cloneMart.sim === 'function', null, { timeout: 45000 });
}
async function shot(page, name) {
  try { await page.screenshot({ path: path.join(OUT_DIR, name + '.png'), timeout: 30000 }); }
  catch (e) { warnings.push('screenshot ' + name + ' failed: ' + e.message.split('\n')[0]); }
}
async function state(page) { return page.evaluate(() => window.__cloneMart.G.state); }
async function waitState(page, s, timeout) {
  await page.waitForFunction(s => window.__cloneMart.G.state === s, s, { timeout: timeout || 15000 });
}
function noErrors(g) {
  assert(g.errors.length === 0, g.errors.length + ' error(s): ' + g.errors.slice(0, 3).join(' | '));
  return 'clean';
}
const OWNER = `(window.__cloneMart.staff.find(s => s.role === 'owner') || window.__cloneMart.staff[0])`;
async function ownerPos(page) {
  return page.evaluate(`(() => { const a = ${OWNER}.agent; return {x:a.pos.x, z:a.pos.z, path:a.path.length}; })()`);
}
// Park the owner in open floor (left of the queue, below the shelves) and stop spawning so nothing interferes.
async function placeOwner(page, x, z) {
  await page.evaluate(`(() => { const a = ${OWNER}.agent; a.pos.x = ${x}; a.pos.z = ${z}; a.path.length = 0; window.__cloneMart.G.spawnT = 1e9; })()`);
}
async function ensurePlaying(page) {
  if (await state(page) !== 'play') await page.evaluate(() => window.__cloneMart.startGame(null));
}
async function pollMoved(page, p0, pred, timeoutMs, tick) {
  const t = Date.now(); let p = p0;
  while (Date.now() - t < timeoutMs) {
    if (tick) await tick(); else await sleep(120);
    p = await ownerPos(page);
    if (pred(p)) return p;
  }
  return p;
}
async function startFromTitle(g, how) {
  const btn = g.page.locator('#btnNew');
  assert(await btn.isVisible(), '#btnNew (開始營業) not visible on title');
  if (how === 'tap') await btn.tap(); else await btn.click();
  await waitState(g.page, 'play', 15000);
  assert(await g.page.locator('#hud').isVisible(), 'HUD not visible after start');
  assert(await g.page.locator('#title').isHidden(), 'title still visible after start');
}
async function tapMoveTest(g, xFrac, yFrac) {
  const page = g.page, vp = page.viewportSize();
  await ensurePlaying(page);
  await placeOwner(page, -2, 3.5);
  const p0 = await ownerPos(page);
  await page.touchscreen.tap(vp.width * xFrac, vp.height * yFrac);
  const p1 = await ownerPos(page);
  const p2 = await pollMoved(page, p0, p => Math.hypot(p.x - p0.x, p.z - p0.z) > 0.3, 8000);
  const moved = Math.hypot(p2.x - p0.x, p2.z - p0.z);
  assert(p1.path > 0 || moved > 0.3, `no path after tap (path=${p1.path}, moved=${moved.toFixed(2)})`);
  assert(moved > 0.3, `path created but player did not move (moved=${moved.toFixed(2)})`);
  return `path=${p1.path} moved=${moved.toFixed(2)}`;
}

/* ------------------------------------------------------------------ in-page scenario runner */
// Runs synchronously inside the page (no frames interleave). Checks invariants every 0.5 s of sim time.
function scenarioInPage(cfg) {
  const C = window.__cloneMart, G = C.G;
  const N = window.__cloneMartNav || {};
  const MAX_CUPS = (N.consts && N.consts.MAX_CUPS) || 6;
  const MOVING = { arrive: 1, toShelf: 1, leave: 1, escape: 1 };
  const issues = [];
  const bad = m => { if (issues.length < 12 && !issues.includes(m)) issues.push(m); };
  const data = cfg.data && cfg.emptyStock ? Object.assign({}, cfg.data, { stock: Object.fromEntries(C.SHELVES.map(s => [s.id, 0])) }) : cfg.data;
  C.startGame(data);
  const owner = C.staff.find(s => s.role === 'owner') || C.staff[0];
  const park = cfg.park ? (N.spots && N.spots[cfg.park]) || null : null;
  const track = new Map();
  const days = [];
  let t = 0, lastDay = G.day, ended = null, dayT = 0;
  const STEP = 0.5;
  while (days.length < cfg.days) {
    if (park) { owner.agent.pos.x = park.x; owner.agent.pos.z = park.z; owner.agent.path.length = 0; }
    const st = C.sim(STEP); t += STEP; dayT += STEP;
    // --- invariants
    if (typeof G.money !== 'number' || !isFinite(G.money)) bad('money not finite: ' + G.money);
    if (cfg.noOverspend && (st === 'play' || st === 'closing') && G.money < -1e-6) bad('money negative mid-day: ' + G.money);
    if (!(G.rating >= 0 && G.rating <= 5)) bad('rating out of [0,5]: ' + G.rating);
    if (!(G.cups >= 0 && G.cups <= MAX_CUPS) || !Number.isFinite(G.cups)) bad('cups out of [0,' + MAX_CUPS + ']: ' + G.cups);
    for (const sh of C.SHELVES) if (!(sh.stock >= 0 && sh.stock <= sh.max) || !Number.isFinite(sh.stock)) bad(sh.id + ' stock out of range: ' + sh.stock);
    for (const s of C.staff) if (!isFinite(s.agent.pos.x) || !isFinite(s.agent.pos.z)) bad(s.role + ' position not finite');
    const seen = new Set();
    for (const c of C.queue) {
      if (c.state !== 'queue') bad('queued customer in state ' + c.state);
      if (seen.has(c)) bad('customer appears twice in queue');
      seen.add(c);
      if (!C.customers.includes(c)) bad('queued customer not in customers list');
    }
    for (const c of C.customers) {
      if (c.state === 'queue' && !seen.has(c)) bad('customer in state queue but missing from queue');
      if (!isFinite(c.agent.pos.x) || !isFinite(c.agent.pos.z)) bad('customer position not finite');
      if (MOVING[c.state]) {
        const r = track.get(c);
        if (!r || r.state !== c.state || Math.hypot(r.x - c.agent.pos.x, r.z - c.agent.pos.z) > 0.02) track.set(c, { x: c.agent.pos.x, z: c.agent.pos.z, t, state: c.state });
        else if (t - r.t > 20) bad(`customer stuck in '${c.state}' at (${c.agent.pos.x.toFixed(2)},${c.agent.pos.z.toFixed(2)}) for >20s`);
      } else track.delete(c);
    }
    // --- day flow
    if (st === 'summary') {
      const sum = document.querySelector('#summary');
      if (!sum || sum.hidden) bad('summary screen not shown at state summary');
      if (C.customers.length || C.queue.length || C.messes.length) bad('day entities not cleared at summary');
      days.push({ day: G.day, money: Math.round(G.money), rating: +G.rating.toFixed(2), served: G.stats.served, angry: G.stats.angry, stolen: G.stats.stolen, caught: G.stats.caught, secs: dayT });
      dayT = 0; track.clear();
      document.querySelector('#btnNext').click();
      if (G.state === 'over') { ended = 'over'; break; }
      if (G.state !== 'play') { bad('after 迎接下一天 state is ' + G.state); break; }
      if (G.day !== lastDay + 1) bad('day did not advance: ' + lastDay + ' -> ' + G.day);
      lastDay = G.day;
    } else if (st !== 'play' && st !== 'closing') { bad('unexpected state during sim: ' + st); break; }
    if (dayT > 300) { bad('day did not reach summary within 300 s of sim time'); break; }
  }
  return { issues, days, ended, finalState: G.state };
}
const setHidden = page => page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  delete document.hidden;
});

/* ================================================================== desktop track */
async function desktopTrack() {
  const test = makeTrack(0, 'desktop');
  const groups = ['smoke', 'input', 'path', 'logic', 'edge', 'save'];
  if (!groups.some(want)) return;
  const browser = await chromium.launch({ args: CHROME_ARGS });
  try {
    let D = null;
    try { D = await openGame(browser, 'desktop', { viewport: { width: 1280, height: 760 } }); }
    catch (e) { await test('smoke', 'desktop 1280x760 loads', () => { throw e; }); return; }
    const page = D.page;

    await test('smoke', 'desktop 1280x760: load, title, 開始營業, HUD', async () => {
      assert(await page.locator('#title').isVisible(), 'title screen not visible');
      await shot(page, 'desktop-title');
      await startFromTitle(D, 'click');
      await sleep(1000);
      await shot(page, 'desktop-play');
      assert(await state(page) === 'play', 'state not play after real-time frames');
      return 'state=play';
    });
    await test('smoke', 'desktop: no page/console errors after load+start', async () => noErrors(D));

    await test('input', 'desktop keyboard (A, then S) moves the player', async () => {
      await ensurePlaying(page);
      await placeOwner(page, -2, 3.5);
      await page.locator('#game').focus().catch(() => {});
      const p0 = await ownerPos(page);
      await page.keyboard.down('KeyA');
      const p1 = await pollMoved(page, p0, p => p.x < p0.x - 0.3, 8000);
      await page.keyboard.up('KeyA');
      await page.keyboard.down('KeyS');
      const p2 = await pollMoved(page, p1, p => p.z > p1.z + 0.3, 8000);
      await page.keyboard.up('KeyS');
      assert(p1.x < p0.x - 0.3, `A did not move left: x ${p0.x.toFixed(2)} -> ${p1.x.toFixed(2)}`);
      assert(p2.z > p1.z + 0.3, `S did not move down: z ${p1.z.toFixed(2)} -> ${p2.z.toFixed(2)}`);
      return `dx=${(p1.x - p0.x).toFixed(2)} dz=${(p2.z - p1.z).toFixed(2)}`;
    });
    await test('input', 'desktop click-to-move creates a path', async () => {
      await ensurePlaying(page);
      await placeOwner(page, -2, 3.5);
      const p0 = await ownerPos(page);
      await page.mouse.click(1280 * 0.72, 760 * 0.62);
      const p1 = await ownerPos(page);
      const p2 = await pollMoved(page, p0, p => Math.hypot(p.x - p0.x, p.z - p0.z) > 0.3, 8000);
      const moved = Math.hypot(p2.x - p0.x, p2.z - p0.z);
      assert(p1.path > 0 || moved > 0.3, `no path after click (path=${p1.path}, moved=${moved.toFixed(2)})`);
      assert(moved > 0.3, `path created but player did not move (moved=${moved.toFixed(2)})`);
      return `path=${p1.path} moved=${moved.toFixed(2)}`;
    });

    await test('path', 'every station / shelf / queue spot reachable from door', async () => {
      const r = await page.evaluate(() => {
        const N = window.__cloneMartNav, C = window.__cloneMart;
        if (!N || !N.findPath) return { missing: true };
        const door = N.spots.DOOR_OUT;
        const targets = [];
        for (const k of Object.keys(N.spots)) if (k !== 'DOOR_OUT') targets.push([k, N.spots[k]]);
        for (const sh of C.SHELVES) {
          const off = sh.id === 'drink' ? 2.6 : 1.1;   // customers browse at spot.x ± off
          for (const o of [-off, 0, off]) targets.push([`shelf:${sh.id}${o ? (o > 0 ? '+' : '') + o : ''}`, { x: sh.spot.x + o, z: sh.spot.z }]);
        }
        for (let i = 0; i < 16; i++) targets.push(['queue#' + i, N.queueSpot(i)]);   // up to 16 customers in store
        // A path is valid iff every leg passes the game's own line-of-sight test (same 0.18 sampling as lineClear);
        // findPath falls back to a single straight leg through walls when no route exists.
        const legClear = (ax, az, bx, bz) => { const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.18); for (let k = 1; k <= n; k++) if (!N.walkXZ(ax + (bx - ax) * k / n, az + (bz - az) * k / n)) return false; return true; };
        const fails = [];
        for (const [name, t] of targets) {
          if (!N.walkXZ(t.x, t.z)) { fails.push(name + ` (${t.x.toFixed(2)},${t.z.toFixed(2)}) not walkable`); continue; }
          const p = N.findPath(door.x, door.z, t.x, t.z);
          if (!p.length) { fails.push(name + ' empty path'); continue; }
          const last = p[p.length - 1];
          if (Math.hypot(last.x - t.x, last.z - t.z) > 0.05) { fails.push(name + ' path ends off-target'); continue; }
          let ax = door.x, az = door.z, ok = true;
          for (const q of p) { if (!legClear(ax, az, q.x, q.z)) ok = false; ax = q.x; az = q.z; }
          if (!ok) fails.push(name + ' unreachable (path goes through walls)');
        }
        const qs = new Set(); for (let i = 0; i < 16; i++) { const q = N.queueSpot(i); qs.add(q.x.toFixed(2) + ',' + q.z.toFixed(2)); }
        if (qs.size !== 16) fails.push('queue spots overlap');
        return { n: targets.length, fails };
      });
      assert(!r.missing, 'window.__cloneMartNav test hook missing');
      assert(r.fails.length === 0, r.fails.slice(0, 5).join('; '));
      return r.n + ' targets OK';
    });

    const ALL = lv => ({ cashier: lv, stocker: lv, cleaner: lv, barista: lv, guard: lv });
    const scenarios = [
      ['no clones, owner parked at register, 3 days', { data: null, days: 3, park: 'CASHIER_SPOT' }],
      ['no clones, idle owner, 2 days', { data: null, days: 2 }],
      ['all clones Lv1, 3 days', { data: { day: 2, money: 6000, rating: 3, cups: 2, clones: ALL(1) }, days: 3 }],
      ['all clones Lv3, 3 days (thieves)', { data: { day: 6, money: 30000, rating: 3.5, cups: 4, clones: ALL(3) }, days: 3 }],
      ['very poor player ($0, empty shelves, stocker+barista)', { data: { day: 4, money: 0, rating: 1.2, cups: 0, clones: { stocker: 1, barista: 1 } }, emptyStock: true, days: 2, noOverspend: true }],
      ['very poor player ($30, owner idle)', { data: { day: 3, money: 30, rating: 2, cups: 0 }, days: 2, noOverspend: true }],
    ];
    for (const [name, cfg] of scenarios) {
      await test('logic', name, async () => {
        const r = await page.evaluate(scenarioInPage, cfg);
        assert(r.days.length >= 1, 'never reached summary; ' + r.issues.join('; '));
        assert(r.issues.length === 0, r.issues.slice(0, 4).join('; '));
        const d = r.days.map(x => `D${x.day}:$${x.money}/★${x.rating}/served${x.served}/angry${x.angry}` + (x.stolen + x.caught ? `/thief:${x.caught}caught,${x.stolen}lost` : '')).join(' ');
        return d + (r.ended ? ' -> over' : '');
      });
    }
    await test('logic', 'desktop: no errors during sims', async () => noErrors(D));

    await test('edge', 'hiring during closing works and day still ends', async () => {
      const r = await page.evaluate(() => {
        const C = window.__cloneMart, G = C.G, N = window.__cloneMartNav;
        C.startGame({ day: 2, money: 5000 });
        G.time = ((N && N.consts && N.consts.DAY_LEN) || 180) - 1; C.spawnCustomer(); C.spawnCustomer();
        let st = C.sim(2);
        if (st !== 'closing') return { err: 'expected closing, got ' + st };
        C.hire('cleaner');
        const ok = G.clones.cleaner === 1 && C.staff.some(s => s.role === 'cleaner') && G.state === 'closing';
        st = C.sim(45);
        return { ok, st };
      });
      assert(!r.err, r.err);
      assert(r.ok, 'hire during closing did not apply');
      assert(r.st === 'summary', 'closing did not end in summary: ' + r.st);
      await page.evaluate(() => document.querySelector('#btnNext').click());
      await waitState(page, 'play');
      return 'summary reached, next day started';
    });
    await test('edge', 'pause / team / visibilitychange ignored during summary', async () => {
      await page.evaluate(() => { window.__cloneMart.startGame({ day: 2, money: 3000 }); window.__cloneMart.endDay(); });
      assert(await state(page) === 'summary', 'not in summary');
      await shot(page, 'desktop-summary');
      await page.keyboard.press('Escape'); await page.keyboard.press('KeyP'); await page.keyboard.press('KeyT');
      await page.evaluate(() => { document.querySelector('#btnPause').click(); document.querySelector('#btnTeam').click(); });
      await setHidden(page);
      assert(await state(page) === 'summary', 'state changed to ' + await state(page));
      assert(await page.locator('#pause').isHidden(), 'pause panel shown over summary');
      assert(await page.locator('#team').isHidden(), 'team panel shown over summary');
      assert(await page.locator('#summary').isVisible(), 'summary hidden');
      await page.evaluate(() => document.querySelector('#btnNext').click());
      await waitState(page, 'play');
      return 'ok';
    });
    await test('edge', 'visibilitychange (tab hidden) pauses play; 繼續 resumes', async () => {
      await ensurePlaying(page);
      await setHidden(page);
      assert(await state(page) === 'paused', 'not paused: ' + await state(page));
      assert(await page.locator('#pause').isVisible(), 'pause panel not shown');
      await page.evaluate(() => document.querySelector('#btnResume').click());
      await waitState(page, 'play');
      return 'ok';
    });
    await test('edge', 'double-tap on 僱用 hires once (no accidental upgrade)', async () => {
      await page.evaluate(() => window.__cloneMart.startGame({ day: 2, money: 50000 }));
      await page.click('#btnTeam');
      assert(await page.locator('#team').isVisible(), 'team panel not open');
      await shot(page, 'desktop-team');
      const r = await page.evaluate(async () => {
        const btn = () => document.querySelector('#teamList button');
        btn().click();
        await new Promise(r => setTimeout(r, 40));
        btn().click();   // second tap of a double-tap lands on the freshly rendered button
        const after = Object.assign({}, window.__cloneMart.G.clones);
        await new Promise(r => setTimeout(r, 700));
        btn().click();   // a deliberate later tap must still work
        return { after, later: Object.assign({}, window.__cloneMart.G.clones) };
      });
      await page.evaluate(() => document.querySelector('#btnTeamClose').click());
      const k = Object.keys(r.after)[0];
      assert(k && r.after[k] === 1, 'after double tap clones=' + JSON.stringify(r.after));
      assert(r.later[k] === 2, 'a deliberate later tap should still upgrade: ' + JSON.stringify(r.later));
      return k + ': double-tap→LV1, later tap→LV2';
    });
    await test('edge', 'restock with exactly $0 (and with exactly 1 unit of cash)', async () => {
      const r = await page.evaluate(() => {
        const C = window.__cloneMart, G = C.G, N = window.__cloneMartNav;
        C.startGame({ day: 2, money: 0, rating: 3, stock: Object.fromEntries(C.SHELVES.map(s => [s.id, 0])) });
        G.spawnT = 1e9;
        const o = C.staff.find(s => s.role === 'owner') || C.staff[0];
        const sh = C.SHELVES.find(s => s.id === 'drink') || C.SHELVES[0];
        const put = p => { o.agent.pos.x = p.x; o.agent.pos.z = p.z; o.agent.path.length = 0; };
        put(N.spots.STOCK_SPOT); C.sim(0.5);
        const carried = o.carry;
        put(sh.spot); C.sim(2);
        const s0 = { stock: sh.stock, money: G.money, carry: o.carry };
        G.money = sh.cost; put(sh.spot); C.sim(1.5);
        return { carried, s0, s1: { stock: sh.stock, money: G.money, carry: o.carry } };
      });
      assert(r.carried, 'owner did not pick up a box at STOCK_SPOT');
      assert(r.s0.stock === 0 && r.s0.money === 0 && r.s0.carry, '$0 restock changed state: ' + JSON.stringify(r.s0));
      assert(r.s1.stock === 1 && r.s1.money === 0, 'exact-cash restock wrong: ' + JSON.stringify(r.s1));
      return 'ok';
    });
    await test('edge', 'thief with no guard escapes cleanly; with guard Lv3 resolved', async () => {
      const r = await page.evaluate(() => {
        const C = window.__cloneMart, G = C.G, N = window.__cloneMartNav;
        const run = data => {
          C.startGame(data);
          const o = C.staff.find(s => s.role === 'owner') || C.staff[0];
          C.spawnCustomer();
          const c = C.customers[C.customers.length - 1];
          c.thief = true; c.list = [C.SHELVES[C.SHELVES.length > 1 ? 1 : 0].id]; c.li = 0;
          G.spawnT = 1e9;
          for (let i = 0; i < 160 && C.customers.includes(c); i++) { o.agent.pos.x = N.spots.STOCK_SPOT.x; o.agent.pos.z = N.spots.STOCK_SPOT.z; o.agent.path.length = 0; C.sim(0.5); }
          return { gone: !C.customers.includes(c), stolen: G.stats.stolen, caught: G.stats.caught, state: c.state };
        };
        return { noGuard: run({ day: 3, money: 1000 }), guard: run({ day: 3, money: 1000, clones: { guard: 3 } }) };
      });
      assert(r.noGuard.gone && r.noGuard.stolen === 1 && r.noGuard.caught === 0, 'no guard: ' + JSON.stringify(r.noGuard));
      assert(r.guard.gone && r.guard.stolen + r.guard.caught === 1, 'guard: ' + JSON.stringify(r.guard));
      return `no guard: stolen; guard: ${r.guard.caught ? 'caught' : 'stolen'}`;
    });
    await test('edge', 'resize during play keeps canvas full-size and HUD visible', async () => {
      await page.evaluate(() => window.__cloneMart.startGame({ day: 2, money: 1000 }));
      const sizes = [];
      for (const [w, h] of [[700, 900], [1280, 760]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForFunction(w => document.querySelector('#game').clientWidth === w && innerWidth === w, w, { timeout: 10000 }).catch(() => {});
        sizes.push(await page.evaluate(() => ({ cw: document.querySelector('#game').clientWidth, bw: document.querySelector('#game').width, iw: innerWidth })));
      }
      for (const s of sizes) assert(s.cw === s.iw && s.bw > 0, 'canvas not sized to viewport: ' + JSON.stringify(s));
      assert(await page.locator('#hud').isVisible(), 'HUD hidden after resize');
      return 'ok';
    });
    await test('edge', 'desktop: no errors during edge tests', async () => noErrors(D));

    let saveKey = null;
    await test('save', 'save/load round-trip via localStorage (reload → 繼續)', async () => {
      await page.evaluate(() => {
        const C = window.__cloneMart;
        C.startGame({ day: 3, money: 4321, rating: 3.4, cups: 3, clones: { cashier: 2, guard: 1, cleaner: 3 } });
        C.endDay();
      });
      assert(await state(page) === 'summary', 'endDay did not reach summary');
      await page.evaluate(() => document.querySelector('#btnNext').click());
      await waitState(page, 'play');
      const saved = await page.evaluate(() => {
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/clone.?mart/i.test(k)) return { k, v: JSON.parse(localStorage.getItem(k)) }; }
        return null;
      });
      assert(saved, 'no clonemart save in localStorage');
      saveKey = saved.k;
      assert(saved.v.day === 4, 'saved day should be 4, got ' + saved.v.day);
      await page.reload({ waitUntil: 'load', timeout: 45000 });
      await waitHook(page);
      const cont = page.locator('#btnContinue');
      await cont.waitFor({ state: 'visible', timeout: 15000 });
      const label = await cont.textContent();
      assert(label.includes('4'), '繼續 button does not mention day 4: ' + label);
      const got = await page.evaluate(() => {
        document.querySelector('#btnContinue').click();
        const C = window.__cloneMart, G = C.G;
        return { state: G.state, day: G.day, money: G.money, clones: Object.assign({}, G.clones), staff: C.staff.filter(s => s.role !== 'owner').map(s => s.role + ':' + s.level).sort() };
      });
      assert(got.state === 'play', 'not playing after 繼續: ' + got.state);
      assert(got.day === saved.v.day, `day ${got.day} != saved ${saved.v.day}`);
      assert(Math.abs(got.money - saved.v.money) < 0.5, `money ${got.money} != saved ${saved.v.money}`);
      assert(JSON.stringify(got.clones) === JSON.stringify(saved.v.clones), `clones ${JSON.stringify(got.clones)} != ${JSON.stringify(saved.v.clones)}`);
      assert(got.staff.join() === 'cashier:2,cleaner:3,guard:1', 'clone staff not restored: ' + got.staff.join());
      return `day ${got.day}, $${Math.round(got.money)}, ${got.staff.join(' ')}`;
    });
    await test('save', 'older/corrupt save (missing fields, bad clone level) loads sanely', async () => {
      assert(saveKey, 'no save key discovered');
      await page.evaluate(k => localStorage.setItem(k, JSON.stringify({ v: 0, day: 2, money: 900, clones: { cashier: 7, cleaner: 'x', guard: 0 }, stock: { drink: 99, snack: -3 } })), saveKey);
      await page.reload({ waitUntil: 'load', timeout: 45000 });
      await waitHook(page);
      await page.locator('#btnContinue').waitFor({ state: 'visible', timeout: 15000 });
      const r = await page.evaluate(() => {
        document.querySelector('#btnContinue').click();
        const C = window.__cloneMart, G = C.G;
        const st = C.sim(20);
        return { st, day: G.day, money: G.money, rating: G.rating, cups: G.cups, clones: Object.assign({}, G.clones),
          speeds: C.staff.map(s => s.agent.speed), stock: C.SHELVES.map(s => [s.stock, s.max]) };
      });
      assert(r.day === 2, 'day ' + r.day);
      assert(Number.isFinite(r.money), 'money ' + r.money);
      assert(r.rating >= 0 && r.rating <= 5, 'rating ' + r.rating);
      assert(Number.isFinite(r.cups) && r.cups >= 0, 'cups ' + r.cups);
      assert(r.speeds.every(v => Number.isFinite(v) && v > 0), 'staff speed invalid ' + r.speeds.join());
      assert(r.stock.every(([s, m]) => s >= 0 && s <= m), 'stock out of range ' + JSON.stringify(r.stock));
      assert(r.st === 'play' || r.st === 'closing', 'state ' + r.st);
      return `clones=${JSON.stringify(r.clones)} rating=${r.rating.toFixed(2)} cups=${r.cups}`;
    });
    await test('save', 'bankrupt summary clears save (no reload-dodge of game over)', async () => {
      assert(saveKey, 'no save key discovered');
      const r = await page.evaluate(k => {
        const C = window.__cloneMart;
        C.startGame({ day: 3, money: 0, clones: {} });
        C.G.money = 0;
        C.endDay();
        const has = localStorage.getItem(k) !== null;
        document.querySelector('#btnNext').click();
        return { has, state: C.G.state };
      }, saveKey);
      assert(r.state === 'over', 'expected game over, got ' + r.state);
      assert(!r.has, 'save still present on a bankrupt summary');
      assert(await page.locator('#over').isVisible(), 'game over screen not visible');
      return 'ok';
    });
    await test('save', 'desktop: no errors during save tests', async () => noErrors(D));
    await D.ctx.close();
  } finally { await browser.close(); }
}

/* ================================================================== mobile tracks */
async function mobileTrack(order, label, deviceName, opts) {
  const test = makeTrack(order, label);
  if (!want('smoke') && !want('input')) return;
  const dev = devices[deviceName];
  const browser = await chromium.launch({ args: CHROME_ARGS });
  try {
    let P = null;
    try { P = await openGame(browser, label, { ...dev, deviceScaleFactor: FULL_DPR ? dev.deviceScaleFactor : 1 }); }
    catch (e) { await test('smoke', `${deviceName} loads`, () => { throw e; }); return; }
    const page = P.page;
    const vp = page.viewportSize();
    await test('smoke', `${deviceName}: load, title, 開始營業 (tap), HUD`, async () => {
      assert(await page.locator('#title').isVisible(), 'title screen not visible');
      if (opts.titleShot) await shot(page, label + '-title');
      await startFromTitle(P, 'tap');
      await sleep(800);
      await shot(page, label + '-play');
      return `${vp.width}x${vp.height}`;
    });
    if (opts.joystick) {
      await test('input', `${deviceName} touch drag (joystick) moves the player`, async () => {
        await ensurePlaying(page);
        await placeOwner(page, -2, 3.5);
        const p0 = await ownerPos(page);
        const cdp = await P.ctx.newCDPSession(page);
        const x0 = vp.width * 0.5, y0 = vp.height * 0.62;
        const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
        await touch('touchStart', x0, y0);
        for (let i = 1; i <= 6; i++) { await touch('touchMove', x0 + i * 12, y0); await sleep(30); }
        let joyShown = false, k = 0;
        const p1 = await pollMoved(page, p0, p => p.x > p0.x + 0.3, 10000, async () => {
          await touch('touchMove', x0 + 72 + (k++ % 2), y0); await sleep(100);
          if (!joyShown) joyShown = await page.locator('#joy').isVisible();
        });
        await touch('touchEnd');
        await page.waitForFunction(() => document.querySelector('#joy').hidden, null, { timeout: 5000 }).catch(() => {});
        const joyHidden = await page.locator('#joy').isHidden();
        assert(p1.x > p0.x + 0.3, `drag right did not move player: x ${p0.x.toFixed(2)} -> ${p1.x.toFixed(2)}`);
        assert(joyShown, 'joystick never shown during drag');
        assert(joyHidden, 'joystick still visible after release');
        return `dx=${(p1.x - p0.x).toFixed(2)}`;
      });
    }
    await test('input', `${deviceName} tap-to-move creates a path`, () => tapMoveTest(P, opts.tap[0], opts.tap[1]));
    await test('smoke', `${deviceName}: no page/console errors`, async () => noErrors(P));
    await P.ctx.close();
  } finally { await browser.close(); }
}

/* ================================================================== main */
(async () => {
  const killer = setTimeout(() => { console.error('Suite timed out after ' + SUITE_TIMEOUT_MS / 1000 + 's'); printTable(); process.exit(2); }, SUITE_TIMEOUT_MS);
  console.log('Clone Mart test suite');
  console.log('  game:      ' + GAME);
  console.log('  three.js:  ' + (THREE_JS ? process.env.THREE_JS + ' (local)' : 'CDN'));
  console.log('  out dir:   ' + OUT_DIR + '\n');
  const tracks = await Promise.allSettled([
    desktopTrack(),
    mobileTrack(1, 'iphone13', 'iPhone 13', { joystick: true, titleShot: true, tap: [0.8, 0.7] }),
    mobileTrack(2, 'ipad', 'iPad (gen 7)', { joystick: true, titleShot: false, tap: [0.25, 0.4] }),
  ]);
  for (const t of tracks) if (t.status === 'rejected') results.push({ order: 9, seq: results.length, group: 'suite', name: 'track crashed', pass: false, detail: String(t.reason && t.reason.message || t.reason).split('\n')[0], ms: 0 });
  clearTimeout(killer);
  const failed = printTable();
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('Suite crashed:', e && e.stack || e);
  printTable();
  process.exit(2);
});

function printTable() {
  const DEV = ['desktop', 'iPhone13', 'iPad', '-'];
  const sorted = results.slice().sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
  const rows = sorted.map(r => [r.pass ? 'PASS' : 'FAIL', DEV[Math.min(r.order, 3)], r.group, r.name, (r.ms / 1000).toFixed(1) + 's', r.detail]);
  const w = [4, 6, 5, 4, 5].map((m, i) => Math.max(m, ...rows.map(r => strWidth(r[i]))));
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - strWidth(s)));
  const line = '-'.repeat(w.reduce((a, b) => a + b, 0) + 22);
  console.log('\n' + line);
  console.log(['RES', 'DEVICE', 'GROUP', 'TEST', 'TIME'].map((h, i) => pad(h, w[i])).join(' | ') + ' | DETAIL');
  console.log(line);
  for (const r of rows) console.log(r.slice(0, 5).map((c, i) => pad(c, w[i])).join(' | ') + ' | ' + r[5]);
  console.log(line);
  const nf = results.filter(r => !r.pass).length;
  if (warnings.length) { console.log('WARN (not failures):'); for (const x of [...new Set(warnings)].slice(0, 15)) console.log('  - ' + x); }
  console.log(`${nf ? 'FAIL' : 'PASS'}: ${results.length - nf}/${results.length} passed, ${nf} failed — ${((Date.now() - T0) / 1000).toFixed(0)}s — screenshots: ${OUT_DIR}`);
  return nf;
}
function strWidth(s) { let n = 0; for (const ch of String(s)) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1; return n; }
