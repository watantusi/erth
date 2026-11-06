// 分身 5：粒子特效。一個 THREE.Points（粒子）+ 一個 InstancedMesh（光環），共 2 個 draw call。
// v3：腳印特效 trail(position, up, kind)：葉子／星光／泡泡／雪花，和爆發粒子共用同一個 Points（不增加 draw call），
//     形狀在 fragment shader 裡依 aKind 畫出；全部預先配置，執行時不配置新物件。
import * as THREE from 'three';

const MAX_PARTICLES = 560;
// 粒子種類（aKind）
const K_SPARK = 0, K_LEAF = 1, K_STAR = 2, K_BUBBLE = 3, K_SNOW = 4;
const TRAIL_KINDS = { leaf: K_LEAF, star: K_STAR, bubble: K_BUBBLE, snow: K_SNOW };
const LEAF_COLORS = [0x6cc24a, 0x8fd16a, 0x4f9e5a, 0xf2a23a, 0xe9773b, 0xf7d046];
const STAR_COLORS = [0xffe27a, 0xfff6c8, 0xffc94d, 0xbfe8ff];
const MAX_RINGS = 8;
const GRAVITY = 9;       // 往星球中心的加速度
const DRAG = 1.6;
const RING_LIFE = 0.7;

export function createEffects(scene) {
  // ---------------- 粒子 ----------------
  const pos = new Float32Array(MAX_PARTICLES * 3);
  const col = new Float32Array(MAX_PARTICLES * 3);
  const size = new Float32Array(MAX_PARTICLES);
  const alpha = new Float32Array(MAX_PARTICLES);
  const vel = new Float32Array(MAX_PARTICLES * 3);
  const life = new Float32Array(MAX_PARTICLES);    // 剩餘壽命
  const maxLife = new Float32Array(MAX_PARTICLES);
  const baseSize = new Float32Array(MAX_PARTICLES);
  const grav = new Float32Array(MAX_PARTICLES);    // 重力倍率（拖尾粒子會輕輕往上飄）
  const kind = new Float32Array(MAX_PARTICLES);    // 形狀（aKind）
  const rot = new Float32Array(MAX_PARTICLES);     // 旋轉角（aRot）
  const spin = new Float32Array(MAX_PARTICLES);    // 旋轉速度
  const sway = new Float32Array(MAX_PARTICLES * 3);// 左右飄動的方向 × 幅度
  const phase = new Float32Array(MAX_PARTICLES);   // 飄動 / 閃爍的相位
  let cursor = 0;
  let alive = 0;

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  const sizeAttr = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
  const kindAttr = new THREE.BufferAttribute(kind, 1).setUsage(THREE.DynamicDrawUsage);
  const rotAttr = new THREE.BufferAttribute(rot, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aKind', kindAttr);
  geo.setAttribute('aRot', rotAttr);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', colAttr);
  geo.setAttribute('aSize', sizeAttr);
  geo.setAttribute('aAlpha', alphaAttr);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const pointUniforms = { uScale: { value: 400 } };
  const pointMat = new THREE.ShaderMaterial({
    uniforms: pointUniforms,
    vertexShader: /* glsl */`
      attribute float aSize;
      attribute float aAlpha;
      attribute float aKind;
      attribute float aRot;
      attribute vec3 color;
      uniform float uScale;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vKind;
      varying vec2 vRot;
      void main() {
        vColor = color;
        vAlpha = aAlpha;
        vKind = aKind;
        vRot = vec2(cos(aRot), sin(aRot));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aAlpha > 0.001 ? aSize * uScale / max(0.1, -mv.z) : 0.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vAlpha;
      varying float vKind;
      varying vec2 vRot;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        if (vKind > 0.5) {
          vec2 p = vec2(vRot.x * c.x - vRot.y * c.y, vRot.y * c.x + vRot.x * c.y);
          vec3 rgb = vColor;
          float a = 0.0;
          if (vKind < 1.5) {
            // 葉子：兩個圓相交的橄欖形 + 中間的葉脈
            float l1 = length(p - vec2(0.27, 0.0));
            float l2 = length(p + vec2(0.27, 0.0));
            float leaf = smoothstep(0.47, 0.43, max(l1, l2));
            float vein = smoothstep(0.03, 0.0, abs(p.x)) * step(abs(p.y), 0.36);
            float shade = 0.82 + 0.3 * smoothstep(-0.2, 0.2, p.x);
            rgb = mix(vColor * shade, vColor * 0.55, vein * 0.8);
            a = leaf;
          } else if (vKind < 2.5) {
            // 星光：五角星 + 柔光
            float ang = atan(p.y, p.x);
            float r = length(p);
            float k = cos(floor(0.5 + ang / 1.2566) * 1.2566 - ang);
            float star = smoothstep(0.03, -0.01, r * k - (0.17 + 0.2 * pow(abs(cos(ang * 2.5)), 6.0)));
            float glow = smoothstep(0.5, 0.0, r) * 0.45;
            rgb = mix(vColor, vec3(1.0), smoothstep(0.16, 0.0, r) * 0.8);
            a = max(star, glow);
          } else if (vKind < 3.5) {
            // 泡泡：亮邊 + 透明中心 + 左上反光
            float ring = smoothstep(0.5, 0.44, d) * smoothstep(0.3, 0.43, d);
            float hi = smoothstep(0.12, 0.0, length(c - vec2(-0.16, -0.16)));
            rgb = mix(vColor, vec3(1.0), 0.35 + hi * 0.65);
            a = clamp(ring * 0.85 + smoothstep(0.5, 0.42, d) * 0.14 + hi, 0.0, 1.0);
          } else {
            // 雪花：六條枝
            float ang = atan(p.y, p.x);
            float r = length(p);
            float sec = mod(ang + 0.5236, 1.0472) - 0.5236;
            vec2 q = vec2(cos(sec), sin(sec)) * r;
            float arm = smoothstep(0.05, 0.02, abs(q.y)) * step(q.x, 0.44);
            vec2 b = vec2(q.x - 0.26, abs(q.y));
            float branch = smoothstep(0.045, 0.015, abs(b.y - b.x * 0.9)) * step(b.x, 0.12) * step(0.0, b.x);
            float core = smoothstep(0.1, 0.06, r);
            rgb = mix(vColor, vec3(1.0), 0.5);
            a = clamp(arm + branch + core, 0.0, 1.0) * smoothstep(0.5, 0.42, r);
          }
          if (a < 0.02) discard;
          gl_FragColor = vec4(rgb, a * vAlpha);
          return;
        }
        // 圓點 + 四芒星閃光，中心偏白，在明亮場景上也清楚
        float disc = smoothstep(0.5, 0.32, d);
        float star = max(0.0, 1.0 - abs(c.x) * 14.0) * smoothstep(0.5, 0.0, abs(c.y))
                   + max(0.0, 1.0 - abs(c.y) * 14.0) * smoothstep(0.5, 0.0, abs(c.x));
        float core = smoothstep(0.22, 0.0, d);
        vec3 rgb = mix(vColor, vec3(1.0), core * 0.65 + star * 0.35);
        float a = clamp(disc * 0.9 + star * 0.6, 0.0, 1.0) * vAlpha;
        gl_FragColor = vec4(rgb, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });

  const points = new THREE.Points(geo, pointMat);
  points.frustumCulled = false;
  points.renderOrder = 20;
  const _buf = new THREE.Vector2();
  points.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(_buf);
    pointUniforms.uScale.value = _buf.y * 0.5;
  };
  scene.add(points);

  // ---------------- 光環 ----------------
  const ringGeo = new THREE.RingGeometry(0.82, 1, 48, 1);
  const ringAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS), 1);
  ringAlpha.setUsage(THREE.DynamicDrawUsage);
  ringGeo.setAttribute('aAlpha', ringAlpha);
  const ringMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      attribute float aAlpha;
      varying float vAlpha;
      varying vec3 vColor;
      varying float vR;
      void main() {
        vAlpha = aAlpha;
        vColor = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #endif
        vR = length(position.xy);
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * p;
      }`,
    fragmentShader: /* glsl */`
      varying float vAlpha;
      varying vec3 vColor;
      varying float vR;
      void main() {
        float edge = 1.0 - abs(vR - 0.91) / 0.09; // 0..1，中間最亮
        vec3 rgb = mix(vColor, vec3(1.0), 0.35 * edge);
        gl_FragColor = vec4(rgb, vAlpha * smoothstep(0.0, 0.6, edge));
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, MAX_RINGS);
  rings.frustumCulled = false;
  rings.renderOrder = 19;
  rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const ringState = [];
  const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX_RINGS; i++) {
    rings.setMatrixAt(i, _zero);
    rings.setColorAt(i, new THREE.Color(1, 1, 1));
    ringState.push({
      t: -1,
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      color: new THREE.Color(),
    });
  }
  rings.instanceColor.setUsage(THREE.DynamicDrawUsage);
  let ringCursor = 0;
  let ringsAlive = 0;
  scene.add(rings);

  // ---------------- 暫存 ----------------
  const _c = new THREE.Color();
  const _base = new THREE.Color();
  const _up = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _s = new THREE.Vector3();
  const _Z = new THREE.Vector3(0, 0, 1);
  const _t1 = new THREE.Vector3();
  const _t2 = new THREE.Vector3();
  let clock = 0;
  const _hsl = { h: 0, s: 0, l: 0 };

  function setColor(target, color) {
    if (color === undefined || color === null) target.set(0xffffff);
    else if (color.isColor) target.copy(color);
    else target.set(color);
  }

  function burst(position, color = 0xffffff, count = 24) {
    if (!position) return;
    setColor(_base, color);
    _base.getHSL(_hsl);
    _up.copy(position);
    if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0);
    _up.normalize();
    const n = Math.max(1, Math.min(MAX_PARTICLES, count | 0));
    for (let k = 0; k < n; k++) {
      const i = cursor;
      cursor = (cursor + 1) % MAX_PARTICLES;
      if (life[i] <= 0) alive++;
      const i3 = i * 3;
      // 隨機方向，偏向地表法線
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      _v.set(s * Math.cos(th), u, s * Math.sin(th));
      _v.addScaledVector(_up, 0.9 + Math.random() * 0.7).normalize();
      const speed = 3 + Math.random() * 4.5;
      vel[i3] = _v.x * speed; vel[i3 + 1] = _v.y * speed; vel[i3 + 2] = _v.z * speed;
      pos[i3] = position.x + _up.x * 0.2;
      pos[i3 + 1] = position.y + _up.y * 0.2;
      pos[i3 + 2] = position.z + _up.z * 0.2;
      const r = Math.random();
      if (r < 0.18) {
        _c.setRGB(1, 1, 1);
      } else {
        _c.setHSL(
          (_hsl.h + (Math.random() - 0.5) * 0.08 + 1) % 1,
          Math.min(1, _hsl.s * (0.85 + Math.random() * 0.3)),
          Math.min(0.92, Math.max(0.25, _hsl.l + (Math.random() - 0.4) * 0.2)),
        );
      }
      col[i3] = _c.r; col[i3 + 1] = _c.g; col[i3 + 2] = _c.b;
      const L = 0.8 + Math.random() * 0.4;
      life[i] = L;
      maxLife[i] = L;
      baseSize[i] = 0.4 + Math.random() * 0.35;
      size[i] = baseSize[i];
      alpha[i] = 1;
      grav[i] = 1;
      kind[i] = K_SPARK;
      spin[i] = 0;
    }
    colAttr.needsUpdate = true;
    kindAttr.needsUpdate = true;
  }

  /** 輕量的閃光拖尾：每次呼叫只放幾顆小粒子（可每幀呼叫，例如彈跳或跟隨物品） */
  function sparkleTrail(position, color = 0xffffff, count = 2) {
    if (!position) return;
    setColor(_base, color);
    _up.copy(position);
    if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0);
    _up.normalize();
    const n = Math.max(1, Math.min(8, count | 0));
    for (let k = 0; k < n; k++) {
      const i = cursor;
      cursor = (cursor + 1) % MAX_PARTICLES;
      if (life[i] <= 0) alive++;
      const i3 = i * 3;
      const sp = 0.6;
      vel[i3] = (Math.random() - 0.5) * sp + _up.x * 0.8;
      vel[i3 + 1] = (Math.random() - 0.5) * sp + _up.y * 0.8;
      vel[i3 + 2] = (Math.random() - 0.5) * sp + _up.z * 0.8;
      pos[i3] = position.x + (Math.random() - 0.5) * 0.3;
      pos[i3 + 1] = position.y + (Math.random() - 0.5) * 0.3;
      pos[i3 + 2] = position.z + (Math.random() - 0.5) * 0.3;
      if (Math.random() < 0.35) _c.setRGB(1, 1, 1); else _c.copy(_base);
      col[i3] = _c.r; col[i3 + 1] = _c.g; col[i3 + 2] = _c.b;
      const L = 0.45 + Math.random() * 0.35;
      life[i] = L;
      maxLife[i] = L;
      baseSize[i] = 0.16 + Math.random() * 0.16;
      size[i] = baseSize[i];
      alpha[i] = 1;
      grav[i] = -0.15;
      kind[i] = K_SPARK;
      spin[i] = 0;
    }
    colAttr.needsUpdate = true;
    kindAttr.needsUpdate = true;
  }

  /** v3：腳印特效。每次呼叫放幾顆粒子（約每一步呼叫一次）。kind: 'leaf' | 'star' | 'bubble' | 'snow' */
  function trail(position, up, kindName = 'star') {
    if (!position) return;
    const K = TRAIL_KINDS[kindName];
    if (!K) return;
    _up.copy(up && up.lengthSq() > 1e-8 ? up : position);
    if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0);
    _up.normalize();
    // 切平面基底（不配置新物件）
    _t1.set(Math.abs(_up.y) < 0.95 ? 0 : 1, Math.abs(_up.y) < 0.95 ? 1 : 0, 0).cross(_up).normalize();
    _t2.crossVectors(_up, _t1);
    const n = K === K_STAR ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const i = cursor;
      cursor = (cursor + 1) % MAX_PARTICLES;
      if (life[i] <= 0) alive++;
      const i3 = i * 3;
      const a = Math.random() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // 切平面上的隨機方向
      _v.copy(_t1).multiplyScalar(ca).addScaledVector(_t2, sa);
      let spread = 0.3, lift = 0.25, vUp = 0, vSide = 0, L = 1, sz = 0.25, g = 0, sw = 0, sp = 0;
      if (K === K_LEAF) {
        spread = 0.3; lift = 0.3 + Math.random() * 0.25; vUp = 1.3 + Math.random() * 0.8; vSide = 0.6 + Math.random() * 0.6;
        L = 1.3 + Math.random() * 0.5; sz = 0.34 + Math.random() * 0.12; g = 0.32; sw = 0.9; sp = (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 3);
        _c.setHex(LEAF_COLORS[(Math.random() * LEAF_COLORS.length) | 0]);
      } else if (K === K_STAR) {
        spread = 0.38; lift = 0.1 + Math.random() * 0.6; vUp = 0.25 + Math.random() * 0.4; vSide = 0.15;
        L = 0.7 + Math.random() * 0.45; sz = 0.28 + Math.random() * 0.16; g = -0.04; sw = 0; sp = (Math.random() - 0.5) * 2;
        _c.setHex(STAR_COLORS[(Math.random() * STAR_COLORS.length) | 0]);
      } else if (K === K_BUBBLE) {
        spread = 0.32; lift = 0.15 + Math.random() * 0.2; vUp = 0.9 + Math.random() * 0.7; vSide = 0.2;
        L = 1.1 + Math.random() * 0.5; sz = 0.17 + Math.random() * 0.18; g = -0.18; sw = 0.45; sp = 0;
        _c.setHSL(0.53 + Math.random() * 0.05, 0.75, 0.78);
      } else {
        spread = 0.45; lift = 0.6 + Math.random() * 0.45; vUp = 0.25 + Math.random() * 0.25; vSide = 0.25;
        L = 1.4 + Math.random() * 0.5; sz = 0.24 + Math.random() * 0.1; g = 0.11; sw = 0.6; sp = (Math.random() - 0.5) * 2.4;
        _c.setRGB(0.93, 0.97, 1);
      }
      const off = (0.35 + Math.random() * 0.65) * spread;
      pos[i3] = position.x + _v.x * off + _up.x * lift;
      pos[i3 + 1] = position.y + _v.y * off + _up.y * lift;
      pos[i3 + 2] = position.z + _v.z * off + _up.z * lift;
      vel[i3] = _up.x * vUp + _v.x * vSide;
      vel[i3 + 1] = _up.y * vUp + _v.y * vSide;
      vel[i3 + 2] = _up.z * vUp + _v.z * vSide;
      // 飄動方向：與散開方向垂直的切線
      sway[i3] = (_t1.x * -sa + _t2.x * ca) * sw;
      sway[i3 + 1] = (_t1.y * -sa + _t2.y * ca) * sw;
      sway[i3 + 2] = (_t1.z * -sa + _t2.z * ca) * sw;
      col[i3] = _c.r; col[i3 + 1] = _c.g; col[i3 + 2] = _c.b;
      life[i] = L;
      maxLife[i] = L;
      baseSize[i] = sz;
      size[i] = sz * 0.6;
      alpha[i] = 1;
      grav[i] = g;
      kind[i] = K;
      rot[i] = Math.random() * Math.PI * 2;
      spin[i] = sp;
      phase[i] = Math.random() * Math.PI * 2;
    }
    colAttr.needsUpdate = true;
    kindAttr.needsUpdate = true;
  }

  function ring(position, up, color = 0xffffff) {
    if (!position) return;
    const st = ringState[ringCursor];
    const idx = ringCursor;
    ringCursor = (ringCursor + 1) % MAX_RINGS;
    if (st.t < 0) ringsAlive++;
    st.t = 0;
    _up.copy(up && up.lengthSq() > 1e-8 ? up : position);
    if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0);
    _up.normalize();
    st.quat.setFromUnitVectors(_Z, _up);
    st.pos.copy(position).addScaledVector(_up, 0.1);
    setColor(st.color, color);
    rings.setColorAt(idx, st.color);
    rings.instanceColor.needsUpdate = true;
  }

  function update(dt) {
    clock += dt;
    if (alive > 0) {
      for (let i = 0; i < MAX_PARTICLES; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        const i3 = i * 3;
        if (life[i] <= 0) {
          life[i] = 0;
          alpha[i] = 0;
          size[i] = 0;
          alive--;
          continue;
        }
        const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
        const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
        const g = GRAVITY * grav[i] * dt / len;
        const K = kind[i];
        const drag = Math.exp(-(K === K_SPARK ? DRAG : 2.6) * dt);
        vel[i3] = (vel[i3] - px * g) * drag;
        vel[i3 + 1] = (vel[i3 + 1] - py * g) * drag;
        vel[i3 + 2] = (vel[i3 + 2] - pz * g) * drag;
        let sx = 0, sy = 0, sz = 0;
        if (K === K_LEAF || K === K_SNOW || K === K_BUBBLE) {
          // 左右飄（速度 = 振幅 × cos）
          const w = K === K_LEAF ? 4.2 : K === K_SNOW ? 2.4 : 5.5;
          const f = Math.cos(phase[i] + clock * w) * dt * w * 0.5;
          sx = sway[i3] * f; sy = sway[i3 + 1] * f; sz = sway[i3 + 2] * f;
        }
        pos[i3] = px + vel[i3] * dt + sx;
        pos[i3 + 1] = py + vel[i3 + 1] * dt + sy;
        pos[i3 + 2] = pz + vel[i3 + 2] * dt + sz;
        const t = 1 - life[i] / maxLife[i]; // 0 → 1
        if (K === K_SPARK) {
          // 先快速長大一點，再縮小
          const grow = t < 0.12 ? 0.6 + t / 0.12 * 0.4 : 1 - (t - 0.12) / 0.88 * 0.75;
          size[i] = baseSize[i] * grow;
          alpha[i] = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
        } else {
          if (spin[i] !== 0) {
            // 葉子翻轉：旋轉加上隨飄動的擺盪
            rot[i] += spin[i] * dt * (K === K_LEAF ? 0.6 + 0.4 * Math.sin(phase[i] + clock * 4.2) : 1);
          }
          const pop = t < 0.15 ? 0.6 + (t / 0.15) * 0.4 : 1;
          if (K === K_STAR) {
            const tw = 0.55 + 0.45 * Math.abs(Math.sin(phase[i] + clock * 13));
            size[i] = baseSize[i] * pop * tw * (1 - t * 0.4);
            alpha[i] = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
          } else if (K === K_BUBBLE) {
            size[i] = baseSize[i] * pop * (1 + t * 0.35);
            alpha[i] = t < 0.85 ? 0.95 : 0.95 * (1 - (t - 0.85) / 0.15);
          } else {
            size[i] = baseSize[i] * pop;
            alpha[i] = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
          }
        }
      }
      posAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
      rotAttr.needsUpdate = true;
    }

    if (ringsAlive > 0) {
      const a = ringAlpha.array;
      for (let i = 0; i < MAX_RINGS; i++) {
        const st = ringState[i];
        if (st.t < 0) continue;
        st.t += dt;
        const k = st.t / RING_LIFE;
        if (k >= 1) {
          st.t = -1;
          ringsAlive--;
          a[i] = 0;
          rings.setMatrixAt(i, _zero);
          continue;
        }
        const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
        const sc = 0.35 + e * 2.6;
        _s.set(sc, sc, sc);
        _m.compose(st.pos, st.quat, _s);
        rings.setMatrixAt(i, _m);
        a[i] = 0.9 * (1 - k) * (1 - k * 0.3);
      }
      rings.instanceMatrix.needsUpdate = true;
      ringAlpha.needsUpdate = true;
    }
  }

  return { burst, ring, sparkleTrail, trail, update };
}
