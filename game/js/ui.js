// 分身 5：介面（開始畫面、HUD、指南針、表情、知識卡、設定、勝利畫面、提示訊息、表情泡泡）
import * as THREE from 'three';
import { EMOTES, SAVE_KEY, GAME_TITLE, GAME_SUBTITLE, BIOMES } from './config.js';

const OCCLUDE_R = 29.3;     // 判斷被星球擋住用的半徑
const METERS_PER_RAD = 30;  // 球面弧長換算：角度 × 30
const MAX_TOASTS = 3;
const MODAL_GUARD_MS = 400;

const TITLE_COLORS = ['#ff8a5c', '#ffb703', '#5cc98a', '#3b9ae1', '#a37cf0'];

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(cls, text, label) {
  const b = h('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}
function retrigger(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // 強制重排以重新播放動畫
  el.classList.add(cls);
}
function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}
const wrapAngle = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

const ARROW_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3.5c.7 0 1.3.4 1.6 1l8.6 19.3c.6 1.4-.9 2.8-2.3 2.1L16.9 22.6a2 2 0 0 0-1.8 0l-7 3.3c-1.4.7-2.9-.7-2.3-2.1l8.6-19.3c.3-.6.9-1 1.6-1z"/></svg>`;

export function createUI({ root, audio, callbacks = {} }) {
  const cb = callbacks || {};
  const sfx = (name) => { try { audio && audio.play(name); } catch { /* 忽略 */ } };
  const mqCoarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : { matches: false };

  root.classList.add('tw-root');

  // ================= 圖層 =================
  const worldLayer = h('div', 'tw-world');     // 目標標記與表情泡泡
  const hud = h('div', 'tw-hud');
  const modalLayer = h('div', 'tw-modals');
  root.append(worldLayer, hud, modalLayer);

  // ================= HUD：進度 =================
  const progress = h('div', 'tw-progress tw-glass');
  progress.setAttribute('role', 'status');
  const chips = h('div', 'tw-chips');
  function makeChip(icon, label) {
    const c = h('div', 'tw-chip');
    c.setAttribute('aria-label', label);
    const ic = h('span', 'tw-chip-ic', icon);
    const v = h('b', 'tw-chip-v', '0');
    const tot = h('span', 'tw-chip-tot', '/0');
    c.append(ic, v, tot);
    chips.append(c);
    return { c, v, tot };
  }
  const chipC = makeChip('💎', '知識晶石');
  const chipT = makeChip('🌱', '幼苗');
  const bar = h('div', 'tw-bar');
  const barFill = h('div', 'tw-bar-fill');
  bar.append(barFill);
  progress.append(chips, bar);

  // ================= HUD：指南針 =================
  const compass = h('div', 'tw-compass tw-glass');
  const dial = h('div', 'tw-compass-dial');
  const arrow = h('div', 'tw-compass-arrow');
  arrow.innerHTML = ARROW_SVG;
  const seen = h('div', 'tw-compass-seen', '👀');
  dial.append(arrow, seen);
  const ctext = h('div', 'tw-compass-text');
  const clabel = h('div', 'tw-compass-label', '');
  const cdist = h('div', 'tw-compass-dist', '');
  ctext.append(clabel, cdist);
  compass.append(dial, ctext);

  const toasts = h('div', 'tw-toasts');
  toasts.setAttribute('aria-live', 'polite');

  // ================= HUD：右上按鈕 =================
  const topRight = h('div', 'tw-topright');
  const btnSettings = button('tw-iconbtn tw-glass', '⚙️', '設定');
  const btnMute = button('tw-iconbtn tw-glass', '🔊', '音效開關');
  topRight.append(btnSettings, btnMute);

  // ================= HUD：表情 =================
  const emoteWrap = h('div', 'tw-emote');
  const picker = h('div', 'tw-emote-picker tw-glass');
  picker.setAttribute('role', 'menu');
  EMOTES.forEach((emo, i) => {
    const b = button('tw-emote-item', emo, `表情 ${i + 1}`);
    b.style.setProperty('--i', i);
    const k = h('span', 'tw-emote-key', String(i + 1));
    b.append(k);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      b.blur();
      closePicker();
      triggerEmote(emo);
    });
    picker.append(b);
  });
  const btnEmote = button('tw-emote-btn tw-glass', '😊', '表情');
  emoteWrap.append(picker, btnEmote);

  // 目標標記
  const marker = h('div', 'tw-marker');
  const markerPin = h('div', 'tw-marker-pin');
  markerPin.append(h('span', '', '✦'));
  marker.append(markerPin);
  worldLayer.append(marker);

  hud.append(progress, compass, toasts, topRight, emoteWrap);

  // ================= 互動狀態 =================
  let started = false;
  let lastProgress = { crystals: 0, totalCrystals: 12, trees: 0, totalTrees: 8, done: false };
  let pickerOpen = false;

  function openPicker() {
    pickerOpen = true;
    emoteWrap.classList.add('is-open');
    btnEmote.setAttribute('aria-expanded', 'true');
  }
  function closePicker() {
    if (!pickerOpen) return;
    pickerOpen = false;
    emoteWrap.classList.remove('is-open');
    btnEmote.setAttribute('aria-expanded', 'false');
  }
  btnEmote.addEventListener('click', (e) => {
    e.stopPropagation();
    btnEmote.blur();
    sfx('ui');
    if (pickerOpen) closePicker(); else openPicker();
  });
  document.addEventListener('pointerdown', (e) => {
    if (pickerOpen && !emoteWrap.contains(e.target)) closePicker();
  }, true);

  function triggerEmote(emo) {
    if (!started || isModalOpen()) return;
    retrigger(btnEmote, 'is-bump');
    if (cb.onEmote) cb.onEmote(emo);
  }

  function refreshMute() {
    const m = !!(audio && audio.isMuted && audio.isMuted());
    btnMute.textContent = m ? '🔇' : '🔊';
    btnMute.setAttribute('aria-pressed', m ? 'true' : 'false');
    btnMute.classList.toggle('is-off', m);
    if (settingsRefs) {
      settingsRefs.soundOn.setAttribute('aria-pressed', m ? 'false' : 'true');
      settingsRefs.soundOff.setAttribute('aria-pressed', m ? 'true' : 'false');
    }
  }
  function setMuted(m) {
    if (audio && audio.setMuted) audio.setMuted(m);
    refreshMute();
    if (!m) sfx('ui');
  }
  btnMute.addEventListener('click', () => {
    btnMute.blur();
    if (audio && audio.unlock) audio.unlock();
    setMuted(!(audio && audio.isMuted && audio.isMuted()));
    retrigger(btnMute, 'is-bump');
  });
  btnSettings.addEventListener('click', () => {
    btnSettings.blur();
    sfx('ui');
    openSettings();
  });

  // ================= 對話框管理 =================
  let current = null;
  let openedAt = 0;
  const queue = [];
  const modals = {};

  function makeModal(name, cardCls) {
    const m = h('div', `tw-modal tw-modal-${name}`);
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.hidden = true;
    const card = h('div', `tw-card ${cardCls || ''}`);
    m.append(card);
    modalLayer.append(m);
    modals[name] = m;
    return { m, card };
  }

  function openModal(name, setup) {
    if (current && current !== name) {
      queue.push([name, setup]);
      return;
    }
    if (setup) setup();
    const m = modals[name];
    m.hidden = false;
    retrigger(m, 'is-open');
    current = name;
    openedAt = performance.now();
    closePicker();
    hud.classList.add('is-dimmed');
  }
  function closeModal(name) {
    if (current !== name) return;
    const m = modals[name];
    m.classList.remove('is-open');
    m.hidden = true;
    current = null;
    hud.classList.remove('is-dimmed');
    armedKey = null;
    if (queue.length) {
      const [n, s] = queue.shift();
      openModal(n, s);
    }
  }
  function isModalOpen() { return current !== null; }
  const guardOk = () => performance.now() - openedAt > MODAL_GUARD_MS;

  // ================= 開始畫面 =================
  const start = makeModal('start', 'tw-start-card');
  start.m.classList.add('tw-modal-hero');
  const titleWrap = h('div', 'tw-start-head');
  const title = h('h1', 'tw-title');
  title.setAttribute('aria-label', GAME_TITLE);
  [...GAME_TITLE].forEach((ch, i) => {
    const s = h('span', 'tw-title-ch', ch);
    s.style.setProperty('--i', i);
    s.style.setProperty('--c', TITLE_COLORS[i % TITLE_COLORS.length]);
    s.setAttribute('aria-hidden', 'true');
    title.append(s);
  });
  const subtitle = h('div', 'tw-subtitle', GAME_SUBTITLE);
  titleWrap.append(title, subtitle);
  // 標題放在卡片外面（讓中間的星球露出來）
  start.m.insertBefore(titleWrap, start.card);

  const story = h('p', 'tw-story', '小小的地球正在褪色⋯⋯收集 12 顆知識晶石、種下 8 棵幼苗，讓星球重新繽紛起來！');
  const startBtns = h('div', 'tw-btnrow');
  const btnNew = button('tw-btn', '開始旅程');
  const btnCont = button('tw-btn', '繼續旅程');
  startBtns.append(btnNew, btnCont);
  const startNote = h('p', 'tw-note', '選「開始旅程」會從頭出發，原本的進度將被清除。');
  const controls = h('div', 'tw-controls');
  start.card.append(story, startBtns, startNote, controls);

  function buildControls() {
    controls.textContent = '';
    const touch = mqCoarse.matches;
    const items = touch
      ? [['🕹️', '左邊拖曳移動'], ['👆', '右邊滑動轉視角'], ['⤴️', '按跳躍鈕']]
      : [['WASD', '移動', '方向鍵'], ['Shift', '跑步'], ['空白鍵', '跳'], ['🖱️', '拖曳轉視角'], ['滾輪', '縮放'], ['1–6', '表情']];
    for (const [k, label, alt] of items) {
      const it = h('div', 'tw-ctrl');
      const kk = h(touch ? 'span' : 'kbd', touch ? 'tw-ctrl-ic' : 'tw-kbd', k);
      it.append(kk);
      if (alt) {
        it.append(h('span', 'tw-ctrl-sep', '/'));
        it.append(h('kbd', 'tw-kbd', alt));
      }
      it.append(h('span', 'tw-ctrl-t', label));
      controls.append(it);
    }
    controls.classList.toggle('is-touch', touch);
  }
  if (mqCoarse.addEventListener) mqCoarse.addEventListener('change', buildControls);

  let startPrimary = btnNew;
  function onStartClick(cont) {
    if (current !== 'start') return;
    try { audio && audio.unlock && audio.unlock(); } catch { /* 忽略 */ }
    sfx('ui');
    if (cb.onStart) cb.onStart({ continue: cont });
  }
  btnNew.addEventListener('click', () => onStartClick(false));
  btnCont.addEventListener('click', () => onStartClick(true));

  function showStart({ hasSave = false } = {}) {
    // 開始畫面優先：關掉其他對話框
    queue.length = 0;
    if (current && current !== 'start') {
      const m = modals[current];
      m.classList.remove('is-open');
      m.hidden = true;
      current = null;
    }
    started = false;
    root.classList.remove('is-playing');
    buildControls();
    btnCont.hidden = !hasSave;
    startNote.hidden = !hasSave;
    btnCont.className = 'tw-btn tw-btn-primary';
    btnNew.className = hasSave ? 'tw-btn tw-btn-secondary' : 'tw-btn tw-btn-primary';
    // 主要按鈕放前面
    if (hasSave) startBtns.prepend(btnCont); else startBtns.prepend(btnNew);
    startPrimary = hasSave ? btnCont : btnNew;
    openModal('start');
    if (!mqCoarse.matches) setTimeout(() => { try { startPrimary.focus({ preventScroll: true }); } catch { /* 忽略 */ } }, 50);
  }
  function hideStart() {
    if (current === 'start') {
      try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch { /* 忽略 */ }
      closeModal('start');
    }
    started = true;
    root.classList.add('is-playing');
    refreshMute();
  }

  // ================= 知識卡 =================
  const fact = makeModal('fact', 'tw-fact-card');
  const factIconWrap = h('div', 'tw-fact-iconwrap');
  const factIcon = h('div', 'tw-fact-icon', '💎');
  factIconWrap.append(factIcon);
  const factBody = h('div', 'tw-fact-body');
  const factTag = h('div', 'tw-tag', '');
  const factKicker = h('div', 'tw-kicker', '找到知識晶石！');
  const factTitle = h('h2', 'tw-fact-title', '');
  const factText = h('p', 'tw-fact-text', '');
  const factCount = h('div', 'tw-fact-count', '');
  const factBtn = button('tw-btn tw-btn-primary tw-btn-wide', '太棒了！');
  const factHead = h('div', 'tw-fact-head');
  factHead.append(factKicker, factTag);
  factBody.append(factHead, factTitle, factText, factCount, factBtn);
  fact.card.append(factIconWrap, factBody);

  function refreshFactCount() {
    const p = lastProgress;
    factCount.textContent = `💎 已收集 ${p.crystals} / ${p.totalCrystals} 顆知識晶石`;
  }
  function closeFact() {
    if (current !== 'fact') return;
    sfx('ui');
    closeModal('fact');
  }
  factBtn.addEventListener('click', () => { if (guardOk()) closeFact(); });
  fact.m.addEventListener('click', (e) => { if (e.target === fact.m && guardOk()) closeFact(); });

  function showFact(f = {}) {
    openModal('fact', () => {
      factIcon.textContent = f.icon || '💎';
      factTitle.textContent = f.title || '';
      factText.textContent = f.text || '';
      const biome = BIOMES.find((b) => b.name === f.biomeName);
      factTag.textContent = f.biomeName ? `${biome ? biome.icon + ' ' : ''}${f.biomeName}` : '';
      factTag.hidden = !f.biomeName;
      refreshFactCount();
      fact.card.scrollTop = 0;
    });
  }

  // ================= 設定 =================
  const settings = makeModal('settings', 'tw-settings-card');
  let settingsRefs = null;
  {
    const head = h('div', 'tw-card-head');
    head.append(h('h2', 'tw-card-title', '⚙️ 設定'));
    const x = button('tw-close', '✕', '關閉');
    head.append(x);
    x.addEventListener('click', () => { sfx('ui'); closeSettings(); });

    const seg = (a, b) => {
      const s = h('div', 'tw-seg');
      const b1 = button('tw-seg-btn', a);
      const b2 = button('tw-seg-btn', b);
      s.append(b1, b2);
      return [s, b1, b2];
    };
    const row = (label, ctl) => {
      const r = h('div', 'tw-row');
      r.append(h('span', 'tw-row-label', label), ctl);
      return r;
    };
    const [sSound, soundOn, soundOff] = seg('開', '關');
    const [sQual, qHigh, qLow] = seg('高', '低');
    soundOn.addEventListener('click', () => setMuted(false));
    soundOff.addEventListener('click', () => setMuted(true));
    const setQ = (q) => {
      sfx('ui');
      quality = q;
      refreshQuality();
      if (cb.onQuality) cb.onQuality(q);
    };
    qHigh.addEventListener('click', () => setQ('high'));
    qLow.addEventListener('click', () => setQ('low'));

    const resetRow = h('div', 'tw-reset');
    const btnReset = button('tw-btn tw-btn-soft tw-btn-wide', '🔄 重新開始');
    const confirm = h('div', 'tw-confirm');
    confirm.append(h('p', 'tw-confirm-q', '確定要重新開始嗎？目前的進度會被清除喔。'));
    const cRow = h('div', 'tw-btnrow tw-btnrow-tight');
    const cNo = button('tw-btn tw-btn-secondary', '取消');
    const cYes = button('tw-btn tw-btn-danger', '確定重來');
    cRow.append(cNo, cYes);
    confirm.append(cRow);
    resetRow.append(btnReset, confirm);
    btnReset.addEventListener('click', () => { sfx('ui'); resetRow.classList.add('is-confirm'); });
    cNo.addEventListener('click', () => { sfx('ui'); resetRow.classList.remove('is-confirm'); });
    cYes.addEventListener('click', () => {
      sfx('ui');
      closeSettings();
      if (cb.onReset) cb.onReset();
      toast('🌍 重新出發囉！');
    });

    const done = button('tw-btn tw-btn-primary tw-btn-wide', '關閉');
    done.addEventListener('click', () => { sfx('ui'); closeSettings(); });

    settings.card.append(head, row('🔊 音效', sSound), row('✨ 畫質', sQual), resetRow, done);
    settingsRefs = { soundOn, soundOff, qHigh, qLow, resetRow };
  }
  settings.m.addEventListener('click', (e) => { if (e.target === settings.m && guardOk()) { sfx('ui'); closeSettings(); } });

  let quality = storageGet(`${SAVE_KEY}:quality`);
  if (quality !== 'low' && quality !== 'high') {
    const small = Math.min(screen.width || 9999, screen.height || 9999) < 500;
    quality = mqCoarse.matches && small ? 'low' : 'high';
  }
  function refreshQuality() {
    settingsRefs.qHigh.setAttribute('aria-pressed', quality === 'high' ? 'true' : 'false');
    settingsRefs.qLow.setAttribute('aria-pressed', quality === 'low' ? 'true' : 'false');
  }
  function openSettings() {
    if (!started || (current && current !== 'settings')) return;
    openModal('settings', () => {
      settingsRefs.resetRow.classList.remove('is-confirm');
      const q = storageGet(`${SAVE_KEY}:quality`);
      if (q === 'low' || q === 'high') quality = q;
      refreshQuality();
      refreshMute();
    });
  }
  function closeSettings() {
    closeModal('settings');
  }

  // ================= 勝利畫面 =================
  const victory = makeModal('victory', 'tw-victory-card');
  const confetti = h('div', 'tw-confetti');
  confetti.setAttribute('aria-hidden', 'true');
  victory.m.insertBefore(confetti, victory.card);
  const vBadge = h('div', 'tw-victory-badge', '🌍');
  const vTitle = h('h2', 'tw-victory-title', '星球恢復色彩了！');
  const vText = h('p', 'tw-victory-text', '謝謝你，小旅人！花朵重新綻放、森林再次翠綠、海洋閃閃發亮——小地球又變得繽紛美麗了。');
  const vStats = h('div', 'tw-stats');
  function stat(icon, label) {
    const s = h('div', 'tw-stat');
    const v = h('b', 'tw-stat-v', '');
    s.append(h('span', 'tw-stat-ic', icon), v, h('span', 'tw-stat-l', label));
    vStats.append(s);
    return v;
  }
  const vTime = stat('⏱️', '旅程時間');
  const vCrys = stat('💎', '知識晶石');
  const vTree = stat('🌱', '種下幼苗');
  const vBtns = h('div', 'tw-btnrow');
  const vCont = button('tw-btn tw-btn-primary', '繼續漫遊');
  const vReset = button('tw-btn tw-btn-secondary', '重新開始');
  vBtns.append(vCont, vReset);
  victory.card.append(vBadge, vTitle, vText, vStats, vBtns);
  vCont.addEventListener('click', () => { if (!guardOk()) return; sfx('ui'); closeModal('victory'); });
  vReset.addEventListener('click', () => {
    if (!guardOk()) return;
    sfx('ui');
    closeModal('victory');
    if (cb.onReset) cb.onReset();
  });

  const CONFETTI_COLORS = ['#ff8a5c', '#ffd45c', '#5cc98a', '#3b9ae1', '#a37cf0', '#ff7eb6', '#8ef0ff'];
  function buildConfetti() {
    confetti.textContent = '';
    for (let i = 0; i < 42; i++) {
      const p = h('i', 'tw-cf');
      const s = p.style;
      s.left = `${Math.random() * 100}%`;
      s.setProperty('--c', CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      s.setProperty('--d', `${(Math.random() * 1.6).toFixed(2)}s`);
      s.setProperty('--t', `${(2.6 + Math.random() * 2.2).toFixed(2)}s`);
      s.setProperty('--x', `${((Math.random() - 0.5) * 120).toFixed(0)}px`);
      s.setProperty('--r', `${(360 + Math.random() * 720).toFixed(0)}deg`);
      s.width = `${6 + Math.random() * 6}px`;
      s.height = `${10 + Math.random() * 8}px`;
      if (Math.random() < 0.3) p.classList.add('round');
      confetti.append(p);
    }
  }
  function showVictory(stats = {}) {
    openModal('victory', () => {
      const p = lastProgress;
      vTime.textContent = fmtTime(stats.timeSec);
      vCrys.textContent = `${stats.crystals ?? p.crystals}`;
      vTree.textContent = `${stats.trees ?? p.trees}`;
      buildConfetti();
    });
  }

  // ================= 提示訊息 =================
  const toastQueue = [];
  const toastFree = [];
  let toastVisible = [];
  function toast(text, ms = 2200) {
    if (!text) return;
    if (toastVisible.some((t) => t.text === text && !t.leaving) || toastQueue.some((t) => t.text === text)) return;
    toastQueue.push({ text: String(text), ms: Math.max(800, ms || 2200) });
    pumpToasts();
  }
  function pumpToasts() {
    while (toastVisible.length < MAX_TOASTS && toastQueue.length) {
      const { text, ms } = toastQueue.shift();
      const el = toastFree.pop() || h('div', 'tw-toast tw-glass');
      el.textContent = text;
      el.classList.remove('is-out');
      toasts.append(el);
      retrigger(el, 'is-in');
      const rec = { el, text, leaving: false };
      toastVisible.push(rec);
      setTimeout(() => dismissToast(rec), ms);
    }
  }
  function dismissToast(rec) {
    if (rec.leaving) return;
    rec.leaving = true;
    rec.el.classList.add('is-out');
    setTimeout(() => {
      rec.el.remove();
      rec.el.classList.remove('is-in', 'is-out');
      toastFree.push(rec.el);
      toastVisible = toastVisible.filter((r) => r !== rec);
      pumpToasts();
    }, 320);
  }

  // ================= 進度 =================
  function updateProgress(p) {
    if (!p) return;
    const prev = lastProgress;
    const np = {
      crystals: p.crystals | 0,
      totalCrystals: p.totalCrystals || prev.totalCrystals || 12,
      trees: p.trees | 0,
      totalTrees: p.totalTrees || prev.totalTrees || 8,
      done: !!p.done,
    };
    chipC.v.textContent = np.crystals;
    chipC.tot.textContent = `/${np.totalCrystals}`;
    chipT.v.textContent = np.trees;
    chipT.tot.textContent = `/${np.totalTrees}`;
    if (started) {
      if (np.crystals !== prev.crystals) retrigger(chipC.c, 'is-pop');
      if (np.trees !== prev.trees) retrigger(chipT.c, 'is-pop');
    }
    const f = (np.crystals + np.trees) / Math.max(1, np.totalCrystals + np.totalTrees);
    barFill.style.transform = `scaleX(${Math.min(1, Math.max(0, f))})`;
    bar.title = `星球恢復 ${Math.round(f * 100)}%`;
    progress.classList.toggle('is-done', np.done || f >= 1);
    lastProgress = np;
    if (current === 'fact') refreshFactCount();
  }

  // ================= 目標 / 指南針 =================
  const target = new THREE.Vector3();
  let hasTarget = false;
  let targetLabel = '';
  function setTarget(pos, label = '') {
    if (!pos) {
      hasTarget = false;
      return;
    }
    hasTarget = true;
    target.copy(pos);
    if (label !== targetLabel) {
      targetLabel = label || '';
      clabel.textContent = targetLabel || '下一個目標';
    }
  }

  // ================= 表情泡泡 =================
  const bubbles = [];
  const bubbleFree = [];
  function addBubble(getWorldPos, emoji, duration = 2.5) {
    if (typeof getWorldPos !== 'function') return;
    let el = bubbleFree.pop();
    if (!el) {
      el = h('div', 'tw-bubble');
      el.append(h('div', 'tw-bubble-in'));
    }
    el.firstChild.textContent = emoji;
    el.classList.remove('is-out', 'is-hidden');
    el.style.transform = 'translate3d(-999px,-999px,0)';
    worldLayer.append(el);
    retrigger(el.firstChild, 'is-pop');
    bubbles.push({ el, get: getWorldPos, t: 0, dur: Math.max(0.5, duration || 2.5), out: false, vis: true });
  }

  // ================= 每幀更新 =================
  let vw = root.clientWidth || window.innerWidth;
  let vh = root.clientHeight || window.innerHeight;
  const onResize = () => {
    vw = root.clientWidth || window.innerWidth;
    vh = root.clientHeight || window.innerHeight;
  };
  window.addEventListener('resize', onResize);

  const _cam = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _ndc = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _tdir = new THREE.Vector3();
  const _cf = new THREE.Vector3();
  const _cr = new THREE.Vector3();
  const _screen = { x: 0, y: 0 };

  /** 把世界座標投影到螢幕；被鏡頭後方或星球擋住時回傳 false */
  function project(p, camera) {
    _d.subVectors(p, _cam);
    if (_d.dot(_fwd) <= 0.05) return false;
    // 線段 鏡頭→點 是否先撞到半徑 OCCLUDE_R 的球
    const a = _d.dot(_d);
    const b = 2 * _cam.dot(_d);
    const c = _cam.dot(_cam) - OCCLUDE_R * OCCLUDE_R;
    if (c < 0) return false;
    const disc = b * b - 4 * a * c;
    if (disc > 0) {
      const s = (-b - Math.sqrt(disc)) / (2 * a);
      if (s > 0 && s < 1) return false;
    }
    _ndc.copy(p).project(camera);
    _screen.x = (_ndc.x + 1) * 0.5 * vw;
    _screen.y = (1 - _ndc.y) * 0.5 * vh;
    return true;
  }

  let arrowAngle = 0;
  let arrowShown = 0; // 上次寫入 DOM 的角度
  let compassState = ''; // '' | 'arrow' | 'seen'
  let lastDist = -1;
  let compassVisible = false;
  let markerVisible = false;

  function setCompassVisible(v) {
    if (v === compassVisible) return;
    compassVisible = v;
    compass.classList.toggle('is-visible', v);
  }
  function setMarkerVisible(v) {
    if (v === markerVisible) return;
    markerVisible = v;
    marker.classList.toggle('is-visible', v);
  }

  function update(dt, camera, player) {
    if (!camera) return;
    dt = Math.min(dt || 0, 0.1);
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    _fwd.set(0, 0, -1).transformDirection(camera.matrixWorld);

    // ---- 表情泡泡 ----
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.t += dt;
      if (b.t >= b.dur) {
        b.el.remove();
        bubbleFree.push(b.el);
        bubbles.splice(i, 1);
        continue;
      }
      if (!b.out && b.t > b.dur - 0.35) {
        b.out = true;
        b.el.classList.add('is-out');
      }
      let p = null;
      try { p = b.get(_tmp); } catch { p = null; }
      if (!p) p = _tmp;
      _p.copy(p);
      const vis = project(_p, camera);
      if (vis !== b.vis) {
        b.vis = vis;
        b.el.classList.toggle('is-hidden', !vis);
      }
      if (vis) b.el.style.transform = `translate3d(${_screen.x.toFixed(1)}px,${_screen.y.toFixed(1)}px,0)`;
    }

    // ---- 指南針 ----
    if (!started || !hasTarget || !player || !player.position) {
      setCompassVisible(false);
      setMarkerVisible(false);
      return;
    }
    setCompassVisible(true);
    _up.copy(player.position);
    if (_up.lengthSq() < 1e-8) return;
    _up.normalize();
    _tdir.copy(target).normalize();
    const ang = Math.acos(Math.max(-1, Math.min(1, _up.dot(_tdir))));
    const dist = Math.round(ang * METERS_PER_RAD);
    if (dist !== lastDist) {
      lastDist = dist;
      cdist.textContent = dist < 2 ? '就在附近！' : `${dist} 公尺`;
    }

    // 目標是否在畫面上且沒被擋住
    let onScreen = false;
    if (project(target, camera)) {
      const m = 28;
      onScreen = _screen.x > m && _screen.x < vw - m && _screen.y > m + 40 && _screen.y < vh - m;
    }
    if (onScreen) {
      marker.style.transform = `translate3d(${_screen.x.toFixed(1)}px,${_screen.y.toFixed(1)}px,0)`;
    }
    setMarkerVisible(onScreen);

    // 大圓方向：目標方向投影到玩家切平面，再換到鏡頭的螢幕座標
    _tdir.addScaledVector(_up, -_tdir.dot(_up));
    _cf.copy(_fwd).addScaledVector(_up, -_fwd.dot(_up));
    if (_cf.lengthSq() < 1e-4) {
      // 鏡頭幾乎正上方往下看：改用鏡頭的「上」當前方
      _cf.set(0, 1, 0).transformDirection(camera.matrixWorld);
      _cf.addScaledVector(_up, -_cf.dot(_up));
    }
    _cf.normalize();
    _cr.crossVectors(_cf, _up);
    if (_tdir.lengthSq() > 1e-10) {
      const x = _tdir.dot(_cr);
      const y = _tdir.dot(_cf);
      const targetAng = Math.atan2(x, y);
      arrowAngle += wrapAngle(targetAng - arrowAngle) * (1 - Math.exp(-14 * dt));
      arrowAngle = wrapAngle(arrowAngle);
    }
    const deg = arrowAngle * 180 / Math.PI;
    if (Math.abs(deg - arrowShown) > 0.4) {
      arrowShown = deg;
      arrow.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    }
    const st = onScreen ? 'seen' : 'arrow';
    if (st !== compassState) {
      compassState = st;
      compass.classList.toggle('is-seen', onScreen);
    }
  }

  // ================= 鍵盤 =================
  let armedKey = null;
  const CLOSE_KEYS = new Set(['Enter', 'NumpadEnter', 'Escape', 'Space']);
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code || '';
    if (current === 'fact') {
      if (CLOSE_KEYS.has(code) || e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!e.repeat && guardOk()) armedKey = code || e.key;
      }
      return;
    }
    if (current === 'start') {
      if ((e.key === 'Enter' || code === 'NumpadEnter') && !e.repeat) {
        e.preventDefault();
        startPrimary.click();
      }
      return;
    }
    if (current === 'victory') {
      if (e.key === 'Escape' && guardOk()) { e.preventDefault(); vCont.click(); }
      return;
    }
    if (e.key === 'Escape') {
      if (!started || e.repeat) return;
      e.preventDefault();
      if (current === 'settings') { sfx('ui'); closeSettings(); }
      else if (!current) { closePicker(); sfx('ui'); openSettings(); }
      return;
    }
    if (!started || current || e.repeat) return;
    let n = -1;
    if (/^Digit[1-6]$/.test(code)) n = +code.slice(5) - 1;
    else if (/^Numpad[1-6]$/.test(code)) n = +code.slice(6) - 1;
    else if (/^[1-6]$/.test(e.key)) n = +e.key - 1;
    if (n >= 0 && n < EMOTES.length) {
      closePicker();
      triggerEmote(EMOTES[n]);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (current !== 'fact' || !armedKey) return;
    if ((e.code || e.key) === armedKey) {
      armedKey = null;
      closeFact();
    }
  });

  refreshMute();
  refreshQuality();
  updateProgress(lastProgress);

  return {
    showStart,
    hideStart,
    showFact,
    isModalOpen,
    toast,
    updateProgress,
    addBubble,
    setTarget,
    showVictory,
    update,
  };
}
