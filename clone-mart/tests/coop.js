#!/usr/bin/env node
/*
 * 分身便利店 — local co-op (👥 雙人同樂) checks
 *
 *   NODE_PATH=$(npm root -g) THREE_JS=/path/three.min.js OUT_DIR=/dir node clone-mart/tests/coop.js
 *
 * Real keyboard events for both players at once, a stubbed navigator.getGamepads with two pads, the co-op camera,
 * the prep toggle (desktop / touch), the receipt line, and co-op off = the old single-player behaviour.
 * Exit code: 0 = all PASS, 1 = some FAIL, 2 = crashed.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium, devices } = require('playwright');

const GAME = process.env.GAME_HTML ? path.resolve(process.env.GAME_HTML) : path.resolve(__dirname, '..', 'index.html');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'clone-mart-coop-' + Date.now());
const THREE_JS = process.env.THREE_JS && fs.existsSync(process.env.THREE_JS) ? fs.readFileSync(process.env.THREE_JS) : null;
const CHROME_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(c, m) { if (!c) throw new Error(m); }
async function test(name, fn) {
  const t = Date.now(); let pass = false, detail = '';
  try { const r = await fn(); pass = true; detail = typeof r === 'string' ? r : ''; }
  catch (e) { detail = (e && e.message ? e.message : String(e)).replace(/^page\.evaluate: (Error: )?/, '').split('\n')[0]; }
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}
async function poll(fn, ms, every) { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(every || 100); } return v; }
async function shot(page, name) {
  try { await page.screenshot({ path: path.join(OUT_DIR, name + '.png'), timeout: 40000, animations: 'disabled' }); return path.join(OUT_DIR, name + '.png'); }
  catch (e) { console.log('    (screenshot ' + name + ' failed: ' + e.message.split('\n')[0] + ')'); return null; }
}

// two stub gamepads; tests flip window.__pads[i].buttons[b].pressed / axes; __padN = how many are connected
const PAD_STUB = () => {
  const mk = i => ({ id: 'stub pad ' + i, index: i, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) });
  window.__pads = [mk(0), mk(1)];
  window.__padN = 2;
  navigator.getGamepads = () => { const out = [null, null, null, null]; for (let i = 0; i < window.__padN; i++) out[i] = window.__pads[i]; return out; };
};

async function openGame(browser, ctxOpts, init) {
  const ctx = await browser.newContext(ctxOpts);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/font|Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text()); });
  if (THREE_JS) await page.route('**/three.min.js', r => r.fulfill({ body: THREE_JS, contentType: 'application/javascript' }));
  await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.route(/fonts\.gstatic\.com/, r => r.fulfill({ body: '', contentType: 'font/woff2' }));
  await page.goto(pathToFileURL(GAME).href, { waitUntil: 'load', timeout: 45000 });
  await page.waitForFunction(() => window.__cloneMart && window.__cloneMartCoop, null, { timeout: 45000 });
  await page.evaluate(lib);
  return { ctx, page, errors };
}

