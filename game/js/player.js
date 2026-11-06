// 分身 2：角色與物理 —— 小旅人角色模型、程序動畫、球面星球物理。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  GRAVITY, WALK_SPEED, RUN_SPEED, JUMP_SPEED, PLAYER_RADIUS, PLANET_RADIUS, PALETTE,
} from './config.js';
import { clamp, damp, tangentBasis } from './utils.js';

// ---- 調整參數 ----
const COYOTE_TIME = 0.1;
const JUMP_BUFFER = 0.12;
const WATER_SPEED = 0.6;
const WATER_JUMP = 0.72;
const FALL_GRAVITY_MULT = 1.18;  // 下落時重力稍大，跳躍更俐落
const MAX_FALL_SPEED = 40;
const ACCEL_GROUND = 11;         // 指數平滑速率（加速）
const DECEL_GROUND = 15;         // 指數平滑速率（減速）
const ACCEL_AIR = 2.6;
const DECEL_AIR = 0.7;
const TURN_RATE_GROUND = 14;
const TURN_RATE_AIR = 6;
const LAND_SOUND_AIRTIME = 0.15;
const SUBSTEP = 1 / 60;
const OBSTACLE_SLACK = 3;        // 3D 距離超過 (半徑和 + 這個) 就跳過
const HEAD_TOP = 1.8;            // 表情泡泡錨點高度

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
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(0.14 * sx, 0.29, 0);
    pivot.add(new THREE.Mesh(legGeo, bodyMat));
    rig.add(pivot);
    legs.push(pivot);
  }

  // 上半身（可上下彈跳、扭轉）
  const torso = new THREE.Group();
  rig.add(torso);

  const bodyGeo = merge([
    part(sphere(0.36, 12, 9), COL.coat, { s: [1, 0.94, 0.92], p: [0, 0.55, 0] }),
    part(new THREE.TorusGeometry(0.26, 0.075, 6, 14), COL.scarf, { r: [Math.PI / 2, 0, 0], p: [0, 0.83, 0] }),
  ]);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  torso.add(body);

  // 探險背包 + 睡袋卷
  const packGeo = merge([
    part(new THREE.BoxGeometry(0.46, 0.46, 0.24), COL.accent, { p: [0, 0.58, -0.36] }),
    part(new THREE.BoxGeometry(0.48, 0.17, 0.27), COL.accentDark, { p: [0, 0.76, -0.36] }),
    part(new THREE.BoxGeometry(0.26, 0.15, 0.07), COL.accentDark, { p: [0, 0.48, -0.5] }),
    part(new THREE.CylinderGeometry(0.095, 0.095, 0.56, 8), COL.roll, { r: [0, 0, Math.PI / 2], p: [0, 0.93, -0.38] }),
  ]);
  const pack = new THREE.Mesh(packGeo, bodyMat);
  torso.add(pack);

  // 手臂（肩膀為樞紐）
  const armGeo = merge([
    part(new THREE.CapsuleGeometry(0.085, 0.13, 3, 8), COL.coat, { p: [0, -0.12, 0] }),
    part(sphere(0.095, 8, 6), COL.skin, { p: [0, -0.25, 0] }),
  ]);
  const arms = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(0.31 * sx, 0.72, 0);
    pivot.add(new THREE.Mesh(armGeo, bodyMat));
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
  head.add(new THREE.Mesh(headGeo, bodyMat));

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
  sprout.add(new THREE.Mesh(sproutGeo, bodyMat));
  head.add(sprout);

  return { root, rig, torso, head, eyes, sprout, legs, arms, shadow, shadowMat };
}

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
  };

  const groundAt = (dir) => {
    const g = world && world.getGroundRadius ? world.getGroundRadius(dir) : PLANET_RADIUS;
    return Number.isFinite(g) ? g : PLANET_RADIUS;
  };
  const waterAt = (dir) => !!(world && world.isWater && world.isWater(dir));

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
    groundR = radius = groundAt(up);
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
    return out.copy(position).addScaledVector(up, HEAD_TOP + parts.rig.position.y);
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
    api.inWater = waterAt(up);

    // 目標速度
    _target.copy(_desired);
    _target.addScaledVector(up, -_target.dot(up));
    const tl = _target.length();
    let targetSpeed = 0;
    if (tl > 1e-6 && wantMag > 0) {
      targetSpeed = (wantRun ? RUN_SPEED : WALK_SPEED) * wantMag * (api.inWater ? WATER_SPEED : 1);
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
      api.grounded = false;
      coyote = 0;
      jumpBuffer = 0;
      airTime = 0;
      anim.sq = 0.26;
      anim.sqV = 0;
      anim.sproutXV -= 6;
      fire('onJump');
    }

    // 重力
    if (!api.grounded) {
      vRad -= GRAVITY * (vRad < 0 ? FALL_GRAVITY_MULT : 1) * h;
      if (vRad < -MAX_FALL_SPEED) vRad = -MAX_FALL_SPEED;
    }

    // 位移：水平沿切平面、徑向沿法線
    const stepLen = vel.length() * h;
    _tmp.copy(up).multiplyScalar(radius).addScaledVector(vel, h);
    radius += vRad * h;
    _tmp.normalize();
    transport(vel, _tmp);
    up.copy(_tmp);
    fixForward();

    resolveObstacles();

    // 地面
    const g = groundAt(up);
    groundR = g;
    if (radius <= g) {
      const rise = g - radius;
      if (api.grounded && rise > 0.12) anim.visY -= rise - 0.12; // 小台階：視覺平滑跨上
      radius = g;
      if (!api.grounded) land();
      if (vRad < 0) vRad = 0;
      api.grounded = true;
    } else if (api.grounded && vRad <= 0 && radius - g < 0.06 + stepLen * 1.15) {
      const drop = radius - g;
      if (drop > 0.12) anim.visY += drop - 0.12;
      radius = g; // 下坡貼地
      vRad = 0;
    } else {
      api.grounded = false;
    }
    if (!api.grounded) airTime += h;

    position.copy(up).multiplyScalar(radius);
  }

  function land() {
    const impact = -vRad;
    if (airTime > LAND_SOUND_AIRTIME) {
      anim.sq = Math.min(anim.sq, 0);
      anim.sqV = -clamp(impact * 0.32, 1.2, 5.5);
      anim.sproutXV += clamp(impact * 0.5, 1, 7);
      fire('onLand');
    }
    airTime = 0;
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

    a.walk = damp(a.walk, g ? clamp(spd / WALK_SPEED, 0, 1) : 0, 10, dt);
    a.run = damp(a.run, g ? clamp((spd - WALK_SPEED * 0.9) / (RUN_SPEED - WALK_SPEED * 0.9), 0, 1) : 0, 8, dt);
    a.air = damp(a.air, g ? 0 : 1, g ? 14 : 8, dt);
    a.water = damp(a.water, api.inWater ? 1 : 0, 5, dt);

    // 步伐：速度越快頻率越高
    if (g && spd > 0.25) {
      const stride = api.inWater ? 0.8 : 1.05 + 0.4 * a.run;
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
    const legAmp = (0.6 + 0.35 * a.run) * a.walk * (1 - 0.4 * a.water);
    legs[0].rotation.x = s * legAmp - a.air * 0.55;
    legs[1].rotation.x = -s * legAmp + a.air * 0.25;
    legs[0].position.y = 0.29 + Math.max(0, -s) * 0.06 * a.walk;
    legs[1].position.y = 0.29 + Math.max(0, s) * 0.06 * a.walk;

    // 手臂
    const armAmp = (0.55 + 0.45 * a.run) * a.walk * (1 - a.water);
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
  }

  function updateShadow() {
    const { shadow, shadowMat } = parts;
    const g0 = groundAt(up);
    const hgt = Math.max(0, radius - g0);
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

  setDirection(up);
  return api;
}
