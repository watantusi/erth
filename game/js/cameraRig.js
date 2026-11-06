// 鏡頭（分身 3）：開始畫面環繞星球（showcase）與第三人稱跟隨（follow）。
// 合約：createCameraRig({ camera, world, player, input }) → { mode, setMode, update(dt), snap() }
// 球面上不使用世界固定的「上」：鏡頭的上 = 平滑後的玩家地表法線，水平朝向（heading）
// 每幀投影到新的切平面再正規化（平行移動），所以走過南北極也不會翻轉。
import * as THREE from 'three';
import { PLANET_RADIUS, WALK_SPEED } from './config.js';
import { clamp, damp, lerp, smoothstep } from './utils.js';

const DEG = Math.PI / 180;

const FOLLOW = {
  distance: 10,
  minDist: 5,
  maxDist: 18,
  pitch: 22 * DEG,
  minPitch: 8 * DEG,
  maxPitch: 65 * DEG,
  targetHeight: 1.2,
  yawPerPx: 0.0048,     // 每 px 水平旋轉（弧度）
  pitchPerPx: 0.0036,   // 每 px 俯仰
  zoomScale: 0.13,      // 每單位 zoom 的距離倍率（指數）
  upLambda: 5,          // 鏡頭「上」跟隨速度
  targetLambda: 16,     // 注視點跟隨速度
  pitchLambda: 14,
  distLambda: 9,
  groundClear: 0.8,     // 鏡頭離地最小距離
  lineClear: 0.45,      // 視線上的地形餘裕
  recenterDelay: 1.5,   // 多久沒碰視角後開始自動回正（秒）
  recenterRate: 1.1,    // 回正速度（1/秒）
  teleportDist: 6,      // 單幀位移超過此值視為傳送 → 直接 snap
};

const SHOWCASE = {
  orbitSpeed: 0.07,     // 弧度/秒
  tilt: 0.32,           // 仰角（弧度）
  tiltWobble: 0.07,
  frameRadius: 31.5,    // 取景時視為星球半徑
};

const FLY_TIME = 1.2;
const LINE_SAMPLES = [0.3, 0.5, 0.7, 0.85, 1.0];

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const finite3 = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