/* in-page helpers (window.__q) */
function lib() {
  const C = window.__cloneMart, K = window.__cloneMartCoop, N = window.__cloneMartNav, UX = window.__cloneMartUX;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const Q = window.__q = { C, K };
  C.G.skipTut = true; C.G.diff = 'hard';
  Q.slot = id => C.SLOT[id];
  Q.near = (sl, p) => sl.band ? { x: clamp(p.x, sl.band[0], sl.band[1]), z: clamp(p.z, sl.band[2], sl.band[3]) } : { x: sl.x, z: sl.z };
  Q.place = (s, x, z, rot) => { const a = s.agent; a.pos.x = x; a.pos.z = z; a.path.length = 0; s.pending = null; s.slip = null; if (rot !== undefined) { a.rot = rot; a.g.rotation.y = rot; } };
  Q.standAt = (id, s) => {
    const sl = C.SLOT[id]; if (!sl) throw new Error('no station ' + id);
    const q = Q.near(sl, sl.spot);
    Q.place(s, sl.spot.x, sl.spot.z, Math.atan2(q.x - sl.spot.x, q.z - sl.spot.z));
    const t = C.findTarget(s); if (t !== sl) throw new Error('standing at ' + id + ' targets ' + (t ? t.id : 'nothing'));
    return sl;
  };
  Q.src = type => C.SLOTS.find(sl => sl.kind === 'src' && sl.give === type);
  Q.isolate = o => { C.G.level = Object.assign({}, C.G.level, { len: 1e6, max: 0, endless: false, bulk: null, vip: 0 }, o || {}); C.G.spillT = C.G.outT = 1e9; };
  Q.start = (lv, team, coop) => { C.botOwner(false); K.want(coop); C.startLevel(lv, team || []); C.skipCountdown(); Q.isolate(); return C.G.state; };
  Q.until = (src, maxSecs, arg) => { const f = (0, eval)('(' + src + ')'); let v; for (let i = 0; i <= maxSecs * 30; i++) { v = f(arg); if (v) return v; if (C.sim(1 / 30) !== 'play') break; } return f(arg) || null; };
  Q.p = s => ({ x: s.agent.pos.x, z: s.agent.pos.z, role: s.role, hold: s.hold ? s.hold.type : null, tag: s.tag.tx.textContent, cls: s.tag.el.className });
  Q.both = () => ({ p1: Q.p(C.player), p2: K.p2 ? Q.p(K.p2) : null });
  // open floor around (x, z): walkable in a 1.2 m circle
  Q.floorNear = (x0, z0) => {
    let best = null, bd = 1e9;
    for (let x = -9.5; x <= 9.5; x += 0.25) for (let z = -6.5; z <= 6.8; z += 0.25) {
      let ok = N.walkXZ(x, z);
      for (let k = 0; ok && k < 12; k++) ok = N.walkXZ(x + Math.cos(k * Math.PI / 6) * 1.2, z + Math.sin(k * Math.PI / 6) * 1.2);
      const d = Math.hypot(x - x0, z - z0); if (ok && d < bd) { bd = d; best = { x, z }; }
    }
    return best;
  };
  Q.corner = (x0, z0) => {   // walkable spot nearest a store corner (no clearance needed)
    let best = null, bd = 1e9;
    for (let x = -9.8; x <= 9.8; x += 0.1) for (let z = -6.8; z <= 6.8; z += 0.1) if (N.walkXZ(x, z)) { const d = Math.hypot(x - x0, z - z0); if (d < bd) { bd = d; best = { x, z }; } }
    return best;
  };
  // is a character fully on screen (feet and head, not under the HUD)?
  Q.inView = s => {
    const p = s.agent.pos, ins = UX.view().inset;
    const f = UX.project(p.x, 0, p.z), h = UX.project(p.x, 2.0, p.z);
    const ok = [f, h].every(q => q.x > 0 && q.x < innerWidth && q.y > 0 && q.y < innerHeight) && f.y > ins.top;
    return { ok, feet: { x: Math.round(f.x), y: Math.round(f.y) }, head: { x: Math.round(h.x), y: Math.round(h.y) }, top: ins.top };
  };
}

