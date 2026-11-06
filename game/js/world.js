// 分身 1：世界美術 —— 低多邊形粉彩小星球（地形、海洋、天空、燈光、道具、雲、彩蛋）
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BIOMES, PALETTE, PLANET_RADIUS, SEA_LEVEL, QUALITY, WORLD_SEED, START_BIOME,
} from './config.js';
import { clamp, lerp, smoothstep, damp, mulberry32, noise3, fbm3, randomDirNear, tangentBasis } from './utils.js';

const R = PLANET_RADIUS;
const SEA_H = SEA_LEVEL - R;          // 海面相對基準半徑的高度（負值）
const WADE = SEA_LEVEL - 0.35;        // 涉水地板
const NB = BIOMES.length;

// ---------------------------------------------------------------------------
// 生態區
// ---------------------------------------------------------------------------
const BI = {};
BIOMES.forEach((b, i) => { BI[b.id] = i; });
const BC = BIOMES.map((b) => b.centers.map((c) => new THREE.Vector3(...c).normalize()));
const iMeadow = BI.meadow ?? 0, iForest = BI.forest ?? 1, iDesert = BI.desert ?? 2;
const iPolar = BI.polar ?? 3, iVolcano = BI.volcano ?? 4, iOcean = BI.ocean ?? 5;
const START = BC[BI[START_BIOME] ?? iMeadow][0].clone();
const VOLC = BC[iVolcano][0].clone();
const DESERT = BC[iDesert][0].clone();
const FOREST = BC[iForest][0].clone();
const POLN = BC[iPolar][0].clone();
const POLS = (BC[iPolar][1] || BC[iPolar][0].clone().negate()).clone();
const OCEAN1 = BC[iOcean][0].clone();
const OCEAN2 = (BC[iOcean][1] || BC[iOcean][0]).clone();

/** center 附近 ang 弧度、方位角 azDeg 的方向（穩定的切平面基底） */
function dirAt(center, ang, azDeg, out = new THREE.Vector3()) {
  const { right, forward } = tangentBasis(center);
  const az = (azDeg * Math.PI) / 180;
  return out.copy(center).multiplyScalar(Math.cos(ang))
    .addScaledVector(right, Math.sin(ang) * Math.cos(az))
    .addScaledVector(forward, Math.sin(ang) * Math.sin(az))
    .normalize();
}

// 島嶼（只在海洋區作用）
const ISLANDS = [
  { dir: dirAt(OCEAN1, 0.34, 40), r: 0.115, h: 3.35 },
  { dir: dirAt(OCEAN1, 0.37, 215), r: 0.075, h: 3.0 },
  { dir: dirAt(OCEAN2, 0.15, 120), r: 0.095, h: 3.25 },
];
ISLANDS.forEach((I) => { I.cosR = Math.cos(I.r); I.cosTop = Math.cos(I.r * 0.3); });

// 沙丘方向
const DUNE_AXIS = new THREE.Vector3().crossVectors(DESERT, new THREE.Vector3(0, 1, 0)).normalize();

const SHARP = 16; // 邊界柔和度
const W = new Float64Array(NB);

/** 計算單位方向的生態區權重（寫入 w），回傳最大權重的索引 */
function biomeWeights(x, y, z, w) {
  const px = x + 0.16 * noise3(x * 1.6 + 11.3, y * 1.6 + 2.1, z * 1.6 + 5.7);
  const py = y + 0.16 * noise3(x * 1.6 + 3.9, y * 1.6 + 17.2, z * 1.6 + 8.4);
  const pz = z + 0.16 * noise3(x * 1.6 + 7.5, y * 1.6 + 1.3, z * 1.6 + 19.9);
  const il = 1 / Math.hypot(px, py, pz);
  let best = -1e9, bi = 0;
  for (let i = 0; i < NB; i++) {
    const cs = BC[i];
    let d = -2;
    for (let k = 0; k < cs.length; k++) {
      const c = cs[k];
      const v = (px * c.x + py * c.y + pz * c.z) * il;
      if (v > d) d = v;
    }
    w[i] = d;
    if (d > best) { best = d; bi = i; }
  }
  let sum = 0;
  for (let i = 0; i < NB; i++) { const e = Math.exp(SHARP * (w[i] - best)); w[i] = e; sum += e; }
  for (let i = 0; i < NB; i++) w[i] /= sum;
  return bi;
}

const COS_START_FLAT0 = Math.cos(0.2), COS_START_FLAT1 = Math.cos(0.46);

function hMeadow(x, y, z) {
  const dS = x * START.x + y * START.y + z * START.z;
  const flat = smoothstep(COS_START_FLAT0, COS_START_FLAT1, dS);
  return 0.2 + flat * 0.48 * fbm3(x * 2.2 + 1.7, y * 2.2 + 4.1, z * 2.2 + 0.3, 3);
}
function hForest(x, y, z) {
  return 0.5 + 0.95 * fbm3(x * 2.7 + 5.1, y * 2.7 + 2.2, z * 2.7 + 9.4, 3);
}
function hDesert(x, y, z) {
  const a = x * DUNE_AXIS.x + y * DUNE_AXIS.y + z * DUNE_AXIS.z;
  return 0.3 + 0.3 * Math.sin(22 * a + 2.4 * noise3(x * 1.8, y * 1.8 + 3, z * 1.8)) +
    0.22 * fbm3(x * 2.4 + 7, y * 2.4, z * 2.4 + 2, 2);
}
function hPolar(x, y, z) {
  return 0.32 + 0.42 * fbm3(x * 2.0 + 9, y * 2.0 + 3, z * 2.0 + 1, 3);
}
function volcAngle(x, y, z) {
  return Math.acos(clamp(x * VOLC.x + y * VOLC.y + z * VOLC.z, -1, 1));
}
function hVolcano(x, y, z) {
  const a = volcAngle(x, y, z);
  const base = 0.3 + 4.4 * (1 - smoothstep(0.02, 0.42, a));
  const crater = 2.2 * (1 - smoothstep(0.04, 0.13, a));
  const rough = 0.32 * fbm3(x * 4 + 2, y * 4 + 6, z * 4 + 1, 2) * smoothstep(0.12, 0.26, a);
  return base - crater + rough;
}
function hOcean(x, y, z) {
  let h = -2.6 + 0.6 * fbm3(x * 3 + 13, y * 3 + 1, z * 3 + 5, 3);
  for (let i = 0; i < ISLANDS.length; i++) {
    const I = ISLANDS[i];
    const d = x * I.dir.x + y * I.dir.y + z * I.dir.z;
    if (d > I.cosR) h += I.h * smoothstep(I.cosR, I.cosTop, d);
  }
  return h;
}
const H_FUNCS = [];
H_FUNCS[iMeadow] = hMeadow; H_FUNCS[iForest] = hForest; H_FUNCS[iDesert] = hDesert;
H_FUNCS[iPolar] = hPolar; H_FUNCS[iVolcano] = hVolcano; H_FUNCS[iOcean] = hOcean;

/** 地形高度（相對 R），單位方向的確定性函式；權重同時留在 W */
function terrainHeight(x, y, z) {
  biomeWeights(x, y, z, W);
  let h = 0;
  for (let i = 0; i < NB; i++) {
    if (W[i] > 1e-4 && H_FUNCS[i]) h += W[i] * H_FUNCS[i](x, y, z);
  }
  const dS = x * START.x + y * START.y + z * START.z;
  h += 0.07 * smoothstep(COS_START_FLAT0, COS_START_FLAT1, dS) * noise3(x * 9 + 3.3, y * 9 + 1.1, z * 9 + 7.7);
  return h;
}

// ---------------------------------------------------------------------------
// 二十面體細分格點（自己建，才能精確反查三角形 → getGroundRadius 與網格完全一致）
// ---------------------------------------------------------------------------
const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI],
  [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]]
  .map((v) => new THREE.Vector3(...v).normalize());
const ICO_F = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];

function buildLattice(N) {
  const per = ((N + 1) * (N + 2)) / 2;
  const total = 20 * per;
  const dirs = new Float32Array(total * 3);
  const faces = new Float64Array(20 * 16); // 每面：center(3) n(3) na a(3) e1(3) e2(3)... 見下
  const fd = [];
  const rowStart = new Int32Array(N + 2);
  for (let i = 0; i <= N + 1; i++) rowStart[i] = i * (N + 1) - (i * (i - 1)) / 2;
  const p = new THREE.Vector3();
  for (let f = 0; f < 20; f++) {
    const a = ICO_V[ICO_F[f * 3]], b = ICO_V[ICO_F[f * 3 + 1]], c = ICO_V[ICO_F[f * 3 + 2]];
    const e1 = b.clone().sub(a), e2 = c.clone().sub(a);
    const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
    const center = a.clone().add(b).add(c).normalize();
    const d00 = e1.dot(e1), d01 = e1.dot(e2), d11 = e2.dot(e2);
    fd.push({
      cx: center.x, cy: center.y, cz: center.z, nx: n.x, ny: n.y, nz: n.z, na: n.dot(a),
      ax: a.x, ay: a.y, az: a.z, e1x: e1.x, e1y: e1.y, e1z: e1.z, e2x: e2.x, e2y: e2.y, e2z: e2.z,
      d00, d01, d11, inv: 1 / (d00 * d11 - d01 * d01),
    });
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N - i; j++) {
        p.copy(a).addScaledVector(e1, j / N).addScaledVector(e2, i / N).normalize();
        const k = (f * per + rowStart[i] + j) * 3;
        dirs[k] = p.x; dirs[k + 1] = p.y; dirs[k + 2] = p.z;
      }
    }
  }
  return { N, per, total, dirs, faces: fd, rowStart };
}

