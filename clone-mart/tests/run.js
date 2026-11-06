#!/usr/bin/env node
/*
 * 分身便利店 CLONE MART RUSH — automated test suite
 *
 *   NODE_PATH=$(npm root -g) node clone-mart/tests/run.js
 *
 * Environment:
 *   THREE_JS=/path/to/three.min.js  serve this file for any request ending in three.min.js (CDN blocked / offline)
 *   OUT_DIR=/some/dir               screenshots (default: <tmp>/clone-mart-tests-<time>)
 *   ONLY=regex                      run only groups matching: smoke|controls|recipes|hazards|flow|invariants|edge|
 *                                   difficulty|progress|cosmetics|long|balance|perf
 *   PERF_MAX_MS=ms                  perf probe fails only above this average frame time (default 1500, software GL)
 *   GAME_HTML=path                  test another copy of the game (default: ../index.html)
 *   SUITE_TIMEOUT=secs              hard cap for the whole run (default 360)
 *
 * Four tracks run in parallel, each in its own Chromium: desktop 1280x760, iPhone 13, iPad, and a second desktop for
 * progression (difficulty, chapters, save v1→v2, cosmetics, themes, long session, balance via tests/human.js).
 * Game logic is driven through window.__cloneMart.sim() (1/30 s steps, no rendering): fast and independent
 * of the software renderer. Only smoke and input tests use real frames, and those poll for the effect.
 * Everything content-related (recipes, plans, levels, roles, stations) is read from the game at run time,
 * so new recipes / levels / stations / clone roles are covered automatically.
 *
 * Exit code: 0 = all PASS, 1 = at least one FAIL, 2 = suite crashed / timed out.
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
const humanLib = require('./human.js');   // human-like owner bot for the balance group

const GAME = process.env.GAME_HTML ? path.resolve(process.env.GAME_HTML) : path.resolve(__dirname, '..', 'index.html');
const GAME_URL = pathToFileURL(GAME).href;
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'clone-mart-tests-' + Date.now());
const THREE_JS = process.env.THREE_JS && fs.existsSync(process.env.THREE_JS) ? fs.readFileSync(process.env.THREE_JS) : null;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY.replace(/,/g, '|'), 'i') : null;   // ONLY=smoke,flow or a regex
const SUITE_TIMEOUT_MS = (+process.env.SUITE_TIMEOUT || 360) * 1000;
const CHROME_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const warnings = [];
const T0 = Date.now();
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const want = g => !ONLY || ONLY.test(g);
const dbg = (...a) => { if (process.env.DEBUG) console.log('    [' + ((Date.now() - T0) / 1000).toFixed(1) + 's]', ...a); };

function makeTrack(order, label) {
  return async function test(group, name, fn) {
    if (!want(group)) return;
    const t = Date.now();
    let pass = false, detail = '';
    try { const r = await fn(); pass = true; detail = typeof r === 'string' ? r : ''; }
    catch (e) { detail = (e && e.message ? e.message : String(e)).replace(/^page\.evaluate: (Error: )?/, '').split('\n')[0]; }
    results.push({ order, seq: results.length, group, name, pass, detail, ms: Date.now() - t });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${label}/${group}] ${name}${detail ? ' — ' + detail : ''}`);
  };
}

/* ------------------------------------------------------------------ page helpers */
async function openGame(browser, label, ctxOpts, initScript) {
  const ctx = await browser.newContext(ctxOpts);
  if (initScript) await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  const isFont = s => /fonts\.(googleapis|gstatic)\.com/.test(s || '') || (/font/i.test(s || '') && /fail|load|decode/i.test(s || ''));
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '', text = m.text();
    if (isFont(url) || isFont(text)) return;
    if (/^Failed to load resource/.test(text) && /^https?:/.test(url)) { warnings.push(`${label}: network ${url}`); return; }
    errors.push('console: ' + text + (url ? ' @' + url : ''));
  });
  page.on('requestfailed', r => {
    const u = r.url(); if (isFont(u)) return;
    if (u.startsWith('file:')) errors.push('local file failed to load: ' + u);
    else warnings.push(`${label}: request failed ${u}`);
  });
  if (THREE_JS) await page.route('**/three.min.js', r => r.fulfill({ body: THREE_JS, contentType: 'application/javascript' }));
  await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.route(/fonts\.gstatic\.com/, r => r.fulfill({ body: '', contentType: 'font/woff2' }));
  await page.goto(GAME_URL, { waitUntil: 'load', timeout: 45000 });
  await ready(page);
  return { ctx, page, errors, label };
}
async function ready(page) {
  await page.waitForFunction(() => window.__cloneMart && typeof window.__cloneMart.sim === 'function', null, { timeout: 45000 });
  await page.evaluate(qaLib);
}
// SwiftShader screenshots are slow (10-30 s), so only key moments are captured unless SHOTS=all
async function shot(page, name, extra) {
  if (extra && process.env.SHOTS !== 'all') return;
  dbg('shot ' + name);
  try { await page.screenshot({ path: path.join(OUT_DIR, name + '.png'), timeout: 25000, animations: 'disabled', caret: 'initial' }); }
  catch (e) { warnings.push('screenshot ' + name + ' failed: ' + e.message.split('\n')[0]); }
}
async function waitFor(page, fn, arg, timeout) { await page.waitForFunction(fn, arg, { timeout: timeout || 20000, polling: 100 }); }
async function poll(fn, timeoutMs, every) {
  const t = Date.now(); let v;
  while (Date.now() - t < timeoutMs) { v = await fn(); if (v) return v; await sleep(every || 120); }
  return v;
}
// real pointer input at an element's centre (no actionability waits: frames are slow under SwiftShader)
async function centre(page, sel) {
  await page.evaluate(sel => { const e = document.querySelector(sel); if (e) e.scrollIntoView({ block: 'center', inline: 'center' }); }, sel);
  const bb = await page.locator(sel).first().boundingBox();
  assert(bb && bb.width > 0, sel + ' is not on screen');
  return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
}
async function press(page, sel, how) { const c = await centre(page, sel); if (how === 'tap') await page.touchscreen.tap(c.x, c.y); else await page.mouse.click(c.x, c.y); }
// let the real countdown run; under a very slow renderer, finish it with skipCountdown once it has visibly advanced
async function finishCountdown(page, maxMs) {
  const c0 = await page.evaluate(() => window.__cloneMart.G.cdT);
  if (await poll(() => page.evaluate(() => window.__cloneMart.G.state === 'play'), maxMs, 150)) return 'natural';
  const c1 = await page.evaluate(() => ({ st: window.__cloneMart.G.state, cd: window.__cloneMart.G.cdT }));
  if (c1.st === 'play') return 'natural';   // it finished between the last poll and this read
  assert(c1.st === 'countdown', 'state "' + c1.st + '" while waiting for the countdown');
  assert(c1.cd < c0, `countdown not running (cdT ${c0} → ${c1.cd})`);
  await page.evaluate(() => window.__cloneMart.skipCountdown());
  return `ran ${(c0 - c1.cd).toFixed(1)}s, rest skipped`;
}
const until = (page, fn, maxSecs, arg) => page.evaluate(([s, m, a]) => window.__qa.until(s, m, a), [fn.toString(), maxSecs, arg === undefined ? null : arg]);
function noErrors(g) { assert(g.errors.length === 0, g.errors.length + ' error(s): ' + g.errors.slice(0, 3).join(' | ')); return 'clean'; }

/* ------------------------------------------------------------------ in-page helper library (window.__qa) */
function qaLib() {
  const C = window.__cloneMart, N = window.__cloneMartNav, UX = window.__cloneMartUX;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const Q = window.__qa = { C };
  C.G.skipTut = true;
  Q.bootDiff = C.G.diff;   // as loaded from the save (the pin below overrides it)
  C.G.diff = 'hard';   // star thresholds/timers in these tests are the base (挑戰) values   // the level-1 tutorial pauses the clock and scripts tickets; logic tests run without it
  Q.slot = id => { const s = C.SLOT[id]; if (!s) throw new Error('no station "' + id + '"'); return s; };
  Q.near = (sl, p) => sl.band ? { x: clamp(p.x, sl.band[0], sl.band[1]), z: clamp(p.z, sl.band[2], sl.band[3]) } : { x: sl.x, z: sl.z };
  Q.place = (s, x, z, rot) => { const a = s.agent; a.pos.x = x; a.pos.z = z; a.path.length = 0; s.pending = null; s.slip = null; if (rot !== undefined) { a.rot = rot; a.g.rotation.y = rot; } };
  Q.standAt = (id, s) => {
    s = s || C.player; const sl = Q.slot(id);
    const q = Q.near(sl, sl.spot);
    Q.place(s, sl.spot.x, sl.spot.z, Math.atan2(q.x - sl.spot.x, q.z - sl.spot.z));
    const t = C.findTarget(s);
    if (t !== sl) throw new Error('standing at ' + id + "'s spot targets " + (t ? t.id : 'nothing'));
    return sl;
  };
  Q.desc = s => (s.hold ? s.hold.type : 'nothing');
  Q.grabAt = (id, s) => { s = s || C.player; return C.grab(s, Q.standAt(id, s)); };
  Q.mustGrab = (id, s) => {
    s = s || C.player;
    if (!Q.grabAt(id, s)) throw new Error('grab at ' + id + ' failed (holding ' + Q.desc(s) + ', station has ' + (C.SLOT[id].item ? C.SLOT[id].item.type : 'nothing') + ')');
  };
  Q.src = type => C.SLOTS.find(sl => sl.kind === 'src' && sl.give === type);
  Q.kind = k => C.SLOTS.find(sl => sl.kind === k);
  Q.extHome = () => C.SLOTS.find(sl => sl.only === 'ext') || C.SLOTS.find(sl => sl.item && sl.item.type === 'ext');
  Q.extAt = () => C.SLOTS.find(sl => sl.item && sl.item.type === 'ext');
  Q.freeCounter = isl => C.SLOTS.find(sl => sl.kind === 'counter' && !sl.only && !sl.item && !sl.fire && (isl === undefined || !!sl.isl === isl));
  Q.clone = () => C.staff.find(s => s !== C.owner);
  Q.trash = () => { const s = C.player; if (s.hold) { const t = Q.kind('trash'); if (t) C.grab(s, Q.standAt(t.id, s)); } };
  // start a level (skipping the countdown); iso: replace level params so nothing random interferes
  Q.start = (lv, team, iso) => {
    C.botOwner(false); C.startLevel(lv, team || []); C.skipCountdown();
    if (iso) Q.isolate(iso === true ? {} : iso);
    return C.G.state;
  };
  Q.isolate = o => { C.G.level = Object.assign({}, C.G.level, { len: 1e6, max: 0, endless: false }, o || {}); C.G.spillT = C.G.outT = 1e9; };
  Q.simUntil = (pred, maxSecs) => { for (let i = 0; i < maxSecs * 30; i++) { if (pred()) return true; if (C.sim(1 / 30) !== 'play') break; } return !!pred(); };
  // advance game time (1/30 s sim steps) until fn(arg) is truthy; real input state (keys, joystick, touch buttons) applies on every step
  Q.until = (src, maxSecs, arg) => { const f = (0, eval)('(' + src + ')'); let v; for (let i = 0; i <= maxSecs * 30; i++) { v = f(arg); if (v) return v; if (C.sim(1 / 30) !== 'play') break; } return f(arg) || null; };
  Q.useUntil = (pred, maxSecs, s) => { s = s || C.player; for (let i = 0; i < maxSecs * 30; i++) { if (pred()) return true; C.useTick(s, 1 / 30); C.sim(1 / 30); } return !!pred(); };
  Q.fires = () => C.SLOTS.filter(sl => sl.fire);
  Q.roleFor = rec => C.ROLES.find(r => (r.recipes || []).includes(rec));
  Q.chopPlan = () => {
    for (const rec in C.PLANS) {
      const p = C.PLANS[rec], i = p.findIndex(s => s[0] === 'chop');
      if (i > 0) { const put = p.slice(0, i).reverse().find(s => s[0] === 'put'), take = p.slice(0, i).reverse().find(s => s[0] === 'take'); if (put && take) return { rec, take: take[1], put: put[1], chop: p[i][1] }; }
    }
    return null;
  };
  // where one item object lives; an item must be in at most one slot or hand, and its mesh parented there
  Q.inventory = () => {
    const where = new Map(), dup = [];
    const add = (it, w, parent) => {
      if (!it) return;
      if (where.has(it)) dup.push(it.type + ': ' + where.get(it) + ' & ' + w); else where.set(it, w);
      if (it.mesh.parent !== parent) dup.push(it.type + ' at ' + w + ': mesh parented elsewhere');
    };
    for (const sl of C.SLOTS) add(sl.item, 'slot ' + sl.id, C.scene);
    for (const s of C.staff) add(s.hold, 'hand of ' + s.role, s.ch.g);
    return { n: where.size, dup };
  };
  Q.counts = () => ({ scene: C.scene.children.length, tags: document.getElementById('tags').children.length });
  Q.openFloor = () => {
    let best = null, bd = 1e9;
    for (let x = -8; x <= 8; x += 0.5) for (let z = -4; z <= 6; z += 0.5) {
      let ok = N.walkXZ(x, z);
      for (let k = 0; ok && k < 16; k++) ok = N.walkXZ(x + Math.cos(k * Math.PI / 8) * 1.6, z + Math.sin(k * Math.PI / 8) * 1.6);
      const d = Math.hypot(x - 3, z - 3);
      if (ok && d < bd) { bd = d; best = { x, z }; }
    }
    return best;
  };
  // invariant watcher for long sims
  // allAI: every character is an AI, so food burning in a machine means an AI abandoned it there
  Q.watch = allAI => {
    const st = new Map(), planIds = new WeakMap(), burnt = new WeakSet(); let nextId = 1;
    const issues = [];
    const bad = m => { if (issues.length < 10 && !issues.includes(m)) issues.push(m); };
    return {
      issues,
      check(now) {
        if (typeof C.G.money !== 'number' || !Number.isFinite(C.G.money)) bad('score not finite: ' + C.G.money);
        Q.inventory().dup.forEach(d => bad('item duplicated: ' + d));
        if (allAI) for (const sl of C.SLOTS) if (C.APPL[sl.id] && sl.item && sl.item.type === 'burnt' && !burnt.has(sl.item)) {
          burnt.add(sl.item); bad('food left in ' + sl.id + ' burnt at t=' + now.toFixed(0) + ' (abandoned by the AI)');
        }
        for (const o of C.orders) {
          const c = o.cust;
          if (!c || !C.customers.includes(c) || c.state === 'leave' || c.order !== o) bad('order #' + o.id + ' (' + o.rec + ') without a live customer (state ' + (c ? c.state : 'none') + ')');
          if (!(o.t >= 0 && o.t <= o.limit + 0.1)) bad('order #' + o.id + ' timer out of range ' + o.t + '/' + o.limit);
        }
        for (const s of C.staff) {
          if (!Number.isFinite(s.agent.pos.x) || !Number.isFinite(s.agent.pos.z)) bad(s.role + ' position not finite');
          if (s.role === 'owner') continue;   // the idle owner is not an AI
          const ai = s.ai || {};
          if (!ai.plan && !s.hold) { st.delete(s); continue; }
          let pid = 0; if (ai.plan) { pid = planIds.get(ai.plan); if (!pid) { pid = nextId++; planIds.set(ai.plan, pid); } }
          const step = ai.plan && ai.plan[ai.i];
          const tgt = step && typeof step[1] === 'string' ? C.SLOT[step[1]] : null;
          const blocked = !!(tgt && (tgt.fire || tgt.broken));   // waiting on a hazard is the player's / cleaner's job
          const sig = pid + ':' + ai.i + ':' + (s.hold ? s.hold.type : '-');
          const prev = st.get(s);
          if (!prev || prev.sig !== sig || blocked) st.set(s, { sig, since: now });
          else if (now - prev.since > 20) {
            bad(s.role + ' stuck >20s at t=' + now.toFixed(0) + ' on ' + (step ? step[0] + ' ' + (typeof step[1] === 'string' ? step[1] : 'spill') : 'no step') + ' holding ' + Q.desc(s) + ' at (' + s.agent.pos.x.toFixed(1) + ',' + s.agent.pos.z.toFixed(1) + ')');
            prev.since = now;
          }
        }
      },
    };
  };
  Q.teamFor = L => {
    const r = C.ROLES.map(r => ({ id: r.id, sc: (r.recipes || []).filter(x => L.rec.includes(x)).length * 2 + (!(r.recipes || []).length && (L.spills || L.outage) ? 1.5 : 0) }))
      .filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
    return r.slice(0, L.clones || 0).map(x => x.id);
  };
  // finish the current level at its time limit with a given score
  Q.finish = (lv, money) => {
    Q.start(lv, []);
    const L = C.LEVELS[lv];
    C.G.money = money; C.G.time = L.len - 0.05;
    const st = C.sim(0.5);
    const html = document.getElementById('resStars').innerHTML;
    return { st, stars: (html.split('<i>')[0].match(/★/g) || []).length, best: Object.assign({}, C.bestOf ? C.bestOf(lv) : C.G.best[lv]),
      receipt: document.getElementById('receipt').textContent, resultsVisible: !document.getElementById('results').hidden,
      next: { hidden: document.getElementById('btnNextLv').hidden, disabled: document.getElementById('btnNextLv').disabled } };
  };
  // level-select buttons → enabled flag per LEVELS index (the list is grouped by chapter, then 特別模式)
  Q.lvOrder = () => {
    if (!C.CHAPTERS) return C.LEVELS.map((L, i) => i);
    const order = []; C.CHAPTERS.map(c => c.id).concat([0]).forEach(id => C.LEVELS.forEach((L, i) => { if (L.ch === id) order.push(i); }));
    return order;
  };
  Q.lvButtons = () => {
    C.showLevels();
    const btn = [...document.querySelectorAll('#lvList .lv')], ord = Q.lvOrder();
    const named = btn.length === ord.length && ord.every((i, k) => (btn[k].querySelector('.nm') || btn[k]).textContent.indexOf(C.LEVELS[i].n) >= 0);
    if (!named) return btn.map(b => !b.disabled);
    const out = C.LEVELS.map(() => false); ord.forEach((i, k) => { out[i] = !btn[k].disabled; }); return out;
  };
  Q.roleButtons = lv => { C.showPrep(lv); return [...document.querySelectorAll('#prepTeam .tp')].map(b => !b.disabled); };
  Q.totalStars = () => { let t = 0; for (const k in C.G.best) t += (C.G.best[k] && C.G.best[k].stars) || 0; return t; };
  // tap target: a source station whose projected screen point resolves (with the game's own rules) to itself
  Q.tapTarget = () => {
    const cam = UX.camera, ray = new THREE.Raycaster(), v2 = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const canvas = document.getElementById('game');
    const resolve = (x, y) => {
      v2.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(v2, cam);
      const hits = ray.intersectObjects(C.pickables || [], true);
      let pt = hits.length ? hits[0].point : null;
      if (!pt) { pt = new THREE.Vector3(); if (!ray.ray.intersectPlane(plane, pt)) return null; }
      let best = null, bd = 1.0;
      for (const sl of C.SLOTS) { const q = Q.near(sl, pt), d = Math.hypot(q.x - pt.x, q.z - pt.z); if (d < bd) { bd = d; best = sl; } }
      return best;
    };
    const p0 = C.player.agent.pos;
    const cands = C.SLOTS.filter(s => s.kind === 'src').sort((a, b) => (Math.hypot(b.x - p0.x, b.z - p0.z) > 2) - (Math.hypot(a.x - p0.x, a.z - p0.z) > 2));
    for (const sl of cands) for (const dy of [0.05, 0.25, -0.15, 0.4]) {
      const p = UX.project(sl.x, sl.y + dy, sl.z);
      if (!(p.x > 24 && p.y > 24 && p.x < innerWidth - 24 && p.y < innerHeight - 24)) continue;
      if (document.elementFromPoint(p.x, p.y) !== canvas) continue;
      if (resolve(p.x, p.y) === sl) return { id: sl.id, give: sl.give, x: p.x, y: p.y, dist: Math.hypot(sl.spot.x - p0.x, sl.spot.z - p0.z) };
    }
    return null;
  };
  Q.pos = () => { const a = C.player.agent.pos; return { x: a.x, z: a.z, role: C.player.role, hold: C.player.hold ? C.player.hold.type : null }; };
  Q.ownerPos = () => { const a = C.owner.agent.pos; return { x: a.x, z: a.z }; };
}

