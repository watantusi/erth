// 分身 4：玩法（知識晶石、幼苗種子、荒地種樹、NPC「嗶嗶」、教學、勝利、存檔）
// v2：平台挑戰頂端的晶石、指南針等級（地圖碎片）、嗶嗶訊號、任務居民（quests.js）
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BIOMES, WORLD_SEED, PICKUP_RADIUS, PALETTE, START_BIOME, SEA_LEVEL,
  CRYSTALS_PER_BIOME, SEEDLING_PLOTS,
  PING_DURATION, PING_COOLDOWN, COMPASS_LEVELS, RADAR_RANGE, TOTAL_QUESTS,
} from './config.js';
import {
  mulberry32, randomDirNear, angleBetweenDirs, getBiomeById, biomeCenters,
  clamp, damp, tangentBasis, projectOnTangent,
} from './utils.js';
import {
  FACTS, factsForBiome, NPC_LINES, NPC_EMOTE_REPLIES, NPC_DEFAULT_REPLIES,
  NPC_IDLE_EMOTES, TUTORIAL, MESSAGES, VICTORY, FRAGMENT_TEXTS, fragmentTitle,
} from './content.js';
import { createQuests } from './quests.js';

const TOTAL_CRYSTALS = BIOMES.length * CRYSTALS_PER_BIOME;
const TOTAL_TREES = SEEDLING_PLOTS;
const TOTAL_SEEDS = SEEDLING_PLOTS;

// ---- 外觀參數 ----
const CRYSTAL_HOVER = 1.15;   // 晶石離地高度
const CRYSTAL_CHECK = 0.5;    // 判定撿取用的點（比外觀低，比較好撿）
const BEAM_HEIGHT = 9.5;
const BEAM_BASE = CRYSTAL_HOVER + 0.35; // 光柱從晶石上方開始
const PLOT_RADIUS = 1.35;
const TREE_GROW_TIME = 1.5;
const NPC_COUNT = 5;
const NPC_HOVER = 0.35;
const NPC_SPEED = 1.1;
const NPC_COLORS = [0xffb3c7, 0xa8e6cf, 0xffd59e, 0xb5c8ff, 0xe2b6ff];
const NPC_HOMES = ['meadow', 'forest', 'desert', 'polar', 'volcano'];

// 種子與荒地分佈：[生態區, 中心索引, 最小角, 最大角]
const SEED_SPECS = [
  ['meadow', 0, 0.07, 0.16], ['meadow', 0, 0.14, 0.32], ['meadow', 0, 0.18, 0.38], ['meadow', 0, 0.2, 0.4],
  ['forest', 0, 0.05, 0.3], ['forest', 0, 0.1, 0.35], ['forest', 0, 0.12, 0.38], ['desert', 0, 0.05, 0.3],
];
const PLOT_SPECS = [
  ['meadow', 0, 0.16, 0.34], ['meadow', 0, 0.22, 0.42], ['forest', 0, 0.08, 0.32], ['forest', 0, 0.12, 0.36],
  ['desert', 0, 0.06, 0.3], ['desert', 0, 0.15, 0.38], ['volcano', 0, 0.32, 0.5], ['polar', 0, 0.34, 0.52],
];

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

// ---- 幾何小工具（只在建立時使用） ----
function mtx(px = 0, py = 0, pz = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}
/** 轉成非索引幾何、套用矩陣、只保留 position/normal，並加上單色頂點色 */
function part(geo, color, matrix) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  if (matrix) g.applyMatrix4(matrix);
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
function merged(parts) {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}
function instanced(geo, mat, count, renderOrder = 0) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false; // 實例散佈整顆星球，不做視錐剔除（數量很少）
  m.renderOrder = renderOrder;
  return m;
}
const easeOutBack = (x) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

// ---- 荒地龜裂泥土貼圖（程式產生） ----
function makeCrackTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(WORLD_SEED + 77);
  const c = S / 2;
  const blob = (radius, jitter, fill) => {
    ctx.beginPath();
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = radius * (1 - jitter * (0.5 + 0.5 * Math.sin(a * 5 + 1.3) * Math.cos(a * 3)));
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  // 柔和邊緣：多層半透明疊加
  blob(S * 0.49, 0.1, 'rgba(176,132,86,0.35)');
  blob(S * 0.46, 0.1, 'rgba(176,132,86,0.55)');
  const grd = ctx.createRadialGradient(c, c, S * 0.05, c, c, S * 0.44);
  grd.addColorStop(0, '#d6ad78');
  grd.addColorStop(1, '#b88a58');
  blob(S * 0.43, 0.1, grd);
  // 斑點
  for (let i = 0; i < 70; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * S * 0.38;
    ctx.fillStyle = rng() < 0.5 ? 'rgba(120,84,50,0.35)' : 'rgba(235,205,160,0.45)';
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, 1.5 + rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // 裂縫
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const crack = (x, y, ang, len, w, depth) => {
    ctx.strokeStyle = '#6e4a2a';
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      ang += (rng() - 0.5) * 0.9;
      x += Math.cos(ang) * len / steps;
      y += Math.sin(ang) * len / steps;
      ctx.lineTo(x, y);
      if (depth > 0 && rng() < 0.3) crack(x, y, ang + (rng() < 0.5 ? 1 : -1) * (0.6 + rng() * 0.6), len * 0.45, w * 0.6, depth - 1);
    }
    ctx.stroke();
  };
  const N = 7;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rng() * 0.5;
    crack(c + Math.cos(a) * 10, c + Math.sin(a) * 10, a, S * (0.24 + rng() * 0.1), 6.5, 2);
  }
  // 中間一圈小裂紋
  ctx.strokeStyle = '#7a5532';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = 16 + rng() * 6;
    if (i === 0) ctx.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    else ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  ctx.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}

