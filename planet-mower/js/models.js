// js/models.js — 星際除草王 3D 模型（程序化、低多邊形卡通風格）
// 座標慣例：原點在地面底部中心，+Y 朝上，+Z 為前方。最外層 group 不設定 position / quaternion。
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 共享資源快取（幾何、材質），避免重複建立
// ---------------------------------------------------------------------------
const _geo = new Map();
const _mat = new Map();

function geo(key, make) {
  let g = _geo.get(key);
  if (!g) { g = make(); _geo.set(key, g); }
  return g;
}

function colorKey(c) { return new THREE.Color(c).getHexString(); }

/** Lambert 材質（flatShading） */
function lam(color, emissive = 0x000000, emissiveIntensity = 1) {
  const key = `L|${colorKey(color)}|${colorKey(emissive)}|${emissiveIntensity}`;
  let m = _mat.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity, flatShading: true });
    _mat.set(key, m);
  }
  return m;
}

function phong(key, params) {
  let m = _mat.get(key);
  if (!m) { m = new THREE.MeshPhongMaterial(params); _mat.set(key, m); }
  return m;
}

function basic(key, params) {
  let m = _mat.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial(params); _mat.set(key, m); }
  return m;
}

function mesh(g, m, x = 0, y = 0, z = 0, parent = null, shadow = true) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  if (shadow) { o.castShadow = true; o.receiveShadow = true; }
  if (parent) parent.add(o);
  return o;
}

const _up = new THREE.Vector3(0, 1, 0);
/** 在 a→b 之間放一段圓柱/膠囊（geometry 必須沿 Y 軸、置中） */
function orientBetween(o, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  o.position.copy(a).addScaledVector(dir, 0.5);
  o.quaternion.setFromUnitVectors(_up, dir.normalize());
  return o;
}

function limb(parent, a, b, radius, material, capsule = true) {
  const len = a.distanceTo(b);
  const g = capsule
    ? geo(`cap|${radius.toFixed(3)}|${len.toFixed(3)}`, () => new THREE.CapsuleGeometry(radius, Math.max(0.001, len - radius), 3, 8))
    : geo(`cyl|${radius.toFixed(3)}|${len.toFixed(3)}`, () => new THREE.CylinderGeometry(radius, radius, len, 8));
  const o = mesh(g, material, 0, 0, 0, parent);
  orientBetween(o, a, b);
  return o;
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// 星星形狀（暈眩 / 道具共用）
function starGeometry() {
  return geo('star', () => {
    const s = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 0.12 : 0.05;
      const a = Math.PI / 2 + (i * Math.PI) / 5;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
    }
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: false });
    g.center();
    return g;
  });
}

// 錐體：底面在原點、尖端朝 -Z（排氣火焰用）
function flameGeometry(r, h, key) {
  return geo(key, () => {
    const g = new THREE.ConeGeometry(r, h, 7, 1, true);
    g.translate(0, h / 2, 0);
    g.rotateX(-Math.PI / 2);
    return g;
  });
}