/* ------------------------------------------------------------------ shared tests */
async function smokeFlow(test, P, label, how) {
  const page = P.page;
  await test('smoke', `${label}: title → 開始營業 → level select → prep → 開店！ → countdown → play`, async () => {
    const act = sel => press(page, sel, how);
    assert(await page.locator('#title').isVisible(), 'title screen not visible');
    const title = await page.locator('#btnNew').textContent();
    assert(/開始營業/.test(title), '#btnNew text is "' + title + '"');
    await shot(page, label + '-1-title');
    await act('#btnNew');
    await waitFor(page, () => !document.getElementById('levels').hidden);
    const nLv = await page.evaluate(() => ({ btn: document.querySelectorAll('#lvList .lv').length, lv: window.__cloneMart.LEVELS.length, first: !document.querySelector('#lvList .lv').disabled }));
    assert(nLv.btn === nLv.lv, `level select shows ${nLv.btn} levels, game has ${nLv.lv}`);
    assert(nLv.first, 'first level is locked');
    await shot(page, label + '-2-levels', true);
    await act('#lvList .lv');
    await waitFor(page, () => !document.getElementById('prep').hidden);
    const prep = await page.evaluate(() => ({ rec: document.querySelectorAll('#prepRec .rec').length, want: window.__cloneMart.LEVELS[0].rec.length }));
    assert(prep.rec === prep.want, `prep lists ${prep.rec} recipes, level has ${prep.want}`);
    await shot(page, label + '-3-prep', true);
    await act('#btnGo');
    await waitFor(page, () => ['countdown', 'play'].includes(window.__cloneMart.G.state), null, 10000);
    await poll(() => page.evaluate(() => document.getElementById('bigmsg').textContent !== '' || window.__cloneMart.G.state === 'play'), 8000);
    const cd = await page.evaluate(() => ({ st: window.__cloneMart.G.state, big: document.getElementById('bigmsg').textContent, hud: !document.getElementById('hud').hidden }));
    assert(cd.hud, 'HUD hidden after 開店！');
    assert(cd.st === 'play' || /^[1-9]$|開店/.test(cd.big), 'countdown shows "' + cd.big + '"');
    await shot(page, label + '-4-countdown', true);
    dbg(label + ' countdown');
    const how_cd = await finishCountdown(page, 15000);
    dbg(label + ' play');
    await poll(() => page.evaluate(() => document.querySelectorAll('#orders .tk').length > 0), 15000);
    const play = await page.evaluate(() => ({ tk: document.querySelectorAll('#orders .tk').length, orders: window.__cloneMart.orders.length, act: !document.getElementById('actions').hidden }));
    assert(play.orders > 0 && play.tk > 0, `no order tickets in play (orders=${play.orders}, tickets=${play.tk})`);
    if (how === 'tap') assert(play.act, 'touch action buttons hidden in play');
    // HUD star target must be this level's next threshold (not left over from the title demo / previous level)
    const rate = await poll(() => page.evaluate(() => { const C = window.__cloneMart, t = document.getElementById('ratenum').textContent, L = C.G.level; const nx = L.stars.find(s => C.G.money < s); return t === (nx ? '/' + nx : t) ? t : null; }), 4000);
    assert(rate, 'HUD star target shows "' + await page.evaluate(() => document.getElementById('ratenum').textContent) + '", level needs ' + await page.evaluate(() => window.__cloneMart.G.level.stars.join('/')));
    await shot(page, label + '-5-play');
    return `countdown "${cd.big}" (${how_cd}) → play, ${play.tk} ticket(s)`;
  });
}
// a running level with no orders/hazards, owner in open floor
async function quietPlay(page, team) {
  return page.evaluate(team => {
    const Q = __qa, C = Q.C;
    const roles = team === 'clone' ? [C.ROLES[0].id] : [];
    Q.start(0, roles, true);
    const p = Q.openFloor(); Q.place(C.owner, p.x, p.z);
    return p;
  }, team);
}
async function tapStationTest(test, P, label, how) {
  const page = P.page;
  await test('controls', `${label}: ${how} on a station walks there and uses it`, async () => {
    await page.evaluate(() => { const Q = __qa, C = Q.C; Q.start(0, [], true); Q.place(C.owner, C.owner.agent.pos.x, C.owner.agent.pos.z); });
    await sleep(900);   // camera settles on the player
    const t = await page.evaluate(() => __qa.tapTarget());
    assert(t, 'no source station visible on screen to tap');
    const p0 = await page.evaluate(() => __qa.pos());
    if (how === 'tap') await page.touchscreen.tap(t.x, t.y); else await page.mouse.click(t.x, t.y);
    const queued = await page.evaluate(() => ({ path: __qa.C.player.agent.path.length, pending: !!__qa.C.player.pending }));
    await until(page, () => __qa.C.player.hold, 20);
    const pe = await page.evaluate(() => __qa.pos());
    assert(queued.pending || pe.hold, `${how} at (${t.x.toFixed(0)},${t.y.toFixed(0)}) did not target a station`);
    const moved = Math.hypot(pe.x - p0.x, pe.z - p0.z);
    assert(pe.hold === t.give, `tapped ${t.id}: holding ${pe.hold || 'nothing'}, expected ${t.give} (moved ${moved.toFixed(2)}m)`);
    assert(t.dist < 0.3 || moved > 0.3, `holding ${t.give} but never walked (moved ${moved.toFixed(2)}m)`);
    return `${t.id} @(${t.x.toFixed(0)},${t.y.toFixed(0)}): walked ${moved.toFixed(1)}m, holding ${pe.hold}`;
  });
}
async function joystickTest(test, P, label) {
  const page = P.page, vp = page.viewportSize();
  await test('controls', `${label}: joystick drag moves the player`, async () => {
    const p0 = await quietPlay(page);
    await sleep(300);
    const cdp = await P.ctx.newCDPSession(page);
    const x0 = vp.width * 0.33, y0 = vp.height * 0.55;
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    // "right" on screen depends on camera yaw (portrait uses a rotated view): measure along the camera's screen-right axis
    const R = await page.evaluate(() => { const e = window.__cloneMartUX.camera.matrixWorld.elements; const l = Math.hypot(e[0], e[2]) || 1; return { x: e[0] / l, z: e[2] / l }; });
    await touch('touchStart', x0, y0);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', x0 + i * 12, y0); await sleep(30); }
    await touch('touchMove', x0 + 72, y0);
    const joyShown = await page.evaluate(() => !document.getElementById('joy').hidden);
    const along = p => (p.x - p0.x) * R.x + (p.z - p0.z) * R.z;
    await page.evaluate(() => __qa.C.sim(0.5));   // game time passes while the finger is held
    const p1 = await page.evaluate(() => __qa.ownerPos());
    await touch('touchEnd');
    await poll(() => page.evaluate(() => document.getElementById('joy').hidden), 4000);
    assert(along(p1) > 0.5, `drag right moved ${along(p1).toFixed(2)}m along screen-right`);
    assert(joyShown, 'joystick never shown');
    assert(await page.locator('#joy').isHidden(), 'joystick still shown after release');
    return `moved ${along(p1).toFixed(2)}m screen-right`;
  });
}

