// 星際除草王 — 關卡資料、星球外觀、天空與背景（分身 D）
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 關卡資料
// ---------------------------------------------------------------------------
export const LEVELS = [
  {
    id: 1, name: '翠綠星', sub: '新手訓練場',
    radius: 8, time: 100, target: 0.8, density: 5.5, traction: 9,
    rocks: 6, cacti: 0, crystals: 0, lava: 0, bugs: 0,
    regrow: 0,
    colors: {
      ground: [0x5c4326, 0x3d5a22],
      grass: [0x5fe03c, 0xb8f55a],
      sky: 0x4f9ee8, hemiSky: 0xcbe8ff, hemiGround: 0x4a3a20,
      sun: 0xfff1cc, atmo: 0x8fd4ff,
      rock: 0x8c8a94, crystal: 0x9fe8ff, bug: 0xff5fa0, lava: 0xff5a1a,
    },
    emissiveGrass: 0,
    hazards: ['🪨 岩石：撞到會反彈，小心繞過'],
    tip: '先沿著一個方向繞一大圈，再往旁邊挪一點繼續繞，像剝橘子一樣最有效率！',
    css: 'radial-gradient(circle at 35% 30%, #c8ff8a 0%, #5fd03c 35%, #2f7a1e 70%, #143a0c 100%)',
  },
  {
    id: 2, name: '沙丘星', sub: '仙人掌荒漠',
    radius: 9, time: 130, target: 0.8, density: 5.5, traction: 9,
    rocks: 4, cacti: 12, crystals: 0, lava: 0, bugs: 0,
    regrow: 0,
    colors: {
      ground: [0x8c5a2c, 0x6a3f20],
      grass: [0xf0c53c, 0xffe684],
      sky: 0x4a2a6a, hemiSky: 0xffc89a, hemiGround: 0x5a3418,
      sun: 0xffb46e, atmo: 0xff9a66,
      rock: 0xa8744a, crystal: 0xffd27a, bug: 0x7affd0, lava: 0xff5a1a,
    },
    emissiveGrass: 0,
    hazards: ['🌵 仙人掌：撞到會暈眩', '🪨 岩石：撞到會反彈'],
    tip: '仙人掌附近的草可以慢速靠近再割，暈眩會浪費好幾秒！',
    css: 'radial-gradient(circle at 35% 30%, #fff0a8 0%, #f0b848 35%, #b06a28 70%, #4a2410 100%)',
  },
  {
    id: 3, name: '冰晶星', sub: '滑溜溜的凍原',
    radius: 9, time: 165, target: 0.8, density: 5.5, traction: 2.0,
    rocks: 2, cacti: 0, crystals: 10, lava: 0, bugs: 0,
    regrow: 0,
    colors: {
      ground: [0x3e6488, 0x26405e],
      grass: [0xc8fff4, 0x7ae6e0],
      sky: 0x163a6e, hemiSky: 0xd8f4ff, hemiGround: 0x284060,
      sun: 0xe8f8ff, atmo: 0xa8f2ff,
      rock: 0x7a8ca4, crystal: 0x8fe6ff, bug: 0xff7ab0, lava: 0xff5a1a,
    },
    emissiveGrass: 0,
    hazards: ['🧊 地面很滑：轉彎會甩尾，提早減速', '💎 冰晶：撞到會反彈'],
    tip: '冰上要「點油門」：放開油門讓車滑行轉彎，比一直踩著更好控制。',
    css: 'radial-gradient(circle at 35% 30%, #ffffff 0%, #b8f4ff 30%, #4aa0d8 68%, #12305a 100%)',
  },
  {
    id: 4, name: '熔岩星', sub: '滾燙的火山地帶',
    radius: 10, time: 150, target: 0.8, density: 5.5, traction: 9,
    rocks: 6, cacti: 0, crystals: 0, lava: 8, bugs: 0,
    regrow: 0,
    colors: {
      ground: [0x2e1410, 0x140806],
      grass: [0xff7a1a, 0xffc43a],
      sky: 0x260604, hemiSky: 0xff9060, hemiGround: 0x3a0c06,
      sun: 0xffa060, atmo: 0xff5a24,
      rock: 0x3e2c2a, crystal: 0xff9a50, bug: 0x9aff5a, lava: 0xff4a10,
    },
    emissiveGrass: 0,
    hazards: ['🔥 熔岩池：開進去會燒傷扣一條命', '🪨 岩石：撞到會反彈'],
    tip: '熔岩池周圍的焦土就是警戒線，看到黑圈就轉彎！',
    css: 'radial-gradient(circle at 35% 30%, #ffd27a 0%, #ff6a1a 32%, #8a1e08 68%, #1e0604 100%)',
  },
  {
    id: 5, name: '紫晶星', sub: '播種蟲的巢穴',
    radius: 10.5, time: 180, target: 0.78, density: 5.5, traction: 9,
    rocks: 0, cacti: 0, crystals: 6, lava: 0, bugs: 2,
    regrow: 0.12,
    colors: {
      ground: [0x3a1c5a, 0x22103e],
      grass: [0xe07aff, 0xff9ad6],
      sky: 0x1c0838, hemiSky: 0xe6b8ff, hemiGround: 0x2a1040,
      sun: 0xffd4f2, atmo: 0xc884ff,
      rock: 0x5a4a70, crystal: 0xb466ff, bug: 0x7aff6a, lava: 0xff5a1a,
    },
    emissiveGrass: 0,
    hazards: ['🐛 播種蟲：會把割過的草種回去，碰到扣命', '🌱 部分草會慢慢再長回來', '💎 紫晶：撞到會反彈'],
    tip: '先避開播種蟲，把大片區域割完，最後再回頭清理零星長回來的草。',
    css: 'radial-gradient(circle at 35% 30%, #ffd0ff 0%, #d070ff 32%, #6a24a8 68%, #1e0838 100%)',
  },
  {
    id: 6, name: '暗影星', sub: '終章・夜光草原',
    radius: 11, time: 220, target: 0.78, density: 5.5, traction: 4.5,
    rocks: 4, cacti: 6, crystals: 0, lava: 6, bugs: 2,
    regrow: 0.12,
    colors: {
      ground: [0x141a24, 0x1c1030],
      grass: [0x2affc4, 0x8aff7a],
      sky: 0x03040a, hemiSky: 0x5a78b0, hemiGround: 0x101018,
      sun: 0xa8c4ff, atmo: 0x40ffd0,
      rock: 0x363a48, crystal: 0x60ffe0, bug: 0xff4060, lava: 0xff5020,
    },
    emissiveGrass: 0.15,
    hazards: ['🌌 夜光草：黑暗中只看得到發光的草', '🔥 熔岩池：燒傷扣命', '🐛 播種蟲：種回草、碰到扣命', '🌵 仙人掌：撞到會暈眩', '⛸️ 地面有點滑'],
    tip: '終極挑戰！留意雷達箭頭，加速能量留給最後找剩下的草。',
    css: 'radial-gradient(circle at 35% 30%, #a0fff0 0%, #2ac8a8 26%, #143a50 62%, #04060e 100%)',
  },
];

