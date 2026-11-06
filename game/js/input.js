// 操控（分身 3）：鍵盤、滑鼠、觸控（浮動搖桿 + 跳躍鈕 + 拖曳視角 + 雙指縮放）、遊戲手把。
// 合約：createInput({ canvas, touchRoot }) → { state, isTouch, setEnabled, endFrame }
import { clamp } from './utils.js';

// ---- 可調參數 ----
const JOY_RADIUS = 52;          // 搖桿最大位移（px），輸出 1.0
const JOY_BASE_RADIUS = 64;     // 底座視覺半徑（px），用來把底座限制在螢幕內
const JOY_DEADZONE = 0.12;
const JOY_RUN = 0.9;            // 推超過此比例就跑步
const JOY_FOLLOW = 1.45;        // 手指離中心超過此倍數時底座跟著滑動
const JOY_ZONE_X = 0.45;        // 左側 45% 寬
const JOY_ZONE_TOP = 0.25;      // 上方 25% 留給 HUD
const TOUCH_LOOK_SCALE = 1.25;  // 手指拖曳視角稍微靈敏一點
const PINCH_PX = 90;            // 捏合多少 px = zoom 1
const KEY_LOOK_SPEED = 540;     // Q/E 旋轉速度（等效 px/秒）
const PAD_LOOK_SPEED = 950;     // 右搖桿（等效 px/秒）
const PAD_DEADZONE = 0.2;

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'Space', 'KeyQ', 'KeyE',
]);
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const JUMP_SVG =
  '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">' +
  '<path d="M12 4.5 4.8 12.2a1.3 1.3 0 0 0 1.9 1.8L10.7 9.8V19a1.3 1.3 0 0 0 2.6 0V9.8l4 4.2a1.3 1.3 0 0 0 1.9-1.8Z" fill="currentColor"/>' +
  '</svg>';

function mq(query) {
  try { return !!(window.matchMedia && window.matchMedia(query).matches); } catch { return false; }
}