/* ------------------------------------------------------------------ desktop track */
async function desktopTrack() {
  const test = makeTrack(0, 'desktop');
  const browser = await chromium.launch({ args: CHROME_ARGS });
  try {
    const P = await openGame(browser, 'desktop', { viewport: { width: 1280, height: 760 } });
    const page = P.page;
    await smokeFlow(test, P, 'desktop', 'click');

    /* ---------- keyboard */
    await test('controls', 'keyboard: WASD moves the player (4 distinct directions)', async () => {
      const p0 = await quietPlay(page);
      const vec = {};
      for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
        await page.evaluate(p => __qa.place(__qa.C.owner, p.x, p.z), p0);
        await page.keyboard.down(key);
        await page.evaluate(() => __qa.C.sim(0.3));   // game time passes while the key is held
        const p = await page.evaluate(() => __qa.ownerPos());
        await page.keyboard.up(key);
        vec[key] = { x: p.x - p0.x, z: p.z - p0.z };
        assert(Math.hypot(vec[key].x, vec[key].z) > 0.5, `${key} moved only ${Math.hypot(vec[key].x, vec[key].z).toFixed(2)}m`);
      }
      const n = v => { const l = Math.hypot(v.x, v.z); return { x: v.x / l, z: v.z / l }; }, dot = (a, b) => n(a).x * n(b).x + n(a).z * n(b).z;
      assert(dot(vec.KeyW, vec.KeyS) < -0.8, 'W and S are not opposite');
      assert(dot(vec.KeyA, vec.KeyD) < -0.8, 'A and D are not opposite');
      assert(Math.abs(dot(vec.KeyW, vec.KeyD)) < 0.3, 'W and D are not perpendicular');
      return Object.entries(vec).map(([k, v]) => k.slice(3) + `(${v.x.toFixed(1)},${v.z.toFixed(1)})`).join(' ');
    });
    await test('controls', 'keyboard: Space grabs at a station', async () => {
      const t = await page.evaluate(() => {
        const Q = __qa, C = Q.C; Q.start(0, [], true);
        for (const sl of C.SLOTS.filter(s => s.kind === 'src')) { try { Q.standAt(sl.id); return { id: sl.id, give: sl.give }; } catch (e) {} }
        return null;
      });
      assert(t, 'no source station reachable from its spot');
      await page.keyboard.press('Space');
      const h = await poll(() => page.evaluate(() => __qa.pos().hold), 3000);
      assert(h === t.give, `Space at ${t.id}: holding ${h}, expected ${t.give}`);
      // and Space again at the pass/trash drops it
      await page.evaluate(() => __qa.standAt(__qa.kind('trash').id));
      await page.keyboard.press('Space');
      const h2 = await poll(async () => (await page.evaluate(() => __qa.pos().hold)) === null, 3000);
      assert(h2, 'Space at the trash did not throw the item away');
      return `${t.id} → ${t.give}, binned`;
    });
    await test('controls', 'keyboard: holding E chops on the board', async () => {
      const c = await page.evaluate(() => { const Q = __qa; Q.start(0, [], true); const c = Q.chopPlan(); if (!c) return null; Q.mustGrab(c.take); Q.mustGrab(c.put); Q.standAt(c.chop); return Object.assign(c, { type: Q.C.SLOT[c.chop].item.type }); });
      if (!c) return 'skipped: no recipe has a chop step';
      await page.keyboard.down('KeyE');
      const done = await until(page, c => { const it = __qa.C.SLOT[c.chop].item; return it && it.type !== c.type ? it.type : null; }, 8, c);
      await page.keyboard.up('KeyE');
      assert(done, `${c.type} on ${c.chop} not chopped after 8s (game time) of holding E`);
      return `${c.type} → ${done}`;
    });
    await test('controls', 'keyboard: Q switches to the clone and back', async () => {
      await quietPlay(page, 'clone');
      await page.keyboard.press('KeyQ');
      const r1 = await poll(async () => { const r = (await page.evaluate(() => __qa.pos())).role; return r !== 'owner' ? r : null; }, 3000);
      assert(r1, 'Q did not switch away from the owner');
      await page.keyboard.press('KeyQ');
      const r2 = await poll(async () => { const r = (await page.evaluate(() => __qa.pos())).role; return r === 'owner' ? r : null; }, 3000);
      assert(r2, 'second Q did not switch back to the owner (1 clone on team)');
      return `owner → ${r1} → owner`;
    });
    await tapStationTest(test, P, 'desktop', 'click');

    /* ---------- recipes */
    await test('recipes', 'every recipe: scripted player using only grab/useTick at station spots (chain from PLANS)', async () => {
      const r = await page.evaluate(() => {
        const Q = __qa, C = Q.C, out = [], fails = [];
        for (const rec of Object.keys(C.RECIPES)) {
          try {
            const plan = C.PLANS[rec]; if (!plan) throw new Error('no PLANS entry');
            Q.start(0, [], { rec: [rec], max: 1 });
            C.sim(0.2);
            if (!C.orders.some(o => o.rec === rec)) throw new Error('no order spawned');
            const P = C.player;
            for (const [op, ref, want] of plan) {
              if (op === 'take' || op === 'put') Q.mustGrab(ref);
              else if (op === 'wait') {
                if (!Q.simUntil(() => C.SLOT[ref].item && C.SLOT[ref].item.type === want, 30)) throw new Error(ref + ' never produced ' + want + ' (has ' + (C.SLOT[ref].item ? C.SLOT[ref].item.type : 'nothing') + ')');
                Q.mustGrab(ref);
              } else if (op === 'chop') {
                Q.standAt(ref); const t0 = C.SLOT[ref].item && C.SLOT[ref].item.type;
                if (!Q.useUntil(() => C.SLOT[ref].item && C.SLOT[ref].item.type !== t0, 20)) throw new Error('chopping at ' + ref + ' never finished');
              } else throw new Error('unknown plan step ' + op);
            }
            if (!P.hold || P.hold.type !== C.RECIPES[rec].item) throw new Error('chain ends holding ' + Q.desc(P) + ', recipe item is ' + C.RECIPES[rec].item);
            const d0 = C.G.stats.delivered, m0 = C.G.money;
            Q.mustGrab(Q.kind('pass').id);
            if (C.G.stats.delivered !== d0 + 1 || P.hold || !(C.G.money > m0)) throw new Error('delivery not counted');
            out.push(rec);
          } catch (e) { fails.push(rec + ': ' + e.message); }
        }
        return { out, fails };
      });
      assert(!r.fails.length, r.fails.join(' | '));
      return r.out.length + ' recipes: ' + r.out.join(' ');
    });
    await test('recipes', 'every recipe: made and delivered by the clone role that lists it (AI only)', async () => {
      const r = await page.evaluate(() => {
        const Q = __qa, C = Q.C, out = [], fails = [], orphan = [];
        for (const rec of Object.keys(C.RECIPES)) if (!Q.roleFor(rec)) orphan.push(rec);
        for (const role of C.ROLES) for (const rec of role.recipes || []) {
          if (!C.RECIPES[rec]) { fails.push(role.id + ' lists unknown recipe ' + rec); continue; }
          Q.start(0, [role.id], { rec: [rec], max: 2 });
          let t = 0; while (t < 120 && !(C.G.stats.byRec[rec] >= 1) && C.G.state === 'play') { C.sim(1); t++; }
          if (C.G.stats.byRec[rec] >= 1) out.push(role.id + ':' + rec + ' ' + t + 's');
          else { const s = Q.clone(); fails.push(role.id + ' never delivered ' + rec + ' in 120s (holding ' + Q.desc(s) + ', step ' + JSON.stringify(s.ai && s.ai.plan && s.ai.plan[s.ai.i]) + ')'); }
        }
        return { out, fails, orphan };
      });
      if (r.orphan.length) warnings.push('no clone role lists recipe(s): ' + r.orphan.join(', '));
      assert(!r.fails.length, r.fails.join(' | '));
      return r.out.join(', ');
    });

    /* ---------- hazards */
    await test('hazards', 'burn → fire → spreads → extinguisher puts every fire out', async () => {
      const r = await page.evaluate(() => {
        const Q = __qa, C = Q.C; Q.start(0, [], true);
        let ap = null, input = null, rule = null;
        for (const id in C.APPL) { const a = C.APPL[id]; if (!a.fire || !C.SLOT[id]) continue; for (const k in a.ins) if (a.ins[k].burn && Q.src(k)) { ap = id; input = k; rule = a.ins[k]; break; } if (ap) break; }
        if (!ap) throw new Error('no appliance that burns and catches fire');
        Q.mustGrab(Q.src(input).id); Q.mustGrab(ap);
        const sl = C.SLOT[ap];
        if (!Q.simUntil(() => sl.item && sl.item.type === 'burnt', rule.t + rule.burn + 2)) throw new Error(ap + ' never burnt the ' + input);
        if (!Q.simUntil(() => sl.fire, C.APPL[ap].fire + 2)) throw new Error('burnt item in ' + ap + ' never caught fire');
        if (C.G.stats.fires < 1) throw new Error('fire not counted in stats');
        if (!Q.simUntil(() => Q.fires().length >= 2, 15)) throw new Error('fire did not spread from ' + ap);
        const spread = Q.fires().map(s => s.id);
        // a burning station refuses items
        const ext = Q.extAt(); if (!ext) throw new Error('no extinguisher in the store');
        const home = ext.id;
        Q.mustGrab(home);
        if (Q.desc(C.player) !== 'ext') throw new Error('took ' + Q.desc(C.player) + ' from the extinguisher stand');
        let guard = 0;
        while (Q.fires().length && guard++ < 20) {
          const f = Q.fires()[0]; Q.standAt(f.id);
          if (!Q.useUntil(() => !f.fire, 8)) throw new Error('spraying ' + f.id + ' for 8s did not put it out');
        }
        if (Q.fires().length) throw new Error('fires left: ' + Q.fires().map(s => s.id));
        Q.mustGrab(home);
        if (!C.SLOT[home].item || C.SLOT[home].item.type !== 'ext') throw new Error('extinguisher not back on its stand');
        return ap + ' burnt → fire → spread to ' + spread.join(',') + ' → all out';
      });
      return r;
    });
    await test('hazards', 'spill: the controlled player slips on it, and it can be mopped', async () => {
      const p = await quietPlay(page);
      const ok = await page.evaluate(p => {
        const Q = __qa, C = Q.C; const n0 = C.spills.length; C.spawnSpill();
        if (C.spills.length !== n0 + 1) throw new Error('spawnSpill made no spill');
        const sp = C.spills[C.spills.length - 1]; sp.x = p.x; sp.z = p.z; sp.g.position.set(p.x, 0, p.z);
        Q.place(C.player, p.x, p.z);
        return true;
      }, p);
      await page.keyboard.down('KeyD');
      const slipped = await page.evaluate(() => { const C = __qa.C; for (let i = 0; i < 30; i++) { C.sim(1 / 30); if (C.player.slip) return true; } return false; });
      await page.keyboard.up('KeyD');
      assert(ok && slipped, 'walking onto the spill with D held did not make the player slip');
      const mopped = await page.evaluate(() => {
        const Q = __qa, C = Q.C; C.player.slip = null;
        const sp = C.spills[C.spills.length - 1]; Q.place(C.player, sp.x, sp.z);
        return Q.useUntil(() => !C.spills.includes(sp), 6);
      });
      assert(mopped, 'holding use next to the spill for 6s did not mop it');
      return 'slipped, mopped';
    });
    await test('hazards', 'outage: broken machine stops cooking, repair fixes it', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C; Q.start(0, [], true);
        C.breakRandomMachine();
        const b = C.SLOTS.find(s => s.broken); if (!b) throw new Error('breakRandomMachine broke nothing');
        let note = '';
        const a = C.APPL[b.id], inT = a && Object.keys(a.ins).find(k => Q.src(k));
        if (inT) {
          Q.mustGrab(Q.src(inT).id); Q.mustGrab(b.id);
          C.sim(a.ins[inT].t + 1);
          if (!b.item || b.item.type !== inT) throw new Error('broken ' + b.id + ' still cooked: ' + (b.item && b.item.type));
          Q.mustGrab(b.id); Q.trash(); note = ', did not cook ' + inT + ' while broken';
        }
        Q.standAt(b.id);
        if (!Q.useUntil(() => !b.broken, 8)) throw new Error('repairing ' + b.id + ' for 8s did not fix it');
        return b.id + ' broken → fixed' + note;
      });
    });
    await test('hazards', 'cleaner clone handles fire (+burnt item), spill and broken machine', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C;
        if (!C.ROLE.cleaner) return 'skipped: no cleaner role';
        Q.start(0, ['cleaner'], true);
        const ctr = Q.freeCounter(true) || Q.freeCounter();
        Q.mustGrab(C.SLOTS.find(s => s.kind === 'src').id); Q.mustGrab(ctr.id);
        Q.place(C.owner, 4.2, 2.4);
        C.ignite(ctr);
        const tFire = Q.simUntil(() => !Q.fires().length, 60); if (!tFire) throw new Error('cleaner did not put out fire(s): ' + Q.fires().map(s => s.id));
        if (!Q.simUntil(() => !C.SLOTS.some(s => s.item && s.item.type === 'burnt'), 40)) throw new Error('cleaner left burnt items');
        if (!Q.simUntil(() => Q.extAt() === Q.extHome(), 30)) throw new Error('extinguisher not returned to its stand');
        C.spawnSpill(); if (!C.spills.length) throw new Error('no spill spawned');
        if (!Q.simUntil(() => !C.spills.length, 60)) throw new Error('cleaner did not mop the spill');
        C.breakRandomMachine(); const b = C.SLOTS.find(s => s.broken);
        if (!Q.simUntil(() => !C.SLOTS.some(s => s.broken), 60)) throw new Error('cleaner did not repair ' + (b && b.id));
        return 'fire+burnt, spill, ' + (b && b.id) + ' handled';
      });
    });

    /* ---------- edge cases */
    await test('edge', 'pausing during the countdown resumes the countdown (not straight to play)', async () => {
      await page.evaluate(() => { __qa.C.botOwner(false); __qa.C.startLevel(0, []); });
      await page.keyboard.press('Escape');
      const s1 = await page.evaluate(() => __qa.C.G.state);
      assert(s1 === 'paused', 'Esc during countdown → ' + s1);
      await sleep(300);
      await page.keyboard.press('Escape');
      const s2 = await page.evaluate(() => ({ st: __qa.C.G.state, cd: __qa.C.G.cdT }));
      assert(s2.st === 'countdown', `resumed into "${s2.st}" instead of the countdown`);
      const how_cd = await finishCountdown(page, 6000);
      const cleared = await poll(() => page.evaluate(() => document.getElementById('bigmsg').textContent === ''), 5000);
      assert(cleared, 'countdown text still on screen in play: "' + await page.evaluate(() => document.getElementById('bigmsg').textContent) + '"');
      return 'paused → countdown (' + how_cd + ') → play';
    });
    await test('edge', 'quitting a level to the menu stops it (no tickets over the menu, no hidden movement)', async () => {
      await page.evaluate(() => { const Q = __qa; Q.start(0, []); Q.C.sim(8); });
      await poll(() => page.evaluate(() => document.querySelectorAll('#orders .tk').length > 0), 5000);
      await page.keyboard.press('Escape');
      await press(page, '#btnQuit');
      await waitFor(page, () => !document.getElementById('levels').hidden);
      await sleep(900);
      const tk = await page.evaluate(() => document.querySelectorAll('#orders .tk').length);
      const p0 = await page.evaluate(() => __qa.ownerPos());
      await page.keyboard.down('KeyD'); await sleep(600); await page.keyboard.up('KeyD');
      const p1 = await page.evaluate(() => __qa.ownerPos());
      const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      assert(tk === 0, tk + ' order ticket(s) still shown over the level menu');
      assert(moved < 0.05, `owner moved ${moved.toFixed(2)}m from keyboard while on the menu`);
      // results → 下一關 → prep: the finished level must not come back to life behind the prep sheet
      const r = await page.evaluate(() => {
        const Q = __qa, C = Q.C, i = C.LEVELS.findIndex(L => !L.endless), L = C.LEVELS[i];
        Q.start(i, []); C.sim(10);
        const n = C.orders.length;
        C.G.money = L.stars[0]; C.G.time = L.len - 0.05;
        const st = C.sim(0.5), nb = document.getElementById('btnNextLv');
        return { st, n, ok: !nb.disabled && !nb.hidden };
      });
      assert(r.st === 'results' && r.ok, 'results: next-level button not available');
      assert(r.n > 0, 'no open orders at closing time (test setup)');
      await press(page, '#btnNextLv');
      await waitFor(page, () => !document.getElementById('prep').hidden);
      await sleep(900);
      const tk2 = await page.evaluate(() => document.querySelectorAll('#orders .tk').length);
      assert(tk2 === 0, tk2 + ' order ticket(s) of the finished level shown over the prep sheet');
      return 'level menu and next-level prep clean';
    });
    await test('edge', 'input during results is ignored', async () => {
      await page.evaluate(() => { const Q = __qa, C = Q.C; Q.start(0, [ C.ROLES[0].id ], true); C.G.level.len = C.G.time + 0.1; C.sim(1); });
      const a = await page.evaluate(() => ({ st: __qa.C.G.state, p: __qa.pos() }));
      assert(a.st === 'results', 'level did not end: ' + a.st);
      for (const k of ['Space', 'KeyQ', 'KeyE', 'Tab', 'KeyJ']) await page.keyboard.press(k);
      await page.keyboard.down('KeyW'); await sleep(400); await page.keyboard.up('KeyW');
      await page.mouse.click(8, 380);
      await sleep(200);
      const b = await page.evaluate(() => ({ st: __qa.C.G.state, p: __qa.pos(), vis: !document.getElementById('results').hidden }));
      assert(b.st === 'results' && b.vis, 'results closed/changed: ' + b.st);
      assert(b.p.role === a.p.role && Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z) < 0.01 && b.p.hold === a.p.hold, 'player changed during results');
      await shot(page, 'desktop-6-results');
      return 'results unchanged';
    });
    await test('edge', 'switching character while holding / while chopping keeps every item in one place', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C; Q.start(0, [C.ROLES[0].id], true);
        Q.mustGrab(C.SLOTS.find(s => s.kind === 'src').id);
        const it = C.owner.hold;
        C.switchChar(1);
        if (C.player === C.owner) throw new Error('switchChar did not switch');
        if (C.owner.hold !== it) throw new Error('owner lost the held item on switch');
        C.sim(2);
        let inv = Q.inventory(); if (inv.dup.length) throw new Error(inv.dup.join(';'));
        C.switchChar(1);
        if (C.player !== C.owner || C.owner.hold !== it) throw new Error('switching back lost the item');
        Q.trash();
        const c = Q.chopPlan();
        if (c) {
          Q.mustGrab(c.take); Q.mustGrab(c.put); Q.standAt(c.chop);
          for (let i = 0; i < 20; i++) C.useTick(C.player, 1 / 30);
          C.switchChar(1); C.sim(1); C.switchChar(1); C.sim(1);
          inv = Q.inventory(); if (inv.dup.length) throw new Error(inv.dup.join(';'));
          if (!C.SLOT[c.chop].item) throw new Error('item on ' + c.chop + ' vanished');
        }
        return 'ok';
      });
    });
    await test('edge', 'switching to a clone right after opening: the clone is visible', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C; Q.start(0, [C.ROLES[0].id]);
        C.switchChar(1); C.sim(2);
        const s = C.player.ch.g.scale.x;
        C.switchChar(1);
        if (!(s > 0.9)) throw new Error('controlled clone stays scaled to ' + s.toFixed(2) + ' (spawn animation frozen)');
        return 'scale ' + s.toFixed(2);
      });
    });
    await test('edge', 'two characters grabbing the same station in one frame', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C; Q.start(0, [C.ROLES[0].id], true);
        const cl = Q.clone(), ctr = Q.freeCounter(), src = C.SLOTS.find(s => s.kind === 'src');
        Q.mustGrab(src.id); Q.mustGrab(ctr.id);
        Q.standAt(ctr.id, C.owner); Q.standAt(ctr.id, cl); cl.ai = { pause: 99 };
        const a = C.grab(C.owner, ctr), b = C.grab(cl, ctr);
        const holders = [C.owner, cl].filter(s => s.hold).length;
        if (a === b || holders !== 1 || ctr.item) throw new Error(`grab results ${a}/${b}, ${holders} holder(s), counter ${ctr.item ? 'still has item' : 'empty'}`);
        if (Q.inventory().dup.length) throw new Error(Q.inventory().dup.join(';'));
        C.owner.hold && Q.trash(); if (cl.hold) { const it = cl.hold; cl.hold = null; it.mesh.parent && it.mesh.parent.remove(it.mesh); }
        Q.standAt(src.id, C.owner); Q.standAt(src.id, cl);
        C.grab(C.owner, src); C.grab(cl, src);
        if (!C.owner.hold || !cl.hold || C.owner.hold === cl.hold) throw new Error('two grabs at a source did not give two separate items');
        return 'one winner on a counter, two items from a source';
      });
    });
    await test('edge', 'dropping onto a burning station is refused and the item is kept', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C; Q.start(0, [], true);
        const ctr = Q.freeCounter(); Q.mustGrab(C.SLOTS.find(s => s.kind === 'src').id);
        const it = C.owner.hold; C.ignite(ctr); Q.standAt(ctr.id);
        const ok = C.grab(C.owner, ctr);
        if (ok || C.owner.hold !== it || ctr.item) throw new Error('drop on fire: grab=' + ok + ', hand=' + Q.desc(C.owner) + ', station=' + (ctr.item && ctr.item.type));
        return 'refused';
      });
    });
    await test('edge', 'extinguisher left on a station that catches fire can still be used', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C; Q.start(0, [], true);
        const home = Q.extHome(), ctr = Q.freeCounter(true) || Q.freeCounter();
        Q.mustGrab(home.id); Q.mustGrab(ctr.id);
        C.ignite(ctr);
        if (!Q.grabAt(ctr.id) || Q.desc(C.player) !== 'ext') throw new Error('extinguisher on burning ' + ctr.id + ' cannot be picked up → fire can never be put out');
        if (!Q.useUntil(() => !Q.fires().length, 20)) throw new Error('could not put out ' + Q.fires().map(s => s.id));
        Q.mustGrab(home.id);
        let note = 'player ok';
        if (C.ROLE.cleaner) {
          Q.start(0, ['cleaner'], true);
          const h = Q.extHome(), c2 = Q.freeCounter(true) || Q.freeCounter();
          Q.mustGrab(h.id); Q.mustGrab(c2.id); Q.place(C.owner, 4.2, 2.4);
          C.ignite(c2);
          if (!Q.simUntil(() => !Q.fires().length, 60)) throw new Error('cleaner cannot fight the fire when the extinguisher sits on burning ' + c2.id);
          note += ', cleaner ok';
        }
        return note;
      });
    });
    await test('edge', 'a clone never abandons food in a machine (order expires / machine breaks mid-cook)', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C;
        let pk = null;
        for (const r of C.ROLES) for (const rec of r.recipes || []) {
          const w = (C.PLANS[rec] || []).find(s => s[0] === 'wait' && C.APPL[s[1]] && Object.values(C.APPL[s[1]].ins).some(x => x.burn));
          if (w && !pk) pk = { role: r.id, rec, slot: w[1] };
        }
        if (!pk) return 'skipped: no clone recipe waits on a machine that burns';
        const sl = C.SLOT[pk.slot];
        const toWait = () => {
          Q.start(0, [pk.role], { rec: [pk.rec], max: 1 }); Q.place(C.owner, 4.2, 2.4);
          const cl = Q.clone();
          if (!Q.simUntil(() => cl.ai.plan && cl.ai.plan[cl.ai.i] && cl.ai.plan[cl.ai.i][0] === 'wait' && sl.item, 60)) throw new Error(pk.role + ' never started waiting on ' + pk.slot);
          C.G.level.max = 0;
          return cl;
        };
        const burnt = () => (sl.item && sl.item.type === 'burnt') || sl.fire || C.G.stats.fires > 0;
        // A: its order expires while the food cooks
        toWait();
        for (const o of C.orders) o.t = o.limit;
        Q.simUntil(burnt, 25);
        if (burnt()) throw new Error(`order expired mid-cook: ${pk.role} left the ${pk.rec} in ${pk.slot} to burn`);
        if (sl.item) throw new Error(`order expired mid-cook: ${sl.item.type} left in ${pk.slot}`);
        // B: the machine breaks while it waits; the player repairs it 30 s later
        toWait();
        sl.broken = 1; sl.fix = 0;
        C.sim(30);
        Q.standAt(pk.slot, C.owner);
        if (!Q.useUntil(() => !sl.broken, 8, C.owner)) throw new Error('could not repair ' + pk.slot);
        Q.place(C.owner, 4.2, 2.4);
        Q.simUntil(burnt, 25);
        if (burnt()) throw new Error(`machine broke mid-cook: ${pk.role} gave up waiting and the ${pk.rec} burnt in ${pk.slot} after the repair`);
        return `${pk.role}/${pk.rec} on ${pk.slot}: collected after expiry and after an outage`;
      });
    });
    await test('edge', 'restarting a level mid-fire/spill/outage leaves a clean store (no leaked meshes)', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C, team = [C.ROLES[0].id];
        Q.start(0, team, true); const base = Q.counts();
        Q.mustGrab(C.SLOTS.find(s => s.kind === 'src').id);
        C.ignite(Q.freeCounter(true) || Q.freeCounter()); C.spawnSpill(); C.spawnSpill(); C.breakRandomMachine(); C.sim(9);
        Q.start(0, team, true);
        const after = Q.counts();
        const left = [Q.fires().length && 'fire', C.spills.length && 'spill', C.SLOTS.some(s => s.broken) && 'broken', C.owner.hold && 'held item',
          C.orders.length && 'orders', (!Q.extAt() || Q.extAt() !== Q.extHome()) && 'extinguisher not home'].filter(Boolean);
        if (left.length) throw new Error('after restart: ' + left.join(', '));
        if (after.scene !== base.scene || after.tags !== base.tags) throw new Error(`scene children ${base.scene}→${after.scene}, tags ${base.tags}→${after.tags}`);
        return `scene ${after.scene}, tags ${after.tags}`;
      });
    });

    /* ---------- flow */
    await test('flow', 'timer ends a level → results; stars match the score on every level', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C, rows = [];
        for (const k in C.G.best) delete C.G.best[k];   // earlier tests in this page may have earned stars
        const i0 = C.LEVELS.findIndex(L => !L.endless);
        Q.start(i0, []);
        const L0 = C.LEVELS[i0];
        if (C.sim(L0.len - 1) !== 'play') throw new Error('level ended before its timer');
        if (C.sim(3) !== 'results') throw new Error('level did not end at its timer (' + C.G.state + ')');
        C.LEVELS.forEach((L, i) => {
          if (L.endless) return;
          const th = L.stars, cases = [[Math.max(0, th[0] - 1), 0], [th[0], 1], [th[1], 2], [th[2] + 7, 3]];
          for (const [m, want] of cases) {
            const r = Q.finish(i, m);
            if (r.st !== 'results' || !r.resultsVisible) throw new Error('L' + (i + 1) + ': no results screen');
            if (r.stars !== want) throw new Error(`L${i + 1} score ${m}: ${r.stars}★ shown, expected ${want}★`);
            if (!r.best || r.best.stars !== want) throw new Error(`L${i + 1}: best stars ${r.best && r.best.stars}, expected ${want}`);
            if (r.receipt.indexOf(m.toLocaleString('en-US')) < 0) throw new Error(`L${i + 1}: receipt lacks the score ${m}`);
          }
          rows.push('L' + (i + 1));
        });
        return 'timer ok; stars ok on ' + rows.join(' ');
      });
    });
    await test('flow', 'endless mode ends after the max number of failed orders', async () => {
      return page.evaluate(() => {
        const Q = __qa, C = Q.C, i = C.LEVELS.findIndex(L => L.endless);
        if (i < 0) return 'skipped: no endless level';
        Q.start(i, []);
        const MAX = C.MAX_FAILS_ENDLESS || 5;
        let t = 0;
        while (C.G.state === 'play' && t < 3000) { if (C.G.fails > MAX) throw new Error('fails ' + C.G.fails + ' > max ' + MAX + ' and still playing'); C.sim(0.5); t += 0.5; if (C.G.state === 'play' && C.G.fails >= MAX) throw new Error('still playing at ' + C.G.fails + ' fails'); }
        if (C.G.state !== 'results') throw new Error('endless never ended (' + C.G.state + ', fails ' + C.G.fails + ')');
        if (C.G.fails !== MAX) throw new Error('ended at ' + C.G.fails + ' fails, max is ' + MAX);
        return `ended after ${MAX} fails at t=${t}s`;
      });
    });

    /* ---------- invariants */
    await test('invariants', 'multi-level AI+bot sims: finite score, no duplicated item, live customers, no stuck clone, stable scene', async () => {
      const r = await page.evaluate(() => {
        const Q = __qa, C = Q.C, rows = [], issues = [];
        const team0 = [C.ROLES[0].id];
        Q.start(0, team0); const base = Q.counts();
        const runs = C.LEVELS.map((L, i) => [i, Q.teamFor(L), L.endless ? 300 : L.len + 2, true]);
        C.LEVELS.forEach((L, i) => { if (L.outage && !L.endless) runs.push([i, Q.teamFor(L).filter(id => id !== 'cleaner'), L.len + 2, true]); });   // outages, bot repairs
        C.LEVELS.forEach((L, i) => { if (!L.endless) runs.push([i, Q.teamFor(L).filter(id => id !== 'cleaner'), L.len + 2, false]); });   // clones alone
        runs.push([0, team0, C.LEVELS[0].len + 2, true]);
        for (const [i, team, secs, bot] of runs) {
          Q.start(i, team); if (bot) C.botOwner(true);
          const w = Q.watch(true); let t = 0;
          while (t < secs) { const st = C.sim(0.5); t += 0.5; w.check(t); if (st !== 'play') break; }
          C.botOwner(false);
          const S = C.G.stats;
          rows.push(`L${i + 1}[${(bot ? 'bot+' : '') + (team.join('+') || '-')}] ${S.delivered}✓${S.failed}✗ ${S.fires}🔥`);
          w.issues.forEach(m => issues.push('L' + (i + 1) + ': ' + m));
          // the same level again must not grow the scene
        }
        const counts = [];
        for (let k = 0; k < 3; k++) { Q.start(0, team0); counts.push(Q.counts()); C.sim(30); }
        const grew = counts.filter(c => c.scene !== base.scene || c.tags !== base.tags);
        if (grew.length) issues.push(`scene/tag count changed across restarts: base ${base.scene}/${base.tags} → ` + counts.map(c => c.scene + '/' + c.tags).join(', '));
        return { rows, issues, base };
      });
      assert(!r.issues.length, r.issues.slice(0, 4).join(' | '));
      return r.rows.join('; ') + `; scene ${r.base.scene} stable`;
    });
    await test('smoke', 'desktop: no page/console errors', async () => noErrors(P));
    await P.ctx.close();

    /* ---------- save / reload / unlocks (fresh storage) */
    if (want('flow')) {
      const S = await openGame(browser, 'desktop-save', { viewport: { width: 1280, height: 760 } });
      const sp = S.page;
      await test('flow', 'best score/stars saved + reloaded; next level unlocks at ≥1★; clone roles unlock by total stars', async () => {
        const a = await sp.evaluate(() => {
          const Q = __qa, C = Q.C, out = {};
          const i0 = C.LEVELS.findIndex(L => !L.endless), i1 = i0 + 1;
          out.lv0 = Q.lvButtons();
          if (!out.lv0[i0] || (C.LEVELS[i1] && out.lv0[i1])) throw new Error('fresh save: level unlocks wrong ' + JSON.stringify(out.lv0));
          const r0 = Q.finish(i0, Math.max(0, C.LEVELS[i0].stars[0] - 1));
          if (r0.stars !== 0 || !r0.next.disabled) throw new Error('0★: next-level button should be disabled');
          if (Q.lvButtons()[i1]) throw new Error('level ' + (i1 + 1) + ' unlocked with 0★');
          const r1 = Q.finish(i0, C.LEVELS[i0].stars[2]);
          if (r1.stars !== 3 || r1.next.disabled) throw new Error('3★: next-level button should be enabled');
          const lv = Q.lvButtons(); if (!lv[i1] || (lv.length > i1 + 1 && lv[i1 + 1])) throw new Error('unlocks after 3★ on L1: ' + JSON.stringify(lv));
          const keys = Object.keys(localStorage).filter(k => /clone.?mart/i.test(k));
          const key = keys.find(k => (localStorage.getItem(k) || '').indexOf(String(C.LEVELS[i0].stars[2])) >= 0);
          if (!key) throw new Error('no clone-mart localStorage key holds the best score (keys: ' + keys.join(',') + ')');
          return { key, i0, score: C.LEVELS[i0].stars[2] };
        });
        await sp.reload({ waitUntil: 'load', timeout: 60000 });
        await ready(sp);
        const b = await sp.evaluate(a => {
          const Q = __qa, C = Q.C;
          const best = C.bestOf ? C.bestOf(a.i0) : C.G.best[a.i0];
          if (!best || best.score !== a.score || best.stars !== 3) throw new Error('after reload best = ' + JSON.stringify(best));
          if (!Q.lvButtons()[a.i0 + 1]) throw new Error('unlock lost after reload');
          // roles: earn stars level by level, check the prep team buttons each time
          const steps = [];
          const checkRoles = () => {
            const ts = Q.totalStars(), btn = Q.roleButtons(a.i0);
            C.ROLES.forEach((r, k) => { if (btn[k] !== (ts >= r.need)) throw new Error(`with ★${ts}: role ${r.id} (needs ★${r.need}) is ${btn[k] ? 'unlocked' : 'locked'}`); });
            steps.push(ts);
          };
          checkRoles();
          C.LEVELS.forEach((L, i) => { if (L.endless || i === a.i0) return; Q.finish(i, L.stars[2]); checkRoles(); });
          return steps;
        }, a);
        const maxNeed = await sp.evaluate(() => Math.max(...__qa.C.ROLES.map(r => r.need)));
        return `key "${a.key}", reload ok, roles checked at ★${b.join(',★')} (max need ★${maxNeed})`;
      });
      await test('smoke', 'desktop-save: no page/console errors', async () => noErrors(S));
      await S.ctx.close();
    }
    /* ---------- hot reload: snapshot data handed back to the game */
    if (want('edge')) {
      const init = () => {
        window.__hotSnap = null;
        window.claude = { hot: { ready(cb) { cb({ best: { 0: { score: 4321, stars: 2 }, 1: { score: 99, stars: 1 } }, team: [] }); }, snapshot(fn) { window.__hotSnap = fn; } } };
      };
      const H = await openGame(browser, 'desktop-hot', { viewport: { width: 1280, height: 760 } }, init);
      await test('edge', 'hot reload: snapshot is registered and its data is restored on boot', async () => {
        const r = await H.page.evaluate(() => ({ snap: typeof window.__hotSnap === 'function' ? window.__hotSnap() : null, best: JSON.parse(JSON.stringify(__qa.C.G.best)), lv: __qa.lvButtons() }));
        assert(r.snap && r.snap.best, 'game did not register a hot snapshot');
        const b0 = r.best['c1-1'] || r.best[0];   // v1 snapshots key by level index; the game migrates them to level ids
        assert(b0 && b0.score === 4321 && b0.stars === 2, 'hot data not restored: best = ' + JSON.stringify(r.best));
        assert(r.lv[1] && r.lv[2], 'levels unlocked by the hot data are still locked');
        return 'best restored, levels unlocked';
      });
      await test('smoke', 'desktop-hot: no page/console errors', async () => noErrors(H));
      await H.ctx.close();
    }
  } finally { await browser.close(); }
}

