// 星際除草王 — 介面 / HUD / 觸控搖桿
// createUI(cb) 自行建立所有 DOM，主控只呼叫回傳的 API。

const STAR = '★';

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtTime(t) {
  t = Math.max(0, Math.ceil(Number(t) || 0));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// 比例(0..1) 或百分比都接受；依 target 判斷尺度
function toPct(v, ref) {
  v = Number(v) || 0;
  const r = ref == null ? v : Number(ref) || 0;
  return r <= 1 ? v * 100 : v;
}

export function createUI(cb = {}) {
  const call = (name, ...a) => { try { cb[name] && cb[name](...a); } catch (e) { console.error(e); } };

  const input = { throttle: 0, steer: 0, boost: false };

  // ---------- 根節點 ----------
  const root = el('div', 'pm-ui');
  root.id = 'pm-ui';
  document.body.appendChild(root);

  // 阻止 iOS 手勢縮放 / 雙擊縮放
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t =>
    document.addEventListener(t, e => e.preventDefault(), { passive: false }));
  let lastTouchEnd = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTouchEnd < 350 && e.cancelable && !e.target.closest('.pm-scroll')) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
  root.addEventListener('contextmenu', e => e.preventDefault());

  // ---------- 觸控偵測 ----------
  const setTouch = () => root.classList.add('is-touch');
  try { if (window.matchMedia && matchMedia('(pointer: coarse)').matches) setTouch(); } catch (e) { /* ignore */ }
  window.addEventListener('touchstart', setTouch, { once: true, passive: true });
  window.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') setTouch(); }, { passive: true });

  // ---------- 按鈕工具 ----------
  const muteBtns = [];
  let muted = false;

  function button(label, cls, onTap) {
    const b = el('button', 'pm-btn ' + (cls || ''), label);
    b.type = 'button';
    const stop = e => e.stopPropagation();
    b.addEventListener('pointerdown', stop);
    b.addEventListener('touchstart', stop, { passive: true });
    b.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      if (b.disabled) return;
      onTap && onTap(e);
    });
    return b;
  }

  function muteButton(cls) {
    const b = button('', 'pm-icon pm-mute ' + (cls || ''), () => call('onMute'));
    b.setAttribute('aria-label', '靜音切換');
    muteBtns.push(b);
    paintMute(b);
    return b;
  }
  function paintMute(b) {
    b.textContent = muted ? '🔇' : '🔊';
    b.classList.toggle('is-muted', muted);
    b.title = muted ? '開啟聲音 (M)' : '靜音 (M)';
  }

  // ---------- 畫面 ----------
  const screens = {};
  function makeScreen(name, extra) {
    const s = el('section', 'pm-screen pm-scroll pm-screen-' + name + (extra ? ' ' + extra : ''));
    s.hidden = true;
    s.addEventListener('pointerdown', e => e.stopPropagation());
    root.appendChild(s);
    screens[name] = s;
    return s;
  }
  function show(name) {
    for (const k in screens) screens[k].hidden = k !== name;
    root.classList.toggle('screen-on', !!name);
    if (name) {
      resetInput();
      const s = screens[name];
      s.scrollTop = 0;
      // 重新觸發進場動畫
      s.classList.remove('pm-enter'); void s.offsetWidth; s.classList.add('pm-enter');
    }
  }

  // 標題
  const sTitle = makeScreen('title', 'pm-bg-soft');
  {
    const top = el('div', 'pm-title-top');
    top.appendChild(muteButton());
    sTitle.appendChild(top);
    const wrap = el('div', 'pm-title-wrap');
    wrap.innerHTML = `
      <div class="pm-logo">
        <div class="pm-logo-main">星際除草王</div>
        <div class="pm-logo-sub">PLANET MOWER</div>
      </div>
      <div class="pm-title-spacer"></div>`;
    const btns = el('div', 'pm-title-btns');
    btns.appendChild(button('▶ 開始遊戲', 'pm-primary pm-big', () => call('onPlay')));
    const helpBtn = button('❓ 操作說明', 'pm-secondary', () => help.hidden = !help.hidden);
    btns.appendChild(helpBtn);
    wrap.appendChild(btns);
    const help = el('div', 'pm-panel pm-help');
    help.hidden = true;
    help.innerHTML = `
      <div class="pm-help-col">
        <h3>💻 電腦</h3>
        <ul>
          <li><kbd>W</kbd><kbd>S</kbd> / <kbd>↑</kbd><kbd>↓</kbd> 前進・後退</li>
          <li><kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd> 轉向</li>
          <li><kbd>Shift</kbd> / <kbd>空白</kbd> 加速</li>
          <li><kbd>P</kbd> 暫停　<kbd>M</kbd> 靜音</li>
        </ul>
      </div>
      <div class="pm-help-col">
        <h3>📱 手機 / 平板</h3>
        <ul>
          <li>左半邊螢幕：按住拖曳搖桿</li>
          <li>往上前進、往下後退、左右轉向</li>
          <li>右下 ⚡ 按住加速</li>
        </ul>
      </div>
      <p class="pm-help-goal">🌱 在時間內把草割到目標比例就過關！</p>`;
    wrap.appendChild(help);
    sTitle.appendChild(wrap);
  }

  // 選關
  const sSelect = makeScreen('select', 'pm-bg-soft');
  const selHead = el('div', 'pm-head');
  selHead.appendChild(button('◀ 返回', 'pm-secondary pm-small', () => call('onMenu')));
  selHead.appendChild(el('h2', 'pm-h2', '選擇星球'));
  selHead.appendChild(el('div', 'pm-head-total'));
  sSelect.appendChild(selHead);
  const grid = el('div', 'pm-grid');
  sSelect.appendChild(grid);

  // 簡報
  const sBrief = makeScreen('brief', 'pm-bg-dim pm-center');
  const briefPanel = el('div', 'pm-panel pm-brief');
  sBrief.appendChild(briefPanel);

  // 暫停
  const sPause = makeScreen('pause', 'pm-bg-dim pm-center');
  {
    const p = el('div', 'pm-panel pm-pause');
    p.appendChild(el('h2', 'pm-h2', '⏸ 暫停中'));
    const b = el('div', 'pm-col');
    b.appendChild(button('▶ 繼續', 'pm-primary pm-big', () => call('onResume')));
    b.appendChild(button('↻ 重新開始', 'pm-secondary', () => call('onRestart')));
    b.appendChild(button('☰ 回選單', 'pm-secondary', () => call('onMenu')));
    p.appendChild(b);
    const m = el('div', 'pm-pause-mute');
    m.appendChild(muteButton());
    p.appendChild(m);
    sPause.appendChild(p);
  }

  // 結算
  const sResult = makeScreen('result', 'pm-bg-dim pm-center');
  const resultPanel = el('div', 'pm-panel pm-result');
  sResult.appendChild(resultPanel);
  const confetti = el('div', 'pm-confetti');
  sResult.appendChild(confetti);

  // ---------- HUD ----------
  const hud = el('div', 'pm-hud');
  hud.hidden = true;
  hud.innerHTML = `
    <div class="pm-hud-top">
      <div class="pm-hud-info">
        <div class="pm-hud-name"><span class="pm-hud-lv"></span><span class="pm-hud-title"></span></div>
        <div class="pm-prog">
          <div class="pm-prog-fill"></div>
          <div class="pm-prog-target"><span></span></div>
        </div>
        <div class="pm-hud-row">
          <span class="pm-hud-pct">0%</span>
          <span class="pm-lives"></span>
        </div>
        <div class="pm-boost"><span class="pm-boost-ico">⚡</span><div class="pm-boost-bar"><div class="pm-boost-fill"></div></div></div>
      </div>
      <div class="pm-timer">0:00</div>
      <div class="pm-hud-btns"></div>
    </div>
    <div class="pm-radar" hidden>↑ 跟著箭頭找剩下的草</div>
    <div class="pm-powers"></div>`;
  root.appendChild(hud);
  const q = s => hud.querySelector(s);
  const H = {
    lv: q('.pm-hud-lv'), title: q('.pm-hud-title'), fill: q('.pm-prog-fill'), target: q('.pm-prog-target'),
    pct: q('.pm-hud-pct'), lives: q('.pm-lives'), boost: q('.pm-boost-fill'), timer: q('.pm-timer'),
    radar: q('.pm-radar'), powers: q('.pm-powers'), btns: q('.pm-hud-btns'), prog: q('.pm-prog')
  };
  {
    const pb = button('⏸', 'pm-icon', () => call('onPause'));
    pb.setAttribute('aria-label', '暫停');
    pb.title = '暫停 (P)';
    H.btns.appendChild(pb);
    H.btns.appendChild(muteButton());
  }
  const prev = {};
  const powerEls = [];

  // ---------- 觸控控制 ----------
  const touch = el('div', 'pm-touch');
  touch.innerHTML = `
    <div class="pm-joyzone"><div class="pm-joy-hint">按住拖曳<br>移動</div></div>
    <div class="pm-joy"><div class="pm-joy-knob"></div></div>`;
  const boostBtn = el('div', 'pm-boostbtn', '<span class="pm-bb-ico">⚡</span><span class="pm-bb-txt">加速</span>');
  touch.appendChild(boostBtn);
  root.appendChild(touch);
  const zone = touch.querySelector('.pm-joyzone');
  const joy = touch.querySelector('.pm-joy');
  const knob = touch.querySelector('.pm-joy-knob');
  let joyId = null, joyX = 0, joyY = 0, boostId = null;
  const JOY_R = 52;

  function resetInput() {
    input.throttle = 0; input.steer = 0; input.boost = false;
    joyId = null; boostId = null;
    joy.classList.remove('on');
    knob.style.transform = '';
    boostBtn.classList.remove('on');
  }

  zone.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    setTouch();
    if (joyId !== null) return;
    joyId = e.pointerId;
    try { zone.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const rr = root.getBoundingClientRect();
    joyX = e.clientX - rr.left; joyY = e.clientY - rr.top;
    joy.style.left = joyX + 'px'; joy.style.top = joyY + 'px';
    joy.classList.add('on');
    knob.style.transform = 'translate(-50%,-50%)';
    zone.classList.add('used');
  });
  zone.addEventListener('pointermove', e => {
    if (e.pointerId !== joyId) return;
    e.preventDefault();
    const rr = root.getBoundingClientRect();
    let dx = e.clientX - rr.left - joyX, dy = e.clientY - rr.top - joyY;
    const d = Math.hypot(dx, dy);
    if (d > JOY_R) { dx *= JOY_R / d; dy *= JOY_R / d; }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const dead = 0.12;
    const f = v => { const a = Math.abs(v); return a < dead ? 0 : Math.sign(v) * Math.min(1, (a - dead) / (1 - dead)); };
    input.throttle = f(-dy / JOY_R);
    input.steer = f(-dx / JOY_R);
  });
  const joyEnd = e => {
    if (e.pointerId !== joyId) return;
    joyId = null;
    input.throttle = 0; input.steer = 0;
    joy.classList.remove('on');
    knob.style.transform = 'translate(-50%,-50%)';
  };
  zone.addEventListener('pointerup', joyEnd);
  zone.addEventListener('pointercancel', joyEnd);
  zone.addEventListener('lostpointercapture', joyEnd);

  boostBtn.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    setTouch();
    boostId = e.pointerId;
    try { boostBtn.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    input.boost = true;
    boostBtn.classList.add('on');
  });
  const boostEnd = e => {
    if (e.pointerId !== boostId) return;
    boostId = null;
    input.boost = false;
    boostBtn.classList.remove('on');
  };
  boostBtn.addEventListener('pointerup', boostEnd);
  boostBtn.addEventListener('pointercancel', boostEnd);
  boostBtn.addEventListener('lostpointercapture', boostEnd);
  window.addEventListener('blur', resetInput);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetInput(); });

  // ---------- 倒數 / toast / flash ----------
  const countdown = el('div', 'pm-countdown');
  countdown.hidden = true;
  root.appendChild(countdown);
  const toasts = el('div', 'pm-toasts');
  root.appendChild(toasts);
  const flashEl = el('div', 'pm-flash');
  root.appendChild(flashEl);

  // ---------- API ----------
  function starsHTML(n, cls) {
    let s = '';
    for (let i = 0; i < 3; i++) s += `<span class="${cls} ${i < n ? 'got' : ''}" style="--i:${i}">${STAR}</span>`;
    return s;
  }

  const api = {
    input,

    showTitle() { show('title'); },

    showSelect(levels, save) {
      levels = levels || [];
      save = save || { unlocked: 1, stars: [] };
      const unlocked = save.unlocked || 1;
      const stars = save.stars || [];
      grid.innerHTML = '';
      let total = 0;
      levels.forEach((lv, i) => {
        const st = Math.max(0, Math.min(3, stars[i] || 0));
        total += st;
        const locked = i >= unlocked;
        const card = el('button', 'pm-card' + (locked ? ' locked' : ''));
        card.type = 'button';
        card.disabled = locked;
        card.style.setProperty('--d', (i * 0.05) + 's');
        card.innerHTML = `
          <div class="pm-card-ball" style="background:${esc(lv.css || '#4a6')}">${locked ? '<span class="pm-lock">🔒</span>' : ''}</div>
          <div class="pm-card-txt">
            <div class="pm-card-no">第 ${i + 1} 關</div>
            <div class="pm-card-name">${esc(lv.name)}</div>
            <div class="pm-card-sub">${esc(lv.sub)}</div>
            <div class="pm-card-stars">${starsHTML(st, 'pm-s')}</div>
          </div>`;
        card.addEventListener('pointerdown', e => e.stopPropagation());
        card.addEventListener('click', e => {
          e.stopPropagation();
          if (locked) return;
          call('onSelect', i);
        });
        grid.appendChild(card);
      });
      selHead.querySelector('.pm-head-total').innerHTML = `<span class="pm-s got">${STAR}</span> ${total}/${levels.length * 3}`;
      show('select');
    },

    showBriefing(level, idx) {
      level = level || {};
      const hz = (level.hazards || []).map(h => `<li>${esc(h)}</li>`).join('');
      briefPanel.innerHTML = `
        <div class="pm-brief-head">
          <div class="pm-card-ball pm-brief-ball" style="background:${esc(level.css || '#4a6')}"></div>
          <div>
            <div class="pm-card-no">第 ${(idx | 0) + 1} 關</div>
            <h2 class="pm-h2 pm-brief-name">${esc(level.name)}</h2>
            <div class="pm-brief-sub">${esc(level.sub)}</div>
          </div>
        </div>
        <div class="pm-stats">
          <div class="pm-stat"><div class="pm-stat-k">🌱 目標</div><div class="pm-stat-v">${Math.round(toPct(level.target))}%</div></div>
          <div class="pm-stat"><div class="pm-stat-k">⏱ 限時</div><div class="pm-stat-v">${fmtTime(level.time)}</div></div>
        </div>
        ${hz ? `<div class="pm-hz"><div class="pm-hz-t">⚠️ 危險</div><ul>${hz}</ul></div>` : ''}
        ${level.tip ? `<div class="pm-tip">💡 ${esc(level.tip)}</div>` : ''}
        <div class="pm-row pm-brief-btns"></div>`;
      const row = briefPanel.querySelector('.pm-brief-btns');
      row.appendChild(button('◀ 返回', 'pm-secondary', () => call('onMenu')));
      row.appendChild(button('🚀 出發！', 'pm-primary pm-big', () => call('onGo')));
      show('brief');
    },

    showCountdown(text) {
      if (text == null || text === '') { countdown.hidden = true; return; }
      countdown.hidden = false;
      countdown.textContent = text;
      countdown.classList.toggle('go', String(text).length > 1);
      countdown.classList.remove('pop'); void countdown.offsetWidth; countdown.classList.add('pop');
    },

    showPause() { show('pause'); },

    showResult(r) {
      r = r || {};
      const pct = Math.round(toPct(r.pct, r.target));
      const tgt = Math.round(toPct(r.target));
      confetti.innerHTML = '';
      let html;
      if (r.win) {
        const n = Math.max(0, Math.min(3, r.stars | 0));
        html = `
          ${r.allClear ? '<div class="pm-allclear">👑 你是銀河除草王！ 👑</div>' : ''}
          <h2 class="pm-h2 pm-win-t">過關成功！</h2>
          <div class="pm-big-stars">${starsHTML(n, 'pm-bs')}</div>
          <div class="pm-stats">
            <div class="pm-stat"><div class="pm-stat-k">🌱 割草率</div><div class="pm-stat-v">${pct}%</div></div>
            <div class="pm-stat"><div class="pm-stat-k">⏱ 剩餘時間</div><div class="pm-stat-v">${fmtTime(r.timeLeft)}</div></div>
          </div>
          <div class="pm-col pm-result-btns"></div>`;
      } else {
        html = `
          <h2 class="pm-h2 pm-lose-t">任務失敗</h2>
          <div class="pm-reason">${esc(r.reason || '再試一次吧！')}</div>
          <div class="pm-stats">
            <div class="pm-stat"><div class="pm-stat-k">🌱 割草率</div><div class="pm-stat-v">${pct}% <small>/ ${tgt}%</small></div></div>
          </div>
          <div class="pm-col pm-result-btns"></div>`;
      }
      resultPanel.className = 'pm-panel pm-result ' + (r.win ? 'win' : 'lose') + (r.allClear ? ' allclear' : '');
      resultPanel.innerHTML = html;
      const b = resultPanel.querySelector('.pm-result-btns');
      if (r.win && r.hasNext) b.appendChild(button('下一關 ▶', 'pm-primary pm-big', () => call('onNext')));
      b.appendChild(button('↻ 重玩', r.win && r.hasNext ? 'pm-secondary' : 'pm-primary pm-big', () => call('onRestart')));
      b.appendChild(button('☰ 選單', 'pm-secondary', () => call('onMenu')));
      if (r.win && r.allClear) {
        const colors = ['#ff5d8f', '#ffd23f', '#5de0ff', '#8cff5d', '#c58bff', '#ff9f43'];
        for (let i = 0; i < 70; i++) {
          const c = el('i');
          c.style.left = (Math.random() * 100) + '%';
          c.style.background = colors[i % colors.length];
          c.style.animationDelay = (Math.random() * 3) + 's';
          c.style.animationDuration = (2.6 + Math.random() * 2.4) + 's';
          c.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
          c.style.setProperty('--x', (Math.random() * 120 - 60) + 'px');
          if (i % 3 === 0) c.style.borderRadius = '50%';
          confetti.appendChild(c);
        }
      }
      show('result');
    },

    hideScreens() { show(null); },

    showHUD(on) {
      on = !!on;
      hud.hidden = !on;
      root.classList.toggle('hud-on', on);
      if (!on) { resetInput(); zone.classList.remove('used'); }
    },

    updateHUD(h) {
      if (!h) return;
      const set = (k, v, fn) => { if (prev[k] !== v) { prev[k] = v; fn(v); } };
      set('idx', h.idx, v => { H.lv.textContent = '第' + ((v | 0) + 1) + '關'; });
      set('name', h.name, v => { H.title.textContent = v || ''; });
      const tgt = toPct(h.target);
      const pct = Math.min(100, Math.max(0, toPct(h.pct, h.target)));
      set('target', tgt, v => {
        H.target.style.left = Math.min(100, v) + '%';
        H.target.firstChild.textContent = Math.round(v) + '%';
      });
      const pr = Math.round(pct * 10) / 10;
      set('pct', pr, v => {
        H.fill.style.width = v + '%';
        H.pct.textContent = Math.floor(v) + '%';
      });
      set('reached', pct >= tgt, v => H.prog.classList.toggle('reached', v));
      const ts = Math.max(0, Math.ceil(h.time || 0));
      set('time', ts, v => { H.timer.textContent = fmtTime(v); });
      set('low', ts < 10, v => H.timer.classList.toggle('low', v));
      const ml = h.maxLives | 0, lv = Math.max(0, h.lives | 0);
      set('lives', lv + '/' + ml, () => {
        let s = '';
        for (let i = 0; i < Math.max(ml, lv); i++) s += `<span class="${i < lv ? 'full' : 'empty'}">${i < lv ? '❤️' : '🖤'}</span>`;
        H.lives.innerHTML = s;
      });
      const bst = Math.round(Math.max(0, Math.min(100, h.boost || 0)));
      set('boost', bst, v => {
        H.boost.style.width = v + '%';
        boostBtn.style.setProperty('--b', v);
        boostBtn.classList.toggle('empty', v < 5);
      });
      set('radar', !!h.radar, v => { H.radar.hidden = !v; });
      const pw = h.powers || [];
      while (powerEls.length < pw.length) {
        const p = el('div', 'pm-power');
        p.innerHTML = '<span class="pm-power-l"></span><span class="pm-power-t"></span>';
        H.powers.appendChild(p);
        powerEls.push({ el: p, l: p.firstChild, t: p.lastChild, lv: null, tv: null });
      }
      powerEls.forEach((p, i) => {
        const d = pw[i];
        if (!d) { if (!p.el.hidden) p.el.hidden = true; return; }
        if (p.el.hidden) p.el.hidden = false;
        if (p.lv !== d.label) { p.lv = d.label; p.l.textContent = d.label; }
        const t = Math.max(0, Math.ceil(d.t || 0));
        if (p.tv !== t) { p.tv = t; p.t.textContent = t + 's'; p.el.classList.toggle('ending', t <= 3); }
      });
    },

    toast(msg) {
      const t = el('div', 'pm-toast');
      t.textContent = msg;
      toasts.appendChild(t);
      while (toasts.children.length > 3) toasts.firstChild.remove();
      setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 1800);
    },

    flash(color) {
      flashEl.style.background = color || 'rgba(255,255,255,.6)';
      flashEl.classList.remove('go'); void flashEl.offsetWidth; flashEl.classList.add('go');
    },

    setMuted(m) {
      muted = !!m;
      muteBtns.forEach(paintMute);
    },
  };

  return api;
}