/** 找出方向 (x,y,z) 所在的格點三角形，結果寫入 out[0..2]（格點索引） */
function locate(L, x, y, z, out) {
  const fs = L.faces;
  let best = -1e9, bf = 0;
  for (let f = 0; f < 20; f++) {
    const F = fs[f];
    const d = x * F.cx + y * F.cy + z * F.cz;
    if (d > best) { best = d; bf = f; }
  }
  const F = fs[bf];
  const s = F.na / (F.nx * x + F.ny * y + F.nz * z);
  const qx = x * s - F.ax, qy = y * s - F.ay, qz = z * s - F.az;
  const d20 = qx * F.e1x + qy * F.e1y + qz * F.e1z;
  const d21 = qx * F.e2x + qy * F.e2y + qz * F.e2z;
  const N = L.N;
  const fu = (F.d11 * d20 - F.d01 * d21) * F.inv * N;
  const fv = (F.d00 * d21 - F.d01 * d20) * F.inv * N;
  let i = Math.floor(fv); if (i < 0) i = 0; else if (i > N - 1) i = N - 1;
  let j = Math.floor(fu); if (j < 0) j = 0; else if (j > N - 1 - i) j = N - 1 - i;
  const ru = fu - j, rv = fv - i;
  const base = bf * L.per, rs = L.rowStart;
  if (ru + rv <= 1 || j >= N - 1 - i) {
    out[0] = base + rs[i] + j; out[1] = base + rs[i] + j + 1; out[2] = base + rs[i + 1] + j;
  } else {
    out[0] = base + rs[i] + j + 1; out[1] = base + rs[i + 1] + j + 1; out[2] = base + rs[i + 1] + j;
  }
}

/** 射線 (x,y,z) 與格點三角形（頂點 = dir*rad[k]）的交點半徑 */
const _tri = new Int32Array(3);
function latticeRadius(L, rad, x, y, z) {
  locate(L, x, y, z, _tri);
  const D = L.dirs;
  const k0 = _tri[0] * 3, k1 = _tri[1] * 3, k2 = _tri[2] * 3;
  const r0 = rad[_tri[0]], r1 = rad[_tri[1]], r2 = rad[_tri[2]];
  const p0x = D[k0] * r0, p0y = D[k0 + 1] * r0, p0z = D[k0 + 2] * r0;
  const ax = D[k1] * r1 - p0x, ay = D[k1 + 1] * r1 - p0y, az = D[k1 + 2] * r1 - p0z;
  const bx = D[k2] * r2 - p0x, by = D[k2 + 1] * r2 - p0y, bz = D[k2 + 2] * r2 - p0z;
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const t = (nx * p0x + ny * p0y + nz * p0z) / (nx * x + ny * y + nz * z);
  return t * Math.hypot(x, y, z);
}

// ---------------------------------------------------------------------------
// 幾何小工具（頂點色、合併）
// ---------------------------------------------------------------------------
const _col = new THREE.Color();
const _gm = new THREE.Matrix4(), _gq = new THREE.Quaternion(), _ge = new THREE.Euler(),
  _gs = new THREE.Vector3(), _gp = new THREE.Vector3();

function prep(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.uv1) g.deleteAttribute('uv1');
  g.computeVertexNormals();
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  _col.set(color);
  for (let i = 0; i < n; i++) { arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
/** 帶顏色與變換的零件 */
function part(geo, color, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  const g = prep(geo, color);
  _ge.set(rx, ry, rz); _gq.setFromEuler(_ge); _gp.set(px, py, pz); _gs.set(sx, sy, sz);
  _gm.compose(_gp, _gq, _gs);
  g.applyMatrix4(_gm);
  return g;
}
function merge(parts) {
  const g = BufferGeometryUtils.mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return g;
}
/** 以位置雜訊扭曲頂點（同位置同偏移，不會裂開） */
function lumpy(geo, amt, freq, seed) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n1 = noise3(x * freq + seed, y * freq + 1.7, z * freq + 3.1);
    const k = 1 + amt * n1;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  pos.needsUpdate = true;
  return geo;
}

// ---- 道具模型（本地 +Y 向上，+Z 向前，底部在 y=0） ----
const C = (h) => h;
function geoPine() {
  return merge([
    part(new THREE.CylinderGeometry(0.11, 0.16, 0.7, 5), C(0x8a5a3c), 0, 0.2, 0),
    part(new THREE.ConeGeometry(0.78, 1.0, 7), C(0x3f8f53), 0, 0.95, 0),
    part(new THREE.ConeGeometry(0.6, 0.9, 7), C(0x4aa05c), 0, 1.45, 0, 0, 0.4, 0),
    part(new THREE.ConeGeometry(0.4, 0.75, 7), C(0x57b066), 0, 1.92, 0, 0, 0.9, 0),
  ]);
}
function geoTrunk() {
  return merge([part(new THREE.CylinderGeometry(0.11, 0.17, 1.0, 5), C(0x9a6a46), 0, 0.3, 0)]);
}
function geoCanopy() {
  return merge([
    part(lumpy(new THREE.IcosahedronGeometry(0.72, 1), 0.12, 2.2, 1), C(0xffffff), 0, 1.3, 0),
    part(new THREE.IcosahedronGeometry(0.42, 0), C(0xf2f2f2), 0.42, 1.05, 0.2),
    part(new THREE.IcosahedronGeometry(0.36, 0), C(0xf6f6f6), -0.36, 1.12, -0.18),
  ]);
}
function geoFlower() {
  const parts = [part(new THREE.CylinderGeometry(0.025, 0.025, 0.32, 3, 1, true), C(0x5fae4e), 0, 0.12, 0)];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(part(new THREE.TetrahedronGeometry(0.12, 0), C(0xffffff),
      Math.cos(a) * 0.12, 0.3, Math.sin(a) * 0.12, 0.6, -a, 0, 1.1, 0.4, 0.85));
  }
  parts.push(part(new THREE.OctahedronGeometry(0.07, 0), C(0xffd84a), 0, 0.33, 0));
  return merge(parts);
}
function geoGrass() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.3;
    const cone = new THREE.ConeGeometry(0.07, 0.45 - i * 0.06, 3, 1, true);
    parts.push(part(cone, C(0xffffff), Math.cos(a) * 0.07, 0.2, Math.sin(a) * 0.07,
      Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25));
  }
  return merge(parts);
}
function geoRock() {
  const g = lumpy(new THREE.IcosahedronGeometry(0.55, 0), 0.32, 1.7, 4.2);
  return merge([part(g, C(0xffffff), 0, 0.12, 0, 0, 0, 0, 1, 0.68, 1)]);
}
function geoCactus() {
  const green = 0x5fae63, dark = 0x4d9a52;
  return merge([
    part(new THREE.CylinderGeometry(0.24, 0.27, 1.5, 7), C(green), 0, 0.6, 0),
    part(new THREE.SphereGeometry(0.24, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2), C(green), 0, 1.35, 0),
    part(new THREE.CylinderGeometry(0.11, 0.11, 0.42, 6), C(dark), 0.34, 0.75, 0, 0, 0, Math.PI / 2),
    part(new THREE.CylinderGeometry(0.12, 0.12, 0.55, 6), C(green), 0.52, 1.0, 0),
    part(new THREE.SphereGeometry(0.12, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), C(green), 0.52, 1.27, 0),
    part(new THREE.CylinderGeometry(0.1, 0.1, 0.36, 6), C(dark), -0.3, 0.55, 0, 0, 0, Math.PI / 2),
    part(new THREE.CylinderGeometry(0.1, 0.1, 0.4, 6), C(green), -0.45, 0.72, 0),
    part(new THREE.SphereGeometry(0.1, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), C(green), -0.45, 0.92, 0),
    part(new THREE.OctahedronGeometry(0.11, 0), C(0xff7fa8), 0, 1.6, 0, 0, 0, 0, 1, 0.7, 1),
  ]);
}
function geoIceSpike() {
  return merge([
    part(new THREE.ConeGeometry(0.36, 2.0, 5), C(0xa6e6ff), 0, 0.85, 0),
    part(new THREE.ConeGeometry(0.22, 1.2, 5), C(0xe4f8ff), 0.3, 0.45, 0.08, 0, 0, -0.35),
    part(new THREE.ConeGeometry(0.2, 1.0, 5), C(0x86d2f2), -0.26, 0.38, -0.1, 0.2, 0, 0.4),
  ]);
}
function geoPalm() {
  const parts = [];
  let x = 0, y = -0.1;
  for (let i = 0; i < 5; i++) {
    const r = 0.15 - i * 0.015;
    parts.push(part(new THREE.CylinderGeometry(r * 0.9, r, 0.5, 6), C(i % 2 ? 0xc49a63 : 0xb38a55), x, y + 0.25, 0, 0, 0, -0.06 * i));
    x += 0.035 * i; y += 0.48;
  }
  const top = y + 0.05;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const leaf = new THREE.ConeGeometry(0.22, 1.5, 4);
    parts.push(part(leaf, C(i % 2 ? 0x4fb35a : 0x5fc46a),
      x + Math.cos(a) * 0.55, top - 0.15, Math.sin(a) * 0.55, 0, -a, Math.PI / 2 + 0.45, 1, 1, 0.25));
  }
  parts.push(part(new THREE.IcosahedronGeometry(0.12, 0), C(0x7a5232), x + 0.1, top - 0.15, 0.08));
  parts.push(part(new THREE.IcosahedronGeometry(0.12, 0), C(0x7a5232), x - 0.08, top - 0.17, -0.1));
  return merge(parts);
}
function geoMushroom() {
  const parts = [
    part(new THREE.CylinderGeometry(0.1, 0.13, 0.35, 6, 1, true), C(0xfff3dc), 0, 0.17, 0),
    part(new THREE.SphereGeometry(0.3, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2), C(0xe8574c), 0, 0.3, 0, 0, 0, 0, 1, 0.75, 1),
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    parts.push(part(new THREE.OctahedronGeometry(0.055, 0), C(0xffffff), Math.cos(a) * 0.18, 0.45, Math.sin(a) * 0.18));
  }
  parts.push(part(new THREE.OctahedronGeometry(0.065, 0), C(0xffffff), 0, 0.53, 0));
  return merge(parts);
}