// ---------------------------------------------------------------------------
// 小工具：亂數與雜訊
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x, y, z, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, seed);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

function fbm3(x, y, z, seed, oct = 4) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + i * 17);
    norm += amp; amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// 星球
// ---------------------------------------------------------------------------
export function makePlanetMesh(def) {
  const R = def.radius;
  const geo = new THREE.IcosahedronGeometry(R, 24);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cA = new THREE.Color(def.colors.ground[0]);
  const cB = new THREE.Color(def.colors.ground[1]);
  const tmp = new THREE.Color();
  const seed = (def.id || 1) * 101;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / R, y = pos.getY(i) / R, z = pos.getZ(i) / R;
    let n = fbm3(x * 2.2 + 10, y * 2.2 + 20, z * 2.2 + 30, seed, 4);
    n = THREE.MathUtils.smoothstep(n, 0.3, 0.7);
    tmp.copy(cA).lerp(cB, n);
    // 少量斑點
    const s = valueNoise3(x * 14 + 5, y * 14 + 7, z * 14 + 9, seed + 7);
    if (s > 0.78) tmp.multiplyScalar(0.82);
    else if (s < 0.16) tmp.lerp(cA, 0.35).multiplyScalar(1.08);
    // 細微明暗
    const f = 0.92 + 0.16 * valueNoise3(x * 30, y * 30, z * 30, seed + 3);
    tmp.multiplyScalar(f);
    colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'planet';
  return mesh;
}

