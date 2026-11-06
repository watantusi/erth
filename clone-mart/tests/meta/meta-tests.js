// Progression / meta checks: shop, wardrobe, upgrades, achievements, daily challenge, old saves.
const { launch, open } = require('./lib');
const results = [];
async function test(name, fn){
  try { const r = await fn(); results.push([true, name, r || '']); console.log('PASS', name, r || ''); }
  catch (e) { results.push([false, name, e.message.split('\n')[0]]); console.log('FAIL', name, e.message.split('\n')[0]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const b = await launch();
  let { ctx, page, errors } = await open(b);
  let coinsAfter = 0;
  const E = (f, a) => page.evaluate(f, a);
  const tap = sel => page.$eval(sel, el => el.click());

  await test('title nav + no errors on boot', async () => {
    const n = await E(() => document.querySelectorAll('#titleNav button').length);
    assert(n === 4, 'nav buttons ' + n); assert(!errors.length, errors.join(';'));
  });

  await test('buy upgrade through the UI (two taps), coins go down', async () => {
    await E(() => { __cloneMart.G.coins = 5000; });
    await page.click('#titleNav [data-go=shop]');
    await page.waitForSelector('#shop:not([hidden])');
    const btn = '#shop .card[data-upg=shoes] button';
    await page.click(btn);
    let lv = await E(() => __cloneMartMeta.upgLevel('shoes'));
    assert(lv === 0, 'bought on first tap');
    await page.click(btn);
    lv = await E(() => __cloneMartMeta.upgLevel('shoes'));
    const c = await E(() => __cloneMart.G.coins);
    const sp = await E(() => __cloneMart.G.life.coinsSpent);
    assert(lv === 1 && sp === 180 && c === 5000 - 180 + 20, `lv ${lv} coins ${c} spent ${sp}`);
    return 'shoes Lv1, coins 5000-180+20 (第一筆投資)';
  });

  await test('wardrobe: buy + equip a cosmetic on the owner and on a clone, live preview canvas', async () => {
    await page.click('#shop .mtabs [data-tab=wear]');
    await page.waitForSelector('#shop .wtile[data-cos=hat_chef]');
    await tap('#shop .wtile[data-cos=hat_chef]');
    await tap('#shop .wtile[data-cos=hat_chef]');
    const r = await E(() => ({ own: __cloneMart.G.owned.has('hat_chef'), eq: __cloneMart.G.equip.owner && __cloneMart.G.equip.owner.hat, live: !!(__cloneMart.owner.ch.cos && __cloneMart.owner.ch.cos.hat), prev: !!document.querySelector('#wrPrev canvas'), coins: __cloneMart.G.coins }));
    assert(r.own && r.eq === 'hat_chef' && r.live, JSON.stringify(r));
    const sp = await E(() => __cloneMart.G.life.coinsSpent);
    assert(sp === 330, 'spent ' + sp);
    // equip on the barista clone (unlocked from the start)
    await tap('#shop .wroles button:nth-child(2)');
    await tap('#shop .wtile[data-cos=hat_chef]');
    const c = await E(() => ({ eq: __cloneMart.G.equip.barista && __cloneMart.G.equip.barista.hat, demo: __cloneMart.staff.filter(s => s.role === 'barista').every(s => s.ch.cos && s.ch.cos.hat && s.ch.cos.hat.id === 'hat_chef'), coins: __cloneMart.G.coins }));
    assert(c.eq === 'hat_chef' && c.demo && c.coins === r.coins, JSON.stringify(c));
    coinsAfter = c.coins;
    // tap again = take it off
    await tap('#shop .wtile[data-cos=hat_chef]');
    const off = await E(() => !(__cloneMart.G.equip.barista || {}).hat);
    assert(off, 'did not unequip');
    await tap('#shop .wtile[data-cos=hat_chef]');
    return 'preview canvas ' + r.prev;
  });

  await test('purchases + equipment persist across reload', async () => {
    await page.reload();
    await page.waitForFunction(() => window.__cloneMartMeta && document.getElementById('titleNav'));
    const r = await E(() => ({ coins: __cloneMart.G.coins, own: [...__cloneMart.G.owned], eq: __cloneMart.G.equip, shoes: __cloneMartMeta.upgLevel('shoes'), hat: !!(__cloneMart.owner.ch.cos && __cloneMart.owner.ch.cos.hat) }));
    assert(r.coins === coinsAfter && r.own.includes('hat_chef') && r.eq.owner.hat === 'hat_chef' && r.eq.barista.hat === 'hat_chef' && r.shoes === 1 && r.hat, JSON.stringify(r));
  });

  // ---- each upgrade measurably applies ----
  const setUpg = (u) => E(u_ => { const G = __cloneMart.G; G.upg = Object.assign({}, u_); }, u);
  const play = (lv, team) => E(([lv, team]) => { const C = __cloneMart; C.G.skipTut = true; C.startLevel(lv, team); C.skipCountdown(); return C.G.state; }, [lv, team]);

  await test('跑鞋: owner speed ×1.25 at Lv3', async () => {
    await setUpg({ shoes: 3 }); await play(1, []);
    const v = await E(() => { __cloneMart.sim(0.1); return __cloneMart.owner.agent.speed; });
    await setUpg({}); await play(1, []);
    const v0 = await E(() => { __cloneMart.sim(0.1); return __cloneMart.owner.agent.speed; });
    assert(Math.abs(v - 4.4*1.25) < 1e-6 && Math.abs(v0 - 4.4) < 1e-6, `${v} vs ${v0}`);
    return `${v0} → ${v}`;
  });

  await test('分身訓練: clone speed ×1.3 and think pause ×0.4 at Lv3', async () => {
    const run = async (u) => { await setUpg(u); await play(1, ['barista']); return E(() => {
      const C = __cloneMart, s = C.staff.find(x => x.role === 'barista'); let mx = 0;
      for (let k = 0; k < 900; k++){ C.sim(1/30); if (s.ai && s.ai.pause > mx) mx = s.ai.pause; }
      return { sp: s.baseSpeed, pause: mx };
    }); };
    const a = await run({ train: 3 }), z = await run({});
    assert(Math.abs(a.sp - 2.6*1.3) < 1e-6 && Math.abs(z.sp - 2.6) < 1e-6, JSON.stringify([a, z]));
    assert(a.pause <= 0.2 + 1e-6 && z.pause > 0.45, JSON.stringify([a, z]));
    return JSON.stringify([z, a]);
  });

  await test('保溫燈 + 快速咖啡機: machine timers', async () => {
    await setUpg({ lamp: 3, coffee: 2 }); await play(2, []);
    const a = await E(() => { const A = __cloneMart.APPL, D = __cloneMart.DIFFS.find(d => d.id === __cloneMart.G.level.diff); return { burn: A.micro.ins.bento_cold.burn, fire: A.micro.fire, k: D.burn, cof: A.coffee.ins.cup.t, hw: A.hotwater.ins.noodle_raw.t }; });
    await setUpg({}); await play(2, []);
    const z = await E(() => { const A = __cloneMart.APPL; return { burn: A.micro.ins.bento_cold.burn, fire: A.micro.fire, cof: A.coffee.ins.cup.t, hw: A.hotwater.ins.noodle_raw.t }; });
    assert(Math.abs(a.burn - 7*a.k*2) < 1e-6 && Math.abs(z.burn - 7*a.k) < 1e-6 && Math.abs(a.fire - z.fire*2) < 1e-6, JSON.stringify([a, z]));
    assert(Math.abs(a.cof - 3*0.55) < 1e-6 && Math.abs(z.cof - 3) < 1e-6 && Math.abs(a.hw - 2.5*0.55) < 1e-6, JSON.stringify([a, z]));
    // the menu world (demo) is back to base values
    const d = await E(() => { __cloneMart.showLevels(); return __cloneMart.APPL.coffee.ins.cup.t; });
    assert(d === 3, 'demo coffee t ' + d);
    return `burn ${z.burn}→${a.burn}, coffee ${z.cof}→${a.cof}`;
  });

  await test('自動灑水器: a fire goes out by itself at Lv3 (4 s), stays without it', async () => {
    const run = async (u) => { await setUpg(u); await play(1, []); return E(() => { const C = __cloneMart; C.ignite(C.SLOT.c1); C.sim(5); return { fire: !!C.SLOT.c1.fire, spr: C.G.life.sprinkled }; }); };
    const a = await run({ sprinkler: 3 }), z = await run({});
    assert(!a.fire && z.fire, JSON.stringify([a, z]));
  });

  await test('大托盤: tip ×1.5 at Lv3', async () => {
    const run = async (u) => { await setUpg(u); await play(1, []); return E(() => {
      const C = __cloneMart; C.orders.slice().forEach(o => {}); while (C.orders.length) C.orders.pop();
      C.G.level.bulk = null; const o = C.spawnOrder('drink'); const before = C.G.money;
      C.grab(C.owner, C.SLOT.drink); C.grab(C.owner, C.SLOT.pass); return C.G.money - before; }); };
    const a = await run({ tray: 3 }), z = await run({});
    assert(a > z, `${z} → ${a}`);
    return `drink delivered: ${z} → ${a}`;
  });

  await test('防滑地墊: Lv1 halves the slide, Lv2 never slips', async () => {
    const run = async (u) => { await setUpg(u); await play(1, []);
      await E(() => { const C = __cloneMart; C.spawnSpill(); const sp = C.spills[C.spills.length-1]; C.owner.agent.pos.set(sp.x, 0, sp.z); C.owner.slipCD = 0; });
      await page.keyboard.down('KeyD');
      const r = await E(() => { const C = __cloneMart; let t = null; for (let k = 0; k < 6; k++){ C.sim(1/30); if (C.owner.slip && t === null) t = C.owner.slip.t + 1/30; } return t; });
      await page.keyboard.up('KeyD');
      return r; };
    const z = await run({}), h = await run({ mat: 1 }), n = await run({ mat: 2 });
    assert(z > 0.5 && h > 0 && h <= 0.275 + 1/30 + 1e-6 && n === null, JSON.stringify([z, h, n]));
    return `slide ${z.toFixed(2)}s → ${h.toFixed(2)}s → none`;
  });

  await test('專業工具箱: mopping ×2.2 at Lv2', async () => {
    const run = async (u) => { await setUpg(u); await play(1, []); return E(() => { const C = __cloneMart; C.spawnSpill(); const sp = C.spills[C.spills.length-1]; C.owner.agent.pos.set(sp.x, 0, sp.z); C.useTick(C.owner, 0.3); return sp.prog; }); };
    const a = await run({ tools: 2 }), z = await run({});
    assert(Math.abs(a - 0.66) < 1e-6 && Math.abs(z - 0.3) < 1e-6, `${z} → ${a}`);
  });

  // ---- achievements ----
  await test('achievements trigger once, with coins + popup', async () => {
    const r = await E(() => {
      const C = __cloneMart, G = C.G; G.ach = {}; G.life.delivered = 0; G.life.combo4 = 0;
      C.G.skipTut = true; C.startLevel(1, []); C.skipCountdown(); C.G.level.bulk = null;   // no random ×2 tickets
      while (C.orders.length) C.orders.pop();
      const c0 = G.coins;
      C.spawnOrder('drink'); C.grab(C.owner, C.SLOT.drink); C.grab(C.owner, C.SLOT.pass);
      const first = G.ach.first, c1 = G.coins, pop = document.querySelectorAll('#achPop .achp').length;
      C.spawnOrder('drink'); C.grab(C.owner, C.SLOT.drink); C.grab(C.owner, C.SLOT.pass);
      const again = __cloneMartMeta.metaCheck();
      // ×4 combo: deliver oldest-first four times
      for (let k = 0; k < 4; k++){ C.spawnOrder('snack'); }
      for (let k = 0; k < 4; k++){ C.grab(C.owner, C.SLOT.snack); C.grab(C.owner, C.SLOT.pass); }
      return { first: !!first, same: G.ach.first === first, gain: c1 - c0, after: G.coins - c1, again, pop, combo4: !!G.ach.combo4, n: Object.keys(G.ach) };
    });
    assert(r.first && r.same && r.gain >= 20 && r.again === 0 && r.pop >= 1 && r.combo4, JSON.stringify(r));
    return JSON.stringify(r.n);
  });

  await test('achievement list ≥ 25 and trophy screen renders', async () => {
    const n = await E(() => { __cloneMart.showLevels(); __cloneMartMeta.openMeta('trophy'); return [__cloneMartMeta.achList().length, document.querySelectorAll('#trophy .ach').length, document.querySelectorAll('#trophy .ach.got').length]; });
    assert(n[0] >= 25 && n[1] === n[0] && n[2] >= 2, JSON.stringify(n));
    await E(() => __cloneMartMeta.metaBack());
    return JSON.stringify(n);
  });

  await test('results: lifetime stats fold in, wallet row shown', async () => {
    const r = await E(() => { const C = __cloneMart; const s0 = C.G.life.shifts; C.G.skipTut = true; C.startLevel(1, ['barista']); C.skipCountdown(); C.sim(200);
      return { st: C.G.state, shifts: C.G.life.shifts - s0, wallet: !!document.querySelector('#resWallet .coinchip'), play: C.G.life.playTime }; });
    assert(r.st === 'results' && r.shifts === 1 && r.wallet && r.play > 100, JSON.stringify(r));
  });

  // ---- daily ----
  await test('daily is the same for the same date, different across dates', async () => {
    const r = await E(() => { const M = __cloneMartMeta, out = [];
      for (let d = 1; d <= 20; d++){ const k = '2026-11-' + String(d).padStart(2, '0'); out.push(JSON.stringify(M.dailyDef(k))); }
      return { same: JSON.stringify(M.dailyDef('2026-11-06')) === JSON.stringify(M.dailyDef('2026-11-06')), uniq: new Set(out).size, lv: new Set(out.map(s => JSON.parse(s).lv)).size, mods: [...new Set(out.flatMap(s => JSON.parse(s).mods.map(m => m.id)))] }; });
    assert(r.same && r.uniq >= 18 && r.lv >= 3, JSON.stringify(r));
    return JSON.stringify(r);
  });

  let def;
  await test('daily run: modifiers applied, own best per day, base level best untouched, streak', async () => {
    await E(() => { const G = __cloneMart.G; G.best['c1-1'] = G.best['c1-1'] || {score:300, stars:1, crown:false}; G.daily = {best:{}, last:'', streak:0, bestStreak:0, days:0}; __cloneMartMeta.setNow(new Date(2026, 10, 6, 12).getTime()); });
    await E(() => { __cloneMart.showLevels(); __cloneMartMeta.openMeta('daily'); });
    await page.click('#btnDailyGo');
    await page.waitForSelector('#prep:not([hidden])');
    const prepTitle = await E(() => document.getElementById('prepTitle').textContent);
    await page.click('#btnGo');
    const r = await E(() => { const C = __cloneMart, L = C.G.level, base = C.LEVELS[C.G.lv], bb = JSON.stringify(C.G.best[base.id] || null);
      C.skipCountdown(); C.sim(400);
      return { daily: L.daily, mods: __cloneMartMeta.META.daily.mods, rec: L.rec, baseRec: base.rec, timeMul: L.timeMul, vip: L.vip, rain: L.rain, outage: L.outage, burnMul: L.burnMul,
        st: C.G.state, title: document.getElementById('resTitle').textContent, best: C.G.daily.best, streak: C.G.daily.streak, baseBestSame: JSON.stringify(C.G.best[base.id] || null) === bb, next: document.getElementById('btnNextLv').hidden }; });
    def = r;
    assert(/每日挑戰/.test(prepTitle), prepTitle);
    assert(r.daily === '2026-11-06' && r.st === 'results' && /每日挑戰/.test(r.title) && r.best['2026-11-06'] !== undefined && r.streak === 1 && r.baseBestSame && r.next, JSON.stringify(r));
    for (const m of r.mods){
      if (m.id === 'only') assert(r.rec.length === 1 && r.rec[0] === m.rec, 'only');
      if (m.id === 'vip') assert(r.vip === 0.35, 'vip');
      if (m.id === 'rain') assert(r.rain && r.rain.every === 32, 'rain');
      if (m.id === 'outage') assert(r.outage === 32, 'outage');
      if (m.id === 'burn') assert(r.burnMul === 0.6, 'burn');
    }
    return 'mods ' + r.mods.map(m => m.id).join('+') + ', best ' + r.best['2026-11-06'];
  });

  await test('daily streak: next day +1, skipped day resets; bonus coins once per day', async () => {
    const r = await E(() => { const C = __cloneMart, M = __cloneMartMeta, G = C.G, out = [];
      const run = (y, m, d) => { M.setNow(new Date(y, m, d, 10).getTime()); C.showLevels(); M.startDaily(); C.G.skipTut = true; C.startLevel(M.META.daily.lv, []); C.skipCountdown(); const c0 = G.coins; C.sim(400); out.push({ day: d, streak: G.daily.streak, days: G.daily.days, coins: G.coins - c0, st: G.state }); };
      run(2026, 10, 7); run(2026, 10, 7); run(2026, 10, 9);
      return out; });
    assert(r[0].streak === 2 && r[0].days === 2 && r[1].streak === 2 && r[1].days === 2 && r[2].streak === 1 && r[2].days === 3, JSON.stringify(r));
    return JSON.stringify(r);
  });

  await test('menu after a daily run clears daily mode (normal level records best again)', async () => {
    const r = await E(() => { const C = __cloneMart; C.showLevels(); C.G.skipTut = true; C.startLevel(1, []); return { daily: !!C.G.level.daily, n: C.G.level.n }; });
    assert(!r.daily && r.n === '早餐尖峰', JSON.stringify(r));
  });

  await test('stats screen lists every recipe', async () => {
    const n = await E(() => { __cloneMart.showLevels(); __cloneMartMeta.openMeta('stats'); return [document.querySelectorAll('#stats .rbar').length, Object.keys(__cloneMart.RECIPES).length]; });
    assert(n[0] === n[1], JSON.stringify(n));
  });

  await test('no page errors so far', async () => { assert(!errors.length, errors.join(' | ')); });
  await ctx.close();

  // ---- old saves ----
  await test('v1 save (best keyed by index) loads; meta defaults', async () => {
    const o = await open(b, undefined, () => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1); localStorage.setItem('clonemart-rush-v1', JSON.stringify({ best: { 0: { score: 420, stars: 2 } }, team: ['barista'] })); } });
    const r = await o.page.evaluate(() => ({ best: __cloneMart.G.best['c1-1'], life: __cloneMart.G.life.delivered, upg: __cloneMart.G.upg, daily: __cloneMart.G.daily.days, coins: __cloneMart.G.coins }));
    await o.page.evaluate(() => { __cloneMartMeta.openMeta('shop'); __cloneMartMeta.openMeta('trophy'); __cloneMartMeta.openMeta('daily'); __cloneMartMeta.openMeta('stats'); });
    assert(r.best && r.best.stars === 2 && r.life === 0 && Object.keys(r.upg).length === 0 && r.daily === 0, JSON.stringify(r));
    assert(!o.errors.length, o.errors.join(';'));
    await o.ctx.close();
  });
  await test('v2 save without meta fields + junk meta fields load safely', async () => {
    const o = await open(b, undefined, () => { if (!sessionStorage.getItem('x')){ sessionStorage.setItem('x', 1); localStorage.setItem('clonemart-rush-v1', JSON.stringify({ v: 2, best: { 'c1-1': { score: 500, stars: 3 } }, coins: 777, owned: ['hat_cat'], equip: { owner: { hat: 'hat_cat' } }, ach: {}, upg: { shoes: 99, bogus: 3 }, life: { delivered: 'x', fires: 4 }, daily: { best: { nope: 3 }, streak: -2 } })); } });
    const r = await o.page.evaluate(() => ({ coins: __cloneMart.G.coins, hat: __cloneMart.owner.ch.cos.hat && __cloneMart.owner.ch.cos.hat.id, shoes: __cloneMartMeta.upgLevel('shoes'), upg: __cloneMart.G.upg, life: [__cloneMart.G.life.delivered, __cloneMart.G.life.fires], daily: __cloneMart.G.daily, star3: !!__cloneMart.G.ach.star3 }));
    assert(r.coins >= 777 && r.hat === 'hat_cat' && r.shoes === 3 && !r.upg.bogus && r.life[0] === 0 && r.life[1] === 4 && Object.keys(r.daily.best).length === 0 && r.daily.streak === 0, JSON.stringify(r));
    assert(!o.errors.length, o.errors.join(';'));
    await o.ctx.close();
    return JSON.stringify(r);
  });

  await b.close();
  const nf = results.filter(r => !r[0]).length;
  console.log(`${nf ? 'FAIL' : 'PASS'} ${results.length - nf}/${results.length}`);
  process.exit(nf ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