async function desktop(browser) {
  const P = await openGame(browser, { viewport: { width: 1280, height: 760 } }, PAD_STUB);
  const page = P.page;
  await page.evaluate(() => { window.__padN = 0; });   // keyboard-only until the gamepad test

  await test('prep: 👥 toggle is visible on desktop, off by default, click turns it on and names the clone 2P takes', async () => {
    await page.evaluate(() => { const C = __q.C; C.showPrep(1); });
    await page.waitForSelector('#prepCoop', { state: 'visible' });
    const off = await page.evaluate(() => ({ pressed: document.querySelector('#btnCoop').getAttribute('aria-pressed'), keys: document.querySelector('#prepCoop .coopkeys').hidden }));
    assert(off.pressed === 'false' && off.keys, 'toggle not off by default: ' + JSON.stringify(off));
    await page.evaluate(() => document.querySelector('#btnCoop').scrollIntoView({ block: 'center' }));
    const bb = await page.locator('#btnCoop').boundingBox();
    const at = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.closest('#btnCoop') ? 'btnCoop' : e.id || e.className || e.tagName); }, [bb.x + bb.width / 2, bb.y + bb.height / 2]);
    assert(at === 'btnCoop', 'something covers the toggle: ' + at + ' ' + JSON.stringify(bb));
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    const on = await poll(() => page.evaluate(() => document.querySelector('#btnCoop').getAttribute('aria-pressed') === 'true' ? document.querySelector('#prepCoop').innerText : null), 3000);
    assert(on, 'click did not turn 雙人同樂 on');
    assert(/2P/.test(on) && /方向鍵/.test(on), 'no 2P key help: ' + on);
    const shotPath = await shot(page, 'coop-1-prep');
    return on.split('\n')[0] + (shotPath ? ' · ' + path.basename(shotPath) : '');
  });

  await test('start in co-op: 2P takes a clone from the team, tags read 1P / 2P, P2 is not in the AI loop', async () => {
    await page.evaluate(() => { document.querySelector('#btnGo').click(); });
    await poll(() => page.evaluate(() => __q.C.G.state === 'countdown' || __q.C.G.state === 'play'), 5000);
    const r = await page.evaluate(() => {
      const Q = __q, C = Q.C, K = Q.K; C.skipCountdown(); Q.isolate();
      C.sim(0.2);
      const p2 = K.p2;
      const before = Q.p(p2); C.spawnOrder('coffee'); C.spawnOrder('drink'); C.sim(4);
      const after = Q.p(p2);
      return { on: K.on(), p2role: p2 && p2.role, team: C.staff.filter(s => s !== C.owner).map(s => s.role), tags: Q.both(), moved: Math.hypot(after.x - before.x, after.z - before.z), plan: !!(p2.ai && p2.ai.plan), claim: C.orders.some(o => o.claim === p2) };
    });
    assert(r.on && r.p2role && r.p2role !== 'owner', 'co-op not on / no clone for 2P: ' + JSON.stringify(r));
    assert(r.tags.p1.tag === '1P' && /\bp1\b/.test(r.tags.p1.cls), '1P tag: ' + JSON.stringify(r.tags.p1));
    assert(r.tags.p2.tag === '2P' && /\bp2\b/.test(r.tags.p2.cls), '2P tag: ' + JSON.stringify(r.tags.p2));
    assert(r.moved < 0.05 && !r.plan && !r.claim, `2P moved/planned on its own (AI): moved ${r.moved.toFixed(2)}m plan=${r.plan} claim=${r.claim}`);
    return `2P = ${r.p2role} (team on the floor: ${r.team.join(',') || 'none'}), idle 4s with a coffee ticket up`;
  });

  await test('keyboard: 1P (WASD) and 2P (arrows) move independently at the same time', async () => {
    await page.evaluate(() => { const Q = __q, C = Q.C, K = Q.K, a = Q.floorNear(-1, 0.5), b = Q.floorNear(3, -1.5); Q.place(C.player, a.x, a.z); Q.place(K.p2, b.x, b.z); window.__p0 = Q.both(); });
    await page.keyboard.down('KeyD'); await page.keyboard.down('ArrowLeft');
    await page.evaluate(() => __q.C.sim(0.5));
    await page.keyboard.up('KeyD'); await page.keyboard.up('ArrowLeft');
    await page.evaluate(() => { const Q = __q; window.__p1 = Q.both(); });
    await page.keyboard.down('KeyS'); await page.keyboard.down('ArrowUp');
    await page.evaluate(() => __q.C.sim(0.5));
    await page.keyboard.up('KeyS'); await page.keyboard.up('ArrowUp');
    const r = await page.evaluate(() => { const p2 = __q.both(); return { a: window.__p0, b: window.__p1, c: p2 }; });
    const d1x = r.b.p1.x - r.a.p1.x, d2x = r.b.p2.x - r.a.p2.x, d1z = r.c.p1.z - r.b.p1.z, d2z = r.c.p2.z - r.b.p2.z;
    assert(d1x > 0.8 && Math.abs(r.b.p1.z - r.a.p1.z) < 0.4, `1P D: dx ${d1x.toFixed(2)}`);
    assert(d2x < -0.8 && Math.abs(r.b.p2.z - r.a.p2.z) < 0.4, `2P ←: dx ${d2x.toFixed(2)}`);
    assert(d1z > 0.5, `1P S: dz ${d1z.toFixed(2)}`);
    assert(d2z < -0.5, `2P ↑: dz ${d2z.toFixed(2)}`);
    return `D+← : 1P dx ${d1x.toFixed(1)}, 2P dx ${d2x.toFixed(1)} · S+↑ : 1P dz ${d1z.toFixed(1)}, 2P dz ${d2z.toFixed(1)}`;
  });

  await test('keyboard: Space grabs for 1P and Enter grabs for 2P; holding / chops for 2P, holding E chops for 1P', async () => {
    const t = await page.evaluate(() => {
      const Q = __q, C = Q.C, K = Q.K;
      for (const s of [C.player, K.p2]) if (s.hold) { Q.standAt(C.SLOTS.find(x => x.kind === 'trash').id, s); C.grab(s, C.findTarget(s)); }
      const srcs = C.SLOTS.filter(s => s.kind === 'src');
      const a = srcs.find(s => { try { Q.standAt(s.id, C.player); return true; } catch (e) { return false; } });
      const b = srcs.find(s => s !== a && s.give !== a.give && (() => { try { Q.standAt(s.id, K.p2); return true; } catch (e) { return false; } })());
      Q.standAt(a.id, C.player);
      return { a: a.id, ag: a.give, b: b.id, bg: b.give };
    });
    await page.keyboard.press('Enter');
    const h2 = await poll(() => page.evaluate(() => __q.K.p2.hold && __q.K.p2.hold.type), 3000);
    const h1a = await page.evaluate(() => __q.C.player.hold);
    assert(h2 === t.bg, `Enter: 2P holds ${h2}, expected ${t.bg}`);
    assert(!h1a, 'Enter also made 1P grab');
    await page.keyboard.press('Space');
    const h1 = await poll(() => page.evaluate(() => __q.C.player.hold && __q.C.player.hold.type), 3000);
    assert(h1 === t.ag, `Space: 1P holds ${h1}, expected ${t.ag}`);
    // chopping: 1P at the board with E, then 2P at the board with /
    const chop = await page.evaluate(() => {
      const Q = __q, C = Q.C, K = Q.K;
      for (const s of [C.player, K.p2]) if (s.hold) { Q.standAt(C.SLOTS.find(x => x.kind === 'trash').id, s); C.grab(s, C.findTarget(s)); }
      const board = C.SLOTS.find(s => s.kind === 'board'), fruit = Q.src('fruit');
      if (!board || !fruit) return null;
      Q.standAt(fruit.id, C.player); C.grab(C.player, C.findTarget(C.player)); Q.standAt(board.id, C.player); C.grab(C.player, board);
      Q.place(K.p2, -9, -6);
      return { board: board.id };
    });
    if (!chop) return `grab ok (${t.ag} / ${t.bg}); no board to chop on`;
    await page.keyboard.down('KeyE');
    const c1 = await page.evaluate(b => __q.until(`b => { const it = __q.C.SLOT[b].item; return it && it.type !== 'fruit' ? it.type : null; }`, 8, b), chop.board);
    await page.keyboard.up('KeyE');
    assert(c1, '1P holding E did not chop');
    await page.evaluate(b => { const Q = __q, C = Q.C, K = Q.K, it = C.SLOT[b].item; if (it && it.mesh.parent) it.mesh.parent.remove(it.mesh); C.SLOT[b].item = null;
      Q.place(C.player, -9, -6); Q.standAt(Q.src('fruit').id, K.p2); C.grab(K.p2, C.findTarget(K.p2)); Q.standAt(b, K.p2); C.grab(K.p2, C.SLOT[b]); }, chop.board);
    await page.keyboard.down('Slash');
    const c2 = await page.evaluate(b => __q.until(`b => { const it = __q.C.SLOT[b].item; return it && it.type !== 'fruit' ? it.type : null; }`, 8, b), chop.board);
    const prog = await page.evaluate(() => __q.K.p2.prog);
    await page.keyboard.up('Slash');
    assert(c2, '2P holding / did not chop');
    return `Space→${h1}, Enter→${h2}; E chopped → ${c1}, / chopped → ${c2}`;
  });

  await test('co-op delivery: 2P delivers a coffee (Enter) while 1P delivers a drink (Space); receipt shows each count', async () => {
    const r0 = await page.evaluate(() => {
      const Q = __q, C = Q.C, K = Q.K;
      for (const s of [C.player, K.p2]) if (s.hold) { Q.standAt(C.SLOTS.find(x => x.kind === 'trash').id, s); C.grab(s, C.findTarget(s)); }
      for (const sl of C.SLOTS) if (sl.item && sl.item.type !== 'ext') { sl.item.mesh.parent && sl.item.mesh.parent.remove(sl.item.mesh); sl.item = null; }
      for (const o of C.orders.slice()) { o.t = o.limit + 1; }
      C.sim(1 / 30);
      C.spawnOrder('coffee'); C.spawnOrder('drink');
      Q.standAt('cups', K.p2);
      Q.standAt('drink', C.player);
      return { del: C.G.stats.delivered, coop: K.coop.del.slice() };
    });
    await page.keyboard.press('Enter');   // 2P: empty cup
    await page.keyboard.press('Space');   // 1P: drink
    const s1 = await page.evaluate(() => __q.both());
    assert(s1.p2.hold === 'cup' && s1.p1.hold === 'drink', 'after Enter+Space: ' + JSON.stringify(s1));
    await page.evaluate(() => { __q.standAt('coffee', __q.K.p2); __q.standAt('pass', __q.C.player); });
    await page.keyboard.press('Enter');   // 2P: cup into the coffee machine
    await page.keyboard.press('Space');   // 1P: deliver the drink
    const brewed = await page.evaluate(() => __q.until(`() => { const it = __q.C.SLOT.coffee.item; return it && it.type === 'coffee'; }`, 15));
    assert(brewed, 'coffee never brewed');
    await page.keyboard.press('Enter');   // 2P: take the coffee
    await page.evaluate(() => __q.standAt('pass', __q.K.p2));
    await page.keyboard.press('Enter');   // 2P: deliver
    const r = await page.evaluate(() => ({ del: __q.C.G.stats.delivered, coop: __q.K.coop.del.slice(), byRec: Object.assign({}, __q.C.G.stats.byRec), hold: __q.both() }));
    assert(r.del - r0.del === 2, `delivered +${r.del - r0.del} (expected 2) ${JSON.stringify(r)}`);
    assert(r.coop[0] - r0.coop[0] === 1 && r.coop[1] - r0.coop[1] === 1, 'per-player counts ' + JSON.stringify(r.coop));
    const sp = await shot(page, 'coop-2-play-desktop');
    const res = await page.evaluate(() => { const C = __q.C; C.G.level.len = C.G.time + 0.05; C.sim(0.3); return { st: C.G.state, line: (document.querySelector('#receipt .coopres') || {}).textContent || '' }; });
    assert(res.st === 'results', 'not on results: ' + res.st);
    assert(/1P\s*1 份/.test(res.line) && /2P\s*1 份/.test(res.line), 'receipt line: ' + res.line);
    const sr = await shot(page, 'coop-3-results');
    return `coffee by 2P + drink by 1P → receipt "${res.line}"` + (sp ? ' · ' + path.basename(sp) : '') + (sr ? ', ' + path.basename(sr) : '');
  });

  await test('switching: 1P Q never lands on 2P; 2P "." switches 2P among the rest', async () => {
    const r = await page.evaluate(() => {
      const Q = __q, C = Q.C, K = Q.K; Q.start(1, ['barista', 'cook'], true);
      return { p1: C.player.role, p2: K.p2.role };
    });
    const seen = [];
    for (let i = 0; i < 4; i++) { await page.keyboard.press('KeyQ'); seen.push(await page.evaluate(() => [__q.C.player.role, __q.K.p2.role, __q.C.player === __q.K.p2])); }
    assert(seen.every(x => !x[2] && x[1] === r.p2), '1P switch touched 2P: ' + JSON.stringify(seen));
    assert(new Set(seen.map(x => x[0])).size === 2, '1P did not cycle owner/other clone: ' + JSON.stringify(seen));
    const b = await page.evaluate(() => __q.K.p2.role);
    await page.keyboard.press('Period');
    const a = await page.evaluate(() => ({ p2: __q.K.p2.role, p1: __q.C.player.role, same: __q.C.player === __q.K.p2, ai: __q.C.staff.find(s => s.role === 'barista').ai }));
    assert(a.p2 !== b && !a.same, '2P "." did not switch: ' + JSON.stringify(a));
    return `start 1P=${r.p1} 2P=${r.p2}; Q×4 → ${seen.map(x => x[0]).join('→')}; "." → 2P=${a.p2}`;
  });

  await test('co-op with an empty team: a 2P partner joins (and leaves with the level)', async () => {
    const r = await page.evaluate(() => {
      const Q = __q, C = Q.C, K = Q.K; Q.start(0, [], true);
      const n = C.staff.length, p2 = K.p2, part = p2 && p2.coopPartner;
      C.sim(0.5);
      Q.start(0, [], false);
      return { n, part, role: p2 && p2.role, after: C.staff.length, on: K.on() };
    });
    assert(r.part && r.n === 2, 'no partner: ' + JSON.stringify(r));
    assert(r.after === 1 && !r.on, 'partner stayed after co-op off: ' + JSON.stringify(r));
    return 'staff 2 in co-op, 1 after';
  });

  await test('camera: in co-op both players stay on screen at opposite corners (zoomed in), overview still works', async () => {
    await page.setViewportSize({ width: 960, height: 560 });
    await page.evaluate(() => { const Q = __q, C = Q.C, K = Q.K; Q.start(1, ['barista'], true); K.setZoom(0.55); });
    const r = [];
    for (const [a, b] of [[[-9.5, -6.5], [9.5, 6.8]], [[9.5, -6.5], [-9.5, 6.8]], [[-9.5, 6.8], [9.5, 6.8]]]) {
      await page.evaluate(([a, b]) => { const Q = __q, p = Q.corner(a[0], a[1]), q = Q.corner(b[0], b[1]); Q.place(Q.C.player, p.x, p.z); Q.place(Q.K.p2, q.x, q.z); }, [a, b]);
      const v = await poll(() => page.evaluate(() => { const Q = __q, x = Q.inView(Q.C.player), y = Q.inView(Q.K.p2); return x.ok && y.ok ? { x, y, d: Q.K.view().dist } : null; }), 8000, 150);
      const last = v || await page.evaluate(() => ({ x: __q.inView(__q.C.player), y: __q.inView(__q.K.p2), d: __q.K.view().dist }));
      assert(v, 'not both on screen: ' + JSON.stringify(last));
      r.push(last.d.toFixed(1));
    }
    await sleep(600); const s1 = await shot(page, 'coop-5-camera-corners-960x560');
    // part-way apart: framed between them, zoomed out only as far as needed
    await page.evaluate(() => { const Q = __q, p = Q.floorNear(-4.5, 2.5), q = Q.floorNear(3.5, -1); Q.place(Q.C.player, p.x, p.z); Q.place(Q.K.p2, q.x, q.z); });
    const mid = await poll(() => page.evaluate(() => { const Q = __q; return Q.inView(Q.C.player).ok && Q.inView(Q.K.p2).ok ? Q.K.view().dist : null; }), 8000, 150);
    assert(mid, 'part-way apart: not both on screen');
    await sleep(600); const s2 = await shot(page, 'coop-6-camera-apart-960x560');
    // close together → the camera comes back in (zoom honoured)
    await page.evaluate(() => { const Q = __q, p = Q.floorNear(2, 2); Q.place(Q.C.player, p.x, p.z); Q.place(Q.K.p2, p.x + 0.6, p.z); });
    const near = await poll(() => page.evaluate(d => { const v = __q.K.view().dist; return v < d * 0.8 ? v : null; }, +r[0]), 8000, 150);
    assert(near, 'camera did not come back in when the players met');
    // overview toggles to the whole store and back
    await page.keyboard.press('KeyV');
    const ov = await poll(() => page.evaluate(() => __q.K.view().overview), 3000);
    assert(ov, 'V did not switch to overview in co-op');
    await page.keyboard.press('KeyV');
    // single player at the same zoom does not fit both corners (so the check above is meaningful)
    await page.evaluate(() => { const Q = __q, C = Q.C, K = Q.K; Q.start(1, ['barista'], false); K.setZoom(0.55); const p = Q.corner(-9.5, -6.5), q = Q.corner(9.5, 6.8); Q.place(C.player, p.x, p.z); Q.place(C.staff.find(s => s !== C.owner), q.x, q.z); });
    await sleep(1500);
    const solo = await page.evaluate(() => ({ d: __q.K.view().dist, other: __q.inView(__q.C.staff.find(s => s !== __q.C.owner)).ok }));
    await page.evaluate(() => __q.K.setZoom(1));
    await page.setViewportSize({ width: 1280, height: 760 });
    return `co-op dist corners ${r.join(' / ')}, apart ${mid.toFixed(1)}, meet → ${near.toFixed(1)}; single player at the same zoom: dist ${solo.d.toFixed(1)}, far clone on screen = ${solo.other}`;
  });

  await test('co-op off = old behaviour: arrows move 1P, Enter / "." do nothing, tag "你", clone runs AI', async () => {
    await page.evaluate(() => { const Q = __q, C = Q.C; Q.start(1, ['barista'], false); const a = Q.floorNear(0, 1); Q.place(C.player, a.x, a.z); window.__o = Q.p(C.player); });
    await page.keyboard.down('ArrowRight');
    await page.evaluate(() => __q.C.sim(0.4));
    await page.keyboard.up('ArrowRight');
    await page.keyboard.press('Enter'); await page.keyboard.press('Period');
    const r = await page.evaluate(() => {
      const Q = __q, C = Q.C, K = Q.K, cl = C.staff.find(s => s !== C.owner), p = Q.p(C.player);
      C.spawnOrder('coffee'); C.sim(3);
      return { on: K.on(), p2: !!K.p2, dx: p.x - window.__o.x, role: C.player.role, tag: C.owner.tag.tx.textContent, cls: C.owner.tag.el.className, clonePlan: !!(cl.ai && cl.ai.plan), receiptLine: !!document.querySelector('#receipt .coopres') };
    });
    assert(!r.on && !r.p2, 'co-op on while off: ' + JSON.stringify(r));
    assert(r.dx > 0.6, `ArrowRight did not move 1P (dx ${r.dx.toFixed(2)})`);
    assert(r.role === 'owner', '"." switched 1P to ' + r.role);
    assert(r.tag === '你' && !/\bp[12]\b/.test(r.cls), 'tag ' + r.tag + ' / ' + r.cls);
    assert(r.clonePlan, 'clone did not pick up the coffee ticket (AI off?)');
    return `→ dx ${r.dx.toFixed(1)}, tag 你, barista AI busy`;
  });

  await test('gamepads (stub, 2 pads): co-op off → pad 0 drives 1P, pad 1 ignored; co-op on → pad 1 drives 2P and A grabs for 2P', async () => {
    await page.evaluate(() => { window.__padN = 2; const Q = __q, C = Q.C; Q.start(1, ['barista'], false); const a = Q.floorNear(0, 1); Q.place(C.player, a.x, a.z); const b = Q.floorNear(4, -1.5); Q.place(C.staff.find(s => s !== C.owner), b.x, b.z); window.__o = Q.p(C.player); window.__c = Q.p(C.staff.find(s => s !== C.owner)); C.G.level.rec = []; });
    await poll(() => page.evaluate(() => __cloneMartUX.input().padOn), 5000);
    // pad 1 alone: nothing happens to 1P (and 1P stays the owner)
    await page.evaluate(() => { __pads[1].axes[0] = -1; __pads[1].buttons[5].pressed = true; });
    await sleep(2500);
    const cl = await page.evaluate(() => { const p = __q.p(__q.C.player); return { d: Math.hypot(p.x - window.__o.x, p.z - window.__o.z), role: p.role }; });
    await page.evaluate(() => { __pads[1].axes[0] = 0; __pads[1].buttons[5].pressed = false; __pads[0].axes[0] = 1; });
    const off = await poll(() => page.evaluate(() => { const p = __q.p(__q.C.player); return p.x - window.__o.x > 0.6 ? p : null; }), 15000, 150);
    await page.evaluate(() => { __pads[0].axes[0] = 0; });
    assert(cl.d < 0.05 && cl.role === 'owner', `pad 1 drove 1P with co-op off: ${JSON.stringify(cl)}`);
    assert(off, 'pad 0 did not move 1P with co-op off');
    // co-op on
    await page.evaluate(() => { const Q = __q, C = Q.C, K = Q.K; Q.start(1, ['barista'], true); const a = Q.floorNear(-1, 1), b = Q.floorNear(4, -1.5); Q.place(C.player, a.x, a.z); Q.place(K.p2, b.x, b.z); window.__p0 = Q.both(); });
    await page.evaluate(() => { __pads[0].axes[0] = 1; __pads[1].axes[0] = -1; });
    const both = await poll(() => page.evaluate(() => { const b = __q.both(), a = window.__p0; return b.p1.x - a.p1.x > 0.6 && b.p2.x - a.p2.x < -0.6 ? { d1: b.p1.x - a.p1.x, d2: b.p2.x - a.p2.x } : null; }), 15000, 150);
    await page.evaluate(() => { __pads[0].axes[0] = 0; __pads[1].axes[0] = 0; });
    assert(both, 'pads did not move 1P right and 2P left: ' + JSON.stringify(await page.evaluate(() => [window.__p0, __q.both(), __q.K.pad2])));
    await page.evaluate(() => { const Q = __q; Q.standAt(Q.src('snack') ? Q.src('snack').id : 'cups', Q.K.p2); });
    await sleep(300);
    await page.evaluate(() => { __pads[1].buttons[0].pressed = true; __pads[1].buttons[0].value = 1; });
    const h = await poll(() => page.evaluate(() => __q.K.p2.hold && __q.K.p2.hold.type), 10000, 150);
    await page.evaluate(() => { __pads[1].buttons[0].pressed = false; __pads[1].buttons[0].value = 0; });
    const p1h = await page.evaluate(() => __q.C.player.hold);
    assert(h && !p1h, `pad 1 A: 2P holds ${h}, 1P holds ${p1h && p1h.type}`);
    const sp = await shot(page, 'coop-4-gamepads-desktop');
    return `off: 1P dx ${(off.x - (await page.evaluate(() => window.__o.x))).toFixed(1)}, clone still; on: 1P dx ${both.d1.toFixed(1)}, 2P dx ${both.d2.toFixed(1)}, pad 1 A → ${h}` + (sp ? ' · ' + path.basename(sp) : '');
  });

  await test('desktop: no page / console errors', async () => { assert(P.errors.length === 0, P.errors.slice(0, 3).join(' | ')); return 'clean'; });
  await P.ctx.close();
}