// ---- 幾何建構 ----
function buildGeometries() {
  const G = {};
  // 晶石：八面體外殼 + 較亮的內核
  // 外殼：把面的明暗烘進頂點色（MeshBasic，不受場景光線影響，旋轉時面會閃爍）
  {
    const g = new THREE.OctahedronGeometry(0.44, 0); // 本來就是非索引幾何
    g.scale(1, 1.5, 1);
    g.computeVertexNormals();
    g.deleteAttribute('uv');
    const pos = g.attributes.position, nor = g.attributes.normal;
    const col = new Float32Array(pos.count * 3);
    const light = new THREE.Vector3(0.45, 0.75, 0.5).normalize();
    const deep = new THREE.Color(0x1590d8), bright = new THREE.Color(0xa6f6ff), c = new THREE.Color();
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      n.fromBufferAttribute(nor, i);
      const k = clamp(0.5 + 0.5 * n.dot(light), 0, 1);
      c.copy(deep).lerp(bright, k);
      for (let j = 0; j < 3; j++) col.set([c.r, c.g, c.b], (i + j) * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    G.gem = g;
  }
  G.core = new THREE.OctahedronGeometry(0.24, 0);
  G.core.scale(1, 1.5, 1);
  // 光柱：開口圓柱，頂點色由下往上淡出（加色混合下黑色 = 透明）
  {
    const g = new THREE.CylinderGeometry(0.36, 0.2, BEAM_HEIGHT, 12, 6, true);
    g.translate(0, BEAM_HEIGHT / 2, 0);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getY(i) / BEAM_HEIGHT;
      const k = Math.pow(1 - h, 1.4) * (h < 0.06 ? h / 0.06 : 1);
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    G.beam = g;
  }
  // 地面光環（平躺於 XZ 平面）
  G.ring = new THREE.RingGeometry(0.62, 0.8, 32);
  G.ring.rotateX(-Math.PI / 2);
  G.plotRing = new THREE.RingGeometry(0.7, 0.8, 40);
  G.plotRing.rotateX(-Math.PI / 2);
  G.glowDisc = new THREE.CircleGeometry(0.62, 24);
  G.glowDisc.rotateX(-Math.PI / 2);

  // 幼苗種子袋
  G.seed = merged([
    part(new THREE.SphereGeometry(0.22, 10, 8), 0xe3ad6c, mtx(0, 0.2, 0, 1, 0.85, 1)),
    part(new THREE.CylinderGeometry(0.06, 0.09, 0.1, 8), 0xb27a42, mtx(0, 0.38, 0)),
    part(new THREE.TorusGeometry(0.075, 0.022, 5, 10), 0xff8a5c, mtx(0, 0.37, 0, 1, 1, 1, Math.PI / 2)),
    part(new THREE.CylinderGeometry(0.018, 0.022, 0.2, 5), 0x5dbb46, mtx(0, 0.5, 0)),
    part(new THREE.SphereGeometry(0.09, 7, 5), 0x8be05a, mtx(0.09, 0.6, 0, 1.1, 0.35, 0.6, 0, 0, 0.5)),
    part(new THREE.SphereGeometry(0.09, 7, 5), 0x8be05a, mtx(-0.09, 0.62, 0, 1.1, 0.35, 0.6, 0, 0, -0.5)),
  ]);

  // 小樹（兩種造型）
  const flowerDirs = [[0.6, 0.5, 0.6], [-0.7, 0.4, 0.5], [0.1, 0.7, -0.7], [-0.4, 0.8, -0.3], [0.8, 0.2, -0.4], [-0.2, 0.3, 0.9], [0.3, 0.95, 0.1]];
  const tree = (crown, crown2, flowerA, flowerB) => {
    const parts = [
      part(new THREE.CylinderGeometry(0.09, 0.14, 0.85, 7), 0x9a6b43, mtx(0, 0.42, 0)),
      part(new THREE.IcosahedronGeometry(0.62, 1), crown, mtx(0, 1.18, 0)),
      part(new THREE.IcosahedronGeometry(0.4, 1), crown2, mtx(0.34, 1.5, 0.12)),
      part(new THREE.IcosahedronGeometry(0.34, 1), crown2, mtx(-0.36, 1.0, -0.15)),
    ];
    flowerDirs.forEach((d, i) => {
      const v = new THREE.Vector3(...d).normalize().multiplyScalar(0.6);
      parts.push(part(new THREE.IcosahedronGeometry(0.085, 0), i % 2 ? flowerA : flowerB, mtx(v.x, 1.18 + v.y, v.z)));
    });
    return merged(parts);
  };
  G.treeA = tree(0x62c35a, 0x86d86a, 0xff9ecf, 0xfff07a);
  G.treeB = tree(0xffb3d1, 0xffcfe2, 0xffffff, 0xff8fb8);

  // 嗶嗶機器人（原點在身體底部，+Z 為正面）
  const R = 0.36;
  G.npcBody = merged([
    part(new THREE.SphereGeometry(R, 16, 12), 0xffffff, mtx(0, R, 0, 1, 0.92, 1)),
    part(new THREE.CylinderGeometry(0.085, 0.085, 0.07, 10), 0xffffff, mtx(R - 0.01, R * 0.95, 0, 1, 1, 1, 0, 0, Math.PI / 2)),
    part(new THREE.CylinderGeometry(0.085, 0.085, 0.07, 10), 0xffffff, mtx(-R + 0.01, R * 0.95, 0, 1, 1, 1, 0, 0, Math.PI / 2)),
  ]);
  G.npcDetail = merged([
    part(new THREE.SphereGeometry(1, 16, 10), 0x24304a, mtx(0, R * 1.08, R * 0.74, 0.25, 0.19, 0.13)),
    part(new THREE.CylinderGeometry(0.02, 0.02, 0.24, 6), 0x9aa6bf, mtx(0, R * 1.84 + 0.1, 0)),
    part(new THREE.CylinderGeometry(0.11, 0.07, 0.07, 10), 0x9aa6bf, mtx(0, 0.02, 0)),
    part(new THREE.CylinderGeometry(0.045, 0.045, 0.09, 8), 0xeef2f8, mtx(R + 0.03, R * 0.95, 0, 1, 1, 1, 0, 0, Math.PI / 2)),
    part(new THREE.CylinderGeometry(0.045, 0.045, 0.09, 8), 0xeef2f8, mtx(-R - 0.03, R * 0.95, 0, 1, 1, 1, 0, 0, Math.PI / 2)),
  ]);
  const smile = new THREE.TorusGeometry(0.036, 0.011, 4, 10, Math.PI);
  G.npcGlow = merged([
    part(new THREE.SphereGeometry(0.068, 10, 8), 0xffd84a, mtx(0, R * 1.84 + 0.25, 0)),
    // 螢幕上的腮紅
    part(new THREE.SphereGeometry(0.03, 8, 5), 0xff8fb8, mtx(0.148, R * 1.03, R * 1.03, 1.2, 0.7, 0.3)),
    part(new THREE.SphereGeometry(0.03, 8, 5), 0xff8fb8, mtx(-0.148, R * 1.03, R * 1.03, 1.2, 0.7, 0.3)),
    part(smile, 0x9ff6ff, mtx(0, R * 0.98, R * 1.115, 1, 1, 1, 0, 0, Math.PI)),
    part(new THREE.CircleGeometry(0.075, 10), 0x9ff6ff, mtx(0, -0.012, 0, 1, 1, 1, Math.PI / 2)),
  ]);
  G.npcEyes = merged([
    part(new THREE.SphereGeometry(0.042, 8, 6), 0xd8fbff, mtx(0.085, R * 1.16, R * 1.1, 1, 1.35, 0.55)),
    part(new THREE.SphereGeometry(0.042, 8, 6), 0xd8fbff, mtx(-0.085, R * 1.16, R * 1.1, 1, 1.35, 0.55)),
  ]);
  G.npcEyeCenterY = R * 1.16;
  G.npcHeadY = R * 1.84 + 0.45;
  G.shadow = new THREE.CircleGeometry(0.38, 16);
  G.shadow.rotateX(-Math.PI / 2);
  return G;
}

// ======================================================================
export function createGameplay({ scene, world, player, ui, audio, effects }) {
  const root = new THREE.Group();
  root.name = 'gameplay';
  scene.add(root);

  const G = buildGeometries();
  const startDir = biomeCenters(getBiomeById(START_BIOME))[0];

  // ---- 暫存物件（避免每幀配置） ----
  const _m = new THREE.Matrix4();
  const _m2 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _pdir = new THREE.Vector3();
  const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const _col = new THREE.Color();

  const safe = (fn) => { try { fn(); } catch (e) { console.warn('[gameplay]', e); } };
  const play = (name) => safe(() => audio && audio.play(name));
  const toast = (text, ms) => safe(() => ui && ui.toast(text, ms));

  // ==================================================================
  // 擺放（確定性）
  // ==================================================================
  const rng = mulberry32(WORLD_SEED + 4004);
  const placed = []; // { dir, kind }
  const groundR = (dir) => world.getGroundRadius(dir);

  function spacingOk(dir, kind, minAny, minSame) {
    for (const p of placed) {
      const d = angleBetweenDirs(dir, p.dir) * 30;
      if (d < minAny) return false;
      if (p.kind === kind && d < minSame) return false;
    }
    return true;
  }
  function obstaclesFree(dir, clearance) {
    const obs = world.obstacles || [];
    _v.copy(dir).multiplyScalar(groundR(dir));
    for (let i = 0; i < obs.length; i++) {
      const ob = obs[i];
      if (!ob || !ob.position) continue;
      const rr = (ob.radius || 0) + clearance;
      if (ob.position.distanceToSquared(_v) < rr * rr) return false;
    }
    return true;
  }
  // v2：避開平台與任務地點（不要把種子、荒地、晶石壓在平台或居民身上）
  const toPoint = (v) => {
    if (!v || typeof v.x !== 'number') return null;
    const p = new THREE.Vector3(v.x, v.y, v.z);
    const len = p.length();
    if (!(len > 1e-6)) return null;
    if (len < 5) p.normalize().multiplyScalar(groundR(p));
    return p;
  };
  const keepOut = []; // { dir, dist }
  for (const pl of Array.isArray(world.platforms) ? world.platforms : []) {
    if (pl && pl.dir) keepOut.push({ dir: pl.dir.clone().normalize(), dist: (pl.radius || 1) + 0.6 });
  }
  for (const ch of Array.isArray(world.challenges) ? world.challenges : []) {
    if (!ch) continue;
    for (const v of [ch.start, ch.goal, ...(Array.isArray(ch.spots) ? ch.spots : [])]) {
      const p = toPoint(v);
      if (p) keepOut.push({ dir: p.normalize(), dist: 1.6 });
    }
  }
  for (const spot of Object.values(world.questSpots || {})) {
    if (!spot) continue;
    for (const v of Object.values(spot)) {
      const p = toPoint(v);
      if (p) keepOut.push({ dir: p.normalize(), dist: 2.6 });
    }
  }
  function keptOut(dir, extra) {
    for (let i = 0; i < keepOut.length; i++) {
      if (angleBetweenDirs(dir, keepOut[i].dir) * 30 < keepOut[i].dist + extra) return true;
    }
    return false;
  }
  const challengeFor = (biomeId) => (Array.isArray(world.challenges) ? world.challenges.find((c) => c && c.biome === biomeId) : null) || null;

  function flatEnough(dir, maxDiff) {
    const { right, forward } = tangentBasis(dir, _v2, _v3);
    const r0 = groundR(dir);
    const a = PLOT_RADIUS / 30;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      _v.copy(dir).addScaledVector(right, Math.cos(ang) * a).addScaledVector(forward, Math.sin(ang) * a).normalize();
      if (Math.abs(groundR(_v) - r0) > maxDiff) return false;
    }
    return true;
  }
  /**
   * 在 center 附近找空地。條件逐步放寬，保證一定回傳方向。
   * opts: { kind, minA, maxA, clearance, water: 'no'|'ocean', biome, minAny, minSame, startMin, flat }
   */
  function findSpot(center, o) {
    const out = new THREE.Vector3();
    const TRIES = 420;
    let fallback = null;
    for (let i = 0; i < TRIES; i++) {
      const phase = Math.floor(i / 70); // 0..5，越後面越寬鬆
      const grow = 1 + phase * 0.3;
      randomDirNear(center, o.maxA * grow, rng, out);
      const ang = angleBetweenDirs(out, center);
      if (ang < o.minA && phase < 4) continue;
      if (angleBetweenDirs(out, startDir) < o.startMin) continue;
      if (phase < 5 && keepOut.length && keptOut(out, o.clearance * 0.5)) continue;
      let ok = true;
      try {
        if (o.water === 'ocean') {
          // 海洋區整片都能涉水（getGroundRadius ≥ SEA_LEVEL - 0.35），所以晶石可以浮在水面上
          if (phase < 5 && !world.isWater(out) && !world.isFree(out, o.clearance)) ok = false;
          else if (!obstaclesFree(out, o.clearance)) ok = false;
          else if (phase < 3 && world.getBiome(out).id !== 'ocean') ok = false;
        } else {
          if (world.isWater(out)) ok = false;
          else if (phase < 5 && !world.isFree(out, o.clearance)) ok = false;
          else if (phase < 2 && o.biome && world.getBiome(out).id !== o.biome) ok = false;
          else if (o.flat && phase < 3 && !flatEnough(out, o.flat)) ok = false;
        }
      } catch (e) { ok = false; }
      if (!ok) continue;
      if (!fallback) fallback = out.clone();
      if (!spacingOk(out, o.kind, phase < 4 ? o.minAny : o.minAny * 0.6, phase < 4 ? o.minSame : o.minSame * 0.7)) continue;
      placed.push({ dir: out, kind: o.kind });
      return out;
    }
    const dir = fallback || randomDirNear(center, o.maxA, rng, out).clone();
    placed.push({ dir, kind: o.kind });
    return dir;
  }

  // ---- 晶石 ----
  const crystals = [];
  BIOMES.forEach((biome) => {
    const centers = biomeCenters(biome);
    const facts = factsForBiome(biome.id);
    for (let i = 0; i < CRYSTALS_PER_BIOME; i++) {
      const center = centers[i % centers.length];
      const isOcean = biome.id === 'ocean';
      const dir = findSpot(center, {
        kind: 'crystal', minA: 0.15, maxA: 0.42, clearance: 1.2,
        water: isOcean ? 'ocean' : 'no', biome: biome.id,
        minAny: 2.6, minSame: 4.2, startMin: 0.21,
      });
      // v2：每區第 1 顆放在平台挑戰的頂端（goal）；仍先跑一次 v1 擺放，讓亂數序列（種子、荒地位置）保持穩定
      let goal = null;
      const ch = i === 0 ? challengeFor(biome.id) : null;
      if (ch && ch.goal) goal = toPoint(ch.goal);
      let finalDir = dir;
      if (goal) {
        finalDir = goal.clone().normalize();
        placed[placed.length - 1].dir = finalDir;
      }
      const fact = facts[i] || FACTS[(crystals.length) % FACTS.length];
      crystals.push({
        id: 'crystal-' + fact.id, index: crystals.length, kind: 'crystal', biome, fact, dir: finalDir,
        gr: goal ? goal.length() - CRYSTAL_HOVER : groundR(finalDir), elevated: !!goal,
        baseQuat: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir),
        pos: new THREE.Vector3(), check: new THREE.Vector3(), ground: new THREE.Vector3(),
        phase: rng() * Math.PI * 2,
        collected: false, anim: -1, target: null,
      });
    }
  });
  for (const c of crystals) {
    // 海上的晶石：光環放在水面上
    let wet = false;
    try { wet = !c.elevated && world.isWater(c.dir); } catch { /* 忽略 */ }
    c.ground.copy(c.dir).multiplyScalar((wet ? Math.max(c.gr, SEA_LEVEL) : c.gr) + 0.08);
    c.check.copy(c.dir).multiplyScalar(c.gr + CRYSTAL_CHECK);
    c.pos.copy(c.dir).multiplyScalar(c.gr + CRYSTAL_HOVER);
    c.target = { position: c.pos, label: '知識晶石' };
    c.radar = { position: c.pos, kind: 'crystal' };
  }

  // ---- 荒地 ----
  const plots = PLOT_SPECS.slice(0, SEEDLING_PLOTS).map((spec, i) => {
    const [bid, ci, minA, maxA] = spec;
    const biome = getBiomeById(bid);
    const center = biomeCenters(biome)[ci] || biomeCenters(biome)[0];
    const dir = findSpot(center, {
      kind: 'plot', minA, maxA, clearance: 1.9, water: 'no', biome: bid === 'volcano' || bid === 'polar' ? null : bid,
      minAny: 3.4, minSame: 6, startMin: 0.12, flat: 0.45,
    });
    const gr = groundR(dir);
    const p = {
      id: 'plot-' + i, index: i, kind: 'plot', biome, dir, gr,
      baseQuat: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir),
      pos: new THREE.Vector3().copy(dir).multiplyScalar(gr),
      planted: false, grow: 1, target: null, vStart: 0, vCount: 0,
      yaw: rng() * Math.PI * 2, variant: i % 2,
    };
    p.target = { position: p.pos, label: '荒地（可種植）' };
    p.radar = { position: p.pos, kind: 'plot' };
    return p;
  });
  // 補足數量（若 SEEDLING_PLOTS 比規格多）
  while (plots.length < SEEDLING_PLOTS) {
    const i = plots.length;
    const biome = getBiomeById('meadow');
    const dir = findSpot(biomeCenters(biome)[0], { kind: 'plot', minA: 0.2, maxA: 0.5, clearance: 1.9, water: 'no', minAny: 3.4, minSame: 6, startMin: 0.12, flat: 0.45 });
    const gr = groundR(dir);
    const p = { id: 'plot-' + i, index: i, kind: 'plot', biome, dir, gr, baseQuat: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir), pos: dir.clone().multiplyScalar(gr), planted: false, grow: 1, target: null, vStart: 0, vCount: 0, yaw: rng() * Math.PI * 2, variant: i % 2 };
    p.target = { position: p.pos, label: '荒地（可種植）' };
    p.radar = { position: p.pos, kind: 'plot' };
    plots.push(p);
  }

  // ---- 幼苗種子 ----
  const seeds = [];
  for (let i = 0; i < TOTAL_SEEDS; i++) {
    const spec = SEED_SPECS[i % SEED_SPECS.length];
    const [bid, ci, minA, maxA] = spec;
    const biome = getBiomeById(bid);
    const center = biomeCenters(biome)[ci] || biomeCenters(biome)[0];
    const dir = findSpot(center, {
      kind: 'seed', minA, maxA, clearance: 1.0, water: 'no', biome: bid,
      minAny: 2.6, minSame: 3.2, startMin: 0.05,
    });
    const gr = groundR(dir);
    const s = {
      id: 'seed-' + i, index: i, kind: 'seed', biome, dir, gr,
      baseQuat: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir),
      pos: new THREE.Vector3().copy(dir).multiplyScalar(gr + 0.25),
      ground: new THREE.Vector3().copy(dir).multiplyScalar(gr + 0.06),
      phase: rng() * Math.PI * 2, picked: false, target: null,
    };
    s.target = { position: s.pos, label: '幼苗種子' };
    s.radar = { position: s.pos, kind: 'seed' };
    seeds.push(s);
  }

  // ==================================================================
  // 視覺物件
  // ==================================================================
  // 材質（共用）
  const M = {
    gem: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, toneMapped: false }),
    core: new THREE.MeshBasicMaterial({ color: 0xe6feff, toneMapped: false }),
    beam: new THREE.MeshBasicMaterial({
      color: PALETTE.crystal, vertexColors: true, transparent: true, opacity: 0.26,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }),
    ring: new THREE.MeshBasicMaterial({
      color: PALETTE.crystal, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    seed: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x2a3a14 }),
    seedGlow: new THREE.MeshBasicMaterial({
      color: PALETTE.seed, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    plotRing: new THREE.MeshBasicMaterial({
      color: PALETTE.seed, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }),
    tree: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    npcBody: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x2c2c36 }),
    npcDetail: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    npcGlow: new THREE.MeshBasicMaterial({ vertexColors: true }),
    npcEyes: new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }),
    shadow: new THREE.MeshBasicMaterial({
      color: 0x1d2a3a, transparent: true, opacity: 0.22, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  };

  const nC = crystals.length;
  const gemMesh = instanced(G.gem, M.gem, nC, 2);
  const coreMesh = instanced(G.core, M.core, nC, 1);
  const beamMesh = instanced(G.beam, M.beam, nC, 5);
  const ringMesh = instanced(G.ring, M.ring, nC, 3);
  for (let i = 0; i < nC; i++) beamMesh.setColorAt(i, _col.setRGB(1, 1, 1));
  const seedMesh = instanced(G.seed, M.seed, seeds.length);
  const seedGlowMesh = instanced(G.glowDisc, M.seedGlow, seeds.length, 3);
  const plotRingMesh = instanced(G.plotRing, M.plotRing, plots.length, 3);
  const treeMeshA = instanced(G.treeA, M.tree, plots.length);
  const treeMeshB = instanced(G.treeB, M.tree, plots.length);
  root.add(coreMesh, gemMesh, beamMesh, ringMesh, seedMesh, seedGlowMesh, plotRingMesh, treeMeshA, treeMeshB);

  // ---- 荒地（貼合地形的合併網格，一個 draw call） ----
  const plotTex = makeCrackTexture();
  M.plot = new THREE.MeshLambertMaterial({
    map: plotTex, vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const plotGeo = (() => {
    const RINGS = 5, SEG = 22;
    const pos = [], nor = [], uv = [], col = [], idx = [];
    const right = new THREE.Vector3(), fwd = new THREE.Vector3(), p = new THREE.Vector3();
    for (const plot of plots) {
      tangentBasis(plot.dir, right, fwd);
      const base = pos.length / 3;
      plot.vStart = base;
      const cs = Math.cos(plot.yaw), sn = Math.sin(plot.yaw);
      const addV = (lx, lz) => {
        const x = lx * cs - lz * sn, z = lx * sn + lz * cs;
        p.copy(plot.dir).multiplyScalar(30).addScaledVector(right, x).addScaledVector(fwd, z).normalize();
        const r = groundR(p) + 0.09;
        pos.push(p.x * r, p.y * r, p.z * r);
        nor.push(p.x, p.y, p.z);
        uv.push(lx / PLOT_RADIUS * 0.5 + 0.5, lz / PLOT_RADIUS * 0.5 + 0.5);
        col.push(1, 1, 1, 1);
      };
      addV(0, 0);
      for (let r = 1; r <= RINGS; r++) {
        const rad = (r / RINGS) * PLOT_RADIUS;
        for (let s = 0; s < SEG; s++) {
          const a = (s / SEG) * Math.PI * 2;
          addV(Math.cos(a) * rad, Math.sin(a) * rad);
        }
      }
      // 逆時針（從地表上方看）= 正面
      for (let s = 0; s < SEG; s++) {
        const s2 = (s + 1) % SEG;
        idx.push(base, base + 1 + s, base + 1 + s2);
      }
      for (let r = 1; r < RINGS; r++) {
        const a0 = base + 1 + (r - 1) * SEG, a1 = base + 1 + r * SEG;
        for (let s = 0; s < SEG; s++) {
          const s2 = (s + 1) % SEG;
          idx.push(a0 + s, a1 + s, a0 + s2);
          idx.push(a0 + s2, a1 + s, a1 + s2);
        }
      }
      plot.vCount = pos.length / 3 - base;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); // RGBA：種下後淡出
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  })();
  const plotMesh = new THREE.Mesh(plotGeo, M.plot);
  plotMesh.renderOrder = 1;
  root.add(plotMesh);
  // 種下後：泥土變濕潤（較深、帶點綠），再慢慢淡出 → 草地恢復
  function tintPlot(plot, healed) { // healed: 0 = 乾裂荒地, 1 = 完全恢復
    const attr = plotGeo.attributes.color;
    const k = clamp(healed * 3, 0, 1);
    const r = 1 - 0.4 * k, g = 1 - 0.25 * k, b = 1 - 0.5 * k;
    const a = 1 - clamp((healed - 0.2) / 0.8, 0, 1);
    for (let i = plot.vStart; i < plot.vStart + plot.vCount; i++) attr.setXYZW(i, r, g, b, a);
    attr.needsUpdate = true;
  }

  // 靜態實例矩陣
  function setStatic() {
    for (const c of crystals) {
      const i = c.index;
      if (c.collected && c.anim < 0) {
        gemMesh.setMatrixAt(i, _zero); coreMesh.setMatrixAt(i, _zero);
        beamMesh.setMatrixAt(i, _zero); ringMesh.setMatrixAt(i, _zero);
      } else {
        _m.compose(_v.copy(c.dir).multiplyScalar(c.gr + BEAM_BASE), c.baseQuat, _s.set(1, 1, 1));
        beamMesh.setMatrixAt(i, _m);
      }
    }
    for (const s of seeds) {
      if (s.picked) { seedMesh.setMatrixAt(s.index, _zero); seedGlowMesh.setMatrixAt(s.index, _zero); }
      else { _m.compose(s.ground, s.baseQuat, _s.set(0.8, 1, 0.8)); seedGlowMesh.setMatrixAt(s.index, _m); }
    }
    for (const p of plots) {
      treeMeshA.setMatrixAt(p.index, _zero);
      treeMeshB.setMatrixAt(p.index, _zero);
      if (p.planted) { plotRingMesh.setMatrixAt(p.index, _zero); setTreeMatrix(p, p.grow); }
    }
    for (const m of [gemMesh, coreMesh, beamMesh, ringMesh, seedMesh, seedGlowMesh, plotRingMesh, treeMeshA, treeMeshB]) {
      m.instanceMatrix.needsUpdate = true;
    }
    if (beamMesh.instanceColor) beamMesh.instanceColor.needsUpdate = true;
  }
  function setTreeMatrix(p, k) {
    const s = 1.25 * Math.max(0, k);
    _q.setFromAxisAngle(Y_AXIS, p.yaw);
    _q2.copy(p.baseQuat).multiply(_q);
    _m.compose(_v.copy(p.dir).multiplyScalar(p.gr - 0.05), _q2, _s.set(s, s, s));
    (p.variant ? treeMeshB : treeMeshA).setMatrixAt(p.index, _m);
  }

  // ==================================================================
  // NPC「嗶嗶」
  // ==================================================================
  const npcBodyMesh = instanced(G.npcBody, M.npcBody, NPC_COUNT);
  const npcDetailMesh = instanced(G.npcDetail, M.npcDetail, NPC_COUNT);
  const npcGlowMesh = instanced(G.npcGlow, M.npcGlow, NPC_COUNT);
  const npcEyesMesh = instanced(G.npcEyes, M.npcEyes, NPC_COUNT);
  const npcShadowMesh = instanced(G.shadow, M.shadow, NPC_COUNT, 1);
  root.add(npcBodyMesh, npcDetailMesh, npcGlowMesh, npcEyesMesh, npcShadowMesh);
  const eyeBlink = [];
  for (let i = 0; i <= 10; i++) {
    const k = 0.12 + 0.88 * (i / 10);
    const y = G.npcEyeCenterY;
    eyeBlink.push(new THREE.Matrix4().makeTranslation(0, y, 0)
      .multiply(new THREE.Matrix4().makeScale(1, k, 1))
      .multiply(new THREE.Matrix4().makeTranslation(0, -y, 0)));
  }

  const npcRng = mulberry32(WORLD_SEED + 5005);
  const npcs = [];
  for (let i = 0; i < NPC_COUNT; i++) {
    const biome = getBiomeById(NPC_HOMES[i % NPC_HOMES.length]);
    const home = biomeCenters(biome)[0];
    const dir = findSpot(home, {
      kind: 'npc', minA: i === 0 ? 0.08 : 0.02, maxA: i === 0 ? 0.14 : 0.25, clearance: 1.2, water: 'no',
      minAny: 2.2, minSame: 6, startMin: 0.04,
    });
    const heading = new THREE.Vector3();
    const { right } = tangentBasis(dir);
    heading.copy(right).applyAxisAngle(dir, npcRng() * Math.PI * 2).normalize();
    const npc = {
      index: i, home, dir: dir.clone(), heading,
      pos: new THREE.Vector3(), head: new THREE.Vector3(), quat: new THREE.Quaternion(),
      speed: 0, turn: 0, wanderTimer: npcRng() * 2, pause: 0, faceTimer: 0,
      replyTimer: -1, replyEmoji: '', hopT: 0, hops: 0, blinkTimer: 1 + npcRng() * 3, blinkT: 0,
      idleTimer: 15 + npcRng() * 20, hintCooldown: 0, hintCount: 0, wasNear: false,
      near: [], nearTimer: npcRng() * 0.5, avoidSign: npcRng() < 0.5 ? -1 : 1, avoidTimer: 0,
      phase: npcRng() * Math.PI * 2, flash: 0, getHead: null, gr: 30, pingCd: 0,
    };
    // 表情泡泡用的位置 getter：寫進快取向量（可傳入 out）
    npc.getHead = (out) => (out ? out.copy(npc.head) : npc.head);
    npc.gr = groundR(npc.dir);
    npc.pos.copy(npc.dir).multiplyScalar(npc.gr + NPC_HOVER);
    npc.head.copy(npc.dir).multiplyScalar(npc.gr + NPC_HOVER + G.npcHeadY);
    npcBodyMesh.setColorAt(i, _col.set(NPC_COLORS[i % NPC_COLORS.length]));
    npcGlowMesh.setColorAt(i, _col.setRGB(1, 1, 1));
    npcs.push(npc);
  }
  npcBodyMesh.instanceColor.needsUpdate = true;
  const GLOW_FLASH = new THREE.Color(1, 0.55, 0.8);

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length) % arr.length];
  function fillLine(line, biome) {
    return line.replace('{icon}', biome ? biome.icon : '').replace('{biome}', biome ? biome.name : '');
  }
  function nearestCrystalFrom(dir) {
    let best = null, bd = -2;
    for (const c of crystals) {
      if (c.collected) continue;
      const d = c.dir.dot(dir);
      if (d > bd) { bd = d; best = c; }
    }
    return best;
  }
  function npcHint(npc) {
    const unplanted = plots.length - countTrees();
    let line;
    if (countCrystals() >= crystals.length && unplanted === 0) line = pick(NPC_LINES.done);
    else {
      const r = npc.hintCount === 0 ? 0 : Math.random();
      const c = nearestCrystalFrom(player.getDirection(_pdir));
      if (c && r < 0.55) line = fillLine(pick(NPC_LINES.crystal), c.biome);
      else if (unplanted > 0 && state.seedsCarried > 0 && r < 0.85) line = pick(NPC_LINES.plant);
      else if (unplanted > 0 && state.seedsCarried === 0 && r < 0.85) line = pick(NPC_LINES.needSeed);
      else line = pick(NPC_LINES.general);
    }
    npc.hintCount++;
    toast(line, 3200);
    play('npc');
    npc.flash = 1;
  }

  function signedAngle(from, to, up) {
    _v3.crossVectors(from, to);
    return Math.atan2(_v3.dot(up), from.dot(to));
  }

  let npcHintGate = 0; // 全域節流：避免兩隻同時說話
  function updateNpcs(dt, t) {
    const ppos = player.position;
    npcHintGate = Math.max(0, npcHintGate - dt);
    for (const npc of npcs) {
      const up = npc.dir;
      // 附近障礙物快取（每 0.5 秒更新）
      npc.nearTimer -= dt;
      if (npc.nearTimer <= 0) {
        npc.nearTimer = 0.5;
        npc.near.length = 0;
        const obs = world.obstacles || [];
        for (let k = 0; k < obs.length; k++) {
          const o = obs[k];
          if (o && o.position && o.position.distanceToSquared(npc.pos) < (o.radius + 6) * (o.radius + 6)) npc.near.push(o);
        }
      }
      const dp = npc.pos.distanceTo(ppos);
      const near = dp < 3;

      // v2：指南針 Lv0/Lv1 時，靠近嗶嗶會得到一段「訊號」
      npc.pingCd = Math.max(0, npc.pingCd - dt);
      if (near && npc.pingCd <= 0 && navLevel() < 2 && countCrystals() < crystals.length) {
        npc.pingCd = PING_COOLDOWN;
        state.ping = PING_DURATION;
        toast(MESSAGES.ping, 3000);
        play('ping');
        npc.flash = 1;
        npc.faceTimer = Math.max(npc.faceTimer, 2.5);
        npc.hopT = 0.35; npc.hops = 1;
        npc.hintCooldown = Math.max(npc.hintCooldown, 20);
        npcHintGate = Math.max(npcHintGate, 5);
        npc.wasNear = true;
      }

      // 提示
      npc.hintCooldown -= dt;
      // 全域節流（教學中、別隻剛說過話）時先不標記，等可以說話時再說
      const gateOpen = npcHintGate <= 0 && state.timeSec >= tutorialUntil;
      if (near && !npc.wasNear && gateOpen) {
        if (npc.hintCooldown <= 0) {
          npcHint(npc);
          npc.hintCooldown = 40;
          npcHintGate = 5;
          npc.faceTimer = Math.max(npc.faceTimer, 2.5);
        }
        npc.wasNear = true;
      } else if (!near) npc.wasNear = false;

      // 偶爾自己比表情
      if (dp < 7 && npc.replyTimer < 0) {
        npc.idleTimer -= dt;
        if (npc.idleTimer <= 0) {
          npc.idleTimer = 18 + Math.random() * 20;
          safe(() => ui.addBubble(npc.getHead, pick(NPC_IDLE_EMOTES), 2.2));
          play('npc');
          npc.flash = 1;
        }
      }

      // 回應表情
      if (npc.replyTimer >= 0) {
        npc.replyTimer -= dt;
        if (npc.replyTimer < 0) {
          const emoji = npc.replyEmoji;
          safe(() => ui.addBubble(npc.getHead, emoji, 2.4));
          play('npc');
          npc.flash = 1;
          if (emoji === '🎉') { npc.hopT = 0.45; npc.hops = 2; }
          else if (emoji === '❤️' || emoji === '😊' || emoji === '👋') { npc.hopT = 0.35; npc.hops = 1; }
        }
      }

      // ---- 移動 ----
      const facing = npc.faceTimer > 0 || dp < 3.2;
      npc.faceTimer = Math.max(0, npc.faceTimer - dt);
      let targetSpeed = 0, maxTurn = 1.6;
      _v.copy(npc.heading); // 想要的方向
      if (facing) {
        _v2.copy(ppos).sub(npc.pos);
        projectOnTangent(_v2, up);
        if (_v2.lengthSq() > 1e-4) _v.copy(_v2.normalize());
        maxTurn = 4;
      } else if (npc.pause > 0) {
        npc.pause -= dt;
      } else {
        targetSpeed = NPC_SPEED;
        npc.wanderTimer -= dt;
        if (npc.wanderTimer <= 0) {
          npc.wanderTimer = 1.2 + Math.random() * 2.5;
          npc.turn = (Math.random() - 0.5) * 1.4;
          if (Math.random() < 0.18) npc.pause = 1 + Math.random() * 2.5;
        }
        _v.applyAxisAngle(up, npc.turn * 0.6);
        // 回家（不要離開自己的生態區太遠）
        const homeAng = angleBetweenDirs(up, npc.home);
        if (homeAng > 0.42) {
          _v2.copy(npc.home); projectOnTangent(_v2, up);
          if (_v2.lengthSq() > 1e-6) _v.addScaledVector(_v2.normalize(), (homeAng - 0.42) * 8);
        }
        // 避開障礙物
        for (let k = 0; k < npc.near.length; k++) {
          const o = npc.near[k];
          _v2.copy(npc.pos).sub(o.position);
          projectOnTangent(_v2, up);
          const d = _v2.length();
          const range = o.radius + 1.6;
          if (d < range && d > 1e-4) {
            _v2.multiplyScalar(1 / d);
            const ahead = -_v2.dot(npc.heading); // >0 表示障礙物在前方
            const w = (1 - d / range) * (ahead > -0.2 ? 2.5 : 0.8);
            _v.addScaledVector(_v2, w);
            if (d < o.radius + 0.45) { // 推出來
              npc.dir.addScaledVector(_v2, (o.radius + 0.45 - d) / npc.gr).normalize();
            }
          }
        }
        // 避開水：前方探測
        npc.avoidTimer -= dt;
        _v2.copy(up).addScaledVector(npc.heading, 1.8 / npc.gr).normalize();
        if (world.isWater(_v2)) {
          if (npc.avoidTimer <= 0) { npc.avoidSign = Math.random() < 0.5 ? -1 : 1; }
          npc.avoidTimer = 1.0;
          _v.copy(npc.heading).applyAxisAngle(up, npc.avoidSign * 1.4);
          targetSpeed *= 0.35;
          maxTurn = 2.6;
        }
      }
      projectOnTangent(_v, up);
      if (_v.lengthSq() > 1e-6) {
        _v.normalize();
        const a = signedAngle(npc.heading, _v, up);
        const step = clamp(a, -maxTurn * dt, maxTurn * dt);
        npc.heading.applyAxisAngle(up, step);
      }
      npc.speed = damp(npc.speed, targetSpeed, 3, dt);
      if (npc.speed > 0.01) {
        _v2.copy(up).addScaledVector(npc.heading, (npc.speed * dt) / npc.gr).normalize();
        if (!world.isWater(_v2)) npc.dir.copy(_v2);
        else npc.speed *= 0.5;
      }
      projectOnTangent(npc.heading, npc.dir);
      if (npc.heading.lengthSq() < 1e-6) tangentBasis(npc.dir, npc.heading, _v3);
      npc.heading.normalize();
      npc.gr = world.getGroundRadius(npc.dir);

      // ---- 動畫姿勢 ----
      let hop = 0, squash = 1;
      if (npc.hopT > 0) {
        npc.hopT -= dt;
        const k = 1 - Math.max(0, npc.hopT) / 0.45;
        hop = Math.sin(Math.PI * clamp(k, 0, 1)) * 0.55;
        squash = 1 + Math.sin(Math.PI * clamp(k, 0, 1)) * 0.08;
        if (npc.hopT <= 0 && npc.hops > 1) { npc.hops--; npc.hopT = 0.45; }
      }
      const bob = Math.sin(t * 2.4 + npc.phase) * 0.07;
      const h = npc.gr + NPC_HOVER + bob + hop;
      npc.pos.copy(npc.dir).multiplyScalar(h);
      _v3.crossVectors(npc.dir, npc.heading).normalize(); // right
      _m2.makeBasis(_v3, npc.dir, npc.heading);
      npc.quat.setFromRotationMatrix(_m2);
      _q.setFromAxisAngle(X_AXIS, npc.speed * 0.14 + Math.sin(t * 1.7 + npc.phase) * 0.04);
      _q2.copy(npc.quat).multiply(_q);
      _m.compose(npc.pos, _q2, _s.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash)));
      npcBodyMesh.setMatrixAt(npc.index, _m);
      npcDetailMesh.setMatrixAt(npc.index, _m);
      npcGlowMesh.setMatrixAt(npc.index, _m);
      // 眨眼
      npc.blinkTimer -= dt;
      if (npc.blinkTimer <= 0) { npc.blinkT = 0.16; npc.blinkTimer = 2 + Math.random() * 3.5; }
      let eye = 10;
      if (npc.blinkT > 0) {
        npc.blinkT -= dt;
        eye = Math.round(Math.abs(npc.blinkT / 0.16 - 0.5) * 2 * 10);
      }
      _m2.multiplyMatrices(_m, eyeBlink[clamp(eye, 0, 10)]);
      npcEyesMesh.setMatrixAt(npc.index, _m2);
      // 天線燈閃
      if (npc.flash > 0) {
        npc.flash = Math.max(0, npc.flash - dt * 1.5);
        _col.setRGB(1, 1, 1).lerp(GLOW_FLASH, Math.sin(npc.flash * Math.PI));
        npcGlowMesh.setColorAt(npc.index, _col);
        npcGlowMesh.instanceColor.needsUpdate = true;
      }
      npc.head.copy(npc.dir).multiplyScalar(h + G.npcHeadY);
      // 影子
      const sh = 1 - clamp((NPC_HOVER + hop) * 0.6, 0, 0.5);
      _m.compose(_v.copy(npc.dir).multiplyScalar(npc.gr + 0.05), npc.quat, _s.set(sh, 1, sh));
      npcShadowMesh.setMatrixAt(npc.index, _m);
    }
    npcBodyMesh.instanceMatrix.needsUpdate = true;
    npcDetailMesh.instanceMatrix.needsUpdate = true;
    npcGlowMesh.instanceMatrix.needsUpdate = true;
    npcEyesMesh.instanceMatrix.needsUpdate = true;
    npcShadowMesh.instanceMatrix.needsUpdate = true;
  }

  // ==================================================================
  // 狀態
  // ==================================================================
  const state = {
    seedsCarried: 0,
    timeSec: 0,
    victoryShown: false,
    fragments: 0,   // v2：地圖碎片（決定指南針等級）
    ping: 0,        // v2：嗶嗶訊號剩餘秒數
  };
  const navLevel = () => COMPASS_LEVELS[Math.min(state.fragments, COMPASS_LEVELS.length - 1)] || 0;

  // ==================================================================
  // v2：任務居民
  // ==================================================================
  const quests = createQuests({
    scene: root, world, player, ui, audio, effects,
    onFragment: (def) => onFragment(def),
    avoid: placed.map((p) => p.dir),
  });
  const TOTAL_Q = TOTAL_QUESTS || 6;
  const countQuests = () => quests.doneCount();
  let tutorialPending = true;
  let tutorialUntil = 0; // 教學訊息播放期間（timeSec），嗶嗶先不插話
  let winStarted = false;
  let needSeedCooldown = 0;
  let firstSeedHinted = false;
  let halfwayShown = false;
  const timers = [];
  const schedule = (delay, fn) => { timers.push({ time: delay, fn }); };

  const countCrystals = () => { let n = 0; for (const c of crystals) if (c.collected) n++; return n; };
  const countTrees = () => { let n = 0; for (const p of plots) if (p.planted) n++; return n; };
  function getProgress() {
    const c = countCrystals(), tr = countTrees(), q = countQuests();
    return {
      crystals: c, totalCrystals: crystals.length,
      trees: tr, totalTrees: plots.length,
      quests: q, totalQuests: TOTAL_Q,
      fragments: state.fragments,
      done: c >= crystals.length && tr >= plots.length && q >= TOTAL_Q,
    };
  }
  // 恢復度 = (晶石 + 樹 + 任務) / 26
  const fraction = () => (countCrystals() + countTrees() + countQuests()) / (crystals.length + plots.length + TOTAL_Q);
  function pushProgress() {
    const p = getProgress();
    safe(() => ui.updateProgress(p));
    safe(() => world.setRestoration(p.done ? 1 : fraction()));
    return p;
  }

  // ---- 撿取 ----
  function collectCrystal(c) {
    c.collected = true;
    c.anim = 0;
    safe(() => effects.burst(c.pos, PALETTE.crystal, 32));
    safe(() => effects.ring(c.ground, c.dir, PALETTE.crystal));
    play('collect');
    const fact = c.fact;
    const biomeName = c.biome.name;
    schedule(0.35, () => safe(() => ui.showFact({ icon: fact.icon, title: fact.title, text: fact.text, biomeName })));
    const p = pushProgress();
    afterProgress(p, 'crystal');
  }
  function pickSeed(s) {
    s.picked = true;
    state.seedsCarried++;
    seedMesh.setMatrixAt(s.index, _zero);
    seedGlowMesh.setMatrixAt(s.index, _zero);
    seedMesh.instanceMatrix.needsUpdate = true;
    seedGlowMesh.instanceMatrix.needsUpdate = true;
    safe(() => effects.burst(s.pos, PALETTE.seed, 16));
    play('seed');
    toast(MESSAGES.seedPicked(state.seedsCarried));
    if (!firstSeedHinted) {
      firstSeedHinted = true;
      schedule(2.4, () => { if (state.seedsCarried > 0 && countTrees() === 0) toast(MESSAGES.firstSeed, 3000); });
    }
  }
  function plant(p) {
    p.planted = true;
    p.grow = 0;
    state.seedsCarried = Math.max(0, state.seedsCarried - 1);
    tintPlot(p, 0.01);
    plotRingMesh.setMatrixAt(p.index, _zero);
    plotRingMesh.instanceMatrix.needsUpdate = true;
    play('plant');
    safe(() => effects.ring(p.pos, p.dir, PALETTE.seed));
    safe(() => effects.burst(_v.copy(p.dir).multiplyScalar(p.gr + 0.4), PALETTE.seed, 18));
    schedule(0.7, () => {
      safe(() => effects.burst(_v.copy(p.dir).multiplyScalar(p.gr + 1.6), 0xff9ecf, 22));
      safe(() => effects.burst(_v.copy(p.dir).multiplyScalar(p.gr + 1.8), 0xfff07a, 14));
    });
    const prog = pushProgress();
    toast(MESSAGES.planted(prog.trees, prog.totalTrees));
    afterProgress(prog, 'tree');
  }
  // 任務完成 → 地圖碎片（quests.js 在完成對話結束後呼叫）
  function onFragment() {
    state.fragments++;
    const n = state.fragments;
    const level = navLevel();
    const prog = pushProgress();
    schedule(1.0, () => {
      play('fragment');
      const ft = FRAGMENT_TEXTS[n <= 3 ? n : FRAGMENT_TEXTS.length - 1] || FRAGMENT_TEXTS[0];
      if (ui && typeof ui.showFragment === 'function') {
        safe(() => ui.showFragment({ fragments: n, level, title: ft.title, text: ft.text }));
      } else {
        toast(`${fragmentTitle(n, TOTAL_Q)} ${ft.text}`, 4200);
      }
      afterProgress(getProgress(), 'quest');
    });
    return prog;
  }
  function afterProgress(p, kind) {
    const f = fraction();
    if (!halfwayShown && f >= 0.5 && !p.done) {
      halfwayShown = true;
      schedule(kind === 'crystal' ? 0.6 : 2.4, () => toast(MESSAGES.halfway, 2600));
    }
    if (kind === 'crystal' && p.crystals === p.totalCrystals && !p.done) schedule(0.6, () => toast(MESSAGES.allCrystals, 2600));
    if (kind === 'tree' && p.trees === p.totalTrees && !p.done) schedule(2.4, () => toast(MESSAGES.allTrees, 2600));
    if (kind === 'quest' && p.quests === p.totalQuests && !p.done) schedule(0.8, () => toast(MESSAGES.allQuests, 2600));
    if (p.done) startVictory();
  }
  function startVictory() {
    if (winStarted || state.victoryShown) return;
    winStarted = true;
    // 若知識卡即將彈出，0.6 秒後（卡片關閉、遊戲恢復時）才開始慶祝
    schedule(0.6, () => {
      safe(() => player.celebrate());
      play('win');
      safe(() => world.setRestoration(1));
      toast(VICTORY.toast, 3500);
      const colors = [0xff9ecf, 0xfff07a, PALETTE.crystal, PALETTE.seed, 0xb5c8ff];
      for (let i = 0; i < 6; i++) {
        schedule(i * 0.22, () => {
          const a = (i / 6) * Math.PI * 2;
          const { right, forward } = tangentBasis(player.getDirection(_pdir), _v2, _v3);
          _v.copy(player.position).addScaledVector(_pdir, 1.6 + (i % 2) * 0.6)
            .addScaledVector(right, Math.cos(a) * 1.8).addScaledVector(forward, Math.sin(a) * 1.8);
          safe(() => effects.burst(_v, colors[i % colors.length], 28));
        });
      }
      safe(() => effects.ring(player.position, player.getDirection(_pdir), 0xfff07a));
      schedule(1.5, () => {
        state.victoryShown = true;
        const p = getProgress();
        safe(() => ui.showVictory({ timeSec: Math.round(state.timeSec), crystals: p.crystals, trees: p.trees, quests: p.quests }));
      });
    });
  }

  // ---- 教學 ----
  function runTutorial() {
    const prog = getProgress();
    const fresh = prog.crystals === 0 && prog.trees === 0 && prog.quests === 0 && state.fragments === 0
      && state.seedsCarried === 0 && countPickedSeeds() === 0;
    if (!fresh) {
      schedule(0.8, () => toast(TUTORIAL.welcomeBack, 2600));
      tutorialUntil = state.timeSec + 3.4;
      return;
    }
    let touch = false;
    try { touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch { /* 忽略 */ }
    const lines = touch ? TUTORIAL.touch : TUTORIAL.keyboard;
    lines.forEach((line, i) => schedule(0.9 + i * 3.6, () => toast(line, 3300)));
    tutorialUntil = state.timeSec + 0.9 + lines.length * 3.6;
  }
  const countPickedSeeds = () => { let n = 0; for (const s of seeds) if (s.picked) n++; return n; };

  // ==================================================================
  // 每幀更新
  // ==================================================================
  const R2 = PICKUP_RADIUS * PICKUP_RADIUS;
  function update(dt, t) {
    if (!(dt > 0)) dt = 0;
    state.timeSec += dt;
    if (tutorialPending) { tutorialPending = false; runTutorial(); }

    // 計時器
    for (let i = timers.length - 1; i >= 0; i--) {
      const tm = timers[i];
      tm.time -= dt;
      if (tm.time <= 0) {
        timers.splice(i, 1);
        tm.fn();
      }
    }

    const ppos = player.position;
    needSeedCooldown = Math.max(0, needSeedCooldown - dt);
    if (state.ping > 0) state.ping = Math.max(0, state.ping - dt);

    // ---- 晶石 ----
    for (const c of crystals) {
      const i = c.index;
      if (c.collected) {
        if (c.anim < 0) continue;
        c.anim += dt / 0.35;
        const a = Math.min(1, c.anim);
        if (a >= 1) {
          c.anim = -1;
          gemMesh.setMatrixAt(i, _zero); coreMesh.setMatrixAt(i, _zero);
          beamMesh.setMatrixAt(i, _zero); ringMesh.setMatrixAt(i, _zero);
          continue;
        }
        const s = (1 + Math.sin(a * Math.PI) * 0.5) * (1 - a * a);
        _q.setFromAxisAngle(Y_AXIS, t * 0.9 + c.phase + a * 8);
        _q2.copy(c.baseQuat).multiply(_q);
        _v.copy(c.dir).multiplyScalar(c.gr + CRYSTAL_HOVER + a * 0.9);
        _m.compose(_v, _q2, _s.set(s, s, s));
        gemMesh.setMatrixAt(i, _m);
        coreMesh.setMatrixAt(i, _m);
        _m.compose(_v.copy(c.dir).multiplyScalar(c.gr + BEAM_BASE), c.baseQuat, _s.set(1 - a, 1, 1 - a));
        beamMesh.setMatrixAt(i, _m);
        _m.compose(c.ground, c.baseQuat, _s.set(1 + a * 1.5, 1, 1 + a * 1.5));
        ringMesh.setMatrixAt(i, _m);
        continue;
      }
      const bob = Math.sin(t * 1.7 + c.phase) * 0.13;
      c.pos.copy(c.dir).multiplyScalar(c.gr + CRYSTAL_HOVER + bob);
      _q.setFromAxisAngle(Y_AXIS, t * 0.9 + c.phase);
      _q2.copy(c.baseQuat).multiply(_q);
      _m.compose(c.pos, _q2, _s.set(1, 1, 1));
      gemMesh.setMatrixAt(i, _m);
      _q.setFromAxisAngle(Y_AXIS, -t * 1.6);
      _q2.copy(c.baseQuat).multiply(_q);
      const pulse = 1 + Math.sin(t * 3 + c.phase) * 0.12;
      _m.compose(c.pos, _q2, _s.set(pulse, pulse, pulse));
      coreMesh.setMatrixAt(i, _m);
      const rp = 1 + Math.sin(t * 2 + c.phase) * 0.08;
      _m.compose(c.ground, c.baseQuat, _s.set(rp, 1, rp));
      ringMesh.setMatrixAt(i, _m);
      // 整合者：靠近時光柱淡出，避免近距離刺眼（遠處仍是醒目的指標）
      const dSq = c.check.distanceToSquared(ppos);
      const near = Math.min(1, Math.max(0, (Math.sqrt(dSq) - 3) / 13));
      const k = 0.12 + 0.88 * near * near * (3 - 2 * near);
      beamMesh.setColorAt(i, _col.setRGB(k, k, k));
      if (dSq < R2) collectCrystal(c);
    }
    if (beamMesh.instanceColor) beamMesh.instanceColor.needsUpdate = true;
    gemMesh.instanceMatrix.needsUpdate = true;
    coreMesh.instanceMatrix.needsUpdate = true;
    beamMesh.instanceMatrix.needsUpdate = true;
    ringMesh.instanceMatrix.needsUpdate = true;

    // ---- 種子 ----
    for (const s of seeds) {
      if (s.picked) continue;
      const bob = Math.sin(t * 2.2 + s.phase) * 0.08;
      _v.copy(s.dir).multiplyScalar(s.gr + 0.12 + bob);
      _q.setFromAxisAngle(Y_AXIS, t * 1.2 + s.phase);
      _q2.copy(s.baseQuat).multiply(_q);
      _m.compose(_v, _q2, _s.set(1.35, 1.35, 1.35));
      seedMesh.setMatrixAt(s.index, _m);
      if (_v2.copy(s.dir).multiplyScalar(s.gr).distanceToSquared(ppos) < R2) pickSeed(s);
    }
    seedMesh.instanceMatrix.needsUpdate = true;

    // ---- 荒地與小樹 ----
    M.plotRing.opacity = state.seedsCarried > 0 ? 0.6 : 0.22;
    let treesDirty = false;
    for (const p of plots) {
      if (p.planted) {
        if (p.grow < 1) {
          p.grow = Math.min(1, p.grow + dt / TREE_GROW_TIME);
          setTreeMatrix(p, easeOutBack(p.grow));
          tintPlot(p, p.grow);
          treesDirty = true;
        }
        continue;
      }
      const k = state.seedsCarried > 0 ? 1.15 + Math.sin(t * 3.2 + p.index) * 0.12 : 1.1;
      _m.compose(_v.copy(p.dir).multiplyScalar(p.gr + 0.12), p.baseQuat, _s.set(k * 1.75, 1, k * 1.75));
      plotRingMesh.setMatrixAt(p.index, _m);
      if (p.pos.distanceToSquared(ppos) < R2 * 1.1) {
        if (state.seedsCarried > 0) plant(p);
        else if (needSeedCooldown <= 0) { needSeedCooldown = 12; toast(MESSAGES.needSeed, 2800); }
      }
    }
    plotRingMesh.instanceMatrix.needsUpdate = true;
    if (treesDirty) { treeMeshA.instanceMatrix.needsUpdate = true; treeMeshB.instanceMatrix.needsUpdate = true; }

    updateNpcs(dt, t);
    safe(() => quests.update(dt, t));

    // 讀檔後若已全部完成但勝利畫面還沒出現過
    if (!winStarted && !state.victoryShown && getProgressDoneFast()) startVictory();
  }
  const getProgressDoneFast = () => countCrystals() >= crystals.length && countTrees() >= plots.length && countQuests() >= TOTAL_Q;

  // ==================================================================
  // 目標（指南針）
  // ==================================================================
  // 大圓角越小 → dot 越大。不建立閉包，避免每幀配置。
  let _best = null, _bestDot = -2;
  function consider(list, flag) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item[flag]) continue;
      const d = item.dir.dot(_pdir);
      if (d > _bestDot) { _bestDot = d; _best = item.target; }
    }
  }
  /** 最近的未收集晶石（target 物件）或 null */
  function nearestCrystalTarget() {
    _best = null; _bestDot = -2;
    consider(crystals, 'collected');
    const b = _best; _best = null;
    return b;
  }
  /** Lv2+：晶石、種子／荒地、進行中任務的目標，取最近的；有計時的任務目標優先 */
  function nearestAnyTarget() {
    _best = null; _bestDot = -2;
    const unplanted = plots.length - countTrees();
    consider(crystals, 'collected');
    if (state.seedsCarried > 0 && unplanted > 0) consider(plots, 'planted');
    else if (unplanted > state.seedsCarried) consider(seeds, 'picked');
    const obj = quests.getNearestObjective(player.position);
    if (obj) {
      if (obj.urgent) { _best = null; return obj; }
      const len = obj.position.length();
      const d = len > 1e-6 ? obj.position.dot(_pdir) / len : -2;
      if (d > _bestDot) { _bestDot = d; _best = obj; }
    }
    const b = _best; _best = null;
    return b;
  }

  // 導航資訊：同一個物件，每次就地更新（main 每幀呼叫，modal 時也會呼叫）
  const radarList = [];
  const nav = {
    level: 0, fragments: 0, ping: 0, showArrow: false, showDistance: false,
    target: null, distance: 0,
    biome: getBiomeById(START_BIOME),
    biomeLeft: { crystals: 0, total: CRYSTALS_PER_BIOME },
    radar: null,
  };
  const RADAR_R = RADAR_RANGE * 1.2;
  const RADAR_R2 = RADAR_R * RADAR_R;
  function getNavInfo() {
    player.getDirection(_pdir);
    const level = navLevel();
    nav.level = level;
    nav.fragments = state.fragments;
    nav.ping = state.ping > 0 ? state.ping : 0;
    // 所在生態區與剩餘晶石
    try { const b = world.getBiome(_pdir); if (b) nav.biome = b; } catch { /* 忽略 */ }
    let left = 0, total = 0;
    const bid = nav.biome && nav.biome.id;
    for (let i = 0; i < crystals.length; i++) {
      const c = crystals[i];
      if (c.biome.id !== bid) continue;
      total++;
      if (!c.collected) left++;
    }
    nav.biomeLeft.crystals = left;
    nav.biomeLeft.total = total || CRYSTALS_PER_BIOME;
    // 箭頭目標
    const pinging = nav.ping > 0;
    let target = null;
    if (level >= 2) target = nearestAnyTarget();
    else if (level === 1) target = nearestCrystalTarget() || nearestAnyTarget();
    else if (pinging) target = nearestCrystalTarget();
    nav.target = target;
    nav.showArrow = !!target;
    nav.showDistance = !!target && (level >= 2 || pinging);
    nav.distance = target ? target.position.distanceTo(player.position) : 0;
    // 雷達（Lv3）
    if (level >= 3) {
      radarList.length = 0;
      const pp = player.position;
      for (let i = 0; i < crystals.length; i++) {
        const c = crystals[i];
        if (!c.collected && c.pos.distanceToSquared(pp) <= RADAR_R2) radarList.push(c.radar);
      }
      for (let i = 0; i < seeds.length; i++) {
        const sd = seeds[i];
        if (!sd.picked && sd.pos.distanceToSquared(pp) <= RADAR_R2) radarList.push(sd.radar);
      }
      if (state.seedsCarried > 0) {
        for (let i = 0; i < plots.length; i++) {
          const p = plots[i];
          if (!p.planted && p.pos.distanceToSquared(pp) <= RADAR_R2) radarList.push(p.radar);
        }
      }
      quests.getRadarPoints(radarList, pp, RADAR_R);
      nav.radar = radarList;
    } else nav.radar = null;
    return nav;
  }
  function getNearestTarget() {
    return getNavInfo().target;
  }

  // ---- 互動（任務居民） ----
  function getInteractHint() {
    return quests.getInteractHint();
  }
  function interact() {
    return quests.interact();
  }

  // ==================================================================
  // 表情
  // ==================================================================
  function onPlayerEmote(emoji) {
    const replies = NPC_EMOTE_REPLIES[emoji] || NPC_DEFAULT_REPLIES;
    for (const npc of npcs) {
      if (npc.pos.distanceTo(player.position) > 8) continue;
      npc.faceTimer = 3;
      npc.pause = Math.max(npc.pause, 0.5);
      npc.replyTimer = 0.4 + Math.random() * 0.5;
      npc.replyEmoji = pick(replies);
      npc.idleTimer = Math.max(npc.idleTimer, 10);
    }
    safe(() => quests.onPlayerEmote(emoji, replies));
  }

  // ==================================================================
  // 存檔
  // ==================================================================
  function getSaveData() {
    return {
      v: 2,
      crystals: crystals.filter((c) => c.collected).map((c) => c.id),
      seeds: seeds.filter((s) => s.picked).map((s) => s.id),
      plots: plots.filter((p) => p.planted).map((p) => p.id),
      seedsCarried: state.seedsCarried,
      timeSec: Math.round(state.timeSec * 10) / 10,
      victoryShown: state.victoryShown,
      fragments: state.fragments,
      quests: quests.getSaveData(),
    };
  }

  function applyState({ crystalIds, seedIds, plotIds, seedsCarried, timeSec, victoryShown, fragments = 0, questData = null }) {
    timers.length = 0;
    winStarted = false;
    safe(() => quests.loadSaveData(questData));
    const qDone = countQuests();
    state.fragments = clamp(Math.max(Math.floor(fragments) || 0, qDone), 0, 99);
    state.ping = 0;
    for (const c of crystals) { c.collected = crystalIds.has(c.id); c.anim = -1; }
    for (const s of seeds) s.picked = seedIds.has(s.id);
    for (const p of plots) { p.planted = plotIds.has(p.id); p.grow = 1; tintPlot(p, p.planted ? 1 : 0); }
    state.timeSec = timeSec;
    state.victoryShown = victoryShown && getProgressDoneFast();
    // 一致性：剩下的種子（身上 + 地上）至少要夠種完剩下的荒地
    const unplanted = plots.length - countTrees();
    const onGround = seeds.length - countPickedSeeds();
    let carried = clamp(Math.floor(seedsCarried) || 0, 0, seeds.length);
    if (carried + onGround < unplanted) carried = unplanted - onGround;
    state.seedsCarried = carried;
    firstSeedHinted = countPickedSeeds() > 0;
    halfwayShown = fraction() >= 0.5;
    needSeedCooldown = 0;
    tutorialPending = true;
    for (const npc of npcs) { npc.replyTimer = -1; npc.faceTimer = 0; npc.hintCooldown = 0; npc.pingCd = 0; }
    setStatic();
    pushProgress();
  }

  function loadSaveData(data) {
    try {
      if (!data || typeof data !== 'object') return;
      const ids = (arr) => new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
      const timeSec = Number(data.timeSec);
      applyState({
        crystalIds: ids(data.crystals),
        seedIds: ids(data.seeds),
        plotIds: ids(data.plots),
        seedsCarried: Number(data.seedsCarried),
        timeSec: Number.isFinite(timeSec) && timeSec >= 0 ? timeSec : 0,
        // v1 存檔沒有任務：v1 的勝利不算 v2 的勝利（完成任務後會再慶祝一次）
        victoryShown: data.victoryShown === true && data.v >= 2,
        fragments: Number(data.fragments) || 0,
        questData: data.quests && typeof data.quests === 'object' ? data.quests : null,
      });
    } catch (e) {
      console.warn('[gameplay] 讀檔失敗，忽略', e);
    }
  }

  function reset() {
    applyState({ crystalIds: new Set(), seedIds: new Set(), plotIds: new Set(), seedsCarried: 0, timeSec: 0, victoryShown: false, fragments: 0, questData: null });
  }

  // 初始狀態
  setStatic();
  safe(() => world.setRestoration(0));

  return {
    update,
    getNearestTarget,
    getNavInfo,
    getInteractHint,
    interact,
    onPlayerEmote,
    getProgress,
    getSaveData,
    loadSaveData,
    reset,
    // 測試/除錯用（非合約）
    _debug: { crystals, seeds, plots, npcs, root, quests, state, nav },
  };
}
