// 分身 2：角色與物理 —— v2 任務居民與任務道具的低多邊形模型 + 程序動畫。
// createCharacter(kind) → { object, update(dt, { moving, speed }), setHappy(bool), headHeight, kind }
// createItem(kind)      → THREE.Object3D（原點在底部中心）
// 幾何與材質都以模組層級快取共用：同一種角色/道具建立多次不會重複配置 GPU 資源。
// （請勿 dispose 這些物件的 geometry/material；要移除時直接從場景拿掉即可。）
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

// ---------------------------------------------------------------------------
// 幾何小工具（只在第一次建立時使用）
// ---------------------------------------------------------------------------
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** 非索引化、套用 縮放→旋轉→位移、只留 position/normal，塗上單色頂點色 */
function P(geo, hex, s = null, r = null, p = null) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  _s.set(1, 1, 1);
  if (s) { if (typeof s === 'number') _s.set(s, s, s); else _s.set(s[0], s[1], s[2]); }
  _e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0);
  _q.setFromEuler(_e);
  _v.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
  _m.compose(_v, _q, _s);
  g.applyMatrix4(_m);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = new THREE.Color(hex);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
function M(list) {
  const g = mergeGeometries(list.filter(Boolean), false);
  for (const x of list) if (x) x.dispose();
  g.computeBoundingSphere();
  return g;
}
const sph = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
const ico = (r, d = 1) => new THREE.IcosahedronGeometry(r, d);
const cyl = (rt, rb, h, n = 8) => new THREE.CylinderGeometry(rt, rb, h, n);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
const cap = (r, len, n = 8) => new THREE.CapsuleGeometry(r, len, 3, n);
const cone = (r, h, n = 8) => new THREE.ConeGeometry(r, h, n);
const torus = (r, t, rs = 5, ts = 12, arc = TAU) => new THREE.TorusGeometry(r, t, rs, ts, arc);

/** 一對眼睛（以眼睛中心高度為原點，縮放 Y 即眨眼）。x = 左右間距的一半 */
function eyesGeo(x, z, size, { yaw = 0.18, color = 0x2b2238, shine = 0xffffff, sy = 1.18 } = {}) {
  const list = [];
  for (const sx of [-1, 1]) {
    list.push(P(sph(size, 10, 8), color, [0.86, sy, 0.55], [0, sx * yaw, 0], [sx * x, 0, z]));
    list.push(P(sph(size * 0.34, 6, 4), shine, null, null, [sx * x + size * 0.28, size * 0.42, z + size * 0.42]));
    list.push(P(sph(size * 0.17, 5, 3), shine, null, null, [sx * x - size * 0.22, -size * 0.38, z + size * 0.44]));
  }
  return M(list);
}
/** 開心時的「^ ^」眼 */
function happyEyesGeo(x, z, size, { yaw = 0.18, color = 0x2b2238 } = {}) {
  const list = [];
  for (const sx of [-1, 1]) {
    list.push(P(torus(size * 0.78, size * 0.26, 4, 8, Math.PI), color, null, [0, sx * yaw, 0], [sx * x, -size * 0.3, z]));
  }
  return M(list);
}
/** 微笑嘴 */
const smile = (r, t, hex, p, rot = 0) => P(torus(r, t, 4, 8, Math.PI), hex, null, [rot, 0, Math.PI], p);
/** 腮紅 */
function blush(x, y, z, r, yaw = 0.5, hex = 0xff8fa3) {
  return [
    P(sph(r, 8, 5), hex, [1.25, 0.7, 0.3], [0, -yaw, 0], [-x, y, z]),
    P(sph(r, 8, 5), hex, [1.25, 0.7, 0.3], [0, yaw, 0], [x, y, z]),
  ];
}

// ---------------------------------------------------------------------------
// v4：可選的玩家角色（模型在 player.js，共用同一套骨架與動畫；這裡是選角畫面用的資料）
// ---------------------------------------------------------------------------
export const CHARACTER_INFO = {
  wanderer: { name: '小旅人', icon: '🌱', desc: '橘色兜帽配小背包，頭頂的小芽走路時會一晃一晃。' },
  fox: { name: '狐狸探險家', icon: '🦊', desc: '豎起尖尖的狐狸耳朵，甩著蓬鬆大尾巴到處嗅嗅新發現！' },
  astro: { name: '太空小子', icon: '🚀', desc: '從星星那邊來的小太空人，一跳背包就噗地噴出小火花。' },
  bear: { name: '熊熊', icon: '🐻', desc: '熊耳朵連帽衣加圓圓小尾巴，背著蜂蜜罐慢慢逛。' },
  cloud: { name: '雲朵仙子', icon: '☁️', desc: '頂著一頭軟綿綿的雲朵，跳起來小翅膀就拍拍拍。' },
};

// ---------------------------------------------------------------------------
// 共用材質與假陰影
// ---------------------------------------------------------------------------
let MAT = null;
function mats() {
  if (MAT) return MAT;
  let shadowTex = null;
  try {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.75)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    shadowTex = new THREE.CanvasTexture(canvas);
    shadowTex.colorSpace = THREE.SRGBColorSpace;
  } catch { shadowTex = null; }
  let glowTex = null;
  try {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    glowTex = new THREE.CanvasTexture(canvas);
    glowTex.colorSpace = THREE.SRGBColorSpace;
  } catch { glowTex = null; }

  MAT = {
    body: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    // 臉與絨毛：平滑著色 + 微自發光，背光時也明亮好認
    soft: new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x3a3030 }),
    eye: new THREE.MeshBasicMaterial({ vertexColors: true }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    halo: new THREE.MeshBasicMaterial({
      color: 0xffffff, map: glowTex, transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }),
    thruster: new THREE.MeshBasicMaterial({
      color: 0x7ff0ff, map: glowTex, transparent: true, opacity: 0.8, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }),
    shadow: new THREE.MeshBasicMaterial({
      color: 0x1b2a3a, map: shadowTex, transparent: true, opacity: 0.34, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    starfish: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0xc8461e }),
    paper: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x3a2e1a, side: THREE.DoubleSide }),
    paperGlow: new THREE.MeshBasicMaterial({ color: 0xffe07a, side: THREE.DoubleSide, toneMapped: false }),
    ice: new THREE.MeshLambertMaterial({
      color: 0x9fdcff, emissive: 0x3f86b8, transparent: true, opacity: 0.8, flatShading: true, depthWrite: false,
    }),
    iceCore: new THREE.MeshLambertMaterial({ color: 0xe6f8ff, emissive: 0x6ab4dc, transparent: true, opacity: 0.55, flatShading: true }),
    iceShine: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, toneMapped: false }),
    // v3：金色道具（平面著色 + 高光，閃閃發亮）
    gold: new THREE.MeshPhongMaterial({
      vertexColors: true, flatShading: true, shininess: 45, specular: 0xd8b860, emissive: 0x7a5200,
    }),
    leaf: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x2c5a18, side: THREE.DoubleSide }),
    goldHalo: new THREE.SpriteMaterial({
      color: 0xffd45a, map: glowTex, transparent: true, opacity: 0.45, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }),
    sparkle: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  };
  return MAT;
}

let SHADOW_GEO = null;
function shadowMesh(r) {
  if (!SHADOW_GEO) {
    SHADOW_GEO = new THREE.CircleGeometry(1, 18);
    SHADOW_GEO.rotateX(-Math.PI / 2);
  }
  const m = new THREE.Mesh(SHADOW_GEO, mats().shadow);
  m.scale.set(r, 1, r);
  m.position.y = 0.025;
  m.renderOrder = 1;
  m.userData.baseScale = r;
  return m;
}

/** 在 parent 下建立一個樞紐 Group（位置 p）並放入 mesh */
function pivot(parent, geo, mat, p) {
  const g = new THREE.Group();
  g.position.set(p[0], p[1], p[2]);
  g.add(new THREE.Mesh(geo, mat));
  parent.add(g);
  return g;
}
function meshAt(parent, geo, mat, p = null) {
  const m = new THREE.Mesh(geo, mat);
  if (p) m.position.set(p[0], p[1], p[2]);
  parent.add(m);
  return m;
}

// ---------------------------------------------------------------------------
// 各角色的幾何（每種只建一次）
// ---------------------------------------------------------------------------
const GEO = {};
const EYE = 0x2b2238;