// ---------------------------------------------------------------------------
// 熔岩池
// ---------------------------------------------------------------------------
export function makeLavaPool(def, R, angR) {
  const lavaColor = new THREE.Color(def.colors.lava);
  const geo = new THREE.SphereGeometry(R + 0.03, 32, 6, 0, Math.PI * 2, 0, angR);
  // 頂點色：中心亮黃、邊緣深紅，加一點雜訊
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const hot = new THREE.Color(0xffd040);
  const edge = lavaColor.clone().multiplyScalar(0.7);
  const tmp = new THREE.Color();
  const seed = Math.floor(Math.random() * 1e6);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = Math.acos(THREE.MathUtils.clamp(y / (R + 0.03), -1, 1)) / angR; // 0 中心 → 1 邊緣
    const n = valueNoise3(x * 1.6, y * 1.6, z * 1.6, seed);
    const k = THREE.MathUtils.clamp(a * 0.9 + (n - 0.5) * 0.6, 0, 1);
    tmp.copy(hot).lerp(lavaColor, Math.min(1, k * 1.6)).lerp(edge, Math.max(0, k - 0.6) * 2.2);
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff, vertexColors: true,
    emissive: lavaColor, emissiveIntensity: 0.9,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'lava';

  // 焦土外環
  const scorchGeo = new THREE.SphereGeometry(R + 0.015, 32, 2, 0, Math.PI * 2, angR * 0.9, angR * 0.38);
  const scorchMat = new THREE.MeshLambertMaterial({
    color: 0x1a0c08, emissive: lavaColor, emissiveIntensity: 0.12,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const scorch = new THREE.Mesh(scorchGeo, scorchMat);
  scorch.name = 'lava-scorch';
  mesh.add(scorch);

  const phase = Math.random() * Math.PI * 2;
  return {
    mesh,
    update(t) {
      const p = Math.sin(t * 2.2 + phase) * 0.5 + 0.5;
      const q = Math.sin(t * 5.3 + phase * 1.7) * 0.5 + 0.5;
      mat.emissiveIntensity = 0.65 + 0.45 * p + 0.12 * q;
      scorchMat.emissiveIntensity = 0.08 + 0.14 * p;
    },
  };
}

// ---------------------------------------------------------------------------
// 環境：星空、太陽、遠方天體、大氣
// ---------------------------------------------------------------------------
function makeGlowTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, s] of stops) grd.addColorStop(o, s);
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hex(c) { return '#' + new THREE.Color(c).getHexString(); }