// ---- 靜態大型道具（回傳零件陣列，本地座標） ----
function cottageParts(roof, wall) {
  return [
    part(new THREE.BoxGeometry(1.5, 1.9, 1.9), wall, 0, 0.35, 0),
    part(new THREE.CylinderGeometry(1.2, 1.2, 2.35, 3), roof, 0, 1.3 + 0.6 * 0.82, 0, -Math.PI / 2, 0, 0, 1, 1, 0.82),
    part(new THREE.BoxGeometry(0.46, 0.78, 0.08), 0x9a6a44, 0, 0.38, 0.96),
    part(new THREE.BoxGeometry(0.06, 0.06, 0.06), 0xffd35a, 0.14, 0.4, 1.01),
    part(new THREE.BoxGeometry(0.06, 0.36, 0.36), 0xffe08a, 0.76, 0.8, 0.25),
    part(new THREE.BoxGeometry(0.06, 0.36, 0.36), 0xffe08a, -0.76, 0.8, 0.25),
    part(new THREE.BoxGeometry(0.06, 0.36, 0.36), 0xffe08a, 0.76, 0.8, -0.45),
    part(new THREE.BoxGeometry(0.06, 0.36, 0.36), 0xffe08a, -0.76, 0.8, -0.45),
    part(new THREE.BoxGeometry(0.3, 0.75, 0.3), 0xc96f5a, 0.42, 2.05, -0.45),
    part(new THREE.BoxGeometry(1.2, 0.12, 0.3), 0x8a5a3c, 0, 0.62, 1.12), // 窗台/花台
    part(new THREE.IcosahedronGeometry(0.12, 0), 0xff8fb0, -0.42, 0.74, 1.14),
    part(new THREE.IcosahedronGeometry(0.12, 0), 0xffd84a, 0.42, 0.74, 1.14),
  ];
}
function windmillParts() {
  return [
    part(new THREE.CylinderGeometry(0.58, 0.9, 3.5, 8), 0xfff1dc, 0, 1.4, 0),
    part(new THREE.ConeGeometry(0.8, 1.0, 8), 0xe2574c, 0, 3.65, 0),
    part(new THREE.BoxGeometry(0.42, 0.75, 0.1), 0x9a6a44, 0, 0.36, 0.86),
    part(new THREE.BoxGeometry(0.3, 0.3, 0.1), 0x7cc6ff, 0, 2.1, 0.66),
    part(new THREE.BoxGeometry(0.22, 0.22, 0.5), 0x8a5a3c, 0, 2.95, 0.65),
  ];
}
function bladeGeo() {
  const parts = [part(new THREE.CylinderGeometry(0.16, 0.16, 0.18, 8), 0xe2574c, 0, 0, 0, Math.PI / 2, 0, 0)];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const arm = part(new THREE.BoxGeometry(0.1, 1.9, 0.06), 0x8a5a3c, 0, 1.0, 0);
    const sail = part(new THREE.BoxGeometry(0.46, 1.45, 0.04), 0xfdf8ef, 0.3, 1.15, 0.02);
    _gm.makeRotationZ(a);
    arm.applyMatrix4(_gm); sail.applyMatrix4(_gm);
    parts.push(arm, sail);
  }
  return merge(parts);
}
function rocketParts() {
  const parts = [
    part(new THREE.CylinderGeometry(2.1, 2.35, 0.7, 10), 0xb9b9c4, 0, 0, 0),
    part(new THREE.CylinderGeometry(1.0, 1.0, 0.12, 10), 0xffd35a, 0, 0.38, 0),
    part(new THREE.CylinderGeometry(0.42, 0.5, 2.4, 10), 0xfafafa, 0, 1.6, 0),
    part(new THREE.ConeGeometry(0.42, 0.9, 10), 0xe8574c, 0, 3.25, 0),
    part(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 10), 0x6ec6ff, 0, 2.25, 0.44, Math.PI / 2 - 0.08, 0, 0),
    part(new THREE.CylinderGeometry(0.3, 0.42, 0.3, 10), 0x777788, 0, 0.32, 0),
    part(new THREE.BoxGeometry(0.16, 4.0, 0.16), 0xe08a3c, 1.3, 1.9, 0.38),
    part(new THREE.BoxGeometry(0.16, 4.0, 0.16), 0xe08a3c, 1.3, 1.9, -0.38),
    part(new THREE.BoxGeometry(0.8, 0.1, 0.12), 0xe08a3c, 0.9, 2.7, 0),
  ];
  for (let i = 0; i < 4; i++) parts.push(part(new THREE.BoxGeometry(0.1, 0.1, 0.76), 0xe08a3c, 1.3, 0.6 + i * 0.95, 0));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    parts.push(part(new THREE.BoxGeometry(0.08, 0.7, 0.55), 0xe8574c, Math.sin(a) * 0.55, 0.75, Math.cos(a) * 0.55, 0, a, 0));
  }
  return parts;
}
function snowmanParts() {
  return [
    part(new THREE.IcosahedronGeometry(0.72, 1), 0xffffff, 0, 0.5, 0),
    part(new THREE.IcosahedronGeometry(0.52, 1), 0xfbfdff, 0, 1.3, 0),
    part(new THREE.IcosahedronGeometry(0.38, 1), 0xffffff, 0, 1.95, 0),
    part(new THREE.ConeGeometry(0.08, 0.42, 5), 0xff8a3d, 0, 1.94, 0.52, Math.PI / 2, 0, 0),
    part(new THREE.IcosahedronGeometry(0.055, 0), 0x2c3440, 0.13, 2.05, 0.33),
    part(new THREE.IcosahedronGeometry(0.055, 0), 0x2c3440, -0.13, 2.05, 0.33),
    part(new THREE.IcosahedronGeometry(0.06, 0), 0x2c3440, 0, 1.4, 0.5),
    part(new THREE.IcosahedronGeometry(0.06, 0), 0x2c3440, 0, 1.2, 0.51),
    part(new THREE.CylinderGeometry(0.26, 0.26, 0.38, 8), 0x2c3440, 0, 2.45, 0),
    part(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 8), 0x2c3440, 0, 2.27, 0),
    part(new THREE.CylinderGeometry(0.27, 0.27, 0.08, 8), 0xe8574c, 0, 2.33, 0),
    part(new THREE.CylinderGeometry(0.4, 0.44, 0.14, 8), 0xe8574c, 0, 1.68, 0),
    part(new THREE.BoxGeometry(0.14, 0.42, 0.06), 0xe8574c, 0.2, 1.48, 0.38, 0.2, 0, 0.2),
    part(new THREE.CylinderGeometry(0.03, 0.04, 0.9, 4), 0x7a5232, 0.75, 1.5, 0, 0, 0, -1.0),
    part(new THREE.CylinderGeometry(0.03, 0.04, 0.9, 4), 0x7a5232, -0.75, 1.5, 0, 0, 0, 1.0),
  ];
}
// 彩蛋 1：沙漠中半埋的巨大古生物化石
function fossilParts() {
  const bone = 0xf4ecd8, parts = [];
  for (let i = 0; i < 11; i++) {
    const x = -3.4 + i * 0.68;
    const y = 0.15 + 0.35 * Math.sin((i / 10) * Math.PI) - (i < 2 ? 0.25 : 0);
    parts.push(part(new THREE.IcosahedronGeometry(0.26 - Math.abs(i - 6) * 0.012, 0), bone, x, y, 0));
    if (i >= 3 && i <= 8) {
      for (const s of [-1, 1]) {
        parts.push(part(new THREE.CylinderGeometry(0.07, 0.06, 1.15, 4), bone, x, y + 0.2, s * 0.42, s * 0.95, 0, 0));
        parts.push(part(new THREE.CylinderGeometry(0.06, 0.05, 0.9, 4), bone, x, y - 0.25, s * 0.95, s * 2.4, 0, 0));
      }
    }
  }
  parts.push(part(new THREE.IcosahedronGeometry(0.62, 0), bone, 4.0, 0.4, 0, 0, 0, -0.25, 1.45, 0.8, 0.9));
  parts.push(part(new THREE.BoxGeometry(1.0, 0.18, 0.6), bone, 4.4, 0.0, 0, 0, 0, -0.35));
  parts.push(part(new THREE.IcosahedronGeometry(0.13, 0), 0x5b4a3e, 4.15, 0.6, 0.42));
  parts.push(part(new THREE.IcosahedronGeometry(0.13, 0), 0x5b4a3e, 4.15, 0.6, -0.42));
  for (let i = 0; i < 4; i++) parts.push(part(new THREE.ConeGeometry(0.06, 0.2, 4), 0xfffaf0, 4.5 + i * 0.16, 0.12, 0.22, Math.PI, 0, 0));
  return parts;
}
// 彩蛋 2：島上的瓶中信 + 藏寶的 X
function bottleParts() {
  return [
    part(new THREE.CylinderGeometry(0.18, 0.18, 0.62, 8), 0x9fe3c8, 0, 0.16, 0, 0, 0, Math.PI / 2 - 0.12),
    part(new THREE.CylinderGeometry(0.07, 0.15, 0.25, 8), 0x9fe3c8, 0.42, 0.21, 0, 0, 0, Math.PI / 2 - 0.12),
    part(new THREE.CylinderGeometry(0.065, 0.065, 0.12, 6), 0x9a6a44, 0.58, 0.23, 0, 0, 0, Math.PI / 2 - 0.12),
    part(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 6), 0xfff6dc, -0.1, 0.06, 0.45, Math.PI / 2, 0.5, 0),
    part(new THREE.CylinderGeometry(0.085, 0.085, 0.08, 6), 0xe8574c, -0.1, 0.06, 0.45, Math.PI / 2, 0.5, 0),
    part(new THREE.BoxGeometry(1.1, 0.06, 0.16), 0xc9a26a, 1.6, 0.0, -0.9, 0, 0.785, 0),
    part(new THREE.BoxGeometry(1.1, 0.06, 0.16), 0xc9a26a, 1.6, 0.0, -0.9, 0, -0.785, 0),
  ];
}
// 彩蛋 3：南極的冰屋與企鵝一家
function iglooParts() {
  return [
    part(new THREE.SphereGeometry(1.35, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), 0xf4faff, 0, -0.05, 0),
    part(new THREE.BoxGeometry(0.95, 0.9, 1.0), 0xeaf5fc, 0, 0.4, 1.3),
    part(new THREE.BoxGeometry(0.55, 0.6, 0.06), 0x3b5a7a, 0, 0.32, 1.81),
    part(new THREE.IcosahedronGeometry(0.16, 0), 0xa8d8f0, 0.5, 1.15, 0.6),
  ];
}
function penguinParts(s, x, z, yaw) {
  const parts = [
    part(new THREE.IcosahedronGeometry(0.34, 1), 0x2c3440, 0, 0.45, 0, 0, 0, 0, 1, 1.35, 0.92),
    part(new THREE.IcosahedronGeometry(0.27, 1), 0xffffff, 0, 0.4, 0.13, 0, 0, 0, 0.92, 1.2, 0.62),
    part(new THREE.ConeGeometry(0.07, 0.2, 4), 0xff9a3d, 0, 0.78, 0.33, Math.PI / 2, 0, 0),
    part(new THREE.IcosahedronGeometry(0.045, 0), 0xffffff, 0.11, 0.86, 0.26),
    part(new THREE.IcosahedronGeometry(0.045, 0), 0xffffff, -0.11, 0.86, 0.26),
    part(new THREE.BoxGeometry(0.14, 0.04, 0.2), 0xff9a3d, 0.1, 0.02, 0.1),
    part(new THREE.BoxGeometry(0.14, 0.04, 0.2), 0xff9a3d, -0.1, 0.02, 0.1),
    part(new THREE.IcosahedronGeometry(0.16, 0), 0x2c3440, 0.32, 0.45, 0, 0, 0, 0.3, 0.35, 1.3, 0.8),
    part(new THREE.IcosahedronGeometry(0.16, 0), 0x2c3440, -0.32, 0.45, 0, 0, 0, -0.3, 0.35, 1.3, 0.8),
  ];
  _ge.set(0, yaw, 0); _gq.setFromEuler(_ge);
  _gm.compose(_gp.set(x, 0, z), _gq, _gs.set(s, s, s));
  parts.forEach((p) => p.applyMatrix4(_gm));
  return parts;
}
function cloudGeo(rng) {
  const parts = [];
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const r = 0.8 + rng() * 0.7 - Math.abs(i - (n - 1) / 2) * 0.15;
    const x = (i - (n - 1) / 2) * 0.95 + (rng() - 0.5) * 0.3;
    parts.push(part(new THREE.IcosahedronGeometry(r, 1), i % 2 ? 0xffffff : 0xf8fbff, x, r * 0.35, (rng() - 0.5) * 0.7, 0, 0, 0, 1, 0.78, 1));
  }
  parts.push(part(new THREE.IcosahedronGeometry(0.9, 1), 0xe3ebfa, 0, -0.05, 0, 0, 0, 0, n * 0.55, 0.35, 0.9));
  return merge(parts);
}
function whaleGeo() {
  const blue = 0x5b7fc0, belly = 0xe4ecf6;
  return merge([
    part(new THREE.IcosahedronGeometry(1, 1), blue, 0, 0, 0, 0, 0, 0, 0.85, 0.7, 1.7),
    part(new THREE.IcosahedronGeometry(1, 1), belly, 0, -0.25, 0.25, 0, 0, 0, 0.7, 0.45, 1.35),
    part(new THREE.ConeGeometry(0.35, 1.2, 5), blue, 0, 0.05, -1.95, -Math.PI / 2, 0, 0, 1, 1, 0.7),
    part(new THREE.BoxGeometry(1.5, 0.08, 0.45), blue, 0, 0.05, -2.55, 0, 0, 0),
    part(new THREE.BoxGeometry(0.6, 0.06, 0.3), blue, 0.75, -0.35, 0.4, 0, 0.5, -0.4),
    part(new THREE.BoxGeometry(0.6, 0.06, 0.3), blue, -0.75, -0.35, 0.4, 0, -0.5, 0.4),
    part(new THREE.IcosahedronGeometry(0.09, 0), 0x1f2633, 0.62, 0.05, 1.05),
    part(new THREE.IcosahedronGeometry(0.09, 0), 0x1f2633, -0.62, 0.05, 1.05),
    part(new THREE.IcosahedronGeometry(0.1, 0), 0xffa3b8, 0.6, -0.12, 1.12, 0, 0, 0, 1, 0.5, 0.5),
    part(new THREE.IcosahedronGeometry(0.1, 0), 0xffa3b8, -0.6, -0.12, 1.12, 0, 0, 0, 1, 0.5, 0.5),
  ]);
}
function spoutGeo() {
  const parts = [part(new THREE.CylinderGeometry(0.12, 0.06, 1.6, 6, 1, true), 0xffffff, 0, 0.8, 0)];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    parts.push(part(new THREE.IcosahedronGeometry(0.18, 0), 0xffffff, Math.cos(a) * 0.35, 1.65 - (i % 2) * 0.15, Math.sin(a) * 0.35));
  }
  parts.push(part(new THREE.IcosahedronGeometry(0.26, 0), 0xffffff, 0, 1.75, 0));
  return merge(parts);
}