const BUILD = {
  // ---- 咩咩村長：毛茸茸的羊、小草帽、拐杖 ----
  sheepElder() {
    const WOOL = 0xfbf7ef, WOOL2 = 0xefe8dc, FACE = 0xf0d4bc, MUZ = 0xfae8d6, HOOF = 0x5b4a52;
    const wool = [P(ico(0.4, 1), WOOL, [1.02, 0.95, 0.92], null, [0, 0.64, 0])];
    const puffs = [[0.32, 0.78, 0.12], [-0.32, 0.78, 0.12], [0.36, 0.55, -0.05], [-0.36, 0.55, -0.05],
      [0, 0.86, -0.22], [0.2, 0.42, 0.2], [-0.2, 0.42, 0.2], [0, 0.4, -0.25], [0.22, 0.9, -0.08], [-0.22, 0.9, -0.08]];
    puffs.forEach((q, i) => wool.push(P(ico(0.19 + (i % 3) * 0.02, 1), i % 2 ? WOOL : WOOL2, null, [i, i * 2, 0], q)));
    wool.push(P(ico(0.13, 1), WOOL, null, null, [0, 0.5, -0.42])); // 小尾巴
    const body = M(wool);

    const H = 0.22; // 頭中心（相對脖子）
    const head = M([
      P(sph(0.25, 14, 10), FACE, [0.96, 1.02, 0.94], null, [0, H, 0.06]),
      P(sph(0.15, 10, 8), MUZ, [1.1, 0.78, 0.9], null, [0, H - 0.09, 0.22]),
      P(sph(0.035, 6, 4), 0x8a5a5a, [1.4, 0.8, 0.8], null, [0, H - 0.04, 0.355]),
      smile(0.035, 0.011, 0x6b3434, [0, H - 0.12, 0.345]),
      ...blush(0.165, H - 0.05, 0.25, 0.05, 0.6),
      // 下垂的耳朵
      P(sph(0.1, 8, 6), FACE, [1.5, 0.55, 0.8], [0, 0, -0.5], [0.27, H + 0.08, 0.02]),
      P(sph(0.1, 8, 6), FACE, [1.5, 0.55, 0.8], [0, 0, 0.5], [-0.27, H + 0.08, 0.02]),
      P(sph(0.06, 6, 4), 0xf7a8b4, [1.4, 0.4, 0.6], [0, 0, -0.5], [0.29, H + 0.07, 0.06]),
      P(sph(0.06, 6, 4), 0xf7a8b4, [1.4, 0.4, 0.6], [0, 0, 0.5], [-0.29, H + 0.07, 0.06]),
      // 頭頂羊毛 + 白眉毛 + 鬍子（長老！）
      P(ico(0.2, 1), WOOL, [1.15, 0.7, 1], null, [0, H + 0.2, 0.0]),
      P(ico(0.07, 1), WOOL, [1.45, 0.62, 0.8], [0, 0, -0.32], [0.112, H + 0.125, 0.25]),
      P(ico(0.07, 1), WOOL, [1.45, 0.62, 0.8], [0, 0, 0.32], [-0.112, H + 0.125, 0.25]),
      P(ico(0.12, 1), WOOL, [1.05, 1.15, 0.75], null, [0, H - 0.26, 0.2]),
      P(ico(0.08, 1), WOOL2, null, null, [0.09, H - 0.21, 0.2]),
      P(ico(0.08, 1), WOOL2, null, null, [-0.09, H - 0.21, 0.2]),
      // 小草帽（微微歪戴）
      P(cyl(0.3, 0.32, 0.035, 14), 0xf2cf6b, null, [0, 0, 0.14], [0.02, H + 0.3, 0.0]),
      P(cyl(0.155, 0.18, 0.15, 12), 0xf5d97e, null, [0, 0, 0.14], [0.0, H + 0.39, 0.0]),
      P(cyl(0.185, 0.185, 0.045, 12), 0xe0584f, null, [0, 0, 0.14], [0.006, H + 0.335, 0.0]),
      P(sph(0.04, 6, 4), 0xffe36b, null, null, [-0.15, H + 0.36, 0.08]),
    ]);
    const eyes = eyesGeo(0.095, 0.29, 0.052);
    const happyEyes = happyEyesGeo(0.095, 0.3, 0.052);
    const leg = M([
      P(cap(0.075, 0.12), HOOF, null, null, [0, -0.12, 0]),
      P(sph(0.095, 8, 6), 0x3e3238, [1, 0.7, 1.25], null, [0, -0.25, 0.03]),
    ]);
    const arm = M([
      P(ico(0.11, 1), WOOL, [1, 1.15, 1], null, [0, -0.08, 0]),
      P(sph(0.07, 8, 6), HOOF, null, null, [0, -0.24, 0]),
    ]);
    const armStick = M([
      P(ico(0.11, 1), WOOL, [1, 1.15, 1], null, [0, -0.08, 0]),
      P(sph(0.07, 8, 6), HOOF, null, null, [0, -0.24, 0]),
      P(cyl(0.028, 0.032, 1.0, 6), 0x9a6b43, null, null, [0, -0.36, 0.1]),
      P(torus(0.075, 0.03, 5, 10, Math.PI * 1.25), 0x9a6b43, null, [0, Math.PI / 2, 0], [0, 0.14, 0.175]),
    ]);
    return { body, head, eyes, happyEyes, leg, arm, armStick, H };
  },

  // ---- 松鼠栗栗：橘色松鼠、捲捲大尾巴 ----
  squirrel() {
    const FUR = 0xf08a3c, FUR2 = 0xd8692a, CREAM = 0xffe6c0;
    const body = M([
      P(sph(0.3, 12, 10), FUR, [1, 1.12, 0.95], null, [0, 0.42, 0]),
      P(sph(0.23, 10, 8), CREAM, [1, 1.12, 0.62], null, [0, 0.4, 0.12]),
      P(sph(0.12, 8, 6), FUR2, [0.85, 0.5, 1.55], null, [0.15, 0.06, 0.06]),
      P(sph(0.12, 8, 6), FUR2, [0.85, 0.5, 1.55], null, [-0.15, 0.06, 0.06]),
      P(sph(0.13, 8, 6), FUR, null, null, [0.19, 0.2, -0.02]),
      P(sph(0.13, 8, 6), FUR, null, null, [-0.19, 0.2, -0.02]),
    ]);
    const H = 0.2;
    const head = M([
      P(sph(0.27, 14, 10), FUR, [1.06, 0.95, 0.95], null, [0, H, 0]),
      P(sph(0.13, 10, 8), CREAM, [1, 0.85, 0.8], null, [0.12, H - 0.07, 0.16]),
      P(sph(0.13, 10, 8), CREAM, [1, 0.85, 0.8], null, [-0.12, H - 0.07, 0.16]),
      P(sph(0.1, 8, 6), CREAM, null, null, [0, H - 0.04, 0.2]),
      P(sph(0.04, 6, 4), 0x5a3030, [1.3, 0.9, 0.9], null, [0, H + 0.02, 0.3]),
      P(box(0.06, 0.05, 0.02), 0xffffff, null, null, [0, H - 0.11, 0.275]),
      smile(0.03, 0.01, 0x6b3434, [0, H - 0.075, 0.293]),
      ...blush(0.18, H - 0.03, 0.2, 0.045, 0.7),
      // 耳朵 + 耳尖簇毛
      P(sph(0.095, 8, 6), FUR, [0.95, 1.35, 0.5], [0, 0, -0.3], [0.16, H + 0.27, -0.03]),
      P(sph(0.095, 8, 6), FUR, [0.95, 1.35, 0.5], [0, 0, 0.3], [-0.16, H + 0.27, -0.03]),
      P(sph(0.06, 6, 5), 0xffb0a8, [0.95, 1.3, 0.35], [0, 0, -0.3], [0.158, H + 0.26, 0.0]),
      P(sph(0.06, 6, 5), 0xffb0a8, [0.95, 1.3, 0.35], [0, 0, 0.3], [-0.158, H + 0.26, 0.0]),
      P(cone(0.035, 0.1, 5), FUR2, null, [0, 0, -0.35], [0.21, H + 0.41, -0.03]),
      P(cone(0.035, 0.1, 5), FUR2, null, [0, 0, 0.35], [-0.21, H + 0.41, -0.03]),
    ]);
    const eyes = eyesGeo(0.105, 0.225, 0.062);
    const happyEyes = happyEyesGeo(0.105, 0.235, 0.062);
    const arm = M([
      P(cap(0.055, 0.1, 6), FUR, null, null, [0, -0.08, 0]),
      P(sph(0.06, 6, 5), CREAM, null, null, [0, -0.16, 0.02]),
    ]);
    // 捲捲大尾巴：沿著螺旋曲線排列的毛球（樞紐在尾巴根部）
    const tail = [];
    const N = 18;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      let x, y, z;
      if (u < 0.6) {
        const k = u / 0.6;
        y = k * 0.9;
        z = -Math.sin(k * Math.PI * 0.5) * 0.3;
      } else {
        const k = (u - 0.6) / 0.4; // 頂端往後捲成一圈
        const a = k * Math.PI * 1.25;
        y = 0.9 + Math.sin(a) * 0.24;
        z = -0.3 - (1 - Math.cos(a)) * 0.24;
      }
      x = 0;
      const r = 0.1 + Math.sin(Math.min(1, u * 1.2) * Math.PI * 0.85) * 0.13;
      tail.push(P(ico(r, 1), u > 0.88 ? 0xffb36b : (i % 4 === 2 ? 0xe57d34 : FUR), null, [i * 0.7, i * 1.3, 0], [x, y, z]));
    }
    return { body, head, eyes, happyEyes, arm, tail: M(tail), H };
  },

  // ---- 駱駝阿沙：單峰駱駝、小圍巾 ----
  camel() {
    const C = 0xe3b479, C2 = 0xcf9a5e, MUZ = 0xf3d8a8, HOOF = 0x7d5f45, SC = 0x2fa7a0, SC2 = 0xffd25e;
    const body = M([
      P(sph(0.5, 16, 12), C, [0.9, 0.74, 1.25], null, [0, 1.05, 0]),
      P(sph(0.36, 14, 10), C, [1, 0.95, 1.1], null, [0, 1.38, -0.08]),
      P(ico(0.16, 1), C2, [1.25, 0.5, 1.3], null, [0, 1.68, -0.08]),
      // 彩色小鞍毯
      P(cyl(0.47, 0.5, 0.05, 12), 0xe05a52, [1, 1, 1.22], null, [0, 1.22, -0.08]),
      P(cyl(0.505, 0.52, 0.04, 12), SC2, [1, 1, 1.22], null, [0, 1.185, -0.08]),
      // 尾巴
      P(cap(0.03, 0.3, 5), C2, null, [0.45, 0, 0], [0, 0.98, -0.66]),
      P(sph(0.06, 6, 4), 0x8a6a4a, [1, 1.6, 1], [0.45, 0, 0], [0, 0.82, -0.74]),
    ]);
    // 脖子 + 頭（樞紐在脖子根部；脖子往前上方彎）
    const neck = M([
      P(cap(0.17, 0.36, 10), C, null, [-0.75, 0, 0], [0, 0.12, 0.17]),
      P(cap(0.15, 0.3, 10), C, null, [-0.15, 0, 0], [0, 0.46, 0.3]),
      P(sph(0.25, 14, 10), C, [0.95, 0.88, 1.12], null, [0, 0.76, 0.34]),
      P(sph(0.18, 12, 9), MUZ, [0.95, 0.82, 1.05], null, [0, 0.68, 0.55]),
      P(sph(0.03, 5, 3), 0x6b4a3a, [1.4, 0.7, 0.7], null, [0.065, 0.73, 0.73]),
      P(sph(0.03, 5, 3), 0x6b4a3a, [1.4, 0.7, 0.7], null, [-0.065, 0.73, 0.73]),
      smile(0.055, 0.013, 0x6b3434, [0, 0.62, 0.7], 0.3),
      ...blush(0.17, 0.7, 0.5, 0.055, 0.8),
      P(sph(0.075, 6, 5), C2, [0.7, 1.25, 0.6], [0, 0, -0.75], [0.2, 0.95, 0.24]),
      P(sph(0.075, 6, 5), C2, [0.7, 1.25, 0.6], [0, 0, 0.75], [-0.2, 0.95, 0.24]),
      P(ico(0.11, 1), 0xb98450, [1.25, 0.75, 1.1], null, [0, 0.99, 0.31]),
      // 圍巾
      P(torus(0.19, 0.075, 6, 14), SC, [1, 1, 1.05], [Math.PI / 2 - 0.5, 0, 0], [0, 0.2, 0.2]),
      P(box(0.13, 0.32, 0.06), SC, null, [0.2, 0, 0.15], [0.12, 0.03, 0.36]),
      P(box(0.135, 0.045, 0.065), SC2, null, [0.2, 0, 0.15], [0.115, 0.08, 0.37]),
      P(box(0.135, 0.045, 0.065), SC2, null, [0.2, 0, 0.15], [0.13, -0.05, 0.34]),
    ]);
    const eyes = eyesGeo(0.14, 0.46, 0.055, { yaw: 0.5 });
    const happyEyes = happyEyesGeo(0.14, 0.47, 0.055, { yaw: 0.5 });
    const lashes = M([
      P(box(0.07, 0.014, 0.014), 0x3a2a2a, null, [0, 0.5, -0.4], [0.18, 0.075, 0.43]),
      P(box(0.07, 0.014, 0.014), 0x3a2a2a, null, [0, -0.5, 0.4], [-0.18, 0.075, 0.43]),
    ]);
    const leg = M([
      P(cap(0.125, 0.3, 8), C, null, null, [0, -0.2, 0]),
      P(sph(0.11, 8, 6), C2, null, null, [0, -0.44, 0]),
      P(cap(0.09, 0.2, 7), C, null, null, [0, -0.6, 0]),
      P(cyl(0.11, 0.125, 0.08, 8), HOOF, [1, 1, 1.15], null, [0, -0.76, 0.015]),
    ]);
    return { body, neck, eyes: M([eyes, lashes]), happyEyes, leg };
  },

  // ---- 企鵝媽媽：圍裙 + 圍巾 ----
  penguinMom() {
    const BK = 0x2d3550, W = 0xffffff, OR = 0xffa53a;
    const body = M([
      P(sph(0.42, 14, 11), BK, [1, 1.33, 0.95], null, [0, 0.58, 0]),
      P(sph(0.37, 14, 10), W, [0.9, 1.12, 0.62], null, [0, 0.54, 0.2]),
      P(sph(0.27, 14, 10), W, [1.12, 0.78, 0.6], null, [0, 0.85, 0.2]),
      P(cone(0.065, 0.16, 7), OR, [1, 1, 0.7], [Math.PI / 2, 0, 0], [0, 0.8, 0.43]),
      ...blush(0.2, 0.78, 0.33, 0.05, 0.55),
      // 圍裙
      P(sph(0.33, 12, 8), 0xff9eb8, [0.84, 0.86, 0.36], null, [0, 0.38, 0.26]),
      P(box(0.17, 0.1, 0.04), W, null, [-0.05, 0, 0], [0, 0.33, 0.37]),
      P(sph(0.028, 6, 4), 0xe8545a, null, null, [-0.02, 0.345, 0.395]),
      P(sph(0.028, 6, 4), 0xe8545a, null, null, [0.02, 0.345, 0.395]),
      P(cone(0.035, 0.04, 6), 0xe8545a, null, [Math.PI, 0, 0], [0, 0.32, 0.395]),
      // 圍巾
      P(torus(0.3, 0.07, 6, 16), 0xe8545a, [1, 1, 0.9], [Math.PI / 2, 0, 0], [0, 0.66, 0.0]),
      P(box(0.1, 0.24, 0.05), 0xe8545a, null, [0.15, 0, 0.2], [0.17, 0.55, 0.27]),
      P(box(0.105, 0.035, 0.055), 0xffffff, null, [0.15, 0, 0.2], [0.162, 0.48, 0.28]),
    ]);
    const eyes = eyesGeo(0.12, 0.355, 0.05, { yaw: 0.3 });
    const happyEyes = happyEyesGeo(0.12, 0.365, 0.05, { yaw: 0.3 });
    const flipper = M([P(sph(0.12, 8, 6), BK, [0.4, 1.7, 0.85], null, [0, -0.18, 0])]);
    const foot = M([P(sph(0.1, 8, 5), OR, [1, 0.38, 1.5], null, [0, 0.03, 0.06])]);
    return { body, eyes, happyEyes, flipper, foot, eyeY: 0.91 };
  },

  // ---- 企鵝寶寶：毛茸茸的灰色寶寶 ----
  penguinChick() {
    const G = 0xb3b9c4, G2 = 0xc6cbd4, CAPC = 0x3a4150, W = 0xf6f8fb;
    const fluff = [P(sph(0.25, 14, 11), G, [1, 1.05, 0.98], null, [0, 0.27, 0]),
      P(sph(0.19, 12, 9), G2, [1, 1.1, 0.6], null, [0, 0.24, 0.12])];
    [[0.24, 0.24, 0, -1.9], [-0.24, 0.24, 0, 1.9], [0.2, 0.12, 0.1, -2.2], [-0.2, 0.12, 0.1, 2.2], [0, 0.3, -0.25, 0]]
      .forEach((q) => fluff.push(P(cone(0.05, 0.09, 5), G, null, [q[3] ? 0 : -1.9, 0, q[3]], [q[0], q[1], q[2]])));
    const body = M([
      ...fluff,
      P(sph(0.2, 12, 10), CAPC, null, null, [0, 0.5, -0.01]),
      P(sph(0.16, 12, 9), W, [1.05, 0.88, 0.62], null, [0, 0.48, 0.1]),
      P(sph(0.04, 6, 4), CAPC, null, null, [0, 0.705, -0.01]),
      P(sph(0.03, 6, 4), CAPC, null, null, [0.035, 0.735, 0.0]),
      P(cone(0.03, 0.07, 6), 0x3a3a44, null, [Math.PI / 2, 0, 0], [0, 0.45, 0.22]),
      ...blush(0.105, 0.44, 0.17, 0.03, 0.6),
      P(sph(0.06, 6, 4), 0xf0a060, [1, 0.35, 1.5], null, [0.08, 0.02, 0.06]),
      P(sph(0.06, 6, 4), 0xf0a060, [1, 0.35, 1.5], null, [-0.08, 0.02, 0.06]),
    ]);
    const eyes = eyesGeo(0.066, 0.2, 0.032, { yaw: 0.3 });
    const happyEyes = happyEyesGeo(0.066, 0.205, 0.032, { yaw: 0.3 });
    const flipper = M([P(sph(0.06, 6, 5), G, [0.45, 1.5, 0.9], null, [0, -0.07, 0])]);
    return { body, eyes, happyEyes, flipper, eyeY: 0.5 };
  },

  // ---- 小雞：小小的黃色圓球 ----
  chick() {
    const Y = 0xffe14d, Y2 = 0xffd23a, OR = 0xff9a2e;
    const body = M([
      P(ico(0.19, 2), Y, [1, 0.95, 1], null, [0, 0.2, 0]),
      P(sph(0.14, 12, 10), Y, null, null, [0, 0.38, 0.03]),
      P(cone(0.025, 0.08, 4), Y2, null, [0, 0, 0.3], [0.015, 0.54, 0.01]),
      P(cone(0.025, 0.07, 4), Y2, null, [0, 0, -0.5], [-0.025, 0.53, 0.0]),
      P(cone(0.035, 0.07, 6), OR, [1, 0.8, 1], [Math.PI / 2, 0, 0], [0, 0.36, 0.19]),
      ...blush(0.085, 0.35, 0.13, 0.025, 0.65),
      P(cyl(0.012, 0.012, 0.05, 4), OR, null, null, [0.06, 0.03, 0.02]),
      P(cyl(0.012, 0.012, 0.05, 4), OR, null, null, [-0.06, 0.03, 0.02]),
      P(sph(0.04, 6, 4), OR, [1, 0.35, 1.4], null, [0.06, 0.01, 0.04]),
      P(sph(0.04, 6, 4), OR, [1, 0.35, 1.4], null, [-0.06, 0.01, 0.04]),
    ]);
    const eyes = eyesGeo(0.058, 0.115, 0.027, { yaw: 0.35 });
    const happyEyes = happyEyesGeo(0.058, 0.12, 0.027, { yaw: 0.35 });
    const wing = M([P(sph(0.07, 6, 5), Y2, [0.4, 1, 1.2], null, [0, -0.05, 0])]);
    return { body, eyes, happyEyes, wing, eyeY: 0.4 };
  },

  // ---- 岩岩博士：地質機器人（安全帽、記錄板、懸浮） ----
  geoBot() {
    const T = 0x37a39a, T2 = 0x2b827b, CR = 0xf2ead8, GR = 0xdfe5ee, DK = 0x55606e, HAT = 0xffc93a;
    const body = M([
      P(box(0.58, 0.48, 0.44), T, null, null, [0, 0.64, 0]),
      P(box(0.62, 0.08, 0.48), T2, null, null, [0, 0.86, 0]),
      P(cyl(0.22, 0.13, 0.22, 8), DK, null, null, [0, 0.31, 0]),
      P(cyl(0.29, 0.29, 0.05, 8), T2, [1, 1, 0.78], null, [0, 0.42, 0]),
      P(box(0.36, 0.26, 0.03), CR, null, null, [0, 0.62, 0.225]),
      P(box(0.12, 0.08, 0.03), 0xd4c8ac, null, null, [0.09, 0.56, 0.24]),
      P(cyl(0.012, 0.012, 0.12, 5), 0xff8a5c, null, [0, 0, 0.15], [0.07, 0.62, 0.25]),
      P(sph(0.032, 6, 4), 0xff6a3d, null, null, [-0.1, 0.68, 0.245]),
      P(sph(0.032, 6, 4), 0x8be05a, null, null, [-0.02, 0.68, 0.245]),
      // 小岩石樣本
      P(ico(0.05, 0), 0x9a7e6c, null, [0.3, 0.6, 0], [-0.09, 0.57, 0.25]),
    ]);
    const head = M([
      P(box(0.5, 0.36, 0.4), GR, null, null, [0, 0.2, 0]),
      P(box(0.42, 0.26, 0.03), 0x24304a, null, null, [0, 0.2, 0.2]),
      P(cyl(0.05, 0.05, 0.05, 8), 0xff8a5c, null, [0, 0, Math.PI / 2], [0.27, 0.2, 0]),
      P(cyl(0.05, 0.05, 0.05, 8), 0xff8a5c, null, [0, 0, Math.PI / 2], [-0.27, 0.2, 0]),
      ...blush(0.15, 0.13, 0.217, 0.028, 0.0, 0xff8fb8),
      // 安全帽
      P(new THREE.SphereGeometry(0.28, 12, 6, 0, TAU, 0, Math.PI / 2), HAT, [1, 0.8, 1], null, [0, 0.37, -0.01]),
      P(cyl(0.33, 0.33, 0.035, 14), 0xf0b52a, [1, 1, 1.05], null, [0, 0.375, 0.02]),
      P(box(0.06, 0.06, 0.5), 0xf0b52a, null, null, [0, 0.55, -0.01]),
      P(cyl(0.055, 0.055, 0.07, 8), 0xb8c2d0, null, [Math.PI / 2, 0, 0], [0, 0.49, 0.25]),
      P(cyl(0.04, 0.04, 0.02, 8), 0xfffbe0, null, [Math.PI / 2, 0, 0], [0, 0.49, 0.29]),
    ]);
    const eyes = M([
      P(box(0.075, 0.1, 0.02), 0x9ff6ff, null, null, [0.095, 0, 0.218]),
      P(box(0.075, 0.1, 0.02), 0x9ff6ff, null, null, [-0.095, 0, 0.218]),
      P(box(0.025, 0.025, 0.02), 0xffffff, null, null, [0.11, 0.025, 0.225]),
      P(box(0.025, 0.025, 0.02), 0xffffff, null, null, [-0.08, 0.025, 0.225]),
      smile(0.04, 0.012, 0x9ff6ff, [0, -0.085, 0.218]),
    ]);
    const happyEyes = M([
      P(torus(0.045, 0.014, 4, 8, Math.PI), 0x9ff6ff, null, null, [0.095, -0.02, 0.22]),
      P(torus(0.045, 0.014, 4, 8, Math.PI), 0x9ff6ff, null, null, [-0.095, -0.02, 0.22]),
      P(torus(0.05, 0.014, 4, 8, Math.PI), 0x9ff6ff, null, [0, 0, Math.PI], [0, -0.07, 0.22]),
    ]);
    const armBase = () => [
      P(cyl(0.055, 0.055, 0.08, 8), DK, null, [0, 0, Math.PI / 2], [0, 0, 0]),
      P(cap(0.05, 0.16, 6), GR, null, null, [0, -0.13, 0]),
      P(sph(0.075, 8, 6), T2, null, null, [0, -0.27, 0]),
    ];
    // 左手：記錄板（先在原點朝 +Z 建好，再擺到手前方）
    const clip = M([
      P(box(0.24, 0.31, 0.025), 0xa8743f),
      P(box(0.2, 0.25, 0.01), 0xffffff, null, null, [0, -0.01, 0.016]),
      P(box(0.14, 0.014, 0.008), 0x8aa0c0, null, null, [0, 0.03, 0.024]),
      P(box(0.14, 0.014, 0.008), 0x8aa0c0, null, null, [0, -0.02, 0.024]),
      P(box(0.09, 0.014, 0.008), 0x8aa0c0, null, null, [-0.025, -0.07, 0.024]),
      P(box(0.09, 0.04, 0.03), 0xc4ccd8, null, null, [0, 0.15, 0.015]),
    ]);
    clip.rotateX(0.2);
    clip.rotateY(-0.35);
    clip.translate(-0.06, -0.3, 0.11);
    const armClip = M([...armBase(), clip]);
    // 右手：地質鎚
    const armHammer = M([
      ...armBase(),
      P(cyl(0.02, 0.02, 0.34, 5), 0x9a6b43, null, [Math.PI / 2, 0, 0], [0, -0.29, 0.1]),
      P(box(0.06, 0.06, 0.18), 0x8a96a8, null, [Math.PI / 2, 0, 0], [0, -0.29, 0.27]),
    ]);
    const glow = new THREE.CircleGeometry(0.3, 16);
    glow.rotateX(-Math.PI / 2);
    return { body, head, eyes, happyEyes, armClip, armHammer, glow };
  },

  // ---- 燈塔海龜：船長帽、小提燈 ----
  turtle() {
    const SK = 0x92d07a, SK2 = 0x7cbf66, SH = 0x8a6d3b, SH2 = 0xb48a52, PL = 0xf2e2a8;
    const body = M([
      shellGeo(0.42, [1.05, 1.15, 0.72], [0, 0.6, -0.12], 0x6a4e2c, 0xc99a5a, 0xae8247),
      P(torus(0.36, 0.06, 5, 16), 0x6d5430, [1.15, 1.32, 1], null, [0, 0.6, -0.02]),
      P(sph(0.34, 14, 10), PL, [1, 1.15, 0.62], null, [0, 0.57, 0.06]),
      P(box(0.34, 0.012, 0.02), 0xdcc890, null, null, [0, 0.63, 0.27]),
      P(box(0.3, 0.012, 0.02), 0xdcc890, null, null, [0, 0.45, 0.255]),
      P(sph(0.08, 6, 5), SK2, [1.2, 0.8, 1], null, [0, 0.3, -0.45]),
    ]);
    const H = 0.2;
    const head = M([
      P(sph(0.26, 14, 10), SK, [1, 0.92, 1], null, [0, H, 0.02]),
      P(sph(0.14, 10, 8), 0xb8e6a0, [1.3, 0.7, 0.8], null, [0, H - 0.09, 0.15]),
      smile(0.05, 0.013, 0x3f6b34, [0, H - 0.08, 0.255], 0.25),
      ...blush(0.165, H - 0.02, 0.2, 0.045, 0.6),
      P(sph(0.025, 5, 3), 0x5f9450, null, null, [0.12, H + 0.12, 0.2]),
      P(sph(0.02, 5, 3), 0x5f9450, null, null, [-0.15, H + 0.1, 0.19]),
      // 船長帽
      P(cyl(0.245, 0.25, 0.09, 14), 0x2f3b6b, null, null, [0, H + 0.2, -0.01]),
      P(sph(0.28, 14, 6), 0xffffff, [1, 0.32, 1.02], null, [0, H + 0.27, -0.03]),
      P(new THREE.SphereGeometry(0.17, 10, 6, 0, TAU, 0, Math.PI / 2), 0x1d2440, [1.2, 0.3, 1], [-0.15, 0, 0], [0, H + 0.16, 0.18]),
      P(ico(0.045, 0), 0xffcf3a, [1, 1, 0.5], null, [0, H + 0.21, 0.245]),
      P(box(0.2, 0.025, 0.02), 0xffcf3a, null, null, [0, H + 0.165, 0.245]),
    ]);
    const eyes = eyesGeo(0.1, 0.22, 0.05, { yaw: 0.35 });
    const happyEyes = happyEyesGeo(0.1, 0.23, 0.05, { yaw: 0.35 });
    const flipper = M([P(sph(0.11, 8, 6), SK, [0.42, 1.65, 0.95], null, [0, -0.17, 0.02])]);
    const flipLamp = M([
      P(sph(0.11, 8, 6), SK, [0.42, 1.65, 0.95], null, [0, -0.17, 0.02]),
      P(cyl(0.01, 0.01, 0.12, 4), 0x444a55, null, null, [0, -0.32, 0.06]),
      P(cyl(0.06, 0.07, 0.025, 6), 0x2f3b6b, null, null, [0, -0.39, 0.06]),
      P(cyl(0.055, 0.055, 0.12, 6), 0xffe680, null, null, [0, -0.46, 0.06]),
      P(cyl(0.07, 0.065, 0.025, 6), 0x2f3b6b, null, null, [0, -0.53, 0.06]),
    ]);
    const leg = M([
      P(cap(0.085, 0.08, 6), SK, null, null, [0, -0.08, 0]),
      P(sph(0.1, 8, 5), SK2, [1, 0.45, 1.35], null, [0, -0.16, 0.04]),
    ]);
    return { body, head, eyes, happyEyes, flipper, flipLamp, leg, H };
  },
};