// 條紋行星貼圖
function makeBandTexture(cols, seed, bands = 18) {
  const rng = mulberry32(seed);
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const g = c.getContext('2d');
  let y = 0;
  while (y < 256) {
    const h = 6 + rng() * 22;
    g.fillStyle = hex(cols[Math.floor(rng() * cols.length)]);
    g.fillRect(0, y, 16, h + 1);
    y += h;
  }
  // 柔化
  const out = document.createElement('canvas');
  out.width = 16; out.height = 256;
  const og = out.getContext('2d');
  og.filter = 'blur(2px)';
  og.drawImage(c, 0, 0);
  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSpotTexture(base, spot, seed) {
  const rng = mulberry32(seed);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = hex(base);
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 40; i++) {
    const x = rng() * 256, y = 14 + rng() * 100, r = 3 + rng() * 12;
    g.fillStyle = hex(spot);
    g.globalAlpha = 0.25 + rng() * 0.5;
    g.beginPath(); g.ellipse(x, y, r, r * 0.8, 0, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRingTexture(cols, seed) {
  const rng = mulberry32(seed);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 4;
  const g = c.getContext('2d');
  for (let x = 0; x < 256; x++) {
    const a = (0.25 + rng() * 0.75) * Math.sin((x / 255) * Math.PI) ** 0.5;
    const col = new THREE.Color(cols[Math.floor(x / 256 * cols.length * 3) % cols.length]);
    g.fillStyle = `rgba(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0},${a.toFixed(3)})`;
    g.fillRect(x, 0, 1, 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 讓 RingGeometry 的 UV 依半徑展開
function ringGeometry(inner, outer) {
  const geo = new THREE.RingGeometry(inner, outer, 96, 1);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    uv.setXY(i, (r - inner) / (outer - inner), 0.5);
  }
  return geo;
}

function basicMat(opts) {
  return new THREE.MeshBasicMaterial(Object.assign({ fog: false }, opts));
}

// 簡單光照的遠方行星（自帶固定明暗，不吃場景燈光）
function shadedPlanetMat(map, color, lightDir, emissive = 0) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map }, hasMap: { value: map ? 1 : 0 },
      color: { value: new THREE.Color(color) },
      lightDir: { value: lightDir.clone().normalize() },
      emissive: { value: emissive },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position,1.0);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map; uniform float hasMap; uniform vec3 color; uniform vec3 lightDir; uniform float emissive;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        vec3 base = color;
        if (hasMap > 0.5) base *= texture2D(map, vUv).rgb;
        float d = max(dot(normalize(vN), lightDir), 0.0);
        float rim = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 3.0);
        vec3 c = base * (0.12 + 0.95 * d) + base * rim * 0.35 + base * emissive;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    fog: false,
  });
}

