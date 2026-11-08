// 分身 2：角色與物理 —— 小旅人角色模型、程序動畫、球面星球物理。
// v2：平台（側面碰撞、撞頭、彈跳蘑菇、邊緣寬容）、可變跳躍高度、頭頂搬運物。
// v4：速度倍率（setSpeedScale）、配合較慢速度重調的加減速與步伐節奏、5 位可選角色（setCharacter）。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  GRAVITY, WALK_SPEED, RUN_SPEED, JUMP_SPEED, PLAYER_RADIUS, PLANET_RADIUS, PALETTE, SEA_LEVEL, CHARACTERS,
} from './config.js';
import { clamp, damp, tangentBasis } from './utils.js';
import { createItem, CHARACTER_INFO } from './characters.js';

export { CHARACTER_INFO };

// ---- 調整參數 ----
const COYOTE_TIME = 0.1;
const JUMP_BUFFER = 0.12;
const WATER_SPEED = 0.6;
const WATER_JUMP = 0.72;
const FALL_GRAVITY_MULT = 1.18;  // 下落時重力稍大，跳躍更俐落
const MAX_FALL_SPEED = 40;
// v4：速度放慢後加減速稍微俐落一點（起步約 0.17 秒到 90%、放開約 0.13 秒停下），空中控制也稍好
const ACCEL_GROUND = 13.5;       // 指數平滑速率（加速）
const DECEL_GROUND = 17.5;       // 指數平滑速率（減速）
const ACCEL_AIR = 5.4;           // v2：空中控制比 v1 好一點，方便落在半徑 1 的平台上（v4 再好一點）
const DECEL_AIR = 2.4;
// v4.1（整合者）：地面走得慢，但起跳時水平速度放大，跳躍距離維持 v4 的水準，平台挑戰不會變難
const AIR_BOOST = 1.45;
// v4 步伐：每步的距離（世界單位）。比 v3 短，讓較慢的速度仍有輕快的步頻、腳不打滑
const STRIDE_WALK = 0.74;
const STRIDE_RUN = 1.02;
const STRIDE_WATER = 0.62;
const TURN_RATE_GROUND = 14;
const TURN_RATE_AIR = 6;
const LAND_SOUND_AIRTIME = 0.15;
const SUBSTEP = 1 / 60;
const OBSTACLE_SLACK = 3;        // 3D 距離超過 (半徑和 + 這個) 就跳過
const HEAD_TOP = 1.8;            // 表情泡泡錨點高度
// ---- v2 平台 ----
const STEP_UP = 0.35;            // 自動跨上的最大高度；更高要跳
const EDGE_MARGIN = 0.16;        // 站在平台邊緣的寬容（腳掌超出邊緣多少仍算站著）
const BODY_HEIGHT = 1.45;        // 撞頭用的身高
const HEAD_RADIUS = 0.3;         // 撞頭判定的水平半徑（比身體窄，邊緣擦過時改為側推）
const JUMP_CUT = 0.45;           // 提早放開跳躍鍵：上升速度乘上這個值（只一次）
const JUMP_CUT_MIN_TIME = 0.08;  // 最短上升時間（輕點也有小跳）
const JUMP_CUT_MIN_VEL = 2.5;    // 上升速度已經很慢就不截了
const IN_WATER_MAX_HEIGHT = 0.25;// 高於海面這麼多（例如站在海上踏石）就不算在水裡

// ---- 每幀重複使用的暫存（不配置新物件） ----
const _camFwd = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _target = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _tmp3 = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _right = new THREE.Vector3();
const _side = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const NO_INPUT = Object.freeze({ moveX: 0, moveY: 0, run: false, jumpPressed: false });
const noop = () => {};

// ---------------------------------------------------------------------------
// 角色模型（全部由低多邊形基本形組成，頂點色 + flat shading）
// ---------------------------------------------------------------------------
const COL = {
  coat: PALETTE.player,
  accent: PALETTE.playerAccent,
  accentDark: 0x2a5aa8,
  skin: 0xffe2c8,
  scarf: 0xffd25e,
  boot: 0x7a4e36,
  leaf: 0x7fd84f,
  stem: 0x58a83a,
  eye: 0x2b2238,
  shine: 0xffffff,
  blush: 0xff8fa3,
  mouth: 0x6b3434,
  roll: 0xffd25e,
};

/** 對幾何做縮放/旋轉/位移並塗上單色頂點色 */
function part(geo, hex, { s = null, r = null, p = null } = {}) {
  if (s) geo.scale(s[0], s[1], s[2]);
  if (r) {
    if (r[0]) geo.rotateX(r[0]);
    if (r[1]) geo.rotateY(r[1]);
    if (r[2]) geo.rotateZ(r[2]);
  }
  if (p) geo.translate(p[0], p[1], p[2]);
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
const merge = (list) => {
  const g = mergeGeometries(list, false);
  list.forEach((x) => x.dispose());
  return g;
};
const sphere = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);

function makeShadowTexture() {
  const size = 64;
  let canvas = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.75)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  } catch { canvas = null; }
  if (!canvas) return null;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildCharacter() {
  const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const faceMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  // 臉部：平滑著色 + 微自發光，背光時也保持明亮好認
  const skinMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x6e4c3a });

  const root = new THREE.Group();
  root.name = 'player';

  // 腳下的柔和圓形假陰影
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x1b2a3a, map: makeShadowTexture(), transparent: true, opacity: 0.38,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const shadowGeo = new THREE.CircleGeometry(0.62, 20);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.renderOrder = 1;
  shadow.name = 'player-shadow';
  root.add(shadow);

  // rig：處理擠壓/拉伸、前傾、轉圈、上下視覺補償（原點在腳底）
  const rig = new THREE.Group();
  root.add(rig);

  // 腿（髖部為樞紐）
  const legGeo = merge([
    part(new THREE.CapsuleGeometry(0.105, 0.1, 3, 8), COL.accent, { p: [0, -0.1, 0] }),
    part(sphere(0.125, 9, 6), COL.boot, { s: [1, 0.72, 1.3], p: [0, -0.2, 0.035] }),
  ]);
  const legs = [];
  const W = []; // v4：小旅人（預設角色）專屬的 mesh，換角色時隱藏
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(0.14 * sx, 0.29, 0);
    const m = new THREE.Mesh(legGeo, bodyMat);
    pivot.add(m);
    W.push(m);
    rig.add(pivot);
    legs.push(pivot);
  }

  // 上半身（可上下彈跳、扭轉）
  const torso = new THREE.Group();
  rig.add(torso);

  // v3：圍巾是合併幾何的最後一段，記下頂點範圍，換色時直接改頂點色（不重建幾何）
  const coatPart = part(sphere(0.36, 12, 9), COL.coat, { s: [1, 0.94, 0.92], p: [0, 0.55, 0] });
  const scarfPart = part(new THREE.TorusGeometry(0.26, 0.075, 6, 14), COL.scarf, { r: [Math.PI / 2, 0, 0], p: [0, 0.83, 0] });
  const scarfStart = coatPart.attributes.position.count;
  const scarfCount = scarfPart.attributes.position.count;
  const bodyGeo = merge([coatPart, scarfPart]);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  torso.add(body);
  W.push(body);

  // 探險背包 + 睡袋卷
  const packGeo = merge([
    part(new THREE.BoxGeometry(0.46, 0.46, 0.24), COL.accent, { p: [0, 0.58, -0.36] }),
    part(new THREE.BoxGeometry(0.48, 0.17, 0.27), COL.accentDark, { p: [0, 0.76, -0.36] }),
    part(new THREE.BoxGeometry(0.26, 0.15, 0.07), COL.accentDark, { p: [0, 0.48, -0.5] }),
    part(new THREE.CylinderGeometry(0.095, 0.095, 0.56, 8), COL.roll, { r: [0, 0, Math.PI / 2], p: [0, 0.93, -0.38] }),
  ]);
  const pack = new THREE.Mesh(packGeo, bodyMat);
  torso.add(pack);
  W.push(pack);

  // v3：圍巾尾巴（垂在右前胸，跑步時往後飄；顏色跟著圍巾換）
  const scarfTail = new THREE.Group();
  scarfTail.position.set(0.15, 0.69, 0.255);
  const fringePart = part(new THREE.BoxGeometry(0.12, 0.035, 0.045), COL.scarf, { r: [0, 0, 0.08], p: [0.02, -0.225, 0] });
  const tailFringe = fringePart.attributes.position.count; // 流蘇在合併幾何的最後
  const tailGeo = merge([
    part(sphere(0.06, 8, 6), COL.scarf, { s: [1.1, 0.9, 0.8] }),
    part(new THREE.BoxGeometry(0.11, 0.2, 0.04), COL.scarf, { r: [0, 0, 0.08], p: [0.01, -0.12, 0] }),
    fringePart,
  ]);
  const tail = new THREE.Mesh(tailGeo, bodyMat);
  scarfTail.add(tail);
  scarfTail.rotation.set(-0.42, 0, 0.12);
  torso.add(scarfTail);

  // 手臂（肩膀為樞紐）
  const armGeo = merge([
    part(new THREE.CapsuleGeometry(0.085, 0.13, 3, 8), COL.coat, { p: [0, -0.12, 0] }),
    part(sphere(0.095, 8, 6), COL.skin, { p: [0, -0.25, 0] }),
  ]);
  const arms = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(0.31 * sx, 0.72, 0);
    const m = new THREE.Mesh(armGeo, bodyMat);
    pivot.add(m);
    W.push(m);
    torso.add(pivot);
    arms.push(pivot);
  }

  // 頭（脖子為樞紐）：橘色兜帽 + 臉
  const head = new THREE.Group();
  head.position.set(0, 0.84, 0);
  torso.add(head);
  const HC = 0.23; // 頭中心相對脖子的高度
  const headGeo = merge([
    part(sphere(0.45, 16, 12), COL.coat, { s: [1.04, 0.96, 1], p: [0, HC + 0.03, -0.05] }),
  ]);
  const hood = new THREE.Mesh(headGeo, bodyMat);
  head.add(hood);
  W.push(hood);

  // 眼睛（以眼睛中心為原點，縮放 Y 即眨眼）
  const eyeY = HC + 0.0;
  const eyeGeo = merge([
    part(sphere(0.068, 10, 8), COL.eye, { s: [0.85, 1.15, 0.6], p: [-0.14, 0, 0.405] }),
    part(sphere(0.068, 10, 8), COL.eye, { s: [0.85, 1.15, 0.6], p: [0.14, 0, 0.405] }),
    part(sphere(0.022, 6, 4), COL.shine, { p: [-0.12, 0.03, 0.448] }),
    part(sphere(0.022, 6, 4), COL.shine, { p: [0.16, 0.03, 0.448] }),
  ]);
  const eyes = new THREE.Mesh(eyeGeo, faceMat);
  eyes.position.y = eyeY;
  head.add(eyes);

  // 腮紅 + 小嘴
  const faceGeo = merge([
    part(sphere(0.39, 20, 16), COL.skin, { s: [1.02, 0.88, 0.8], p: [0, HC - 0.04, 0.13] }),
    part(sphere(0.06, 8, 5), COL.blush, { s: [1.25, 0.7, 0.3], r: [0, -0.55, 0], p: [-0.235, HC - 0.085, 0.374] }),
    part(sphere(0.06, 8, 5), COL.blush, { s: [1.25, 0.7, 0.3], r: [0, 0.55, 0], p: [0.235, HC - 0.085, 0.374] }),
    part(new THREE.TorusGeometry(0.038, 0.012, 4, 8, Math.PI), COL.mouth, { r: [0, 0, Math.PI], p: [0, HC - 0.075, 0.433] }),
  ]);
  head.add(new THREE.Mesh(faceGeo, skinMat));

  // 頭頂的小芽（會擺動）
  const sprout = new THREE.Group();
  sprout.position.set(0, HC + 0.43, -0.03);
  const sproutGeo = merge([
    part(new THREE.CylinderGeometry(0.022, 0.03, 0.2, 5), COL.stem, { p: [0, 0.09, 0] }),
    part(sphere(0.13, 8, 5), COL.leaf, { s: [1, 0.28, 0.58], r: [0, 0, 0.5], p: [-0.11, 0.215, 0] }),
    part(sphere(0.11, 8, 5), COL.leaf, { s: [1, 0.28, 0.58], r: [0, 0, -0.6], p: [0.095, 0.185, 0] }),
  ]);
  sproutGeo.rotateY(0.7); // 斜擺，從正面與側面都看得到葉子
  const sproutMesh = new THREE.Mesh(sproutGeo, bodyMat);
  sprout.add(sproutMesh);
  W.push(sproutMesh);
  head.add(sprout);

  // v2：頭頂搬運物的掛點（底部中心貼著兜帽頂）
  const carry = new THREE.Group();
  carry.position.set(0, HC + 0.38, -0.04);
  head.add(carry);

  // v3：帽子掛點（兜帽球心；帽子幾何以這裡為原點建立，傾斜角度依帽子而定）
  const hat = new THREE.Group();
  hat.name = 'player-hat';
  hat.position.set(0, HC + 0.03, -0.05);
  head.add(hat);

  const wanderer = makeSkin('wanderer', {
    nodes: W, bodyGeo, scarfStart, scarfCount,
    sproutPos: sprout.position.clone(), carryPos: carry.position.clone(), topY: HAT_TOP_DEFAULT,
  });

  return {
    root, rig, torso, head, eyes, sprout, carry, legs, arms, shadow, shadowMat,
    hat, bodyGeo, scarfStart, scarfCount, bodyMat, faceMat, skinMat, scarfTail, tailGeo, tailFringe,
    wanderer,
  };
}

