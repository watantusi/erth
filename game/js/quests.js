// 分身 4：任務居民與任務邏輯（v2）。由 gameplay.js 建立（模組內部 API，不是對外合約）。
// 模型來自 characters.js（分身 2）；放置、移動、跟隨、計時都在這裡。
import * as THREE from 'three';
import { INTERACT_RADIUS, ICE_MELT_TIME, VOLCANO_TIME, WORLD_SEED } from './config.js';
import {
  mulberry32, randomDirNear, angleBetweenDirs, getBiomeById, biomeCenters, clamp, tangentBasis,
} from './utils.js';
import { createCharacter, createItem } from './characters.js';
import { QUESTS, QUEST_ORDER, CHOICES, QUEST_MESSAGES } from './content.js';

const TOUCH_R = 1.35;          // 碰到小雞/企鵝寶寶
const PICK_R = 1.5;            // 撿松果/海星/冰、踩量測點
const FOLLOW_GAP = 0.8;        // 跟隨隊伍間距
const FOLLOW_FIRST = 1.05;     // 第一隻離玩家的距離
const HOME_R = 2.6;            // 雞舍門口判定
const MOM_R = INTERACT_RADIUS + 0.6;
const CULL_DIST = 40;          // 居民：太遠就不畫、不更新動畫（頭上標記另外看 MARK_DIST）
const CULL_SMALL = 30;         // 小雞、道具：更近才畫（模型由多個 mesh 組成，省 draw call）
const MARK_DIST = 60;
const DONE_SHOW = 5;           // 完成後在任務列表顯示幾秒
const PATH_N = 128;
const NPC_COLORS = {
  sheepElder: 0xf4f1ea, squirrel: 0xc8814a, camel: 0xd9b07a, penguinMom: 0x2f3b52,
  penguinChick: 0x9aa6bf, chick: 0xffd84a, geoBot: 0x8fa3bf, turtle: 0x6fbf73,
};
const ITEM_COLORS = { pinecone: 0x9a6b43, starfish: 0xffb36b, mapFragment: 0xf2e2b6, stationFlag: 0xff6a3d, iceBlock: 0xbfe9ff };

// ---------------------------------------------------------------------------
// 備用模型（characters.js 回傳不完整或丟例外時才用；共用幾何與材質）
// ---------------------------------------------------------------------------
let FB = null;
function fallbackShared() {
  if (FB) return FB;
  FB = {
    body: new THREE.SphereGeometry(0.4, 12, 9),
    head: new THREE.SphereGeometry(0.26, 10, 8),
    item: new THREE.OctahedronGeometry(0.25, 0),
    mats: {},
  };
  return FB;
}
function fbMat(color) {
  const S = fallbackShared();
  if (!S.mats[color]) S.mats[color] = new THREE.MeshLambertMaterial({ color, flatShading: true });
  return S.mats[color];
}
function fallbackCharacter(kind) {
  const S = fallbackShared();
  const small = kind === 'chick' || kind === 'penguinChick';
  const g = new THREE.Group();
  const s = small ? 0.5 : 1;
  const body = new THREE.Mesh(S.body, fbMat(NPC_COLORS[kind] || 0xffffff));
  body.position.y = 0.4 * s; body.scale.setScalar(s);
  const head = new THREE.Mesh(S.head, fbMat(NPC_COLORS[kind] || 0xffffff));
  head.position.set(0, 0.95 * s, 0.12 * s); head.scale.setScalar(s);
  g.add(body, head);
  return { object: g, update() {}, setHappy() {}, headHeight: 1.25 * s };
}
function fallbackItem(kind) {
  const m = new THREE.Mesh(fallbackShared().item, fbMat(ITEM_COLORS[kind] || 0xffffff));
  m.position.y = 0.3;
  const g = new THREE.Group();
  g.add(m);
  return g;
}
function makeCharacter(kind) {
  try {
    const c = createCharacter(kind);
    if (c && c.object) {
      if (typeof c.update !== 'function') c.update = () => {};
      if (typeof c.setHappy !== 'function') c.setHappy = () => {};
      if (!(c.headHeight > 0)) c.headHeight = 1.2;
      return c;
    }
  } catch (e) { console.warn('[quests] createCharacter 失敗，改用備用模型', kind, e); }
  return fallbackCharacter(kind);
}
function makeItem(kind) {
  try {
    const o = createItem(kind);
    if (o && o.isObject3D) return o;
  } catch (e) { console.warn('[quests] createItem 失敗，改用備用模型', kind, e); }
  return fallbackItem(kind);
}