function buildDecor(def, lightDir) {
  const g = new THREE.Group();
  g.name = 'decor';
  const spinners = [];
  const C = def.colors;
  const add = (obj, spin = 0.01) => { g.add(obj); spinners.push({ obj, spin }); return obj; };

  switch (def.id) {
    case 1: { // 灰藍大月亮 + 小月亮
      const m1 = add(new THREE.Mesh(new THREE.SphereGeometry(16, 40, 24),
        shadedPlanetMat(makeSpotTexture(0xdfe6f0, 0x8a94a8, 11), 0xffffff, lightDir)), 0.01);
      m1.position.set(-120, 70, -160);
      const m2 = add(new THREE.Mesh(new THREE.SphereGeometry(6, 24, 16),
        shadedPlanetMat(makeSpotTexture(0xf0d8b0, 0xa08060, 12), 0xffffff, lightDir)), 0.03);
      m2.position.set(90, 40, -190);
      break;
    }
    case 2: { // 環狀行星
      const p = add(new THREE.Mesh(new THREE.SphereGeometry(30, 48, 32),
        shadedPlanetMat(makeBandTexture([0xffd8a0, 0xe8a060, 0xc87848, 0xfff0d0], 21), 0xffffff, lightDir)), 0.006);
      p.position.set(-150, 60, -170);
      p.rotation.z = 0.35;
      const ring = new THREE.Mesh(ringGeometry(40, 66),
        basicMat({ map: makeRingTexture([0xffe0b0, 0xd09060, 0xfff4e0], 22), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = Math.PI / 2 - 0.25;
      p.add(ring);
      const m = add(new THREE.Mesh(new THREE.SphereGeometry(5, 20, 14),
        shadedPlanetMat(null, 0xc8a0ff, lightDir)), 0.02);
      m.position.set(110, 80, -150);
      break;
    }
    case 3: { // 冰藍氣體巨星 + 小冰月
      const p = add(new THREE.Mesh(new THREE.SphereGeometry(42, 48, 32),
        shadedPlanetMat(makeBandTexture([0xbfefff, 0x7ac8f0, 0xe8fbff, 0x5aa0d8], 31), 0xffffff, lightDir)), 0.004);
      p.position.set(140, -30, -200);
      p.rotation.z = -0.2;
      const m = add(new THREE.Mesh(new THREE.SphereGeometry(7, 24, 16),
        shadedPlanetMat(makeSpotTexture(0xffffff, 0xa8d8f0, 32), 0xffffff, lightDir)), 0.02);
      m.position.set(-100, 90, -150);
      break;
    }
    case 4: { // 紅巨星 + 黑色小衛星
      const s = add(new THREE.Mesh(new THREE.SphereGeometry(38, 40, 24),
        basicMat({ map: makeSpotTexture(0xff5a20, 0xffb040, 41), color: 0xffffff })), 0.003);
      s.position.set(-150, 40, -200);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeGlowTexture([[0, 'rgba(255,120,40,0.9)'], [0.45, 'rgba(255,60,20,0.35)'], [1, 'rgba(255,40,0,0)']]),
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
      }));
      halo.scale.setScalar(150);
      s.add(halo);
      const m = add(new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16),
        shadedPlanetMat(makeSpotTexture(0x3a2a28, 0xff5020, 42), 0xffffff, lightDir, 0.15)), 0.02);
      m.position.set(100, 70, -160);
      break;
    }
    case 5: { // 粉紫雙環行星 + 晶石小行星
      const p = add(new THREE.Mesh(new THREE.SphereGeometry(28, 48, 32),
        shadedPlanetMat(makeBandTexture([0xffb8f0, 0xd080ff, 0xf0d8ff, 0xa060e0], 51), 0xffffff, lightDir)), 0.006);
      p.position.set(140, 70, -170);
      p.rotation.z = -0.4;
      const r1 = new THREE.Mesh(ringGeometry(36, 50),
        basicMat({ map: makeRingTexture([0xffc0f0, 0xe090ff], 52), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      r1.rotation.x = Math.PI / 2 - 0.3;
      const r2 = new THREE.Mesh(ringGeometry(54, 62),
        basicMat({ map: makeRingTexture([0xa0f0ff, 0xc0a0ff], 53), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      r2.rotation.x = Math.PI / 2 - 0.3;
      p.add(r1, r2);
      const rng = mulberry32(54);
      for (let i = 0; i < 7; i++) {
        const a = new THREE.Mesh(new THREE.OctahedronGeometry(2 + rng() * 4, 0),
          shadedPlanetMat(null, new THREE.Color(C.crystal).lerp(new THREE.Color(0xffffff), rng() * 0.4), lightDir, 0.25));
        a.position.set(-160 + rng() * 120, -40 + rng() * 140, -140 - rng() * 80);
        a.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        add(a, 0.1 + rng() * 0.2);
      }
      break;
    }
    case 6:
    default: { // 巨大暗色行星 + 青綠輪廓 + 星雲
      const p = add(new THREE.Mesh(new THREE.SphereGeometry(70, 48, 32),
        shadedPlanetMat(makeBandTexture([0x1a2030, 0x101420, 0x22283a], 61), 0x8090b0, lightDir)), 0.003);
      p.position.set(-120, 30, -250);
      const rim = new THREE.Mesh(new THREE.SphereGeometry(74, 48, 32), new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(C.atmo) } },
        vertexShader: `varying vec3 vN; varying vec3 vV;
          void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 wp = modelMatrix*vec4(position,1.0);
          vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix*viewMatrix*wp; }`,
        fragmentShader: `uniform vec3 color; varying vec3 vN; varying vec3 vV;
          void main(){ float d = abs(dot(normalize(vN), normalize(vV)));
          float a = smoothstep(0.0, 0.45, d) * (1.0 - smoothstep(0.45, 0.75, d));
          gl_FragColor = vec4(color * a * 0.9, 1.0);
          #include <colorspace_fragment>
          }`,
        side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false,
      }));
      p.add(rim);
      const neb = [[0x2040ff, 160, 120, -280, 260], [0xff3080, -40, 150, -300, 220], [0x20ffc0, 200, -60, -260, 200]];
      for (const [col, x, y, z, s] of neb) {
        const c = new THREE.Color(col);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: makeGlowTexture([[0, `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},0.28)`], [0.5, `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},0.08)`], [1, 'rgba(0,0,0,0)']]),
          blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
        }));
        sp.position.set(x, y, z);
        sp.scale.setScalar(s);
        g.add(sp);
      }
      break;
    }
  }
  g.traverse((o) => { o.frustumCulled = false; o.renderOrder = -10; });
  return { group: g, spinners };
}