// 去飽和（恢復度）注入
const DESAT_CHUNK = `#include <dithering_fragment>
{ float tewL = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor.rgb = max(mix(vec3(tewL), gl_FragColor.rgb, uSat), 0.0); }`;

// ---------------------------------------------------------------------------
export function createWorld({ scene, renderer, quality = 'high' } = {}) {
  const q = QUALITY[quality] ? quality : 'high';
  const decoScale = QUALITY[q].props;   // 只縮放「裝飾」密度；障礙物在各畫質下都一樣（玩法一致）
  const N = q === 'low' ? 32 : 48;
  const NW = q === 'low' ? 20 : 28;

  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);

  // ---- 共用 uniform ----
  const uSat = { value: 0.45 };
  const uTime = { value: 0 };
  let restoreCur = 0, restoreTarget = 0;

  function patch(mat) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSat = uSat;
      shader.fragmentShader = 'uniform float uSat;\n' +
        shader.fragmentShader.replace('#include <dithering_fragment>', DESAT_CHUNK);
    };
    return mat;
  }

  // ---- 材質 ----
  const terrainMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  const propMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  const cloudMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x8a96aa, emissiveIntensity: 0.55 }));
  const lavaMat = patch(new THREE.MeshBasicMaterial({ color: 0xff7a3d }));
  const spoutMat = patch(new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xe8f8ff, transparent: true, opacity: 0.85, depthWrite: false }));

  // =========================================================================
  // 地形
  // =========================================================================
  const L = buildLattice(N);
  const HR = new Float32Array(L.total);           // 頂點半徑（海床）
  const WV = new Float32Array(L.total * NB);      // 頂點生態區權重
  for (let k = 0; k < L.total; k++) {
    const x = L.dirs[k * 3], y = L.dirs[k * 3 + 1], z = L.dirs[k * 3 + 2];
    HR[k] = R + terrainHeight(x, y, z);
    for (let b = 0; b < NB; b++) WV[k * NB + b] = W[b];
  }

  /** 渲染網格在 dir 方向的半徑（未夾涉水） */
  function seabed(x, y, z) { return latticeRadius(L, HR, x, y, z); }

  // 顏色
  const CL = (h) => new THREE.Color(h);
  const COL = {
    meadowA: CL(0x8fd16a), meadowB: CL(0xa9df7c), meadowY: CL(0xd9e98a),
    forestA: CL(0x4f9e5a), forestB: CL(0x3f8a4f), forestH: CL(0x6cb565),
    desertA: CL(0xe9c77b), desertB: CL(0xf3d891), desertC: CL(0xdcb168),
    polarA: CL(0xf4f9fc), polarB: CL(0xc2e2f4),
    volcGlow: CL(0xd8623c), volcDark: CL(0x5b4b48), volcLow: CL(0x84726a), volcMoss: CL(0x8a9a6a),
    sand: CL(0xf3e3ae), seabed: CL(0xd8c79a), seabedDeep: CL(0xa9b79a), islandGreen: CL(0x9bd46e),
    ice: CL(0xd8eef8),
  };
  const _bc = new THREE.Color(), _acc = new THREE.Color();
  function biomeColor(b, x, y, z, h, out) {
    switch (b) {
      case iMeadow: {
        const n = noise3(x * 6 + 1, y * 6 + 2, z * 6 + 3);
        out.lerpColors(COL.meadowA, COL.meadowB, clamp(0.5 + n * 1.2, 0, 1));
        const p = noise3(x * 3.5 + 8, y * 3.5 + 8, z * 3.5 + 8);
        if (p > 0.22) out.lerp(COL.meadowY, smoothstep(0.22, 0.42, p) * 0.65);
        break;
      }
      case iForest: {
        const n = noise3(x * 5 + 4, y * 5 + 1, z * 5 + 2);
        out.lerpColors(COL.forestA, COL.forestB, clamp(0.5 + n * 1.3, 0, 1));
        if (h > 0.9) out.lerp(COL.forestH, smoothstep(0.9, 1.4, h) * 0.6);
        break;
      }
      case iDesert: {
        const n = noise3(x * 5 + 2, y * 5 + 7, z * 5 + 1);
        out.lerpColors(COL.desertA, COL.desertB, clamp(0.5 + n * 1.2, 0, 1));
        if (h < 0.15) out.lerp(COL.desertC, smoothstep(0.15, -0.1, h) * 0.6);
        break;
      }
      case iPolar: {
        const n = noise3(x * 4 + 6, y * 4 + 2, z * 4 + 9);
        out.lerpColors(COL.polarA, COL.polarB, smoothstep(-0.05, 0.3, n));
        break;
      }
      case iVolcano: {
        const a = volcAngle(x, y, z);
        if (a < 0.12) out.lerpColors(COL.volcGlow, COL.volcDark, smoothstep(0.06, 0.12, a));
        else {
          out.lerpColors(COL.volcDark, COL.volcLow, smoothstep(0.12, 0.38, a));
          const n = noise3(x * 5 + 3, y * 5 + 3, z * 5 + 3);
          if (a > 0.3 && n > 0.1) out.lerp(COL.volcMoss, smoothstep(0.3, 0.45, a) * 0.6);
        }
        break;
      }
      default: { // ocean
        if (h > SEA_H + 0.35) out.lerpColors(COL.sand, COL.islandGreen, smoothstep(SEA_H + 0.35, SEA_H + 0.65, h));
        else out.lerpColors(COL.seabed, COL.seabedDeep, smoothstep(-0.6, -2.4, h));
      }
    }
    return out;
  }

  const triCount = 20 * N * N;
  const tPos = new Float32Array(triCount * 9);
  const tCol = new Float32Array(triCount * 9);
  {
    const jr = mulberry32(WORLD_SEED ^ 0x5151);
    const D = L.dirs, rs = L.rowStart;
    let t = 0;
    const wsum = new Float64Array(NB);
    const emit = (k0, k1, k2) => {
      // 確保外向
      let a = k0, b = k1, c = k2;
      const ax = D[a * 3] * HR[a], ay = D[a * 3 + 1] * HR[a], az = D[a * 3 + 2] * HR[a];
      const bx = D[b * 3] * HR[b], by = D[b * 3 + 1] * HR[b], bz = D[b * 3 + 2] * HR[b];
      const cx = D[c * 3] * HR[c], cy = D[c * 3 + 1] * HR[c], cz = D[c * 3 + 2] * HR[c];
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const flip = nx * (ax + bx + cx) + ny * (ay + by + cy) + nz * (az + bz + cz) < 0;
      const o = t * 9;
      tPos[o] = ax; tPos[o + 1] = ay; tPos[o + 2] = az;
      if (flip) {
        tPos[o + 3] = cx; tPos[o + 4] = cy; tPos[o + 5] = cz; tPos[o + 6] = bx; tPos[o + 7] = by; tPos[o + 8] = bz;
      } else {
        tPos[o + 3] = bx; tPos[o + 4] = by; tPos[o + 5] = bz; tPos[o + 6] = cx; tPos[o + 7] = cy; tPos[o + 8] = cz;
      }
      // 顏色
      let mx = D[a * 3] + D[b * 3] + D[c * 3], my = D[a * 3 + 1] + D[b * 3 + 1] + D[c * 3 + 1], mz = D[a * 3 + 2] + D[b * 3 + 2] + D[c * 3 + 2];
      const il = 1 / Math.hypot(mx, my, mz); mx *= il; my *= il; mz *= il;
      const h = (HR[a] + HR[b] + HR[c]) / 3 - R;
      _acc.setRGB(0, 0, 0);
      for (let i = 0; i < NB; i++) wsum[i] = (WV[a * NB + i] + WV[b * NB + i] + WV[c * NB + i]) / 3;
      for (let i = 0; i < NB; i++) {
        if (wsum[i] < 0.01) continue;
        biomeColor(i, mx, my, mz, h, _bc);
        _acc.r += _bc.r * wsum[i]; _acc.g += _bc.g * wsum[i]; _acc.b += _bc.b * wsum[i];
      }
      // 沙灘 / 冰岸
      const nonOcean = 1 - wsum[iOcean];
      const beach = (1 - smoothstep(SEA_H + 0.12, SEA_H + 0.38, h)) * nonOcean;
      if (beach > 0) {
        const icy = wsum[iPolar];
        _bc.copy(COL.sand).lerp(COL.ice, icy);
        _acc.lerp(_bc, beach * (1 - wsum[iVolcano]));
      }
      const j = 0.95 + jr() * 0.09;
      for (let v = 0; v < 3; v++) {
        tCol[o + v * 3] = _acc.r * j; tCol[o + v * 3 + 1] = _acc.g * j; tCol[o + v * 3 + 2] = _acc.b * j;
      }
      t++;
    };
    for (let f = 0; f < 20; f++) {
      const base = f * L.per;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N - i; j++) {
          emit(base + rs[i] + j + 1, base + rs[i + 1] + j, base + rs[i] + j);
          if (j < N - 1 - i) emit(base + rs[i] + j + 1, base + rs[i + 1] + j + 1, base + rs[i + 1] + j);
        }
      }
    }
  }
  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
  terrainGeo.computeVertexNormals();
  terrainGeo.computeBoundingSphere();
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.name = 'terrain';
  root.add(terrain);

  // =========================================================================
  // 公開的地表查詢
  // =========================================================================
  function getGroundRadius(dir) {
    const r = seabed(dir.x, dir.y, dir.z);
    return r < WADE ? WADE : r;
  }
  function getSurfacePoint(dir, offset = 0, out = new THREE.Vector3()) {
    const r = getGroundRadius(dir) + offset;
    return out.copy(dir).normalize().multiplyScalar(r);
  }
  const _wb = new Float64Array(NB);
  function getBiome(dir) {
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    return BIOMES[biomeWeights(dir.x / l, dir.y / l, dir.z / l, _wb)];
  }
  function isWater(dir) { return seabed(dir.x, dir.y, dir.z) < SEA_LEVEL; }

  const obstacles = [];
  const _fp = new THREE.Vector3();
  function freeAt(dir, ground, clearance) {
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const k = ground / l;
    const px = dir.x * k, py = dir.y * k, pz = dir.z * k;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const dx = o.position.x - px, dy = o.position.y - py, dz = o.position.z - pz;
      const rr = o.radius + clearance;
      if (dx * dx + dy * dy + dz * dz < rr * rr) return false;
    }
    return true;
  }
  function isFree(dir, clearance = 0) {
    const sb = seabed(dir.x, dir.y, dir.z);
    if (sb < WADE) return false; // 深水
    return freeAt(dir, sb, clearance);
  }
  function addObstacle(dir, radius) {
    const p = new THREE.Vector3().copy(dir).normalize();
    p.multiplyScalar(getGroundRadius(p));
    obstacles.push({ position: p, radius });
  }

  // =========================================================================
  // 海洋
  // =========================================================================
  let water;
  {
    const LW = buildLattice(NW);
    const depth = new Float32Array(LW.total);
    for (let k = 0; k < LW.total; k++) {
      depth[k] = SEA_LEVEL - seabed(LW.dirs[k * 3], LW.dirs[k * 3 + 1], LW.dirs[k * 3 + 2]);
    }
    const pos = [], col = [], dep = [];
    const cShallow = CL(0x8fe3ef), cMid = CL(PALETTE.water), cDeep = CL(PALETTE.waterDeep);
    const D = LW.dirs, rs = LW.rowStart;
    const pushV = (k) => {
      pos.push(D[k * 3] * SEA_LEVEL, D[k * 3 + 1] * SEA_LEVEL, D[k * 3 + 2] * SEA_LEVEL);
      const d = depth[k];
      if (d < 0.8) _bc.lerpColors(cShallow, cMid, smoothstep(0, 0.8, d));
      else _bc.lerpColors(cMid, cDeep, smoothstep(0.8, 2.4, d));
      col.push(_bc.r, _bc.g, _bc.b);
      dep.push(d);
    };
    const tri = (a, b, c) => {
      if (Math.max(depth[a], depth[b], depth[c]) < -0.5) return; // 完全在陸地下
      // 外向
      const ax = D[a * 3], ay = D[a * 3 + 1], az = D[a * 3 + 2];
      const ux = D[b * 3] - ax, uy = D[b * 3 + 1] - ay, uz = D[b * 3 + 2] - az;
      const vx = D[c * 3] - ax, vy = D[c * 3 + 1] - ay, vz = D[c * 3 + 2] - az;
      const s = (uy * vz - uz * vy) * ax + (uz * vx - ux * vz) * ay + (ux * vy - uy * vx) * az;
      pushV(a); if (s < 0) { pushV(c); pushV(b); } else { pushV(b); pushV(c); }
    };
    for (let f = 0; f < 20; f++) {
      const base = f * LW.per;
      for (let i = 0; i < NW; i++) {
        for (let j = 0; j < NW - i; j++) {
          tri(base + rs[i] + j + 1, base + rs[i + 1] + j, base + rs[i] + j);
          if (j < NW - 1 - i) tri(base + rs[i] + j + 1, base + rs[i + 1] + j + 1, base + rs[i + 1] + j);
        }
      }
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    wg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    wg.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1));
    wg.computeVertexNormals();
    wg.computeBoundingSphere();
    const waterMat = new THREE.MeshPhongMaterial({
      vertexColors: true, flatShading: true, transparent: true, opacity: 1,
      shininess: 45, specular: 0x4a6070, depthWrite: false,
    });
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uSat = uSat;
      shader.uniforms.uTime = uTime;
      shader.vertexShader = 'uniform float uTime;\nattribute float aDepth;\nvarying float vDepth;\nvarying float vWave;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  vDepth = aDepth;
  {
    vec3 tewN = normalize(position);
    float w = sin(uTime * 1.3 + position.x * 0.55 + position.y * 0.35) * 0.5
            + sin(uTime * 1.9 + position.z * 0.6 - position.x * 0.3) * 0.5;
    transformed += tewN * w * 0.07;
    vWave = w;
  }`);
      shader.fragmentShader = 'uniform float uSat;\nuniform float uTime;\nvarying float vDepth;\nvarying float vWave;\n' +
        shader.fragmentShader
          .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float foamEdge = 0.32 + 0.12 * sin(uTime * 2.2 + vWave * 3.0);
    float foam = 1.0 - smoothstep(0.02, foamEdge, vDepth);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), foam * 0.8);
    diffuseColor.rgb += vec3(0.05, 0.07, 0.08) * smoothstep(0.55, 1.0, vWave);
    diffuseColor.a = mix(0.5, 0.9, smoothstep(0.1, 1.6, vDepth));
    diffuseColor.a = max(diffuseColor.a, foam * 0.92);
  }`)
          .replace('#include <dithering_fragment>', DESAT_CHUNK);
    };
    water = new THREE.Mesh(wg, waterMat);
    water.name = 'water';
    water.renderOrder = 2;
    root.add(water);
  }

  // =========================================================================
  // 天空
  // =========================================================================
  const skyUniforms = {
    uTop: { value: CL(PALETTE.skyTop) },
    uBottom: { value: CL(PALETTE.skyBottom) },
    uSunCol: { value: CL(PALETTE.sun) },
    uCam: { value: new THREE.Vector3(0, 0, 90) },
    uSun: { value: new THREE.Vector3(0.4, 0.6, 0.7).normalize() },
    uPlanetR: { value: R + 0.6 },
    uSat,
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: `varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
    fragmentShader: `uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uSunCol; uniform vec3 uCam; uniform vec3 uSun;
uniform float uPlanetR; uniform float uSat;
varying vec3 vWorld;
void main() {
  vec3 rd = normalize(vWorld - uCam);
  float dist = max(length(uCam), uPlanetR + 0.01);
  vec3 toC = -uCam / dist;
  float th = acos(clamp(dot(rd, toC), -1.0, 1.0));
  float alpha = asin(clamp(uPlanetR / dist, 0.0, 1.0));
  float g = clamp((th - alpha) / 0.75, 0.0, 1.0);
  g = smoothstep(0.0, 1.0, pow(g, 0.7));
  vec3 col = mix(uBottom, uTop, g);
  float s = max(dot(rd, uSun), 0.0);
  col += uSunCol * (pow(s, 90.0) * 0.55 + pow(s, 10.0) * 0.12);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  float tewL = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor.rgb = mix(vec3(tewL), gl_FragColor.rgb, clamp(0.35 + uSat * 0.65, 0.0, 1.05));
}`,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 16), skyMat);
  sky.name = 'sky';
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  root.add(sky);

  // =========================================================================
  // 燈光
  // =========================================================================
  const hemi = new THREE.HemisphereLight(0xdcefff, 0xffdcb8, 1.05);
  const sun = new THREE.DirectionalLight(PALETTE.sun, 2.7);
  sun.position.set(40, 60, 70);
  root.add(hemi, sun, sun.target);

  // =========================================================================
  // 道具擺放
  // =========================================================================
  const _up = new THREE.Vector3(), _fw = new THREE.Vector3(), _rt = new THREE.Vector3(), _tmpv = new THREE.Vector3();
  const _bm = new THREE.Matrix4(), _bq = new THREE.Quaternion(), _bp = new THREE.Vector3(), _bs = new THREE.Vector3();

  /** 方向 dir、朝向（yaw 或指向 lookDir）、縮放 → 寫入 out 的 Matrix4 */
  function surfaceMatrix(dir, yaw, sx, sy, sz, sink, out, lookDir = null, radius = null) {
    _up.copy(dir).normalize();
    if (lookDir) {
      _fw.copy(lookDir).addScaledVector(_up, -lookDir.dot(_up));
      if (_fw.lengthSq() < 1e-8) tangentBasis(_up, _rt, _fw);
      _fw.normalize();
    } else {
      tangentBasis(_up, _rt, _fw);
    }
    _rt.crossVectors(_up, _fw).normalize();
    if (yaw) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      _tmpv.copy(_fw).multiplyScalar(c).addScaledVector(_rt, s);
      _rt.multiplyScalar(c).addScaledVector(_fw, -s);
      _fw.copy(_tmpv);
    }
    _bm.makeBasis(_rt, _up, _fw);
    _bq.setFromRotationMatrix(_bm);
    const r = (radius == null ? getGroundRadius(_up) : radius) - sink;
    _bp.copy(_up).multiplyScalar(r);
    return out.compose(_bp, _bq, _bs.set(sx, sy, sz));
  }

  function slopeAt(d) {
    const t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
    tangentBasis(d, t1, t2);
    const e = 0.012, p = new THREE.Vector3();
    const h = (a, b) => { p.copy(d).addScaledVector(t1, a).addScaledVector(t2, b); return seabed(p.x, p.y, p.z); };
    const gx = (h(e, 0) - h(-e, 0)) / (2 * e * R), gy = (h(0, e) - h(0, -e)) / (2 * e * R);
    return Math.hypot(gx, gy);
  }

  const staticParts = [];
  function placeStatic(parts, dir, yaw, scale, sink, lookDir = null) {
    const m = surfaceMatrix(dir, yaw, scale, scale, scale, sink, new THREE.Matrix4(), lookDir);
    for (const g of parts) { g.applyMatrix4(m); staticParts.push(g); }
    return m;
  }

  const COS_START_CLEAR = Math.cos(0.27);
  const _d = new THREE.Vector3();
  /** 在某生態區隨機撒道具 */
  function scatter(rng, count, biome, opt, cb) {
    const centers = BC[biome];
    let placed = 0, tries = 0;
    const maxTries = count * 40;
    while (placed < count && tries < maxTries) {
      tries++;
      const c = opt.center || centers[Math.floor(rng() * centers.length)];
      randomDirNear(c, opt.maxAngle ?? 1.0, rng, _d);
      const scale = opt.scale ? opt.scale(rng) : 1;
      if (biome != null && !opt.center) {
        const bi = biomeWeights(_d.x, _d.y, _d.z, W);
        if (bi !== biome || W[bi] < (opt.minWeight ?? 0.55)) continue;
      }
      const g = seabed(_d.x, _d.y, _d.z);
      if (g < SEA_LEVEL + (opt.minAbove ?? 0.18)) continue;
      if (opt.maxAbove != null && g > SEA_LEVEL + opt.maxAbove) continue;
      if (opt.avoidStart !== false && _d.dot(START) > COS_START_CLEAR) continue;
      if (opt.exclude && opt.exclude(_d)) continue;
      if (opt.maxSlope && slopeAt(_d) > opt.maxSlope) continue;
      if (!freeAt(_d, g, (opt.radius || 0) * scale + (opt.clearance ?? 0.35))) continue;
      cb(_d, g, scale, rng);
      placed++;
    }
    return placed;
  }

  const lists = {}; // name → [{ m, c }]
  function addInst(name, m, color = null) {
    (lists[name] || (lists[name] = [])).push({ m: m.clone(), c: color != null ? new THREE.Color(color) : null });
  }
  const _im = new THREE.Matrix4();

  // ---- 地標：村莊 ----
  const houses = [
    { ang: 0.33, az: 20, roof: 0xe8655a, wall: 0xfff4e0 },
    { ang: 0.36, az: 78, roof: 0x5a8fe8, wall: 0xfff0f0 },
    { ang: 0.31, az: 140, roof: 0xf0a04b, wall: 0xfff8e6 },
    { ang: 0.37, az: 198, roof: 0xa77be0, wall: 0xf4f0ff },
    { ang: 0.335, az: 255, roof: 0x4fbfa8, wall: 0xfffbe8 },
  ];
  const _look = new THREE.Vector3();
  for (const h of houses) {
    const d = dirAt(START, h.ang, h.az);
    _look.copy(START).sub(d);
    placeStatic(cottageParts(h.roof, h.wall), d, 0, 1.1, 0.12, _look);
    addObstacle(d, 1.45);
  }
  // 風車
  let bladePivot;
  {
    const d = dirAt(START, 0.42, 318);
    _look.copy(START).sub(d);
    const m = placeStatic(windmillParts(), d, 0, 1.15, 0.12, _look);
    addObstacle(d, 1.15);
    bladePivot = new THREE.Object3D();
    const hub = new THREE.Vector3(0, 2.95, 0.98).applyMatrix4(m);
    bladePivot.position.copy(hub);
    bladePivot.quaternion.setFromRotationMatrix(m);
    bladePivot.scale.setScalar(1.15);
    const blades = new THREE.Mesh(bladeGeo(), propMat);
    blades.name = 'windmillBlades';
    bladePivot.add(blades);
    root.add(bladePivot);
  }

  // ---- 火山口熔岩 ----
  let lava;
  const volcTop = new THREE.Vector3();
  {
    const floor = seabed(VOLC.x, VOLC.y, VOLC.z);
    const lavaR = floor + 0.42;
    // 找熔岩面與火山口內壁的交界角
    let minA = 1;
    for (let az = 0; az < 360; az += 30) {
      for (let a = 0.005; a < 0.2; a += 0.004) {
        const dd = dirAt(VOLC, a, az);
        if (seabed(dd.x, dd.y, dd.z) > lavaR) { minA = Math.min(minA, a); break; }
      }
    }
    const rad = Math.min(minA, 0.13) * lavaR + 0.35;
    const lg = new THREE.CylinderGeometry(rad, rad * 0.8, 0.5, 14);
    lava = new THREE.Mesh(lg, lavaMat);
    lava.name = 'lava';
    surfaceMatrix(VOLC, 0, 1, 1, 1, 0.25, _im, null, lavaR);
    lava.matrix.copy(_im);
    lava.matrix.decompose(lava.position, lava.quaternion, lava.scale);
    root.add(lava);
    obstacles.push({ position: VOLC.clone().multiplyScalar(lavaR), radius: rad - 0.1 });
    volcTop.copy(VOLC).multiplyScalar(lavaR);
  }

  // ---- 沙漠：火箭發射台 + 化石 ----
  {
    const d = dirAt(DESERT, 0.24, 10);
    placeStatic(rocketParts(), d, 0.6, 1.0, 0.2);
    addObstacle(d, 2.4);
    const f = dirAt(DESERT, 0.3, 160);
    placeStatic(fossilParts(), f, 1.1, 1.0, 0.18);
    // 化石沿長軸放幾個障礙
    const m = surfaceMatrix(f, 1.1, 1, 1, 1, 0, new THREE.Matrix4());
    for (const x of [-2.2, 0, 2.0, 4.1]) {
      const p = new THREE.Vector3(x, 0, 0).applyMatrix4(m).normalize();
      addObstacle(p, x === 4.1 ? 0.9 : 1.05);
    }
  }
  // ---- 北極：雪人；南極：冰屋 + 企鵝一家 ----
  {
    const d = dirAt(POLN, 0.22, 30);
    placeStatic(snowmanParts(), d, 0, 1.15, 0.15, START.clone().sub(d));
    addObstacle(d, 0.85);
    const ig = dirAt(POLS, 0.18, 200);
    const igParts = iglooParts()
      .concat(penguinParts(1.0, -1.1, 2.6, 0.2))
      .concat(penguinParts(0.85, -0.25, 2.9, -0.1))
      .concat(penguinParts(0.55, 0.45, 3.0, -0.4));
    const m = placeStatic(igParts, ig, 0.3, 1.1, 0.12);
    addObstacle(ig, 1.6);
    for (const [x, z] of [[-1.1, 2.6], [-0.25, 2.9], [0.45, 3.0]]) {
      const p = new THREE.Vector3(x, 0, z).applyMatrix4(m).normalize();
      addObstacle(p, 0.35);
    }
  }
  // ---- 海洋：島上的瓶中信 ----
  {
    const I = ISLANDS[0];
    const d = dirAt(I.dir, I.r * 0.42, 250);
    placeStatic(bottleParts(), d, 0.4, 1.35, 0.05);
  }

  // =========================================================================
  // 隨機撒道具（障礙物類：各畫質相同；裝飾類：依畫質縮放）
  // =========================================================================
  const rngObs = mulberry32(WORLD_SEED + 101);
  const rngDeco = mulberry32(WORLD_SEED + 202);
  const deco = (n) => Math.round(n * decoScale);
  const notCrater = (d) => d.dot(VOLC) > Math.cos(0.17);

  // 森林：松樹 + 圓樹
  scatter(rngObs, 80, iForest, { maxAngle: 0.75, radius: 0.4, maxSlope: 0.7, scale: (r) => 1.1 + r() * 0.6 }, (d, g, s, r) => {
    addInst('pine', surfaceMatrix(d, r() * 6.28, s, s * (0.9 + r() * 0.3), s, 0.1, _im));
    addObstacle(d, 0.4 * s);
  });
  const greens = [0x7cc95a, 0x8fd468, 0x6ab84f, 0x9bd66a];
  scatter(rngObs, 26, iForest, { maxAngle: 0.75, radius: 0.45, maxSlope: 0.7, scale: (r) => 1.0 + r() * 0.5 }, (d, g, s, r) => {
    surfaceMatrix(d, r() * 6.28, s, s, s, 0.1, _im);
    addInst('trunk', _im); addInst('canopy', _im, greens[Math.floor(r() * greens.length)]);
    addObstacle(d, 0.42 * s);
  });
  // 草原：圓樹（含粉色花樹）
  const meadowTrees = [0x8fd468, 0xffb8cf, 0x7cc95a, 0xffc9a8, 0x9bd66a];
  scatter(rngObs, 16, iMeadow, { maxAngle: 0.7, radius: 0.45, maxSlope: 0.6, scale: (r) => 1.0 + r() * 0.45, exclude: (d) => d.dot(START) > Math.cos(0.3) }, (d, g, s, r) => {
    surfaceMatrix(d, r() * 6.28, s, s, s, 0.1, _im);
    addInst('trunk', _im); addInst('canopy', _im, meadowTrees[Math.floor(r() * meadowTrees.length)]);
    addObstacle(d, 0.42 * s);
  });
  // 石頭（依生態區著色）
  const rockTint = [];
  rockTint[iMeadow] = 0xd6d2c8; rockTint[iForest] = 0xa9b49a; rockTint[iDesert] = 0xe0a868;
  rockTint[iPolar] = 0xd2e6f0; rockTint[iVolcano] = 0x5e504c; rockTint[iOcean] = 0xb8b2a6;
  const rockCounts = [[iMeadow, 6], [iForest, 10], [iDesert, 18], [iPolar, 8], [iVolcano, 24]];
  for (const [b, n] of rockCounts) {
    scatter(rngObs, n, b, { maxAngle: 0.8, radius: 0.5, scale: (r) => 0.6 + r() * 1.0, exclude: b === iVolcano ? notCrater : null }, (d, g, s, r) => {
      addInst('rock', surfaceMatrix(d, r() * 6.28, s, s * (0.8 + r() * 0.5), s, 0.12 * s, _im), rockTint[b]);
      addObstacle(d, 0.5 * s);
    });
  }
  // 沙漠：仙人掌
  scatter(rngObs, 22, iDesert, { maxAngle: 0.75, radius: 0.35, scale: (r) => 0.9 + r() * 0.6 }, (d, g, s, r) => {
    addInst('cactus', surfaceMatrix(d, r() * 6.28, s, s, s, 0.08, _im));
    addObstacle(d, 0.36 * s);
  });
  // 極地：冰刺
  scatter(rngObs, 28, iPolar, { maxAngle: 0.65, radius: 0.4, scale: (r) => 0.8 + r() * 0.8 }, (d, g, s, r) => {
    addInst('ice', surfaceMatrix(d, r() * 6.28, s, s * (0.8 + r() * 0.6), s, 0.1, _im));
    addObstacle(d, 0.38 * s);
  });
  // 極地邊緣的雪松（白綠色）
  scatter(rngObs, 12, iPolar, { maxAngle: 0.75, minWeight: 0.5, radius: 0.4, scale: (r) => 1.0 + r() * 0.4, exclude: (d) => d.dot(POLN) > Math.cos(0.45) || d.dot(POLS) > Math.cos(0.45) }, (d, g, s, r) => {
    addInst('pine', surfaceMatrix(d, r() * 6.28, s, s, s, 0.1, _im));
    addObstacle(d, 0.4 * s);
  });
  // 海洋島嶼：棕櫚樹 + 岩石
  for (let ii = 0; ii < ISLANDS.length; ii++) {
    const I = ISLANDS[ii];
    scatter(rngObs, ii === 1 ? 1 : 3, null, { center: I.dir, maxAngle: I.r * 0.55, minAbove: 0.25, radius: 0.3, avoidStart: false, scale: (r) => 0.9 + r() * 0.35 }, (d, g, s, r) => {
      addInst('palm', surfaceMatrix(d, r() * 6.28, s, s, s, 0.08, _im));
      addObstacle(d, 0.3 * s);
    });
    scatter(rngObs, ii === 1 ? 3 : 2, null, { center: I.dir, maxAngle: I.r * 0.85, minAbove: -0.1, radius: 0.5, avoidStart: false, scale: (r) => 0.6 + r() * 0.7 }, (d, g, s, r) => {
      addInst('rock', surfaceMatrix(d, r() * 6.28, s, s * 0.8, s, 0.12 * s, _im), rockTint[iOcean]);
      addObstacle(d, 0.5 * s);
    });
  }
  // 沿岸的棕櫚（沙漠、草原的海邊）
  for (const b of [iDesert, iMeadow]) {
    scatter(rngObs, 4, b, { maxAngle: 1.0, minWeight: 0.4, minAbove: 0.12, maxAbove: 0.45, radius: 0.3, scale: (r) => 0.9 + r() * 0.3 }, (d, g, s, r) => {
      addInst('palm', surfaceMatrix(d, r() * 6.28, s, s, s, 0.08, _im));
      addObstacle(d, 0.3 * s);
    });
  }

  // ---- 裝飾（非障礙） ----
  const flowerCols = [0xffffff, 0xffb3c7, 0xfff07a, 0xc7a8ff, 0xff9f80, 0xa8dcff];
  scatter(rngDeco, deco(240), iMeadow, { maxAngle: 0.75, minWeight: 0.45, avoidStart: false, clearance: 0.1, scale: (r) => 0.8 + r() * 0.6 }, (d, g, s, r) => {
    addInst('flower', surfaceMatrix(d, r() * 6.28, s, s, s, 0.03, _im), flowerCols[Math.floor(r() * flowerCols.length)]);
  });
  scatter(rngDeco, deco(40), iForest, { maxAngle: 0.8, avoidStart: false, clearance: 0.1, scale: (r) => 0.7 + r() * 0.5 }, (d, g, s, r) => {
    addInst('flower', surfaceMatrix(d, r() * 6.28, s, s, s, 0.03, _im), flowerCols[Math.floor(r() * 3)]);
  });
  const grassCols = [0x7ccf5a, 0x9be070, 0x6bbd4f, 0xb7e27a];
  const forestGrass = [0x4fa05a, 0x66b860, 0x3f8f4f];
  scatter(rngDeco, deco(220), iMeadow, { maxAngle: 0.8, minWeight: 0.4, avoidStart: false, clearance: 0.1, scale: (r) => 0.9 + r() * 0.8 }, (d, g, s, r) => {
    addInst('grass', surfaceMatrix(d, r() * 6.28, s, s, s, 0.03, _im), grassCols[Math.floor(r() * grassCols.length)]);
  });
  scatter(rngDeco, deco(110), iForest, { maxAngle: 0.8, avoidStart: false, clearance: 0.1, scale: (r) => 0.9 + r() * 0.8 }, (d, g, s, r) => {
    addInst('grass', surfaceMatrix(d, r() * 6.28, s, s, s, 0.03, _im), forestGrass[Math.floor(r() * forestGrass.length)]);
  });
  scatter(rngDeco, deco(26), iForest, { maxAngle: 0.8, clearance: 0.1, scale: (r) => 0.8 + r() * 0.9 }, (d, g, s, r) => {
    addInst('mushroom', surfaceMatrix(d, r() * 6.28, s, s, s, 0.03, _im));
  });
  scatter(rngDeco, deco(30), iDesert, { maxAngle: 0.8, clearance: 0.1, scale: (r) => 0.7 + r() * 0.5 }, (d, g, s, r) => {
    addInst('grass', surfaceMatrix(d, r() * 6.28, s, s * 0.7, s, 0.03, _im), 0xc9c46a);
  });

  // 彩蛋 4：草原山丘上的花朵愛心（從高空看得到）
  {
    const c = dirAt(START, 0.5, 105);
    const { right, forward } = tangentBasis(c);
    const p = new THREE.Vector3();
    for (let i = 0; i < 34; i++) {
      const tt = (i / 34) * Math.PI * 2;
      const hx = 16 * Math.pow(Math.sin(tt), 3);
      const hy = 13 * Math.cos(tt) - 5 * Math.cos(2 * tt) - 2 * Math.cos(3 * tt) - Math.cos(4 * tt);
      p.copy(c).addScaledVector(right, (hx * 0.2) / R).addScaledVector(forward, (hy * 0.2) / R).normalize();
      if (isWater(p)) continue;
      addInst('flower', surfaceMatrix(p, i, 1.25, 1.25, 1.25, 0.03, _im), i % 2 ? 0xff6f91 : 0xff8fab);
    }
  }
  // 彩蛋 5：森林裡的精靈蘑菇圈
  {
    const c = dirAt(FOREST, 0.22, 65);
    const { right, forward } = tangentBasis(c);
    const p = new THREE.Vector3();
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2;
      p.copy(c).addScaledVector(right, (Math.cos(a) * 2.0) / R).addScaledVector(forward, (Math.sin(a) * 2.0) / R).normalize();
      addInst('mushroom', surfaceMatrix(p, a, 1.1, 1.1, 1.1, 0.03, _im));
    }
    addInst('mushroom', surfaceMatrix(c, 0, 2.2, 2.2, 2.2, 0.03, _im));
    addObstacle(c, 0.6);
  }

  // ---- 建立 InstancedMesh ----
  const geos = {
    pine: geoPine(), trunk: geoTrunk(), canopy: geoCanopy(), flower: geoFlower(), grass: geoGrass(),
    rock: geoRock(), cactus: geoCactus(), ice: geoIceSpike(), palm: geoPalm(), mushroom: geoMushroom(),
  };
  for (const name of Object.keys(geos)) {
    const list = lists[name];
    if (!list || !list.length) { geos[name].dispose(); continue; }
    const im = new THREE.InstancedMesh(geos[name], propMat, list.length);
    im.name = 'props:' + name;
    for (let i = 0; i < list.length; i++) {
      im.setMatrixAt(i, list[i].m);
      if (list[i].c) im.setColorAt(i, list[i].c);
    }
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    root.add(im);
  }
  // 靜態合併道具
  const staticMesh = new THREE.Mesh(merge(staticParts), propMat);
  staticMesh.name = 'props:static';
  root.add(staticMesh);

  // =========================================================================
  // 雲
  // =========================================================================
  const cloudGroups = [];
  {
    const rng = mulberry32(WORLD_SEED + 303);
    const count = Math.max(6, Math.round(14 * (0.6 + 0.4 * decoScale)));
    const partsA = [], partsB = [];
    const m = new THREE.Matrix4(), dd = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const g = cloudGeo(rng);
      const s = 1.1 + rng() * 0.9;
      // 避免正好在南北極上空（旋轉軸附近不動）
      do { dd.set(rng() * 2 - 1, (rng() * 2 - 1) * 0.8, rng() * 2 - 1); } while (dd.lengthSq() < 0.05);
      dd.normalize();
      surfaceMatrix(dd, rng() * 6.28, s, s, s, 0, m, null, 38.5 + rng() * 3.5);
      g.applyMatrix4(m);
      (i % 2 ? partsB : partsA).push(g);
    }
    for (const [parts, axis, speed] of [[partsA, new THREE.Vector3(0.1, 1, 0.15).normalize(), 0.018], [partsB, new THREE.Vector3(-0.2, 1, -0.1).normalize(), -0.012]]) {
      if (!parts.length) continue;
      const mesh = new THREE.Mesh(merge(parts), cloudMat);
      mesh.name = 'clouds';
      root.add(mesh);
      cloudGroups.push({ mesh, axis, speed });
    }
  }

  // =========================================================================
  // 火山煙
  // =========================================================================
  const SMOKE_N = q === 'low' ? 7 : 10;
  const smoke = new THREE.InstancedMesh(prep(new THREE.IcosahedronGeometry(0.6, 1), 0xffffff), cloudMat, SMOKE_N);
  smoke.name = 'smoke';
  smoke.frustumCulled = false;
  const smokeQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), VOLC);
  const smokeWind = new THREE.Vector3(), smokeSide = new THREE.Vector3();
  {
    const { right, forward } = tangentBasis(VOLC);
    smokeWind.copy(right);
    smokeSide.copy(forward);
    const c = new THREE.Color();
    for (let i = 0; i < SMOKE_N; i++) smoke.setColorAt(i, c.setHSL(0.07, 0.06, 0.74 + (i % 3) * 0.08));
  }
  root.add(smoke);

  // =========================================================================
  // 鯨魚
  // =========================================================================
  const whale = new THREE.Mesh(whaleGeo(), propMat);
  whale.name = 'whale';
  const spout = new THREE.Mesh(spoutGeo(), spoutMat);
  spout.position.set(0, 0.6, 0.55);
  spout.visible = false;
  whale.add(spout);
  root.add(whale);
  const whaleE1 = new THREE.Vector3(), whaleE2 = new THREE.Vector3();
  tangentBasis(OCEAN1, whaleE1, whaleE2);
  const WHALE_ANG = 0.15;

  // =========================================================================
  // update
  // =========================================================================
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
  const _m1 = new THREE.Matrix4(), _q1 = new THREE.Quaternion(), _s1 = new THREE.Vector3();
  const sunDir = new THREE.Vector3(0.4, 0.6, 0.7).normalize();
  const lavaA = new THREE.Color(0xff6a2d), lavaB = new THREE.Color(0xffb347);
  let sunInit = false;

  function update(dt = 0.016, t = 0, camera = null) {
    uTime.value = t;
    restoreCur = damp(restoreCur, restoreTarget, 1.4, dt);
    if (Math.abs(restoreCur - restoreTarget) < 1e-4) restoreCur = restoreTarget;
    uSat.value = 0.45 + 0.6 * restoreCur;

    // 太陽跟著鏡頭（從肩膀後上方照過來）
    if (camera) {
      const cp = camera.position;
      const dist = cp.length();
      if (dist > 1e-3) {
        const e = camera.matrixWorld.elements;
        _v1.copy(cp).multiplyScalar(1 / dist);              // 鏡頭所在方向
        _v2.set(e[4], e[5], e[6]).normalize();               // 鏡頭上
        _v3.set(e[0], e[1], e[2]).normalize();               // 鏡頭右
        _v4.copy(_v1).multiplyScalar(0.6).addScaledVector(_v2, 1.0).addScaledVector(_v3, 0.75).normalize();
        if (!sunInit) { sunDir.copy(_v4); sunInit = true; }
        else sunDir.lerp(_v4, 1 - Math.exp(-4 * dt)).normalize();
        hemi.position.copy(_v1);
        sky.position.copy(cp);
        skyUniforms.uCam.value.copy(cp);
      }
    }
    sun.position.copy(sunDir).multiplyScalar(100);
    skyUniforms.uSun.value.copy(sunDir);

    // 雲
    for (let i = 0; i < cloudGroups.length; i++) {
      const cg = cloudGroups[i];
      cg.mesh.quaternion.setFromAxisAngle(cg.axis, t * cg.speed);
    }
    // 風車
    if (bladePivot) bladePivot.children[0].rotation.z = -t * 1.1;
    // 熔岩
    lavaMat.color.lerpColors(lavaA, lavaB, 0.5 + 0.5 * Math.sin(t * 1.7));
    lava.scale.y = 1 + 0.15 * Math.sin(t * 2.3);
    // 火山煙
    for (let i = 0; i < SMOKE_N; i++) {
      const p = (t * 0.085 + i / SMOKE_N) % 1;
      const wob = Math.sin(t * 0.9 + i * 2.1) * 0.5;
      _v1.copy(volcTop).addScaledVector(VOLC, 0.4 + p * 8.5)
        .addScaledVector(smokeWind, p * p * 4 + wob * p)
        .addScaledVector(smokeSide, Math.sin(i * 2.4) * 0.6 * p);
      const s = (0.5 + p * 2.0) * smoothstep(0, 0.1, p) * (1 - smoothstep(0.72, 1, p));
      _m1.compose(_v1, smokeQuat, _s1.set(s, s * 0.85, s));
      smoke.setMatrixAt(i, _m1);
    }
    smoke.instanceMatrix.needsUpdate = true;
    // 鯨魚：繞圈游，週期性浮出換氣噴水
    {
      const th = t * 0.07;
      const ca = Math.cos(WHALE_ANG), sa = Math.sin(WHALE_ANG);
      _v1.copy(OCEAN1).multiplyScalar(ca)
        .addScaledVector(whaleE1, sa * Math.cos(th)).addScaledVector(whaleE2, sa * Math.sin(th)).normalize();
      _v2.copy(whaleE1).multiplyScalar(-Math.sin(th)).addScaledVector(whaleE2, Math.cos(th)); // 前進方向
      _v2.addScaledVector(_v1, -_v2.dot(_v1)).normalize();
      const cyc = (t % 16) / 16; // 0..1
      const surf = smoothstep(0.55, 0.65, cyc) * (1 - smoothstep(0.88, 0.97, cyc));
      const depth = lerp(1.35, 0.32, surf) + Math.sin(t * 1.3) * 0.05;
      _v3.crossVectors(_v1, _v2).normalize();
      _m1.makeBasis(_v3, _v1, _v2);
      whale.quaternion.setFromRotationMatrix(_m1);
      // 浮出時頭微微上揚
      _q1.setFromAxisAngle(_v3, -0.12 * surf * Math.sin(t * 0.8));
      whale.quaternion.premultiply(_q1);
      whale.position.copy(_v1).multiplyScalar(SEA_LEVEL - depth);
      const sp = clamp((cyc - 0.66) / 0.18, 0, 1);
      if (sp > 0 && sp < 1) {
        spout.visible = true;
        const k = Math.sin(sp * Math.PI);
        spout.scale.set(0.6 + k * 0.6, Math.max(0.01, k * 1.3), 0.6 + k * 0.6);
      } else spout.visible = false;
    }
  }

  function setRestoration(f) {
    restoreTarget = clamp(Number(f) || 0, 0, 1);
  }

  // 初始一次（沒有鏡頭時也有合理的燈光）
  update(0, 0, null);

  return {
    root,
    getGroundRadius,
    getSurfacePoint,
    getBiome,
    isWater,
    obstacles,
    isFree,
    setRestoration,
    update,
  };
}