/** 依三角面中心上色（非索引幾何）：fn(x, y, z, faceIndex) → 色碼 */
function colorFaces(g, fn) {
  const pos = g.attributes.position, col = g.attributes.color;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    c.set(fn(x, y, z, i / 3));
    for (let j = 0; j < 3; j++) col.setXYZ(i + j, c.r, c.g, c.b);
  }
  return g;
}
const lathe = (pts, n) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), n);

/** 海龜殼：低多邊形二十面體，每個三角面依「甲片」中心上色（平面著色 → 自然的甲片拼貼感） */
function shellGeo(r, sc, pos, dark, light, mid) {
  const g = new THREE.IcosahedronGeometry(r, 2);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  const centers = [[0, 0.25, -1], [0.62, 0.45, -0.65], [-0.62, 0.45, -0.65], [0.6, -0.4, -0.7], [-0.6, -0.4, -0.7],
    [0, 0.85, -0.5], [0, -0.75, -0.65]].map((c) => new THREE.Vector3(...c).normalize());
  const cD = new THREE.Color(dark), cL = new THREE.Color(light), cM = new THREE.Color(mid), c = new THREE.Color();
  const f = new THREE.Vector3(), t = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    f.set(0, 0, 0);
    for (let j = 0; j < 3; j++) f.add(t.fromBufferAttribute(p, i + j));
    f.normalize();
    let best = -1, bi = 0;
    centers.forEach((cc, k) => { const d = f.dot(cc); if (d > best) { best = d; bi = k; } });
    if (f.z > 0.15) c.copy(cD); // 前緣（被腹甲擋住）
    else if (best > 0.93) c.copy(bi % 2 ? cL : cM);
    else c.copy(cD);
    for (let j = 0; j < 3; j++) col.set([c.r, c.g, c.b], (i + j) * 3);
  }
  g.deleteAttribute('uv');
  g.scale(sc[0], sc[1], sc[2]);
  g.translate(pos[0], pos[1], pos[2]);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function geoFor(kind) {
  if (!GEO[kind]) GEO[kind] = BUILD[kind]();
  return GEO[kind];
}

