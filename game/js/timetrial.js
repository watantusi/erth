// 計時挑戰（分身 3，v3）：通關後解鎖。隨機在星球上放 TRIAL_COUNT 顆金色「時光晶石」
// （2 顆在平台挑戰上），3-2-1 倒數後計時，收集完記錄最佳時間與獎牌。
// 合約：createTimeTrial({ scene, world, player, ui, audio, effects })
//   → { active, start(seed?), cancel(), update(dt, t), getNavTarget(), getRadarPoints(out), getBest(),
//       getSaveData(), loadSaveData(d), onFinish }
//   - onFinish({ time, best, medal, newRecord, choice })：結果視窗關閉後呼叫（choice = 'retry' | 'exit'）
//   - getBest() → 最佳秒數或 null（另有 getBestMedal() / bestMedal）
//   - getSaveData() → { best, medal }
// 視覺：晶石模型用 characters.createItem('trialCrystal')（沒有時改用簡單的金色八面體），
// 光柱與地面光環各用一個 InstancedMesh。物件只建立一次（重玩時重複利用），每幀不配置新物件。
import * as THREE from 'three';
import * as Characters from './characters.js';
import { TRIAL_COUNT, TRIAL_MEDALS, PICKUP_RADIUS, PLANET_RADIUS, SEA_LEVEL, START_BIOME } from './config.js';
import { mulberry32, randomUnitVector, angleBetweenDirs, biomeCenters, getBiomeById, tangentBasis, clamp } from './utils.js';

const HOVER = 1.15;          // 晶石離站立面高度
const CHECK = 0.5;           // 撿取判定點高度（比外觀低，比較好撿）
const BEAM_HEIGHT = 16;
const BEAM_BASE = HOVER + 0.4;
const GOLD = 0xffc93c;
const GOLD_DEEP = 0xd98c00;
const BEAM_GOLD = 0xffa81e;
const GOLD_BRIGHT = 0xfff2a8;
const ELEVATED = 2;          // 放在平台挑戰上的數量
const MIN_SPACING = 8;       // 晶石之間最小距離
const START_ANGLE = 0.3;     // 起點區（草原中心）半徑（弧度）
const PLAYER_MIN = 8;        // 地面晶石離玩家目前位置的最小距離
const COLLECT_TIME = 0.4;    // 收集動畫秒數
const FINISH_DELAY = 0.55;   // 最後一顆收集後等動畫播完再出結果
const MEDAL_RANK = { gold: 3, silver: 2, bronze: 1 };
const LABEL = '時光晶石';

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export function medalFor(time) {
  if (!Number.isFinite(time)) return null;
  if (time < TRIAL_MEDALS.gold) return 'gold';
  if (time < TRIAL_MEDALS.silver) return 'silver';
  if (time < TRIAL_MEDALS.bronze) return 'bronze';
  return null;
}
const rankOf = (m) => MEDAL_RANK[m] || 0;

// ---- 共用幾何（模組層級，只建一次） ----
let GEO = null;
function geometries() {
  if (GEO) return GEO;
  // 光柱：開口圓柱，頂點色由下往上淡出（加色混合下黑色 = 透明）
  const beam = new THREE.CylinderGeometry(0.5, 0.3, BEAM_HEIGHT, 12, 8, true);
  beam.translate(0, BEAM_HEIGHT / 2, 0);
  {
    const pos = beam.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getY(i) / BEAM_HEIGHT;
      const k = Math.pow(1 - h, 1.25) * (h < 0.05 ? h / 0.05 : 1);
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
    }
    beam.setAttribute('color', new THREE.BufferAttribute(col, 3));
    beam.deleteAttribute('uv');
  }
  const ring = new THREE.RingGeometry(0.7, 0.92, 32);
  ring.rotateX(-Math.PI / 2);
  // 備援晶石：金色八面體（面的明暗烘進頂點色）+ 亮色內核
  const gem = new THREE.OctahedronGeometry(0.5, 0);
  gem.scale(1, 1.55, 1);
  gem.computeVertexNormals();
  gem.deleteAttribute('uv');
  {
    const pos = gem.attributes.position, nor = gem.attributes.normal;
    const col = new Float32Array(pos.count * 3);
    const light = new THREE.Vector3(0.45, 0.75, 0.5).normalize();
    const deep = new THREE.Color(GOLD_DEEP), bright = new THREE.Color(GOLD_BRIGHT), c = new THREE.Color();
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      n.fromBufferAttribute(nor, i);
      c.copy(deep).lerp(bright, clamp(0.5 + 0.5 * n.dot(light), 0, 1));
      for (let j = 0; j < 3; j++) col.set([c.r, c.g, c.b], (i + j) * 3);
    }
    gem.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const core = new THREE.OctahedronGeometry(0.26, 0);
  core.scale(1, 1.55, 1);
  GEO = { beam, ring, gem, core };
  return GEO;
}

