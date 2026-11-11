// 星際除草王 — 主控：遊戲迴圈、球面移動、草地、碰撞、相機、粒子
import * as THREE from 'three';
import { LEVELS, makePlanetMesh, makeLavaPool, createEnvironment } from './world.js';
import { makeMower, makeBug, makeRock, makeCactus, makeCrystal, makePickup } from './models.js';
import { Sound } from './audio.js';
import { createUI } from './ui.js';

// ---------- 常數 ----------
const MAX_SPEED = 7.5;
const BOOST_MULT = 1.65;
const TURN_RATE = 2.7;
const PLAYER_RAD = 0.75;
const MOW_R = 1.25;
const WIDE_R = 2.3;
const CAM_H = 4.4;
const CAM_D = 6.8;
const MAX_LIVES = 3;
const BUG_RAD = 0.6;
const BUG_SEED_R = 0.95;

// ---------- 小工具 ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomUnit(rng, out) {
  const u = rng() * 2 - 1, th = rng() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(th), u, s * Math.sin(th));
}
const V = () => new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _a = V(), _b = V(), _c = V(), _d = V(), _m = new THREE.Matrix4();

// 把物件擺在球面方向 dir 上（+Y 對齊法線），yaw 繞法線旋轉
function placeOnSphere(obj, dir, R, yaw = 0, lift = 0) {
  obj.position.copy(dir).multiplyScalar(R + lift);
  _q.setFromUnitVectors(Y_AXIS, dir);
  _q2.setFromAxisAngle(Y_AXIS, yaw);
  obj.quaternion.copy(_q).multiply(_q2);
}
// 以 basis(left, up, fwd) 擺放
function orient(obj, up, fwd, R, lift = 0) {
  _a.crossVectors(up, fwd).normalize(); // left
  _m.makeBasis(_a, up, fwd);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(up).multiplyScalar(R + lift);
}

// ---------- 存檔 ----------
const SAVE_KEY = 'planet-mower-save-v1';
let save = { unlocked: 1, stars: [] };
try {
  const s = JSON.parse(localStorage.getItem(SAVE_KEY));
  if (s && s.unlocked) save = { unlocked: Math.min(LEVELS.length, s.unlocked | 0) || 1, stars: Array.isArray(s.stars) ? s.stars : [] };
} catch (e) { /* 無痕模式等 */ }
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { } }

// ---------- 渲染器 ----------
const container = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const isCoarse = matchMedia('(pointer: coarse)').matches;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isCoarse ? 1.75 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 1200);
const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
scene.add(sun, sun.target);
const env = createEnvironment(scene);

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.fov = camera.aspect < 0.8 ? 72 : 62; // 直向手機看廣一點
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
onResize();