// ---------------------------------------------------------------------------
// 角色組裝 + 動畫
// ---------------------------------------------------------------------------
const ASSEMBLE = {
  sheepElder(R) {
    const G = geoFor('sheepElder'), m = mats();
    const legL = pivot(R.rig, G.leg, m.body, [0.14, 0.31, 0]);
    const legR = pivot(R.rig, G.leg, m.body, [-0.14, 0.31, 0]);
    const torso = new THREE.Group(); R.rig.add(torso);
    meshAt(torso, G.body, m.body);
    const head = new THREE.Group(); head.position.set(0, 0.98, 0.04); torso.add(head);
    meshAt(head, G.head, m.soft);
    R.eyesAt(head, G, G.H + 0.035);
    const armL = pivot(torso, G.arm, m.body, [0.36, 0.8, 0.04]);
    const armR = pivot(torso, G.armStick, m.body, [-0.36, 0.8, 0.04]);
    R.headHeight = 1.78;
    R.shadowR = 0.55;
    return (st, dt) => {
      const s = Math.sin(st.phase), w = st.move, hp = st.happy;
      const bob = Math.abs(Math.cos(st.phase)) * 0.04 * w;
      torso.position.y = bob + st.hop * 0.5;
      torso.rotation.z = s * 0.06 * w + Math.sin(st.t * 0.9) * 0.02 * (1 - w);
      torso.rotation.x = 0.06 * w;
      legL.rotation.x = s * 0.55 * w; legR.rotation.x = -s * 0.55 * w;
      armL.rotation.x = -s * 0.45 * w;
      armL.rotation.z = 0.15 + hp * (2.3 + Math.sin(st.t * 14) * 0.35);
      armR.rotation.x = -0.25 + s * 0.2 * w - hp * 0.5;
      armR.rotation.z = -0.12 - hp * 0.2;
      head.rotation.x = -0.06 * w + Math.sin(st.t * 1.6) * 0.03 - hp * 0.15;
      head.rotation.z = Math.sin(st.t * 0.7) * 0.06 * (1 - w) + Math.sin(st.t * 9) * 0.08 * hp;
      head.rotation.y = Math.sin(st.t * 0.45) * 0.18 * (1 - w) * (1 - hp);
    };
  },

  squirrel(R) {
    const G = geoFor('squirrel'), m = mats();
    const torso = new THREE.Group(); R.rig.add(torso);
    meshAt(torso, G.body, m.body);
    const tail = pivot(torso, G.tail, m.body, [0, 0.2, -0.26]);
    const head = new THREE.Group(); head.position.set(0, 0.72, 0.03); torso.add(head);
    meshAt(head, G.head, m.soft);
    R.eyesAt(head, G, G.H + 0.04);
    const armL = pivot(torso, G.arm, m.body, [0.18, 0.56, 0.17]);
    const armR = pivot(torso, G.arm, m.body, [-0.18, 0.56, 0.17]);
    R.headHeight = 1.35;
    R.shadowR = 0.45;
    return (st, dt) => {
      const w = st.move, hp = st.happy;
      // 走路 = 一蹦一蹦
      const hopW = Math.abs(Math.sin(st.phase)) * 0.16 * w;
      R.rig.position.y += hopW;
      torso.rotation.x = 0.12 * w - Math.cos(st.phase * 2) * 0.06 * w;
      tail.rotation.x = -0.15 * w + Math.sin(st.t * 2.2) * 0.06 + Math.cos(st.phase * 2) * 0.12 * w;
      tail.rotation.z = Math.sin(st.t * 1.3) * 0.08 + Math.sin(st.t * 12) * 0.14 * hp;
      armL.rotation.x = -0.7 - hp * 1.6; armR.rotation.x = -0.7 - hp * 1.6;
      armL.rotation.z = hp * (0.6 + Math.sin(st.t * 16) * 0.3);
      armR.rotation.z = -hp * (0.6 + Math.sin(st.t * 16 + 1) * 0.3);
      // 嗅嗅 + 歪頭
      head.rotation.x = Math.sin(st.t * 9) * 0.02 * (1 - w) - 0.08 * w;
      head.rotation.z = Math.sin(st.t * 0.8) * 0.08 * (1 - w);
      head.rotation.y = Math.sin(st.t * 0.5) * 0.25 * (1 - w) * (1 - hp);
    };
  },

  camel(R) {
    const G = geoFor('camel'), m = mats();
    const legs = [
      pivot(R.rig, G.leg, m.soft, [0.24, 0.8, 0.4]),
      pivot(R.rig, G.leg, m.soft, [-0.24, 0.8, 0.4]),
      pivot(R.rig, G.leg, m.soft, [0.24, 0.8, -0.42]),
      pivot(R.rig, G.leg, m.soft, [-0.24, 0.8, -0.42]),
    ];
    const torso = new THREE.Group(); R.rig.add(torso);
    meshAt(torso, G.body, m.soft);
    const neck = new THREE.Group(); neck.position.set(0, 1.18, 0.52); torso.add(neck);
    meshAt(neck, G.neck, m.soft);
    R.eyesAt(neck, G, 0.82);
    R.headHeight = 2.5;
    R.shadowR = 0.85;
    let sit = 0, still = 0;
    return (st, dt) => {
      const w = st.move, hp = st.happy, s = Math.sin(st.phase);
      still = w > 0.1 || hp > 0.1 ? 0 : still + dt;
      sit = damp(sit, still > 4 ? 1 : 0, 2.2, dt);
      const drop = sit * 0.62;
      torso.position.y = -drop + Math.abs(Math.cos(st.phase)) * 0.05 * w + st.hop * 0.2;
      torso.rotation.z = s * 0.05 * w;
      for (let i = 0; i < 4; i++) {
        const front = i < 2;
        const sg = (i === 0 || i === 3) ? 1 : -1; // 對角步態
        const leg = legs[i];
        leg.position.y = 0.8 - drop;
        leg.rotation.x = sg * s * 0.45 * w + (front ? 1.45 : -1.45) * sit;
      }
      neck.rotation.x = -Math.cos(st.phase * 2) * 0.08 * w + Math.sin(st.t * 1.1) * 0.04 + sit * 0.15
        + Math.sin(st.t * 8) * 0.12 * hp;
      neck.rotation.y = Math.sin(st.t * 0.4) * 0.25 * (1 - w) * (1 - hp);
      neck.rotation.z = Math.sin(st.t * 5) * 0.12 * hp;
      // 反芻：嘴巴咀嚼
      neck.scale.y = 1 + Math.max(0, Math.sin(st.t * 6)) * 0.015 * sit;
    };
  },

  penguinMom(R) {
    const G = geoFor('penguinMom'), m = mats();
    const footL = pivot(R.rig, G.foot, m.body, [0.14, 0, 0.06]);
    const footR = pivot(R.rig, G.foot, m.body, [-0.14, 0, 0.06]);
    const torso = new THREE.Group(); R.rig.add(torso);
    meshAt(torso, G.body, m.soft);
    R.eyesAt(torso, G, G.eyeY);
    const flL = pivot(torso, G.flipper, m.body, [0.4, 0.78, 0]);
    const flR = pivot(torso, G.flipper, m.body, [-0.4, 0.78, 0]);
    R.headHeight = 1.42;
    R.shadowR = 0.55;
    return (st, dt) => waddle(st, torso, flL, flR, footL, footR, 1, 0.42);
  },

  penguinChick(R) {
    const G = geoFor('penguinChick'), m = mats();
    const torso = new THREE.Group(); R.rig.add(torso);
    meshAt(torso, G.body, m.soft);
    R.eyesAt(torso, G, G.eyeY);
    const flL = pivot(torso, G.flipper, m.body, [0.22, 0.34, 0]);
    const flR = pivot(torso, G.flipper, m.body, [-0.22, 0.34, 0]);
    R.headHeight = 0.85;
    R.shadowR = 0.3;
    return (st, dt) => waddle(st, torso, flL, flR, null, null, 1.4, 0.22);
  },

  chick(R) {
    const G = geoFor('chick'), m = mats();
    const torso = new THREE.Group(); R.rig.add(torso);
    meshAt(torso, G.body, m.soft);
    R.eyesAt(torso, G, G.eyeY);
    const wL = pivot(torso, G.wing, m.soft, [0.17, 0.24, 0]);
    const wR = pivot(torso, G.wing, m.soft, [-0.17, 0.24, 0]);
    R.headHeight = 0.72;
    R.shadowR = 0.22;
    return (st, dt) => {
      const w = st.move, hp = st.happy;
      R.rig.position.y += Math.abs(Math.sin(st.phase)) * 0.1 * w;
      torso.rotation.z = Math.sin(st.phase) * 0.12 * w;
      torso.rotation.x = 0.1 * w + Math.max(0, Math.sin(st.t * 3.1)) * 0.25 * (1 - w) * (1 - hp) * (Math.sin(st.t * 0.37) > 0.6 ? 1 : 0); // 啄地
      const flap = Math.sin(st.t * (hp > 0.1 ? 30 : 6)) * (0.15 + hp * 0.7) + w * Math.sin(st.phase * 2) * 0.3;
      wL.rotation.z = 0.1 + flap + hp * 0.6; wR.rotation.z = -0.1 - flap - hp * 0.6;
    };
  },

  geoBot(R) {
    const G = geoFor('geoBot'), m = mats();
    const torso = new THREE.Group(); R.rig.add(torso);
    meshAt(torso, G.body, m.body);
    const glow = meshAt(torso, G.glow, m.thruster, [0, 0.19, 0]);
    glow.renderOrder = 3;
    const head = new THREE.Group(); head.position.set(0, 0.9, 0); torso.add(head);
    meshAt(head, G.head, m.body);
    R.eyesAt(head, G, 0.2);
    const armL = pivot(torso, G.armClip, m.body, [0.35, 0.78, 0]);
    const armR = pivot(torso, G.armHammer, m.body, [-0.35, 0.78, 0]);
    R.headHeight = 1.75;
    R.shadowR = 0.42;
    R.blinkLow = 0.15;
    return (st, dt) => {
      const w = st.move, hp = st.happy;
      const hover = 0.2 + Math.sin(st.t * 2.6) * 0.05;
      torso.position.y = hover + st.hop * 0.4;
      R.shadowLift = hover;
      torso.rotation.x = 0.18 * clamp(st.speed / 6, 0, 1);
      torso.rotation.z = Math.sin(st.t * 1.7) * 0.03 + Math.sin(st.t * 10) * 0.06 * hp;
      const pulse = 0.85 + Math.sin(st.t * 18) * 0.1 + w * 0.2;
      glow.scale.set(pulse, 1, pulse);
      armL.rotation.x = -0.75 + Math.sin(st.t * 1.4) * 0.05 + 0.2 * w;
      armL.rotation.z = -0.38;
      armR.rotation.x = -0.1 + Math.sin(st.phase) * 0.3 * w - hp * (1.9 + Math.sin(st.t * 12) * 0.4);
      armR.rotation.z = -0.15 - hp * 0.3;
      head.rotation.y = Math.sin(st.t * 0.6) * 0.3 * (1 - w) * (1 - hp);
      head.rotation.z = Math.sin(st.t * 0.9) * 0.05 + Math.sin(st.t * 7) * 0.1 * hp;
      head.rotation.x = -0.1 + Math.sin(st.t * 0.6) * 0.04 * (1 - w); // 微微低頭看記錄板
    };
  },

  turtle(R) {
    const G = geoFor('turtle'), m = mats();
    const legL = pivot(R.rig, G.leg, m.body, [0.16, 0.22, 0]);
    const legR = pivot(R.rig, G.leg, m.body, [-0.16, 0.22, 0]);
    const torso = new THREE.Group(); R.rig.add(torso);
    meshAt(torso, G.body, m.body);
    const head = new THREE.Group(); head.position.set(0, 0.98, 0.06); torso.add(head);
    meshAt(head, G.head, m.soft);
    R.eyesAt(head, G, G.H + 0.04);
    const flL = pivot(torso, G.flipper, m.body, [0.38, 0.76, 0.05]);
    const flR = pivot(torso, G.flipLamp, m.body, [-0.38, 0.76, 0.05]);
    R.headHeight = 1.62;
    R.shadowR = 0.55;
    return (st, dt) => {
      const w = st.move, hp = st.happy, s = Math.sin(st.phase);
      torso.position.y = Math.abs(Math.cos(st.phase)) * 0.04 * w + st.hop * 0.5;
      torso.rotation.z = s * 0.1 * w + Math.sin(st.t * 0.8) * 0.025;
      legL.rotation.x = s * 0.6 * w; legR.rotation.x = -s * 0.6 * w;
      flL.rotation.z = 0.35 + Math.sin(st.t * 1.8) * 0.06 + hp * (1.8 + Math.sin(st.t * 14) * 0.4);
      flL.rotation.x = -s * 0.3 * w;
      flR.rotation.z = -0.15 - Math.sin(st.t * 1.8) * 0.04;
      flR.rotation.x = -0.35 + s * 0.15 * w - hp * 0.6;
      head.rotation.x = Math.sin(st.t * 1.2) * 0.04 - hp * 0.12;
      head.rotation.z = Math.sin(st.t * 0.6) * 0.06 * (1 - w) + Math.sin(st.t * 9) * 0.08 * hp;
      head.rotation.y = Math.sin(st.t * 0.4) * 0.2 * (1 - w) * (1 - hp);
    };
  },
};