// ---------------------------------------------------------------------------
// 騎乘式除草機 + 太空人駕駛
// ---------------------------------------------------------------------------
export function makeMower() {
  const group = new THREE.Group();
  group.name = 'mower';
  const root = new THREE.Group(); // blink 時切換的就是這層
  group.add(root);

  // 材質
  const red = lam(0xe8322f);
  const redDark = lam(0xb51f22);
  const black = lam(0x24262b);
  const tire = lam(0x2b2b30);
  const hubM = lam(0xd9dde3);
  const metal = phong('mower-metal', { color: 0xb9c0c9, specular: 0xffffff, shininess: 60, flatShading: true });
  const deckM = lam(0x4a505c);
  const seatM = lam(0x30343c);
  const suit = lam(0xf4f6fa);
  const suitGrey = lam(0xa9b2c0);
  const accent = lam(0xff9a1f);
  const lightM = lam(0xfff6c8, 0xfff2a8, 1.2);
  const visorM = phong('visor', { color: 0x1a2a6c, emissive: 0x060c2a, specular: 0x9fd0ff, shininess: 120, flatShading: false });
  const antBall = lam(0xff3b3b, 0xff2020, 0.6);
  const flagM = _mat.get('flag') || (() => {
    const m = new THREE.MeshLambertMaterial({ color: 0xffd23a, side: THREE.DoubleSide, flatShading: true });
    _mat.set('flag', m); return m;
  })();

  // ---- 車身 ----
  mesh(geo('mw-body', () => new THREE.BoxGeometry(1.0, 0.3, 1.3)), red, 0, 0.48, -0.05, root);
  mesh(geo('mw-skirt', () => new THREE.BoxGeometry(1.04, 0.06, 1.34)), redDark, 0, 0.34, -0.05, root);
  // 引擎蓋
  const hood = mesh(geo('mw-hood', () => new THREE.BoxGeometry(0.86, 0.3, 0.52)), red, 0, 0.76, 0.5, root);
  hood.rotation.x = 0.08;
  mesh(geo('mw-hoodtop', () => new THREE.BoxGeometry(0.6, 0.06, 0.4)), redDark, 0, 0.93, 0.46, root);
  // 水箱罩
  mesh(geo('mw-grille', () => new THREE.BoxGeometry(0.5, 0.18, 0.04)), black, 0, 0.72, 0.77, root);
  // 前保險桿
  mesh(geo('mw-bumper', () => new THREE.BoxGeometry(0.9, 0.08, 0.08)), black, 0, 0.44, 0.7, root);
  // 頭燈
  const lampG = geo('mw-lamp', () => { const g = new THREE.CylinderGeometry(0.075, 0.085, 0.06, 10); g.rotateX(Math.PI / 2); return g; });
  mesh(lampG, lightM, 0.3, 0.8, 0.77, root);
  mesh(lampG, lightM, -0.3, 0.8, 0.77, root);
  // 後擋泥板
  const fenderG = geo('mw-fender', () => new THREE.BoxGeometry(0.28, 0.07, 0.6));
  mesh(fenderG, red, 0.55, 0.69, -0.45, root);
  mesh(fenderG, red, -0.55, 0.69, -0.45, root);

  // ---- 座椅 ----
  mesh(geo('mw-seatbase', () => new THREE.BoxGeometry(0.36, 0.16, 0.36)), black, 0, 0.7, -0.3, root);
  mesh(geo('mw-cushion', () => new THREE.BoxGeometry(0.58, 0.12, 0.5)), seatM, 0, 0.84, -0.3, root);
  const back = mesh(geo('mw-backrest', () => new THREE.BoxGeometry(0.6, 0.42, 0.09)), seatM, 0, 1.0, -0.64, root);
  back.rotation.x = -0.15;

  // ---- 方向盤 ----
  limb(root, V(0, 0.86, 0.34), V(0, 1.1, 0.14), 0.035, black, false);
  const wheelS = mesh(geo('mw-steer', () => new THREE.TorusGeometry(0.16, 0.03, 6, 14)), black, 0, 1.12, 0.12, root);
  wheelS.rotation.x = -2.21;

  // ---- 排氣管 ----
  limb(root, V(0.4, 0.6, -0.7), V(0.4, 1.0, -0.7), 0.05, metal, false);
  limb(root, V(0.4, 0.98, -0.68), V(0.4, 1.0, -0.86), 0.055, metal, false);
  const flame = new THREE.Group();
  flame.position.set(0.4, 1.0, -0.87);
  flame.visible = false;
  root.add(flame);
  const flameOuter = new THREE.Mesh(flameGeometry(0.09, 0.45, 'flame-o'),
    basic('flame-o', { color: 0xff6a1a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const flameInner = new THREE.Mesh(flameGeometry(0.05, 0.28, 'flame-i'),
    basic('flame-i', { color: 0xfff27a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  flame.add(flameOuter, flameInner);

  // ---- 旗子 ----
  limb(root, V(-0.42, 0.6, -0.7), V(-0.42, 1.95, -0.7), 0.018, metal, false);
  const flagPivot = new THREE.Group();
  flagPivot.position.set(-0.42, 1.92, -0.7);
  root.add(flagPivot);
  const flagG = geo('mw-flag', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(0.36, -0.1); s.lineTo(0, -0.22); s.closePath();
    return new THREE.ShapeGeometry(s);
  });
  const flag = mesh(flagG, flagM, 0, 0, 0, flagPivot);
  flag.rotation.y = Math.PI / 2; // +X → -Z（向後飄）

  // ---- 輪子（輪軸沿 X）----
  const wheels = [];
  function addWheel(x, z, r, w) {
    const pivot = new THREE.Group();
    pivot.position.set(x, r, z);
    root.add(pivot);
    const tg = geo(`tire|${r}|${w}`, () => { const g = new THREE.CylinderGeometry(r, r, w, 10); g.rotateZ(Math.PI / 2); return g; });
    const hg = geo(`hub|${r}|${w}`, () => { const g = new THREE.CylinderGeometry(r * 0.5, r * 0.5, w + 0.02, 6); g.rotateZ(Math.PI / 2); return g; });
    const bg = geo(`bolt|${r}`, () => new THREE.BoxGeometry(0.02, r * 0.2, r * 0.2));
    mesh(tg, tire, 0, 0, 0, pivot);
    mesh(hg, hubM, 0, 0, 0, pivot);
    // 輪轂上的小方塊讓轉動看得出來
    const side = Math.sign(x);
    mesh(bg, accent, side * (w / 2 + 0.015), r * 0.28, 0, pivot, false);
    wheels.push({ pivot, r });
  }
  addWheel(0.55, -0.45, 0.32, 0.22);
  addWheel(-0.55, -0.45, 0.32, 0.22);
  addWheel(0.47, 0.55, 0.2, 0.15);
  addWheel(-0.47, 0.55, 0.2, 0.15);

  // ---- 刀盤 ----
  mesh(geo('mw-deck', () => new THREE.CylinderGeometry(0.44, 0.46, 0.1, 12)), deckM, 0, 0.24, 0.05, root);
  const blades = new THREE.Group();
  blades.position.set(0, 0.15, 0.05);
  root.add(blades);
  const bladeG = geo('mw-blade', () => new THREE.BoxGeometry(0.8, 0.02, 0.08));
  mesh(bladeG, metal, 0, 0, 0, blades, false);
  mesh(bladeG, metal, 0, 0, 0, blades, false).rotation.y = Math.PI / 2;
  mesh(geo('mw-bladehub', () => new THREE.CylinderGeometry(0.07, 0.07, 0.06, 8)), accent, 0, 0.01, 0, blades, false);

  // ---- 太空人 ----
  const astro = new THREE.Group();
  root.add(astro);
  // 軀幹
  const torso = mesh(geo('as-torso', () => new THREE.CapsuleGeometry(0.19, 0.22, 3, 10)), suit, 0, 1.18, -0.32, astro);
  torso.rotation.x = -0.12;
  mesh(geo('as-chest', () => new THREE.BoxGeometry(0.18, 0.12, 0.05)), suitGrey, 0, 1.2, -0.13, astro);
  mesh(geo('as-chestbtn', () => new THREE.BoxGeometry(0.05, 0.04, 0.02)), antBall, 0.04, 1.21, -0.1, astro, false);
  // 背包
  mesh(geo('as-pack', () => new THREE.BoxGeometry(0.36, 0.4, 0.16)), suitGrey, 0, 1.24, -0.53, astro);
  mesh(geo('as-packcap', () => new THREE.CylinderGeometry(0.05, 0.05, 0.36, 8).rotateZ(Math.PI / 2)), accent, 0, 1.42, -0.6, astro);
  // 頸圈 + 頭盔 + 面罩
  const ring = mesh(geo('as-neck', () => new THREE.TorusGeometry(0.13, 0.04, 6, 12)), suitGrey, 0, 1.43, -0.3, astro);
  ring.rotation.x = Math.PI / 2;
  mesh(geo('as-helmet', () => new THREE.SphereGeometry(0.24, 12, 10)), suit, 0, 1.62, -0.28, astro);
  const visor = mesh(geo('as-visor', () => new THREE.SphereGeometry(0.18, 14, 10)), visorM, 0, 1.63, -0.15, astro, false);
  visor.scale.set(1.15, 0.85, 0.7);
  // 天線
  limb(astro, V(0.1, 1.8, -0.32), V(0.13, 1.96, -0.34), 0.012, suitGrey, false);
  mesh(geo('as-antball', () => new THREE.SphereGeometry(0.035, 8, 6)), antBall, 0.13, 1.97, -0.34, astro, false);
  // 手臂
  for (const s of [1, -1]) {
    const shoulder = V(0.22 * s, 1.3, -0.3);
    const elbow = V(0.25 * s, 1.15, -0.1);
    const hand = V(0.15 * s, 1.14, 0.1);
    limb(astro, shoulder, elbow, 0.075, suit);
    limb(astro, elbow, hand, 0.07, suit);
    mesh(geo('as-glove', () => new THREE.SphereGeometry(0.07, 8, 6)), accent, hand.x, hand.y, hand.z, astro);
    // 腿
    const hip = V(0.11 * s, 0.95, -0.25);
    const knee = V(0.12 * s, 0.98, 0.05);
    const foot = V(0.13 * s, 0.74, 0.16);
    limb(astro, hip, knee, 0.085, suit);
    limb(astro, knee, foot, 0.08, suit);
    mesh(geo('as-boot', () => new THREE.BoxGeometry(0.13, 0.09, 0.2)), suitGrey, foot.x, 0.69, foot.z + 0.03, astro);
  }

  // ---- 暈眩星星 ----
  const stars = new THREE.Group();
  stars.position.set(0, 2.12, -0.28);
  stars.visible = false;
  root.add(stars);
  const starM = lam(0xffe14a, 0xffc400, 0.9);
  const starList = [];
  for (let i = 0; i < 4; i++) {
    const st = mesh(starGeometry(), starM, 0, 0, 0, stars, false);
    starList.push(st);
  }

  // ---- update ----
  let time = 0;
  function update(dt, speed = 0, opts = {}) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    time += dt;
    const { stunned = false, boosting = false, blink = false } = opts || {};

    // 輪子：前進(+Z)時繞 +X 正轉
    for (const w of wheels) w.pivot.rotation.x += (speed * dt) / w.r;

    // 刀盤持續旋轉（移動時更快）
    blades.rotation.y += dt * (22 + Math.abs(speed) * 2);

    // 車身微震
    const mv = Math.min(1, Math.abs(speed) / 6);
    root.position.y = Math.abs(Math.sin(time * 18)) * 0.012 * (0.3 + mv) + (boosting ? Math.sin(time * 40) * 0.006 : 0);

    // 旗子飄動
    flagPivot.rotation.y = Math.sin(time * (5 + mv * 6)) * (0.18 + mv * 0.15);

    // 暈眩星星
    stars.visible = !!stunned;
    if (stunned) {
      stars.rotation.y += dt * 4;
      for (let i = 0; i < starList.length; i++) {
        const a = (i / starList.length) * Math.PI * 2;
        const st = starList[i];
        st.position.set(Math.cos(a) * 0.3, Math.sin(time * 6 + i * 1.7) * 0.05, Math.sin(a) * 0.3);
        st.rotation.y = -stars.rotation.y + time * 3; // 面向外側並自轉
        st.rotation.z = time * 2 + i;
      }
    }

    // 加速火焰
    flame.visible = !!boosting;
    if (boosting) {
      const f = 0.8 + Math.random() * 0.45;
      flameOuter.scale.set(1 + Math.random() * 0.2, 1 + Math.random() * 0.2, f);
      flameInner.scale.set(1, 1, f * (0.9 + Math.random() * 0.2));
    }

    // 閃爍
    root.visible = blink ? Math.floor(time * 14) % 2 === 0 : true;
  }

  update(0, 0, {});
  return { group, update };
}

// ---------------------------------------------------------------------------
// 外星播種蟲
// ---------------------------------------------------------------------------
export function makeBug(color = 0x9b4dff) {
  const group = new THREE.Group();
  group.name = 'bug';
  const body = new THREE.Group();
  group.add(body);
  const HOVER = 0.62;
  body.position.y = HOVER;

  const base = new THREE.Color(color);
  const bodyM = lam(base.getHex());
  const spotM = lam(base.clone().lerp(new THREE.Color(0xffffff), 0.45).getHex());
  const darkM = lam(base.clone().multiplyScalar(0.55).getHex());
  const eyeW = lam(0xffffff, 0x333333, 1);
  const pupil = phong('bug-pupil', { color: 0x111118, specular: 0xffffff, shininess: 90 });
  const bagM = lam(0xc9a066);
  const ropeM = lam(0x7a5530);
  const seedM = lam(0xe8d36a, 0x403000, 1);
  const tipM = lam(0xfff07a, 0xffd23a, 0.8);

  // 身體與頭
  const torso = mesh(geo('bug-body', () => new THREE.SphereGeometry(0.42, 10, 8)), bodyM, 0, 0, -0.05, body);
  torso.scale.set(1, 0.75, 1.2);
  const head = mesh(geo('bug-head', () => new THREE.SphereGeometry(0.28, 10, 8)), bodyM, 0, 0.06, 0.48, body);
  head.scale.set(1.05, 0.95, 0.9);
  // 斑點
  const spotG = geo('bug-spot', () => new THREE.SphereGeometry(0.075, 6, 4));
  const spots = [[0.22, 0.22, 0.12], [-0.25, 0.2, -0.05], [0.18, 0.18, -0.32], [-0.12, 0.27, 0.2], [0.3, 0.06, -0.15], [-0.3, 0.08, -0.3]];
  for (const [x, y, z] of spots) {
    const s = mesh(spotG, spotM, x, y, z, body, false);
    s.scale.set(1, 0.5, 1);
    s.lookAt(x * 3, y * 4 + 0.5, z * 3);
  }
  // 大眼睛
  const eyeG = geo('bug-eye', () => new THREE.SphereGeometry(0.13, 10, 8));
  const pupG = geo('bug-pupil', () => new THREE.SphereGeometry(0.065, 8, 6));
  const hiG = geo('bug-hi', () => new THREE.SphereGeometry(0.022, 5, 4));
  for (const s of [1, -1]) {
    mesh(eyeG, eyeW, 0.12 * s, 0.18, 0.66, body, false);
    mesh(pupG, pupil, 0.13 * s, 0.18, 0.77, body, false);
    mesh(hiG, eyeW, 0.15 * s, 0.21, 0.83, body, false);
  }
  // 觸角
  const antennae = [];
  for (const s of [1, -1]) {
    const piv = new THREE.Group();
    piv.position.set(0.1 * s, 0.28, 0.5);
    body.add(piv);
    limb(piv, V(0, 0, 0), V(0.13 * s, 0.32, 0.14), 0.018, darkM, false);
    mesh(geo('bug-anttip', () => new THREE.SphereGeometry(0.05, 8, 6)), tipM, 0.13 * s, 0.33, 0.14, piv, false);
    antennae.push({ piv, s });
  }
  // 6 條腳
  const legs = [];
  for (const s of [1, -1]) {
    for (let i = 0; i < 3; i++) {
      const piv = new THREE.Group();
      piv.position.set(0.3 * s, -0.12, 0.25 - i * 0.28);
      body.add(piv);
      const knee = V(0.2 * s, -0.04, 0);
      const foot = V(0.3 * s, -0.26, 0.02);
      limb(piv, V(0, 0, 0), knee, 0.03, darkM, false);
      limb(piv, knee, foot, 0.026, darkM, false);
      mesh(geo('bug-foot', () => new THREE.SphereGeometry(0.04, 6, 4)), darkM, foot.x, foot.y, foot.z, piv, false);
      legs.push({ piv, s, i });
    }
  }
  // 背上的種子袋
  const bag = mesh(geo('bug-bag', () => new THREE.SphereGeometry(0.19, 8, 6)), bagM, 0, 0.36, -0.2, body);
  bag.scale.set(1, 0.85, 1);
  mesh(geo('bug-bagneck', () => new THREE.CylinderGeometry(0.05, 0.09, 0.1, 6)), bagM, 0, 0.53, -0.2, body, false);
  mesh(geo('bug-rope', () => new THREE.TorusGeometry(0.06, 0.018, 4, 8).rotateX(Math.PI / 2)), ropeM, 0, 0.54, -0.2, body, false);
  const seedG = geo('bug-seed', () => new THREE.SphereGeometry(0.035, 5, 4));
  mesh(seedG, seedM, 0.02, 0.6, -0.19, body, false);
  mesh(seedG, seedM, -0.04, 0.61, -0.22, body, false);
  mesh(seedG, seedM, 0.01, 0.62, -0.25, body, false);
  // 綁帶
  mesh(geo('bug-strap', () => new THREE.TorusGeometry(0.3, 0.02, 4, 12)), ropeM, 0, 0.12, -0.2, body, false).rotation.y = Math.PI / 2;

  const phase = (group.id * 1.618) % (Math.PI * 2);
  function update(dt, t = 0) {
    const p = t + phase;
    body.position.y = HOVER + Math.sin(p * 3) * 0.07;
    body.rotation.z = Math.sin(p * 2.2) * 0.06;
    body.rotation.x = Math.sin(p * 3 + 1) * 0.05;
    for (const l of legs) {
      l.piv.rotation.x = Math.sin(p * 9 + l.i * 2.1 + (l.s > 0 ? 0 : Math.PI)) * 0.45;
      l.piv.rotation.z = l.s * (0.1 + Math.sin(p * 4 + l.i) * 0.1);
    }
    for (const a of antennae) {
      a.piv.rotation.z = a.s * Math.sin(p * 5) * 0.25;
      a.piv.rotation.x = Math.sin(p * 4 + a.s) * 0.2;
    }
    bag.rotation.z = Math.sin(p * 3) * 0.1;
  }
  update(0, 0);
  return { group, update };
}

// ---------------------------------------------------------------------------
// 岩石
// ---------------------------------------------------------------------------
function lumpyGeometry(baseGeo, rng, amount) {
  const g = baseGeo.clone();
  const pos = g.attributes.position;
  const offs = new Map();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let f = offs.get(k);
    if (f === undefined) { f = 1 + (rng() * 2 - 1) * amount; offs.set(k, f); }
    v.multiplyScalar(f);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export function makeRock(rng = Math.random, size = 0.8, color = 0x8a8577) {
  const group = new THREE.Group();
  group.name = 'rock';
  const m = lam(color);
  const g = lumpyGeometry(geo('rock-base', () => new THREE.DodecahedronGeometry(1, 0)), rng, 0.22);
  const main = mesh(g, m, 0, 0, 0, group);
  const sy = 0.65 + rng() * 0.25;
  main.scale.set(size * (0.82 + rng() * 0.12), size * sy, size * (0.82 + rng() * 0.12));
  main.position.y = size * sy * 0.78;
  main.rotation.set(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4);

  // 旁邊的小石子（共享幾何）
  const pebG = geo('rock-pebble', () => new THREE.DodecahedronGeometry(1, 0));
  const darker = lam(new THREE.Color(color).multiplyScalar(0.85).getHex());
  const n = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const r = size * (0.95 + rng() * 0.25);
    const s = size * (0.16 + rng() * 0.14);
    const p = mesh(pebG, darker, Math.cos(a) * r, s * 0.6, Math.sin(a) * r, group);
    p.scale.set(s, s * 0.75, s);
    p.rotation.set(rng() * 3, rng() * 3, rng() * 3);
  }
  return group;
}

// ---------------------------------------------------------------------------
// 仙人掌（碰撞半徑約 0.45）
// ---------------------------------------------------------------------------
export function makeCactus(rng = Math.random, height = 1.6) {
  const group = new THREE.Group();
  group.name = 'cactus';
  const inner = new THREE.Group(); // 外層 group 交給主控擺放，旋轉放在內層
  inner.rotation.y = rng() * Math.PI * 2;
  group.add(inner);
  const green = lam(0x3fae4a);
  const greenD = lam(0x2e8a3a);
  const flowerM = lam(0xff6fae, 0x401020, 1);
  const capG = geo('cactus-cap', () => new THREE.CapsuleGeometry(1, 1, 3, 8)); // 高度 3（含兩端）

  const h = Math.max(0.6, height);
  const r = 0.3;
  const trunk = mesh(capG, green, 0, h / 2, 0, inner);
  trunk.scale.set(r, h / 3, r);
  // 刺紋（細條）
  const ribG = geo('cactus-rib', () => new THREE.BoxGeometry(0.03, 1, 0.03));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const rb = mesh(ribG, greenD, Math.cos(a) * r * 0.98, h * 0.48, Math.sin(a) * r * 0.98, inner, false);
    rb.scale.y = h * 0.6;
  }

  const nArms = 1 + Math.floor(rng() * 2.2);
  let ang = rng() * Math.PI * 2;
  for (let i = 0; i < nArms; i++) {
    const side = new THREE.Group();
    side.rotation.y = ang;
    inner.add(side);
    const ay = h * (0.35 + rng() * 0.25);
    const ar = 0.15;
    // 水平段
    const hor = mesh(capG, green, 0.26, ay, 0, side);
    hor.scale.set(ar, 0.3 / 3 + 0.05, ar);
    hor.rotation.z = Math.PI / 2;
    // 上彎段
    const up = 0.3 + rng() * 0.35;
    const vert = mesh(capG, green, 0.38, ay + up / 2, 0, side);
    vert.scale.set(ar, (up + 0.1) / 3, ar);
    ang += Math.PI * (0.7 + rng() * 0.6);
  }
  // 頂端小花
  if (rng() < 0.7) {
    const fl = mesh(geo('cactus-flower', () => new THREE.IcosahedronGeometry(0.1, 0)), flowerM, 0, h + 0.02, 0, inner, false);
    fl.scale.y = 0.6;
  }
  return group;
}

// ---------------------------------------------------------------------------
// 晶簇
// ---------------------------------------------------------------------------
function crystalMaterial(color) {
  const c = new THREE.Color(color);
  return phong(`crystal|${c.getHexString()}`, {
    color: c,
    emissive: c.clone().multiplyScalar(0.35),
    specular: 0xffffff,
    shininess: 90,
    transparent: true,
    opacity: 0.88,
    flatShading: true,
  });
}

export function makeCrystal(rng = Math.random, size = 0.7, color = 0x9fe8ff) {
  const group = new THREE.Group();
  group.name = 'crystal';
  const inner = new THREE.Group();
  inner.rotation.y = rng() * Math.PI * 2;
  group.add(inner);
  const m = crystalMaterial(color);
  const g = geo('crystal-shard', () => new THREE.LatheGeometry(
    [new THREE.Vector2(0, 0), new THREE.Vector2(1, 0), new THREE.Vector2(1, 0.72), new THREE.Vector2(0, 1)], 6));

  // 主晶柱
  const main = mesh(g, m, 0, -0.05 * size, 0, inner);
  main.scale.set(size * 0.42, size * (2 + rng() * 0.6), size * 0.42);
  // 周圍小晶柱
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.6;
    const d = size * (0.38 + rng() * 0.3);
    const s = mesh(g, m, Math.cos(a) * d, -0.05 * size, Math.sin(a) * d, inner);
    const hh = size * (0.7 + rng() * 0.9);
    const rr = size * (0.18 + rng() * 0.12);
    s.scale.set(rr, hh, rr);
    // 往外傾斜
    s.rotation.set(Math.sin(a) * (0.35 + rng() * 0.3), 0, -Math.cos(a) * (0.35 + rng() * 0.3));
  }
  // 底座石塊
  const baseM = lam(new THREE.Color(color).multiplyScalar(0.35).lerp(new THREE.Color(0x555566), 0.5).getHex());
  const b = mesh(geo('crystal-base', () => new THREE.DodecahedronGeometry(1, 0)), baseM, 0, 0.05 * size, 0, inner);
  b.scale.set(size * 0.75, size * 0.25, size * 0.75);
  return group;
}

// ---------------------------------------------------------------------------
// 道具
// ---------------------------------------------------------------------------
const PICKUP_COLORS = { wide: 0xff8a1f, time: 0x2fe6ff, boost: 0xffe23a };

export function makePickup(type = 'boost') {
  if (!PICKUP_COLORS[type]) type = 'boost';
  const color = PICKUP_COLORS[type];
  const group = new THREE.Group();
  group.name = `pickup-${type}`;
  const bob = new THREE.Group();
  group.add(bob);
  const spin = new THREE.Group();
  bob.add(spin);

  const c = new THREE.Color(color);
  const iconM = lam(c.getHex(), c.getHex(), 0.75);
  const whiteM = lam(0xffffff, 0xffffff, 0.5);
  const shellM = phong(`pk-shell|${type}`, {
    color: c, emissive: c.clone().multiplyScalar(0.4), specular: 0xffffff, shininess: 100,
    transparent: true, opacity: 0.22, depthWrite: false, flatShading: true,
  });
  const haloM = basic(`pk-halo|${type}`, {
    color: c, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const glowM = basic(`pk-glow|${type}`, {
    color: c, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
  });

  // 圖示
  if (type === 'wide') {
    // 左右雙箭頭 ↔
    mesh(geo('pk-shaft', () => new THREE.BoxGeometry(0.36, 0.08, 0.08)), iconM, 0, 0, 0, spin, false);
    const coneG = geo('pk-arrow', () => new THREE.ConeGeometry(0.1, 0.16, 6));
    mesh(coneG, iconM, 0.24, 0, 0, spin, false).rotation.z = -Math.PI / 2;
    mesh(coneG, iconM, -0.24, 0, 0, spin, false).rotation.z = Math.PI / 2;
    mesh(geo('pk-wide-disc', () => new THREE.CylinderGeometry(0.09, 0.09, 0.05, 10).rotateX(Math.PI / 2)), whiteM, 0, 0, 0, spin, false);
  } else if (type === 'time') {
    // 沙漏
    const coneG = geo('pk-hg', () => new THREE.ConeGeometry(0.14, 0.18, 8));
    mesh(coneG, iconM, 0, 0.09, 0, spin, false).rotation.x = Math.PI;
    mesh(coneG, iconM, 0, -0.09, 0, spin, false);
    const capG = geo('pk-hgcap', () => new THREE.CylinderGeometry(0.17, 0.17, 0.04, 10));
    mesh(capG, whiteM, 0, 0.2, 0, spin, false);
    mesh(capG, whiteM, 0, -0.2, 0, spin, false);
  } else {
    // 閃電
    const g = geo('pk-bolt', () => {
      const s = new THREE.Shape();
      s.moveTo(0.06, 0.26); s.lineTo(-0.12, -0.02); s.lineTo(0.0, -0.02);
      s.lineTo(-0.06, -0.26); s.lineTo(0.13, 0.04); s.lineTo(0.01, 0.04); s.closePath();
      const eg = new THREE.ExtrudeGeometry(s, { depth: 0.07, bevelEnabled: false });
      eg.center();
      return eg;
    });
    mesh(g, iconM, 0, 0, 0, spin, false);
  }

  // 半透明外殼 + 光暈
  mesh(geo('pk-shell', () => new THREE.IcosahedronGeometry(0.34, 1)), shellM, 0, 0, 0, bob, false);
  const glow = mesh(geo('pk-glow', () => new THREE.SphereGeometry(0.46, 12, 8)), glowM, 0, 0, 0, bob, false);
  const haloG = geo('pk-halo', () => new THREE.TorusGeometry(0.42, 0.025, 6, 28));
  const halo1 = mesh(haloG, haloM, 0, 0, 0, bob, false);
  const halo2 = mesh(haloG, haloM, 0, 0, 0, bob, false);
  halo1.rotation.x = Math.PI / 2;
  halo2.scale.setScalar(0.85);
  // 繞行的小星星
  const sparkM = lam(0xffffff, c.getHex(), 1);
  const sparks = [];
  for (let i = 0; i < 3; i++) {
    const sp = mesh(starGeometry(), sparkM, 0, 0, 0, bob, false);
    sp.scale.setScalar(0.45);
    sparks.push(sp);
  }

  const phase = (group.id * 0.917) % (Math.PI * 2);
  function update(dt, t = 0) {
    const p = t + phase;
    bob.position.y = Math.sin(p * 2.4) * 0.1;
    spin.rotation.y = p * 2.2;
    halo1.rotation.z = p * 1.5;
    halo2.rotation.set(Math.PI / 2 + Math.sin(p * 1.3) * 0.9, p * 1.1, 0);
    const pulse = 1 + Math.sin(p * 5) * 0.08;
    glow.scale.setScalar(pulse);
    for (let i = 0; i < sparks.length; i++) {
      const a = p * 1.8 + (i / sparks.length) * Math.PI * 2;
      sparks[i].position.set(Math.cos(a) * 0.5, Math.sin(p * 3 + i * 2) * 0.12, Math.sin(a) * 0.5);
      sparks[i].rotation.y = -a;
    }
  }
  update(0, 0);
  return { group, update };
}