/* ------------------------------------------------------------------ mobile tracks */
async function mobileTrack(order, label, deviceName, opts) {
  const test = makeTrack(order, label);
  const dev = devices[deviceName];
  const browser = await chromium.launch({ args: CHROME_ARGS });
  try {
    // DPR 1 keeps SwiftShader fast; layout, touch and UA stay those of the device
    const P = await openGame(browser, label, Object.assign({}, dev, { deviceScaleFactor: 1 }));
    const page = P.page;
    await smokeFlow(test, P, label, 'tap');
    await joystickTest(test, P, label);
    if (opts.buttons) {
      await test('controls', `${label}: tap ✋ #btnGrab grabs at a station`, async () => {
        const t = await page.evaluate(() => { const Q = __qa, C = Q.C; Q.start(0, [], true); for (const sl of C.SLOTS.filter(s => s.kind === 'src')) { try { Q.standAt(sl.id); return { id: sl.id, give: sl.give }; } catch (e) {} } return null; });
        await waitFor(page, () => !document.getElementById('actions').hidden, null, 8000);
        await press(page, '#btnGrab', 'tap');
        const h = await poll(() => page.evaluate(() => __qa.pos().hold), 4000);
        assert(h === t.give, `#btnGrab at ${t.id}: holding ${h}, expected ${t.give}`);
        return `${t.id} → ${h}`;
      });
      await test('controls', `${label}: holding 🔪 #btnUse chops`, async () => {
        const c = await page.evaluate(() => { const Q = __qa; Q.start(0, [], true); const c = Q.chopPlan(); if (!c) return null; Q.mustGrab(c.take); Q.mustGrab(c.put); Q.standAt(c.chop); return Object.assign(c, { type: Q.C.SLOT[c.chop].item.type }); });
        if (!c) return 'skipped: no chop recipe';
        await waitFor(page, () => !document.getElementById('actions').hidden, null, 8000);
        const bb = await page.locator('#btnUse').boundingBox();
        const cdp = await P.ctx.newCDPSession(page);
        const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 7 }] });
        const done = await until(page, c => { const it = __qa.C.SLOT[c.chop].item; return it && it.type !== c.type ? it.type : null; }, 10, c);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert(done, `holding #btnUse did not chop the ${c.type}`);
        return `${c.type} → ${done}`;
      });
      await test('controls', `${label}: tap 🔄 #btnSwap switches character`, async () => {
        await quietPlay(page, 'clone');
        await waitFor(page, () => !document.getElementById('actions').hidden, null, 8000);
        await press(page, '#btnSwap', 'tap');
        const r = await poll(async () => { const r = (await page.evaluate(() => __qa.pos())).role; return r !== 'owner' ? r : null; }, 4000);
        assert(r, '#btnSwap did not switch');
        await press(page, '#btnSwap', 'tap');
        const r2 = await poll(async () => (await page.evaluate(() => __qa.pos())).role === 'owner', 4000);
        assert(r2, 'second #btnSwap did not switch back');
        return 'owner → ' + r + ' → owner';
      });
    }
    await tapStationTest(test, P, label, 'tap');
    if (opts.perf) await perfProbe(test, P, label);
    await test('smoke', `${label}: no page/console errors`, async () => noErrors(P));
    await P.ctx.close();
  } finally { await browser.close(); }
}