/** 企鵝類的搖擺走路 */
function waddle(st, torso, flL, flR, footL, footR, rate, size) {
  const w = st.move, hp = st.happy, s = Math.sin(st.phase);
  torso.rotation.z = s * 0.16 * w + Math.sin(st.t * 1.1) * 0.025;
  torso.rotation.x = 0.05 * w;
  torso.position.y = Math.abs(s) * 0.04 * size * w;
  const flap = hp * (0.9 + Math.sin(st.t * 22 * rate) * 0.45);
  flL.rotation.z = 0.25 + Math.abs(s) * 0.25 * w + Math.sin(st.t * 2) * 0.05 + flap;
  flR.rotation.z = -0.25 - Math.abs(s) * 0.25 * w - Math.sin(st.t * 2 + 1) * 0.05 - flap;
  if (footL) {
    footL.position.y = Math.max(0, s) * 0.08 * w;
    footR.position.y = Math.max(0, -s) * 0.08 * w;
    footL.rotation.x = -Math.max(0, s) * 0.4 * w;
    footR.rotation.x = -Math.max(0, -s) * 0.4 * w;
  }
}

// 每種角色的步伐長度（越小 → 同樣速度下步頻越高）與開心跳的高度
const STRIDE = { sheepElder: 0.9, squirrel: 1.0, camel: 1.6, penguinMom: 0.55, penguinChick: 0.35, chick: 0.38, geoBot: 1.2, turtle: 0.6 };
const HOP = { sheepElder: 0.22, squirrel: 0.32, camel: 0.25, penguinMom: 0.2, penguinChick: 0.18, chick: 0.16, geoBot: 0.25, turtle: 0.2 };