async function touch(browser) {
  const P = await openGame(browser, Object.assign({}, devices['iPhone 13'], { deviceScaleFactor: 1 }), () => {
    const mk = i => ({ id: 'stub pad ' + i, index: i, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });
    window.__pads = [mk(0), mk(1)]; window.__padN = 0;
    navigator.getGamepads = () => { const out = [null, null, null, null]; for (let i = 0; i < window.__padN; i++) out[i] = window.__pads[i]; return out; };
  });
  const page = P.page;
  await test('touch device: 👥 toggle hidden without pads, shown with 2 gamepads; co-op off keeps the touch buttons for 1P', async () => {
    const a = await page.evaluate(() => { __q.C.showPrep(1); const el = document.querySelector('#prepCoop'); return { exists: !!el, hidden: !el || el.hidden || el.offsetParent === null }; });
    assert(a.hidden, 'toggle visible on a touch device without gamepads');
    await page.evaluate(() => { window.__padN = 2; });
    const shown = await poll(() => page.evaluate(() => { const el = document.querySelector('#prepCoop'); return el && !el.hidden && el.offsetParent !== null; }), 8000, 150);
    assert(shown, 'toggle not shown with 2 gamepads connected');
    await page.evaluate(() => { window.__padN = 1; });
    const hid = await poll(() => page.evaluate(() => document.querySelector('#prepCoop').hidden), 8000, 150);
    assert(hid, 'toggle still shown after the 2nd pad disconnected');
    const r = await page.evaluate(() => { const Q = __q, C = Q.C, K = Q.K; Q.start(1, ['barista'], true); return { on: K.on(), act: !document.querySelector('#actions').hidden || true }; });
    assert(!r.on, 'co-op started on touch with only 1 gamepad');
    return 'hidden → shown with 2 pads → hidden with 1; co-op stays off with 1 pad';
  });
  await test('touch: no page / console errors', async () => { assert(P.errors.length === 0, P.errors.slice(0, 3).join(' | ')); return 'clean'; });
  await P.ctx.close();
}

(async () => {
  const browser = await chromium.launch({ args: CHROME_ARGS });
  const kill = setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 600000);
  try { await desktop(browser); await touch(browser); }
  catch (e) { console.log('CRASH', e); results.push({ name: 'crash', pass: false }); }
  finally { clearTimeout(kill); await browser.close(); }
  const fail = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - fail}/${results.length} passed — screenshots: ${OUT_DIR}`);
  process.exit(fail ? 1 : 0);
})();