function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const k in m) {
        const v = m[k];
        if (v && v.isTexture) v.dispose();
      }
      if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k].value; if (v && v.isTexture) v.dispose(); }
      m.dispose();
    }
  });
}

export function createEnvironment(scene) {
  const SUN_DIR = new THREE.Vector3(0.55, 0.62, 0.35).normalize();

  // 跟著相機走的天空根節點
  const skyRoot = new THREE.Group();
  skyRoot.name = 'sky-root';
  scene.add(skyRoot);

  // --- 星空 ---
  const N = 2500, D = 400;
  const sp = new Float32Array(N * 3), sc = new Float32Array(N * 3);
  const rng = mulberry32(12345);
  const palette = [0xffffff, 0xffffff, 0xffffff, 0xcfe0ff, 0xfff0c8, 0xffc8e8, 0xa8f0ff, 0xffd090];
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const u = rng() * 2 - 1, th = rng() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    sp[i * 3] = s * Math.cos(th) * D; sp[i * 3 + 1] = u * D; sp[i * 3 + 2] = s * Math.sin(th) * D;
    c.setHex(palette[Math.floor(rng() * palette.length)]).multiplyScalar(0.45 + rng() * 0.55);
    sc[i * 3] = c.r; sc[i * 3 + 1] = c.g; sc[i * 3 + 2] = c.b;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  const starMat = new THREE.PointsMaterial({
    size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 1,
    depthWrite: false, fog: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -20;
  skyRoot.add(stars);

  // 少量大顆亮星
  const M = 120;
  const bp = new Float32Array(M * 3), bc = new Float32Array(M * 3);
  for (let i = 0; i < M; i++) {
    const u = rng() * 2 - 1, th = rng() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    bp[i * 3] = s * Math.cos(th) * D; bp[i * 3 + 1] = u * D; bp[i * 3 + 2] = s * Math.sin(th) * D;
    c.setHex(palette[Math.floor(rng() * palette.length)]);
    bc[i * 3] = c.r; bc[i * 3 + 1] = c.g; bc[i * 3 + 2] = c.b;
  }
  const bigGeo = new THREE.BufferGeometry();
  bigGeo.setAttribute('position', new THREE.BufferAttribute(bp, 3));
  bigGeo.setAttribute('color', new THREE.BufferAttribute(bc, 3));
  const bigMat = new THREE.PointsMaterial({
    size: 3.5, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, fog: false,
  });
  const bigStars = new THREE.Points(bigGeo, bigMat);
  bigStars.frustumCulled = false;
  bigStars.renderOrder = -20;
  skyRoot.add(bigStars);

  // --- 太陽 ---
  const sunTex = makeGlowTexture([
    [0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,255,255,0.75)'],
    [0.45, 'rgba(255,255,255,0.18)'], [1, 'rgba(255,255,255,0)'],
  ]);
  const sunMat = new THREE.SpriteMaterial({
    map: sunTex, color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false,
  });
  const sun = new THREE.Sprite(sunMat);
  sun.position.copy(SUN_DIR).multiplyScalar(350);
  sun.scale.setScalar(110);
  sun.frustumCulled = false;
  sun.renderOrder = -15;
  skyRoot.add(sun);

  // --- 大氣光暈 ---
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(0x88ccff) },
      radius: { value: 8 },
      thick: { value: 1.2 },
      intensity: { value: 1.0 },
      sunDir: { value: SUN_DIR.clone() },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld; varying vec3 vNormalV; varying vec3 vViewPos; varying vec3 vCenter;
      void main(){
        vCenter = (modelMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vViewPos = mv.xyz;
        vNormalV = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 color; uniform float radius; uniform float thick; uniform float intensity; uniform vec3 sunDir;
      varying vec3 vWorld; varying vec3 vNormalV; varying vec3 vViewPos; varying vec3 vCenter;
      void main(){
        vec3 center = vCenter;
        vec3 rd = normalize(vWorld - cameraPosition);
        // 視線與星球中心的最近距離（相機在大氣內也能正確淡出）
        float t = max(dot(center - cameraPosition, rd), 0.0);
        float d = length(cameraPosition + rd * t - center);
        float x = clamp((d - radius) / thick, 0.0, 1.0);
        float g = 1.0 - smoothstep(0.0, 1.0, x);
        g = g * g;
        // 背面法線與視線：外緣≈0、星球輪廓≈0.5
        float vd = abs(dot(normalize(-vViewPos), vNormalV));
        g *= smoothstep(0.0, 0.5, vd) * 0.6 + 0.4;
        // 向陽面稍亮
        vec3 n = normalize(cameraPosition + rd * t - center);
        float lit = 0.55 + 0.45 * max(dot(n, sunDir), 0.0);
        gl_FragColor = vec4(color * g * lit * intensity, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false,
  });
  let atmo = null;

  let decor = null, spinners = [];
  let current = null;

  function luminance(hexColor) {
    const col = new THREE.Color(hexColor);
    return 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
  }

  return {
    sunDir: SUN_DIR,
    setLevel(def) {
      current = def;
      const C = def.colors;
      scene.background = new THREE.Color(C.sky);

      // 亮天空時星星淡一些
      const L = luminance(C.sky);
      starMat.opacity = THREE.MathUtils.clamp(1.0 - L * 2.2, 0.15, 1);
      bigMat.opacity = THREE.MathUtils.clamp(1.0 - L * 1.6, 0.3, 1);

      sunMat.color.setHex(C.sun);

      // 遠方天體
      if (decor) { skyRoot.remove(decor); disposeObject(decor); decor = null; }
      const built = buildDecor(def, SUN_DIR);
      decor = built.group; spinners = built.spinners;
      skyRoot.add(decor);

      // 大氣光暈
      if (atmo) { scene.remove(atmo); atmo.geometry.dispose(); }
      const R = def.radius;
      atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.15, 64, 40), atmoMat);
      atmo.name = 'atmosphere';
      atmo.renderOrder = 5;
      atmoMat.uniforms.color.value.setHex(C.atmo);
      atmoMat.uniforms.radius.value = R;
      atmoMat.uniforms.thick.value = R * 0.15;
      atmoMat.uniforms.intensity.value = def.id === 6 ? 0.75 : 0.8;
      scene.add(atmo);
    },
    update(dt, t, camera) {
      if (camera) skyRoot.position.copy(camera.position);
      for (const s of spinners) s.obj.rotation.y += s.spin * dt;
      stars.rotation.y = t * 0.002;
      bigStars.rotation.y = t * 0.002;
    },
  };
}