export const CHARACTER_KINDS = Object.keys(BUILD);

export function createCharacter(kind) {
  if (!BUILD[kind]) {
    console.warn('[characters] 未知的角色：', kind);
    kind = 'chick';
  }
  const m = mats();
  const object = new THREE.Group();
  object.name = 'character-' + kind;
  const rig = new THREE.Group();
  object.add(rig);

  let eyes = null, happyEyes = null;
  const R = {
    rig, headHeight: 1.5, shadowR: 0.5, shadowLift: 0, blinkLow: 0.12,
    eyesAt(parent, G, y) {
      eyes = meshAt(parent, G.eyes, m.eye, [0, y, 0]);
      happyEyes = meshAt(parent, G.happyEyes, m.eye, [0, y, 0]);
      happyEyes.visible = false;
    },
  };
  const animate = ASSEMBLE[kind](R);
  const shadow = shadowMesh(R.shadowR);
  object.add(shadow);

  const stride = STRIDE[kind] || 0.8;
  const hopH = HOP[kind] || 0.2;
  const st = {
    t: Math.random() * 10, phase: 0, move: 0, speed: 0, happy: 0, happyOn: false, happyT: 0, hop: 0,
    blinkTimer: 1 + Math.random() * 3, blinkT: 0, sq: 0,
  };

  function update(dt, opts) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    const moving = !!(opts && opts.moving);
    const speed = opts && Number.isFinite(opts.speed) ? Math.abs(opts.speed) : (moving ? 3 : 0);
    st.t += dt;
    st.speed = damp(st.speed, moving ? speed : 0, 10, dt);
    st.move = damp(st.move, moving && speed > 0.05 ? clamp(speed / 2.5, 0.35, 1) : 0, 9, dt);
    st.phase += (Math.min(st.speed, 14) * dt / stride) * Math.PI;
    st.happy = damp(st.happy, st.happyOn ? 1 : 0, st.happyOn ? 7 : 4, dt);

    // 開心：連續原地小跳
    if (st.happyOn || st.happyT > 0) {
      st.happyT += dt;
      const k = (st.happyT % 0.56) / 0.56;
      st.hop = Math.sin(k * Math.PI) * hopH;
      if (!st.happyOn && k > 0.95) { st.happyT = 0; st.hop = 0; }
    } else st.hop = 0;

    rig.position.set(0, 0, 0);
    rig.rotation.set(0, 0, 0);
    animate(st, dt);
    if (kind !== 'geoBot') rig.position.y += st.hop * (kind === 'camel' ? 0 : 1);
    // 呼吸 + 跳躍伸縮
    const land = st.happyT > 0 ? Math.max(0, Math.cos((st.happyT % 0.56) / 0.56 * Math.PI * 2)) : 0;
    const sy = 1 + Math.sin(st.t * 2.3) * 0.018 * (1 - st.move) - land * 0.08 * st.happy + st.hop * 0.25;
    const sxz = 1 / Math.sqrt(sy);
    rig.scale.set(sxz, sy, sxz);

    // 眨眼 / 開心眼
    st.blinkTimer -= dt;
    if (st.blinkTimer <= 0) { st.blinkT = 0.12; st.blinkTimer = 1.8 + Math.random() * 3.5; }
    let es = 1;
    if (st.blinkT > 0) { st.blinkT -= dt; es = R.blinkLow; }
    if (eyes) {
      const hv = st.happy > 0.5;
      eyes.visible = !hv;
      happyEyes.visible = hv;
      eyes.scale.y = es;
      happyEyes.scale.setScalar(1 + Math.sin(st.t * 10) * 0.08);
    }
    // 假陰影：跳起時縮小變淡
    const lift = rig.position.y + R.shadowLift;
    const k = clamp(1 - lift * 0.9, 0.55, 1);
    shadow.scale.set(R.shadowR * k, 1, R.shadowR * k);
  }

  function setHappy(on) {
    on = !!on;
    if (on && !st.happyOn) st.happyT = 0.0001;
    st.happyOn = on;
  }

  update(1 / 60, { moving: false, speed: 0 });
  return { object, update, setHappy, headHeight: R.headHeight, kind };
}