export function createInput({ canvas, touchRoot }) {
  const state = {
    moveX: 0, moveY: 0,
    run: false,
    jumpPressed: false,
    lookX: 0, lookY: 0,
    zoom: 0,
  };

  let enabled = true;
  let isTouch = mq('(pointer: coarse)');

  // ---- DOM（觸控元件） ----
  const root = touchRoot || document.body;
  const container = document.createElement('div');
  container.className = 'tew-controls';
  container.innerHTML =
    '<div class="tew-joy idle"><div class="tew-joy-knob"></div></div>' +
    '<div class="tew-jump" role="button" aria-label="跳躍">' + JUMP_SVG + '<span class="tew-jump-label">跳</span></div>' +
    '<div class="tew-safe-probe"></div>';
  root.appendChild(container);
  const joyBase = container.querySelector('.tew-joy');
  const joyKnob = container.querySelector('.tew-joy-knob');
  const jumpBtn = container.querySelector('.tew-jump');
  const probe = container.querySelector('.tew-safe-probe');

  function applyClasses() {
    container.classList.toggle('is-touch', isTouch);
    container.classList.toggle('is-enabled', enabled);
  }
  applyClasses();

  const safe = { t: 0, r: 0, b: 0, l: 0 };
  function readSafe() {
    try {
      const cs = getComputedStyle(probe);
      safe.t = parseFloat(cs.paddingTop) || 0;
      safe.r = parseFloat(cs.paddingRight) || 0;
      safe.b = parseFloat(cs.paddingBottom) || 0;
      safe.l = parseFloat(cs.paddingLeft) || 0;
    } catch { /* 忽略 */ }
    return safe;
  }

  function setTouchMode(on) {
    if (isTouch === on) return;
    isTouch = on;
    if (!on) { endJoy(); lookPtrs.length = 0; }
    applyClasses();
  }
  // 只有在裝置確實有精準指標（滑鼠/觸控板）時，才因鍵盤滑鼠操作而隱藏觸控元件
  const hasFinePointer = () => mq('(any-pointer: fine)');

  // ---- 鍵盤 ----
  const keys = new Set();
  let kbX = 0, kbY = 0, kbLook = 0, kbRun = false;

  function computeKeys() {
    const h = (c) => (keys.has(c) ? 1 : 0);
    let x = Math.min(1, h('KeyD') + h('ArrowRight')) - Math.min(1, h('KeyA') + h('ArrowLeft'));
    let y = Math.min(1, h('KeyW') + h('ArrowUp')) - Math.min(1, h('KeyS') + h('ArrowDown'));
    if (x !== 0 && y !== 0) { x *= Math.SQRT1_2; y *= Math.SQRT1_2; }
    kbX = x; kbY = y;
    kbLook = h('KeyE') - h('KeyQ');
    kbRun = keys.has('ShiftLeft') || keys.has('ShiftRight');
  }

  const isTypingTarget = (t) => !!t && t.nodeType === 1 &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const isGameTarget = (t) => !t || t === document || t === document.body ||
    t === document.documentElement || t === canvas || (t.nodeType === 1 && container.contains(t));
  const isControl = (t) => !!t && t.nodeType === 1 &&
    (t.tagName === 'BUTTON' || t.tagName === 'A' || t.getAttribute('role') === 'button' || t.tabIndex >= 0);
  // 分辨按鈕是用鍵盤（Tab）還是滑鼠/手指聚焦的
  let lastPointerDownT = -1e9;
  let keyboardFocusEl = null;
  const onAnyPointerDown = () => { lastPointerDownT = performance.now(); };
  const onFocusIn = (e) => {
    keyboardFocusEl = performance.now() - lastPointerDownT > 400 ? e.target : null;
  };

  function onKeyDown(e) {
    const code = e.code;
    if (!GAME_KEYS.has(code)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (isTypingTarget(t)) return;
    if (!enabled) return;
    if (code === 'Space' || code.startsWith('Arrow')) {
      if (isGameTarget(t)) {
        e.preventDefault();
      } else if (isControl(t)) {
        // 用鍵盤（Tab）聚焦的按鈕：空白鍵照常操作按鈕，不當作跳躍
        if (code === 'Space' && t === keyboardFocusEl) return;
        // 滑鼠點過而殘留焦點的按鈕：交還給遊戲，避免空白鍵重複觸發按鈕
        if (code === 'Space') { e.preventDefault(); t.blur(); }
      }
    }
    if (MOVE_KEYS.has(code) && isTouch && hasFinePointer()) setTouchMode(false);
    if (code === 'Space' && !e.repeat && !keys.has('Space')) state.jumpPressed = true;
    keys.add(code);
    computeKeys();
    recompute();
  }
  function onKeyUp(e) {
    const code = e.code;
    if (!GAME_KEYS.has(code)) return;
    if (keys.delete(code)) {
      if ((code === 'Space' || code.startsWith('Arrow')) && isGameTarget(e.target)) e.preventDefault();
      computeKeys();
      recompute();
    }
  }

  // ---- 滑鼠拖曳視角 ----
  const mouse = { dragging: false, id: -1, x: 0, y: 0 };

  // ---- 觸控：搖桿與視角 ----
  const joy = { active: false, id: -1, cx: 0, cy: 0, x: 0, y: 0, outX: 0, outY: 0, run: false };
  const lookPtrs = []; // [{ id, x, y }]，最多兩個（第二個用來捏合）
  let pinchDist = 0;

  function startJoy(e) {
    readSafe();
    const w = window.innerWidth, h = window.innerHeight;
    const m = JOY_BASE_RADIUS + 6;
    joy.active = true;
    joy.id = e.pointerId;
    joy.cx = clamp(e.clientX, safe.l + m, Math.max(safe.l + m, w - safe.r - m));
    joy.cy = clamp(e.clientY, safe.t + m, Math.max(safe.t + m, h - safe.b - m));
    joyBase.classList.remove('idle');
    joyBase.classList.add('active');
    joyBase.style.left = joy.cx + 'px';
    joyBase.style.top = joy.cy + 'px';
    updateJoy(e.clientX, e.clientY);
  }
  function updateJoy(x, y) {
    let dx = x - joy.cx, dy = y - joy.cy;
    let d = Math.hypot(dx, dy);
    const follow = JOY_RADIUS * JOY_FOLLOW;
    if (d > follow) {
      // 底座跟著手指滑動，維持在 follow 半徑上
      const k = (d - follow) / d;
      joy.cx += dx * k; joy.cy += dy * k;
      joyBase.style.left = joy.cx + 'px';
      joyBase.style.top = joy.cy + 'px';
      dx = x - joy.cx; dy = y - joy.cy; d = follow;
    }
    const raw = d / JOY_RADIUS;
    const mag = Math.min(1, raw);
    const out = mag < JOY_DEADZONE ? 0 : (mag - JOY_DEADZONE) / (1 - JOY_DEADZONE);
    if (d > 1e-6) {
      joy.outX = (dx / d) * out;
      joy.outY = (-dy / d) * out;
    } else {
      joy.outX = 0; joy.outY = 0;
    }
    const run = raw >= JOY_RUN;
    if (run !== joy.run) { joy.run = run; joyBase.classList.toggle('running', run); }
    const kd = Math.min(d, JOY_RADIUS);
    const kx = d > 1e-6 ? (dx / d) * kd : 0;
    const ky = d > 1e-6 ? (dy / d) * kd : 0;
    joyKnob.style.transform = 'translate(' + kx.toFixed(1) + 'px,' + ky.toFixed(1) + 'px)';
    recompute();
  }
  function endJoy() {
    if (!joy.active && !joy.run && joy.outX === 0 && joy.outY === 0) return;
    joy.active = false;
    joy.id = -1;
    joy.outX = 0; joy.outY = 0;
    joy.run = false;
    joyBase.classList.remove('active', 'running');
    joyBase.classList.add('idle');
    joyBase.style.left = '';
    joyBase.style.top = '';
    joyKnob.style.transform = '';
    recompute();
  }

  function findLook(id) {
    for (let i = 0; i < lookPtrs.length; i++) if (lookPtrs[i].id === id) return i;
    return -1;
  }
  function resetPinch() {
    pinchDist = lookPtrs.length >= 2
      ? Math.hypot(lookPtrs[0].x - lookPtrs[1].x, lookPtrs[0].y - lookPtrs[1].y)
      : 0;
  }

  function capture(el, id) {
    try { el.setPointerCapture(id); } catch { /* 忽略 */ }
  }

  function onCanvasPointerDown(e) {
    if (e.pointerType === 'mouse') {
      if (isTouch && hasFinePointer()) setTouchMode(false);
      if (!enabled) return;
      if (e.button !== 0 && e.button !== 2) return;
      mouse.dragging = true;
      mouse.id = e.pointerId;
      mouse.x = e.clientX; mouse.y = e.clientY;
      capture(canvas, e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }
    // touch / pen
    setTouchMode(true);
    if (!enabled) return;
    if (e.cancelable) e.preventDefault();
    capture(canvas, e.pointerId);
    const w = window.innerWidth, h = window.innerHeight;
    if (!joy.active && e.clientX < w * JOY_ZONE_X && e.clientY > h * JOY_ZONE_TOP) {
      startJoy(e);
    } else if (lookPtrs.length < 2 && findLook(e.pointerId) < 0) {
      lookPtrs.push({ id: e.pointerId, x: e.clientX, y: e.clientY });
      resetPinch();
    }
  }

  function onCanvasPointerMove(e) {
    if (!enabled) return;
    if (e.pointerType === 'mouse') {
      if (!mouse.dragging || e.pointerId !== mouse.id) return;
      state.lookX += e.clientX - mouse.x;
      state.lookY += e.clientY - mouse.y;
      mouse.x = e.clientX; mouse.y = e.clientY;
      return;
    }
    if (joy.active && e.pointerId === joy.id) {
      if (e.cancelable) e.preventDefault();
      updateJoy(e.clientX, e.clientY);
      return;
    }
    const i = findLook(e.pointerId);
    if (i < 0) return;
    if (e.cancelable) e.preventDefault();
    const p = lookPtrs[i];
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (lookPtrs.length >= 2) {
      const d = Math.hypot(lookPtrs[0].x - lookPtrs[1].x, lookPtrs[0].y - lookPtrs[1].y);
      state.zoom += (pinchDist - d) / PINCH_PX; // 手指張開 → 拉近（zoom < 0）
      pinchDist = d;
    } else {
      state.lookX += dx * TOUCH_LOOK_SCALE;
      state.lookY += dy * TOUCH_LOOK_SCALE;
    }
  }

  function onCanvasPointerUp(e) {
    if (e.pointerType === 'mouse') {
      if (e.pointerId === mouse.id) {
        mouse.dragging = false;
        mouse.id = -1;
        canvas.style.cursor = '';
      }
      return;
    }
    if (joy.active && e.pointerId === joy.id) endJoy();
    const i = findLook(e.pointerId);
    if (i >= 0) { lookPtrs.splice(i, 1); resetPinch(); }
  }

  function onWheel(e) {
    e.preventDefault();
    if (!enabled) return;
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 33;       // 行
    else if (e.deltaMode === 2) d *= 400; // 頁
    // 觸控板捏合（ctrlKey）數值小，放大一點
    let z = e.ctrlKey ? d / 25 : d / 100;
    z = clamp(z, -3, 3);
    state.zoom += z;
  }

  // ---- 跳躍鈕 ----
  let jumpPtr = -1;
  function onJumpDown(e) {
    if (e.pointerType !== 'mouse') setTouchMode(true);
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (!enabled) return;
    if (jumpPtr !== -1) return; // 同時第二根手指不重複觸發
    jumpPtr = e.pointerId;
    capture(jumpBtn, e.pointerId);
    state.jumpPressed = true;
    jumpBtn.classList.add('pressed');
  }
  function onJumpUp(e) {
    if (e.pointerId !== jumpPtr) return;
    jumpPtr = -1;
    jumpBtn.classList.remove('pressed');
  }
  function releaseJumpBtn() {
    jumpPtr = -1;
    jumpBtn.classList.remove('pressed');
  }

  // ---- 遊戲手把 ----
  let padConnected = false;
  let padX = 0, padY = 0, padRun = false, padJumpPrev = true;
  const padBtn = (gp, i) => {
    const b = gp.buttons[i];
    return !!b && (b.pressed || b.value > 0.5);
  };
  function pollGamepad(dt) {
    if (!padConnected || !navigator.getGamepads) return;
    let pads;
    try { pads = navigator.getGamepads(); } catch { return; }
    let gp = null;
    for (let i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
    }
    if (!gp) {
      if (padX || padY || padRun) { padX = 0; padY = 0; padRun = false; recompute(); }
      return;
    }
    const ax = gp.axes;
    let lx = ax[0] || 0, ly = ax[1] || 0;
    let m = Math.hypot(lx, ly);
    if (m < PAD_DEADZONE) { lx = 0; ly = 0; } else {
      const s = Math.min(1, (m - PAD_DEADZONE) / (1 - PAD_DEADZONE)) / m;
      lx *= s; ly *= s;
    }
    let x = lx, y = -ly;
    if (gp.mapping === 'standard') {
      if (padBtn(gp, 12)) y += 1;
      if (padBtn(gp, 13)) y -= 1;
      if (padBtn(gp, 14)) x -= 1;
      if (padBtn(gp, 15)) x += 1;
    }
    padX = clamp(x, -1, 1); padY = clamp(y, -1, 1);

    let rx = ax[2] || 0, ry = ax[3] || 0;
    m = Math.hypot(rx, ry);
    if (m < PAD_DEADZONE) { rx = 0; ry = 0; } else {
      const s = Math.min(1, (m - PAD_DEADZONE) / (1 - PAD_DEADZONE)) / m;
      rx *= s; ry *= s;
    }
    state.lookX += rx * PAD_LOOK_SPEED * dt;
    state.lookY += ry * PAD_LOOK_SPEED * 0.7 * dt;

    const jump = padBtn(gp, 0);
    if (jump && !padJumpPrev) state.jumpPressed = true;
    padJumpPrev = jump;
    padRun = padBtn(gp, 5) || padBtn(gp, 7) || padBtn(gp, 10);
    recompute();
  }
  function onPadConnected() { padConnected = true; padJumpPrev = true; }
  function onPadDisconnected() {
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      padConnected = false;
      for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) padConnected = true;
    } catch { padConnected = false; }
    padX = 0; padY = 0; padRun = false;
    recompute();
  }

  // ---- 合成輸出 ----
  function recompute() {
    if (!enabled) {
      state.moveX = 0; state.moveY = 0; state.run = false;
      return;
    }
    let x, y;
    if (joy.active) {
      x = joy.outX; y = joy.outY;
    } else {
      x = kbX + padX; y = kbY + padY;
      const l = Math.hypot(x, y);
      if (l > 1) { x /= l; y /= l; }
    }
    state.moveX = x;
    state.moveY = y;
    state.run = kbRun || joy.run || padRun;
  }

  function clearHeld() {
    keys.clear();
    computeKeys();
    endJoy();
    lookPtrs.length = 0;
    pinchDist = 0;
    if (mouse.dragging) { mouse.dragging = false; mouse.id = -1; canvas.style.cursor = ''; }
    releaseJumpBtn();
    padX = 0; padY = 0; padRun = false; padJumpPrev = true;
    recompute();
  }

  function setEnabled(v) {
    v = !!v;
    if (v !== enabled) {
      enabled = v;
      clearHeld();
      state.jumpPressed = false;
      state.lookX = 0; state.lookY = 0; state.zoom = 0;
    }
    applyClasses();
  }

  let lastT = performance.now();
  function endFrame() {
    state.jumpPressed = false;
    state.lookX = 0;
    state.lookY = 0;
    state.zoom = 0;
    const now = performance.now();
    const dt = clamp((now - lastT) / 1000, 0, 0.1);
    lastT = now;
    if (!enabled) return;
    // 下一幀要用的持續量：Q/E 旋轉、手把
    if (kbLook !== 0) state.lookX += kbLook * KEY_LOOK_SPEED * dt;
    pollGamepad(dt);
  }

  // ---- 事件綁定 ----
  const onBlur = () => clearHeld();
  const onVis = () => { if (document.hidden) clearHeld(); };
  const preventDefault = (e) => { if (e.cancelable) e.preventDefault(); };

  const listeners = [
    [window, 'pointerdown', onAnyPointerDown, { capture: true, passive: true }],
    [document, 'focusin', onFocusIn, false],
    [window, 'keydown', onKeyDown, false],
    [window, 'keyup', onKeyUp, false],
    [window, 'blur', onBlur, false],
    [document, 'visibilitychange', onVis, false],
    [canvas, 'pointerdown', onCanvasPointerDown, { passive: false }],
    [canvas, 'pointermove', onCanvasPointerMove, { passive: false }],
    [canvas, 'pointerup', onCanvasPointerUp, false],
    [canvas, 'pointercancel', onCanvasPointerUp, false],
    [canvas, 'lostpointercapture', onCanvasPointerUp, false],
    [canvas, 'wheel', onWheel, { passive: false }],
    [jumpBtn, 'pointerdown', onJumpDown, { passive: false }],
    [jumpBtn, 'pointerup', onJumpUp, false],
    [jumpBtn, 'pointercancel', onJumpUp, false],
    [jumpBtn, 'lostpointercapture', onJumpUp, false],
    [container, 'contextmenu', preventDefault, false],
    [container, 'touchstart', preventDefault, { passive: false }],
    // iOS Safari 的雙指縮放手勢
    [document, 'gesturestart', preventDefault, { passive: false }],
    [window, 'gamepadconnected', onPadConnected, false],
    [window, 'gamepaddisconnected', onPadDisconnected, false],
  ];
  for (const [t, n, f, o] of listeners) t.addEventListener(n, f, o);
  window.addEventListener('resize', readSafe);

  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) padConnected = true;
  } catch { /* 忽略 */ }

  return {
    state,
    get isTouch() { return isTouch; },
    get enabled() { return enabled; },
    setEnabled,
    endFrame,
    dispose() {
      for (const [t, n, f, o] of listeners) t.removeEventListener(n, f, o);
      window.removeEventListener('resize', readSafe);
      container.remove();
    },
  };
}
