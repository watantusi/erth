/*
 * "Human-like" owner bot for balance checks (used by balance.js and run.js).
 *
 * It rides on the game's own owner autopilot (botOwner → aiUpdate with every recipe) and makes it play like a
 * casual human, from outside the game, after every 1/30 s sim step:
 *   - reaction delay 0.6–1.2 s before every step (the AI's own think pause is 0.5 s)
 *   - walks at 80 % of the owner's speed
 *   - does not always take the most urgent ticket (pOther: picks a random other open ticket)
 *   - occasional wrong pick-up that has to be binned (pWrong)
 *   - sometimes gets distracted while food sits ready in a machine (pBurn: 4–12 s extra), so it burns on the
 *     shorter burn timers
 * The game is only read through window.__cloneMart. Exported as a function to run in the page (page.evaluate).
 */
module.exports = function humanLib() {
  const C = window.__cloneMart;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const H = window.__human = {
    opts: { react: [0.6, 1.2], speed: 0.8, pOther: 0.35, pWrong: 0.1, pBurn: 0.25, distract: [4, 12] },
    st: null,
    // start a level the way a player does (owner = human-like bot); returns false if it did not start
    start(lv, team, firstTime) {
      const G = C.G;
      C.botOwner(false);
      G.skipTut = !firstTime;
      C.startLevel(lv, team || []);
      C.skipCountdown();
      if (G.state !== 'play') return false;
      C.botOwner(true);
      const o = C.owner;
      if (!o._baseSpeed0) o._baseSpeed0 = o.baseSpeed;
      o.baseSpeed = o._baseSpeed0 * H.opts.speed;
      H.st = { ai: null, plan: null, i: -1, rolled: null, willDistract: false, seen: new WeakSet(), stats: { react: 0, other: 0, wrong: 0, distract: 0, burned: 0 } };
      return true;
    },
    stop() {
      const o = C.owner;
      if (o._baseSpeed0) o.baseSpeed = o._baseSpeed0;
      C.botOwner(false);
      C.G.skipTut = true;
    },
    // after each sim step: make the owner's autopilot human
    tick() {
      const o = C.owner, ai = o.ai, st = H.st, op = H.opts;
      if (!ai || !st) return;
      const fresh = ai !== st.ai || ai.plan !== st.plan;
      if (fresh && ai.plan) {
        // a new job was just chosen
        if (ai.claim && Math.random() < op.pOther) {
          const alt = C.orders.filter(x => x !== ai.claim && !x.claim && C.PLANS[x.rec]);
          if (alt.length) {
            const n = alt[Math.floor(Math.random() * alt.length)];
            ai.claim.claim = null; n.claim = o; ai.claim = n;
            ai.plan = C.PLANS[n.rec].concat([['deliver', 'pass']]); ai.i = 0; ai.t = 0;
            st.stats.other++;
          }
        }
        if (!o.hold && ai.claim && Math.random() < op.pWrong) {
          const srcs = C.SLOTS.filter(sl => sl.kind === 'src' && !sl.fire);
          const trash = C.SLOTS.find(sl => sl.kind === 'trash');
          if (srcs.length && trash) {
            const w = srcs[Math.floor(Math.random() * srcs.length)];
            ai.plan = [['take', w.id], ['bin', trash.id]].concat(ai.plan); ai.i = 0; ai.t = 0;
            st.stats.wrong++;
          }
        }
      }
      if (ai.plan && (fresh || ai.i !== st.i)) { ai.pause = rnd(op.react[0], op.react[1]); st.stats.react++; }
      // distracted while food cooks: it sits ready in the machine for a while (the AI grabs it the step it is done,
      // so the pause starts the step before it would be ready)
      const step = ai.plan && ai.plan[ai.i];
      if (step && step[0] === 'wait') {
        const sl = C.SLOT[step[1]], it = sl && sl.item, A = sl && C.APPL[sl.id], inR = it && A && A.ins[it.type];
        if (inR && st.rolled !== it) { st.rolled = it; st.willDistract = Math.random() < op.pBurn; }
        if (inR && st.willDistract && st.rolled === it && it.cook + 1 / 30 >= inR.t && !sl.broken) {
          st.willDistract = false; ai.pause = Math.max(ai.pause || 0, rnd(op.distract[0], op.distract[1])); st.stats.distract++;
        }
      }
      for (const sl of C.SLOTS) if (sl.item && sl.item.type === 'burnt' && !st.seen.has(sl.item)) { st.seen.add(sl.item); st.stats.burned++; }
      st.ai = ai; st.plan = ai.plan; st.i = ai.i;
    },
    // play `secs` of game time (or to the end); returns the state
    play(secs) {
      const n = Math.round(secs * 30);
      for (let k = 0; k < n && C.G.state === 'play'; k++) { C.sim(1 / 30); H.tick(); }
      if (C.G.state === 'play') return 'play';
      return C.G.state;
    },
    // a whole level: returns {score, stars, delivered, failed, burnt, fires}
    level(lv, team, firstTime) {
      const L = C.LEVELS[lv];
      if (!H.start(lv, team, firstTime)) return null;
      const EL = C.G.level;
      H.play((L.endless ? 900 : L.len) + 400);   // + the paused tutorial clock on a first play
      const score = Math.max(0, Math.round(C.G.money)), S = C.G.stats;
      let stars = 0; for (const t of EL.stars) if (score >= t) stars++;
      const r = { score, stars, th: EL.stars.slice(), delivered: S.delivered, failed: S.failed, burnt: H.st.stats.burned, fires: S.fires, human: Object.assign({}, H.st.stats) };
      H.stop();
      return r;
    },
    // the prep screen's default team for a level (depends on the stars earned so far)
    defaultTeam(i) {
      C.botOwner(false); C.showPrep(i);
      return [...document.querySelectorAll('#prepTeam .tp')].map((b, k) => b.classList.contains('on') && C.ROLES[k] ? C.ROLES[k].id : null).filter(Boolean);
    },
    // the default team on its own, owner idle (a replay: no tutorial)
    idle(i, team) {
      const G = C.G;
      C.botOwner(false); G.skipTut = true; C.startLevel(i, team); C.skipCountdown();
      const EL = G.level; C.sim((EL.endless ? 900 : EL.len) + 5);
      const score = Math.max(0, Math.round(G.money)); let stars = 0; for (const t of EL.stars) if (score >= t) stars++;
      return { score, stars, th: EL.stars.slice(), delivered: G.stats.delivered, failed: G.stats.failed, burnt: 0, fires: G.stats.fires, human: {} };
    },
    // a player's run through one chapter (or a list of chapters) on one difficulty, from a fresh save; modes: solo | team | idle
    // (idle reuses the progress of the mode before it, so its team is the one that player would have).
    // Returns {'mode:levelIndex': result}. G.best and G.diff are restored afterwards.
    campaign(diff, chapter, modes, opts) {
      const G = C.G, keep = { best: JSON.stringify(G.best), diff: G.diff, opts: Object.assign({}, H.opts) };
      if (opts) Object.assign(H.opts, opts);
      G.diff = diff;
      const chs = [].concat(chapter), lvls = [];   // one chapter or a list, played in order with the progress carried over
      for (const ch of chs) C.LEVELS.forEach((L, i) => { if ((L.ch === undefined ? 1 : L.ch) === ch && !L.endless) lvls.push(i); });
      const out = {};
      try {
        for (const mode of modes) {
          if (mode !== 'idle') for (const k in G.best) delete G.best[k];
          for (const i of lvls) {
            const team = mode === 'solo' ? [] : H.defaultTeam(i);
            const r = mode === 'idle' ? H.idle(i, team) : H.level(i, team, !C.bestOf(i).stars);
            if (!r) continue;
            r.team = team.join('+') || '-';
            out[mode + ':' + i] = r;
            if (mode === 'idle') continue;
            const lid = C.LEVELS[i].id, p = G.best[lid] || { score: 0, stars: 0 };   // progress as a player would (unlocks, roles)
            G.best[lid] = { score: Math.max(p.score, r.score), stars: Math.max(p.stars, r.stars), crown: false };
          }
        }
      } finally {
        H.stop();
        for (const k in G.best) delete G.best[k];
        Object.assign(G.best, JSON.parse(keep.best)); G.diff = keep.diff; H.opts = keep.opts;
      }
      return out;
    },
  };
};