// ---------------------------------------------------------------------------
// 任務道具
// ---------------------------------------------------------------------------
const ITEM_GEO = {};
const ITEM_BUILD = {
  pinecone() {
    const list = [P(sph(0.13, 8, 8), 0x6e4226, [1, 1.9, 1], null, [0, 0.27, 0])];
    const L = 6;
    for (let i = 0; i < L; i++) {
      const u = i / (L - 1);
      const r = 0.09 + Math.sin((0.15 + u * 0.75) * Math.PI) * 0.11;
      const y = 0.08 + u * 0.36;
      const n = 7;
      // 一圈往外翹的鱗片
      for (let k = 0; k < n; k++) {
        const a = (k + (i % 2) * 0.5) * (TAU / n);
        list.push(P(sph(0.065, 5, 4), k % 2 ? 0x8f5a32 : 0xa86c3c, [1, 0.55, 1.35], [0.5, a, 0],
          [Math.sin(a) * r * 0.85, y, Math.cos(a) * r * 0.85]));
      }
    }
    list.push(P(cyl(0.02, 0.025, 0.08, 5), 0x5e3a20, null, null, [0, 0.52, 0]));
    list.push(P(sph(0.06, 6, 4), 0x7fd84f, [1.3, 0.3, 0.6], [0, 0, 0.4], [0.05, 0.55, 0]));
    return { main: M(list) };
  },
  starfish() {
    const shape = new THREE.Shape();
    const N = 5, ro = 0.3, ri = 0.13;
    for (let i = 0; i <= N * 2; i++) {
      const a = Math.PI / 2 + (i * Math.PI) / N;
      const r = i % 2 === 0 ? ro : ri;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    const ext = new THREE.ExtrudeGeometry(shape, {
      depth: 0.05, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.035, bevelSegments: 1, curveSegments: 1,
    });
    ext.translate(0, 0, -0.025);
    const list = [P(ext, 0xff8a5c, null, null, [0, 0.29, 0])];
    for (let i = 0; i < N; i++) {
      const a = Math.PI / 2 + (i * TAU) / N;
      for (let j = 1; j <= 2; j++) {
        const r = 0.08 * j;
        list.push(P(sph(0.022, 5, 3), 0xffe2b0, null, null, [Math.cos(a) * r, 0.29 + Math.sin(a) * r, 0.07]));
      }
    }
    list.push(P(sph(0.035, 6, 4), 0xffe2b0, null, null, [0, 0.29, 0.07]));
    const halo = new THREE.CircleGeometry(0.48, 20);
    halo.translate(0, 0.29, -0.06);
    return { main: M(list), halo };
  },
  mapFragment() {
    // 兩片對折、邊緣撕破的羊皮紙，站立成 V 字形
    const make = (sx) => {
      const s = new THREE.Shape();
      const w = 0.24, h = 0.42;
      s.moveTo(0, 0);
      s.lineTo(sx * w * 0.6, 0);
      s.lineTo(sx * w * 0.75, 0.03);
      s.lineTo(sx * w, 0.0);
      s.lineTo(sx * w * 0.93, h * 0.25);
      s.lineTo(sx * w * 1.02, h * 0.45);
      s.lineTo(sx * w * 0.9, h * 0.62);
      s.lineTo(sx * w * 0.98, h * 0.85);
      s.lineTo(sx * w * 0.86, h);
      s.lineTo(sx * w * 0.4, h * 0.96);
      s.lineTo(0, h);
      s.lineTo(0, 0);
      return s;
    };
    const fold = 0.42;
    const paper = [];
    const glow = [];
    const deco = [];
    for (const sx of [-1, 1]) {
      const g = new THREE.ShapeGeometry(make(sx));
      paper.push(P(g, sx < 0 ? 0xf3e1b2 : 0xe9d3a0, null, [0, sx * fold, 0], [0, 0.06, 0]));
      const gg = new THREE.ShapeGeometry(make(sx));
      gg.scale(1.14, 1.08, 1);
      gg.translate(sx * -0.004, -0.017, -0.006);
      glow.push(P(gg, 0xffffff, null, [0, sx * fold, 0], [0, 0.06, 0]));
    }
    // 地圖圖案：綠色小島、藍色波浪、紅色虛線與 X
    const onPanel = (sx, x, y, geo, hex, s = null, r = null) => {
      const g = P(geo, hex, s, r, [sx * x, y + 0.06, 0.008]);
      g.rotateY(sx * fold);
      return g;
    };
    deco.push(onPanel(-1, 0.12, 0.27, sph(0.06, 8, 5), 0x7fc860, [1.3, 1, 0.12]));
    deco.push(onPanel(-1, 0.08, 0.3, sph(0.035, 6, 4), 0x5aa848, [1, 1, 0.12]));
    deco.push(onPanel(-1, 0.13, 0.11, box(0.12, 0.012, 0.004), 0x5aa8d8));
    deco.push(onPanel(-1, 0.1, 0.08, box(0.1, 0.012, 0.004), 0x5aa8d8));
    for (let i = 0; i < 4; i++) deco.push(onPanel(1, 0.04 + i * 0.035, 0.12 + i * 0.045, box(0.022, 0.012, 0.004), 0xd9534f, null, [0, 0, 0.9]));
    deco.push(onPanel(1, 0.17, 0.3, box(0.07, 0.016, 0.004), 0xd9534f, null, [0, 0, 0.785]));
    deco.push(onPanel(1, 0.17, 0.3, box(0.07, 0.016, 0.004), 0xd9534f, null, [0, 0, -0.785]));
    return { paper: M([...paper, ...deco]), glow: M(glow) };
  },
  stationFlag() {
    const list = [
      P(cyl(0.16, 0.19, 0.06, 8), 0x7a8494, null, null, [0, 0.03, 0]),
      P(cyl(0.07, 0.09, 0.05, 8), 0x55606e, null, null, [0, 0.08, 0]),
    ];
    for (let i = 0; i < 5; i++) {
      list.push(P(cyl(0.022, 0.022, 0.13, 6), i % 2 ? 0xff6a3d : 0xffffff, null, null, [0, 0.165 + i * 0.13, 0]));
    }
    // 三角旗
    const tri = new THREE.Shape();
    tri.moveTo(0, 0); tri.lineTo(0.26, -0.08); tri.lineTo(0, -0.17); tri.lineTo(0, 0);
    const flag = new THREE.ExtrudeGeometry(tri, { depth: 0.015, bevelEnabled: false });
    list.push(P(flag, 0xffc93a, null, null, [0.02, 0.84, -0.008]));
    list.push(P(sph(0.035, 6, 4), 0xffc93a, null, null, [0, 0.86, 0]));
    // 量測儀表
    list.push(P(cyl(0.12, 0.12, 0.06, 12), 0x37a39a, null, [Math.PI / 2, 0, 0], [0, 0.48, 0.05]));
    list.push(P(cyl(0.095, 0.095, 0.01, 12), 0xffffff, null, [Math.PI / 2, 0, 0], [0, 0.48, 0.082]));
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * (0.15 + 0.7 * (i / 4));
      list.push(P(box(0.012, 0.025, 0.006), 0x2f3b52, null, [0, 0, a - Math.PI / 2], [Math.cos(a) * 0.075, 0.48 + Math.sin(a) * 0.075, 0.088]));
    }
    list.push(P(box(0.012, 0.075, 0.006), 0xe0453a, null, [0, 0, -0.6], [0.022, 0.51, 0.092]));
    list.push(P(sph(0.015, 6, 4), 0x2f3b52, null, null, [0, 0.48, 0.092]));
    return { main: M(list) };
  },
  iceBlock() {
    // 圓角立方體
    const S = 0.25, Rr = 0.07;
    const g = new THREE.BoxGeometry(2 * S, 2 * S, 2 * S, 3, 3, 3);
    const pos = g.attributes.position;
    const v = new THREE.Vector3(), inner = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      inner.set(clamp(v.x, -S + Rr, S - Rr), clamp(v.y, -S + Rr, S - Rr), clamp(v.z, -S + Rr, S - Rr));
      v.sub(inner);
      if (v.lengthSq() > 1e-9) v.normalize().multiplyScalar(Rr);
      v.add(inner);
      pos.setXYZ(i, v.x, v.y + S, v.z);
    }
    const outer = g.toNonIndexed();
    g.dispose();
    outer.deleteAttribute('uv');
    outer.computeVertexNormals();
    const core = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    core.rotateY(0.3);
    core.translate(0, S - 0.02, 0);
    // 左上角的 L 形反光 + 一顆小星光
    const shine = M([
      P(box(0.035, 0.26, 0.01), 0xffffff, null, null, [-S + 0.06, S + 0.06, S + 0.003]),
      P(box(0.17, 0.035, 0.01), 0xffffff, null, null, [-S + 0.14, 2 * S - 0.06, S + 0.003]),
      P(box(0.03, 0.03, 0.01), 0xffffff, null, null, [0.05, 2 * S - 0.06, S + 0.003]),
      P(box(0.035, 0.01, 0.2), 0xffffff, null, null, [-S + 0.06, 2 * S + 0.003, 0.0]),
    ]);
    return { outer, core, shine };
  },

  // v3：金色橡實（約 0.6 高）——圓胖的金色果實、鱗片狀殼斗、彎彎的小梗與一片綠葉
  goldenAcorn() {
    const G1 = 0xffd84a, G2 = 0xffea8a, C1 = 0xe8a832, C2 = 0xd08f26, C3 = 0xf4bd48;
    const nut = P(lathe([[0, 0.02], [0.05, 0.035], [0.105, 0.08], [0.15, 0.15], [0.172, 0.22], [0.176, 0.29], [0.16, 0.35], [0, 0.35]], 12), G1);
    colorFaces(nut, (x, y, z) => (y < 0.12 ? 0xf2bf2e : (Math.floor(Math.atan2(x, z) / TAU * 12 + 12) % 2 ? G1 : G2)));
    const capG = P(lathe([[0.15, 0.31], [0.2, 0.33], [0.215, 0.37], [0.205, 0.42], [0.165, 0.465], [0.09, 0.495], [0, 0.505]], 12), C1);
    // 殼斗鱗片：依高度與角度交錯上色
    colorFaces(capG, (x, y, z) => {
      const row = Math.floor((y - 0.31) / 0.045);
      const col = Math.floor((Math.atan2(x, z) / TAU + 1) * 12 + row * 0.5);
      return (row + col) % 2 ? C1 : (row % 2 ? C2 : C3);
    });
    const stem = P(cyl(0.022, 0.03, 0.1, 6), C2, null, [0, 0, -0.35], [0.02, 0.545, 0]);
    const stemTip = P(sph(0.026, 6, 4), C2, null, null, [0.04, 0.595, 0]);
    const shine = M([
      P(sph(0.035, 6, 4), 0xffffff, [0.7, 1.4, 0.4], [0, 0, 0.35], [-0.09, 0.25, 0.135]),
      P(sph(0.018, 5, 3), 0xffffff, null, null, [-0.06, 0.155, 0.15]),
    ]);
    // 葉子：兩半折起的葉片 + 葉脈
    const leaf = M([
      P(sph(0.11, 8, 4), 0x7fd84f, [0.5, 0.06, 1], [0.25, 0, 0.35], [0.045, 0, 0.1]),
      P(sph(0.11, 8, 4), 0x9be860, [0.5, 0.06, 1], [0.25, 0, -0.35], [-0.045, 0, 0.1]),
      P(box(0.012, 0.012, 0.2), 0x4f9e3a, null, null, [0, 0.012, 0.1]),
    ]);
    leaf.rotateX(-0.5);
    leaf.rotateY(-0.9);
    leaf.translate(0.04, 0.56, 0.01);
    // 小星光（十字）
    const star = (x, y, z, s) => [
      P(box(s * 0.25, s, s * 0.25), 0xfff6c8, null, [0, 0, 0.785], [x, y, z]),
      P(box(s, s * 0.25, s * 0.25), 0xfff6c8, null, [0, 0, 0.785], [x, y, z]),
    ];
    const sparkle = M([...star(0.22, 0.47, 0.06, 0.07), ...star(-0.21, 0.16, 0.08, 0.05), ...star(0.16, 0.08, -0.12, 0.04)]);
    return { body: M([nut, capG, stem, stemTip]), shine, leaf, sparkle };
  },

  // v3：時光晶石——金色多面晶體（六角雙錐 + 小晶簇）+ 繞著它的時鐘環（12 刻度、指針）
  trialCrystal() {
    const A = 0xffc93a, B = 0xffe58a, D = 0xe9a21f;
    const facet = (x, y, z, i) => (i % 3 === 0 ? B : i % 3 === 1 ? A : D);
    const main = M([
      colorFaces(P(cyl(0.16, 0.16, 0.26, 6), A, null, null, [0, 0.4, 0]), facet),
      colorFaces(P(cone(0.16, 0.24, 6), A, null, null, [0, 0.65, 0]), facet),
      colorFaces(P(cone(0.16, 0.2, 6), A, null, [Math.PI, 0, 0], [0, 0.17, 0]), facet),
      // 旁邊的小晶簇
      colorFaces(P(cyl(0.055, 0.06, 0.14, 5), A, null, [0, 0, 0.5], [0.15, 0.2, 0.04]), facet),
      colorFaces(P(cone(0.055, 0.08, 5), B, null, [0, 0, 0.5], [0.205, 0.3, 0.04]), facet),
      colorFaces(P(cyl(0.045, 0.05, 0.1, 5), A, null, [0.2, 0, -0.55], [-0.14, 0.2, -0.03]), facet),
      colorFaces(P(cone(0.045, 0.07, 5), B, null, [0.2, 0, -0.55], [-0.185, 0.27, -0.04]), facet),
    ]);
    // 時鐘環（在 XZ 平面，原點 = 晶體中心；由 createItem 傾斜放置）
    const ringParts = [P(torus(0.36, 0.022, 4, 36), 0xffd65e, null, [Math.PI / 2, 0, 0])];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const big = i % 3 === 0;
      ringParts.push(P(box(big ? 0.05 : 0.03, big ? 0.05 : 0.03, big ? 0.075 : 0.045), big ? 0xffffff : 0xfff0b8,
        null, [0, a, 0], [Math.sin(a) * 0.36, 0, Math.cos(a) * 0.36]));
    }
    // 12 點鐘位置的小沙漏標記
    ringParts.push(P(cone(0.035, 0.05, 4), 0xffffff, null, [0, 0, 0], [0, 0.04, 0.36]));
    ringParts.push(P(cone(0.035, 0.05, 4), 0xffffff, null, [Math.PI, 0, 0], [0, -0.04, 0.36]));
    const ring = M(ringParts);
    // 晶體表面的時鐘指針（正面），讓它一眼就是「時間」
    const hands = M([
      P(cyl(0.1, 0.1, 0.012, 12), 0xfff8e0, null, [Math.PI / 2, 0, 0], [0, 0.42, 0.142]),
      P(box(0.018, 0.075, 0.012), 0x8a5a12, null, null, [0, 0.452, 0.152]),
      P(box(0.055, 0.016, 0.012), 0x8a5a12, null, null, [0.024, 0.42, 0.152]),
      P(sph(0.014, 6, 4), 0xff6a3d, null, null, [0, 0.42, 0.158]),
    ]);
    return { main, ring, hands };
  },
};