// ---------- 草地材質（實例化 + 風吹 + 高度屬性） ----------
const grassUniforms = { uTime: { value: 0 } };
function makeClumpGeometry() {
  const pos = [], col = [], nrm = [];
  const r = mulberry32(7);
  for (let b = 0; b < 7; b++) {
    const a = r() * Math.PI * 2, d = r() * 0.2;
    const bx = Math.cos(a) * d, bz = Math.sin(a) * d;
    const h = 0.34 + r() * 0.26, w = 0.05 + r() * 0.035, yaw = r() * Math.PI;
    const cx = Math.cos(yaw) * w, cz = Math.sin(yaw) * w;
    const lx = (r() - 0.5) * 0.16, lz = (r() - 0.5) * 0.16;
    pos.push(bx - cx, 0, bz - cz, bx + cx, 0, bz + cz, bx + lx, h, bz + lz);
    col.push(0.38, 0.38, 0.38, 0.38, 0.38, 0.38, 1, 1, 1);
    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}
const CLUMP_GEO = makeClumpGeometry();
function makeGrassMaterial(emissive) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  if (emissive) m.emissive = new THREE.Color(emissive);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = grassUniforms.uTime;
    sh.vertexShader = 'attribute float aH;\nuniform float uTime;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float hh = aH;
        transformed.y *= hh;
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3].x * 0.9 + instanceMatrix[3].y * 0.7 + instanceMatrix[3].z * 0.8;
        #else
          float ph = 0.0;
        #endif
        float sw = sin(uTime * 2.2 + ph) * 0.08 * position.y * hh;
        transformed.x += sw; transformed.z += sw * 0.6;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vColor.rgb *= mix(0.5, 1.0, smoothstep(0.12, 1.0, aH));`);
  };
  return m;
}

// ---------- 全域物件：玩家、粒子、箭頭、割草圈 ----------
const mower = makeMower();
scene.add(mower.group);

const mowRing = new THREE.Mesh(
  new THREE.RingGeometry(0.92, 1.0, 48),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide })
);
mowRing.rotation.x = -Math.PI / 2;
mowRing.position.set(0, 0.07, 0.45);
mower.group.add(mowRing);

const arrow = new THREE.Group();
{
  const mat = new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.92, depthTest: false });
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.7, 12), mat);
  head.rotation.x = Math.PI / 2; head.position.z = 0.55;
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.7, 8), mat);
  tail.rotation.x = Math.PI / 2;
  head.renderOrder = tail.renderOrder = 10;
  arrow.add(head, tail);
}
arrow.visible = false;
scene.add(arrow);

// 草屑粒子
const PCOUNT = 500;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PCOUNT * 3), pCol = new Float32Array(PCOUNT * 3);
const pVel = new Float32Array(PCOUNT * 3), pLife = new Float32Array(PCOUNT);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.14, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
particles.frustumCulled = false;
scene.add(particles);
let pNext = 0;
function emit(x, y, z, nx, ny, nz, color, speed = 3) {
  const i = pNext; pNext = (pNext + 1) % PCOUNT;
  pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
  const up = speed * (0.6 + Math.random() * 0.7);
  pVel[i * 3] = nx * up + (Math.random() - 0.5) * speed;
  pVel[i * 3 + 1] = ny * up + (Math.random() - 0.5) * speed;
  pVel[i * 3 + 2] = nz * up + (Math.random() - 0.5) * speed;
  pCol[i * 3] = color.r; pCol[i * 3 + 1] = color.g; pCol[i * 3 + 2] = color.b;
  pLife[i] = 0.6 + Math.random() * 0.4;
}
function updateParticles(dt) {
  for (let i = 0; i < PCOUNT; i++) {
    if (pLife[i] <= 0) continue;
    pLife[i] -= dt;
    const k = i * 3;
    if (pLife[i] <= 0) { pPos[k] = pPos[k + 1] = pPos[k + 2] = 0; continue; } // 藏到星球中心
    const x = pPos[k], y = pPos[k + 1], z = pPos[k + 2];
    const inv = 1 / (Math.hypot(x, y, z) || 1);
    pVel[k] -= x * inv * 11 * dt; pVel[k + 1] -= y * inv * 11 * dt; pVel[k + 2] -= z * inv * 11 * dt;
    pPos[k] += pVel[k] * dt; pPos[k + 1] += pVel[k + 1] * dt; pPos[k + 2] += pVel[k + 2] * dt;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
}
function clearParticles() { pLife.fill(0); pPos.fill(0); }

// ---------- 玩家狀態 ----------
const P = {
  up: V(), fwd: V(), vel: V(),
  stun: 0, invuln: 0, boost: 100, wideT: 0, boosting: false, speed: 0,
};

// ---------- 關卡 ----------
let L = null;        // 目前關卡執行資料
let levelIdx = 0;
let mode = 'menu';   // menu | brief | countdown | play | paused | ending | result
let T = 0;

function disposeLevel() {
  if (!L) return;
  scene.remove(L.group);
  L.group.traverse((o) => {
    if (o.geometry && o.geometry !== CLUMP_GEO) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose && m.dispose());
  });
  L = null;
}

function buildLevel(idx) {
  disposeLevel();
  levelIdx = idx;
  const def = LEVELS[idx];
  const R = def.radius;
  const rng = mulberry32(1000 + idx * 7919);
  const group = new THREE.Group();
  scene.add(group);
  env.setLevel(def);
  const C = def.colors;
  hemi.color.set(C.hemiSky); hemi.groundColor.set(C.hemiGround);
  sun.color.set(C.sun);

  group.add(makePlanetMesh(def));

  const spawnUp = new THREE.Vector3(0, 1, 0);
  const obstacles = [];   // {type, dir, angR, cosLim, obj}
  const lavas = [];       // {dir, angR, cosHit, pool}

  const tryDir = (angR, minFromSpawn = 0.45) => {
    for (let t = 0; t < 80; t++) {
      const dir = randomUnit(rng, V());
      if (dir.angleTo(spawnUp) < minFromSpawn + angR) continue;
      let ok = true;
      for (const o of obstacles) if (dir.angleTo(o.dir) < o.angR + angR + 2.0 / R) { ok = false; break; }
      if (ok) for (const l of lavas) if (dir.angleTo(l.dir) < l.angR + angR + 2.0 / R) { ok = false; break; }
      if (ok) return dir;
    }
    return null;
  };
  const addObstacle = (type, size, obj) => {
    const angR = size / R;
    const dir = tryDir(angR);
    if (!dir) return;
    placeOnSphere(obj, dir, R, rng() * Math.PI * 2);
    group.add(obj);
    const lim = angR + PLAYER_RAD / R;
    obstacles.push({ type, dir, angR, lim, cosLim: Math.cos(lim), obj });
  };

  for (let i = 0; i < (def.lava || 0); i++) {
    const r = 1.2 + rng() * 1.0;
    const angR = r / R;
    const dir = tryDir(angR, 0.6);
    if (!dir) continue;
    const pool = makeLavaPool(def, R, angR);
    _q.setFromUnitVectors(Y_AXIS, dir);
    pool.mesh.quaternion.copy(_q);
    group.add(pool.mesh);
    lavas.push({ dir, angR, cosHit: Math.cos(Math.max(0.01, angR - 0.25 / R)), pool });
  }
  for (let i = 0; i < (def.rocks || 0); i++) { const s = 0.6 + rng() * 0.7; addObstacle('rock', s, makeRock(rng, s, C.rock)); }
  for (let i = 0; i < (def.cacti || 0); i++) { addObstacle('cactus', 0.45, makeCactus(rng, 1.5 + rng() * 0.8)); }
  for (let i = 0; i < (def.crystals || 0); i++) { const s = 0.5 + rng() * 0.45; addObstacle('crystal', s, makeCrystal(rng, s, C.crystal)); }

  // ----- 草 -----
  const area = 4 * Math.PI * R * R;
  const target = Math.round(area * (def.density || 5.5));
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const tmpN = V();
  for (let i = 0; i < target; i++) {
    const y = 1 - (2 * (i + 0.5)) / target;
    const rr = Math.sqrt(1 - y * y);
    const th = i * golden + (rng() - 0.5) * 0.002 * target / (rr * 40 + 1);
    tmpN.set(Math.cos(th) * rr, y, Math.sin(th) * rr);
    tmpN.x += (rng() - 0.5) * 0.25 / R; tmpN.z += (rng() - 0.5) * 0.25 / R; tmpN.normalize();
    let blocked = false;
    for (const o of obstacles) if (tmpN.dot(o.dir) > Math.cos(o.angR * 0.95)) { blocked = true; break; }
    if (!blocked) for (const l of lavas) if (tmpN.dot(l.dir) > Math.cos(l.angR + 0.1 / R)) { blocked = true; break; }
    if (!blocked) pts.push(tmpN.x, tmpN.y, tmpN.z);
  }
  const N = pts.length / 3;
  const geo = CLUMP_GEO.clone();
  const aH = new THREE.InstancedBufferAttribute(new Float32Array(N).fill(1), 1);
  aH.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aH', aH);
  const mesh = new THREE.InstancedMesh(geo, makeGrassMaterial(def.emissiveGrass ? new THREE.Color(C.grass[1]).multiplyScalar(def.emissiveGrass) : null), N);
  const g0 = new THREE.Color(C.grass[0]), g1 = new THREE.Color(C.grass[1]), gc = new THREE.Color();
  const pos = new Float32Array(N * 3);
  const dummy = new THREE.Object3D();
  const weed = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const n = tmpN.set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    pos[i * 3] = n.x * R; pos[i * 3 + 1] = n.y * R; pos[i * 3 + 2] = n.z * R;
    placeOnSphere(dummy, n, R, rng() * Math.PI * 2);
    const s = 1.0 + rng() * 0.45;
    dummy.scale.set(s, s * (0.8 + rng() * 0.45), s);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    gc.copy(g0).lerp(g1, rng());
    if (def.regrow && rng() < def.regrow) { weed[i] = 1; gc.lerp(new THREE.Color(0xff66cc), 0.35); }
    mesh.setColorAt(i, gc);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  group.add(mesh);

  // ----- 播種蟲 -----
  const bugs = [];
  for (let i = 0; i < (def.bugs || 0); i++) {
    const b = makeBug(C.bug);
    const up = V().set(rng() - 0.5, -1, rng() - 0.5).normalize(); // 從背面出發
    up.applyAxisAngle(Y_AXIS, i * 2.1);
    const fwd = V().set(1, 0, 0); fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    group.add(b.group);
    bugs.push({ ...b, up, fwd, wander: 0, turn: 0, chase: false });
  }

  // ----- 道具 -----
  const pickups = [];
  const types = ['wide', 'time', 'boost', 'wide'];
  for (const type of types) {
    const p = makePickup(type);
    group.add(p.group);
    const pk = { ...p, type, dir: V(), active: true, respawn: 0 };
    placePickup(pk, rng, obstacles, lavas, R, spawnUp);
    pickups.push(pk);
  }

  L = {
    def, idx, R, group, rng, obstacles, lavas, bugs, pickups,
    grass: { mesh, aH, pos, N, cut: new Uint8Array(N), timer: new Float32Array(N), weed },
    mowed: 0, time: def.time, lives: MAX_LIVES, grassColor: g1.clone(),
    radarDir: null, radarT: 0, cutRate: 0, lastTick: 999, ended: false,
  };
  resetPlayer();
  clearParticles();
}

function placePickup(pk, rng, obstacles, lavas, R, avoid) {
  for (let t = 0; t < 60; t++) {
    randomUnit(rng, pk.dir);
    if (avoid && pk.dir.angleTo(avoid) < 0.5) continue;
    let ok = true;
    for (const o of obstacles) if (pk.dir.angleTo(o.dir) < o.lim + 0.15) { ok = false; break; }
    if (ok) for (const l of lavas) if (pk.dir.angleTo(l.dir) < l.angR + 0.15) { ok = false; break; }
    if (ok) break;
  }
  pk.group.position.copy(pk.dir).multiplyScalar(R + 0.9);
  _q.setFromUnitVectors(Y_AXIS, pk.dir);
  pk.group.quaternion.copy(_q);
  pk.group.visible = true; pk.active = true;
}

function resetPlayer() {
  P.up.set(0, 1, 0); P.fwd.set(0, 0, 1); P.vel.set(0, 0, 0);
  P.stun = 0; P.invuln = 0; P.boost = 100; P.wideT = 0; P.speed = 0;
  orient(mower.group, P.up, P.fwd, L.R);
  mower.group.visible = true;
  snapCamera();
}

// ---------- 相機 ----------
const camPos = V(), camUp = V(0, 1, 0), camLook = V();
let shake = 0, menuAngle = 0;
function playCamTarget(out) {
  return out.copy(P.up).multiplyScalar(L.R + CAM_H).addScaledVector(P.fwd, -CAM_D);
}
function snapCamera() {
  playCamTarget(camPos); camUp.copy(P.up);
  camLook.copy(P.up).multiplyScalar(L.R + 0.5).addScaledVector(P.fwd, 3);
}
function updatePlayCamera(dt) {
  const k = 1 - Math.exp(-5 * dt);
  camPos.lerp(playCamTarget(_b), k);
  camUp.lerp(P.up, k).normalize();
  _c.copy(P.up).multiplyScalar(L.R + 0.5).addScaledVector(P.fwd, 3);
  camLook.lerp(_c, 1 - Math.exp(-8 * dt));
  applyCamera(dt);
}
function updateOrbitCamera(dt, speed = 0.12) {
  menuAngle += dt * speed;
  const D = L.R * 2.9;
  _b.set(Math.cos(menuAngle) * D, D * 0.42, Math.sin(menuAngle) * D);
  const k = 1 - Math.exp(-1.8 * dt);
  camPos.lerp(_b, k);
  camUp.lerp(Y_AXIS, k).normalize();
  camLook.lerp(_c.set(0, 0, 0), k);
  applyCamera(dt);
}
function applyCamera(dt) {
  camera.position.copy(camPos);
  if (shake > 0) {
    shake = Math.max(0, shake - dt);
    const s = shake * 0.6;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    camera.position.z += (Math.random() - 0.5) * s;
  }
  camera.up.copy(camUp);
  camera.lookAt(camLook);
  // 光源跟著玩家視角：從上方偏左後方照過來
  _d.crossVectors(camUp, _a.subVectors(camLook, camPos).normalize()).normalize(); // left
  sun.position.copy(camLook).addScaledVector(camUp, 12).addScaledVector(_d, 5).addScaledVector(_a, -4);
  sun.target.position.copy(camLook);
  hemi.position.copy(camUp);
}

// ---------- 輸入 ----------
const keys = new Set();
window.addEventListener('keydown', (e) => {
  const c = e.code;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(c)) e.preventDefault();
  if (e.repeat) { keys.add(c); return; }
  keys.add(c);
  if (c === 'KeyP' || c === 'Escape') { if (mode === 'play') pauseGame(); else if (mode === 'paused') resumeGame(); }
  if (c === 'KeyM') toggleMute();
  if ((c === 'Enter' || c === 'Space') && mode === 'brief') startCountdown();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); if (mode === 'play') pauseGame(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'play') pauseGame(); });

function readInput() {
  let thr = 0, steer = 0, boost = false;
  if (keys.has('KeyW') || keys.has('ArrowUp')) thr += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) thr -= 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) steer += 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) steer -= 1;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('Space')) boost = true;
  const ti = ui.input;
  if (ti) {
    if (Math.abs(ti.throttle) > Math.abs(thr)) thr = ti.throttle;
    if (Math.abs(ti.steer) > Math.abs(steer)) steer = ti.steer;
    boost = boost || !!ti.boost;
  }
  return { thr: Math.max(-1, Math.min(1, thr)), steer: Math.max(-1, Math.min(1, steer)), boost };
}

// ---------- 遊戲更新 ----------
function hurt(fromDir, msg) {
  if (P.invuln > 0 || !L || L.ended) return;
  L.lives--;
  P.invuln = 2.2; P.stun = 0.7; shake = 0.5;
  _a.copy(P.up).sub(fromDir); _a.addScaledVector(P.up, -_a.dot(P.up));
  if (_a.lengthSq() < 1e-6) _a.copy(P.fwd).negate();
  P.vel.copy(_a.normalize()).multiplyScalar(9);
  Sound.play('hit');
  ui.flash('rgba(255,60,60,0.45)');
  if (msg) ui.toast(msg);
  for (let i = 0; i < 14; i++) {
    const x = P.up.x * L.R, y = P.up.y * L.R, z = P.up.z * L.R;
    emit(x, y, z, P.up.x, P.up.y, P.up.z, { r: 1, g: 0.45, b: 0.2 }, 4);
  }
  if (L.lives <= 0) endLevel(false, '沒有生命了…');
}

function pushOut(o) {
  if (P.up.dot(o.dir) < o.cosLim) return false;
  _a.crossVectors(o.dir, P.up);
  if (_a.lengthSq() < 1e-10) _a.set(1, 0, 0).cross(o.dir);
  _a.normalize();
  _b.copy(o.dir).applyAxisAngle(_a, o.lim);
  _q.setFromUnitVectors(P.up, _b);
  P.up.copy(_b); P.fwd.applyQuaternion(_q); P.vel.applyQuaternion(_q);
  _c.copy(P.up).sub(o.dir); _c.addScaledVector(P.up, -_c.dot(P.up)).normalize();
  const vn = P.vel.dot(_c);
  if (vn < 0) P.vel.addScaledVector(_c, -vn * 1.5);
  return vn < -1.5 ? -vn : 0.001;
}

function updatePlayer(dt) {
  const R = L.R;
  let { thr, steer, boost } = readInput();
  if (P.stun > 0) { P.stun -= dt; thr = 0; steer = 0; boost = false; }
  if (P.invuln > 0) P.invuln -= dt;
  if (P.wideT > 0) P.wideT -= dt;
  const boosting = boost && thr > 0 && P.boost > 1;
  if (boosting && !P.boosting) Sound.play('boost');
  P.boosting = boosting;
  P.boost = boosting ? Math.max(0, P.boost - 38 * dt) : Math.min(100, P.boost + 13 * dt);

  const along = P.vel.dot(P.fwd);
  if (steer) P.fwd.applyAxisAngle(P.up, steer * TURN_RATE * dt * (along < -0.5 ? -1 : 1));
  const maxS = MAX_SPEED * (boosting ? BOOST_MULT : 1);
  _a.copy(P.fwd).multiplyScalar(thr > 0 ? thr * maxS : thr * MAX_SPEED * 0.55);
  const traction = L.def.traction || 9;
  P.vel.lerp(_a, 1 - Math.exp(-traction * (thr === 0 ? 0.8 : 1) * dt));

  const sp = P.vel.length();
  if (sp > 1e-4) {
    _a.crossVectors(P.up, P.vel).normalize();
    _q.setFromAxisAngle(_a, (sp * dt) / R);
    P.up.applyQuaternion(_q).normalize();
    P.fwd.applyQuaternion(_q);
    P.vel.applyQuaternion(_q);
  }
  P.fwd.addScaledVector(P.up, -P.fwd.dot(P.up)).normalize();
  P.vel.addScaledVector(P.up, -P.vel.dot(P.up));

  for (const o of L.obstacles) {
    const hit = pushOut(o);
    if (hit) {
      if (o.type === 'cactus' && P.invuln <= 0 && P.stun <= 0) {
        P.stun = 1.0; shake = 0.3; Sound.play('bump'); ui.toast('🌵 好刺！暈頭轉向…');
        P.vel.multiplyScalar(0.3);
      } else if (hit > 1.5) { Sound.play('bump'); shake = Math.min(0.25, hit * 0.04); }
    }
  }
  for (const l of L.lavas) if (P.up.dot(l.dir) > l.cosHit) hurt(l.dir, '🔥 好燙！離熔岩遠一點');

  P.speed = P.vel.dot(P.fwd);
  orient(mower.group, P.up, P.fwd, R);
  mower.update(dt, P.speed, { stunned: P.stun > 0, boosting, blink: P.invuln > 0 && Math.floor(T * 12) % 2 === 0 });
  const mr = P.wideT > 0 ? WIDE_R : MOW_R;
  mowRing.scale.setScalar(mr);
  mowRing.material.color.set(P.wideT > 0 ? 0xffa53d : 0xffffff);
  Sound.setEngine(Math.min(1.6, Math.abs(P.speed) / MAX_SPEED), true);
}

function updateGrass(dt) {
  const G = L.grass, R = L.R, N = G.N, pos = G.pos, aH = G.aH.array, cut = G.cut;
  const mr = P.wideT > 0 ? WIDE_R : MOW_R;
  const r2 = mr * mr;
  const cx = P.up.x * R + P.fwd.x * 0.45, cy = P.up.y * R + P.fwd.y * 0.45, cz = P.up.z * R + P.fwd.z * 0.45;
  const bugs = L.bugs, nb = bugs.length;
  const bp = [];
  for (let j = 0; j < nb; j++) bp.push(bugs[j].up.x * R, bugs[j].up.y * R, bugs[j].up.z * R);
  const s2 = BUG_SEED_R * BUG_SEED_R;
  const regrow = !!L.def.regrow;
  let changed = false, cuts = 0;
  const gc = L.grassColor;
  for (let i = 0; i < N; i++) {
    const k = i * 3;
    const x = pos[k], y = pos[k + 1], z = pos[k + 2];
    if (!cut[i]) {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      if (dx * dx + dy * dy + dz * dz < r2) {
        cut[i] = 1; aH[i] = 0.12; L.mowed++; cuts++; changed = true;
        if (regrow && G.weed[i]) G.timer[i] = 18 + Math.random() * 16;
        if (cuts <= 3 || Math.random() < 0.15) emit(x, y, z, x / R, y / R, z / R, gc, 3.2);
      } else if (aH[i] < 1) { aH[i] = Math.min(1, aH[i] + dt * 0.7); changed = true; }
    } else {
      if (regrow && G.weed[i]) {
        G.timer[i] -= dt;
        if (G.timer[i] <= 0) { cut[i] = 0; L.mowed--; changed = true; continue; }
      }
      for (let j = 0; j < nb; j++) {
        const dx = x - bp[j * 3], dy = y - bp[j * 3 + 1], dz = z - bp[j * 3 + 2];
        if (dx * dx + dy * dy + dz * dz < s2) { cut[i] = 0; L.mowed--; changed = true; break; }
      }
    }
  }
  if (changed) G.aH.needsUpdate = true;
  L.cutRate += (cuts / Math.max(dt, 1e-3) - L.cutRate) * Math.min(1, dt * 6);
  Sound.setMow(Math.min(1, L.cutRate / 60));

  // 雷達：找最近的未割草
  L.radarT -= dt;
  if (L.radarT <= 0) {
    L.radarT = 0.3;
    let best = -2, bi = -1;
    for (let i = 0; i < N; i++) {
      if (cut[i]) continue;
      const d = pos[i * 3] * P.up.x + pos[i * 3 + 1] * P.up.y + pos[i * 3 + 2] * P.up.z;
      if (d > best) { best = d; bi = i; }
    }
    L.radarDir = (bi >= 0 && best / R < Math.cos(5 / R)) ? V().set(pos[bi * 3], pos[bi * 3 + 1], pos[bi * 3 + 2]).normalize() : null;
  }
}

function updateBugs(dt, t) {
  const R = L.R;
  for (const b of L.bugs) {
    const dist = Math.acos(Math.max(-1, Math.min(1, b.up.dot(P.up)))) * R;
    b.chase = dist < 7;
    let turn;
    if (b.chase) {
      _a.copy(P.up).addScaledVector(b.up, -P.up.dot(b.up)).normalize();
      const ang = Math.atan2(_b.crossVectors(b.fwd, _a).dot(b.up), b.fwd.dot(_a));
      turn = Math.max(-1.6, Math.min(1.6, ang * 3));
    } else {
      b.wander -= dt;
      if (b.wander <= 0) { b.wander = 1 + Math.random() * 2; b.turn = (Math.random() - 0.5) * 2.2; }
      turn = b.turn;
    }
    b.fwd.applyAxisAngle(b.up, turn * dt);
    const sp = b.chase ? 4.3 : 3.0;
    _a.crossVectors(b.up, b.fwd).normalize();
    _q.setFromAxisAngle(_a, (sp * dt) / R);
    b.up.applyQuaternion(_q).normalize(); b.fwd.applyQuaternion(_q);
    b.fwd.addScaledVector(b.up, -b.fwd.dot(b.up)).normalize();
    orient(b.group, b.up, b.fwd, R);
    if (b.up.dot(P.up) > Math.cos((PLAYER_RAD + BUG_RAD) / R)) hurt(b.up, '🐛 被播種蟲咬了！');
  }
}

function updatePickups(dt, t, active) {
  const R = L.R;
  for (const p of L.pickups) {
    if (p.active) {
      p.update(dt, t);
      if (active && P.up.dot(p.dir) > Math.cos(1.2 / R)) {
        p.active = false; p.group.visible = false; p.respawn = 14;
        Sound.play('pickup');
        if (p.type === 'wide') { P.wideT = 10; ui.toast('🔶 超寬刀片 10 秒！'); }
        else if (p.type === 'time') { L.time += 12; ui.toast('⏱️ 時間 +12 秒'); }
        else { P.boost = 100; ui.toast('⚡ 加速能量全滿！'); }
        const x = p.dir.x * (R + 0.9), y = p.dir.y * (R + 0.9), z = p.dir.z * (R + 0.9);
        const col = p.type === 'wide' ? { r: 1, g: 0.6, b: 0.2 } : p.type === 'time' ? { r: 0.3, g: 0.95, b: 1 } : { r: 1, g: 0.9, b: 0.2 };
        for (let i = 0; i < 20; i++) emit(x, y, z, p.dir.x, p.dir.y, p.dir.z, col, 3.5);
      }
    } else if (active) {
      p.respawn -= dt;
      if (p.respawn <= 0) placePickup(p, Math.random, L.obstacles, L.lavas, R, P.up);
    }
  }
}

function updateArrow() {
  const show = L.radarDir && L.mowed / L.grass.N > 0.55;
  arrow.visible = !!show;
  if (!show) return;
  const R = L.R;
  _a.copy(L.radarDir).addScaledVector(P.up, -L.radarDir.dot(P.up)).normalize(); // 切線方向
  arrow.position.copy(P.up).multiplyScalar(R + 2.7 + Math.sin(T * 4) * 0.12);
  _b.crossVectors(P.up, _a).normalize();
  _m.makeBasis(_b, P.up, _a);
  arrow.quaternion.setFromRotationMatrix(_m);
}

function updateHUD() {
  const powers = [];
  if (P.wideT > 0) powers.push({ label: '🔶 超寬刀片', t: P.wideT });
  ui.updateHUD({
    idx: L.idx, name: L.def.name,
    pct: L.mowed / L.grass.N, target: L.def.target,
    time: Math.max(0, L.time), lives: L.lives, maxLives: MAX_LIVES,
    boost: P.boost, powers, radar: arrow.visible,
  });
}

function updatePlay(dt) {
  L.time -= dt;
  const secs = Math.ceil(L.time);
  if (secs <= 5 && secs !== L.lastTick && secs > 0) { L.lastTick = secs; Sound.play('tick'); }
  updatePlayer(dt);
  if (L.ended) return;
  updateBugs(dt, T);
  if (L.ended) return;
  updateGrass(dt);
  updatePickups(dt, T, true);
  updateArrow();
  for (const l of L.lavas) l.pool.update(T);
  updatePlayCamera(dt);
  updateHUD();
  if (L.mowed / L.grass.N >= L.def.target) endLevel(true);
  else if (L.time <= 0) endLevel(false, '時間到了！');
}

function animateIdle(dt) {
  if (!L) return;
  for (const l of L.lavas) l.pool.update(T);
  for (const b of L.bugs) b.update(dt, T);
  updatePickups(dt, T, false);
  const G = L.grass, aH = G.aH.array;
  let ch = false;
  for (let i = 0; i < G.N; i++) if (!G.cut[i] && aH[i] < 1) { aH[i] = Math.min(1, aH[i] + dt * 0.7); ch = true; }
  if (ch) G.aH.needsUpdate = true;
  mower.update(dt, 0, { stunned: false, boosting: false, blink: false });
}

// ---------- 流程 ----------
let countdownT = 0, countdownStep = -1, endT = 0, pendingResult = null;

function toggleMute() { Sound.init(); const m = Sound.toggleMute(); ui.setMuted(m); }

function goTitle() {
  mode = 'menu';
  Sound.setEngine(0, false); Sound.setMow(0);
  if (!L) buildLevel(Math.min(save.unlocked, LEVELS.length) - 1);
  arrow.visible = false;
  ui.showHUD(false);
  ui.showTitle();
}
function goSelect() {
  mode = 'menu';
  Sound.setEngine(0, false); Sound.setMow(0);
  if (!L) buildLevel(Math.min(save.unlocked, LEVELS.length) - 1);
  arrow.visible = false;
  ui.showHUD(false);
  ui.showSelect(LEVELS, save);
}
function openBriefing(idx) {
  buildLevel(idx);
  mode = 'brief';
  ui.showHUD(false);
  ui.showBriefing(LEVELS[idx], idx);
}
function startCountdown() {
  ui.hideScreens();
  ui.showHUD(true);
  resetPlayer();
  mode = 'countdown'; countdownT = 0; countdownStep = -1;
  updateHUD();
}
function pauseGame() {
  if (mode !== 'play') return;
  mode = 'paused';
  Sound.setEngine(0, false); Sound.setMow(0);
  ui.showPause();
}
function resumeGame() {
  if (mode !== 'paused') return;
  ui.hideScreens();
  mode = 'play';
}
function endLevel(win, reason) {
  if (L.ended) return;
  L.ended = true;
  mode = 'ending'; endT = 0;
  Sound.setEngine(0, false); Sound.setMow(0);
  arrow.visible = false;
  const ratio = Math.max(0, L.time) / L.def.time;
  const stars = win ? (ratio >= 0.4 ? 3 : ratio >= 0.2 ? 2 : 1) : 0;
  if (win) {
    save.stars[L.idx] = Math.max(save.stars[L.idx] || 0, stars);
    save.unlocked = Math.max(save.unlocked, Math.min(LEVELS.length, L.idx + 2));
    persist();
    Sound.play('win');
    ui.toast('🎉 草坪整理完成！');
    const x = P.up.x * L.R, y = P.up.y * L.R, z = P.up.z * L.R;
    for (let i = 0; i < 60; i++) emit(x, y, z, P.up.x, P.up.y, P.up.z, { r: Math.random(), g: 1, b: Math.random() }, 6);
  } else {
    Sound.play('lose');
  }
  pendingResult = {
    win, stars, reason: reason || '', pct: L.mowed / L.grass.N, target: L.def.target,
    timeLeft: Math.max(0, L.time), idx: L.idx, hasNext: win && L.idx < LEVELS.length - 1,
    allClear: win && L.idx === LEVELS.length - 1,
  };
  updateHUD();
}

const ui = createUI({
  onPlay() { Sound.init(); Sound.play('click'); Sound.music(true); goSelect(); },
  onSelect(idx) { Sound.init(); Sound.play('click'); openBriefing(idx); },
  onGo() { Sound.init(); Sound.play('click'); startCountdown(); },
  onPause() { pauseGame(); },
  onResume() { Sound.play('click'); resumeGame(); },
  onRestart() { Sound.play('click'); openBriefing(levelIdx); startCountdown(); },
  onMenu() { Sound.play('click'); goSelect(); },
  onNext() { Sound.play('click'); openBriefing(Math.min(LEVELS.length - 1, levelIdx + 1)); },
  onMute() { toggleMute(); },
});
ui.setMuted(Sound.isMuted());

// ---------- 主迴圈 ----------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (mode !== 'paused') T += dt;
  grassUniforms.uTime.value = T;

  if (L) {
    if (mode === 'play') {
      updatePlay(dt);
    } else if (mode === 'countdown') {
      countdownT += dt;
      const step = Math.floor(countdownT / 0.8);
      if (step !== countdownStep) {
        countdownStep = step;
        if (step < 3) { ui.showCountdown(String(3 - step)); Sound.play('count'); }
        else { ui.showCountdown('出發!'); Sound.play('go'); mode = 'play'; setTimeout(() => ui.showCountdown(null), 700); }
      }
      animateIdle(dt);
      updatePlayCamera(dt);
    } else if (mode === 'ending') {
      endT += dt;
      animateIdle(dt);
      if (endT < 1.2) updatePlayCamera(dt); else updateOrbitCamera(dt, 0.2);
      if (endT > 1.6 && pendingResult) { mode = 'result'; ui.showHUD(false); ui.showResult(pendingResult); pendingResult = null; }
    } else if (mode === 'paused') {
      applyCamera(0);
    } else if (mode === 'brief') {
      animateIdle(dt);
      updateOrbitCamera(dt, 0.15);
    } else { // menu / result
      animateIdle(dt);
      updateOrbitCamera(dt, 0.12);
    }
    if (mode !== 'paused') updateParticles(dt);
    env.update(dt, T, camera);
  }
  renderer.render(scene, camera);
}

goTitle();
const boot = document.getElementById('boot');
if (boot) boot.remove();
requestAnimationFrame(frame);

// 方便測試
window.__game = { get L() { return L; }, P, get mode() { return mode; }, LEVELS, save, buildLevel, openBriefing, startCountdown };
