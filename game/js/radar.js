// 雷達小地圖（分身 3，v2）：右上角的圓形小地圖，以玩家為中心、鏡頭朝向為上（沒有固定北方）。
// 合約：createRadar({ root }) → { update(nav, player, camera), setVisible(bool) }
//  - nav.radar：Array<{ position: Vector3, kind }> | null（null → 隱藏）
//  - kind: 'crystal' | 'seed' | 'plot' | 'npc' | 'quest'
// 投影：點的方向投影到玩家切平面得到方位，距離用球面弧長（RADAR_RANGE 對應到半徑），
// 超出範圍的點貼在外圈畫成小箭頭。2D canvas 繪製，最多約 20 fps，不在每幀配置物件。
import * as THREE from 'three';
import { RADAR_RANGE, PLANET_RADIUS } from './config.js';

const FRAME_MS = 1000 / 20;   // 最多 20 fps
const RIM_PAD = 9;            // 外圈箭頭離邊緣的距離（CSS px）
const ICON = 1.15;            // 圖示整體縮放（依尺寸再調整）

const COLORS = {
  crystal: '#3fd6f0',
  crystalEdge: '#0f8fb0',
  seed: '#5cc94a',
  seedEdge: '#2f8a2a',
  plot: '#9a6a3c',
  npc: '#ffffff',
  npcEdge: '#5d6a85',
  quest: '#ffc93c',
  questEdge: '#d18a00',
  player: '#ff8a5c',
  playerEdge: '#ffffff',
  ring: 'rgba(59, 120, 190, 0.18)',
  tick: 'rgba(59, 120, 190, 0.22)',
};
// 畫的順序（後畫的在上面）
const KIND_ORDER = { plot: 0, seed: 1, npc: 2, crystal: 3, quest: 4 };