/* ------------------------------------------------------------------ progression track: difficulty, chapters, save, cosmetics, themes, long session, balance */
const EXTRA_GROUPS = ['difficulty', 'progress', 'cosmetics', 'long', 'balance'];
async function progressionTrack(order, label) {
  if (!EXTRA_GROUPS.some(want)) return;
  const test = makeTrack(order, label);
  const browser = await chromium.launch({ args: CHROME_ARGS });
  try {
    const P = await openGame(browser, label, { viewport: { width: 1280, height: 760 } });
    const page = P.page;
    await page.evaluate(humanLib);

    /* ---------- difficulty */
    await test('difficulty', 'DIFFS ordered easy→hard; effLevel scales timers, order gap, ★ thresholds, clone slots (LEVELS untouched)', () => page.evaluate(() => {
      const C = __qa.C;
      if (!C.DIFFS || !C.effLevel) return 'skipped: no difficulty modes';
      const D = C.DIFFS, near = (a, b) => Math.abs(a - b) < 1e-6;
      for (let k = 1; k < D.length; k++) {
        const a = D[k - 1], b = D[k];
        for (const f of ['time', 'every', 'burn', 'slots']) if (!(a[f] >= b[f])) throw new Error(`${a.id}.${f}=${a[f]} < ${b.id}.${f}=${b[f]} (an easier mode must not be stricter)`);
        if (!(a.star <= b.star)) throw new Error(`${a.id}.star ${a.star} > ${b.id}.star ${b.star}`);
      }
      const snap = JSON.stringify(C.LEVELS.map(L => [L.stars, L.every, L.clones, L.len]));
      let n = 0;
      C.LEVELS.forEach((L, i) => {
        for (const d of D) {
          const E = C.effLevel(L, d.id), tag = `L${i + 1}/${d.id}`;
          if (E.diff !== d.id) throw new Error(tag + ': diff ' + E.diff);
          if (!near(E.timeMul, d.time)) throw new Error(`${tag}: timeMul ${E.timeMul} ≠ ${d.time}`);
          if (!near(E.every[0], L.every[0] * d.every) || !near(E.every[1], L.every[1] * d.every)) throw new Error(`${tag}: every ${E.every}`);
          if (E.clones !== Math.min(5, L.clones + d.slots)) throw new Error(`${tag}: clones ${E.clones}`);
          E.stars.forEach((t, k) => { const w = Math.max(10, Math.round(L.stars[k] * d.star / 10) * 10); if (t !== w) throw new Error(`${tag}: ★${k + 1} ${t} ≠ ${w}`); });
          for (let k = 1; k < 3; k++) if (E.stars[k] < E.stars[k - 1]) throw new Error(`${tag}: thresholds not increasing ${E.stars}`);
          n++;
        }
      });
      if (JSON.stringify(C.LEVELS.map(L => [L.stars, L.every, L.clones, L.len])) !== snap) throw new Error('effLevel changed LEVELS');
      return `${D.map(d => d.id).join(' < ')}; ${n} level×difficulty combos`;
    }));
    await test('difficulty', 'in game: ticket timer, spawn gap, burn/fire timers, prep slots, crown & coins follow the difficulty', () => page.evaluate(() => {
      const Q = __qa, C = Q.C, G = C.G;
      if (!C.DIFFS || !C.effLevel) return 'skipped: no difficulty modes';
      const i = C.LEVELS.findIndex(L => !L.endless && !L.script && !L.storm);
      const L = C.LEVELS[i], rec = L.rec.find(r => C.RECIPES[r]);
      // an appliance that burns, and the source of its input
      let burnA = null;
      for (const id in C.APPL) for (const t in C.APPL[id].ins) { const r = C.APPL[id].ins[t]; if (r.burn && !burnA && Q.src(t) && C.SLOT[id]) burnA = { id, t, out: r.out, cook: r.t }; }
      const base = {};
      for (const id in C.APPL) { const a = C.APPL[id]; base[id] = { fire: '_fire' in a ? a._fire : a.fire, burn: {} }; for (const t in a.ins) base[id].burn[t] = '_burn' in a.ins[t] ? a.ins[t]._burn : a.ins[t].burn; }
      const keepBest = JSON.stringify(G.best), keepCoins = G.coins, keepDiff = G.diff, rows = [];
      try {
        for (const d of C.DIFFS) {
          G.diff = d.id;
          Q.start(i, [], { vip: 0, bulk: null, rush: null, rain: null, storm: null });
          G.rainT = G.stormT = 1e9;
          const E = C.effLevel(L, d.id);
          if (G.level.diff !== d.id || JSON.stringify(G.level.stars) !== JSON.stringify(E.stars)) throw new Error(d.id + ': level thresholds ' + G.level.stars + ' ≠ ' + E.stars);
          // ticket timer
          const o = C.spawnOrder(rec);
          const want = C.RECIPES[rec].time * d.time;
          if (Math.abs(o.limit - want) > 1e-6) throw new Error(`${d.id}: ${rec} ticket ${o.limit}s, expected ${want}s`);
          // spawn gap (the regular gap: with fewer than 3 tickets the board refills faster)
          G.level.max = 99; G.spawnT = 0; G.gapT = 0;
          const n0 = C.orders.length; C.sim(1 / 30);
          if (C.orders.length !== n0 + 1) throw new Error(d.id + ': no ticket spawned');
          const gap = G.spawnT, lo = L.every[0] * d.every - 0.05, hi = L.every[1] * d.every + 0.01;
          if (!(gap >= lo && gap <= hi)) throw new Error(`${d.id}: next ticket in ${gap.toFixed(2)}s, expected ${lo.toFixed(2)}–${hi.toFixed(2)}`);
          G.level.max = 0; for (const x of C.orders) x.t = x.limit; C.sim(1 / 30);
          // burn / fire timers: table values and a real burn
          for (const id in C.APPL) {
            const a = C.APPL[id];
            if (base[id].fire && Math.abs(a.fire - base[id].fire * d.burn) > 1e-6) throw new Error(`${d.id}: ${id} fire ${a.fire}, expected ${base[id].fire * d.burn}`);
            for (const t in a.ins) if (base[id].burn[t] && Math.abs(a.ins[t].burn - base[id].burn[t] * d.burn) > 1e-6) throw new Error(`${d.id}: ${id}/${t} burn ${a.ins[t].burn}`);
          }
          let burnAt = null;
          if (burnA) {
            Q.trash(); Q.mustGrab(Q.src(burnA.t).id); Q.mustGrab(burnA.id);
            const sl = C.SLOT[burnA.id];
            if (!Q.simUntil(() => sl.item && sl.item.type === burnA.out, burnA.cook + 3)) throw new Error(burnA.id + ' did not cook');
            let t = 0; while (t < 60 && sl.item && sl.item.type !== 'burnt') { C.sim(1 / 30); t += 1 / 30; }
            const wantB = base[burnA.id].burn[burnA.t] * d.burn;
            if (Math.abs(t - wantB) > 0.2) throw new Error(`${d.id}: ${burnA.out} burnt after ${t.toFixed(2)}s in ${burnA.id}, expected ${wantB.toFixed(2)}s`);
            burnAt = t;
            Q.mustGrab(burnA.id); Q.trash();
          }
          // prep screen: clone slots
          C.showPrep(i);
          const slots = (document.getElementById('prepSlots') || {}).textContent || '';
          if (!new RegExp('/\\s*' + E.clones + '\\b').test(slots)) throw new Error(`${d.id}: prep slots "${slots}", expected …/ ${E.clones}`);
          // the menu demo runs at base timers
          for (const id in C.APPL) for (const t in C.APPL[id].ins) if (base[id].burn[t] && C.APPL[id].ins[t].burn !== base[id].burn[t]) throw new Error('menu demo keeps the ' + d.id + ' burn timers');
          // crown & coins
          for (const k in G.best) delete G.best[k];
          const c0 = G.coins, score = E.stars[2];
          Q.start(i, []); G.money = score; G.time = G.level.len - 0.05; C.sim(0.5);
          if (G.state !== 'results') throw new Error(d.id + ': no results');
          const b = C.bestOf(i), coinW = d.coin === undefined ? null : Math.max(0, Math.round(score / 10 * d.coin));
          if (b.stars !== 3) throw new Error(`${d.id}: ${score} at ★★★ ${E.stars[2]} gave ${b.stars}★`);
          if ('crown' in b && !!b.crown !== (d.id === C.DIFFS[C.DIFFS.length - 1].id)) throw new Error(`${d.id}: crown ${b.crown}`);
          const got = G.stats.coins !== undefined ? G.stats.coins : G.coins - c0;   // the shift's pay (achievements may add bonuses on top)
          if (coinW !== null && (got !== coinW || G.coins - c0 < coinW)) throw new Error(`${d.id}: +${got} coins for the shift (wallet +${G.coins - c0}), expected ${coinW}`);
          rows.push(`${d.id}: ${rec} ${o.limit.toFixed(0)}s, gap ${gap.toFixed(1)}s, ${burnA ? burnA.out + ' burns ' + burnAt.toFixed(1) + 's' : 'no burn'}, ${E.clones} slots, ★${E.stars.join('/')}, +${got}💰${b.crown ? '👑' : ''}`);
        }
      } finally {
        for (const k in G.best) delete G.best[k]; Object.assign(G.best, JSON.parse(keepBest)); G.coins = keepCoins; G.diff = keepDiff;
      }
      return rows.join('; ');
    }));

    /* ---------- chapters */
    await test('progress', 'chapter & level unlock rules (need stars, previous level ★, endless req), labels, level-select buttons', () => page.evaluate(() => {
      const Q = __qa, C = Q.C, G = C.G;
      if (!C.CHAPTERS || !C.levelUnlocked) return 'skipped: no chapters';
      const keep = JSON.stringify(G.best), lvIdx = id => C.LEVELS.findIndex(L => L.id === id), out = [];
      const clear = () => { for (const k in G.best) delete G.best[k]; };
      const set = (i, stars) => { G.best[C.LEVELS[i].id] = { score: stars * 100, stars, crown: false }; };
      const ofCh = id => C.LEVELS.map((L, i) => i).filter(i => C.LEVELS[i].ch === id && !C.LEVELS[i].endless);
      const check = (i, want, why) => { if (C.levelUnlocked(i) !== want) throw new Error(`${C.lvLabel(i)} ${C.LEVELS[i].n}: ${want ? 'locked' : 'unlocked'} ${why}`); };
      const giveStars = (idx, n) => { for (const i of idx) { const s = Math.max(0, Math.min(3, n)); set(i, s); n -= s; } };
      const synth = [];
      // stable save ids: unique; the endless level is 'endless' and chapter 1 keeps the v1 ids wherever new levels are inserted
      const ids = C.LEVELS.map(L => L.id);
      if (ids.some(x => !x) || new Set(ids).size !== ids.length) throw new Error('level ids missing or duplicated: ' + ids.join(','));
      const e = C.LEVELS.find(L => L.endless); if (e && e.id !== 'endless') throw new Error('the endless level has id "' + e.id + '" (v1 saves map index 6 to "endless")');
      ofCh(1).slice(0, 6).forEach((i, k) => { if (C.LEVELS[i].id !== 'c1-' + (k + 1)) throw new Error(`chapter-1 level ${k + 1} has id "${C.LEVELS[i].id}", v1 saves expect "c1-${k + 1}"`); });
      try {
        // every chapter as it is in the game
        C.CHAPTERS.forEach((Ch, ci) => {
          const idx = ofCh(Ch.id); if (!idx.length) return;
          clear();
          if (C.LEVELS[idx[0]].req) { /* its own requirement: checked below */ }
          else if (ci === 0 || !Ch.need) check(idx[0], true, 'with no stars (chapter needs none)');
          else {
            const prev = ofCh(C.CHAPTERS[ci - 1].id);
            if (Ch.need > prev.length * 3) throw new Error(`chapter ${Ch.id} needs ★${Ch.need} but chapter ${C.CHAPTERS[ci - 1].id} only has ${prev.length * 3}`);
            giveStars(prev, Ch.need - 1); check(idx[0], false, `with ★${Ch.need - 1} in the previous chapter (needs ★${Ch.need})`);
            clear(); giveStars(prev, Ch.need); check(idx[0], true, `with ★${Ch.need} in the previous chapter`);
          }
          for (let k = 1; k < idx.length; k++) {
            if (C.LEVELS[idx[k]].req) continue;
            set(idx[k - 1], 0); check(idx[k], false, 'with 0★ on the level before');
            set(idx[k - 1], 1); check(idx[k], true, 'with 1★ on the level before');
          }
          // labels: 第 ch-k 關, in order
          idx.forEach((i, k) => { const w = '第 ' + Ch.id + '-' + (k + 1) + ' 關'; if (C.lvLabel(i) !== w) throw new Error(`label of ${C.LEVELS[i].n}: "${C.lvLabel(i)}", expected "${w}"`); });
          out.push(`ch${Ch.id}: ${idx.length} levels, need ★${Ch.need || 0}`);
        });
        // levels with an explicit requirement (endless)
        C.LEVELS.forEach((L, i) => {
          if (!L.req) return;
          const j = lvIdx(L.req.lv); if (j < 0) throw new Error(L.id + ' requires unknown level ' + L.req.lv);
          clear(); set(j, (L.req.stars || 1) - 1); check(i, false, `with ${(L.req.stars || 1) - 1}★ on ${L.req.lv}`);
          set(j, L.req.stars || 1); check(i, true, `with ${L.req.stars || 1}★ on ${L.req.lv}`);
          out.push(`${L.id} needs ${L.req.lv}`);
        });
        // a synthetic chapter after the last one (exercises the `need` rule even with one chapter)
        const lastCh = C.CHAPTERS[C.CHAPTERS.length - 1], prev = ofCh(lastCh.id);
        if (prev.length) {
          const ch = { id: 990, n: 'QA', ic: '?', theme: 'default', need: Math.min(3, prev.length * 3) };
          C.CHAPTERS.push(ch); synth.push(() => C.CHAPTERS.splice(C.CHAPTERS.indexOf(ch), 1));
          const mk = id => Object.assign({}, C.LEVELS[prev[0]], { id, ch: 990, script: null, req: null });
          const a = mk('qa-990-1'), b = mk('qa-990-2'); C.LEVELS.push(a, b);
          synth.push(() => { C.LEVELS.splice(C.LEVELS.indexOf(b), 1); C.LEVELS.splice(C.LEVELS.indexOf(a), 1); });
          const ia = C.LEVELS.indexOf(a), ib = C.LEVELS.indexOf(b);
          clear(); giveStars(prev, ch.need - 1); check(ia, false, 'synthetic chapter, ★' + (ch.need - 1));
          giveStars(prev, ch.need); check(ia, true, 'synthetic chapter, ★' + ch.need); check(ib, false, 'synthetic chapter level 2 with 0★ on level 1');
          set(ia, 2); check(ib, true, 'synthetic chapter level 2 with 2★ on level 1');
          if (C.lvLabel(ib) !== '第 990-2 關') throw new Error('synthetic label ' + C.lvLabel(ib));
          // the locked first level of a chapter names the chapter rule on its card
          clear(); C.showLevels();
          const card = [...document.querySelectorAll('#lvList .lv')].find(b => b.disabled && /990-1/.test(b.textContent));
          if (!card) throw new Error('synthetic chapter level not listed / not locked in the level select');
          if (card.textContent.indexOf('★' + ch.need) < 0) throw new Error('locked chapter card says "' + (card.querySelector('.bs') || card).textContent + '", not the ★' + ch.need + ' chapter rule');
          out.push('synthetic chapter ok');
        }
      } finally { while (synth.length) synth.pop()(); }
      // level select shows exactly the unlock state, for a mid-campaign save
      clear();
      const ch1 = ofCh(C.CHAPTERS[0].id); ch1.slice(0, 2).forEach(i => set(i, 2));
      const btn = Q.lvButtons(), want = C.LEVELS.map((L, i) => C.levelUnlocked(i));
      if (JSON.stringify(btn) !== JSON.stringify(want)) throw new Error('level select ' + JSON.stringify(btn) + ' ≠ levelUnlocked ' + JSON.stringify(want));
      // the intro card uses the chapter label
      const i2 = ch1[1] !== undefined ? ch1[1] : ch1[0];
      Q.start(i2, []);
      const intro = (document.querySelector('#lvIntro .no') || {}).textContent || '';
      const num = C.lvLabel(i2).replace(/[^0-9-]/g, '');
      if (intro && intro.indexOf(num) < 0) throw new Error(`intro card "${intro}" for ${C.lvLabel(i2)}`);
      clear(); Object.assign(G.best, JSON.parse(keep));
      return out.join('; ') + '; level select matches; intro "' + intro + '"';
    }));

    /* ---------- cosmetics & themes */
    await test('cosmetics', 'cosmetics apply/remove on owner and clones: idempotent, no scene growth across restarts', () => page.evaluate(() => {
      const Q = __qa, C = Q.C, G = C.G;
      if (!C.COSMETICS || !C.COSMETICS.length || !C.applyCosmetics) return 'skipped: no cosmetics';
      const count = o => { let n = 0; o.traverse(() => n++); return n; };
      const keep = JSON.stringify(G.equip || {}), o = C.owner, role = C.ROLES[0].id, out = [];
      const i0 = C.LEVELS.findIndex(L => !L.endless);
      try {
        G.equip = {}; Q.start(i0, [role], true); C.applyCosmetics(o);
        const base = count(o.ch.g), sBase = count(C.scene);
        for (const cz of C.COSMETICS) {
          if (typeof cz.build !== 'function') continue;   // not a worn object (e.g. a colour): nothing to attach
          G.equip = { owner: { [cz.slot]: cz.id } }; C.applyCosmetics(o);
          const n1 = count(o.ch.g);
          if (n1 <= base) throw new Error(cz.id + ': nothing attached to the owner');
          if (!o.ch.cos || !o.ch.cos[cz.slot] || o.ch.cos[cz.slot].id !== cz.id) throw new Error(cz.id + ': not recorded on the character');
          C.applyCosmetics(o); C.applyCosmetics(o);
          if (count(o.ch.g) !== n1) throw new Error(cz.id + ': re-applying grew the character ' + n1 + '→' + count(o.ch.g));
          G.equip = {}; C.applyCosmetics(o);
          if (count(o.ch.g) !== base) throw new Error(cz.id + ': removing left ' + (count(o.ch.g) - base) + ' objects');
        }
        // one per slot at once, then swap inside a slot
        const bySlot = {}; for (const cz of C.COSMETICS) if (typeof cz.build === 'function') (bySlot[cz.slot] = bySlot[cz.slot] || []).push(cz.id);
        G.equip = { owner: {} }; for (const sl in bySlot) G.equip.owner[sl] = bySlot[sl][0];
        C.applyCosmetics(o); const full = count(o.ch.g);
        for (const sl in bySlot) if (bySlot[sl].length > 1) { G.equip.owner[sl] = bySlot[sl][1]; C.applyCosmetics(o); G.equip.owner[sl] = bySlot[sl][0]; C.applyCosmetics(o); }
        if (count(o.ch.g) !== full) throw new Error('swapping inside a slot changed the object count ' + full + '→' + count(o.ch.g));
        // unknown id: ignored
        G.equip = { owner: { [C.COSMETICS[0].slot]: 'qa-no-such-item' } }; C.applyCosmetics(o);
        if (count(o.ch.g) !== base) throw new Error('unknown cosmetic id attached something');
        // a clone wears its role's cosmetic from spawn; restarts do not grow the scene
        const cz = C.COSMETICS.find(c => typeof c.build === 'function') || C.COSMETICS[0];
        G.equip = { [role]: { [cz.slot]: cz.id }, owner: { [cz.slot]: cz.id } };
        const counts = [];
        for (let k = 0; k < 3; k++) {
          Q.start(i0, [role], true); C.applyCosmetics(o);
          const cl = C.staff.find(s => s.role === role);
          if (!cl || !cl.ch.cos || !cl.ch.cos[cz.slot] || cl.ch.cos[cz.slot].id !== cz.id) throw new Error('clone ' + role + ' spawned without its ' + cz.id);
          counts.push(count(C.scene) + '/' + C.scene.children.length);
          C.sim(2);
        }
        if (new Set(counts).size !== 1) throw new Error('scene grew across restarts with cosmetics: ' + counts.join(' → '));
        G.equip = {}; Q.start(i0, [role], true); C.applyCosmetics(o);
        if (count(C.scene) !== sBase) throw new Error(`scene ${sBase} → ${count(C.scene)} objects after unequipping everything`);
        out.push(C.COSMETICS.length + ' cosmetics', 'scene ' + sBase + ' objects stable');
      } finally { G.equip = JSON.parse(keep); C.applyCosmetics(o); }
      return out.join(', ');
    }));
    await test('cosmetics', 'themes: on/off idempotent, nothing left visible after off, door → queue and kitchen paths stay walkable', () => page.evaluate(() => {
      const Q = __qa, C = Q.C, N = window.__cloneMartNav;
      if (!C.THEMES || !C.applyTheme) return 'skipped: no themes';
      const count = () => { let n = 0; C.scene.traverse(() => n++); return n; };
      const visible = () => { let n = 0; C.scene.traverse(o => { if (!o.isMesh && !o.isPoints && !o.isSprite) return; for (let p = o; p; p = p.parent) if (!p.visible) return; n++; }); return n; };
      const S = N.spots || {};
      const pathOk = (a, b) => {
        if (!a || !b || !N.findPath) return true;
        const p = N.findPath(a.x, a.z, b.x, b.z); if (!p || !p.length) return 'no path';
        let prev = a; const bad = [];
        for (const q of p) {
          const d = Math.hypot(q.x - prev.x, q.z - prev.z), n = Math.ceil(d / 0.1);
          for (let k = 1; k <= n; k++) { const x = prev.x + (q.x - prev.x) * k / n, z = prev.z + (q.z - prev.z) * k / n; if (!N.walkXZ(x, z)) { bad.push('wall at ' + x.toFixed(1) + ',' + z.toFixed(1)); break; } }
          prev = q;
        }
        const end = p[p.length - 1]; if (Math.hypot(end.x - b.x, end.z - b.z) > 0.8) bad.push('ends ' + Math.hypot(end.x - b.x, end.z - b.z).toFixed(1) + 'm short');
        return bad.length ? bad.slice(0, 2).join(' ') : true;
      };
      const routes = () => {
        const door = S.DOOR_OUT, q0 = N.queueSpot ? N.queueSpot(0) : S.CHECKOUT_SPOT, own = { x: 4.2, z: 2.4 };
        const r = { 'door→queue': pathOk(door, q0), 'door→checkout': pathOk(door, S.CHECKOUT_SPOT), 'owner→pass': pathOk(own, C.SLOT.pass && C.SLOT.pass.spot) };
        for (const k in r) if (r[k] !== true) return k + ' blocked: ' + r[k];
        return true;
      };
      const i0 = C.LEVELS.findIndex(L => !L.endless);
      Q.start(i0, [], true);
      C.applyTheme('default');
      for (const id of Object.keys(C.THEMES)) C.applyTheme(id);   // themes build their dressing on first use: warm them up before the baseline
      C.applyTheme('default');
      const base = count(), vBase = visible(), out = [];
      const r0 = routes(); if (r0 !== true) throw new Error('default store: ' + r0);
      let ids = Object.keys(C.THEMES).filter(id => id !== 'default'), synth = false;
      if (!ids.length) {   // only the default store: check the switching mechanism with a throw-away theme
        synth = true;
        C.THEMES.qa_theme = { n: 'QA', on() { this.m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshBasicMaterial()); this.m.position.set(-9, 3, -6); C.scene.add(this.m); }, off() { C.scene.remove(this.m); this.m = null; } };
        ids = ['qa_theme'];
      }
      try {
        for (const id of ids) {
          const on = [], off = [], vOff = [];
          for (let k = 0; k < 3; k++) {
            C.applyTheme(id); const a = count(); C.applyTheme(id); const b = count();
            if (a !== b) throw new Error(`${id}: applying twice ${a}→${b} objects`);
            on.push(a);
            const r = routes(); if (r !== true) throw new Error(id + ': ' + r);
            C.applyTheme('default'); off.push(count()); vOff.push(visible());
          }
          if (new Set(on).size !== 1 || new Set(off).size !== 1) throw new Error(`${id}: scene not stable over on/off cycles: on ${on.join(',')} off ${off.join(',')}`);
          if (vOff[0] !== vBase) throw new Error(`${id}: ${vOff[0] - vBase} meshes still visible after switching back to default`);
          out.push(`${id} ${on[0] - base >= 0 ? '+' : ''}${on[0] - base} objects`);
        }
        // a chapter with its own theme switches it on with its levels and off in the menus; customers still reach the queue
        for (const Ch of C.CHAPTERS || []) {
          if (!Ch.theme || Ch.theme === 'default' || !C.THEMES[Ch.theme]) continue;
          const i = C.LEVELS.findIndex(L => L.ch === Ch.id && !L.endless); if (i < 0) continue;
          const T = C.THEMES[Ch.theme], o0 = T.on, f0 = T.off; let nOn = 0, nOff = 0;
          T.on = function () { nOn++; return o0 && o0.apply(this, arguments); }; T.off = function () { nOff++; return f0 && f0.apply(this, arguments); };
          try {
            Q.start(i, []); C.botOwner(true);
            if (nOn !== 1) throw new Error(`chapter ${Ch.id}: theme ${Ch.theme} on() ran ${nOn}× when its level started`);
            const waited = Q.simUntil(() => C.customers.some(c => c.state === 'wait'), 40);
            C.botOwner(false);
            if (!waited) throw new Error(`chapter ${Ch.id} (${Ch.theme}): no customer reached the queue in 40s`);
            C.showLevels();
            if (nOff !== 1) throw new Error(`chapter ${Ch.id}: theme ${Ch.theme} off() ran ${nOff}× back in the menu`);
            out.push(`ch${Ch.id} → ${Ch.theme} on/off, customers queue`);
          } finally { T.on = o0; T.off = f0; C.botOwner(false); }
        }
      } finally { C.applyTheme('default'); if (synth) delete C.THEMES.qa_theme; }
      Q.start(i0, [], true);
      if (count() !== base) throw new Error(`scene ${base} → ${count()} objects after all themes`);
      return (synth ? 'only the default store; synthetic theme ' : '') + out.join('; ') + '; paths ok';
    }));

    /* ---------- long session */
    await test('long', '12 levels back to back (bot + team): scene, tags, DOM, customers/orders stay bounded', async () => {
      const plan = await page.evaluate(() => {
        const C = __qa.C, all = C.LEVELS.map((L, i) => i).filter(i => !C.LEVELS[i].endless), e = C.LEVELS.findIndex(L => L.endless);
        const runs = []; for (let k = 0; runs.length < 12; k++) { runs.push(all[k % all.length]); if (e >= 0 && runs.length === 6) runs.push(e); }
        return runs.slice(0, 12);
      });
      const rows = [];
      for (const i of plan) {
        const r = await page.evaluate(i => {
          const Q = __qa, C = Q.C, L = C.LEVELS[i];
          Q.start(i, Q.teamFor(L)); C.botOwner(true);
          let t = 0, maxC = 0, maxO = 0, maxSp = 0;
          const cap = L.endless ? 240 : L.len + 3;
          while (t < cap && C.G.state === 'play') { C.sim(0.5); t += 0.5; maxC = Math.max(maxC, C.customers.length); maxO = Math.max(maxO, C.orders.length); maxSp = Math.max(maxSp, C.spills.length); }
          C.botOwner(false);
          if (C.G.state === 'play') { C.endLevel(); C.sim(0); }
          const st = C.G.state, S = C.G.stats.delivered + '✓' + C.G.stats.failed + '✗';
          C.showLevels();   // the menu world is rebuilt the same way after every level
          let sc = 0; C.scene.traverse(() => sc++);
          return { i, st, maxC, maxO, maxSp, scene: C.scene.children.length, sc, tags: document.getElementById('tags').children.length, S };
        }, i);
        const domNow = () => page.evaluate(() => {   // live DOM, minus the parts rebuilt per level/frame (world tags, the last receipt)
          let n = document.getElementsByTagName('*').length;
          for (const id of ['tags', 'results']) { const e = document.getElementById(id); if (e) n -= e.getElementsByTagName('*').length; }
          return n;
        });
        await sleep(1400);   // float texts / toasts remove themselves on timers
        r.dom = await domNow();
        if (rows.length && r.dom > rows[0].dom + 12) { await sleep(3500); r.dom = await domNow(); }   // a slower popup (toast, achievement) may still be up
        rows.push(r);
      }
      const a = rows[0], issues = [];
      for (const r of rows) {
        if (r.st !== 'results') issues.push(`L${r.i + 1} ended in state ${r.st}`);
        if (r.scene !== a.scene || r.sc !== a.sc) issues.push(`L${r.i + 1}: scene ${a.scene}/${a.sc} → ${r.scene}/${r.sc}`);
        if (r.tags !== a.tags) issues.push(`L${r.i + 1}: tags ${a.tags} → ${r.tags}`);
        if (r.dom > a.dom + 12) issues.push(`L${r.i + 1}: DOM ${a.dom} → ${r.dom}`);
        if (r.maxC > 40) issues.push(`L${r.i + 1}: ${r.maxC} customers at once`);
        if (r.maxO > 15) issues.push(`L${r.i + 1}: ${r.maxO} orders at once`);
        if (r.maxSp > 25) issues.push(`L${r.i + 1}: ${r.maxSp} spills at once`);
      }
      assert(!issues.length, issues.slice(0, 4).join(' | '));
      const last = rows[rows.length - 1];
      return `${rows.map(r => 'L' + (r.i + 1) + ' ' + r.S).join(', ')}; menu scene ${last.scene}/${last.sc} objects, tags ${last.tags}, DOM ${a.dom}→${last.dom}; peak customers ${Math.max(...rows.map(r => r.maxC))}, orders ${Math.max(...rows.map(r => r.maxO))}`;
    });

    /* ---------- balance (human-like owner bot: tests/human.js) */
    if (want('balance')) {
      const camp = {};
      const run = async d => (camp[d] = camp[d] || await page.evaluate(d => {
        const C = __qa.C; if (!C.DIFFS || !C.DIFFS.some(x => x.id === d)) return null;
        const chapters = (C.CHAPTERS || [{ id: 1 }]).map(c => c.id), out = {};
        // every chapter in order (later chapters are reported only); 挑戰 plays chapter 1 solo / team / AI alone
        Object.assign(out, d === 'hard' ? window.__human.campaign(d, chapters[0], ['solo', 'team', 'idle']) : window.__human.campaign(d, chapters, ['team']));
        return { out, levels: C.LEVELS.map((L, i) => ({ i, ch: L.ch === undefined ? 1 : L.ch, label: C.lvLabel ? C.lvLabel(i) : 'L' + (i + 1), endless: !!L.endless })).filter(L => !L.endless) };
      }, d));
      const pick = (r, mode, ch) => r.levels.filter(L => L.ch === ch && r.out[mode + ':' + L.i]).map(L => ({ L, x: r.out[mode + ':' + L.i] }));
      const fmtRows = rows => rows.map(({ L, x }) => `${L.label.replace(/[^0-9-]/g, '')} ${x.stars}★(${x.score}/${x.th[0]})`).join(' ');
      const other = (r, mode) => {
        const xs = r.levels.filter(L => L.ch !== 1 && r.out[mode + ':' + L.i]), low = xs.filter(L => r.out[mode + ':' + L.i].stars < 1);
        if (low.length) warnings.push(`balance ${mode}: human-like bot got 0★ on ${low.map(L => L.label).join(', ')} (chapters after 1 are reported, not failed)`);
        return xs.length ? `; later chapters ≥1★ on ${xs.length - low.length}/${xs.length}` : '';
      };
      await test('balance', '輕鬆: human-like bot + default team gets ≥1★ on every chapter-1 level, ≥2★ on most', async () => {
        const r = await run('easy'); if (!r) return 'skipped: no easy mode';
        const rows = pick(r, 'team', 1), s1 = rows.filter(x => x.x.stars >= 1).length, s2 = rows.filter(x => x.x.stars >= 2).length;
        assert(rows.length && s1 === rows.length && s2 * 2 > rows.length, `≥1★ ${s1}/${rows.length}, ≥2★ ${s2}/${rows.length}: ${fmtRows(rows)}`);
        return fmtRows(rows) + other(r, 'team');
      });
      await test('balance', '標準: human-like bot + default team gets ≥1★ on most chapter-1 levels', async () => {
        const r = await run('normal'); if (!r) return 'skipped: no normal mode';
        const rows = pick(r, 'team', 1), s1 = rows.filter(x => x.x.stars >= 1).length;
        assert(rows.length && s1 >= rows.length - 1, `≥1★ on ${s1}/${rows.length}: ${fmtRows(rows)}`);
        return fmtRows(rows) + other(r, 'team');
      });
      await test('balance', '挑戰 stays hard: AI alone < ★★ on every chapter-1 level, solo human-like bot averages < ★★', async () => {
        const r = await run('hard'); if (!r) return 'skipped: no hard mode';
        const idle = pick(r, 'idle', 1), solo = pick(r, 'solo', 1), team = pick(r, 'team', 1);
        const easyIdle = idle.filter(x => x.x.stars >= 2);
        assert(!easyIdle.length, 'AI alone gets ★★ on ' + fmtRows(easyIdle));
        const avg = solo.reduce((a, x) => a + x.x.stars, 0) / Math.max(1, solo.length);
        assert(avg < 2, `solo average ${avg.toFixed(2)}★: ${fmtRows(solo)}`);
        return `AI alone ${fmtRows(idle)} | solo ${fmtRows(solo)} | team ${fmtRows(team)}`;
      });
    }
    await test('smoke', `${label}: no page/console errors`, async () => noErrors(P));
    await P.ctx.close();

    /* ---------- save v1 → v2 migration and v2 round trip (fresh storage) */
    if (want('progress')) {
      const S = await openGame(browser, label + '-save', { viewport: { width: 1280, height: 760 } });
      const sp = S.page;
      const saveKey = () => sp.evaluate(() => {
        __qa.C.saveProgress();
        return Object.keys(localStorage).find(k => { try { const d = JSON.parse(localStorage.getItem(k)); return !!d && typeof d === 'object' && 'best' in d; } catch (e) { return false; } });
      });
      const reload = async () => { await sp.reload({ waitUntil: 'load', timeout: 60000 }); await ready(sp); };
      await test('progress', 'save v1 (best keyed by level index) migrates to v2 level ids', async () => {
        const key = await saveKey();
        assert(key, 'no save key found');
        const hasIds = await sp.evaluate(() => !!__qa.C.LEVELS[0].id && __qa.C.LEVELS[0].id === 'c1-1');
        if (!hasIds) return 'skipped: no stable level ids';
        const v1 = { v: 1, best: { 0: { score: 321, stars: 2 }, 3: { score: 900, stars: 3 }, 6: { score: 5000, stars: 1 }, 42: { score: 1, stars: 1 }, 1: { score: 'x', stars: 1 }, 2: { score: 77, stars: 9 } }, tips: ['swap'], team: ['barista', 'nobody'], muted: false };
        await sp.evaluate(([k, d]) => localStorage.setItem(k, JSON.stringify(d)), [key, v1]);
        await reload();
        const r = await sp.evaluate(k => {
          const C = __qa.C, G = C.G, idx = id => C.LEVELS.findIndex(L => L.id === id);
          const best = JSON.parse(JSON.stringify(G.best));
          const unlocked = [idx('c1-2'), idx('c1-3'), idx('c1-5')].map(i => i >= 0 && C.levelUnlocked(i));
          C.saveProgress();
          const e = C.LEVELS.findIndex(L => L.endless);
          return { best, bootDiff: __qa.bootDiff, team: G.team, unlocked, endless: e < 0 ? null : C.bestOf(e).score, saved: JSON.parse(localStorage.getItem(k)) };
        }, key);
        const b = r.best, want = { 'c1-1': [321, 2], 'c1-4': [900, 3], endless: [5000, 1], 'c1-3': [77, 3] };
        for (const id in want) assert(b[id] && b[id].score === want[id][0] && b[id].stars === want[id][1], `${id}: ${JSON.stringify(b[id])}, expected score/stars ${want[id]}`);
        const numeric = Object.keys(b).filter(k => /^\d+$/.test(k));
        assert(!numeric.length, 'index keys left after migration: ' + numeric);
        assert(!b['c1-2'], 'invalid v1 entry (score "x") was migrated: ' + JSON.stringify(b['c1-2']));
        assert(Object.keys(b).length === 4, 'unexpected entries: ' + Object.keys(b).join(','));
        assert(r.unlocked[0] && !r.unlocked[1] && r.unlocked[2], 'unlocks after migration (c1-2 open, c1-3 locked: its v1 entry was invalid, c1-5 open): ' + r.unlocked);
        assert(JSON.stringify(r.team) === '["barista"]', 'team ' + JSON.stringify(r.team));
        assert(r.endless === null || r.endless === 5000, 'the endless level shows best ' + r.endless + ' (v1 index 6 went elsewhere)');
        assert(r.saved.v === 2, 'saved version ' + r.saved.v);
        assert(!Object.keys(r.saved.best).some(k => /^\d+$/.test(k)), 'v2 save still has index keys');
        return `c1-1 ${b['c1-1'].stars}★, c1-3 clamped to ${b['c1-3'].stars}★, c1-4 ${b['c1-4'].stars}★, endless ${b.endless.score}; bad/unknown entries dropped; difficulty ${r.bootDiff}; saved as v2`;
      });
      await test('progress', 'save v2 round trip: best+crown, difficulty, coins, owned, equipped, achievements survive reloads', async () => {
        const key = await saveKey();
        const data = await sp.evaluate(() => {
          const C = __qa.C, G = C.G, cz = (C.COSMETICS || [])[0];
          if (!C.DIFFS || !('coins' in G)) return null;
          const lv = C.LEVELS.filter(L => !L.endless);
          for (const k in G.best) delete G.best[k];
          G.best[lv[0].id] = { score: 777, stars: 3, crown: true }; if (lv[1]) G.best[lv[1].id] = { score: 55, stars: 1, crown: false };
          G.diff = C.DIFFS[1] ? C.DIFFS[1].id : C.DIFFS[0].id; G.coins = 1234; G.owned = new Set(cz ? [cz.id] : []);
          // an achievement id the game knows, if it has a registry (a module may drop unknown ids on load)
          const reg = C.ACHIEVEMENTS || C.ACHS || C.ACH, achId = (reg && (Array.isArray(reg) ? reg[0] && reg[0].id : Object.keys(reg)[0])) || 'qa_first';
          G.equip = cz ? { owner: { [cz.slot]: cz.id } } : {}; G.ach = Object.assign({}, G.ach, { [achId]: G.ach && G.ach[achId] || { t: 123 } });
          C.saveProgress();
          return { best: JSON.parse(JSON.stringify(G.best)), diff: G.diff, coins: G.coins, owned: [...G.owned].sort(), equip: JSON.parse(JSON.stringify(G.equip)), achId, ach: true, cz: cz ? { id: cz.id, slot: cz.slot } : null };
        });
        if (!data) return 'skipped: no save v2 fields';
        const snap = () => sp.evaluate(achId => { const C = __qa.C, G = C.G, o = C.owner; return { best: JSON.parse(JSON.stringify(G.best)), diff: __qa.bootDiff, coins: G.coins, owned: [...G.owned].sort(), equip: JSON.parse(JSON.stringify(G.equip)), ach: !!(G.ach && G.ach[achId]), worn: o.ch.cos ? Object.fromEntries(Object.entries(o.ch.cos).filter(([, v]) => v).map(([k, v]) => [k, v.id])) : {} }; }, data.achId);
        let last = null;
        for (let k = 0; k < 2; k++) {
          await reload();
          const r = last = await snap();
          // what was saved must come back (other modules may add their own entries next to it)
          const subset = {
            best: Object.fromEntries(Object.entries(r.best).filter(([id]) => data.best[id])),
            owned: r.owned.filter(id => data.owned.includes(id)),
            equip: Object.fromEntries(Object.entries(data.equip).map(([role, sl]) => [role, Object.fromEntries(Object.keys(sl).map(k => [k, (r.equip[role] || {})[k]]))])),
          };
          // coins may only grow: on boot the achievement system pays out rewards the saved progress already qualifies for
          assert(r.coins >= data.coins, `reload ${k + 1}: coins ${r.coins} < ${data.coins}`);
          data.coins = r.coins;
          for (const f of ['best', 'diff', 'coins', 'owned', 'equip', 'ach']) {
            const a = f in subset ? subset[f] : r[f];
            assert(JSON.stringify(a) === JSON.stringify(data[f]), `reload ${k + 1}: ${f} ${JSON.stringify(a)} ≠ ${JSON.stringify(data[f])}`);
          }
          if (data.cz) assert(r.worn[data.cz.slot] === data.cz.id, `reload ${k + 1}: owner not wearing ${data.cz.id} (${JSON.stringify(r.worn)})`);
          await sp.evaluate(d => { __qa.C.G.diff = d; __qa.C.saveProgress(); }, data.diff);   // save again as the game would
        }
        return `key "${key}": ${Object.keys(data.best).length} levels (crown kept), ${data.diff}, 💰${data.coins}, owned ${data.owned.join(',') || '-'}, worn ${JSON.stringify(last.worn)}, ach ok, 2 reloads`;
      });
      await test('progress', 'corrupt or hostile save: the game boots with defaults and plays', async () => {
        const key = await saveKey();
        const cases = ['{not json', JSON.stringify({ v: 2, best: [], coins: -5, owned: 'x', equip: null, ach: 3, diff: 'insane', team: 'barista', tips: 7 }), JSON.stringify({ v: 2, best: { 'c1-1': { score: 1e12, stars: 99, crown: 'yes' }, x: null, y: 5 } })];
        const out = [];
        for (const c of cases) {
          await sp.evaluate(([k, v]) => localStorage.setItem(k, v), [key, c]);
          await reload();
          const r = await sp.evaluate(() => {
            const Q = __qa, C = Q.C, G = C.G;
            const st = { coins: G.coins, diff: Q.bootDiff, diffOk: !C.DIFFS || C.DIFFS.some(x => x.id === Q.bootDiff), owned: !G.owned || G.owned instanceof Set, best: JSON.parse(JSON.stringify(G.best)) };
            const i0 = C.LEVELS.findIndex(L => !L.endless); Q.start(i0, []); st.play = C.sim(5);
            return st;
          });
          assert(r.play === 'play', 'level does not run: ' + r.play);
          assert(r.coins === undefined || (Number.isFinite(r.coins) && r.coins >= 0), 'coins ' + r.coins);
          assert(r.owned, 'owned is not a Set');
          assert(r.diffOk, 'difficulty ' + r.diff);
          for (const k in r.best) assert(r.best[k].stars >= 0 && r.best[k].stars <= 3 && Number.isFinite(r.best[k].score), k + ': ' + JSON.stringify(r.best[k]));
          out.push(Object.keys(r.best).length + ' best, ' + r.coins + '💰, ' + r.diff);
        }
        return out.join(' | ');
      });
      await test('smoke', `${label}-save: no page/console errors`, async () => noErrors(S));
      await S.ctx.close();
    }
  } finally { await browser.close(); }
}