export function createTimeTrial({ scene, world, player, ui, audio, effects } = {}) {
  const safe = (fn) => { try { return fn(); } catch (e) { console.warn('[timetrial]', e); return undefined; } };
  const play = (name) => safe(() => audio && audio.play && audio.play(name));

  const G = geometries();
  const root = new THREE.Group();
  root.name = 'time-trial';
  root.visible = false;
  if (scene) scene.add(root);

  const M = {
    beam: new THREE.MeshBasicMaterial({
      color: BEAM_GOLD, vertexColors: true, transparent: true, opacity: 0.32,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }),
    ring: new THREE.MeshBasicMaterial({
      color: GOLD, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false,
    }),
    gem: null,
    core: null,
  };

  const beamMesh = new THREE.InstancedMesh(G.beam, M.beam, TRIAL_COUNT);
  const ringMesh = new THREE.InstancedMesh(G.ring, M.ring, TRIAL_COUNT);
  for (const m of [beamMesh, ringMesh]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    root.add(m);
  }
  beamMesh.renderOrder = 5;
  ringMesh.renderOrder = 3;
  const _col = new THREE.Color(1, 1, 1);
  for (let i = 0; i < TRIAL_COUNT; i++) beamMesh.setColorAt(i, _col);

  // ---- 晶石模型（建立一次） ----
  function makeModel() {
    let obj = null;
    try {
      const kinds = Characters.ITEM_KINDS;
      const known = !Array.isArray(kinds) || kinds.indexOf('trialCrystal') >= 0;
      if (known && typeof Characters.createItem === 'function') {
        const o = Characters.createItem('trialCrystal');
        if (o && o.isObject3D && o.children && o.children.length) obj = o;
      }
    } catch (e) { console.warn('[timetrial] createItem(trialCrystal) 失敗，改用備援模型', e); }
    if (!obj) {
      if (!M.gem) {
        M.gem = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92, toneMapped: false });
        M.core = new THREE.MeshBasicMaterial({ color: 0xfffbe0, toneMapped: false });
      }
      obj = new THREE.Group();
      const core = new THREE.Mesh(G.core, M.core);
      const gem = new THREE.Mesh(G.gem, M.gem);
      core.renderOrder = 1;
      gem.renderOrder = 2;
      obj.add(core, gem);
      obj.userData.fallback = true;
    }
    // 把模型的中心放在樞紐原點（不管 createItem 的原點在腳底還是中心）
    const box = new THREE.Box3().setFromObject(obj);
    const pivotObj = new THREE.Group();
    if (!box.isEmpty()) obj.position.y -= (box.min.y + box.max.y) / 2;
    pivotObj.add(obj);
    pivotObj.visible = false;
    root.add(pivotObj);
    return pivotObj;
  }

  const crystals = [];
  for (let i = 0; i < TRIAL_COUNT; i++) {
    crystals.push({
      index: i,
      model: makeModel(),
      dir: new THREE.Vector3(0, 1, 0),
      base: PLANET_RADIUS,          // 站立面半徑（地面或平台頂）
      elevated: false,
      baseQuat: new THREE.Quaternion(),
      pos: new THREE.Vector3(),     // 外觀位置（導航 / 雷達用）
      check: new THREE.Vector3(),   // 撿取判定點
      ground: new THREE.Vector3(),  // 光環位置
      phase: 0,
      collected: false,
      anim: -1,                     // 收集動畫進度（-1 = 沒有）
      target: null,
      radar: null,
    });
  }
  for (const c of crystals) {
    c.target = { position: c.pos, label: LABEL };
    c.radar = { position: c.pos, kind: 'trial' };
  }

  // ---- 狀態 ----
  let state = 'idle';     // 'idle' | 'countdown' | 'running' | 'finishing' | 'result'
  let runId = 0;
  let elapsed = 0;
  let found = 0;
  let finishTimer = 0;
  let best = null;        // 秒
  let bestMedal = null;
  let seedCounter = 0;
  const timerState = { time: 0, best: null, found: 0, total: TRIAL_COUNT };

  const api = {
    active: false,
    onFinish: null,
    start,
    cancel,
    update,
    getNavTarget,
    getRadarPoints,
    getBest: () => best,
    getBestMedal: () => bestMedal,
    get bestMedal() { return bestMedal; },
    get state() { return state; },
    get time() { return elapsed; },
    get found() { return found; },
    get total() { return TRIAL_COUNT; },
    getSaveData,
    loadSaveData,
    dispose,
    _debug: { crystals, root, beamMesh, ringMesh, placeCrystals: (seed) => placeCrystals(seed) },
  };

  // ==================================================================
  // 擺放
  // ==================================================================
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _r = new THREE.Vector3();
  const _f = new THREE.Vector3();
  const _cand = new THREE.Vector3();
  const _best = new THREE.Vector3();
  const _playerDir = new THREE.Vector3();
  const startDir = (() => {
    try { return biomeCenters(getBiomeById(START_BIOME))[0]; } catch { return new THREE.Vector3(0, 0.25, 1).normalize(); }
  })();

  const groundR = (dir) => {
    const r = safe(() => world.getGroundRadius(dir));
    return Number.isFinite(r) ? r : PLANET_RADIUS;
  };
  const toVec = (v) => (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? v : null);

  /** 已放的晶石中，與 p（世界座標）最近的距離 */
  function minDistTo(p, count) {
    let m = Infinity;
    for (let i = 0; i < count; i++) {
      const d = crystals[i].pos.distanceTo(p);
      if (d < m) m = d;
    }
    return m;
  }
  /** 坡度：四周 0.9 單位的地面高度差 */
  function flatEnough(dir, maxDiff) {
    const { right, forward } = tangentBasis(dir, _r, _f);
    const r0 = groundR(dir);
    const a = 0.9 / r0;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      _b.copy(dir).addScaledVector(right, Math.cos(ang) * a).addScaledVector(forward, Math.sin(ang) * a).normalize();
      if (Math.abs(groundR(_b) - r0) > maxDiff) return false;
    }
    return true;
  }
  function nearSecret(dir) {
    const list = world && Array.isArray(world.secretSpots) ? world.secretSpots : null;
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i] && toVec(list[i].position);
      if (!p) continue;
      _b.copy(p).normalize();
      if (angleBetweenDirs(dir, _b) * PLANET_RADIUS < 2.5) return true;
    }
    return false;
  }

  function setCrystal(c, dir, base, elevated, rng) {
    c.dir.copy(dir).normalize();
    c.base = base;
    c.elevated = elevated;
    c.baseQuat.setFromUnitVectors(Y_AXIS, c.dir);
    c.pos.copy(c.dir).multiplyScalar(base + HOVER);
    c.check.copy(c.dir).multiplyScalar(base + CHECK);
    let wet = false;
    if (!elevated) wet = !!safe(() => world.isWater(c.dir));
    c.ground.copy(c.dir).multiplyScalar((wet ? Math.max(base, SEA_LEVEL) : base) + 0.07);
    c.phase = rng() * Math.PI * 2;
    c.collected = false;
    c.anim = -1;
  }

  /** 挑選所有位置（確定性：同一個 seed 得到同樣的配置，前提是玩家位置相同） */
  function placeCrystals(seed) {
    const rng = mulberry32(seed >>> 0);
    const ppos = player && player.position && toVec(player.position) ? player.position : null;
    if (ppos) _playerDir.copy(ppos).normalize(); else _playerDir.copy(startDir);
    let count = 0;

    // (1) 平台挑戰上：隨機挑不同的挑戰，取 goal 或 spots 其中一點
    const chs = (world && Array.isArray(world.challenges) ? world.challenges : []).filter((ch) => ch && (toVec(ch.goal) || (Array.isArray(ch.spots) && ch.spots.length)));
    const order = chs.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    for (let oi = 0; oi < order.length && count < Math.min(ELEVATED, TRIAL_COUNT); oi++) {
      const ch = chs[order[oi]];
      const pts = [];
      if (toVec(ch.goal)) pts.push(ch.goal);
      if (Array.isArray(ch.spots)) for (const s of ch.spots) if (toVec(s)) pts.push(s);
      if (!pts.length) continue;
      // 從隨機一點開始找一個合格的
      const k0 = Math.floor(rng() * pts.length);
      for (let k = 0; k < pts.length; k++) {
        const p = pts[(k0 + k) % pts.length];
        const len = p.length();
        if (!(len > 1)) continue;
        _a.copy(p).divideScalar(len);
        // 站立面 = 該點下方最高的平台頂面
        let base = safe(() => world.getSupportRadius ? world.getSupportRadius(_a, len) : NaN);
        if (!Number.isFinite(base) || base > len) base = len - 0.5;
        _cand.copy(_a).multiplyScalar(base + HOVER);
        if (ppos && _cand.distanceTo(ppos) < 5) continue;
        if (minDistTo(_cand, count) < MIN_SPACING) continue;
        setCrystal(crystals[count], _a, base, true, rng);
        count++;
        break;
      }
    }

    // (2) 其餘散在星球各處的陸地 / 淺水（best-candidate 取樣 → 分布均勻但仍隨機）
    const levels = [
      { spacing: MIN_SPACING, startA: START_ANGLE, flat: 0.6, clear: 1.2, tries: 900 },
      { spacing: MIN_SPACING, startA: START_ANGLE, flat: 1.0, clear: 0.9, tries: 900 },
      { spacing: 6, startA: 0.2, flat: 1.6, clear: 0.7, tries: 1200 },
      { spacing: 4, startA: 0.1, flat: 99, clear: 0.5, tries: 1500 },
    ];
    const PICK_K = 7;
    for (let li = 0; li < levels.length && count < TRIAL_COUNT; li++) {
      const L = levels[li];
      let tries = 0;
      while (count < TRIAL_COUNT && tries < L.tries) {
        let got = 0, bestScore = -1;
        while (got < PICK_K && tries < L.tries) {
          tries++;
          randomUnitVector(rng, _cand);
          if (angleBetweenDirs(_cand, startDir) < L.startA) continue;
          if (!safe(() => world.isFree(_cand, L.clear))) continue;
          const base = groundR(_cand);
          _a.copy(_cand).multiplyScalar(base + HOVER);
          if (ppos && _a.distanceTo(ppos) < PLAYER_MIN * (L.spacing / MIN_SPACING)) continue;
          const md = minDistTo(_a, count);
          if (md < L.spacing) continue;
          if (L.flat < 50 && !flatEnough(_cand, L.flat)) continue;
          if (nearSecret(_cand)) continue;
          got++;
          // 分數：與其他晶石的最小距離（偏好分散）；加一點亂數避免總是最遠
          const score = Math.min(md, 60) * (0.75 + rng() * 0.5);
          if (score > bestScore) { bestScore = score; _best.copy(_cand); }
        }
        if (bestScore < 0) break;
        setCrystal(crystals[count], _best, groundR(_best), false, rng);
        count++;
      }
    }
    // 最後的保險（幾乎不可能用到）：起點附近
    while (count < TRIAL_COUNT) {
      randomUnitVector(rng, _cand);
      _cand.multiplyScalar(0.25).add(startDir).normalize();
      setCrystal(crystals[count], _cand, groundR(_cand), false, rng);
      count++;
    }
    return crystals;
  }

  // ==================================================================
  // 流程
  // ==================================================================
  function pushTimer() {
    timerState.time = elapsed;
    timerState.best = best;
    timerState.found = found;
    timerState.total = TRIAL_COUNT;
    safe(() => ui && ui.setTimer && ui.setTimer(timerState));
  }

  function hideAll() {
    for (const c of crystals) c.model.visible = false;
    root.visible = false;
  }

  async function start(seed) {
    let s = Number(seed);
    if (seed === undefined || seed === null || !Number.isFinite(s)) {
      seedCounter++;
      s = (Date.now() ^ Math.imul(seedCounter, 0x9e3779b1)) >>> 0;
    }
    const id = ++runId;
    placeCrystals(s);
    elapsed = 0;
    found = 0;
    finishTimer = 0;
    state = 'countdown';
    api.active = true;
    api.seed = s >>> 0;
    root.visible = true;
    for (const c of crystals) c.model.visible = true;
    update(0, 0);
    pushTimer();
    if (ui && typeof ui.showCountdown === 'function') {
      try { await ui.showCountdown(); } catch (e) { console.warn('[timetrial] showCountdown', e); }
    }
    if (id !== runId || state !== 'countdown') return; // 倒數期間被取消
    play('go');
    state = 'running';
    pushTimer();
  }

  function cancel() {
    runId++;
    state = 'idle';
    api.active = false;
    hideAll();
    safe(() => ui && ui.setTimer && ui.setTimer(null));
  }

  async function finish() {
    const id = runId;
    state = 'result';
    api.active = false;
    hideAll();
    const time = Math.round(elapsed * 100) / 100;
    const medal = medalFor(time);
    const newRecord = best === null || time < best;
    if (newRecord) best = time;
    if (rankOf(medal) > rankOf(bestMedal)) bestMedal = medal;
    safe(() => ui && ui.setTimer && ui.setTimer(null));
    play('trialEnd');
    let choice = 'exit';
    if (ui && typeof ui.showTrialResult === 'function') {
      try {
        const r = await ui.showTrialResult({ time, best, medal, newRecord });
        if (r === 'retry') choice = 'retry';
      } catch (e) { console.warn('[timetrial] showTrialResult', e); }
    }
    if (id !== runId) return; // 結果視窗開著時被取消（例如重新開始遊戲）
    state = 'idle';
    if (typeof api.onFinish === 'function') {
      safe(() => api.onFinish({ time, best, medal, newRecord, choice }));
    }
    if (choice === 'retry' && id === runId && state === 'idle') start();
  }

  function collect(c) {
    c.collected = true;
    c.anim = 0;
    found++;
    safe(() => effects && effects.burst && effects.burst(c.pos, GOLD, 34));
    safe(() => effects && effects.ring && effects.ring(c.ground, c.dir, GOLD));
    play('collect');
    if (found === TRIAL_COUNT - 1) safe(() => ui && ui.toast && ui.toast('只剩最後一顆！', 1600));
    if (found >= TRIAL_COUNT) {
      state = 'finishing';
      finishTimer = FINISH_DELAY;
    }
  }

  // ==================================================================
  // 每幀
  // ==================================================================
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const R2 = PICKUP_RADIUS * PICKUP_RADIUS;
  let clock = 0;

  function update(dt, t) {
    if (state === 'idle' || state === 'result') return;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.25) dt = 0.25;
    clock = Number.isFinite(t) && t > 0 ? t : clock + dt;
    const tt = clock;
    if (state === 'running') elapsed += dt;
    const ppos = player && player.position;
    const canCollect = state === 'running' && ppos;

    for (let i = 0; i < TRIAL_COUNT; i++) {
      const c = crystals[i];
      if (c.collected) {
        if (c.anim < 0) continue;
        c.anim += dt / COLLECT_TIME;
        const a = Math.min(1, c.anim);
        if (a >= 1) {
          c.anim = -1;
          c.model.visible = false;
          beamMesh.setMatrixAt(i, _zero);
          ringMesh.setMatrixAt(i, _zero);
          continue;
        }
        const s = (1 + Math.sin(a * Math.PI) * 0.6) * (1 - a * a);
        _q.setFromAxisAngle(Y_AXIS, tt * 1.4 + c.phase + a * 10);
        c.model.quaternion.copy(c.baseQuat).multiply(_q);
        c.model.position.copy(c.dir).multiplyScalar(c.base + HOVER + a * 1.1);
        c.model.scale.setScalar(Math.max(1e-3, s));
        _m.compose(_v.copy(c.dir).multiplyScalar(c.base + BEAM_BASE), c.baseQuat, _s.set(1 - a, 1 + a * 0.3, 1 - a));
        beamMesh.setMatrixAt(i, _m);
        _m.compose(c.ground, c.baseQuat, _s.set(1 + a * 1.8, 1, 1 + a * 1.8));
        ringMesh.setMatrixAt(i, _m);
        continue;
      }
      // 旋轉 + 上下浮動
      const bob = Math.sin(tt * 2.1 + c.phase) * 0.15;
      c.pos.copy(c.dir).multiplyScalar(c.base + HOVER + bob);
      c.model.position.copy(c.pos);
      _q.setFromAxisAngle(Y_AXIS, tt * 1.4 + c.phase);
      c.model.quaternion.copy(c.baseQuat).multiply(_q);
      const pulse = 1 + Math.sin(tt * 3.2 + c.phase) * 0.06;
      c.model.scale.setScalar(pulse);
      // 光柱：靠近時淡出（遠處是醒目的指標）
      let k = 1;
      if (ppos) {
        const d = Math.sqrt(c.check.distanceToSquared(ppos));
        const near = clamp((d - 3) / 13, 0, 1);
        k = 0.14 + 0.86 * near * near * (3 - 2 * near);
      }
      k *= 0.9 + 0.1 * Math.sin(tt * 2.6 + c.phase);
      beamMesh.setColorAt(i, _col.setRGB(k, k, k));
      _m.compose(_v.copy(c.dir).multiplyScalar(c.base + BEAM_BASE), c.baseQuat, _s.set(1, 1, 1));
      beamMesh.setMatrixAt(i, _m);
      const rp = 1 + Math.sin(tt * 2.4 + c.phase) * 0.1;
      _q2.setFromAxisAngle(Y_AXIS, -tt * 0.8);
      _q.copy(c.baseQuat).multiply(_q2);
      _m.compose(c.ground, _q, _s.set(rp, 1, rp));
      ringMesh.setMatrixAt(i, _m);
      if (canCollect && c.check.distanceToSquared(ppos) < R2) collect(c);
    }
    beamMesh.instanceMatrix.needsUpdate = true;
    ringMesh.instanceMatrix.needsUpdate = true;
    if (beamMesh.instanceColor) beamMesh.instanceColor.needsUpdate = true;

    if (state === 'finishing') {
      finishTimer -= dt;
      if (finishTimer <= 0) { finish(); return; }
    }
    if (state === 'running' || state === 'countdown') pushTimer();
  }

  // ==================================================================
  // 導航 / 雷達
  // ==================================================================
  function getNavTarget() {
    if (!api.active || state === 'finishing') return null;
    const ppos = player && player.position;
    let bestC = null, bestD = Infinity;
    for (let i = 0; i < TRIAL_COUNT; i++) {
      const c = crystals[i];
      if (c.collected) continue;
      const d = ppos ? c.pos.distanceToSquared(ppos) : i;
      if (d < bestD) { bestD = d; bestC = c; }
    }
    return bestC ? bestC.target : null;
  }

  function getRadarPoints(out) {
    if (!out) out = [];
    if (!api.active) return out;
    for (let i = 0; i < TRIAL_COUNT; i++) {
      if (!crystals[i].collected) out.push(crystals[i].radar);
    }
    return out;
  }

  // ==================================================================
  // 存檔：只存最佳時間與最佳獎牌
  // ==================================================================
  function getSaveData() {
    return { best, medal: bestMedal };
  }
  function loadSaveData(d) {
    if (!d || typeof d !== 'object') return;
    const b = Number(d.best);
    if (d.best !== null && d.best !== undefined && Number.isFinite(b) && b > 0 && b < 1e6) best = b;
    else best = null;
    let m = MEDAL_RANK[d.medal] ? d.medal : null;
    if (rankOf(medalFor(best)) > rankOf(m)) m = medalFor(best);
    bestMedal = m;
  }

  function dispose() {
    cancel();
    root.removeFromParent();
    beamMesh.dispose();
    ringMesh.dispose();
    M.beam.dispose();
    M.ring.dispose();
    if (M.gem) { M.gem.dispose(); M.core.dispose(); }
  }

  return api;
}