export function createCameraRig({ camera, world, player, input }) {
  let mode = 'showcase';

  // ---- 共用暫存（不在每幀配置） ----
  const ORIGIN = new THREE.Vector3(0, 0, 0);
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const _m = new THREE.Matrix4();
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _q1 = new THREE.Quaternion();
  const _qI = new THREE.Quaternion();

  // 目前模式的理想鏡頭
  const idealPos = new THREE.Vector3();
  const idealQuat = new THREE.Quaternion();
  const idealUp = new THREE.Vector3(0, 1, 0);

  // ---- showcase 狀態 ----
  let orbitAngle = 0.5;
  let showcaseT = 0;

  // ---- follow 狀態 ----
  const smoothUp = new THREE.Vector3(0, 1, 0);
  const heading = new THREE.Vector3(0, 0, 1);
  const target = new THREE.Vector3();
  const desiredTarget = new THREE.Vector3();
  const lastPlayerPos = new THREE.Vector3();
  let havePlayerPos = false;
  let pitch = FOLLOW.pitch, pitchGoal = FOLLOW.pitch;
  let dist = FOLLOW.distance, distGoal = FOLLOW.distance;
  let lift = 0;
  let idleLook = 99;
  let recenterBlend = 0;

  // ---- 模式切換的平滑過渡 ----
  let blendT = 1;
  const blendFromPos = new THREE.Vector3();
  const blendFromQuat = new THREE.Quaternion();
  const blendFromUp = new THREE.Vector3(0, 1, 0);

  function groundRadius(dir) {
    let r = PLANET_RADIUS;
    try {
      if (world && world.getGroundRadius) r = world.getGroundRadius(dir);
    } catch { /* 忽略 */ }
    return Number.isFinite(r) ? r : PLANET_RADIUS;
  }

  /** 確保 p 在地表上方至少 clear 的距離（就地修改） */
  function enforceGround(p, clear) {
    const r = p.length();
    if (r < 1e-6) { p.set(0, PLANET_RADIUS + clear, 0); return; }
    _v3.copy(p).divideScalar(r);
    const g = groundRadius(_v3) + clear;
    if (r < g) p.copy(_v3).multiplyScalar(g);
  }

  function lookQuat(eye, at, up, outQuat) {
    _m.lookAt(eye, at, up);
    outQuat.setFromRotationMatrix(_m);
  }

  /** 讀取玩家的地表法線到 _up */
  function readPlayerUp() {
    const pu = player && player.up;
    if (pu && finite3(pu) && pu.lengthSq() > 1e-8) _up.copy(pu).normalize();
    else if (player && player.position && player.position.lengthSq() > 1e-8) _up.copy(player.position).normalize();
    else _up.set(0, 1, 0);
    return _up;
  }

  /** heading = 玩家面向投影到 smoothUp 的切平面（失敗時用穩定的切線） */
  function initHeading() {
    const f = player && player.forward;
    if (f && finite3(f)) heading.copy(f); else heading.set(0, 0, 0);
    heading.addScaledVector(smoothUp, -heading.dot(smoothUp));
    if (heading.lengthSq() < 1e-6) {
      // 備援：任何與 up 不平行的參考向量
      _v1.set(1, 0, 0);
      if (Math.abs(smoothUp.x) > 0.9) _v1.set(0, 0, 1);
      heading.crossVectors(smoothUp, _v1);
    }
    heading.normalize();
  }

  function computeDesiredTarget() {
    desiredTarget.copy(player.position).addScaledVector(_up, FOLLOW.targetHeight);
  }

  /** follow 的平滑狀態立即到位 */
  function snapFollow(resetView) {
    readPlayerUp();
    smoothUp.copy(_up);
    initHeading();
    if (resetView) { pitchGoal = FOLLOW.pitch; distGoal = FOLLOW.distance; }
    pitch = pitchGoal;
    dist = distGoal;
    computeDesiredTarget();
    target.copy(desiredTarget);
    lastPlayerPos.copy(player.position);
    havePlayerPos = true;
    lift = -1; // 下一次計算時直接採用目標值
    idleLook = 99;
    recenterBlend = 0;
  }

  // ---- showcase ----
  function showcaseDistance() {
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    const tanV = Math.tan(((camera.fov || 55) * DEG) / 2);
    const tanMin = Math.min(tanV, tanV * aspect);
    const k = aspect < 1 ? 0.86 : 0.72; // 星球佔較短邊的比例
    const ang = Math.atan(k * tanMin);
    return clamp(SHOWCASE.frameRadius / Math.sin(ang), 60, 170);
  }

  function computeShowcase(dt) {
    showcaseT += dt;
    orbitAngle += dt * SHOWCASE.orbitSpeed;
    const D = showcaseDistance();
    const tilt = SHOWCASE.tilt + Math.sin(showcaseT * 0.11) * SHOWCASE.tiltWobble;
    const c = Math.cos(tilt);
    idealPos.set(Math.sin(orbitAngle) * c, Math.sin(tilt), Math.cos(orbitAngle) * c).multiplyScalar(D);
    idealUp.copy(WORLD_UP);
    lookQuat(idealPos, ORIGIN, idealUp, idealQuat);
  }

  // ---- follow ----
  function computeFollow(dt) {
    if (!player || !player.position || !finite3(player.position)) return false;
    readPlayerUp();

    // 傳送（setDirection、讀檔）→ 直接到位
    if (havePlayerPos && player.position.distanceToSquared(lastPlayerPos) > FOLLOW.teleportDist * FOLLOW.teleportDist) {
      snapFollow(false);
    }
    lastPlayerPos.copy(player.position);
    havePlayerPos = true;

    // 平滑的「上」
    if (smoothUp.dot(_up) < -0.2) smoothUp.copy(_up);
    else {
      smoothUp.lerp(_up, 1 - Math.exp(-FOLLOW.upLambda * dt));
      if (smoothUp.lengthSq() < 1e-8) smoothUp.copy(_up);
      smoothUp.normalize();
    }

    // 平行移動 heading：投影到新的切平面再正規化
    heading.addScaledVector(smoothUp, -heading.dot(smoothUp));
    if (heading.lengthSq() < 1e-6 || !finite3(heading)) initHeading();
    else heading.normalize();

    // 視角輸入
    const st = input && input.state;
    const lx = st ? st.lookX || 0 : 0;
    const ly = st ? st.lookY || 0 : 0;
    const zm = st ? st.zoom || 0 : 0;
    if (lx !== 0 || ly !== 0) idleLook = 0; else idleLook += dt;
    if (lx !== 0) heading.applyAxisAngle(smoothUp, -lx * FOLLOW.yawPerPx).normalize(); // 往右拖 → 往右看
    if (ly !== 0) pitchGoal = clamp(pitchGoal + ly * FOLLOW.pitchPerPx, FOLLOW.minPitch, FOLLOW.maxPitch);
    if (zm !== 0) distGoal = clamp(distGoal * Math.exp(zm * FOLLOW.zoomScale), FOLLOW.minDist, FOLLOW.maxDist);

    // 自動回正：一段時間沒動視角且玩家在移動 → 慢慢轉到玩家背後
    const speed = Number.isFinite(player.speed) ? player.speed : 0;
    const wantRecenter = idleLook > FOLLOW.recenterDelay && speed > 0.6;
    recenterBlend = damp(recenterBlend, wantRecenter ? 1 : 0, 2.5, dt);
    if (recenterBlend > 0.01 && player.forward && finite3(player.forward)) {
      _v1.copy(player.forward).addScaledVector(smoothUp, -player.forward.dot(smoothUp));
      if (_v1.lengthSq() > 1e-6) {
        _v1.normalize();
        const cosA = heading.dot(_v1);
        const sinA = _v2.crossVectors(heading, _v1).dot(smoothUp);
        const a = Math.atan2(sinA, cosA);
        // 角度越大越不追（朝鏡頭走時 >150° 完全忽略）
        const w = 1 - smoothstep(100 * DEG, 150 * DEG, Math.abs(a));
        const sf = clamp(speed / WALK_SPEED, 0, 1.3);
        const step = a * (1 - Math.exp(-FOLLOW.recenterRate * dt)) * w * sf * recenterBlend;
        if (step !== 0) heading.applyAxisAngle(smoothUp, step).normalize();
        pitchGoal = damp(pitchGoal, FOLLOW.pitch, 0.35 * recenterBlend * w, dt);
      }
    }

    pitch = damp(pitch, pitchGoal, FOLLOW.pitchLambda, dt);
    dist = damp(dist, distGoal, FOLLOW.distLambda, dt);

    // 注視點
    computeDesiredTarget();
    target.lerp(desiredTarget, 1 - Math.exp(-FOLLOW.targetLambda * dt));
    // 高速時不要落後太多
    const lagSq = target.distanceToSquared(desiredTarget);
    if (lagSq > 2.25) target.sub(desiredTarget).multiplyScalar(1.5 / Math.sqrt(lagSq)).add(desiredTarget);

    // 理想位置：目標後上方
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    idealPos.copy(target)
      .addScaledVector(heading, -cp * dist)
      .addScaledVector(smoothUp, sp * dist);

    // 視線被地形擋住 → 把鏡頭往上抬（快上慢下）
    let need = 0;
    for (let i = 0; i < LINE_SAMPLES.length; i++) {
      const f = LINE_SAMPLES[i];
      _v1.lerpVectors(target, idealPos, f);
      const r = _v1.length();
      if (r < 1e-6) continue;
      _v1.divideScalar(r);
      const clear = f >= 1 ? FOLLOW.groundClear : FOLLOW.lineClear;
      const deficit = groundRadius(_v1) + clear - r;
      if (deficit > 0) need = Math.max(need, deficit / f);
    }
    need = Math.min(need, 9);
    if (lift < 0) lift = need;
    else lift = need > lift ? damp(lift, need, 22, dt) : damp(lift, need, 2.5, dt);
    if (lift > 1e-4) idealPos.addScaledVector(smoothUp, lift);
    enforceGround(idealPos, FOLLOW.groundClear);

    idealUp.copy(smoothUp);
    lookQuat(idealPos, target, idealUp, idealQuat);
    return true;
  }

  function computeIdeal(dt) {
    if (mode === 'follow') {
      if (!computeFollow(dt)) computeShowcase(dt);
    } else {
      computeShowcase(dt);
    }
  }

  function apply() {
    if (blendT < 1) {
      const t = blendT;
      const eDir = easeInOut(Math.min(1, t * 1.15));
      const eRad = easeInOut(t);
      // 位置：繞著星球做球面插值（不會穿過星球）
      const r0 = blendFromPos.length();
      const r1 = idealPos.length();
      _v1.copy(blendFromPos).divideScalar(r0 || 1);
      _v2.copy(idealPos).divideScalar(r1 || 1);
      _q1.setFromUnitVectors(_v1, _v2);
      _qI.identity().slerp(_q1, eDir);
      _v1.applyQuaternion(_qI).multiplyScalar(lerp(r0, r1, eRad));
      enforceGround(_v1, FOLLOW.groundClear);
      camera.position.copy(_v1);
      camera.quaternion.slerpQuaternions(blendFromQuat, idealQuat, eRad);
      // camera.up 只是記錄（方向已由四元數決定）
      _q1.setFromUnitVectors(blendFromUp, idealUp);
      _qI.identity().slerp(_q1, eRad);
      camera.up.copy(blendFromUp).applyQuaternion(_qI).normalize();
    } else {
      camera.position.copy(idealPos);
      camera.quaternion.copy(idealQuat);
      camera.up.copy(idealUp);
    }
    camera.updateMatrixWorld();
  }

  function update(dt) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    computeIdeal(dt);
    if (blendT < 1) blendT = Math.min(1, blendT + dt / FLY_TIME);
    apply();
  }

  function setMode(m) {
    if (m !== 'showcase' && m !== 'follow') return;
    if (m === mode) return;
    // 從目前鏡頭姿態平滑過渡
    blendFromPos.copy(camera.position);
    if (blendFromPos.lengthSq() < 1e-6 || !finite3(blendFromPos)) blendFromPos.set(0, 20, 90);
    blendFromQuat.copy(camera.quaternion);
    blendFromUp.copy(camera.up).normalize();
    if (!finite3(blendFromUp) || blendFromUp.lengthSq() < 0.5) blendFromUp.set(0, 1, 0);
    blendT = 0;
    mode = m;
    if (m === 'follow') {
      snapFollow(true);
    } else {
      orbitAngle = Math.atan2(camera.position.x, camera.position.z);
      showcaseT = 0;
    }
  }

  function snap() {
    blendT = 1;
    if (mode === 'follow') snapFollow(false);
    computeIdeal(0);
    apply();
  }

  return {
    get mode() { return mode; },
    setMode,
    update,
    snap,
    /** 是否正在模式切換的飛行過渡中 */
    get transitioning() { return blendT < 1; },
  };
}