/* ------------------------------------------------------------------ perf probe (iPhone 13, DSF 1): report, fail only on gross regressions */
async function perfProbe(test, P, label) {
  if (!want('perf')) return;
  const page = P.page;
  await test('perf', `${label}: average frame time during busy play (DSF 1, software GL)`, async () => {
    const info = await page.evaluate(() => {
      const Q = __qa, C = Q.C;
      let i = 0; C.LEVELS.forEach((L, k) => { if (!L.endless && L.clones >= C.LEVELS[i].clones) i = k; });
      Q.start(i, Q.teamFor(C.LEVELS[i])); C.botOwner(true); C.sim(20);   // a busy store: tickets, customers, the whole team working
      if (C.ROLE.bot) C.ROLE.bot = Object.assign({ name: '老闆', icon: '🤖' }, C.ROLE.bot);   // the hook's autopilot role has no HUD name (real frames read it)
      let meshes = 0; C.scene.traverse(o => { if (o.isMesh) meshes++; });
      return { lv: i, meshes, team: C.staff.length - 1, dpr: devicePixelRatio, w: innerWidth, h: innerHeight, cust: C.customers.length };
    });
    const ms = +(process.env.PERF_MS || 4000);
    const ts = await page.evaluate(ms => new Promise(res => {
      const ts = []; let t0 = null;
      const f = t => { if (t0 === null) t0 = t; ts.push(t); if (t - t0 < ms && __qa.C.G.state === 'play') requestAnimationFrame(f); else res(ts); };
      requestAnimationFrame(() => requestAnimationFrame(f));   // skip the first frame after the sim burst
    }), ms);
    await page.evaluate(() => { __qa.C.botOwner(false); });
    const d = []; for (let k = 1; k < ts.length; k++) d.push(ts[k] - ts[k - 1]);
    assert(d.length >= 2, 'fewer than 3 frames in ' + ms + 'ms');
    const avg = d.reduce((a, b) => a + b, 0) / d.length, p95 = d.slice().sort((a, b) => a - b)[Math.floor(d.length * 0.95)];
    const max = +(process.env.PERF_MAX_MS || 1500);
    const msg = `avg ${avg.toFixed(1)}ms (${(1000 / avg).toFixed(1)} fps), p95 ${p95.toFixed(0)}ms, ${d.length} frames; L${info.lv + 1} with ${info.team} clones, ${info.cust} customers, ${info.meshes} meshes, ${info.w}x${info.h}@${info.dpr}x`;
    assert(avg < max, msg + ` — over the ${max}ms gross-regression limit (PERF_MAX_MS)`);
    return msg;
  });
}

