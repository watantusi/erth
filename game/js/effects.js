// 分身 5：粒子特效。一個 THREE.Points（粒子）+ 一個 InstancedMesh（光環），共 2 個 draw call。
import * as THREE from 'three';

const MAX_PARTICLES = 400;
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
  let cursor = 0;
  let alive = 0;

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  const sizeAttr = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
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
      attribute vec3 color;
      uniform float uScale;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aAlpha > 0.001 ? aSize * uScale / max(0.1, -mv.z) : 0.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
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
    }
    colAttr.needsUpdate = true;
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
    }
    colAttr.needsUpdate = true;
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
        const drag = Math.exp(-DRAG * dt);
        vel[i3] = (vel[i3] - px * g) * drag;
        vel[i3 + 1] = (vel[i3 + 1] - py * g) * drag;
        vel[i3 + 2] = (vel[i3 + 2] - pz * g) * drag;
        pos[i3] = px + vel[i3] * dt;
        pos[i3 + 1] = py + vel[i3 + 1] * dt;
        pos[i3 + 2] = pz + vel[i3 + 2] * dt;
        const t = 1 - life[i] / maxLife[i]; // 0 → 1
        // 先快速長大一點，再縮小
        const grow = t < 0.12 ? 0.6 + t / 0.12 * 0.4 : 1 - (t - 0.12) / 0.88 * 0.75;
        size[i] = baseSize[i] * grow;
        alpha[i] = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      }
      posAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
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

  return { burst, ring, sparkleTrail, update };
}