// ---------------------------------------------------------------------------
// v3 裝扮：帽子（第一次戴上時才建立，之後切換只改 visible）與圍巾顏色
// ---------------------------------------------------------------------------
// 兜帽是以帽子掛點為中心、半徑約 (0.468, 0.432, 0.45) 的橢球；帽子的帽圍都要比該高度的兜帽寬，避免穿模。
export const HAT_IDS = ['straw', 'explorer', 'beanie', 'flower', 'penguin', 'crown'];
export const SCARF_IDS = ['sunny', 'sky', 'mint', 'rose', 'lava', 'night'];
const SCARF_COLORS = {
  sunny: COL.scarf, sky: 0x62bdf6, mint: 0x5fd9a8, rose: 0xff8db4, lava: 0xf0502c, night: 0x2a3a8f,
};
const HAT_TOP_DEFAULT = 0.69; // 沒戴帽子時兜帽頂（頭部座標）

const _hc = new THREE.Color();
const _hv = new THREE.Vector3();
const _he = new THREE.Euler();
const _hq = new THREE.Quaternion();
const _hm = new THREE.Matrix4();
const _hs = new THREE.Vector3();

/**
 * 帽子零件：轉成非索引幾何（每個三角面可以有自己的顏色）、套用 縮放→旋轉→位移，
 * color 可以是色碼，或 (x, y, z, faceIndex) => 色碼（依三角面中心決定，營造編織/條紋感）。
 */
function hp(geo, color, s = null, r = null, p = null) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  _hs.set(1, 1, 1);
  if (s) { if (typeof s === 'number') _hs.setScalar(s); else _hs.set(s[0], s[1], s[2]); }
  _he.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0);
  _hq.setFromEuler(_he);
  _hv.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
  _hm.compose(_hv, _hq, _hs);
  g.applyMatrix4(_hm);
  const pos = g.attributes.position;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  const fn = typeof color === 'function' ? color : null;
  if (!fn) _hc.set(color);
  for (let i = 0; i < n; i += 3) {
    if (fn) {
      const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
      const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
      const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      _hc.set(fn(cx, cy, cz, i / 3));
    }
    for (let j = 0; j < 3 && i + j < n; j++) {
      arr[(i + j) * 3] = _hc.r; arr[(i + j) * 3 + 1] = _hc.g; arr[(i + j) * 3 + 2] = _hc.b;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
function hmerge(list) {
  const g = mergeGeometries(list, false);
  list.forEach((x) => x.dispose());
  g.computeBoundingSphere();
  return g;
}
/** 以 Y 軸為中心的角度 → 第幾片（用來交錯上色） */
const sector = (x, z, n) => Math.floor(((Math.atan2(x, z) / (Math.PI * 2)) + 1) * n) % n;
/** 一朵五瓣小花（面朝 +Z），之後由呼叫端旋轉擺放 */
function flowerParts(petal, center, size, out, mtx) {
  const parts = [];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    parts.push(hp(sphere(size, 7, 4), petal, [1, 0.62, 0.32], [0, 0, a], [Math.sin(a) * size * 0.95, Math.cos(a) * size * 0.95, 0]));
  }
  parts.push(hp(sphere(size * 0.62, 7, 5), center, [1, 1, 0.6], null, [0, 0, size * 0.18]));
  for (const g of parts) { g.applyMatrix4(mtx); out.push(g); }
}

const HAT_BUILD = {
  // 草帽：寬帽簷 + 紅色緞帶與側邊蝴蝶結，小芽從帽頂冒出來
  straw() {
    const S1 = 0xf6d77e, S2 = 0xe9c463, S3 = 0xd9ad4c, RIB = 0xe8545a, RIB2 = 0xc93f4a;
    const weave = (x, y, z) => (sector(x, z, 18) % 2 ? S1 : S2);
    const list = [
      hp(new THREE.CylinderGeometry(0.33, 0.45, 0.25, 18), weave, null, null, [0, 0.325, 0]),
      hp(new THREE.CylinderGeometry(0.33, 0.33, 0.02, 18), S1, null, null, [0, 0.455, 0]),
      hp(new THREE.CylinderGeometry(0.7, 0.73, 0.035, 22), (x, y, z) => (sector(x, z, 22) % 2 ? S1 : S2), null, null, [0, 0.19, 0]),
      hp(new THREE.TorusGeometry(0.715, 0.028, 4, 26), S3, null, [Math.PI / 2, 0, 0], [0, 0.205, 0]),
      hp(new THREE.CylinderGeometry(0.432, 0.452, 0.08, 18), RIB, null, null, [0, 0.245, 0]),
      // 蝴蝶結（右前側）
      hp(sphere(0.075, 7, 5), RIB, [1.2, 0.85, 0.5], [0, 0.95, 0.35], [0.33, 0.27, 0.33]),
      hp(sphere(0.075, 7, 5), RIB, [1.2, 0.85, 0.5], [0, 0.95, -0.35], [0.43, 0.27, 0.19]),
      hp(sphere(0.04, 6, 4), RIB2, null, null, [0.39, 0.26, 0.28]),
      hp(new THREE.BoxGeometry(0.05, 0.13, 0.02), RIB, null, [0.2, 0.95, 0.35], [0.38, 0.19, 0.3]),
      hp(new THREE.BoxGeometry(0.05, 0.11, 0.02), RIB2, null, [-0.25, 0.95, -0.2], [0.43, 0.2, 0.22]),
    ];
    return { geo: hmerge(list), tilt: [-0.14, 0, 0.1], sprout: 'raise', top: 0.465 };
  },

  // 探險帽：卡其色分片帽頂、向下斜的帽簷、咖啡色帽帶 + 小地球徽章
  explorer() {
    const K1 = 0xf0dfb0, K2 = 0xe2cc93, K3 = 0xcfb47a, BAND = 0x7d5a3a;
    const list = [
      hp(new THREE.SphereGeometry(0.485, 16, 7, 0, Math.PI * 2, 0, Math.PI / 2), (x, y, z) => (sector(x, z, 8) % 2 ? K1 : K2),
        [1, 0.68, 1.04], null, [0, 0.17, 0]),
      hp(new THREE.CylinderGeometry(0.49, 0.69, 0.07, 22), K3, [1, 1, 1.1], null, [0, 0.145, 0.02]),
      hp(new THREE.CylinderGeometry(0.5, 0.5, 0.075, 18), BAND, [1, 1, 1.04], null, [0, 0.21, 0]),
      hp(new THREE.CylinderGeometry(0.05, 0.065, 0.05, 8), K3, null, null, [0, 0.505, 0]),
      hp(sphere(0.045, 8, 5), K1, [1, 0.6, 1], null, [0, 0.53, 0]),
      // 小地球徽章
      hp(new THREE.CylinderGeometry(0.068, 0.068, 0.025, 12), 0xffd25e, null, [Math.PI / 2, 0, 0], [0, 0.215, 0.515]),
      hp(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12), 0x4fb3e0, null, [Math.PI / 2, 0, 0], [0, 0.215, 0.522]),
      hp(sphere(0.024, 6, 4), 0x7fd84f, [1.3, 1, 0.5], null, [-0.012, 0.225, 0.535]),
      hp(sphere(0.016, 6, 4), 0x7fd84f, [1.2, 1, 0.5], null, [0.02, 0.2, 0.535]),
    ];
    return { geo: hmerge(list), tilt: [-0.1, 0, -0.04], sprout: 'hide', top: 0.53 };
  },

  // 毛線帽：條紋針織帽身、羅紋反摺、大毛球
  beanie() {
    const T1 = 0x3fb7ad, T2 = 0x35a199, CR = 0xfff3d6, CR2 = 0xf1e2bf, CUFF1 = 0x2f9a91, CUFF2 = 0x288880;
    const knit = (x, y, z) => {
      const band = Math.floor((y - 0.1) / 0.085);
      const stripe = band === 2 || band === 4;
      const rib = sector(x, z, 28) % 2;
      return stripe ? (rib ? CR : CR2) : (rib ? T1 : T2);
    };
    const list = [
      hp(new THREE.SphereGeometry(0.5, 28, 8, 0, Math.PI * 2, 0, Math.PI / 2), knit, [1, 0.88, 1], null, [0, 0.1, 0]),
      hp(new THREE.CylinderGeometry(0.52, 0.525, 0.14, 28), (x, y, z) => (sector(x, z, 28) % 2 ? CUFF1 : CUFF2), null, null, [0, 0.12, 0]),
      hp(new THREE.IcosahedronGeometry(0.14, 1), CR, null, null, [0, 0.6, 0]),
      hp(new THREE.IcosahedronGeometry(0.075, 0), CR2, null, [0.3, 0.5, 0], [0.08, 0.63, 0.05]),
      hp(new THREE.IcosahedronGeometry(0.07, 0), CR2, null, [0.8, 0.2, 0.4], [-0.07, 0.64, -0.06]),
      hp(new THREE.IcosahedronGeometry(0.065, 0), CR, null, [0.1, 0.9, 0.2], [0.02, 0.7, -0.02]),
    ];
    return { geo: hmerge(list), tilt: [-0.16, 0, 0.06], sprout: 'hide', top: 0.66 };
  },

  // 花圈：綠色藤圈 + 葉子 + 五顏六色的小花，小芽照常露出來
  flower() {
    const V = 0x5aa83e, L1 = 0x76c853, L2 = 0x9ad968;
    const RX = 0.452, RZ = 0.44, Y = 0.19;
    const list = [hp(new THREE.TorusGeometry(0.446, 0.042, 5, 26), V, [1, 0.985, 1], [Math.PI / 2, 0, 0], [0, Y, 0])];
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pv = new THREE.Vector3();
    const sv = new THREE.Vector3(1, 1, 1);
    // 葉子
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.11;
      list.push(hp(sphere(0.06, 6, 4), i % 2 ? L1 : L2, [1.5, 0.3, 0.75], [0.35, a + (i % 2 ? 0.6 : -0.6), 0],
        [Math.sin(a) * (RX + 0.03), Y + (i % 2 ? 0.02 : -0.015), Math.cos(a) * (RZ + 0.03)]));
    }
    // 小花（正面那朵最大）
    const FL = [
      [0, 0xff8fb8, 0xffe36b, 0.09], [0.6, 0xffffff, 0xffc93a, 0.074], [-0.6, 0xc7a3ff, 0xfff1a8, 0.074],
      [1.25, 0xffb36b, 0xfff6d0, 0.07], [-1.25, 0xffffff, 0xff9ab8, 0.07], [2.0, 0xff8fb8, 0xffe36b, 0.066],
      [-2.0, 0x8fd3ff, 0xfff1a8, 0.066], [Math.PI, 0xffe36b, 0xff8a5c, 0.066],
    ];
    for (const [a, petal, center, size] of FL) {
      pv.set(Math.sin(a) * (RX + 0.035), Y + 0.025, Math.cos(a) * (RZ + 0.035));
      e.set(-0.45, a, 0, 'YXZ');
      q.setFromEuler(e);
      mtx.compose(pv, q, sv);
      flowerParts(petal, center, size, list, mtx);
    }
    return { geo: hmerge(list), tilt: [-0.2, 0, 0.07], sprout: 'show', top: 0.43 };
  },

  // 企鵝帽：深藍帽身、白色臉斑、黑豆眼、橘色小嘴、兩側小翅膀耳罩、頭頂小呆毛
  penguin() {
    const NV = 0x34406a, NV2 = 0x2a3456, W = 0xffffff, TRIM = 0xe6eef8, OR = 0xffa53a, EYE = 0x161a28;
    const list = [
      hp(new THREE.SphereGeometry(0.51, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), NV, [1, 0.92, 1], null, [0, 0.06, 0]),
      hp(new THREE.TorusGeometry(0.505, 0.045, 5, 22), TRIM, null, [Math.PI / 2, 0, 0], [0, 0.07, 0]),
      // 白色臉斑（兩個重疊的扁球 → 愛心形）
      hp(sphere(0.17, 12, 8), W, [1, 0.95, 0.42], [-0.62, 0, 0], [-0.085, 0.26, 0.4]),
      hp(sphere(0.17, 12, 8), W, [1, 0.95, 0.42], [-0.62, 0, 0], [0.085, 0.26, 0.4]),
      hp(sphere(0.13, 10, 7), W, [1.35, 0.7, 0.4], [-0.45, 0, 0], [0, 0.17, 0.45]),
      // 眼睛 + 反光
      hp(sphere(0.05, 8, 6), EYE, [0.9, 1.15, 0.6], [-0.6, 0, 0], [-0.088, 0.29, 0.462]),
      hp(sphere(0.05, 8, 6), EYE, [0.9, 1.15, 0.6], [-0.6, 0, 0], [0.088, 0.29, 0.462]),
      hp(sphere(0.016, 5, 3), W, null, null, [-0.076, 0.31, 0.49]),
      hp(sphere(0.016, 5, 3), W, null, null, [0.1, 0.31, 0.49]),
      // 小嘴
      hp(new THREE.ConeGeometry(0.068, 0.15, 6), OR, [1.25, 1, 0.75], [Math.PI / 2 - 0.25, 0, 0], [0, 0.2, 0.54]),
      // 腮紅
      hp(sphere(0.03, 6, 4), 0xff9eb8, [1.3, 0.7, 0.4], [-0.5, 0, 0], [-0.19, 0.2, 0.43]),
      hp(sphere(0.03, 6, 4), 0xff9eb8, [1.3, 0.7, 0.4], [-0.5, 0, 0], [0.19, 0.2, 0.43]),
      // 兩側往外翹的小翅膀
      hp(sphere(0.13, 8, 6), NV, [0.34, 1.2, 0.72], [0.35, 0, 1.05], [0.54, 0.12, -0.1]),
      hp(sphere(0.13, 8, 6), NV, [0.34, 1.2, 0.72], [0.35, 0, -1.05], [-0.54, 0.12, -0.1]),
      // 頭頂呆毛
      hp(new THREE.ConeGeometry(0.04, 0.14, 5), NV2, null, [0.3, 0, 0.35], [-0.03, 0.55, -0.02]),
      hp(new THREE.ConeGeometry(0.032, 0.11, 5), NV2, null, [-0.2, 0, -0.4], [0.04, 0.54, 0.0]),
    ];
    return { geo: hmerge(list), tilt: [-0.06, 0, 0], sprout: 'hide', top: 0.53 };
  },

  // 皇冠：金色厚邊冠身 + 五個尖角與珍珠 + 正面寶石（通關獎勵），小芽從中間冒出來
  crown() {
    const G1 = 0xffcc3a, G2 = 0xf0b322, G3 = 0xe09a18, PEARL = 0xfff8e8;
    const B = 0.35, H = 0.15;
    const band = new THREE.LatheGeometry([
      new THREE.Vector2(0.25, 0), new THREE.Vector2(0.295, 0), new THREE.Vector2(0.315, H),
      new THREE.Vector2(0.275, H), new THREE.Vector2(0.25, 0),
    ], 15);
    const list = [
      hp(band, (x, y, z) => (sector(x, z, 15) % 2 ? G1 : G2), null, null, [0, B, 0]),
      hp(new THREE.TorusGeometry(0.296, 0.026, 4, 18), G3, null, [Math.PI / 2, 0, 0], [0, B + 0.01, 0]),
    ];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const x = Math.sin(a) * 0.3, z = Math.cos(a) * 0.3;
      list.push(hp(new THREE.ConeGeometry(0.075, 0.15, 4), i % 2 ? G2 : G1, [1, 1, 0.55], [0, a + Math.PI / 4, 0], [x, B + H + 0.07, z]));
      list.push(hp(new THREE.IcosahedronGeometry(0.03, 0), PEARL, null, null, [x * 1.0, B + H + 0.16, z * 1.0]));
    }
    // 寶石：正面紅、左右藍綠、後面紫
    const GEMS = [[0, 0xff4d6d, 0.05], [1.57, 0x4fb3ff, 0.04], [-1.57, 0x5fe08a, 0.04], [Math.PI, 0xb27bff, 0.04]];
    for (const [a, hex, r] of GEMS) {
      list.push(hp(new THREE.OctahedronGeometry(r, 0), hex, [1, 1.2, 0.55], [0, a, 0],
        [Math.sin(a) * 0.31, B + H * 0.48, Math.cos(a) * 0.31]));
    }
    const geo = hmerge(list);
    // 放大一點（通關獎勵要醒目），以冠底為基準縮放後稍微往下坐
    geo.translate(0, -B, 0);
    geo.scale(1.12, 1.12, 1.12);
    geo.translate(0, B - 0.02, 0);
    geo.computeBoundingSphere();
    return { geo, tilt: [-0.08, 0, 0.17], sprout: 'show', top: 0.63, gold: true };
  },
};