export const ITEM_KINDS = Object.keys(ITEM_BUILD);

export function createItem(kind) {
  const root = new THREE.Group();
  root.name = 'item-' + kind;
  if (!ITEM_BUILD[kind]) {
    console.warn('[characters] 未知的道具：', kind);
    return root;
  }
  if (!ITEM_GEO[kind]) ITEM_GEO[kind] = ITEM_BUILD[kind]();
  const G = ITEM_GEO[kind], m = mats();
  switch (kind) {
    case 'pinecone':
    case 'stationFlag':
      meshAt(root, G.main, m.body);
      break;
    case 'starfish': {
      meshAt(root, G.main, m.starfish);
      const h = meshAt(root, G.halo, m.halo);
      h.renderOrder = 4;
      root.userData.halo = h;
      break;
    }
    case 'mapFragment': {
      const g = meshAt(root, G.glow, m.paperGlow);
      meshAt(root, G.paper, m.paper);
      root.userData.glow = g;
      break;
    }
    case 'iceBlock': {
      meshAt(root, G.core, m.iceCore);
      const o = meshAt(root, G.outer, m.ice);
      o.renderOrder = 2;
      const s = meshAt(root, G.shine, m.iceShine);
      s.renderOrder = 3;
      break;
    }
    case 'goldenAcorn': {
      // userData.halo：發光光暈（Sprite，永遠面向鏡頭），呼叫端可依時間改 opacity/scale 做呼吸效果
      const halo = new THREE.Sprite(m.goldHalo);
      halo.scale.set(0.95, 0.95, 1);
      halo.position.y = 0.32;
      halo.renderOrder = 4;
      root.add(halo);
      meshAt(root, G.body, m.gold);
      meshAt(root, G.leaf, m.leaf);
      meshAt(root, G.shine, m.sparkle);
      const sp = meshAt(root, G.sparkle, m.sparkle);
      root.userData.halo = halo;
      root.userData.sparkle = sp;
      break;
    }
    case 'trialCrystal': {
      // 整個物件可以由呼叫端繞 Y 旋轉；userData.ring 是傾斜的時鐘環（子物件，也可另外轉它的 rotation.y）
      const halo = new THREE.Sprite(m.goldHalo);
      halo.scale.set(1.1, 1.3, 1);
      halo.position.y = 0.42;
      halo.renderOrder = 4;
      root.add(halo);
      meshAt(root, G.main, m.gold);
      meshAt(root, G.hands, m.sparkle);
      const tilt = new THREE.Group();
      tilt.position.y = 0.42;
      tilt.rotation.set(0.42, 0, -0.28);
      root.add(tilt);
      const ring = meshAt(tilt, G.ring, m.sparkle);
      root.userData.halo = halo;
      root.userData.ring = ring;
      break;
    }
    default: break;
  }
  return root;
}