// ---------------------------------------------------------------------------
// 頭上標記（! = 有新任務、✓ = 可以回報）與量測點號碼：程式繪製的小貼圖
// ---------------------------------------------------------------------------
function bubbleTexture(fill, draw) {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath(); ctx.arc(S / 2 + 1.5, S / 2 + 2.5, 27, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = fill;
  ctx.beginPath(); ctx.arc(S / 2, S / 2, 27, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  draw(ctx, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function makeMarkerMaterials() {
  const exclaim = bubbleTexture('#ffcf3a', (ctx, S) => {
    ctx.fillStyle = '#5a3b00';
    ctx.beginPath();
    ctx.moveTo(S / 2 - 6, 14); ctx.lineTo(S / 2 + 6, 14); ctx.lineTo(S / 2 + 3.5, 39); ctx.lineTo(S / 2 - 3.5, 39);
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(S / 2, 47, 4.6, 0, Math.PI * 2); ctx.fill();
  });
  const check = bubbleTexture('#5ccf6a', (ctx, S) => {
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(S * 0.3, S * 0.52); ctx.lineTo(S * 0.45, S * 0.67); ctx.lineTo(S * 0.72, S * 0.36); ctx.stroke();
  });
  const mk = (map) => new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false });
  const digits = [1, 2, 3].map((n) => mk(bubbleTexture('#ff7a45', (ctx, S) => {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 38px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(n), S / 2, S / 2 + 2);
  })));
  return { exclaim: mk(exclaim), check: mk(check), digits, done: mk(check) };
}

// ===========================================================================
export function createQuests({ scene, world, player, ui, audio, effects, onFragment, avoid = [], avoidZones = [] }) {
  const root = new THREE.Group();
  root.name = 'quests';
  scene.add(root);

  const safe = (fn) => { try { return fn(); } catch (e) { console.warn('[quests]', e); return undefined; } };
  const play = (name) => safe(() => audio && audio.play(name));
  const toast = (text, ms) => safe(() => ui && ui.toast(text, ms));

  // ---- 暫存（避免每幀配置） ----
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _f = new THREE.Vector3();
  const _r = new THREE.Vector3();
  const _mb = new THREE.Matrix4();
  const _alt = new THREE.Vector3(1, 0, 0);
  const _alt2 = new THREE.Vector3(0, 0, 1);

  /** 不配置記憶體的 placeOnSphere：+Y = dir、+Z = facing（投影到切平面） */
  function placeFast(obj, dir, radius, facing) {
    _up.copy(dir).normalize();
    obj.position.copy(_up).multiplyScalar(radius);
    if (facing) _f.copy(facing); else _f.set(0, 0, 0);
    _f.addScaledVector(_up, -_f.dot(_up));
    if (_f.lengthSq() < 1e-8) {
      _f.copy(Math.abs(_up.x) < 0.9 ? _alt : _alt2);
      _f.addScaledVector(_up, -_f.dot(_up));
    }
    _f.normalize();
    _r.crossVectors(_up, _f).normalize();
    _mb.makeBasis(_r, _up, _f);
    obj.quaternion.setFromRotationMatrix(_mb);
  }

  const groundR = (dir) => world.getGroundRadius(dir);
  /** questSpots / challenges 的點：世界座標；若長度很小就當作方向，放到地表 */
  function toPoint(v) {
    if (!v || typeof v.x !== 'number') return null;
    const p = new THREE.Vector3(v.x, v.y, v.z);
    const len = p.length();
    if (!(len > 1e-6)) return null;
    if (len < 5) { p.normalize(); p.multiplyScalar(groundR(p)); }
    return p;
  }

  // =========================================================================
  // 確定性擺放
  // =========================================================================
  const rng = mulberry32(WORLD_SEED + 6006);
  const taken = avoid.map((d) => d.clone().normalize()); // 已被佔用的方向
  const challengeOf = (biomeId) => (Array.isArray(world.challenges) ? world.challenges.find((c) => c && c.biome === biomeId) : null) || null;
  const qs = world.questSpots || {};
  const platforms = Array.isArray(world.platforms) ? world.platforms : [];

  function nearPlatform(dir, clearance) {
    for (let i = 0; i < platforms.length; i++) {
      const p = platforms[i];
      if (!p || !p.dir) continue;
      const lim = ((p.radius || 1) + clearance) / 30;
      if (angleBetweenDirs(dir, p.dir) < lim) return true;
    }
    return false;
  }
  // v4：地形知識牌等禁區（{ dir, dist }：dist = 球面距離，世界單位）
  const zones = (Array.isArray(avoidZones) ? avoidZones : []).filter((z) => z && z.dir && z.dist > 0)
    .map((z) => ({ dir: z.dir.clone().normalize(), dist: z.dist }));
  function inZone(dir, extra = 0) {
    for (let i = 0; i < zones.length; i++) if (angleBetweenDirs(dir, zones[i].dir) * 30 < zones[i].dist + extra) return true;
    return false;
  }
  function spacingOk(dir, minDist) {
    for (const t of taken) if (angleBetweenDirs(dir, t) * 30 < minDist) return false;
    return true;
  }
  /** 在 center 附近找空地（不在水裡、沒有障礙物、不壓到平台），逐步放寬 */
  function findGround(center, { minA = 0.05, maxA = 0.35, biome = null, clearance = 0.9, minDist = 2.4, wade = false } = {}) {
    const out = new THREE.Vector3();
    let fallback = null;
    for (let i = 0; i < 360; i++) {
      const phase = Math.floor(i / 60);
      randomDirNear(center, maxA * (1 + phase * 0.25), rng, out);
      if (phase < 4 && angleBetweenDirs(out, center) < minA) continue;
      let ok = true;
      try {
        if (!wade && world.isWater(out)) ok = false;
        else if (phase < 5 && !world.isFree(out, clearance)) ok = false;
        else if (phase < 3 && biome && world.getBiome(out).id !== biome) ok = false;
        else if (phase < 5 && nearPlatform(out, clearance + 0.4)) ok = false;
        else if (phase < 5 && inZone(out, clearance * 0.5)) ok = false;
      } catch { ok = false; }
      if (!ok) continue;
      if (!fallback) fallback = out.clone();
      if (!spacingOk(out, phase < 4 ? minDist : minDist * 0.5)) continue;
      const d = out.clone();
      taken.push(d);
      return d;
    }
    const d = fallback || center.clone().normalize();
    taken.push(d);
    return d;
  }
  const centerOf = (biomeId, near = null) => {
    const cs = biomeCenters(getBiomeById(biomeId));
    if (!near) return cs[0];
    let best = cs[0], bd = -2;
    for (const c of cs) { const d = c.dot(near); if (d > bd) { bd = d; best = c; } }
    return best;
  };
  /** 平台挑戰上的點，依高度排序（低 → 高） */
  function sortedSpots(biomeId) {
    const ch = challengeOf(biomeId);
    if (!ch || !Array.isArray(ch.spots)) return [];
    return ch.spots.map(toPoint).filter(Boolean).sort((a, b) => a.length() - b.length());
  }
  /** 從排序好的點裡平均挑 n 個（盡量包含最高點） */
  function spreadPick(arr, n) {
    if (arr.length <= n) return arr.slice();
    const out = [];
    for (let i = 0; i < n; i++) out.push(arr[Math.round((i / Math.max(1, n - 1)) * (arr.length - 1))]);
    return out;
  }
  const groundPoint = (dir) => dir.clone().multiplyScalar(groundR(dir));
  const markTaken = (p) => { if (p) taken.push(p.clone().normalize()); return p; };

  // ---- 居民位置 ----
  const npcPoint = {};
  for (const id of QUEST_ORDER) {
    let p = qs[id] ? toPoint(qs[id].npc) : null;
    if (!p) p = groundPoint(findGround(centerOf(id), { minA: 0.03, maxA: 0.22, biome: id === 'ocean' ? null : id, clearance: 1.4, minDist: 4, wade: id === 'ocean' }));
    else markTaken(p);
    npcPoint[id] = p;
  }
  const homePoint = (qs.meadow && toPoint(qs.meadow.home)) || groundPoint(findGround(npcPoint.meadow.clone().normalize(), { minA: 0.06, maxA: 0.15, biome: 'meadow', clearance: 1.2 }));
  markTaken(homePoint);
  const icePoint = (qs.polar && toPoint(qs.polar.ice)) || groundPoint(findGround(centerOf('polar'), { minA: 0.05, maxA: 0.25, biome: 'polar', clearance: 1.2 }));
  markTaken(icePoint);

  // ---- 小雞（1 隻在草原平台上，其餘在草原／森林交界） ----
  const chickPoints = [];
  {
    const spots = sortedSpots('meadow');
    if (spots.length) chickPoints.push(markTaken(spots[spots.length - 1].clone()));
    const m = centerOf('meadow'), f = centerOf('forest');
    let tries = 0;
    while (chickPoints.length < 3) {
      const t = 0.42 + ((chickPoints.length + tries) % 3) * 0.07;
      _v.copy(m).lerp(f, t).normalize();
      const d = findGround(_v.clone(), { minA: 0.0, maxA: 0.1, clearance: 0.8, minDist: 5 });
      chickPoints.push(groundPoint(d));
      tries++;
    }
  }
  // ---- 松果（≥2 在森林平台上，其餘在森林地面） ----
  const pinePoints = [];
  {
    const spots = spreadPick(sortedSpots('forest').reverse(), 2);
    for (const s of spots) pinePoints.push(markTaken(s.clone()));
    while (pinePoints.length < QUESTS.forest.need) {
      const d = findGround(centerOf('forest'), { minA: 0.06, maxA: 0.32, biome: 'forest', clearance: 0.7, minDist: 4 });
      pinePoints.push(groundPoint(d));
    }
  }
  // ---- 企鵝寶寶（1 隻在極地平台最高處；1 隻在冰屋後面；1 隻在冰柱／障礙物之間） ----
  const penguinPoints = [];
  {
    const momDir = npcPoint.polar.clone().normalize();
    const pc = centerOf('polar', momDir);
    const spots = sortedSpots('polar');
    if (spots.length) penguinPoints.push(markTaken(spots[spots.length - 1].clone()));
    const obs = Array.isArray(world.obstacles) ? world.obstacles : [];
    const tryHidden = (pos, radius, awayFrom) => {
      // 在障礙物「背對 awayFrom」那一側找空位
      const up = pos.clone().normalize();
      const away = pos.clone().sub(awayFrom); away.addScaledVector(up, -away.dot(up));
      if (away.lengthSq() < 1e-6) tangentBasis(up, away, _v2);
      away.normalize();
      for (let k = 0; k < 8; k++) {
        const ang = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.45;
        const dirT = away.clone().applyAxisAngle(up, ang);
        const p = pos.clone().addScaledVector(dirT, radius + 0.75).normalize();
        try {
          if (world.isWater(p) || !world.isFree(p, 0.3) || nearPlatform(p, 0.6) || inZone(p) || !spacingOk(p, 2.5)) continue;
        } catch { continue; }
        taken.push(p.clone());
        return groundPoint(p);
      }
      return null;
    };
    // 冰屋
    const igloo = world.landmarks && world.landmarks.igloo;
    if (igloo && penguinPoints.length < 3) {
      const iDir = igloo.clone().normalize();
      let best = null, bd = 1e9;
      for (const o of obs) {
        if (!o || !o.position) continue;
        const d = angleBetweenDirs(o.position.clone().normalize(), iDir) * 30;
        if (d < bd) { bd = d; best = o; }
      }
      const pos = best && bd < 3 ? best.position : groundPoint(iDir);
      const p = tryHidden(pos, best && bd < 3 ? best.radius : 1.5, npcPoint.polar);
      if (p) penguinPoints.push(p);
    }
    // 兩個靠近的障礙物之間（冰柱、岩石）
    if (penguinPoints.length < 3) {
      const polarObs = obs.filter((o) => o && o.position && angleBetweenDirs(o.position.clone().normalize(), pc) < 0.5);
      let found = null;
      outer: for (let i = 0; i < polarObs.length; i++) {
        for (let j = i + 1; j < polarObs.length; j++) {
          const a = polarObs[i], b = polarObs[j];
          const gap = a.position.distanceTo(b.position) - a.radius - b.radius;
          if (gap < 0.9 || gap > 3.5) continue;
          const mid = a.position.clone().add(b.position).multiplyScalar(0.5).normalize();
          try {
            if (world.isWater(mid) || nearPlatform(mid, 0.6) || inZone(mid) || !spacingOk(mid, 3)) continue;
            if (angleBetweenDirs(mid, momDir) * 30 < 6) continue;
          } catch { continue; }
          found = mid; break outer;
        }
      }
      if (found) { taken.push(found.clone()); penguinPoints.push(groundPoint(found)); }
    }
    while (penguinPoints.length < 3) {
      const d = findGround(pc, { minA: 0.1, maxA: 0.4, biome: 'polar', clearance: 0.8, minDist: 6 });
      penguinPoints.push(groundPoint(d));
    }
  }
  // ---- 量測點（火山平台上，由低到高） ----
  const stationPoints = [];
  {
    const spots = spreadPick(sortedSpots('volcano'), 3);
    for (const s of spots) stationPoints.push(markTaken(s.clone()));
    while (stationPoints.length < 3) {
      const d = findGround(centerOf('volcano'), { minA: 0.15, maxA: 0.35, clearance: 0.8, minDist: 5 });
      stationPoints.push(groundPoint(d));
    }
  }
  // ---- 發光海星（海上踏石與海蝕柱上） ----
  const starPoints = [];
  {
    const spots = spreadPick(sortedSpots('ocean'), 3);
    for (const s of spots) starPoints.push(markTaken(s.clone()));
    while (starPoints.length < 3) {
      const d = findGround(npcPoint.ocean.clone().normalize(), { minA: 0.08, maxA: 0.3, clearance: 0.6, minDist: 5, wade: true });
      starPoints.push(groundPoint(d));
    }
  }

  // =========================================================================
  // 建立居民、物品
  // =========================================================================
  const MK = makeMarkerMaterials();
  const npcs = {};
  const quests = {};
  const radarNpc = [];

  for (const id of QUEST_ORDER) {
    const def = QUESTS[id];
    const p = npcPoint[id];
    const dir = p.clone().normalize();
    const ch = makeCharacter(def.npc);
    root.add(ch.object);
    // 預設面向：朝向該生態區中心（或任意切線）
    const base = new THREE.Vector3();
    _v.copy(centerOf(id, dir)).sub(dir);
    base.copy(_v).addScaledVector(dir, -_v.dot(dir));
    if (base.lengthSq() < 1e-6) tangentBasis(dir, _v2, base);
    base.normalize();
    const marker = new THREE.Sprite(MK.exclaim);
    marker.scale.set(0.75, 0.75, 0.75);
    marker.renderOrder = 6;
    root.add(marker);
    const npc = {
      id, def, ch, pos: p.clone(), dir, r: p.length(), facing: base.clone(), base,
      head: new THREE.Vector3(), marker, near: false, dist: 1e9, visible: true,
      replyTimer: -1, replyEmoji: '', hop: 0, getHead: null,
      radar: { position: p.clone(), kind: 'npc' },
      target: { position: p.clone(), label: QUEST_MESSAGES.talkTo(def.name), urgent: false },
    };
    npc.head.copy(dir).multiplyScalar(npc.r + ch.headHeight);
    npc.getHead = (out) => (out ? out.copy(npc.head) : npc.head);
    placeFast(ch.object, dir, npc.r, base);
    npcs[id] = npc;
    radarNpc.push(npc.radar);
    quests[id] = {
      id, def, npc, status: 'idle', introSeen: false, doneShow: 0, preHintCd: 0,
      items: [], delivered: 0, got: 0,
      // 冰
      carrying: false, iceTime: 0, lastSec: -1,
      // 量測
      running: false, next: 0, timer: 0,
    };
  }

  // ---- 跟隨者（小雞、企鵝寶寶） ----
  function makeFollower(q, kind, point, index, label) {
    const ch = makeCharacter(kind);
    root.add(ch.object);
    const dir = point.clone().normalize();
    const f = {
      q, kind: 'follower', index, ch, spawn: point.clone(), spawnDir: dir, pos: point.clone(), dir: dir.clone(),
      state: 'wait', slot: 0, hop: rng() * 6, moveSpeed: 0, anim: 0, from: new THREE.Vector3(), to: new THREE.Vector3(),
      facing: new THREE.Vector3(), idleT: rng() * 3,
      radar: { position: point.clone(), kind: 'quest' },
      target: { position: point.clone(), label, urgent: false },
    };
    tangentBasis(dir, _v2, f.facing);
    f.facing.applyAxisAngle(dir, rng() * Math.PI * 2);
    placeFast(ch.object, dir, point.length(), f.facing);
    return f;
  }
  chickPoints.forEach((p, i) => quests.meadow.items.push(makeFollower(quests.meadow, 'chick', p, i, QUESTS.meadow.itemLabel)));
  penguinPoints.forEach((p, i) => quests.polar.items.push(makeFollower(quests.polar, 'penguinChick', p, i, QUESTS.polar.itemLabel)));

  // ---- 撿拾物（松果、海星） ----
  function makePickup(q, kind, point, index, label) {
    const obj = makeItem(kind);
    root.add(obj);
    const dir = point.clone().normalize();
    const it = {
      q, kind: 'pickup', index, obj, pos: point.clone(), dir, r: point.length(), collected: false,
      phase: rng() * Math.PI * 2, facing: new THREE.Vector3(),
      radar: { position: point.clone(), kind: 'quest' },
      target: { position: point.clone(), label, urgent: false },
    };
    tangentBasis(dir, _v2, it.facing);
    placeFast(obj, dir, it.r, it.facing);
    return it;
  }
  pinePoints.forEach((p, i) => quests.forest.items.push(makePickup(quests.forest, 'pinecone', p, i, QUESTS.forest.itemLabel)));
  starPoints.forEach((p, i) => quests.ocean.items.push(makePickup(quests.ocean, 'starfish', p, i, QUESTS.ocean.itemLabel)));

  // ---- 量測點 ----
  stationPoints.forEach((p, i) => {
    const it = makePickup(quests.volcano, 'stationFlag', p, i, `${i + 1} 號${QUESTS.volcano.itemLabel}`);
    const sp = new THREE.Sprite(MK.digits[i]);
    sp.scale.set(0.6, 0.6, 0.6);
    sp.renderOrder = 6;
    root.add(sp);
    it.label = sp;
    it.done = false;
    quests.volcano.items.push(it);
  });

  // ---- 冰塊（拿冰點） ----
  const ice = (() => {
    const obj = makeItem('iceBlock');
    root.add(obj);
    const dir = icePoint.clone().normalize();
    const facing = new THREE.Vector3();
    tangentBasis(dir, _v2, facing);
    placeFast(obj, dir, icePoint.length(), facing);
    return {
      obj, pos: icePoint.clone(), dir, r: icePoint.length(), facing, phase: 0,
      radar: { position: icePoint.clone(), kind: 'quest' },
      target: { position: icePoint.clone(), label: QUESTS.desert.iceLabel, urgent: false },
    };
  })();

  // ---- 雞舍門口（帶著小雞時的目標） ----
  const homeRadar = { position: homePoint.clone(), kind: 'quest' };
  const homeTarget = { position: homePoint.clone(), label: QUESTS.meadow.homeLabel, urgent: false };

  // =========================================================================
  // 玩家走過的路徑（跟隨者沿著它排隊）
  // =========================================================================
  const path = Array.from({ length: PATH_N }, () => new THREE.Vector3());
  let pathHead = 0, pathCount = 0;
  function recordPath() {
    const p = player.position;
    if (pathCount > 0) {
      const d2 = p.distanceToSquared(path[pathHead]);
      if (d2 < 0.04) return;
      if (d2 > 36) { pathCount = 0; snapFollowers = true; } // 傳送：清空
    }
    pathHead = (pathHead + 1) % PATH_N;
    path[pathHead].copy(p);
    if (pathCount < PATH_N) pathCount++;
  }
  let snapFollowers = false;
  /** 沿著路徑往回 dist 的位置 */
  function pathPoint(dist, out) {
    let prev = player.position;
    let acc = 0;
    for (let k = 0; k < pathCount; k++) {
      const pt = path[(pathHead - k + PATH_N) % PATH_N];
      const seg = prev.distanceTo(pt);
      if (seg > 1e-6 && acc + seg >= dist) return out.copy(prev).lerp(pt, (dist - acc) / seg);
      acc += seg;
      prev = pt;
    }
    // 路徑不夠長：往玩家背後延伸
    out.copy(prev);
    if (acc < dist) {
      _v2.copy(player.forward || _alt).multiplyScalar(-(dist - acc));
      out.add(_v2);
    }
    return out;
  }

  // =========================================================================
  // 任務列表（ui.setQuests）
  // =========================================================================
  let trackerDirty = true;
  const countFollowing = (q) => { let n = 0; for (const f of q.items) if (f.state === 'follow') n++; return n; };
  function progressText(q) {
    const def = q.def;
    if (q.id === 'desert') {
      if (q.carrying) return QUEST_MESSAGES.timeLeft(Math.max(0, Math.ceil(q.iceTime)));
      return '0/1';
    }
    if (q.status === 'ready') return QUEST_MESSAGES.readyProgress;
    if (q.id === 'volcano') {
      if (q.running) return `${QUEST_MESSAGES.timeLeft(Math.max(0, Math.ceil(q.timer)))}・${q.next}/3`;
      return `${q.next}/3`;
    }
    if (q.id === 'meadow' || q.id === 'polar') {
      const fl = countFollowing(q);
      return `${q.delivered}/${def.need}` + (fl ? `（跟著 ${fl}）` : '');
    }
    return `${q.got}/${def.need}`;
  }
  function pushTracker() {
    trackerDirty = false;
    const list = [];
    for (const id of QUEST_ORDER) {
      const q = quests[id];
      if (q.status === 'active' || q.status === 'ready') {
        list.push({ id, icon: q.def.icon, title: q.def.title, progress: progressText(q), state: 'active' });
      } else if (q.status === 'done' && q.doneShow > 0) {
        list.push({ id, icon: q.def.icon, title: q.def.title, progress: '✓', state: 'done' });
      }
    }
    safe(() => ui && ui.setQuests && ui.setQuests(list));
  }

  // =========================================================================
  // 對話
  // =========================================================================
  let dlgToken = 0, dlgBusy = false, dlgBusyTime = 0;
  // v3：計時挑戰中暫停任務（不撿東西、不觸發對話、計時暫停；居民與跟隨者照常動）
  let paused = false;
  const pickLine = (arr) => arr[Math.floor(Math.random() * arr.length) % arr.length];

  function openDialogue(q, mode) {
    const def = q.def;
    let lines, choices = null;
    if (mode === 'intro') {
      lines = def.intro.slice();
      choices = [{ label: CHOICES.yes, value: 'yes' }, { label: CHOICES.no, value: 'no' }];
      q.introSeen = true;
    } else if (mode === 'remind') lines = def.remind({ got: q.id === 'meadow' || q.id === 'polar' ? q.delivered : q.got, need: def.need });
    else if (mode === 'complete') lines = def.complete.slice();
    else lines = [pickLine(def.after)];
    const token = ++dlgToken;
    dlgBusy = true;
    dlgBusyTime = 0;
    play('talk');
    let p = null;
    if (ui && typeof ui.showDialogue === 'function') {
      p = safe(() => ui.showDialogue({ name: def.name, icon: def.icon, lines, choices: choices || undefined }));
    }
    const done = (value) => {
      if (token !== dlgToken) return;
      dlgBusy = false;
      safe(() => afterDialogue(q, mode, value));
    };
    if (p && typeof p.then === 'function') p.then(done, () => done(null));
    else {
      // 沒有對話框（舊版 UI）：用提示訊息代替，直接接下任務
      toast(mode === 'intro' ? lines[1] || lines[0] : lines[lines.length - 1], 3600);
      done(choices ? 'yes' : null);
    }
  }
  function afterDialogue(q, mode, value) {
    if (mode === 'intro') {
      if (value === 'yes') accept(q);
      else toast(q.def.later[0], 2600);
    } else if (mode === 'complete') finish(q);
  }
  function accept(q) {
    if (q.status !== 'idle') return;
    q.status = 'active';
    play('quest');
    toast(q.def.accept, 2800);
    trackerDirty = true;
    checkReady(q, true);
  }
  function setReady(q, silent) {
    if (q.status !== 'active') return;
    q.status = 'ready';
    trackerDirty = true;
    if (!silent) { play('quest'); toast(QUEST_MESSAGES.ready(q.def.name), 2800); }
  }
  function checkReady(q, silent) {
    if (q.status !== 'active') return;
    const need = q.def.need;
    if ((q.id === 'meadow' || q.id === 'polar') && q.delivered >= need) setReady(q, silent);
    else if ((q.id === 'forest' || q.id === 'ocean') && q.got >= need) setReady(q, silent);
  }
  function finish(q) {
    if (q.status === 'done') return;
    q.status = 'done';
    q.doneShow = DONE_SHOW;
    trackerDirty = true;
    const npc = q.npc;
    safe(() => npc.ch.setHappy(true));
    npc.hop = 0.9;
    if (q.id === 'desert') { q.carrying = false; safe(() => player.setCarry && player.setCarry(null)); }
    if (q.id === 'polar') for (const f of q.items) safe(() => f.ch.setHappy(true));
    if (q.id === 'ocean') safe(() => world.setLighthouseLit && world.setLighthouseLit(true));
    if (q.id === 'volcano') for (const it of q.items) it.label.visible = false;
    play('questDone');
    safe(() => effects.burst(npc.head, 0xfff07a, 30));
    safe(() => effects.ring(npc.pos, npc.dir, 0xffd84a));
    if (typeof onFragment === 'function') safe(() => onFragment(q.def));
  }

  // =========================================================================
  // 互動
  // =========================================================================
  function nearestNpc(maxDist) {
    let best = null, bd = maxDist;
    for (const id of QUEST_ORDER) {
      const n = npcs[id];
      if (n.dist < bd) { bd = n.dist; best = n; }
    }
    return best;
  }
  function refreshNpcDist() {
    const pp = player.position;
    for (const id of QUEST_ORDER) { const n = npcs[id]; n.dist = n.pos.distanceTo(pp); }
  }
  function getInteractHint() {
    if (dlgBusy || paused) return null;
    refreshNpcDist();
    return nearestNpc(INTERACT_RADIUS) ? '對話' : null;
  }
  function interact() {
    if (dlgBusy || paused) return false;
    refreshNpcDist();
    const n = nearestNpc(INTERACT_RADIUS);
    if (!n) return false;
    const q = quests[n.id];
    if (q.status === 'idle') openDialogue(q, 'intro');
    else if (q.status === 'active') openDialogue(q, 'remind');
    else if (q.status === 'ready') openDialogue(q, 'complete');
    else openDialogue(q, 'after');
    return true;
  }
  function preHint(q) {
    if (q.preHintCd > 0) return;
    q.preHintCd = 10;
    toast(q.def.preHint, 2800);
  }

  // =========================================================================
  // 每幀更新
  // =========================================================================
  const npcCtx = { moving: false, speed: 0 };
  const folCtx = { moving: false, speed: 0 };

  function updateNpcs(dt, t) {
    const pp = player.position;
    for (const id of QUEST_ORDER) {
      const n = npcs[id];
      const q = quests[id];
      n.dist = n.pos.distanceTo(pp);
      const vis = n.dist < CULL_DIST;
      if (vis !== n.visible) { n.visible = vis; n.ch.object.visible = vis; }
      // 標記
      const showMark = n.dist < MARK_DIST && (q.status === 'idle' || q.status === 'ready');
      n.marker.visible = showMark;
      if (showMark) {
        n.marker.material = q.status === 'ready' ? MK.check : MK.exclaim;
        n.marker.position.copy(n.dir).multiplyScalar(n.r + n.ch.headHeight + 0.55 + Math.sin(t * 3 + n.r) * 0.08);
      }
      if (!vis) continue;
      // 面向玩家
      if (n.dist < 7) {
        _v.copy(pp).sub(n.pos);
        _v.addScaledVector(n.dir, -_v.dot(n.dir));
        if (_v.lengthSq() > 1e-4) _v.normalize(); else _v.copy(n.facing);
      } else _v.copy(n.base);
      n.facing.lerp(_v, 1 - Math.exp(-6 * dt));
      n.facing.addScaledVector(n.dir, -n.facing.dot(n.dir));
      if (n.facing.lengthSq() < 1e-6) n.facing.copy(n.base);
      n.facing.normalize();
      let lift = 0;
      if (n.hop > 0) { n.hop = Math.max(0, n.hop - dt); lift = Math.abs(Math.sin(n.hop * Math.PI * 3.3)) * 0.35; }
      placeFast(n.ch.object, n.dir, n.r + lift, n.facing);
      safe(() => n.ch.update(dt, npcCtx));
      n.head.copy(n.dir).multiplyScalar(n.r + lift + n.ch.headHeight);
      // 表情回應
      if (n.replyTimer >= 0) {
        n.replyTimer -= dt;
        if (n.replyTimer < 0) {
          const e = n.replyEmoji;
          safe(() => ui.addBubble(n.getHead, e, 2.4));
          play('npc');
          n.hop = Math.max(n.hop, 0.3);
        }
      }
    }
  }

  function placeFollower(f, radiusOverride) {
    _v.copy(f.pos);
    const len = _v.length();
    f.dir.copy(_v).multiplyScalar(1 / len);
    const r = radiusOverride != null ? radiusOverride : Math.max(len, groundR(f.dir));
    placeFast(f.ch.object, f.dir, r, f.facing);
  }

  function updateFollowers(q, dt, t) {
    const pp = player.position;
    const isChick = q.id === 'meadow';
    let slot = 0;
    for (const f of q.items) {
      if (f.state === 'home' && isChick) { f.ch.object.visible = false; continue; }
      const dp = f.pos.distanceTo(pp);
      const vis = dp < CULL_SMALL;
      f.ch.object.visible = vis;
      if (f.state === 'wait') {
        if (dp < TOUCH_R + 0.25 && !paused) {
          if (q.status === 'active') {
            f.state = 'follow';
            play('npc');
            toast(q.def.followed, 2200);
            safe(() => effects.burst(_v.copy(f.pos).addScaledVector(f.dir, 0.4), 0xfff07a, 12));
            trackerDirty = true;
          } else if (q.status === 'idle') preHint(q);
        }
        if (!vis) continue;
        // 原地蹦跳、東張西望
        f.idleT -= dt;
        if (f.idleT <= 0) { f.idleT = 1.2 + Math.random() * 2.2; f.anim = 0.35; }
        let lift = 0;
        if (f.anim > 0) { f.anim = Math.max(0, f.anim - dt); lift = Math.sin((f.anim / 0.35) * Math.PI) * 0.22; }
        if (dp < 6) {
          _v.copy(pp).sub(f.pos); _v.addScaledVector(f.spawnDir, -_v.dot(f.spawnDir));
          if (_v.lengthSq() > 1e-4) f.facing.lerp(_v.normalize(), 1 - Math.exp(-5 * dt));
        }
        f.pos.copy(f.spawn);
        f.dir.copy(f.spawnDir);
        placeFast(f.ch.object, f.spawnDir, f.spawn.length() + lift, f.facing);
        folCtx.moving = false; folCtx.speed = 0;
        safe(() => f.ch.update(dt, folCtx));
      } else if (f.state === 'follow') {
        const dist = FOLLOW_FIRST + slot * FOLLOW_GAP;
        slot++;
        pathPoint(dist, _v2);
        if (snapFollowers) f.pos.copy(_v2);
        _v.copy(_v2).sub(f.pos);
        const gap = _v.length();
        const k = 1 - Math.exp(-(gap > 3 ? 12 : 8) * dt);
        const step = gap * k;
        if (gap > 1e-5) f.pos.addScaledVector(_v, k);
        const sp = dt > 0 ? step / dt : 0;
        f.moveSpeed = f.moveSpeed + (sp - f.moveSpeed) * Math.min(1, dt * 10);
        // 面向移動方向（停下時面向玩家）
        if (step > 1e-4) _v.normalize(); else { _v.copy(pp).sub(f.pos); }
        _v.addScaledVector(f.dir, -_v.dot(f.dir));
        if (_v.lengthSq() > 1e-6) f.facing.lerp(_v.normalize(), 1 - Math.exp(-10 * dt));
        f.hop += step * 5.5;
        const lift = f.moveSpeed > 0.3 ? Math.abs(Math.sin(f.hop)) * 0.22 : 0;
        const len = f.pos.length();
        f.dir.copy(f.pos).multiplyScalar(1 / len);
        placeFast(f.ch.object, f.dir, Math.max(len, groundR(f.dir)) + lift, f.facing);
        folCtx.moving = f.moveSpeed > 0.3; folCtx.speed = f.moveSpeed;
        safe(() => f.ch.update(dt, folCtx));
      } else if (f.state === 'enter') {
        f.anim = Math.min(1, f.anim + dt / 0.9);
        const a = Math.max(0, f.anim);
        f.pos.copy(f.from).lerp(f.to, a);
        const len = f.pos.length();
        f.dir.copy(f.pos).multiplyScalar(1 / len);
        _v.copy(f.to).sub(f.from); _v.addScaledVector(f.dir, -_v.dot(f.dir));
        if (_v.lengthSq() > 1e-6) f.facing.copy(_v.normalize());
        f.hop += dt * 14;
        placeFast(f.ch.object, f.dir, Math.max(len, groundR(f.dir)) + Math.abs(Math.sin(f.hop)) * 0.25, f.facing);
        folCtx.moving = true; folCtx.speed = 3;
        safe(() => f.ch.update(dt, folCtx));
        if (a >= 1) {
          f.state = 'home';
          if (isChick) {
            f.ch.object.visible = false;
            safe(() => effects.burst(homePoint, 0xfff07a, 10));
          }
          q.delivered++;
          play('seed');
          toast(q.def.delivered(q.delivered, q.def.need), 2200);
          trackerDirty = true;
          checkReady(q);
        }
      } else if (f.state === 'home') {
        // 企鵝寶寶站在媽媽身邊
        if (!vis) continue;
        _v.copy(q.npc.pos).sub(f.pos); _v.addScaledVector(f.dir, -_v.dot(f.dir));
        if (_v.lengthSq() > 1e-4) f.facing.lerp(_v.normalize(), 1 - Math.exp(-4 * dt));
        const lift = q.status === 'done' ? Math.max(0, Math.sin(t * 5 + f.index * 2)) * 0.15 : 0;
        placeFast(f.ch.object, f.dir, Math.max(f.pos.length(), groundR(f.dir)) + lift, f.facing);
        folCtx.moving = false; folCtx.speed = 0;
        safe(() => f.ch.update(dt, folCtx));
      }
    }
    // 送達：小雞 → 雞舍門口；企鵝寶寶 → 媽媽身邊
    if (q.status === 'active' && !paused) {
      const dest = isChick ? homePoint : q.npc.pos;
      const R = isChick ? HOME_R : MOM_R;
      if (pp.distanceTo(dest) < R) {
        let k = 0;
        for (const f of q.items) {
          if (f.state !== 'follow') continue;
          f.state = 'enter';
          f.anim = -k * 0.25; // 依序跑進去
          k++;
          f.from.copy(f.pos);
          if (isChick) f.to.copy(homePoint);
          else momSlot(q, f, f.to);
        }
      }
    }
  }
  function momSlot(q, f, out) {
    const n = q.npc;
    _v.copy(n.base).applyAxisAngle(n.dir, (f.index - 1) * 0.9 + Math.PI * 0.25);
    out.copy(n.pos).addScaledVector(_v, 1.25);
    const d = out.clone().normalize();
    return out.copy(d).multiplyScalar(groundR(d));
  }

  function updatePickups(q, dt, t) {
    const pp = player.position;
    for (const it of q.items) {
      if (it.collected) continue;
      const dp = it.pos.distanceTo(pp);
      const vis = dp < CULL_SMALL;
      it.obj.visible = vis;
      if (!vis) continue;
      const bob = 0.12 + Math.sin(t * 2.2 + it.phase) * 0.08;
      it.facing.applyAxisAngle(it.dir, dt * 1.2);
      placeFast(it.obj, it.dir, it.r + bob, it.facing);
      if (dp < PICK_R && !paused) {
        if (q.status === 'active') {
          it.collected = true;
          it.obj.visible = false;
          q.got++;
          play('seed');
          safe(() => effects.burst(it.pos, q.id === 'ocean' ? 0xffd27a : 0xc8814a, 16));
          toast(q.def.picked(q.got, q.def.need), 2000);
          trackerDirty = true;
          checkReady(q);
        } else if (q.status === 'idle') preHint(q);
      }
    }
  }

  function updateIce(q, dt, t) {
    const pp = player.position;
    const dp = ice.pos.distanceTo(pp);
    const showIce = !q.carrying && q.status !== 'done' && dp < CULL_SMALL;
    ice.obj.visible = showIce;
    if (showIce) {
      ice.phase += dt;
      placeFast(ice.obj, ice.dir, ice.r + 0.05 + Math.sin(ice.phase * 2) * 0.04, ice.facing);
    }
    if (q.status === 'done' || paused) return;
    if (!q.carrying) {
      if (dp < PICK_R + 0.2) {
        if (q.status === 'active') {
          q.carrying = true;
          q.iceTime = ICE_MELT_TIME;
          q.lastSec = Math.ceil(q.iceTime);
          safe(() => player.setCarry && player.setCarry('ice'));
          safe(() => player.setCarryScale && player.setCarryScale(1));
          play('seed');
          safe(() => effects.burst(ice.pos, 0xbfe9ff, 18));
          toast(q.def.pickedIce, 2600);
          setReady(q, true);
          trackerDirty = true;
        } else if (q.status === 'idle') preHint(q);
      }
      return;
    }
    // 帶著冰：計時融化
    q.iceTime -= dt;
    const sec = Math.max(0, Math.ceil(q.iceTime));
    if (sec !== q.lastSec) {
      q.lastSec = sec;
      trackerDirty = true;
      if (sec <= 10 && sec > 0) play('tick');
      if (sec === 10) toast(q.def.melting, 1800);
    }
    safe(() => player.setCarryScale && player.setCarryScale(0.3 + 0.7 * clamp(q.iceTime / ICE_MELT_TIME, 0, 1)));
    if (q.iceTime <= 0) {
      q.carrying = false;
      q.status = 'active';
      safe(() => player.setCarry && player.setCarry(null));
      safe(() => effects.burst(player.getHeadPosition ? player.getHeadPosition(_v) : player.position, 0x7fd6ff, 16));
      play('splash');
      toast(q.def.melted, 3000);
      trackerDirty = true;
    }
  }

  function resetStations(q) {
    q.running = false; q.next = 0; q.timer = 0;
    for (const it of q.items) { it.done = false; it.label.material = MK.digits[it.index]; }
  }
  function updateStations(q, dt, t) {
    const pp = player.position;
    for (const it of q.items) {
      const dp = it.pos.distanceTo(pp);
      const vis = dp < CULL_DIST;
      it.obj.visible = vis;
      it.label.visible = vis && q.status !== 'done';
      if (!vis) continue;
      const isNext = q.status === 'active' && it.index === q.next;
      const s = isNext ? 1 + Math.sin(t * 6) * 0.12 : 1;
      it.obj.scale.setScalar(it.done ? 0.85 : s);
      if (it.done) it.facing.applyAxisAngle(it.dir, dt * 2.5);
      placeFast(it.obj, it.dir, it.r, it.facing);
      it.label.position.copy(it.dir).multiplyScalar(it.r + 2.0 + Math.sin(t * 2.5 + it.index) * 0.08);
      if (dp < PICK_R && !it.done && !paused) {
        if (q.status === 'idle') { preHint(q); continue; }
        if (q.status !== 'active') continue;
        if (it.index === q.next) {
          it.done = true;
          it.label.material = MK.done;
          q.next++;
          safe(() => effects.ring(it.pos, it.dir, 0xff6a3d));
          safe(() => effects.burst(_v.copy(it.dir).multiplyScalar(it.r + 1), 0xffb36b, 14));
          trackerDirty = true;
          if (q.next === 1) {
            q.running = true; q.timer = VOLCANO_TIME; q.lastSec = Math.ceil(q.timer);
            play('quest');
            toast(q.def.started, 2600);
          } else if (q.next >= q.items.length) {
            q.running = false;
            play('quest');
            toast(q.def.finished, 2800);
            setReady(q, true);
          } else {
            play('seed');
            toast(q.def.stepped(q.next), 1600);
          }
        } else if (it.index > q.next && q.preHintCd <= 0) {
          q.preHintCd = 3;
          toast(q.def.wrongOrder(q.next + 1), 1800);
        }
      }
    }
    if (q.running && !paused) {
      q.timer -= dt;
      const sec = Math.max(0, Math.ceil(q.timer));
      if (sec !== q.lastSec) {
        q.lastSec = sec;
        trackerDirty = true;
        if (sec <= 10 && sec > 0) play('tick');
      }
      if (q.timer <= 0) {
        resetStations(q);
        toast(q.def.timeout, 3000);
        play('splash');
        trackerDirty = true;
      }
    }
  }

  function update(dt, t) {
    if (!(dt > 0)) dt = 0;
    if (dlgBusy) {
      dlgBusyTime += dt;
      if (dlgBusyTime > 1.5) { dlgBusy = false; dlgToken++; } // 對話框沒有回應（防呆）
    }
    recordPath();
    updateNpcs(dt, t);
    for (const id of QUEST_ORDER) {
      const q = quests[id];
      q.preHintCd = Math.max(0, q.preHintCd - dt);
      if (q.doneShow > 0) { q.doneShow -= dt; if (q.doneShow <= 0) trackerDirty = true; }
    }
    updateFollowers(quests.meadow, dt, t);
    updateFollowers(quests.polar, dt, t);
    snapFollowers = false;
    updatePickups(quests.forest, dt, t);
    updatePickups(quests.ocean, dt, t);
    updateIce(quests.desert, dt, t);
    updateStations(quests.volcano, dt, t);

    // 自動對話：第一次靠近（介紹）／完成目標後回來（回報）
    if (!dlgBusy && !paused) {
      for (const id of QUEST_ORDER) {
        const q = quests[id];
        if (q.npc.dist >= INTERACT_RADIUS) continue;
        if (q.status === 'idle' && !q.introSeen) { openDialogue(q, 'intro'); break; }
        if (q.status === 'ready') { openDialogue(q, 'complete'); break; }
      }
    }
    if (trackerDirty) pushTracker();
  }

  // =========================================================================
  // 導航 / 雷達
  // =========================================================================
  function within(pos, center, range2) { return pos.distanceToSquared(center) <= range2; }
  /** 把居民與進行中任務的目標點加進 out（{ position, kind } 物件，重複使用，不配置） */
  function getRadarPoints(out, center = player.position, range = Infinity) {
    const r2 = range * range;
    for (const e of radarNpc) if (within(e.position, center, r2)) out.push(e);
    for (const id of QUEST_ORDER) {
      const q = quests[id];
      if (q.status !== 'active') continue;
      if (id === 'meadow' || id === 'polar') {
        let following = 0;
        for (const f of q.items) {
          if (f.state === 'wait') { if (within(f.spawn, center, r2)) out.push(f.radar); } else if (f.state === 'follow') following++;
        }
        if (following && id === 'meadow' && within(homeRadar.position, center, r2)) out.push(homeRadar);
      } else if (id === 'forest' || id === 'ocean') {
        for (const it of q.items) if (!it.collected && within(it.pos, center, r2)) out.push(it.radar);
      } else if (id === 'desert') {
        if (!q.carrying && within(ice.pos, center, r2)) out.push(ice.radar);
      } else if (id === 'volcano') {
        const it = q.items[q.next];
        if (it && within(it.pos, center, r2)) out.push(it.radar);
      }
    }
    return out;
  }
  /** 進行中任務最近的目標（{ position, label, urgent }，同一物件重複使用）或 null */
  let _bestObj = null, _bestD = Infinity;
  function cand(target, pos, pp) {
    const d = pos.distanceToSquared(pp);
    if (d < _bestD) { _bestD = d; _bestObj = target; }
  }
  function getNearestObjective(pp = player.position) {
    _bestObj = null; _bestD = Infinity;
    let urgent = null;
    for (const id of QUEST_ORDER) {
      const q = quests[id];
      if (q.status === 'ready') {
        const tgt = q.npc.target;
        tgt.urgent = id === 'desert' && q.carrying;
        if (tgt.urgent) urgent = tgt;
        cand(tgt, q.npc.pos, pp);
        continue;
      }
      if (q.status !== 'active') continue;
      if (id === 'meadow' || id === 'polar') {
        const following = countFollowing(q);
        if (following > 0) {
          if (id === 'meadow') cand(homeTarget, homePoint, pp);
          else { q.npc.target.urgent = false; cand(q.npc.target, q.npc.pos, pp); }
        } else {
          for (const f of q.items) if (f.state === 'wait') cand(f.target, f.spawn, pp);
        }
      } else if (id === 'forest' || id === 'ocean') {
        for (const it of q.items) if (!it.collected) cand(it.target, it.pos, pp);
      } else if (id === 'desert') {
        cand(ice.target, ice.pos, pp);
      } else if (id === 'volcano') {
        const it = q.items[q.next];
        if (it) {
          it.target.urgent = q.running;
          if (q.running) urgent = it.target;
          cand(it.target, it.pos, pp);
        }
      }
    }
    const res = urgent || _bestObj;
    _bestObj = null;
    return res;
  }

  // =========================================================================
  // 進度 / 存檔
  // =========================================================================
  function doneCount() {
    let done = 0;
    for (const id of QUEST_ORDER) if (quests[id].status === 'done') done++;
    return done;
  }
  function getProgress() {
    return { done: doneCount(), total: QUEST_ORDER.length };
  }
  function getSaveData() {
    const out = {};
    for (const id of QUEST_ORDER) {
      const q = quests[id];
      const e = { s: q.status, i: q.introSeen ? 1 : 0 };
      if (id === 'meadow' || id === 'polar') e.d = q.items.filter((f) => f.state === 'home' || f.state === 'enter').map((f) => f.index);
      if (id === 'forest' || id === 'ocean') e.c = q.items.filter((it) => it.collected).map((it) => it.index);
      if (id === 'volcano' && q.status === 'ready') e.n = 3;
      out[id] = e;
    }
    out.lit = quests.ocean.status === 'done';
    return out;
  }

  function applyQuestState(q, e) {
    const valid = ['idle', 'active', 'ready', 'done'];
    let s = e && valid.includes(e.s) ? e.s : 'idle';
    q.introSeen = !!(e && e.i) || s !== 'idle';
    q.doneShow = 0;
    q.preHintCd = 0;
    const idx = (arr) => new Set(Array.isArray(arr) ? arr.filter((x) => Number.isInteger(x)) : []);
    if (q.id === 'meadow' || q.id === 'polar') {
      const d = idx(e && e.d);
      q.delivered = 0;
      for (const f of q.items) {
        const home = s === 'done' || d.has(f.index);
        f.state = home ? 'home' : 'wait';
        f.anim = 0;
        f.pos.copy(f.spawn); f.dir.copy(f.spawnDir);
        if (home) {
          q.delivered++;
          if (q.id === 'polar') { momSlot(q, f, f.pos); f.dir.copy(f.pos).normalize(); }
        }
        f.ch.object.visible = !(home && q.id === 'meadow');
        safe(() => f.ch.setHappy(s === 'done'));
      }
      if (s === 'ready' && q.delivered < q.def.need) s = 'active';
    } else if (q.id === 'forest' || q.id === 'ocean') {
      const c = idx(e && e.c);
      q.got = 0;
      for (const it of q.items) {
        it.collected = s === 'done' || c.has(it.index);
        it.obj.visible = !it.collected;
        if (it.collected) q.got++;
      }
      if (s === 'ready' && q.got < q.def.need) s = 'active';
    } else if (q.id === 'desert') {
      q.carrying = false; q.iceTime = 0; q.lastSec = -1;
      if (s === 'ready') s = 'active'; // 帶著的冰：重新去拿
    } else if (q.id === 'volcano') {
      resetStations(q);
      if (s === 'ready') {
        if (e && e.n === 3) { for (const it of q.items) { it.done = true; it.label.material = MK.done; } q.next = 3; } else s = 'active';
      }
      if (s === 'done') for (const it of q.items) { it.done = true; it.label.visible = false; }
    }
    q.status = s;
    safe(() => q.npc.ch.setHappy(s === 'done'));
    q.npc.hop = 0;
    q.npc.replyTimer = -1;
    if (s === 'active') checkReady(q, true);
  }
  function loadSaveData(data) {
    const d = data && typeof data === 'object' ? data : {};
    dlgBusy = false; dlgToken++;
    pathCount = 0;
    safe(() => player.setCarry && player.setCarry(null));
    for (const id of QUEST_ORDER) safe(() => applyQuestState(quests[id], d[id]));
    safe(() => world.setLighthouseLit && world.setLighthouseLit(quests.ocean.status === 'done'));
    trackerDirty = true;
    pushTracker();
  }
  function reset() { loadSaveData({}); }

  function onPlayerEmote(emoji, replies) {
    for (const id of QUEST_ORDER) {
      const n = npcs[id];
      if (n.pos.distanceTo(player.position) > 7) continue;
      n.replyTimer = 0.5 + Math.random() * 0.4;
      n.replyEmoji = replies[Math.floor(Math.random() * replies.length) % replies.length];
    }
  }

  // 初始
  reset();

  return {
    update,
    getInteractHint,
    interact,
    getProgress,
    doneCount,
    getRadarPoints,
    getNearestObjective,
    getSaveData,
    loadSaveData,
    reset,
    onPlayerEmote,
    isBusy: () => dlgBusy,
    /** v3：計時挑戰中暫停任務收集與計時 */
    setPaused: (b) => { paused = !!b; },
    isPaused: () => paused,
    /** 擺放用：所有任務物件的方向（gameplay 的種子／荒地避開它們） */
    _debug: { quests, npcs, ice, homePoint, root },
  };
}