let HAT_MATS = null;
function hatMats(bodyMat) {
  if (!HAT_MATS) {
    HAT_MATS = {
      body: bodyMat,
      gold: new THREE.MeshPhongMaterial({
        vertexColors: true, flatShading: true, shininess: 70, specular: 0x8a7440, emissive: 0x3a2400,
      }),
    };
  }
  return HAT_MATS;
}

/** 夜空圍巾上的小星星（只在 'night' 圍巾顯示） */
function buildScarfStars(mat) {
  const list = [];
  const N = 13;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + 0.2;
    const b = ((i * 7) % 5 - 2) * 0.42;                // 管子截面上的角度（-0.84..0.84，偏外側）
    const rr = 0.26 + (0.075 + 0.006) * Math.cos(b);
    const s = i % 3 === 0 ? 0.026 : 0.018;
    list.push(part(new THREE.OctahedronGeometry(s, 0), i % 4 === 1 ? 0xbfe6ff : 0xfff2a8, {
      s: [1, 1, 0.6], r: [0, a, 0.785],
      p: [Math.sin(a) * rr, 0.83 + (0.075 + 0.006) * Math.sin(b), Math.cos(a) * rr],
    }));
  }
  const g = merge(list);
  const m = new THREE.Mesh(g, mat);
  m.name = 'player-scarf-stars';
  // 尾巴上的星星（跟著尾巴擺動）
  const tl = [[-0.025, -0.07, 0.026, 0.022], [0.035, -0.15, 0.026, 0.017], [0.0, 0.0, 0.055, 0.016], [0.03, -0.04, 0.026, 0.012]]
    .map(([x, y, z, r], i) => part(new THREE.OctahedronGeometry(r, 0), i === 1 ? 0xbfe6ff : 0xfff2a8,
      { s: [1, 1, 0.5], r: [0, 0, 0.785], p: [x, y, z] }));
  const tm = new THREE.Mesh(merge(tl), mat);
  tm.name = 'player-scarf-tail-stars';
  return { ring: m, tail: tm };
}

// ---------------------------------------------------------------------------
// v4 可選角色：共用同一套骨架（腿/身體/手臂/頭/小芽/帽子掛點/搬運掛點），每位角色只是掛在骨架上的另一組 mesh。
// 第一次選到某角色時才建立（之後切換只改 visible，不再配置任何東西）。
// ---------------------------------------------------------------------------
const HOOD_C = [0, 0.26, -0.05];          // 兜帽球心（頭部座標）= 帽子掛點
const SKIN_HAND = COL.skin;

/** 角色描述：nodes = 這位角色專屬、要一起顯示/隱藏的物件 */
function makeSkin(id, o) {
  return {
    id,
    nodes: o.nodes,
    bodyGeo: o.bodyGeo, scarfStart: o.scarfStart, scarfCount: o.scarfCount, scarfApplied: null,
    sunny: o.sunny !== undefined ? o.sunny : COL.scarf,     // 預設「暖陽黃」圍巾在這位角色身上的顏色
    sproutPos: o.sproutPos || null,                         // 頭頂小芽/天線的位置（null = 沒有）
    carryPos: o.carryPos,                                   // 沒戴帽子時，頭頂搬運物的位置
    topY: o.topY,                                           // 頭頂（不含耳朵/天線）高度，帽子與泡泡高度用
    headExtra: o.headExtra || 0,                            // 表情泡泡額外抬高
    hatScale: o.hatScale || 1, hatLift: o.hatLift || 0, hatFwd: o.hatFwd || 0,
    hatAdjust: o.hatAdjust || {},                           // 每頂帽子的微調 { s, y, z }
    ears: o.ears || null, earRest: o.earRest || 0, earBack: o.earBack || 0,
    earHat: o.earHat || {}, earCarry: o.earCarry || 0,
    tail: o.tail || null, tailKind: o.tailKind || null,
    wings: o.wings || null,
    jet: o.jet || null,
    fits: {},                                               // 帽子 id → 合身資訊（第一次戴上時計算）
  };
}

/** 依 y 高度取外套球面在正前方（或 x 偏移處）的 z，用來把小配件貼在衣服上 */
function coatZ(y, x = 0) {
  const k = 1 - (x / 0.36) ** 2 - ((y - 0.55) / 0.338) ** 2;
  return 0.331 * Math.sqrt(Math.max(0, k));
}
/** 圍巾（每位角色都同一個位置與形狀，夜空星星與換色都共用） */
const scarfPiece = () => hp(new THREE.TorusGeometry(0.26, 0.075, 6, 14), COL.scarf, null, [Math.PI / 2, 0, 0], [0, 0.83, 0]);
/** 身體：list 的最後一段是圍巾，記下頂點範圍（換色用） */
function bodyWithScarf(list) {
  const sc = scarfPiece();
  const scarfCount = sc.attributes.position.count;
  list.push(sc);
  const geo = hmerge(list);
  return { geo, scarfStart: geo.attributes.position.count - scarfCount, scarfCount };
}
const coatShell = (hex) => hp(sphere(0.36, 12, 9), hex, [1, 0.94, 0.92], null, [0, 0.55, 0]);
const hoodShell = (hex) => hp(sphere(0.45, 16, 12), hex, [1.04, 0.96, 1], null, [HOOD_C[0], HOOD_C[1], HOOD_C[2]]);
function legGeoOf(pants, boot, extra = []) {
  return hmerge([
    hp(new THREE.CapsuleGeometry(0.105, 0.1, 3, 8), pants, null, null, [0, -0.1, 0]),
    hp(sphere(0.125, 9, 6), boot, [1, 0.72, 1.3], null, [0, -0.2, 0.035]),
    ...extra,
  ]);
}
function armGeoOf(sleeve, hand, extra = []) {
  return hmerge([
    hp(new THREE.CapsuleGeometry(0.085, 0.13, 3, 8), sleeve, null, null, [0, -0.12, 0]),
    hp(sphere(0.095, 8, 6), hand, null, null, [0, -0.25, 0]),
    ...extra,
  ]);
}
/** 把一片薄零件貼在以 c 為球心、半徑 r 的球面上 dir 的方向（本地 +Z = 球面法線），roll = 繞法線轉 */
function onSphere(geo, c, dir, r, roll = 0) {
  const d = _hv.set(dir[0], dir[1], dir[2]).normalize();
  const zA = d.clone();
  const xA = new THREE.Vector3(0, 1, 0).cross(zA).normalize();
  const yA = zA.clone().cross(xA);
  const m = new THREE.Matrix4().makeRotationZ(roll);
  m.premultiply(new THREE.Matrix4().makeBasis(xA, yA, zA));
  m.setPosition(c[0] + zA.x * r, c[1] + zA.y * r, c[2] + zA.z * r);
  geo.applyMatrix4(m);
  return geo;
}

/** 在骨架節點上掛 mesh，並記到 nodes */
function attach(parent, geo, mat, nodes, pos = null) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  parent.add(m);
  nodes.push(m);
  return m;
}
function attachPivot(parent, pos, nodes) {
  const g = new THREE.Group();
  g.position.set(pos[0], pos[1], pos[2]);
  parent.add(g);
  nodes.push(g);
  return g;
}
/** 骨架上每個肢體掛一份 */
function attachLimbs(P, legGeo, armGeo, mat, nodes) {
  for (const l of P.legs) attach(l, legGeo, mat, nodes);
  for (const a of P.arms) attach(a, armGeo, mat, nodes);
}

let SKIN_MATS = null;
function skinMats(P) {
  if (!SKIN_MATS) {
    SKIN_MATS = {
      // 雲朵頭髮與翅膀：平滑著色 + 淡藍自發光，看起來軟綿綿
      fluff: new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x5a6a8a }),
      // 頭盔面罩玻璃（半透明，不寫深度）
      glass: new THREE.MeshLambertMaterial({
        color: 0xbfe6ff, emissive: 0x2a5a80, transparent: true, opacity: 0.26, depthWrite: false,
      }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      // 太空衣：微微自發光，背光時也是乾淨的白色
      suit: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x2a3038 }),
    };
  }
  return SKIN_MATS;
}

