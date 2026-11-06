// 共用工具：亂數、雜訊、球面數學。所有模組可用，請勿修改既有函式簽名。
import * as THREE from 'three';
import { BIOMES } from './config.js';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 與幀率無關的指數平滑：damp(current, target, lambda, dt) */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** 可重現的亂數產生器，回傳 () => [0,1) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 3D Perlin 雜訊（固定種子，所有模組結果一致） ----
const perm = new Uint8Array(512);
(function initPerm() {
  const rng = mulberry32(1337);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
})();
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function grad(h, x, y, z) {
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}
/** 3D Perlin 雜訊，回傳約 [-1, 1] */
export function noise3(x, y, z) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
  const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
  return lerp(
    lerp(lerp(grad(perm[AA] & 15, x, y, z), grad(perm[BA] & 15, x - 1, y, z), u),
      lerp(grad(perm[AB] & 15, x, y - 1, z), grad(perm[BB] & 15, x - 1, y - 1, z), u), v),
    lerp(lerp(grad(perm[AA + 1] & 15, x, y, z - 1), grad(perm[BA + 1] & 15, x - 1, y, z - 1), u),
      lerp(grad(perm[AB + 1] & 15, x, y - 1, z - 1), grad(perm[BB + 1] & 15, x - 1, y - 1, z - 1), u), v),
    w);
}
/** 分形雜訊（fBm），回傳約 [-1, 1] */
export function fbm3(x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// ---- 球面數學 ----
const _tmp = new THREE.Vector3();

/** 均勻隨機單位向量 */
export function randomUnitVector(rng = Math.random, out = new THREE.Vector3()) {
  const u = rng() * 2 - 1;
  const th = rng() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(th), u, s * Math.sin(th));
}

/** 在 center（單位向量）附近 maxAngle 弧度內取隨機方向 */
export function randomDirNear(center, maxAngle, rng = Math.random, out = new THREE.Vector3()) {
  const c = _tmp.copy(center).normalize();
  const { right, forward } = tangentBasis(c);
  const ang = Math.acos(1 - rng() * (1 - Math.cos(maxAngle)));
  const phi = rng() * Math.PI * 2;
  return out.copy(c).multiplyScalar(Math.cos(ang))
    .addScaledVector(right, Math.sin(ang) * Math.cos(phi))
    .addScaledVector(forward, Math.sin(ang) * Math.sin(phi))
    .normalize();
}

/** 給定地表法線 up（單位向量），回傳一組穩定的切平面基底 */
export function tangentBasis(up, outRight = new THREE.Vector3(), outForward = new THREE.Vector3()) {
  const ref = Math.abs(up.y) < 0.95 ? THREE.Object3D.DEFAULT_UP : new THREE.Vector3(1, 0, 0);
  outRight.crossVectors(ref, up).normalize();
  outForward.crossVectors(up, outRight).normalize();
  return { right: outRight, forward: outForward };
}

/** 把 v 投影到法線為 up 的切平面上（就地修改 v 並回傳） */
export function projectOnTangent(v, up) {
  return v.addScaledVector(up, -v.dot(up));
}

/** 兩個單位方向之間的球面角距離（弧度） */
export function angleBetweenDirs(a, b) {
  return Math.acos(clamp(a.dot(b), -1, 1));
}

/** 讓 object 站在地表：位置 = dir * radius，物體 +Y 對齊 dir，可指定面向切線 facing */
export function placeOnSphere(object, dir, radius, facing = null) {
  const up = _tmp.copy(dir).normalize();
  object.position.copy(up).multiplyScalar(radius);
  const q = new THREE.Quaternion().setFromUnitVectors(THREE.Object3D.DEFAULT_UP, up);
  object.quaternion.copy(q);
  if (facing) {
    const f = facing.clone();
    projectOnTangent(f, up);
    if (f.lengthSq() > 1e-6) {
      f.normalize();
      const m = new THREE.Matrix4();
      const right = new THREE.Vector3().crossVectors(up, f).normalize();
      // 物體本地 +Z 朝 facing
      m.makeBasis(right, up, f);
      object.quaternion.setFromRotationMatrix(m);
    }
  }
  return object;
}

/** 依 id 取生態區設定 */
export function getBiomeById(id) {
  return BIOMES.find((b) => b.id === id);
}

/** 生態區的所有 center（已正規化的 Vector3 陣列） */
export function biomeCenters(biome) {
  return biome.centers.map((c) => new THREE.Vector3(...c).normalize());
}
