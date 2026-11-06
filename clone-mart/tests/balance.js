#!/usr/bin/env node
/*
 * Difficulty balance report: a human-like owner bot (tests/human.js) plays every chapter level on each difficulty,
 * solo and with the default team the prep screen picks (from the stars that run has earned so far).
 *
 *   NODE_PATH=$(npm root -g) THREE_JS=/path/three.min.js node clone-mart/tests/balance.js [trials] [chapter]
 *
 * Env: GAME_HTML=path (default ../index.html), DIFFS=easy,normal,hard, MODES=solo,team,idle, HUMAN='{"pBurn":0.4}', VERBOSE=1,
 *      DIFF_OVERRIDE='{"easy":{"time":1.3}}' (try DIFFS numbers without editing the game)
 * Prints one table row per level/difficulty: average score, ★ per trial, and the share of runs at ≥1★ / ≥2★.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const humanLib = require('./human.js');

const TRIALS = +(process.argv[2] || 3);
const CHAPTER = +(process.argv[3] || 1);   // levels of this chapter (the run starts from a fresh save)
const GAME = process.env.GAME_HTML ? path.resolve(process.env.GAME_HTML) : path.resolve(__dirname, '..', 'index.html');
const THREE_JS = process.env.THREE_JS && fs.existsSync(process.env.THREE_JS) ? fs.readFileSync(process.env.THREE_JS) : null;
const MODES = (process.env.MODES || 'solo,team,idle').split(',');   // solo | team | idle (team of the run before, owner does nothing)
const HUMAN = process.env.HUMAN ? JSON.parse(process.env.HUMAN) : null;     // override human.js opts, e.g. '{"pBurn":0.5}'

async function open(browser) {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 500 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  if (THREE_JS) await page.route('**/three.min.js', r => r.fulfill({ body: THREE_JS, contentType: 'application/javascript' }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto(pathToFileURL(GAME).href, { timeout: 90000 });
  await page.waitForFunction(() => window.__cloneMart && window.__cloneMart.sim, null, { timeout: 45000 });
  await page.evaluate(humanLib);
  if (process.env.DIFF_OVERRIDE) await page.evaluate(o => { for (const D of window.__cloneMart.DIFFS) if (o[D.id]) Object.assign(D, o[D.id]); }, JSON.parse(process.env.DIFF_OVERRIDE));
  return { page, errs };
}

(async () => {
  const t0 = Date.now();
  const diffs = process.env.DIFFS ? process.env.DIFFS.split(',') : null;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const probe = await open(browser);
  const meta = await probe.page.evaluate(ch => {
    const C = window.__cloneMart;
    const ids = (C.CHAPTERS || [{ id: 1 }]).map(c => c.id), chain = ids.slice(0, Math.max(1, ids.indexOf(ch) + 1));   // earlier chapters first: their stars pick the team
    return { chain, diffs: C.DIFFS.map(d => ({ id: d.id, n: d.n, d })), levels: C.LEVELS.map((L, i) => ({ i, n: L.n, ch: L.ch, endless: !!L.endless, label: C.lvLabel ? C.lvLabel(i) : 'L' + (i + 1) })).filter(L => L.ch === ch && !L.endless) };
  }, CHAPTER);
  const D = meta.diffs.filter(d => !diffs || diffs.includes(d.id));
  console.log('DIFFS: ' + D.map(d => `${d.id} ${JSON.stringify({ time: d.d.time, every: d.d.every, burn: d.d.burn, star: d.d.star, slots: d.d.slots })}`).join('\n       '));
  // one page per difficulty, run in parallel
  const pages = [probe].concat(await Promise.all(D.slice(1).map(() => open(browser))));
  const all = await Promise.all(D.map(async (d, k) => {
    const runs = [];
    for (let t = 0; t < TRIALS; t++) runs.push(await pages[k].page.evaluate(a => window.__human.campaign(...a), [d.id, meta.chain, MODES, HUMAN]));
    return runs;
  }));
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + ['level', 'diff', 'mode', 'team (last)', 'thresholds', 'avg score', 'stars/trial', '≥1★', '≥2★', 'deliv/fail/burnt'].join(' | '));
  const summary = {};
  for (const L of meta.levels) {
    D.forEach((d, k) => {
      for (const mode of MODES) {
        const rs = all[k].map(r => r[mode + ':' + L.i]).filter(Boolean);
        if (!rs.length) continue;
        const avg = f => (rs.reduce((a, r) => a + r[f], 0) / rs.length);
        const s1 = rs.filter(r => r.stars >= 1).length / rs.length, s2 = rs.filter(r => r.stars >= 2).length / rs.length;
        const key = d.id + '/' + mode; summary[key] = summary[key] || { lv: 0, s1: 0, s2: 0, avgStars: 0 };
        summary[key].lv++; summary[key].s1 += s1 >= 0.5 ? 1 : 0; summary[key].s2 += s2 >= 0.5 ? 1 : 0; summary[key].avgStars += avg('stars');
        console.log([pad(L.label + ' ' + L.n, 16), pad(d.n, 4), pad(mode, 4), pad(rs[rs.length - 1].team, 22), pad(rs[0].th.join('/'), 14), pad(Math.round(avg('score')), 6),
          pad(rs.map(r => r.stars).join(','), 10), pad(Math.round(s1 * 100) + '%', 4), pad(Math.round(s2 * 100) + '%', 4),
          avg('delivered').toFixed(1) + '/' + avg('failed').toFixed(1) + '/' + avg('burnt').toFixed(1) + (process.env.VERBOSE ? ' ' + JSON.stringify(rs[0].human) : '')].join(' | '));
      }
    });
  }
  console.log('\nsummary (levels where ≥50% of runs reach the mark):');
  for (const k in summary) { const s = summary[k]; console.log(`  ${pad(k, 12)} ≥1★ on ${s.s1}/${s.lv}, ≥2★ on ${s.s2}/${s.lv}, avg ★ ${(s.avgStars / s.lv).toFixed(2)}`); }
  const errs = pages.flatMap(p => p.errs);
  if (errs.length) console.log('page errors: ' + errs.slice(0, 3).join(' | '));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${TRIALS} trial(s)`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(2); });