const SKIN_BUILD = {
  // ---- 狐狸探險家：狐狸耳朵兜帽、蓬鬆的橘白大尾巴、綠色外套 ----
  fox(P) {
    const COAT = 0x55a868, COAT2 = 0x3f8c54, HOOD = 0xf08a3c, HOOD2 = 0xe3782c, WHITE = 0xfff4e4,
      PAW = 0x4a3530, PANTS = 0xf4e3c3, TOG = 0xd9a066;
    const nodes = [];
    const mat = P.bodyMat;
    attachLimbs(P, legGeoOf(PANTS, PAW), armGeoOf(COAT, PAW, [
      hp(new THREE.TorusGeometry(0.083, 0.026, 4, 10), COAT2, null, [Math.PI / 2, 0, 0], [0, -0.19, 0]),
    ]), mat, nodes);
    // 外套：牛角扣 + 白色胸前絨毛 + 下擺深綠滾邊
    const list = [coatShell(COAT)];
    list.push(hp(new THREE.TorusGeometry(0.262, 0.03, 4, 18), COAT2, [1, 1, 0.93], [Math.PI / 2, 0, 0], [0, 0.31, 0]));
    for (const y of [0.56, 0.44]) {
      list.push(hp(new THREE.CylinderGeometry(0.032, 0.032, 0.03, 8), TOG, null, [Math.PI / 2 - (y - 0.55) * 2.2, 0, 0], [-0.07, y, coatZ(y, -0.07) + 0.008]));
    }
    list.push(hp(sphere(0.15, 10, 7), WHITE, [1, 0.75, 0.42], [-0.35, 0, 0], [0, 0.71, coatZ(0.71) - 0.03]));
    const body = bodyWithScarf(list);
    attach(P.torso, body.geo, mat, nodes);
    // 兜帽 + 兩頰白色絨毛 + 額前小瀏海
    attach(P.head, hmerge([
      hoodShell(HOOD),
      hp(sphere(0.12, 9, 7), WHITE, [1.05, 0.85, 0.7], [0, -0.7, 0.3], [-0.33, 0.1, 0.2]),
      hp(sphere(0.12, 9, 7), WHITE, [1.05, 0.85, 0.7], [0, 0.7, -0.3], [0.33, 0.1, 0.2]),
    ]), mat, nodes);
    // 耳朵（三角形，白色內耳、深色耳尖）：以耳根為樞紐，戴帽子/頂冰塊時往外倒
    const earGeo = hmerge([
      hp(new THREE.ConeGeometry(0.145, 0.34, 4), HOOD, [1, 1, 0.52], [0, Math.PI / 4, 0], [0, 0.17, 0]),
      hp(new THREE.ConeGeometry(0.085, 0.22, 4), WHITE, [1, 1, 0.4], [0, Math.PI / 4, 0], [0, 0.125, 0.033]),
      hp(new THREE.ConeGeometry(0.05, 0.1, 4), PAW, [1, 1, 0.56], [0, Math.PI / 4, 0], [0, 0.305, 0]),
    ]);
    const ears = [];
    for (const sx of [-1, 1]) {
      const e = attachPivot(P.head, [0.25 * sx, 0.585, -0.1], nodes);
      attach(e, earGeo, mat, []);
      ears.push(e);
    }
    // 尾巴：一串漸大的絨毛球，尾端白色，往後上方翹
    const tail = attachPivot(P.torso, [0, 0.3, -0.24], nodes);
    attach(tail, hmerge([
      hp(sphere(0.1, 9, 7), HOOD, null, null, [0, -0.01, -0.07]),
      hp(sphere(0.17, 10, 8), HOOD, [1, 0.92, 1.15], [0.5, 0, 0], [0, 0.04, -0.21]),
      hp(sphere(0.22, 11, 9), HOOD2, [1, 1.05, 1.05], [0.6, 0, 0], [0, 0.16, -0.37]),
      hp(sphere(0.19, 10, 8), HOOD, [1, 1, 1], null, [0, 0.31, -0.45]),
      hp(sphere(0.155, 10, 8), WHITE, null, null, [0, 0.45, -0.47]),
      hp(new THREE.ConeGeometry(0.11, 0.17, 7), WHITE, null, [-0.4, 0, 0], [0, 0.6, -0.46]),
    ]), mat, []);
    return makeSkin('fox', {
      nodes, bodyGeo: body.geo, scarfStart: body.scarfStart, scarfCount: body.scarfCount,
      carryPos: new THREE.Vector3(0, 0.69, -0.04), topY: 0.69, headExtra: 0.06,
      ears, earRest: 0.42, earCarry: 0.85,
      earHat: { straw: 0.12, explorer: 0.2, beanie: 0.18, flower: 0.0, penguin: 0.42, crown: 0.0 },
      tail, tailKind: 'fox',
    });
  },

  // ---- 太空小子：白色太空衣、圓頭盔（面罩反光 + 小天線）、背上的小噴射背包 ----
  astro(P) {
    const SUIT = 0xf4f6fb, SUIT2 = 0xd3dbe8, SUIT3 = 0xb5c0d2, OR = 0xff8a3d, BLUE = 0x4f8fe0, GLOVE = 0xd6dde9,
      BOOT = 0x7d8cab, DARK = 0x56607a;
    const nodes = [];
    const mat = P.bodyMat;
    const M = skinMats(P);
    attachLimbs(P, legGeoOf(SUIT, BOOT, [
      hp(new THREE.TorusGeometry(0.104, 0.025, 4, 10), OR, null, [Math.PI / 2, 0, 0], [0, -0.135, 0]),
    ]), armGeoOf(SUIT, GLOVE, [
      hp(new THREE.TorusGeometry(0.085, 0.028, 4, 10), OR, null, [Math.PI / 2, 0, 0], [0, -0.19, 0]),
    ]), M.suit, nodes);
    // 太空衣：胸前控制面板（三顆按鈕）+ 橘色腰帶 + 藍色臂章
    const list = [coatShell(SUIT)];
    const py = 0.57, pz = coatZ(py) + 0.005;
    list.push(hp(new THREE.BoxGeometry(0.22, 0.15, 0.05), SUIT2, null, [-0.12, 0, 0], [0, py, pz - 0.01]));
    list.push(hp(new THREE.BoxGeometry(0.17, 0.035, 0.02), DARK, null, [-0.12, 0, 0], [0, py + 0.035, pz + 0.018]));
    [[-0.055, 0xff5a5a], [0, 0xffd25e], [0.055, BLUE]].forEach(([x, c]) => {
      list.push(hp(new THREE.CylinderGeometry(0.019, 0.019, 0.03, 8), c, null, [Math.PI / 2 - 0.12, 0, 0], [x, py - 0.025, pz + 0.02]));
    });
    list.push(hp(new THREE.TorusGeometry(0.313, 0.03, 4, 20), OR, [1, 1, 0.93], [Math.PI / 2, 0, 0], [0, 0.38, 0]));
    const body = bodyWithScarf(list);
    attach(P.torso, body.geo, M.suit, nodes);
    // 頭盔：前面開口的白色球殼 + 灰色框 + 兩側橘色耳機
    const HC3 = [0, 0.26, -0.03], HR = 0.5, OPEN = 0.82;
    const shell = new THREE.SphereGeometry(HR, 20, 12, 0, Math.PI * 2, OPEN, Math.PI - OPEN);
    shell.rotateX(Math.PI / 2);
    const rimR = HR * Math.sin(OPEN), rimZ = HR * Math.cos(OPEN);
    attach(P.head, hmerge([
      hp(shell, SUIT, null, null, HC3),
      hp(new THREE.TorusGeometry(rimR, 0.045, 6, 26), SUIT2, null, null, [HC3[0], HC3[1], HC3[2] + rimZ]),
      hp(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 12), OR, null, [0, 0, Math.PI / 2], [-HR + 0.01, HC3[1] - 0.02, HC3[2]]),
      hp(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 12), OR, null, [0, 0, Math.PI / 2], [HR - 0.01, HC3[1] - 0.02, HC3[2]]),
      hp(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 10), SUIT3, null, [0, 0, Math.PI / 2], [-HR - 0.035, HC3[1] - 0.02, HC3[2]]),
      hp(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 10), SUIT3, null, [0, 0, Math.PI / 2], [HR + 0.035, HC3[1] - 0.02, HC3[2]]),
    ]), M.suit, nodes);
    // 面罩玻璃（半透明）+ 左上兩道反光
    const glass = new THREE.SphereGeometry(HR + 0.012, 18, 6, 0, Math.PI * 2, 0, OPEN + 0.04);
    glass.rotateX(Math.PI / 2);
    const gm = attach(P.head, hmerge([hp(glass, 0xffffff, null, null, HC3)]), M.glass, nodes);
    gm.renderOrder = 2;
    attach(P.head, hmerge([
      onSphere(hp(sphere(0.07, 8, 4), 0xffffff, [1.5, 0.3, 0.12]), HC3, [-0.36, 0.42, 0.83], HR + 0.02, 0.85),
      onSphere(hp(sphere(0.035, 6, 4), 0xffffff, [1.2, 0.45, 0.15]), HC3, [-0.2, 0.52, 0.83], HR + 0.02, 0.75),
      onSphere(hp(sphere(0.02, 6, 4), 0xffffff, [1, 1, 0.2]), HC3, [0.32, -0.28, 0.9], HR + 0.02, 0),
    ]), M.glow, nodes);
    // 天線：掛在小芽樞紐上（共用小芽的彈簧擺動）
    attach(P.sprout, hmerge([
      hp(new THREE.CylinderGeometry(0.012, 0.018, 0.2, 5), SUIT3, null, null, [0, 0.1, 0]),
      hp(new THREE.CylinderGeometry(0.035, 0.04, 0.03, 8), SUIT2, null, null, [0, 0.01, 0]),
      hp(sphere(0.05, 8, 6), 0xff5a6a, null, null, [0, 0.225, 0]),
      hp(sphere(0.018, 5, 4), 0xffffff, null, null, [-0.018, 0.245, 0.03]),
    ]), mat, nodes);
    // 噴射背包：兩支燃料罐 + 背板 + 噴嘴
    const TZ = -0.43;
    const tank = (x) => [
      hp(new THREE.CylinderGeometry(0.1, 0.1, 0.3, 10), SUIT, null, null, [x, 0.5, TZ]),
      hp(sphere(0.1, 10, 6), OR, [1, 0.8, 1], null, [x, 0.65, TZ]),
      hp(new THREE.CylinderGeometry(0.102, 0.102, 0.045, 10), OR, null, null, [x, 0.42, TZ]),
      hp(new THREE.CylinderGeometry(0.055, 0.085, 0.09, 8), DARK, null, null, [x, 0.315, TZ]),
    ];
    attach(P.torso, hmerge([
      hp(new THREE.BoxGeometry(0.36, 0.36, 0.08), SUIT2, null, null, [0, 0.52, -0.35]),
      ...tank(-0.125), ...tank(0.125),
      hp(new THREE.BoxGeometry(0.07, 0.05, 0.02), 0x6fe0ff, null, null, [0, 0.6, -0.395]),
      hp(new THREE.BoxGeometry(0.07, 0.03, 0.02), 0xff5a5a, null, null, [0, 0.53, -0.395]),
    ]), M.suit, nodes);
    // 噴射火焰：跳躍時噴一下（縮放 Y = 火焰長度）
    const jet = attachPivot(P.torso, [0, 0.27, TZ], nodes);
    const flame = (x) => [
      hp(new THREE.ConeGeometry(0.075, 0.34, 8), 0xff8a2c, null, [Math.PI, 0, 0], [x, -0.17, 0]),
      hp(new THREE.ConeGeometry(0.045, 0.2, 8), 0xfff3b0, null, [Math.PI, 0, 0], [x, -0.1, 0]),
      hp(sphere(0.075, 7, 5), 0xffffff, null, null, [x - 0.035, -0.36, 0.02]),
      hp(sphere(0.055, 6, 4), 0xf2f6ff, null, null, [x + 0.045, -0.4, -0.02]),
    ];
    attach(jet, hmerge([...flame(-0.125), ...flame(0.125)]), M.glow, []);
    jet.visible = false;
    return makeSkin('astro', {
      nodes, bodyGeo: body.geo, scarfStart: body.scarfStart, scarfCount: body.scarfCount,
      sproutPos: new THREE.Vector3(0.13, 0.745, -0.06),
      carryPos: new THREE.Vector3(0, 0.755, -0.03), topY: 0.76, headExtra: 0.1,
      hatScale: 1.1, hatLift: 0.0, hatFwd: 0.02,
      jet,
    });
  },

  // ---- 熊熊：熊耳朵咖啡色連帽衣、圓尾巴、背上的蜂蜜罐、蜂蜜色圍巾 ----
  bear(P) {
    const FUR = 0xae764a, FUR2 = 0x95623a, CREAM = 0xf3d8ad, PANTS = 0x5d82c2, BOOT = 0x6a4430,
      HONEY = 0xf2a72c, HONEY2 = 0xffcf4a, LID = 0xe8545a, LID2 = 0xfff2e2, ROPE = 0x7a4e36;
    const nodes = [];
    const mat = P.bodyMat;
    attachLimbs(P, legGeoOf(PANTS, BOOT, [
      hp(new THREE.TorusGeometry(0.104, 0.028, 4, 10), 0x4a6ba8, null, [Math.PI / 2, 0, 0], [0, -0.13, 0]),
    ]), armGeoOf(FUR, SKIN_HAND, [
      hp(new THREE.TorusGeometry(0.083, 0.03, 4, 10), CREAM, null, [Math.PI / 2, 0, 0], [0, -0.19, 0]),
    ]), mat, nodes);
    // 連帽衣：奶油色肚子 + 口袋
    const list = [coatShell(FUR)];
    list.push(hp(sphere(0.17, 12, 9), CREAM, [1, 0.95, 0.26], [-0.2, 0, 0], [0, 0.46, coatZ(0.46) - 0.03]));
    const body = bodyWithScarf(list);
    attach(P.torso, body.geo, mat, nodes);
    attach(P.head, hmerge([hoodShell(FUR)]), mat, nodes);
    // 圓耳朵
    const earGeo = hmerge([
      hp(sphere(0.13, 10, 8), FUR, [1, 0.95, 0.6], null, [0, 0.07, 0]),
      hp(sphere(0.078, 8, 6), CREAM, [1, 1, 0.4], null, [0, 0.07, 0.05]),
    ]);
    const ears = [];
    for (const sx of [-1, 1]) {
      const e = attachPivot(P.head, [0.31 * sx, 0.55, -0.07], nodes);
      attach(e, earGeo, mat, []);
      ears.push(e);
    }
    // 圓尾巴
    const tail = attachPivot(P.torso, [0, 0.29, -0.25], nodes);
    attach(tail, hmerge([hp(sphere(0.11, 10, 8), CREAM, null, null, [0, 0, -0.05])]), mat, []);
    // 蜂蜜罐背包
    attach(P.torso, hmerge([
      hp(sphere(0.17, 12, 9), HONEY, [1, 0.9, 0.82], null, [0, 0.56, -0.44]),
      hp(new THREE.CylinderGeometry(0.1, 0.12, 0.07, 12), 0xe0921f, null, null, [0, 0.71, -0.44]),
      hp(new THREE.SphereGeometry(0.135, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2), (x, y, z, f) => (sector(x, z - (-0.44), 10) % 2 ? LID : LID2),
        [1, 0.55, 1], null, [0, 0.735, -0.44]),
      hp(new THREE.TorusGeometry(0.11, 0.016, 4, 14), ROPE, null, [Math.PI / 2, 0, 0], [0, 0.74, -0.44]),
      hp(sphere(0.045, 7, 5), HONEY2, [0.8, 1.5, 0.6], null, [0.07, 0.655, -0.31]),
      hp(sphere(0.03, 6, 4), HONEY2, null, null, [0.07, 0.6, -0.305]),
      hp(new THREE.BoxGeometry(0.15, 0.09, 0.02), LID2, null, [0.2, 0, 0], [-0.0, 0.53, -0.296]),
      hp(new THREE.BoxGeometry(0.05, 0.42, 0.03), ROPE, null, [0.35, 0, -0.2], [-0.2, 0.62, -0.25]),
      hp(new THREE.BoxGeometry(0.05, 0.42, 0.03), ROPE, null, [0.35, 0, 0.2], [0.2, 0.62, -0.25]),
    ]), mat, nodes);
    return makeSkin('bear', {
      nodes, bodyGeo: body.geo, scarfStart: body.scarfStart, scarfCount: body.scarfCount,
      sunny: 0xf5b22e,
      carryPos: new THREE.Vector3(0, 0.69, -0.04), topY: 0.69, headExtra: 0.02,
      ears, earRest: 0.75, earCarry: 0.6,
      earHat: { straw: 0.25, explorer: 0.3, beanie: 0.12, flower: 0.0, penguin: 0.3, crown: 0.05 },
      tail, tailKind: 'bear',
    });
  },

  // ---- 雲朵仙子：蓬鬆雲朵頭髮、淺藍衣服、背上會拍動的小翅膀 ----
  cloud(P) {
    const OUT = 0xa6d6ff, OUT2 = 0x86c0f2, WHITE = 0xffffff, W2 = 0xeaf4ff, LEG = 0xd9d3fb, BOOT = 0xf8faff,
      SOLE = 0x8cc6f0, STAR = 0xffd25e;
    const nodes = [];
    const mat = P.bodyMat;
    const M = skinMats(P);
    attachLimbs(P, legGeoOf(LEG, BOOT, [
      hp(new THREE.SphereGeometry(0.128, 9, 4, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), SOLE, [1, 0.72, 1.3], null, [0, -0.2, 0.035]),
    ]), armGeoOf(OUT, SKIN_HAND, [
      hp(sphere(0.065, 8, 6), WHITE, [1.45, 0.8, 1.45], null, [0, -0.185, 0]),
    ]), mat, nodes);
    // 衣服：下擺一圈雲朵花邊 + 胸前小星星
    const list = [coatShell(OUT)];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3;
      list.push(hp(sphere(0.075, 8, 6), i % 2 ? WHITE : W2, null, null, [Math.sin(a) * 0.255, 0.3 + (i % 2) * 0.012, Math.cos(a) * 0.235]));
    }
    list.push(hp(new THREE.OctahedronGeometry(0.055, 0), STAR, [1, 1, 0.45], [0, 0, 0.785], [0, 0.55, coatZ(0.55) + 0.01]));
    list.push(hp(new THREE.CylinderGeometry(0.255, 0.27, 0.04, 16), OUT2, null, null, [0, 0.36, 0]));
    const body = bodyWithScarf(list);
    attach(P.torso, body.geo, mat, nodes);
    // 雲朵頭髮：底層 + 一圈蓬蓬的雲團（正面留給臉）+ 星星髮夾
    const hair = [hp(sphere(0.45, 16, 12), WHITE, [1.05, 0.97, 1.02], null, [0, 0.27, -0.06])];
    const PUFFS = [
      [0, 1, -0.1, 0.2], [0.55, 0.78, 0.05, 0.17], [-0.55, 0.78, 0.05, 0.17], [0.85, 0.3, -0.15, 0.17],
      [-0.85, 0.3, -0.15, 0.17], [0.35, 0.55, -0.8, 0.18], [-0.35, 0.55, -0.8, 0.18], [0, 0.3, -1, 0.17],
      [0.7, -0.05, -0.55, 0.14], [-0.7, -0.05, -0.55, 0.14], [0.25, 0.8, 0.5, 0.14], [-0.28, 0.78, 0.48, 0.15],
      [0.0, 0.88, 0.32, 0.14], [0.72, 0.05, 0.42, 0.12], [-0.72, 0.05, 0.42, 0.12],
    ];
    PUFFS.forEach(([x, y, z, r], i) => {
      const d = new THREE.Vector3(x, y, z).normalize();
      hair.push(hp(sphere(r, 10, 8), i % 3 === 1 ? W2 : WHITE, null, null,
        [d.x * 0.45 * 1.0, 0.27 + d.y * 0.42, -0.06 + d.z * 0.44]));
    });
    // 彩虹髮夾（右側）
    [[0.085, 0xff7f93], [0.066, 0xffd25e], [0.047, 0x7fd0ff]].forEach(([r, c]) => {
      hair.push(hp(new THREE.TorusGeometry(r, 0.0105, 4, 12, Math.PI), c, null, [0, 0.75, -0.42], [0.41, 0.5, 0.17]));
    });
    hair.push(hp(sphere(0.035, 7, 5), WHITE, null, null, [0.41 + 0.068, 0.5 - 0.06, 0.17 - 0.06]));
    hair.push(hp(sphere(0.035, 7, 5), WHITE, null, null, [0.41 - 0.068, 0.5 + 0.05, 0.17 + 0.06]));
    attach(P.head, hmerge(hair), M.fluff, nodes);
    // 小翅膀（以翅根為樞紐，左右各一，羽毛從大到小）
    const wingGeo = (sx) => hmerge([
      hp(sphere(0.2, 10, 6), WHITE, [1, 0.58, 0.16], [0, 0, sx * 0.5], [sx * 0.18, 0.09, 0]),
      hp(sphere(0.16, 9, 6), W2, [1, 0.5, 0.15], [0, 0, sx * 0.1], [sx * 0.17, -0.04, 0.005]),
      hp(sphere(0.12, 8, 5), 0xcfe7ff, [1, 0.45, 0.14], [0, 0, -sx * 0.35], [sx * 0.12, -0.13, 0.01]),
    ]);
    const wings = [];
    for (const sx of [-1, 1]) {
      const w = attachPivot(P.torso, [0.08 * sx, 0.56, -0.3], nodes);
      attach(w, wingGeo(sx), M.fluff, []);
      wings.push(w);
    }
    return makeSkin('cloud', {
      nodes, bodyGeo: body.geo, scarfStart: body.scarfStart, scarfCount: body.scarfCount,
      carryPos: new THREE.Vector3(0, 0.84, -0.06), topY: 0.8, headExtra: 0.1,
      hatScale: 1.1, hatLift: 0.1, hatFwd: 0.0,
      wings,
    });
  },
};