/* ================================================================== main */
(async () => {
  const killer = setTimeout(() => { console.error('Suite timed out after ' + SUITE_TIMEOUT_MS / 1000 + 's'); printTable(); process.exit(2); }, SUITE_TIMEOUT_MS);
  console.log('Clone Mart Rush test suite');
  console.log('  game:     ' + GAME);
  console.log('  three.js: ' + (THREE_JS ? process.env.THREE_JS + ' (local)' : 'CDN'));
  console.log('  out dir:  ' + OUT_DIR + (ONLY ? '\n  only:     ' + ONLY : '') + '\n');
  const mobileWanted = want('smoke') || want('controls') || want('perf');
  const tracks = await Promise.allSettled([
    desktopTrack(),
    mobileWanted ? mobileTrack(1, 'iphone13', 'iPhone 13', { buttons: true, perf: true }) : null,
    mobileWanted ? mobileTrack(2, 'ipad', 'iPad (gen 7)', { buttons: false }) : null,
    progressionTrack(3, 'desktop2'),
  ]);
  for (const t of tracks) if (t.status === 'rejected') results.push({ order: 9, seq: results.length, group: 'suite', name: 'track crashed', pass: false, detail: String(t.reason && t.reason.message || t.reason).split('\n')[0], ms: 0 });
  clearTimeout(killer);
  const failed = printTable();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Suite crashed:', e && e.stack || e); printTable(); process.exit(2); });

function printTable() {
  const DEV = ['desktop', 'iPhone13', 'iPad', 'desktop', '-'];
  const sorted = results.slice().sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
  const rows = sorted.map(r => [r.pass ? 'PASS' : 'FAIL', DEV[Math.min(r.order, 4)], r.group, r.name, (r.ms / 1000).toFixed(1) + 's', r.detail]);
  const w = [4, 6, 5, 4, 5].map((m, i) => Math.max(m, ...rows.map(r => strWidth(r[i]))));
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - strWidth(s)));
  const line = '-'.repeat(Math.min(200, w.reduce((a, b) => a + b, 0) + 22));
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
function strWidth(s) { let n = 0; for (const ch of String(s)) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦★✓✗]/.test(ch) ? 2 : 1; return n; }