export function createRadar({ root } = {}) {
  const host = root || document.body;
  const el = document.createElement('div');
  el.className = 'tew-radar';
  el.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  el.appendChild(canvas);
  host.appendChild(el);
  const ctx = canvas.getContext('2d');

  let visibleWanted = true;  // setVisible
  let shown = false;         // 目前 DOM 狀態
  let cssSize = 0;
  let dpr = 1;
  let lastDraw = -1e9;
  let sizeDirty = true;
  let fovGrad = null;        // 視野扇形漸層（尺寸改變時才重建）

  // 暫存
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const v = new THREE.Vector3();

  // 每個點的投影結果（重複利用的平行陣列）
  let cap = 0;
  let px = new Float32Array(0), py = new Float32Array(0), pOut = new Uint8Array(0), pKind = new Uint8Array(0);
  let order = new Uint16Array(0);
  const KINDS = ['plot', 'seed', 'npc', 'crystal', 'quest'];
  function kindIndex(k) {
    const i = KIND_ORDER[k];
    return i === undefined ? 2 : i;
  }
  function ensureCap(n) {
    if (n <= cap) return;
    cap = Math.max(16, n * 2);
    px = new Float32Array(cap); py = new Float32Array(cap);
    pOut = new Uint8Array(cap); pKind = new Uint8Array(cap);
    order = new Uint16Array(cap);
  }

  function setShown(on) {
    if (on === shown) return;
    shown = on;
    el.classList.toggle('is-visible', on);
    if (on) { sizeDirty = true; lastDraw = -1e9; }
  }

  function measure() {
    const r = el.clientWidth || 0;
    const d = Math.min(2, window.devicePixelRatio || 1);
    if (r !== cssSize || d !== dpr || sizeDirty) {
      cssSize = r;
      dpr = d;
      const px2 = Math.max(1, Math.round(r * d));
      if (canvas.width !== px2) canvas.width = px2;
      if (canvas.height !== px2) canvas.height = px2;
      sizeDirty = false;
      fovGrad = null;
    }
  }
  const onResize = () => { sizeDirty = true; };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  /**
   * 建立玩家切平面上的基底：up = 玩家法線；fwd = 鏡頭前方投影（往下看時改用鏡頭的上）；right = fwd × up
   * 回傳 false 表示資料不足
   */
  function buildBasis(player, camera) {
    const pu = player.up;
    if (pu && pu.lengthSq() > 1e-8) up.copy(pu).normalize();
    else if (player.position && player.position.lengthSq() > 1e-8) up.copy(player.position).normalize();
    else return false;
    const m = camera.matrixWorld.elements;
    // 鏡頭前方 = -Z 欄
    fwd.set(-m[8], -m[9], -m[10]);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-4) {
      // 幾乎垂直往下看：用鏡頭的上（+Y 欄）當前方
      fwd.set(m[4], m[5], m[6]);
      fwd.addScaledVector(up, -fwd.dot(up));
      if (fwd.lengthSq() < 1e-8) return false;
    }
    fwd.normalize();
    right.crossVectors(fwd, up).normalize();
    return true;
  }

  /** 把 nav.radar 投影到 px/py（相對中心，單位 = 半徑比例，向上為 -y） */
  function project(list, player, n, rInner) {
    const pr = player.position.length() || PLANET_RADIUS;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const it = list[i];
      const p = it && it.position;
      if (!p) continue;
      const len = p.length();
      if (!(len > 1e-6)) continue;
      v.copy(p).divideScalar(len);
      const c = v.dot(up);
      const ang = Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
      // 弧長距離（用玩家所在半徑）；非常近的點用直線距離避免方向不穩
      let dist = ang * pr;
      v.addScaledVector(up, -c);
      let x = v.dot(right), y = v.dot(fwd);
      let l = Math.hypot(x, y);
      if (dist < 0.05) {
        // 幾乎就在腳下：用切平面上的直線差
        v.copy(p).sub(player.position);
        x = v.dot(right); y = v.dot(fwd);
        l = Math.hypot(x, y);
        dist = l;
      }
      if (l < 1e-6) { x = 0; y = -1; l = 1; } // 正下方或對蹠點：方向不定，畫在下方
      const k = dist / RADAR_RANGE;
      const out = k > 1;
      const s = (out ? 1 : k) * rInner / l;
      px[count] = x * s;
      py[count] = -y * s;
      pOut[count] = out ? 1 : 0;
      pKind[count] = kindIndex(it.kind);
      order[count] = count;
      count++;
    }
    // 依種類排序（插入排序，點很少）
    for (let i = 1; i < count; i++) {
      const o = order[i];
      const ko = pKind[o] * 2 + (pOut[o] ? 0 : 1);
      let j = i - 1;
      while (j >= 0 && pKind[order[j]] * 2 + (pOut[order[j]] ? 0 : 1) > ko) { order[j + 1] = order[j]; j--; }
      order[j + 1] = o;
    }
    return count;
  }

  // ---- 圖示 ----
  function diamond(x, y, s, fill, edge) {
    ctx.beginPath();
    ctx.moveTo(x, y - s * 1.25);
    ctx.lineTo(x + s * 0.85, y);
    ctx.lineTo(x, y + s * 1.25);
    ctx.lineTo(x - s * 0.85, y);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = edge; ctx.stroke();
    // 高光
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.95);
    ctx.lineTo(x + s * 0.35, y - s * 0.1);
    ctx.lineTo(x, y + s * 0.15);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
  }
  function dot(x, y, r, fill, edge) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
    if (edge) { ctx.lineWidth = 1.2; ctx.strokeStyle = edge; ctx.stroke(); }
  }
  function ring(x, y, r, color) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  }
  function robot(x, y, s) {
    // 小天線
    ctx.beginPath();
    ctx.moveTo(x, y - s * 1.0); ctx.lineTo(x, y - s * 1.55);
    ctx.lineWidth = 1.2; ctx.strokeStyle = COLORS.npcEdge; ctx.stroke();
    dot(x, y - s * 1.65, s * 0.28, COLORS.quest, null);
    dot(x, y, s, COLORS.npc, COLORS.npcEdge);
    // 眼睛
    ctx.fillStyle = '#2f3b52';
    ctx.fillRect(x - s * 0.5, y - s * 0.22, s * 0.28, s * 0.38);
    ctx.fillRect(x + s * 0.22, y - s * 0.22, s * 0.28, s * 0.38);
  }
  function star(x, y, rOut, fill, edge) {
    const rIn = rOut * 0.46;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i & 1 ? rIn : rOut;
      if (i === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = edge; ctx.stroke();
  }
  function chevron(x, y, ux, uy, s, color) {
    // ux,uy：朝外的單位向量
    const tx = -uy, ty = ux;
    ctx.beginPath();
    ctx.moveTo(x + ux * s, y + uy * s);
    ctx.lineTo(x - ux * s * 0.6 + tx * s * 0.9, y - uy * s * 0.6 + ty * s * 0.9);
    ctx.lineTo(x - ux * s * 0.15, y - uy * s * 0.15);
    ctx.lineTo(x - ux * s * 0.6 - tx * s * 0.9, y - uy * s * 0.6 - ty * s * 0.9);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke();
  }
  const KIND_RIM_COLOR = [COLORS.plot, COLORS.seedEdge, COLORS.npcEdge, COLORS.crystalEdge, COLORS.questEdge];

  function draw(count, now) {
    const S = cssSize;
    const c = S / 2;
    const unit = (S / 112) * ICON; // 圖示縮放
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);

    // 半範圍圈與十字刻度
    const rInner = c - RIM_PAD;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.ring;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(c, c, rInner * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(c, c, rInner, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.ring;
    ctx.stroke();
    ctx.strokeStyle = COLORS.tick;
    ctx.beginPath();
    ctx.moveTo(c, c - rInner * 0.5 + 3); ctx.lineTo(c, c - rInner + 4);
    ctx.moveTo(c, c + rInner * 0.5 - 3); ctx.lineTo(c, c + rInner - 4);
    ctx.moveTo(c - rInner * 0.5 + 3, c); ctx.lineTo(c - rInner + 4, c);
    ctx.moveTo(c + rInner * 0.5 - 3, c); ctx.lineTo(c + rInner - 4, c);
    ctx.stroke();

    // 視野扇形（鏡頭朝上）
    if (!fovGrad) {
      fovGrad = ctx.createRadialGradient(c, c, 0, c, c, rInner);
      fovGrad.addColorStop(0, 'rgba(255, 207, 77, 0.28)');
      fovGrad.addColorStop(1, 'rgba(255, 207, 77, 0)');
    }
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, rInner, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.closePath();
    ctx.fillStyle = fovGrad;
    ctx.fill();

    const pulse = 0.5 + 0.5 * Math.sin(now * 0.006);
    for (let n = 0; n < count; n++) {
      const i = order[n];
      const k = pKind[i];
      const x = c + px[i], y = c + py[i];
      if (pOut[i]) {
        const l = Math.hypot(px[i], py[i]) || 1;
        const ux = px[i] / l, uy = py[i] / l;
        const rr = c - RIM_PAD * 0.55;
        chevron(c + ux * rr, c + uy * rr, ux, uy, (k === 4 ? 5 : 4.2) * unit, KIND_RIM_COLOR[k]);
        continue;
      }
      switch (KINDS[k]) {
        case 'crystal': diamond(x, y, 4.4 * unit, COLORS.crystal, COLORS.crystalEdge); break;
        case 'seed': dot(x, y, 3.4 * unit, COLORS.seed, COLORS.seedEdge); break;
        case 'plot': ring(x, y, 3.8 * unit, COLORS.plot); break;
        case 'quest': {
          const r = (5.6 + pulse * 1.6) * unit;
          ctx.beginPath();
          ctx.arc(x, y, r + 3 * unit, 0, Math.PI * 2);
          ctx.globalAlpha = 0.18 + 0.22 * (1 - pulse);
          ctx.fillStyle = COLORS.quest;
          ctx.fill();
          ctx.globalAlpha = 1;
          star(x, y, r, COLORS.quest, COLORS.questEdge);
          break;
        }
        default: robot(x, y, 3.6 * unit); break;
      }
    }

    // 玩家箭頭（永遠朝上 = 鏡頭方向）
    const a = 6.2 * unit;
    ctx.beginPath();
    ctx.moveTo(c, c - a * 1.25);
    ctx.lineTo(c + a * 0.95, c + a * 0.95);
    ctx.lineTo(c, c + a * 0.45);
    ctx.lineTo(c - a * 0.95, c + a * 0.95);
    ctx.closePath();
    ctx.shadowColor = 'rgba(36, 58, 96, 0.35)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = COLORS.player;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = COLORS.playerEdge;
    ctx.stroke();
  }

  // 最近一次投影結果（測試用）
  let lastCount = 0;

  function update(nav, player, camera) {
    const list = nav && nav.radar;
    const ok = visibleWanted && !!list && !!player && !!player.position && !!camera;
    setShown(ok);
    if (!ok) return;
    const now = performance.now();
    if (now - lastDraw < FRAME_MS) return;
    lastDraw = now;
    if (sizeDirty || cssSize === 0) measure();
    if (cssSize <= 0) return;
    if (!buildBasis(player, camera)) return;
    const n = list.length >>> 0;
    ensureCap(n);
    const rInner = cssSize / 2 - RIM_PAD;
    lastCount = project(list, player, n, rInner);
    draw(lastCount, now);
  }

  function setVisible(v2) {
    visibleWanted = !!v2;
    if (!visibleWanted) setShown(false);
  }

  return {
    update,
    setVisible,
    element: el,
    /** 測試用：第 i 個投影點（相對中心的 CSS px，y 向下為正），依繪製順序之前的原始順序 */
    _debugPoint(i) {
      if (i < 0 || i >= lastCount) return null;
      return { x: px[i], y: py[i], out: !!pOut[i], kind: KINDS[pKind[i]] };
    },
    dispose() {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      el.remove();
    },
  };
}