// ---------------------------------------------------------------------------
// createPlayer
// ---------------------------------------------------------------------------
export function createPlayer({ scene, world }) {
  const parts = buildCharacter();
  const object = parts.root;
  if (scene) scene.add(object);

  const position = object.position;
  const up = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3(0, 0, 1);
  const vel = new THREE.Vector3();      // 切平面內的水平速度
  const lastGoodUp = new THREE.Vector3(0, 1, 0);
  let radius = PLANET_RADIUS;
  let vRad = 0;                          // 徑向速度
  let prevR = PLANET_RADIUS;             // 這個子步之前的半徑（平台 CCD 用）
  let supPlat = null;                    // supportAt() 最近一次選中的平台
  let jumpCutArmed = false;              // 這次上升可以被「提早放開」截短
  let jumpTime = 0;
  let jumpHeldKnown = false, jumpHeld = true;
  let carryKind = null, carryObj = null, carryScale = 1, carryTarget = 1, carryPop = 0;
  // v3 裝扮
  const cosmetics = { hat: null, scarf: 'sunny', trail: null };
  const hatCache = {};                   // id → { mesh, tilt, sprout, top }（帽子幾何，所有角色共用）
  let hatInfo = null;                    // 目前戴的帽子在目前角色身上的合身資訊（null = 沒戴）
  let scarfStars = null;
  // v4：角色與速度倍率
  const skins = { wanderer: parts.wanderer };
  let skin = parts.wanderer;
  let speedScale = 1;
  let walkSpeed = WALK_SPEED, runSpeed = RUN_SPEED;
  const HAT_BASE_POS = parts.hat.position.clone();
  let coyote = 0;
  let jumpBuffer = 0;
  let airTime = 0;
  let groundR = PLANET_RADIUS;
  let wantMag = 0;
  let wantRun = false;

  // 動畫狀態
  const anim = {
    time: 0, phase: 0, stepIndex: 0,
    walk: 0, run: 0, air: 0, water: 0, lean: 0, twist: 0,
    sq: 0, sqV: 0,
    visY: 0,
    blinkTimer: 1.5 + Math.random() * 2, blinkT: 0, doubleBlink: false,
    sproutX: 0, sproutXV: 0, sproutZ: 0, sproutZV: 0,
    turn: 0,
    celebT: -1,
    prevSpeed: 0, accel: 0,
    tailX: -0.42,
    // v4 角色專屬
    earL: 0, earR: 0, earX: 0, twitchT: 2.5, twitch: 0, twitchSide: 1,
    wag: 0, wagV: 0, flap: 0, flapPhase: 0, jet: 0,
  };

  const api = {
    object, position, up, forward,
    grounded: true,
    inWater: false,
    speed: 0,
    onJump: noop,
    onLand: noop,
    onStep: noop,
    update,
    setDirection,
    getDirection,
    celebrate,
    getHeadPosition,
    // v2
    supportPlatform: null,
    onBounce: noop,
    setCarry,
    setCarryScale,
    // v3
    setCosmetics,
    get cosmetics() { return cosmetics; },
    // v4
    setCharacter,
    get character() { return skin.id; },
    setSpeedScale,
    get speedScale() { return speedScale; },
  };

  const groundAt = (dir) => {
    const g = world && world.getGroundRadius ? world.getGroundRadius(dir) : PLANET_RADIUS;
    return Number.isFinite(g) ? g : PLANET_RADIUS;
  };
  const waterAt = (dir) => !!(world && world.isWater && world.isWater(dir));

  /**
   * 腳下可站立的最高表面（地面或平台頂面），q = 目前（或這一步之前較高的）腳底半徑。
   * 優先用 world.getSupportRadius（v2），沒有就退回 getGroundRadius（v1 世界也能跑）。
   * 另外加上邊緣寬容：腳掌還踩在平台邊上（EDGE_MARGIN 內）就算站著。結果的平台存到 supPlat。
   */
  function supportAt(dir, q) {
    let s;
    supPlat = null;
    if (world && typeof world.getSupportRadius === 'function') {
      s = world.getSupportRadius(dir, q);
      if (Number.isFinite(s)) supPlat = world.lastSupport || null;
      else s = groundAt(dir);
    } else {
      s = groundAt(dir);
    }
    const plats = world && world.platforms;
    if (plats) {
      for (let i = 0, n = plats.length; i < n; i++) {
        const p = plats[i];
        if (!p || !p.dir) continue;
        const top = p.top;
        if (!(top > s) || top > q + STEP_UP + 0.05) continue;
        const c = dir.x * p.dir.x + dir.y * p.dir.y + dir.z * p.dir.z;
        if (c <= 0) continue;
        const reach = (p.radius || 0) + EDGE_MARGIN;
        if ((1 - c * c) * top * top < reach * reach) { s = top; supPlat = p; }
      }
    }
    return s;
  }

  /** 平台側面碰撞（推出去、沿著滑）與從下方撞到浮空平台底部（停止上升） */
  function resolvePlatforms() {
    const plats = world && world.platforms;
    if (!plats || plats.length === 0) return;
    const feetHigh = Math.max(radius, prevR);
    for (let iter = 0; iter < 2; iter++) {
      let moved = false;
      for (let i = 0, n = plats.length; i < n; i++) {
        const p = plats[i];
        if (!p || !p.dir) continue;
        const pd = p.dir;
        const c = up.x * pd.x + up.y * pd.y + up.z * pd.z;
        if (c <= 0) continue;
        const reach = (p.radius || 0) + PLAYER_RADIUS;
        const d2 = (1 - c * c) * radius * radius;
        if (d2 >= reach * reach) continue;
        if (feetHigh >= p.top - STEP_UP) continue;               // 夠高：可以站上去或自動跨上
        const bottom = Number.isFinite(p.bottom) ? p.bottom : -Infinity;
        if (radius + BODY_HEIGHT <= bottom) continue;            // 整個人在浮空平台下方
        const d = Math.sqrt(d2);
        // 從下方往上撞：頭在上一步還在平台底下
        if (vRad > 0 && prevR + BODY_HEIGHT <= bottom + 0.02 && d < (p.radius || 0) + HEAD_RADIUS) {
          radius = bottom - BODY_HEIGHT - 0.005;
          vRad = Math.min(0, -0.5);
          jumpCutArmed = false;
          anim.sq = Math.min(anim.sq, -0.12);
          anim.sqV = -1.5;
          anim.sproutXV += 5;
          moved = true;
          continue;
        }
        // 側面：沿切平面推出
        _pos.copy(up).multiplyScalar(radius);
        _n.copy(pd).multiplyScalar(radius);
        _n.subVectors(_pos, _n);
        _n.addScaledVector(up, -_n.dot(up));
        const h = _n.length();
        if (h < 1e-5) _n.copy(forward).negate();
        else _n.multiplyScalar(1 / h);
        _pos.addScaledVector(_n, reach - d + 1e-4);
        const vn = vel.dot(_n);
        if (vn < 0) vel.addScaledVector(_n, -vn);
        up.copy(_pos).normalize();
        moved = true;
      }
      if (!moved) break;
    }
  }

  function fire(name) {
    const fn = api[name];
    if (typeof fn === 'function') {
      try { fn(); } catch (e) { console.error(e); }
    }
  }

  /** 讓 forward 落在切平面且為單位向量；退化時給一個穩定的值 */
  function fixForward() {
    forward.addScaledVector(up, -forward.dot(up));
    if (forward.lengthSq() < 1e-8) {
      tangentBasis(up, _tmp, forward);
    }
    forward.normalize();
  }

  function orient() {
    _right.crossVectors(up, forward).normalize();
    _mat.makeBasis(_right, up, forward);
    object.quaternion.setFromRotationMatrix(_mat);
  }

  function setDirection(dir) {
    up.copy(dir);
    if (!(up.lengthSq() > 1e-10) || !Number.isFinite(up.x + up.y + up.z)) up.set(0, 1, 0);
    up.normalize();
    lastGoodUp.copy(up);
    fixForward();
    // 站到地表；若會卡在平台裡（柱子、或離地太近的浮空平台），就改站到那個平台頂上
    groundR = radius = supportAt(up, groundAt(up) + STEP_UP);
    let onPlat = supPlat;
    const plats = world && world.platforms;
    for (let iter = 0; plats && iter < 4; iter++) {
      let moved = false;
      for (let i = 0; i < plats.length; i++) {
        const p = plats[i];
        if (!p || !p.dir || !(p.top > radius)) continue;
        const bottom = Number.isFinite(p.bottom) ? p.bottom : -Infinity;
        if (bottom >= radius + BODY_HEIGHT) continue;
        const c = up.dot(p.dir);
        const reach = (p.radius || 0) + PLAYER_RADIUS * 0.5;
        if (c > 0 && (1 - c * c) * p.top * p.top < reach * reach) { radius = p.top; onPlat = p; moved = true; }
      }
      if (!moved) break;
    }
    groundR = radius;
    prevR = radius;
    api.supportPlatform = onPlat;
    jumpCutArmed = false;
    position.copy(up).multiplyScalar(radius);
    vel.set(0, 0, 0);
    vRad = 0;
    coyote = 0;
    jumpBuffer = 0;
    airTime = 0;
    api.grounded = true;
    api.inWater = waterAt(up);
    api.speed = 0;
    anim.visY = 0;
    anim.sq = anim.sqV = 0;
    anim.celebT = -1;
    orient();
    updateShadow();
  }

  function getDirection(out = new THREE.Vector3()) {
    return out.copy(up);
  }

  function getHeadPosition(out = new THREE.Vector3()) {
    const extra = (carryObj ? 0.5 * carryScale : 0) + (hatInfo ? hatInfo.extra : skin.headExtra);
    return out.copy(position).addScaledVector(up, HEAD_TOP + parts.rig.position.y + extra);
  }

  /** 頭上頂著東西（目前只有 'ice'）；null = 放下 */
  function setCarry(kind) {
    kind = kind || null;
    if (kind === carryKind) return;
    if (carryObj) { parts.carry.remove(carryObj); carryObj = null; }
    carryKind = kind;
    if (kind) {
      const item = kind === 'ice' ? 'iceBlock' : kind;
      try { carryObj = createItem(item); } catch (e) { console.error(e); carryObj = null; }
      if (carryObj) {
        carryObj.scale.setScalar(0.001);
        parts.carry.add(carryObj);
        carryPop = 0;
        carryScale = carryTarget = 1;
        anim.sq = -0.12; anim.sqV = -1.5; // 頂上去時壓一下
      }
    }
    syncHead();
  }

  // ---- v3 裝扮 ----
  /** 第一次戴某頂帽子時建立（合併成一個 mesh），之後只切換 visible，不再配置任何東西 */
  function getHat(id) {
    if (hatCache[id]) return hatCache[id];
    const def = HAT_BUILD[id]();
    const mats = hatMats(parts.bodyMat);
    const mesh = new THREE.Mesh(def.geo, def.gold ? mats.gold : mats.body);
    mesh.name = 'hat-' + id;
    mesh.visible = false;
    parts.hat.add(mesh);
    const tilt = new THREE.Euler(def.tilt[0], def.tilt[1], def.tilt[2]);
    const info = { id, mesh, tilt, sprout: def.sprout, top: def.top };
    hatCache[id] = info;
    return info;
  }

  /**
   * v4：帽子戴在某位角色頭上的合身資訊（第一次才計算並快取）。
   * 帽子掛點 = 兜帽球心 + 角色的抬高/前移，縮放 = 角色頭的大小（頭盔、雲朵頭髮比兜帽大）。
   */
  function getFit(sk, id) {
    if (sk.fits[id]) return sk.fits[id];
    const hat = getHat(id);
    const adj = sk.hatAdjust[id] || {};
    const sc = sk.hatScale * (adj.s || 1);
    const pos = new THREE.Vector3(HAT_BASE_POS.x, HAT_BASE_POS.y + sk.hatLift + (adj.y || 0), HAT_BASE_POS.z + sk.hatFwd + (adj.z || 0));
    // 帽頂中心（頭部座標）：搬運物放這裡；'raise' 的小芽也從這裡冒出來
    const top = new THREE.Vector3(0, hat.top * sc, 0).applyEuler(hat.tilt).add(pos);
    const baseSprout = sk.sproutPos || parts.wanderer.sproutPos;
    const fit = {
      id, hat, mesh: hat.mesh, tilt: hat.tilt, sprout: hat.sprout, pos, scale: sc,
      sproutPos: hat.sprout === 'raise' ? top.clone().add(new THREE.Vector3(0, -0.04, 0)) : baseSprout.clone(),
      carryPos: top.y > sk.carryPos.y ? new THREE.Vector3(top.x, top.y + 0.005, top.z) : sk.carryPos.clone(),
      extra: Math.max(sk.headExtra, top.y - HAT_TOP_DEFAULT),
      ear: sk.earHat[id] || 0,
    };
    sk.fits[id] = fit;
    return fit;
  }

  /** 把目前的帽子（cosmetics.hat）戴到目前角色頭上 */
  function applyHat() {
    if (hatInfo) hatInfo.mesh.visible = false;
    hatInfo = null;
    const id = cosmetics.hat;
    if (id) {
      try { hatInfo = getFit(skin, id); } catch (e) { console.error(e); hatInfo = null; }
    }
    if (hatInfo) {
      hatInfo.mesh.visible = true;
      parts.hat.rotation.copy(hatInfo.tilt);
      parts.hat.position.copy(hatInfo.pos);
      parts.hat.scale.setScalar(hatInfo.scale);
    }
  }

  /** 小芽（天線）與頭頂搬運物的位置/可見度要配合帽子與角色 */
  function syncHead() {
    const { sprout, carry } = parts;
    const h = hatInfo;
    sprout.visible = !!skin.sproutPos && !carryObj && !(h && h.sprout === 'hide');
    sprout.position.copy(h ? h.sproutPos : (skin.sproutPos || parts.wanderer.sproutPos));
    const cp = h ? h.carryPos : skin.carryPos;
    carry.position.set(cp.x, cp.y, cp.z);
  }

  /**
   * v4：換角色（CHARACTERS 之一；未知 id 忽略）。第一次選到時建立模型，之後只切換 visible，
   * 帽子/圍巾/搬運物/動畫狀態都保留。
   */
  function setCharacter(id) {
    if (typeof id !== 'string' || !CHARACTERS.includes(id)) return;
    if (id === skin.id) return;
    let next = skins[id];
    if (!next) {
      const build = SKIN_BUILD[id];
      if (!build) return;
      try { next = build(parts); } catch (e) { console.error(e); return; }
      for (const n of next.nodes) n.visible = false;
      skins[id] = next;
    }
    for (const n of skin.nodes) n.visible = false;
    skin = next;
    for (const n of skin.nodes) n.visible = true;
    if (skin.jet) skin.jet.visible = false;
    setScarfColor(cosmetics.scarf);
    applyHat();
    syncHead();
    anim.earL = anim.earR = skin.earRest;
  }

  /** v4：速度倍率（SPEED_SCALES 的值），乘在走路/跑步速度上；跳躍高度不變 */
  function setSpeedScale(s) {
    s = +s;
    if (!Number.isFinite(s) || s <= 0) s = 1;
    speedScale = clamp(s, 0.3, 2.5);
    walkSpeed = WALK_SPEED * speedScale;
    runSpeed = RUN_SPEED * speedScale;
  }

  function setScarfColor(id) {
    let hex = SCARF_COLORS[id] !== undefined ? SCARF_COLORS[id] : SCARF_COLORS.sunny;
    if (hex === SCARF_COLORS.sunny) hex = skin.sunny; // 例如熊熊的預設圍巾是蜂蜜色
    _hc.set(hex);
    if (skin.scarfApplied !== hex) {
      const attr = skin.bodyGeo.attributes.color;
      const arr = attr.array;
      const a0 = skin.scarfStart * 3, a1 = (skin.scarfStart + skin.scarfCount) * 3;
      for (let i = a0; i < a1; i += 3) { arr[i] = _hc.r; arr[i + 1] = _hc.g; arr[i + 2] = _hc.b; }
      attr.needsUpdate = true;
      skin.scarfApplied = hex;
    }
    const tattr = parts.tailGeo.attributes.color;
    const tarr = tattr.array;
    // 尾巴流蘇稍微深一點
    const fringe = tarr.length - parts.tailFringe * 3;
    for (let i = 0; i < tarr.length; i += 3) {
      const k = i >= fringe ? 0.8 : 1;
      tarr[i] = _hc.r * k; tarr[i + 1] = _hc.g * k; tarr[i + 2] = _hc.b * k;
    }
    tattr.needsUpdate = true;
    if (id === 'night' && !scarfStars) {
      scarfStars = buildScarfStars(parts.faceMat);
      parts.torso.add(scarfStars.ring);
      parts.scarfTail.add(scarfStars.tail);
    }
    if (scarfStars) scarfStars.ring.visible = scarfStars.tail.visible = id === 'night';
  }

  /**
   * 換裝：{ hat, scarf, trail }。沒給（undefined）的欄位保持不變；
   * hat: null | HAT_IDS；scarf: SCARF_IDS（null/未知 = 'sunny'）；trail 只記住（粒子由 main 發射）。
   */
  function setCosmetics(c) {
    if (!c || typeof c !== 'object') return;
    if (c.hat !== undefined) {
      const id = HAT_BUILD[c.hat] ? c.hat : null;
      if (id !== cosmetics.hat || (id && !hatInfo)) {
        cosmetics.hat = id;
        applyHat();
        cosmetics.hat = hatInfo ? id : null;
        syncHead();
      }
    }
    if (c.scarf !== undefined) {
      const id = SCARF_COLORS[c.scarf] !== undefined ? c.scarf : 'sunny';
      if (id !== cosmetics.scarf) {
        setScarfColor(id);
        cosmetics.scarf = id;
      }
    }
    if (c.trail !== undefined) {
      cosmetics.trail = typeof c.trail === 'string' && c.trail ? c.trail : null;
    }
  }

  /** 搬運物的大小（1 = 原尺寸，0 = 融化消失），平滑過渡 */
  function setCarryScale(s) {
    carryTarget = clamp(Number.isFinite(+s) ? +s : 1, 0, 1.5);
  }

  function celebrate() {
    anim.celebT = 0;
    if (api.grounded) {
      vRad = 8.5;
      api.grounded = false;
      coyote = 0;
      anim.sq = 0.18;
      anim.sqV = 0;
    }
  }

  /** 計算鏡頭在玩家切平面上的前/右方向 */
  function cameraBasis(camera) {
    if (camera && camera.matrixWorld) {
      camera.getWorldDirection(_camFwd);
      _camFwd.addScaledVector(up, -_camFwd.dot(up));
      if (_camFwd.lengthSq() < 0.01) {
        // 鏡頭幾乎垂直往下看：改用鏡頭的「上」
        _camUp.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(_quat));
        _camUp.addScaledVector(up, -_camUp.dot(up));
        if (_camUp.lengthSq() > 1e-6) _camFwd.copy(_camUp);
      }
    } else {
      _camFwd.copy(forward);
    }
    if (_camFwd.lengthSq() < 1e-8) _camFwd.copy(forward);
    _camFwd.normalize();
    _camRight.crossVectors(_camFwd, up).normalize(); // moveX > 0 = 螢幕右方
  }

  /** 把向量 v 平行移動到新的切平面（保持長度） */
  function transport(v, n) {
    const len = v.length();
    if (len < 1e-9) { v.set(0, 0, 0); return; }
    v.addScaledVector(n, -v.dot(n));
    const l2 = v.length();
    if (l2 < 1e-9) { v.set(0, 0, 0); return; }
    v.multiplyScalar(len / l2);
  }

  function resolveObstacles() {
    const obs = world && world.obstacles;
    if (!obs || obs.length === 0) return;
    for (let iter = 0; iter < 3; iter++) {
      _pos.copy(up).multiplyScalar(radius);
      let moved = false;
      for (let i = 0, n = obs.length; i < n; i++) {
        const o = obs[i];
        if (!o || !o.position) continue;
        const op = o.position;
        const dx = _pos.x - op.x, dy = _pos.y - op.y, dz = _pos.z - op.z;
        const minD = PLAYER_RADIUS + (o.radius || 0);
        const lim = minD + OBSTACLE_SLACK;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > lim * lim) continue;
        // 可選：有 height 的障礙物可以跳過去
        if (o.height !== undefined && radius - op.length() > o.height) continue;
        const dn = dx * up.x + dy * up.y + dz * up.z;
        let tx = dx - up.x * dn, ty = dy - up.y * dn, tz = dz - up.z * dn;
        const h2 = tx * tx + ty * ty + tz * tz;
        if (h2 >= minD * minD) continue;
        const h = Math.sqrt(h2);
        if (h < 1e-5) _n.copy(forward).negate(); // 正好在中心：往後推
        else _n.set(tx / h, ty / h, tz / h);
        _pos.addScaledVector(_n, minD - h + 1e-4);
        const vn = vel.dot(_n);
        if (vn < 0) {
          vel.addScaledVector(_n, -vn);
          // 正面撞上時給一點側向滑動，比較容易繞過樹和石頭
          _side.crossVectors(up, _n);
          const vt = vel.dot(_side);
          const dsg = _desired.dot(_side);
          const sgn = Math.abs(vt) > 0.05 ? Math.sign(vt) : (Math.abs(dsg) > 0.02 ? Math.sign(dsg) : 1);
          vel.addScaledVector(_side, sgn * -vn * 0.35);
        }
        moved = true;
      }
      if (!moved) break;
      up.copy(_pos).normalize();
    }
  }

  function physicsStep(h) {
    const wasGrounded = api.grounded;
    // 站在海上踏石、或跳得比海面高時不算在水裡
    // 整合者 v4：河流、湖泊等內陸水面用 world.getWaterSurface 判斷
    if (world.getWaterSurface) {
      const ws = world.getWaterSurface(up);
      api.inWater = ws === ws && radius < ws + IN_WATER_MAX_HEIGHT && waterAt(up);
    } else {
      api.inWater = radius < SEA_LEVEL + IN_WATER_MAX_HEIGHT && waterAt(up);
    }

    // 目標速度
    _target.copy(_desired);
    _target.addScaledVector(up, -_target.dot(up));
    const tl = _target.length();
    let targetSpeed = 0;
    if (tl > 1e-6 && wantMag > 0) {
      targetSpeed = (wantRun ? runSpeed : walkSpeed) * wantMag * (api.inWater ? WATER_SPEED : 1);
      if (!wasGrounded) targetSpeed *= AIR_BOOST;
      _target.multiplyScalar(targetSpeed / tl);
    } else {
      _target.set(0, 0, 0);
    }
    const accelerating = targetSpeed > 0.01;
    let lambda = wasGrounded
      ? (accelerating ? ACCEL_GROUND : DECEL_GROUND)
      : (accelerating ? ACCEL_AIR : DECEL_AIR);
    if (api.inWater) lambda *= 0.75;
    // 急轉彎時更快反應（避免冰面感）
    if (wasGrounded && accelerating && vel.dot(_target) < 0) lambda *= 1.6;
    vel.lerp(_target, 1 - Math.exp(-lambda * h));
    if (!accelerating && vel.lengthSq() < 0.0025) vel.set(0, 0, 0);

    // 跳躍（土狼時間 + 輸入緩衝）
    coyote = wasGrounded ? COYOTE_TIME : coyote - h;
    jumpBuffer -= h;
    if (jumpBuffer > 0 && coyote > 0) {
      vRad = JUMP_SPEED * (api.inWater ? WATER_JUMP : 1);
      if (!api.inWater) vel.multiplyScalar(AIR_BOOST);
      api.grounded = false;
      api.supportPlatform = null;
      coyote = 0;
      jumpBuffer = 0;
      airTime = 0;
      jumpCutArmed = true;
      jumpTime = 0;
      anim.sq = 0.26;
      anim.sqV = 0;
      anim.sproutXV -= 6;
      anim.jet = 1.25;
      anim.flap = 1;
      fire('onJump');
    }

    // 可變跳躍高度：上升初段放開跳躍鍵 → 截短一次（舊版 input 沒有 jumpHeld 時永遠是完整跳）
    if (jumpCutArmed) {
      jumpTime += h;
      if (vRad <= JUMP_CUT_MIN_VEL || api.grounded) jumpCutArmed = false;
      else if (jumpHeldKnown && !jumpHeld && jumpTime >= JUMP_CUT_MIN_TIME) {
        vRad *= JUMP_CUT;
        jumpCutArmed = false;
      }
    }

    // 重力
    if (!api.grounded) {
      vRad -= GRAVITY * (vRad < 0 ? FALL_GRAVITY_MULT : 1) * h;
      if (vRad < -MAX_FALL_SPEED) vRad = -MAX_FALL_SPEED;
    }

    // 位移：水平沿切平面、徑向沿法線
    prevR = radius;
    const stepLen = vel.length() * h;
    _tmp.copy(up).multiplyScalar(radius).addScaledVector(vel, h);
    radius += vRad * h;
    _tmp.normalize();
    transport(vel, _tmp);
    up.copy(_tmp);
    fixForward();

    resolveObstacles();
    resolvePlatforms();

    // 支撐面（地面或平台頂面）；用這一步前後較高的半徑查詢，快速落下也不會穿過平台
    const g = supportAt(up, Math.max(prevR, radius));
    const plat = supPlat;
    groundR = g;
    if (radius <= g) {
      const rise = g - radius;
      if (!api.grounded && vRad > 0.5) {
        radius = g; // 上升中擦到平台邊（< STEP_UP）：墊上去，繼續往上
      } else if (plat && plat.bounce > 0 && vRad <= 0.5) {
        radius = g;
        bounce(plat);
      } else {
        if (api.grounded && rise > 0.12) anim.visY -= rise - 0.12; // 小台階：視覺平滑跨上
        radius = g;
        if (!api.grounded) land(plat);
        if (vRad < 0) vRad = 0;
        api.grounded = true;
      }
    } else if (api.grounded && vRad <= 0 && radius - g < 0.06 + stepLen * 1.15) {
      const drop = radius - g;
      if (drop > 0.12) anim.visY += drop - 0.12;
      radius = g; // 下坡貼地
      vRad = 0;
    } else {
      api.grounded = false;
    }
    api.supportPlatform = api.grounded ? plat : null;
    if (!api.grounded) airTime += h;

    position.copy(up).multiplyScalar(radius);
  }

  function land(plat) {
    const impact = -vRad;
    if (airTime > LAND_SOUND_AIRTIME) {
      anim.sq = Math.min(anim.sq, 0);
      anim.sqV = -clamp(impact * 0.32, 1.2, 5.5);
      anim.sproutXV += clamp(impact * 0.5, 1, 7);
      fire('onLand');
    }
    // 落在平台上：再加一點俐落的小壓扁
    if (plat) anim.sqV = Math.min(anim.sqV, -2.4);
    airTime = 0;
    jumpCutArmed = false;
  }

  function bounce(plat) {
    vRad = plat.bounce;
    api.grounded = false;
    coyote = 0;
    jumpBuffer = 0;
    jumpCutArmed = false; // 彈跳不受放開跳躍鍵影響
    airTime = 0;
    anim.sq = 0.36;
    anim.sqV = 2;
    anim.sproutXV -= 9;
    anim.jet = 1.4;
    anim.flap = 1;
    fire('onBounce');
  }

  function update(dt, input, camera) {
    if (!(dt > 0)) return;
    if (dt > 0.25) dt = 0.25;
    input = input || NO_INPUT;

    cameraBasis(camera);
    let mx = +input.moveX || 0, my = +input.moveY || 0;
    _desired.copy(_camRight).multiplyScalar(mx).addScaledVector(_camFwd, my);
    let mag = _desired.length();
    if (mag > 1) { _desired.divideScalar(mag); mag = 1; }
    if (mag < 0.06) { mag = 0; _desired.set(0, 0, 0); }
    wantMag = mag;
    wantRun = !!input.run;
    if (input.jumpPressed) jumpBuffer = JUMP_BUFFER;
    jumpHeldKnown = input.jumpHeld !== undefined;
    jumpHeld = jumpHeldKnown ? !!input.jumpHeld : true;

    const steps = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-6));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) physicsStep(h);

    // NaN 防護
    if (!Number.isFinite(position.x + position.y + position.z + vel.x + vel.y + vel.z + vRad)) {
      setDirection(lastGoodUp);
    } else {
      lastGoodUp.copy(up);
    }

    api.speed = vel.length();
    face(dt, mag);
    orient();
    animate(dt);
    updateShadow();
  }

  /** 平滑轉向移動方向 */
  function face(dt, mag) {
    let has = false;
    if (mag > 0.05) { _tmp2.copy(_desired); has = true; }
    else if (api.speed > 1.5) { _tmp2.copy(vel); has = true; }
    anim.turn = damp(anim.turn, 0, 8, dt);
    if (!has) return;
    _tmp2.addScaledVector(up, -_tmp2.dot(up));
    if (_tmp2.lengthSq() < 1e-8) return;
    _tmp2.normalize();
    const d = clamp(forward.dot(_tmp2), -1, 1);
    let ang = Math.acos(d);
    if (ang < 1e-4) return;
    _side.copy(_tmp2).addScaledVector(forward, -d);
    if (_side.lengthSq() < 1e-8) _side.crossVectors(up, forward); // 正好反方向
    _side.normalize();
    const rate = api.grounded ? TURN_RATE_GROUND : TURN_RATE_AIR;
    const stepAng = Math.min(ang, ang * (1 - Math.exp(-rate * dt)) + 1.5 * dt);
    const sign = _side.dot(_tmp3.crossVectors(up, forward)) >= 0 ? 1 : -1;
    anim.turn = clamp(anim.turn + sign * stepAng * 0.6, -1, 1);
    forward.multiplyScalar(Math.cos(stepAng)).addScaledVector(_side, Math.sin(stepAng));
    fixForward();
  }

  // -------------------------------------------------------------------------
  // 程序動畫
  // -------------------------------------------------------------------------
  function animate(dt) {
    const a = anim;
    const { rig, torso, head, eyes, sprout, legs, arms } = parts;
    a.time += dt;
    const t = a.time;
    const spd = api.speed;
    const g = api.grounded;

    a.accel = damp(a.accel, (spd - a.prevSpeed) / Math.max(dt, 1e-4), 10, dt);
    a.prevSpeed = spd;

    a.walk = damp(a.walk, g ? clamp(spd / walkSpeed, 0, 1) : 0, 10, dt);
    a.run = damp(a.run, g ? clamp((spd - walkSpeed * 0.9) / (runSpeed - walkSpeed * 0.9), 0, 1) : 0, 8, dt);
    a.air = damp(a.air, g ? 0 : 1, g ? 14 : 8, dt);
    a.water = damp(a.water, api.inWater ? 1 : 0, 5, dt);

    // 步伐：每走 stride 距離踏一步（步頻跟著地面速度，腳不打滑）；速度倍率大時步幅也稍微變大
    if (g && spd > 0.25) {
      const stride = (api.inWater ? STRIDE_WATER : STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * a.run)
        * (0.65 + 0.35 * speedScale);
      a.phase += (spd * dt / stride) * Math.PI;
      const idx = Math.floor(a.phase / Math.PI);
      if (idx !== a.stepIndex) {
        a.stepIndex = idx;
        if (spd > 1) fire('onStep');
      }
    } else {
      a.stepIndex = Math.floor(a.phase / Math.PI);
    }
    const s = Math.sin(a.phase);
    const bobWave = Math.abs(Math.cos(a.phase));

    // 擠壓/拉伸彈簧
    a.sqV += (-190 * a.sq - 12 * a.sqV) * dt;
    a.sq = clamp(a.sq + a.sqV * dt, -0.38, 0.38);
    let sy = 1 + a.sq + (g ? 0 : clamp(vRad * 0.012, -0.07, 0.1));
    const breathe = Math.sin(t * 2.4) * 0.018 * (1 - a.walk);
    sy += breathe;
    const sxz = 1 / Math.sqrt(Math.max(0.3, sy));
    rig.scale.set(sxz, sy, sxz);

    // 前傾（跑步、加速）
    const leanTarget = a.walk * 0.07 + a.run * 0.2 + clamp(a.accel * 0.012, -0.12, 0.12) * (g ? 1 : 0.3)
      - a.water * 0.03;
    a.lean = damp(a.lean, leanTarget, 9, dt);
    rig.rotation.x = a.lean;
    rig.rotation.z = a.turn * -0.12 * a.walk;

    // 慶祝：轉一圈 + 舉手
    let spin = 0, cheer = 0;
    if (a.celebT >= 0) {
      a.celebT += dt;
      const k = clamp(a.celebT / 0.9, 0, 1);
      spin = (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2) * Math.PI * 2;
      cheer = Math.sin(Math.PI * clamp(a.celebT / 1.1, 0, 1));
      if (a.celebT > 1.1) a.celebT = -1;
    }
    rig.rotation.y = spin;

    // 視覺高度：台階平滑 + 走路彈跳 + 水中浮沉
    a.visY = clamp(damp(a.visY, 0, 16, dt), -0.4, 0.4);
    const walkBob = bobWave * (0.05 + 0.03 * a.run) * a.walk * (1 - a.water * 0.6);
    const waterBob = (Math.sin(t * 3.1) * 0.035 - 0.06) * a.water;
    rig.position.y = a.visY + waterBob;
    torso.position.y = walkBob - 0.02 * a.walk;
    a.twist = damp(a.twist, s * 0.14 * a.walk, 20, dt);
    torso.rotation.y = a.twist;

    // 腿
    const legAmp = (0.72 + 0.33 * a.run) * a.walk * (1 - 0.4 * a.water);
    legs[0].rotation.x = s * legAmp - a.air * 0.55;
    legs[1].rotation.x = -s * legAmp + a.air * 0.25;
    legs[0].position.y = 0.29 + Math.max(0, -s) * 0.06 * a.walk;
    legs[1].position.y = 0.29 + Math.max(0, s) * 0.06 * a.walk;

    // 手臂
    const armAmp = (0.6 + 0.45 * a.run) * a.walk * (1 - a.water);
    const paddle = Math.sin(t * 7) * a.water;
    const idleSway = Math.sin(t * 2.4 + 0.6) * 0.04 * (1 - a.walk);
    const airLift = a.air * (0.9 + clamp(vRad * 0.04, -0.4, 0.4));
    const cheerLift = cheer * 2.5;
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      const arm = arms[i];
      arm.rotation.x = (i === 0 ? -s : s) * armAmp + paddle * 0.7 * (i === 0 ? 1 : -1) - a.run * 0.25 * a.walk;
      const spread = 0.22 + idleSway + airLift + a.water * 0.7 + cheerLift
        + (cheer > 0 ? Math.sin(t * 22 + i * 2) * 0.2 * cheer : 0);
      arm.rotation.z = sx * Math.min(spread, 2.8);
    }

    // 頭：略為反向補償前傾、走路點頭、偶爾歪頭
    head.rotation.x = -a.lean * 0.45 + bobWave * 0.05 * a.walk - a.air * 0.08;
    head.rotation.z = Math.sin(t * 0.7) * 0.05 * (1 - a.walk) + a.turn * 0.1;
    head.rotation.y = -a.twist * 0.6;

    // 眨眼（慶祝時瞇成開心眼）
    a.blinkTimer -= dt;
    if (a.blinkTimer <= 0) {
      a.blinkT = 0.13;
      a.blinkTimer = a.doubleBlink ? 0.22 : 2 + Math.random() * 3.5;
      a.doubleBlink = !a.doubleBlink && Math.random() < 0.25;
    }
    let eyeS = 1;
    if (a.blinkT > 0) {
      a.blinkT -= dt;
      eyeS = 0.12;
    }
    if (cheer > 0.2) eyeS = Math.min(eyeS, 0.35);
    eyes.scale.y = damp(eyes.scale.y, eyeS, 40, dt);

    // 小芽：彈簧擺動，受速度、加速度、跳躍影響
    const sxTarget = -clamp(spd * 0.035, 0, 0.45) - (g ? 0 : clamp(vRad * 0.02, -0.25, 0.25));
    a.sproutXV += (-60 * (a.sproutX - sxTarget) - 5 * a.sproutXV) * dt
      - clamp(a.accel, -30, 30) * 0.4 * dt;
    a.sproutX = clamp(a.sproutX + a.sproutXV * dt, -1, 1);
    const szTarget = Math.sin(t * 1.4) * 0.12 * (1 - a.walk) + Math.sin(a.phase * 2) * 0.14 * a.walk
      + a.turn * 0.4;
    a.sproutZV += (-50 * (a.sproutZ - szTarget) - 5 * a.sproutZV) * dt;
    a.sproutZ = clamp(a.sproutZ + a.sproutZV * dt, -1, 1);
    sprout.rotation.x = a.sproutX + Math.sin(t * 2.4) * 0.03;
    sprout.rotation.z = a.sproutZ;

    // 圍巾尾巴：垂在胸前，走路時隨步伐彈跳、往外甩，空中往上飄（只往前/外擺，不會穿進身體）
    const flutter = clamp(spd / runSpeed, 0, 1) * (g ? 1 : 0.5);
    const tailX = -0.42 - bobWave * 0.35 * a.walk - flutter * 0.25 - a.air * clamp(-vRad * 0.05 + 0.2, 0, 0.7)
      - Math.max(0, Math.sin(t * 2.4)) * 0.03 * (1 - a.walk);
    a.tailX = damp(a.tailX, tailX, 12, dt);
    parts.scarfTail.rotation.x = a.tailX;
    parts.scarfTail.rotation.z = 0.12 + clamp(a.sproutZ * 0.2, -0.15, 0.15) + flutter * 0.4 + s * 0.12 * a.walk + cheer * 0.5;

    // 頭頂搬運物：彈出、融化縮小、跟著走路晃動（用小芽的彈簧值，有一點慣性）
    if (carryObj) {
      carryPop = Math.min(1, carryPop + dt * 3.2);
      const pop = carryPop < 1 ? 1 + Math.sin(carryPop * Math.PI) * 0.35 * (1 - carryPop) : 1;
      carryScale = damp(carryScale, carryTarget, 6, dt);
      const sc = 0.82 * carryScale * Math.min(1, carryPop * 2.5) * pop;
      carryObj.scale.setScalar(Math.max(sc, 0.001));
      carryObj.visible = sc > 0.01;
      const { carry } = parts;
      carry.rotation.x = a.sproutX * 0.22 + Math.sin(a.phase * 2) * 0.05 * a.walk;
      carry.rotation.z = a.sproutZ * 0.3;
      carry.rotation.y = 0.45 + a.turn * 0.2;
      carry.position.y = (hatInfo ? hatInfo.carryPos.y : skin.carryPos.y) + bobWave * 0.04 * a.walk;
    }

    if (skin.id !== 'wanderer') animateSkin(dt, t, s, spd, g, cheer);
  }

  /** v4：角色專屬的小動作（耳朵、尾巴、翅膀、噴射火焰） */
  function animateSkin(dt, t, s, spd, g, cheer) {
    const a = anim;
    const sk = skin;
    const sp = clamp(spd / runSpeed, 0, 1);
    if (sk.ears) {
      // 偶爾抖一下耳朵；戴帽子或頂冰塊時往外倒；跑步時往後貼
      a.twitchT -= dt;
      if (a.twitchT <= 0) {
        a.twitchT = 1.6 + Math.random() * 3.2;
        a.twitch = 1;
        a.twitchSide = Math.random() < 0.5 ? -1 : 1;
      }
      a.twitch = Math.max(0, a.twitch - dt * 5);
      const tw = Math.sin(a.twitch * Math.PI * 3) * 0.22 * a.twitch;
      const base = sk.earRest + (hatInfo ? hatInfo.ear : 0) + (carryObj ? sk.earCarry : 0)
        + a.air * clamp(-vRad * 0.02, -0.15, 0.2) - cheer * 0.2;
      a.earL = damp(a.earL, base + (a.twitchSide < 0 ? tw : 0), 14, dt);
      a.earR = damp(a.earR, base + (a.twitchSide > 0 ? tw : 0), 14, dt);
      a.earX = damp(a.earX, -sp * 0.45 * (g ? 1 : 0.5) + Math.sin(a.phase * 2) * 0.06 * a.walk + clamp(a.sproutX * 0.2, -0.15, 0.15), 12, dt);
      sk.ears[0].rotation.set(a.earX, 0, a.earL);
      sk.ears[1].rotation.set(a.earX, 0, -a.earR);
    }
    if (sk.tail) {
      // 尾巴彈簧：走路左右甩、起跳往下壓然後翹起
      const wagTarget = sk.tailKind === 'fox'
        ? Math.sin(t * 2.3) * 0.32 * (1 - a.walk) + s * 0.38 * a.walk + a.turn * 0.5
        : Math.sin(t * 3.1) * 0.18 * (1 - a.walk) + s * 0.3 * a.walk;
      a.wagV += (-70 * (a.wag - wagTarget) - 7 * a.wagV) * dt;
      a.wag = clamp(a.wag + a.wagV * dt, -1, 1);
      const lift = sk.tailKind === 'fox'
        ? -sp * 0.5 * (g ? 1 : 0.4) + (g ? 0 : clamp(-vRad * 0.03, -0.35, 0.35)) + cheer * 0.4 + Math.sin(t * 1.7) * 0.05
        : (g ? 0 : clamp(-vRad * 0.02, -0.2, 0.2));
      sk.tail.rotation.set(lift, a.wag, sk.tailKind === 'fox' ? -a.wag * 0.35 : a.wag * 0.4);
    }
    if (sk.wings) {
      // 小翅膀：地面上慢慢搧，空中快速拍動，起跳時用力拍一下
      a.flap = Math.max(0, a.flap - dt * 2.2);
      const rate = g ? 3.2 + sp * 4 + cheer * 10 : 16;
      a.flapPhase += dt * rate;
      const amp = g ? 0.12 + sp * 0.12 + cheer * 0.4 : 0.5 + a.flap * 0.3;
      const f = Math.sin(a.flapPhase) * amp;   // 上下拍（繞前後軸）
      const open = 0.55 - (g ? 0 : 0.2);       // 往後收的角度（空中張開一點）
      sk.wings[0].rotation.set(0.1, -(open + f * 0.25), -(0.1 + f));
      sk.wings[1].rotation.set(0.1, open + f * 0.25, 0.1 + f);
    }
    if (sk.jet) {
      // 噴射背包：起跳時噴一大口，上升途中小火，落地熄火
      const want = !g && vRad > 0 ? 0.45 : 0;
      a.jet = Math.max(want, a.jet - dt * 3.2);
      const k = a.jet > 1 ? 1 + (a.jet - 1) * 0.6 : a.jet;
      const on = k > 0.04;
      sk.jet.visible = on;
      if (on) {
        const fl = 0.85 + Math.sin(t * 47) * 0.1 + Math.sin(t * 31) * 0.06;
        sk.jet.scale.set(0.6 + 0.4 * k, k * fl, 0.6 + 0.4 * k);
      }
    }
  }

  function updateShadow() {
    const { shadow, shadowMat } = parts;
    // 影子落在腳下的支撐面（平台頂面或地面）
    const g0 = supportAt(up, radius);
    const onPlat = supPlat !== null;
    const hgt = Math.max(0, radius - g0);
    if (onPlat) {
      shadow.quaternion.identity();
      shadow.position.set(0, g0 - radius + 0.03, 0);
      const sc = clamp(1 - hgt * 0.13, 0.45, 1);
      shadow.scale.set(sc, 1, sc);
      shadowMat.opacity = 0.36 * clamp(1 - hgt * 0.16, 0.2, 1);
      return;
    }
    // 依地形斜率傾斜陰影
    _right.crossVectors(up, forward).normalize();
    const eps = 0.35 / Math.max(radius, 1);
    _p1.copy(up).addScaledVector(_right, eps).normalize();
    _p1.multiplyScalar(groundAt(_p1));
    _p2.copy(up).addScaledVector(forward, eps).normalize();
    _p2.multiplyScalar(groundAt(_p2));
    _tmp.copy(up).multiplyScalar(g0);
    _p1.sub(_tmp);
    _p2.sub(_tmp);
    _n.crossVectors(_p2, _p1);
    if (_n.dot(up) < 0) _n.negate();
    if (_n.lengthSq() > 1e-10) {
      _n.normalize();
      _quat.copy(object.quaternion).invert();
      _n.applyQuaternion(_quat);
      shadow.quaternion.setFromUnitVectors(_Y, _n);
    } else {
      shadow.quaternion.identity();
    }
    shadow.position.set(0, g0 - radius + 0.03, 0);
    const sc = clamp(1 - hgt * 0.13, 0.45, 1);
    shadow.scale.set(sc, 1, sc);
    shadowMat.opacity = 0.36 * clamp(1 - hgt * 0.16, 0.2, 1) * (api.inWater ? 0.35 : 1);
  }

  setScarfColor('sunny');
  setDirection(up);
  return api;
}
