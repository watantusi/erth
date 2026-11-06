// 分身 5：介面（開始畫面、HUD、指南針、表情、知識卡、設定、勝利畫面、提示訊息、表情泡泡）
// v2：居民對話框、任務追蹤、分級指南針（setNav）、互動提示、地圖碎片彈窗
// v3：知識測驗、解鎖彈窗、衣櫥、圖鑑、計時挑戰（倒數、計時器、成績）、日夜循環設定
import * as THREE from 'three';
import * as CFG from './config.js';
import { EMOTES, SAVE_KEY, GAME_TITLE, GAME_SUBTITLE, BIOMES, PING_DURATION, TOTAL_QUESTS } from './config.js';

const OCCLUDE_R = 29.3;     // 判斷被星球擋住用的半徑
const METERS_PER_RAD = 30;  // 球面弧長換算：角度 × 30
const MAX_TOASTS = 3;
const MODAL_GUARD_MS = 400;
const DLG_GUARD_MS = 250;   // 對話框：防止誤觸的最短間隔
const DLG_CPS = 45;         // 逐字顯示速度（字/秒）
const DLG_PAUSE = { '，': 0.08, '、': 0.08, ',': 0.08, '。': 0.18, '！': 0.18, '？': 0.18, '!': 0.15, '?': 0.15, '…': 0.12, '⋯': 0.12, '～': 0.1 };
const QUEST_DONE_MS = 3000; // 完成的任務顯示 ✓ 多久後淡出
const QUEST_NEW_MS = 2600;  // 「新任務！」標籤顯示多久
const NARROW_MQ = '(max-width: 719px)'; // 窄螢幕：指南針移到左欄
const RADAR_ZONE_BOTTOM = 84 + 112;     // 右上雷達區的底部（不含 safe area）
const PING_TOTAL = PING_DURATION || 20;
const QUESTS_TOTAL = TOTAL_QUESTS || 6;
const RING_C = 2 * Math.PI * 22;        // 訊號倒數圈的周長（r = 22，viewBox 48）
const NAV_HINT_FIRST = 4;   // Lv0 提示：開始後幾秒第一次出現
const NAV_HINT_EVERY = 75;  // 之後每隔幾秒出現
const NAV_HINT_SHOW = 7;    // 每次顯示幾秒
const MEDALS = CFG.TRIAL_MEDALS || { gold: 90, silver: 140, bronze: 220 };
const MEDAL_ICON = { gold: '🥇', silver: '🥈', bronze: '🥉' };
const MEDAL_NAME = { gold: '金牌', silver: '銀牌', bronze: '銅牌' };
const DEFAULT_SLOTS = [{ id: 'hat', name: '帽子' }, { id: 'scarf', name: '圍巾' }, { id: 'trail', name: '腳印特效' }];
const SLOT_ICON = { hat: '🎩', scarf: '🧣', trail: '👣' };
const NONE_ITEM = { hat: { icon: '🙅', name: '不戴帽子' }, trail: { icon: '🚫', name: '不要特效' } };
const SCARF_COLORS = { sunny: '#ffcf4d', sky: '#5fb4f0', mint: '#5fd3a0', rose: '#ff8fb4', lava: '#ff6a3d', night: '#3a4a8c' };

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
/** 計時挑戰用：mm:ss.s（無效值顯示 —） */
function fmtTrial(sec) {
  if (sec === null || sec === undefined || !isFinite(sec) || sec < 0) return '—';
  const tenths = Math.floor(sec * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenths % 10}`;
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
  const chipQ = makeChip('📜', '任務');
  chipQ.c.hidden = true;
  const bar = h('div', 'tw-bar');
  const barFill = h('div', 'tw-bar-fill');
  bar.append(barFill);
  // v3：星星數放在進度條右邊（不加寬進度卡）
  const progFoot = h('div', 'tw-progress-foot');
  const starPill = h('div', 'tw-starpill');
  starPill.setAttribute('aria-label', '測驗星星');
  const starIc = h('span', 'tw-starpill-ic', '⭐');
  const starV = h('b', 'tw-starpill-v', '0');
  starPill.append(starIc, starV);
  starPill.hidden = true;
  progFoot.append(bar, starPill);
  progress.append(chips, progFoot);

  // ================= HUD：指南針 =================
  const compass = h('div', 'tw-compass tw-glass');
  const crow = h('div', 'tw-compass-row');
  const dial = h('div', 'tw-compass-dial');
  const pingRing = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  pingRing.setAttribute('viewBox', '0 0 48 48');
  pingRing.setAttribute('class', 'tw-compass-ring');
  pingRing.setAttribute('aria-hidden', 'true');
  pingRing.innerHTML = `<circle class="tw-ring-bg" cx="24" cy="24" r="22"/><circle class="tw-ring-fg" cx="24" cy="24" r="22" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="0"/>`;
  const ringFg = pingRing.querySelector('.tw-ring-fg');
  const arrow = h('div', 'tw-compass-arrow');
  arrow.innerHTML = ARROW_SVG;
  const seen = h('div', 'tw-compass-seen', '👀');
  const biomeIc = h('div', 'tw-compass-biome', '🌼');
  dial.append(pingRing, arrow, seen, biomeIc);
  const ctext = h('div', 'tw-compass-text');
  const clabel = h('div', 'tw-compass-label', '');
  const cdist = h('div', 'tw-compass-dist', '');
  ctext.append(clabel, cdist);
  const pips = h('div', 'tw-pips');
  pips.setAttribute('aria-label', '指南針等級 0');
  const pipEls = [0, 1, 2].map(() => { const i = h('i', 'tw-pip'); pips.append(i); return i; });
  crow.append(dial, ctext, pips);
  const chint = h('div', 'tw-compass-hint');
  chint.append(h('span', 'tw-compass-hint-in', '🗺️ 幫助居民拿到地圖碎片，就能解鎖指南針'));
  compass.append(crow, chint);

  // ================= HUD：任務追蹤（左上，進度卡下方） =================
  const quests = h('div', 'tw-quests');
  quests.setAttribute('aria-live', 'polite');
  const questMore = h('div', 'tw-quest-more tw-glass', '');
  questMore.hidden = true;
  quests.append(questMore);

  // 左欄：進度 →（窄螢幕時）指南針 → 任務
  const leftCol = h('div', 'tw-left');
  leftCol.append(progress, quests);

  // ================= HUD：互動提示（下方中央） =================
  const prompt = h('div', 'tw-prompt tw-glass');
  prompt.setAttribute('aria-live', 'polite');

  const toasts = h('div', 'tw-toasts');
  toasts.setAttribute('aria-live', 'polite');

  // ================= HUD：右上按鈕 =================
  const topRight = h('div', 'tw-topright');
  const btnSettings = button('tw-iconbtn tw-glass', '⚙️', '設定');
  const btnMute = button('tw-iconbtn tw-glass', '🔊', '音效開關');
  topRight.append(btnSettings, btnMute);

  // ================= HUD（v3）：衣櫥 / 圖鑑 =================
  // 預設在右側、雷達下方（和表情鈕對齊）；矮的橫向畫面改到右上按鈕列旁邊（見 ui.css）
  const side = h('div', 'tw-side');
  function sideBtn(icon, label, key) {
    const b = button('tw-sidebtn tw-glass', '', label);
    b.append(h('span', 'tw-sidebtn-ic', icon), h('span', 'tw-sidebtn-l', label), h('i', 'tw-sidebtn-dot'));
    if (key) b.title = `${label}（${key}）`;
    side.append(b);
    return b;
  }
  const btnBag = sideBtn('🎒', '衣櫥', 'B');
  const btnBook = sideBtn('📖', '圖鑑', 'J');

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

  hud.append(leftCol, compass, toasts, topRight, side, emoteWrap, prompt);

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

  // 這幾種對話框同名時也要排隊（不覆蓋正在顯示的內容）
  const QUEUE_SAME = new Set(['dialogue', 'fragment', 'fact', 'quiz', 'unlock', 'countdown', 'result']);
  // 開始畫面強制關閉時，讓正在等待的 Promise 結束
  const forced = {};
  function openModal(name, setup, abort) {
    if (current && (current !== name || QUEUE_SAME.has(name))) {
      queue.push([name, setup, abort]);
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
    hud.classList.toggle('is-talking', name === 'dialogue');
    hud.classList.toggle('is-wardrobe', name === 'wardrobe');
    hud.classList.toggle('is-quiet', name === 'countdown');
  }
  function closeModal(name) {
    if (current !== name) return;
    const m = modals[name];
    m.classList.remove('is-open');
    m.hidden = true;
    current = null;
    hud.classList.remove('is-dimmed', 'is-talking', 'is-wardrobe', 'is-quiet');
    armedKey = null;
    if (queue.length) {
      const [n, s, a] = queue.shift();
      openModal(n, s, a);
    }
  }
  /** 清掉排隊中的對話框（開始畫面用）；排隊中的 Promise 以 undefined 結束 */
  function flushQueue() {
    const q = queue.splice(0);
    for (const [, , abort] of q) { try { abort && abort(); } catch { /* 忽略 */ } }
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

  const story = h('p', 'tw-story', '小小的地球正在褪色⋯⋯收集 12 顆知識晶石、種下 8 棵幼苗、幫助 6 位居民，讓星球重新繽紛起來！');
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
      ? [['🕹️', '左邊拖曳移動'], ['👆', '右邊滑動轉視角'], ['⤴️', '按跳躍鈕'], ['💬', '靠近居民點對話鈕']]
      : [['WASD', '移動', '方向鍵'], ['Shift', '跑步'], ['空白鍵', '跳'], ['F', '對話'], ['🖱️', '拖曳轉視角'], ['滾輪', '縮放'], ['1–6', '表情']];
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
    flushQueue();
    if (current && current !== 'start') {
      const m = modals[current];
      m.classList.remove('is-open');
      m.hidden = true;
      if (current === 'dialogue') abortDialogue();
      const f = forced[current];
      current = null;
      hud.classList.remove('is-dimmed', 'is-talking', 'is-wardrobe', 'is-quiet');
      if (f) { try { f(); } catch { /* 忽略 */ } }
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
    startedAt = performance.now();
    root.classList.add('is-playing');
    refreshMute();
    refreshSideVisibility();
    if (cb.getJournal) {
      try { const j = cb.getJournal(); if (j && typeof j.stars === 'number') setStars(j.stars, false); } catch { /* 忽略 */ }
    }
    requestAnimationFrame(relayout);
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
  let factResolve = null;
  function closeFact() {
    if (current !== 'fact') return;
    sfx('ui');
    const r = factResolve;
    factResolve = null;
    closeModal('fact');
    if (r) r();
  }
  forced.fact = () => { const r = factResolve; factResolve = null; if (r) r(); };
  factBtn.addEventListener('click', () => { if (guardOk()) closeFact(); });
  fact.m.addEventListener('click', (e) => { if (e.target === fact.m && guardOk()) closeFact(); });

  function showFact(f = {}) {
    return new Promise((resolve) => {
      openModal('fact', () => {
        factResolve = resolve;
        setupFact(f || {});
      }, () => resolve());
      bookNew = true;
      refreshSideBadges();
    });
  }
  function setupFact(f) {
    {
      factIcon.textContent = f.icon || '💎';
      factTitle.textContent = f.title || '';
      factText.textContent = f.text || '';
      const biome = BIOMES.find((b) => b.name === f.biomeName);
      factTag.textContent = f.biomeName ? `${biome ? biome.icon + ' ' : ''}${f.biomeName}` : '';
      factTag.hidden = !f.biomeName;
      refreshFactCount();
      fact.card.scrollTop = 0;
    }
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

    // v3：日夜循環、計時挑戰
    const [sDay, dayOn, dayOff] = seg('開', '關');
    const setDay = (on) => {
      sfx('ui');
      dayNight = on;
      refreshDayNight();
      if (cb.onDayNight) cb.onDayNight(on);
    };
    dayOn.addEventListener('click', () => setDay(true));
    dayOff.addEventListener('click', () => setDay(false));
    const dayRow = row('🌗 日夜循環', sDay);
    const trialRow = h('div', 'tw-trialrow');
    const btnTrial = button('tw-btn tw-btn-gold tw-btn-wide', '⏱️ 計時挑戰');
    trialRow.append(btnTrial, h('p', 'tw-trialrow-note', '收集 8 顆時光晶石，挑戰最快紀錄！'));
    btnTrial.addEventListener('click', () => {
      sfx('ui');
      closeSettings();
      if (cb.onTimeTrial) cb.onTimeTrial();
    });

    settings.card.append(head, row('🔊 音效', sSound), row('✨ 畫質', sQual), dayRow, trialRow, resetRow, done);
    settingsRefs = { soundOn, soundOff, qHigh, qLow, resetRow, dayOn, dayOff, trialRow };
  }
  settings.m.addEventListener('click', (e) => { if (e.target === settings.m && guardOk()) { sfx('ui'); closeSettings(); } });

  let quality = storageGet(`${SAVE_KEY}:quality`);
  if (quality !== 'low' && quality !== 'high') {
    const small = Math.min(screen.width || 9999, screen.height || 9999) < 500;
    quality = mqCoarse.matches && small ? 'low' : 'high';
  }
  let dayNight = true;
  function refreshDayNight() {
    settingsRefs.dayOn.setAttribute('aria-pressed', dayNight ? 'true' : 'false');
    settingsRefs.dayOff.setAttribute('aria-pressed', dayNight ? 'false' : 'true');
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
      try { const d = cb.getDayNight ? cb.getDayNight() : undefined; if (typeof d === 'boolean') dayNight = d; } catch { /* 忽略 */ }
      refreshDayNight();
      let can = false;
      try { can = !!(cb.canTimeTrial && cb.canTimeTrial()); } catch { can = false; }
      settingsRefs.trialRow.hidden = !can || !cb.onTimeTrial;
      settings.card.scrollTop = 0;
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
  const vQuest = stat('📜', '完成任務');
  const vFrag = stat('🗺️', '地圖碎片');
  const vBtns = h('div', 'tw-btnrow');
  const vCont = button('tw-btn tw-btn-primary', '繼續漫遊');
  const vReset = button('tw-btn tw-btn-secondary', '重新開始');
  const vTrial = button('tw-btn tw-btn-gold tw-victory-trial', '⏱️ 計時挑戰');
  vBtns.append(vCont, vTrial, vReset);
  vTrial.addEventListener('click', () => {
    if (!guardOk()) return;
    sfx('ui');
    closeModal('victory');
    if (cb.onTimeTrial) cb.onTimeTrial();
  });
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
    fillConfetti(confetti, 42);
  }
  function fillConfetti(container, n) {
    for (let i = 0; i < n; i++) {
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
      container.append(p);
    }
  }
  function showVictory(stats = {}) {
    openModal('victory', () => {
      const p = lastProgress;
      vTime.textContent = fmtTime(stats.timeSec);
      vCrys.textContent = `${stats.crystals ?? p.crystals}`;
      vTree.textContent = `${stats.trees ?? p.trees}`;
      const q = stats.quests ?? p.quests;
      const fr = stats.fragments ?? p.fragments;
      vQuest.textContent = `${q ?? 0}`;
      vFrag.textContent = `${fr ?? 0}`;
      vQuest.parentElement.hidden = q === undefined && !p.hasQuests;
      vFrag.parentElement.hidden = fr === undefined && !p.hasQuests;
      vStats.classList.toggle('is-five', !vQuest.parentElement.hidden && !vFrag.parentElement.hidden);
      vTrial.hidden = !cb.onTimeTrial;
      vBtns.classList.toggle('is-three', !vTrial.hidden);
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
    if (toastQueue.length && toastVisible.length < MAX_TOASTS) layoutToasts();
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
      quests: p.quests | 0,
      totalQuests: p.totalQuests || 0,
      fragments: p.fragments | 0,
      hasQuests: !!p.totalQuests,
      done: !!p.done,
    };
    chipC.v.textContent = np.crystals;
    chipC.tot.textContent = `/${np.totalCrystals}`;
    chipT.v.textContent = np.trees;
    chipT.tot.textContent = `/${np.totalTrees}`;
    chipQ.c.hidden = !np.hasQuests;
    chipQ.v.textContent = np.quests;
    chipQ.tot.textContent = `/${np.totalQuests || QUESTS_TOTAL}`;
    chips.classList.toggle('is-three', np.hasQuests);
    if (started) {
      if (np.crystals !== prev.crystals) retrigger(chipC.c, 'is-pop');
      if (np.trees !== prev.trees) retrigger(chipT.c, 'is-pop');
      if (np.hasQuests && np.quests !== prev.quests) retrigger(chipQ.c, 'is-pop');
    }
    const f = (np.crystals + np.trees + (np.hasQuests ? np.quests : 0))
      / Math.max(1, np.totalCrystals + np.totalTrees + (np.hasQuests ? np.totalQuests : 0));
    barFill.style.transform = `scaleX(${Math.min(1, Math.max(0, f))})`;
    bar.title = `星球恢復 ${Math.round(f * 100)}%`;
    progress.classList.toggle('is-done', np.done || f >= 1);
    lastProgress = np;
    // v3：星星數（progress.stars 或圖鑑資料）
    let st = typeof p.stars === 'number' ? p.stars : undefined;
    if (st === undefined && cb.getJournal) {
      try { const j = cb.getJournal(); if (j && typeof j.stars === 'number') st = j.stars; } catch { /* 忽略 */ }
    }
    if (st !== undefined) setStars(st, started);
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

  // ================= 居民對話（視覺小說式，modal） =================
  const dlg = makeModal('dialogue', 'tw-dlg-card');
  dlg.m.classList.add('tw-modal-dlg');
  const dlgPortrait = h('div', 'tw-dlg-portrait');
  const dlgIcon = h('span', 'tw-dlg-icon', '💬');
  dlgPortrait.append(dlgIcon);
  const dlgName = h('div', 'tw-dlg-name', '');
  const dlgText = h('p', 'tw-dlg-text');
  const dlgTyped = h('span', 'tw-dlg-typed');
  const dlgRest = h('span', 'tw-dlg-rest');
  dlgRest.setAttribute('aria-hidden', 'true');
  dlgText.append(dlgTyped, dlgRest);
  const dlgFoot = h('div', 'tw-dlg-foot');
  const dlgDots = h('div', 'tw-dlg-dots');
  dlgDots.setAttribute('aria-hidden', 'true');
  const dlgChoices = h('div', 'tw-dlg-choices');
  const dlgNext = h('div', 'tw-dlg-next', '▼');
  dlgNext.setAttribute('aria-hidden', 'true');
  dlgFoot.append(dlgDots, dlgChoices, dlgNext);
  dlg.card.append(dlgPortrait, dlgName, dlgText, dlgFoot);

  const D = {
    token: null, resolve: null, lines: [], idx: 0, chars: [], shown: 0, budget: 0,
    typing: false, raf: 0, lastT: 0, finishedAt: 0, choices: null, choicesAt: Infinity,
    single: true, defaultValue: undefined,
  };

  function dlgRender() {
    dlgTyped.textContent = D.chars.slice(0, D.shown).join('');
    dlgRest.textContent = D.chars.slice(D.shown).join('');
  }
  function dlgStartLine(i) {
    D.idx = i;
    D.chars = Array.from(D.lines[i] || '');
    D.shown = 0;
    D.budget = 0;
    D.typing = true;
    dlgRender();
    dlgText.scrollTop = 0;
    dlg.card.classList.remove('is-ready', 'is-choosing');
    dlgChoices.textContent = '';
    for (let k = 0; k < dlgDots.children.length; k++) dlgDots.children[k].classList.toggle('on', k <= i);
    sfx('talk');
    retrigger(dlgPortrait, 'is-talk');
    if (!D.raf) {
      D.lastT = performance.now();
      D.raf = requestAnimationFrame(dlgTick);
    }
  }
  function dlgTick(now) {
    D.raf = 0;
    if (!D.typing) return;
    const dt = Math.min(0.25, Math.max(0, (now - D.lastT) / 1000)); // 幀率很低時也維持約略的速度
    D.lastT = now;
    if (current === 'dialogue') {
      D.budget += dt * DLG_CPS;
      let changed = false;
      while (D.budget >= 1 && D.shown < D.chars.length) {
        D.shown++;
        D.budget -= 1;
        changed = true;
        const p = DLG_PAUSE[D.chars[D.shown - 1]];
        if (p && D.shown < D.chars.length) { D.budget -= p * DLG_CPS; break; }
      }
      if (changed) dlgRender();
      if (D.shown >= D.chars.length) { dlgFinishLine(); return; }
    }
    D.raf = requestAnimationFrame(dlgTick);
  }
  function dlgFinishLine() {
    D.typing = false;
    if (D.raf) { cancelAnimationFrame(D.raf); D.raf = 0; }
    D.shown = D.chars.length;
    dlgRender();
    D.finishedAt = performance.now();
    if (D.idx >= D.lines.length - 1) dlgShowChoices();
    else dlg.card.classList.add('is-ready');
  }
  function dlgShowChoices() {
    const list = D.choices && D.choices.length ? D.choices : [{ label: '好！', value: undefined }];
    const token = D.token;
    dlgChoices.textContent = '';
    list.forEach((c, i) => {
      const b = button(`tw-btn ${i === 0 ? 'tw-btn-primary' : 'tw-btn-secondary'} tw-dlg-choice`, String(c.label ?? '好！'));
      b.style.setProperty('--i', i);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (D.token !== token || performance.now() - D.choicesAt < DLG_GUARD_MS) return;
        dlgPick(c.value);
      });
      dlgChoices.append(b);
    });
    D.single = list.length === 1;
    D.defaultValue = list[0].value;
    D.choicesAt = performance.now();
    dlg.card.classList.add('is-choosing');
    if (!mqCoarse.matches) {
      try { dlgChoices.firstChild.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    }
  }
  function dlgPick(value) {
    if (current !== 'dialogue' || !D.resolve) return;
    sfx('ui');
    const r = D.resolve;
    D.resolve = null;
    D.token = null;
    D.typing = false;
    try { document.activeElement && dlg.m.contains(document.activeElement) && document.activeElement.blur(); } catch { /* 忽略 */ }
    closeModal('dialogue'); // 可能立刻打開排隊中的下一段
    r(value);
  }
  /** 點一下／按鍵：打完這句 → 下一句 → （最後一句只有一個選項時）關閉 */
  function dlgAdvance(fromKey) {
    if (current !== 'dialogue') return;
    const now = performance.now();
    if (now - openedAt < DLG_GUARD_MS) return;
    if (D.typing) { dlgFinishLine(); return; }
    if (now - D.finishedAt < 160) return; // 連點保護
    if (D.idx < D.lines.length - 1) { dlgStartLine(D.idx + 1); return; }
    if (now - D.choicesAt < DLG_GUARD_MS) return;
    if (fromKey) {
      const f = document.activeElement;
      if (f && f.parentElement === dlgChoices) { f.click(); return; }
    }
    if (D.single) dlgPick(D.defaultValue);
  }
  dlg.m.addEventListener('click', () => dlgAdvance(false));
  // 點背景不要搶走選項按鈕的焦點（鍵盤使用者可以繼續用方向鍵選）
  dlg.m.addEventListener('mousedown', (e) => { if (!e.target.closest('button')) e.preventDefault(); });
  function abortDialogue() {
    D.typing = false;
    if (D.resolve) {
      const r = D.resolve;
      D.resolve = null;
      D.token = null;
      r(undefined);
    }
  }

  function showDialogue({ name = '', icon = '💬', lines = [], choices = null } = {}) {
    return new Promise((resolve) => {
      const token = {};
      openModal('dialogue', () => {
        D.token = token;
        D.resolve = resolve;
        const arr = Array.isArray(lines) ? lines : [lines];
        D.lines = arr.filter((l) => l !== null && l !== undefined && l !== '').map(String);
        if (!D.lines.length) D.lines = ['⋯⋯'];
        D.choices = Array.isArray(choices) ? choices.filter((c) => c && typeof c === 'object') : null;
        D.choicesAt = Infinity;
        dlgIcon.textContent = icon || '💬';
        dlgName.textContent = name || '';
        dlgName.hidden = !name;
        dlg.m.setAttribute('aria-label', name ? `${name} 說` : '對話');
        dlgDots.textContent = '';
        if (D.lines.length > 1) for (let i = 0; i < D.lines.length; i++) dlgDots.append(h('i'));
        dlgStartLine(0);
      }, () => resolve(undefined));
    });
  }

  // ================= 地圖碎片彈窗 =================
  const frag = makeModal('fragment', 'tw-frag-card');
  frag.m.classList.add('tw-modal-frag');
  const fragMap = h('div', 'tw-frag-map');
  fragMap.setAttribute('aria-hidden', 'true');
  const fragPieces = [];
  for (let i = 0; i < QUESTS_TOTAL; i++) {
    const p = h('i', 'tw-frag-piece');
    p.style.setProperty('--c', i % 3);
    p.style.setProperty('--r', Math.floor(i / 3));
    fragMap.append(p);
    fragPieces.push(p);
  }
  const fragBody = h('div', 'tw-frag-body');
  const fragKicker = h('div', 'tw-kicker', '');
  const fragTitle = h('h2', 'tw-frag-title', '');
  const fragText = h('p', 'tw-frag-text', '');
  const fragLevel = h('div', 'tw-frag-level');
  const fragLvLabel = h('span', 'tw-frag-lv-l', '🧭 指南針');
  const fragPipsEl = h('span', 'tw-frag-pips');
  const fragPips = [0, 1, 2].map(() => { const i = h('i', 'tw-pip'); fragPipsEl.append(i); return i; });
  const fragLvNum = h('b', 'tw-frag-lv-n', 'Lv 0');
  fragLevel.append(fragLvLabel, fragPipsEl, fragLvNum);
  const fragBtn = button('tw-btn tw-btn-primary tw-btn-wide', '太棒了！');
  fragBody.append(fragKicker, fragTitle, fragText, fragLevel, fragBtn);
  frag.card.append(fragMap, fragBody);
  function closeFragment() {
    if (current !== 'fragment') return;
    sfx('ui');
    closeModal('fragment');
  }
  fragBtn.addEventListener('click', () => { if (guardOk()) closeFragment(); });
  frag.m.addEventListener('click', (e) => { if (e.target === frag.m && guardOk()) closeFragment(); });

  function showFragment({ fragments = 1, level = 1, title = '', text = '' } = {}) {
    openModal('fragment', () => {
      const n = Math.max(0, Math.min(QUESTS_TOTAL, fragments | 0));
      const lv = Math.max(0, Math.min(3, level | 0));
      const prev = Math.min(lv, Math.max(0, Math.min(3, n - 1)));
      fragPieces.forEach((p, i) => {
        p.classList.remove('is-have', 'is-new');
        if (i < n - 1) p.classList.add('is-have');
        else if (i === n - 1) p.classList.add('is-new');
      });
      fragKicker.textContent = `取得地圖碎片！(${n}/${QUESTS_TOTAL})`;
      fragTitle.textContent = title || (lv > prev ? '指南針升級了！' : '地圖又更完整了！');
      fragText.textContent = text || '';
      fragText.hidden = !text;
      fragPips.forEach((p, i) => {
        p.classList.remove('on', 'fill');
        if (i < prev) p.classList.add('on');
        else if (i < lv) { p.classList.add('fill'); p.style.setProperty('--d', `${0.75 + (i - prev) * 0.25}s`); }
      });
      fragLvNum.textContent = lv >= 3 ? 'Lv 3 MAX' : `Lv ${lv}`;
      retrigger(fragLvNum, 'is-up');
      frag.card.scrollTop = 0;
    });
  }

  // ================= 任務追蹤 =================
  const questMap = new Map(); // id → { el, ic, title, prog, state, timer }
  let questSig = null;
  let questMax = 3;
  let startedAt = 0;

  function makeQuest() {
    const el = h('div', 'tw-quest tw-glass');
    const ic = h('span', 'tw-quest-ic', '');
    const body = h('div', 'tw-quest-body');
    const title = h('div', 'tw-quest-title', '');
    const prog = h('div', 'tw-quest-prog', '');
    body.append(title, prog);
    const badge = h('span', 'tw-quest-new', '新任務！');
    el.append(ic, body, badge);
    return { el, ic, title, prog, state: '', icon: '', timer: 0, leaving: false };
  }
  function removeQuest(id, r) {
    if (r.leaving) return;
    r.leaving = true;
    clearTimeout(r.timer);
    r.el.classList.add('is-leaving');
    setTimeout(() => {
      r.el.remove();
      if (questMap.get(id) === r) questMap.delete(id);
      layoutQuests();
    }, 420);
  }
  function setQuests(list) {
    list = Array.isArray(list) ? list : [];
    const sig = list.map((q) => (q ? `${q.id}\u0001${q.icon}\u0001${q.title}\u0001${q.progress}\u0001${q.state}` : '')).join('\u0002');
    if (sig === questSig) return;
    questSig = sig;
    const now = performance.now();
    const quiet = !started || now - startedAt < 1500; // 讀檔還原時不要每個都喊「新任務」
    const seenIds = new Set();
    const order = [];
    for (const q of list) {
      if (!q || q.id === undefined || q.id === null) continue;
      const id = String(q.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const done = q.state === 'done';
      let r = questMap.get(id);
      if (r && r.leaving) {
        if (done) continue;
        r = null; // 淡出中又變回進行中：重建
      }
      if (!r) {
        if (done) continue; // 第一次看到就已完成（讀檔、或已淡出）→ 不顯示
        r = makeQuest();
        questMap.set(id, r);
        if (!quiet) {
          r.el.classList.add('is-new');
          setTimeout(() => r.el.classList.remove('is-new'), QUEST_NEW_MS);
        }
      }
      const icon = done ? '✓' : (q.icon || '📜');
      if (r.icon !== icon) { r.icon = icon; r.ic.textContent = icon; }
      const title = String(q.title ?? '');
      if (r.title.textContent !== title) r.title.textContent = title;
      const prog = done ? '完成！' : String(q.progress ?? '');
      if (r.prog.textContent !== prog) {
        const had = r.prog.textContent !== '';
        r.prog.textContent = prog;
        if (had && !quiet && !done) retrigger(r.prog, 'is-bump');
      }
      if (done && r.state !== 'done') {
        r.el.classList.remove('is-new');
        retrigger(r.el, 'is-done');
        r.timer = setTimeout(() => removeQuest(id, r), QUEST_DONE_MS);
      }
      r.state = done ? 'done' : 'active';
      order.push(r);
    }
    // 名單上消失的任務：淡出
    for (const [id, r] of questMap) {
      if (!seenIds.has(id) && !r.leaving) {
        if (r.state === 'done') continue; // 等 ✓ 計時器結束
        removeQuest(id, r);
      }
    }
    // 依名單順序排列（淡出中的維持原位）
    let ref = quests.firstChild;
    for (const r of order) {
      if (r.el !== ref) quests.insertBefore(r.el, ref);
      else ref = ref.nextSibling;
    }
    quests.append(questMore);
    layoutQuests();
    if (order.length) measureQuestMax();
  }
  function layoutQuests() {
    const items = [...quests.children].filter((e) => e !== questMore);
    let shown = 0, hidden = 0;
    for (const el of items) {
      const leaving = el.classList.contains('is-leaving');
      if (shown < questMax || leaving) {
        el.classList.remove('is-overflow');
        if (!leaving) shown++;
      } else {
        el.classList.add('is-overflow');
        hidden++;
      }
    }
    questMore.hidden = hidden === 0;
    if (hidden) questMore.textContent = `+${hidden} 個任務`;
  }
  function measureQuestMax() {
    const top = quests.getBoundingClientRect().top || 0;
    // 畫面高度 56% 以下留給左下的搖桿；每張卡的高度用實際量到的（單行約 34px、雙行約 44px），留一點給「+N」
    const card = quests.querySelector('.tw-quest:not(.is-overflow)');
    const itemH = (card && card.offsetHeight ? card.offsetHeight : 36) + 6;
    const avail = vh * 0.56 - top - 28;
    const m = Math.max(1, Math.min(3, Math.floor(avail / itemH)));
    if (m !== questMax) { questMax = m; layoutQuests(); }
  }

  // ================= 互動提示 =================
  let promptText = null;
  function setPrompt(text) {
    text = text ? String(text) : null;
    if (text === promptText) return;
    promptText = text;
    hud.classList.toggle('has-prompt', !!text);
    if (!text) { prompt.classList.remove('is-visible'); return; }
    prompt.textContent = '';
    const m = /^([A-Za-z0-9]|Enter|Space|空白鍵)\s+(.+)$/.exec(text);
    if (m) prompt.append(h('kbd', 'tw-kbd', m[1]), h('span', 'tw-prompt-t', m[2]));
    else prompt.append(h('span', 'tw-prompt-t', text));
    prompt.classList.add('is-visible');
    retrigger(prompt, 'is-pop');
  }

  // ================= 分級指南針（v2） =================
  let navMode = false;   // setNav 呼叫過就以 setNav 為準
  let nav = null;
  let navLevel = -1;
  let navHintClock = 0;
  let navHintOn = false;
  let pingOn = false;
  let pingUrgent = false;
  let lastRingOff = -1;
  const txt = new WeakMap();
  function setText(el, s) {
    if (txt.get(el) === s) return;
    txt.set(el, s);
    el.textContent = s;
  }
  function setNav(n) {
    navMode = true;
    nav = n || null;
    if (!nav) return;
    const lv = Math.max(0, Math.min(3, nav.level | 0));
    if (lv !== navLevel) {
      const up = navLevel >= 0 && lv > navLevel;
      navLevel = lv;
      pipEls.forEach((p, i) => p.classList.toggle('on', i < lv));
      pips.setAttribute('aria-label', `指南針等級 ${lv}`);
      compass.classList.toggle('is-lv0', lv === 0);
      if (up) retrigger(compass, 'is-levelup');
    }
  }
  function setNavHint(on) {
    if (on === navHintOn) return;
    navHintOn = on;
    compass.classList.toggle('has-hint', on);
  }
  function setPing(sec) {
    const on = sec > 0;
    if (on !== pingOn) {
      pingOn = on;
      compass.classList.toggle('is-ping', on);
      if (on) retrigger(compass, 'is-pingstart');
    }
    if (!on) return;
    const off = Math.round(RING_C * (1 - Math.max(0, Math.min(1, sec / PING_TOTAL))) * 10) / 10;
    if (off !== lastRingOff) {
      lastRingOff = off;
      ringFg.setAttribute('stroke-dashoffset', off.toFixed(1));
    }
    const urgent = sec < 5;
    if (urgent !== pingUrgent) {
      pingUrgent = urgent;
      compass.classList.toggle('is-urgent', urgent);
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
  let compassBadge = false;
  let markerVisible = false;

  function setCompassVisible(v) {
    if (v === compassVisible) return;
    compassVisible = v;
    compass.classList.toggle('is-visible', v);
    layoutToasts();
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
    let tgt = null;
    let label = '';
    let showDist = true;
    let ping = 0;
    if (navMode) {
      if (!started || !nav || !player || !player.position) {
        setCompassVisible(false);
        setMarkerVisible(false);
        return;
      }
      ping = Math.max(0, +nav.ping || 0);
      const t = nav.target;
      if (nav.showArrow && t && t.position) {
        tgt = t.position;
        label = t.label || '下一個目標';
        showDist = !!nav.showDistance;
      }
      // Lv0 偶爾出現的提示（不在訊號期間、不在對話框開著時計時）
      if (navLevel === 0 && !ping) {
        if (!current) navHintClock += dt;
        const k = navHintClock - NAV_HINT_FIRST;
        setNavHint(k >= 0 && k % NAV_HINT_EVERY < NAV_HINT_SHOW);
      } else {
        setNavHint(false);
      }
    } else {
      if (!started || !hasTarget || !player || !player.position) {
        setCompassVisible(false);
        setMarkerVisible(false);
        return;
      }
      tgt = target;
      label = targetLabel || '下一個目標';
    }
    setCompassVisible(true);
    setPing(ping);
    const badge = !tgt;
    if (badge !== compassBadge) {
      compassBadge = badge;
      compass.classList.toggle('is-badge', badge);
    }
    const biome = navMode && nav.biome ? nav.biome : null;

    if (badge) {
      // 沒有箭頭：顯示目前生態區與剩餘晶石
      setMarkerVisible(false);
      setText(biomeIc, (biome && biome.icon) || '🧭');
      setText(clabel, (biome && biome.name) || '探索中');
      const left = nav.biomeLeft;
      let line = '';
      if (left && typeof left.crystals === 'number') line = left.crystals > 0 ? `💎 還有 ${left.crystals} 顆` : '💎 這裡都找齊了！';
      setText(cdist, line);
      return;
    }

    setText(clabel, label);
    _up.copy(player.position);
    if (_up.lengthSq() < 1e-8) return;
    _up.normalize();
    _tdir.copy(tgt).normalize();
    const ang = Math.acos(Math.max(-1, Math.min(1, _up.dot(_tdir))));
    const dist = Math.round(ang * METERS_PER_RAD);
    let line;
    if (showDist) line = dist < 2 ? '就在附近！' : `${dist} 公尺`;
    else line = biome ? `${biome.icon || ''} ${biome.name || ''}`.trim() : '';
    if (ping > 0) line = `${line ? line + ' · ' : ''}📡 ${Math.ceil(ping)} 秒`;
    setText(cdist, line);

    // 目標是否在畫面上且沒被擋住
    let onScreen = false;
    if (project(tgt, camera)) {
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

  // ================= 版面：窄螢幕指南針、提示訊息位置、任務數量 =================
  const safeProbe = h('div', 'tw-safe-probe');
  root.append(safeProbe);
  const mqNarrow = window.matchMedia ? window.matchMedia(NARROW_MQ) : { matches: false };
  function placeCompass() {
    if (mqNarrow.matches) {
      if (compass.parentNode !== leftCol) leftCol.insertBefore(compass, quests);
    } else if (compass.parentNode !== hud) {
      hud.insertBefore(compass, toasts);
    }
  }
  function layoutToasts() {
    if (!started) return;
    const st = parseFloat(getComputedStyle(safeProbe).paddingTop) || 0;
    let top = 0, width, cx = vw / 2, bottom = false;
    if (mqNarrow.matches && vh >= vw) {
      // 直立手機：上方已經被進度、指南針、任務與雷達佔滿，改放在下方操控區（表情鈕）上面、角色腳下
      bottom = true;
      width = Math.min(vw * 0.88, 420);
    } else if (mqNarrow.matches) {
      // 窄的橫向畫面：放在上方，進度卡（計時中＝計時器）與右上按鈕（含衣櫥/圖鑑、雷達）之間
      const pr = (timerOn ? timer : progress).getBoundingClientRect();
      const l = pr.right + 8, r = rightLimit(pr.top, pr.bottom + 80) - 8;
      if (r - l >= 160) {
        top = pr.top;
        cx = (l + r) / 2;
        width = Math.min(420, r - l);
      } else {
        bottom = true;
        width = Math.min(vw * 0.88, 420);
      }
    } else {
      const cr = compass.getBoundingClientRect();
      const tmr = timerOn ? timer.getBoundingClientRect() : null;
      top = (compassVisible && cr.height ? cr.bottom : (tmr && tmr.height ? tmr.bottom : st + 12)) + 10;
      // 左邊避開任務卡、右邊避開雷達區
      const qr = quests.getBoundingClientRect();
      const leftEdge = qr.height > 0 && qr.top < top + 120 ? qr.right : 0;
      const half = vw / 2 - Math.max(leftEdge, 140) - 8;
      width = Math.max(220, Math.min(420, half * 2));
    }
    toasts.classList.toggle('is-bottom', bottom);
    toasts.style.top = bottom ? '' : `${Math.round(top)}px`;
    toasts.style.left = `${Math.round(cx)}px`;
    toasts.style.width = `${Math.round(width)}px`;
  }
  /** 上方 y0..y1 這一帶，右側介面（右上按鈕、衣櫥/圖鑑、雷達）最左邊的 x */
  function rightLimit(y0, y1) {
    let x = topRight.getBoundingClientRect().left;
    const els = [side, document.querySelector('.tew-radar.is-visible')];
    for (const el of els) {
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.top < y1 && r.bottom > y0) x = Math.min(x, r.left);
    }
    return x;
  }
  function relayout() {
    placeCompass();
    if (timerOn) placeTimer();
    measureQuestMax();
    layoutToasts();
  }
  if (mqNarrow.addEventListener) mqNarrow.addEventListener('change', relayout);
  window.addEventListener('resize', () => requestAnimationFrame(relayout));
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => layoutToasts());
    ro.observe(leftCol);
    ro.observe(compass);
  }

  // =====================================================================
  // ================= v3：星星、側邊按鈕 =================
  // =====================================================================
  let stars = null;        // 目前顯示的星星數（null = 還不知道 → 不顯示）
  let bagNew = false;      // 有新裝扮 → 衣櫥鈕顯示小紅點
  let bookNew = false;     // 有新知識 → 圖鑑鈕顯示小紅點
  function setStars(n, animate) {
    n = Math.max(0, n | 0);
    const changed = stars !== null && n !== stars;
    stars = n;
    starPill.hidden = false;
    starV.textContent = String(n);
    if (animate && changed) retrigger(starPill, 'is-pop');
  }
  function refreshSideBadges() {
    btnBag.classList.toggle('has-new', bagNew);
    btnBook.classList.toggle('has-new', bookNew);
  }
  function refreshSideVisibility() {
    btnBag.hidden = !cb.getWardrobe;
    btnBook.hidden = !cb.getJournal;
    side.hidden = btnBag.hidden && btnBook.hidden;
  }
  btnBag.addEventListener('click', () => { btnBag.blur(); sfx('ui'); retrigger(btnBag, 'is-bump'); showWardrobe(); });
  btnBook.addEventListener('click', () => { btnBook.blur(); sfx('ui'); retrigger(btnBook, 'is-bump'); showJournal(); });

  // 飛行的星星（測驗答對 → 飛到 HUD 的星星數）
  const flyLayer = h('div', 'tw-fly');
  flyLayer.setAttribute('aria-hidden', 'true');
  root.append(flyLayer);
  function flyStar(fromEl, done) {
    const target = !starPill.hidden && starPill.offsetParent ? starPill : (!btnBook.hidden ? btnBook : null);
    const a = fromEl.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const sx = a.left + a.width / 2 - rr.left, sy = a.top + a.height / 2 - rr.top;
    let tx = 40, ty = 30;
    if (target) {
      const b = target.getBoundingClientRect();
      tx = b.left + b.width / 2 - rr.left; ty = b.top + b.height / 2 - rr.top;
    }
    const el = h('div', 'tw-flystar', '⭐');
    flyLayer.append(el);
    // 小火花
    for (let i = 0; i < 8; i++) {
      const sp = h('i', 'tw-flyspark');
      const ang = (i / 8) * Math.PI * 2;
      sp.style.left = `${sx}px`;
      sp.style.top = `${sy}px`;
      sp.style.setProperty('--dx', `${Math.cos(ang) * 46}px`);
      sp.style.setProperty('--dy', `${Math.sin(ang) * 46}px`);
      flyLayer.append(sp);
      setTimeout(() => sp.remove(), 700);
    }
    const mx = (sx + tx) / 2 + (tx < sx ? -40 : 40), my = Math.min(sy, ty) - 80;
    const finish = () => {
      el.remove();
      if (done) done();
      if (target !== starPill) return;
      retrigger(starPill, 'is-pop');
      // 對話框蓋住 HUD 時，在最上層補一個會跳動的星星數，讓玩家看得到 +1
      const r = starPill.getBoundingClientRect();
      const ghost = starPill.cloneNode(true);
      ghost.hidden = false;
      ghost.className = 'tw-starpill tw-star-ghost';
      ghost.style.left = `${r.left - rr.left}px`;
      ghost.style.top = `${r.top - rr.top}px`;
      flyLayer.append(ghost);
      setTimeout(() => ghost.remove(), 1500);
    };
    if (!el.animate) { finish(); return; }
    const anim = el.animate([
      { transform: `translate(${sx}px, ${sy}px) translate(-50%, -50%) scale(0.4) rotate(0deg)`, opacity: 0 },
      { transform: `translate(${sx}px, ${sy - 30}px) translate(-50%, -50%) scale(1.8) rotate(20deg)`, opacity: 1, offset: 0.22 },
      { transform: `translate(${mx}px, ${my}px) translate(-50%, -50%) scale(1.3) rotate(160deg)`, opacity: 1, offset: 0.6 },
      { transform: `translate(${tx}px, ${ty}px) translate(-50%, -50%) scale(0.6) rotate(360deg)`, opacity: 0.9 },
    ], { duration: 1050, easing: 'cubic-bezier(0.45, 0, 0.3, 1)', fill: 'forwards' });
    anim.onfinish = finish;
    anim.oncancel = finish;
  }

  // ================= v3：知識測驗 =================
  const quiz = makeModal('quiz', 'tw-quiz-card');
  const quizTop = h('div', 'tw-quiz-top');
  const quizIcon = h('div', 'tw-quiz-icon', '❓');
  const quizTag = h('div', 'tw-quiz-tag', '小測驗');
  quizTop.append(quizIcon, quizTag);
  const quizQ = h('h2', 'tw-quiz-q', '');
  const quizChoices = h('div', 'tw-quiz-choices');
  const quizResult = h('div', 'tw-quiz-result');
  const quizVerdict = h('div', 'tw-quiz-verdict', '');
  const quizExplain = h('p', 'tw-quiz-explain', '');
  const quizNext = button('tw-btn tw-btn-primary tw-btn-wide', '繼續');
  quizResult.append(quizVerdict, quizExplain, quizNext);
  quiz.card.append(quizTop, quizQ, quizChoices, quizResult);
  const Q = { resolve: null, answer: 0, picked: -1, correct: false, at: 0, starBase: 0 };

  function quizPick(i) {
    if (current !== 'quiz' || Q.picked >= 0 || performance.now() - openedAt < 300) return;
    const btns = [...quizChoices.children];
    if (!btns[i]) return;
    Q.picked = i;
    Q.correct = i === Q.answer;
    quiz.card.classList.add('is-answered', Q.correct ? 'is-correct' : 'is-wrong');
    btns.forEach((b, k) => {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
      if (k === Q.answer) b.classList.add('is-right');
      else if (k === i) b.classList.add('is-miss');
      else b.classList.add('is-other');
    });
    const right = btns[Q.answer];
    if (Q.correct) {
      sfx('correct');
      quizVerdict.textContent = '';
      quizVerdict.append(h('span', 'tw-quiz-vt', '🎉 答對了！'), h('span', 'tw-quiz-plus', '+1 ⭐'));
      flyStar(btns[i], () => { if (stars === null || stars < Q.starBase + 1) setStars(Q.starBase + 1, true); });
    } else {
      sfx('wrong');
      quizVerdict.textContent = '';
      const ans = right ? right.querySelector('.tw-quiz-ct').textContent : '';
      quizVerdict.append(h('span', 'tw-quiz-vt', '差一點點！'), h('span', 'tw-quiz-ans', `正確答案是「${ans}」`));
    }
    quizExplain.hidden = !quizExplain.textContent;
    Q.at = performance.now();
    requestAnimationFrame(() => {
      try { quizResult.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* 忽略 */ }
      if (!mqCoarse.matches) { try { quizNext.focus({ preventScroll: true }); } catch { /* 忽略 */ } }
    });
  }
  function closeQuiz() {
    if (current !== 'quiz' || Q.picked < 0 || performance.now() - Q.at < 350) return;
    sfx('ui');
    const r = Q.resolve;
    const res = { correct: Q.correct, choice: Q.picked };
    Q.resolve = null;
    closeModal('quiz');
    if (r) r(res);
    if (reopenJournal) {
      reopenJournal = false;
      clearTimeout(reopenTimer);
      setTimeout(() => { if (!current) showJournal(); }, 280);
    }
  }
  forced.quiz = () => { const r = Q.resolve; Q.resolve = null; if (r) r({ correct: false, choice: -1 }); };
  quizNext.addEventListener('click', closeQuiz);

  function showQuiz({ icon = '❓', question = '', choices = [], answer = 0, explain = '' } = {}) {
    return new Promise((resolve) => {
      openModal('quiz', () => {
        clearTimeout(reopenTimer);
        Q.resolve = resolve;
        Q.picked = -1;
        Q.correct = false;
        Q.starBase = stars || 0;
        const list = (Array.isArray(choices) ? choices : []).map(String);
        Q.answer = Math.max(0, Math.min(list.length - 1, answer | 0));
        quiz.card.classList.remove('is-answered', 'is-correct', 'is-wrong');
        quizIcon.textContent = icon || '❓';
        quizQ.textContent = question || '';
        quizExplain.textContent = explain ? `💡 ${explain}` : '';
        quizVerdict.textContent = '';
        quizChoices.textContent = '';
        list.forEach((c, i) => {
          const b = button('tw-quiz-choice', '');
          b.style.setProperty('--i', i);
          b.append(h('span', 'tw-quiz-cn', String(i + 1)), h('span', 'tw-quiz-ct', c), h('span', 'tw-quiz-mark'));
          b.addEventListener('click', () => quizPick(i));
          quizChoices.append(b);
        });
        quiz.card.scrollTop = 0;
      }, () => resolve({ correct: false, choice: -1 }));
    });
  }

  // ================= v3：解鎖新裝扮 =================
  const unlock = makeModal('unlock', 'tw-unlock-card');
  unlock.m.classList.add('tw-modal-celebrate');
  const unlockArt = h('div', 'tw-unlock-art');
  const unlockRays = h('div', 'tw-rays');
  const unlockIcon = h('div', 'tw-unlock-icon', '🎁');
  unlockArt.append(unlockRays, unlockIcon);
  for (let i = 0; i < 6; i++) {
    const sp = h('i', 'tw-unlock-spark', '✦');
    sp.style.setProperty('--i', i);
    unlockArt.append(sp);
  }
  const unlockBody = h('div', 'tw-unlock-body');
  const unlockKicker = h('div', 'tw-kicker', '✨ 解鎖新裝扮！');
  const unlockName = h('h2', 'tw-unlock-name', '');
  const unlockText = h('p', 'tw-unlock-text', '');
  const unlockBtns = h('div', 'tw-btnrow');
  const unlockOk = button('tw-btn tw-btn-primary', '好耶！');
  const unlockWear = button('tw-btn tw-btn-secondary', '🎒 去換裝');
  unlockBtns.append(unlockOk, unlockWear);
  unlockBody.append(unlockKicker, unlockName, unlockText, unlockBtns);
  unlock.card.append(unlockArt, unlockBody);
  function closeUnlock(wear) {
    if (current !== 'unlock' || !guardOk()) return;
    sfx('ui');
    closeModal('unlock');
    if (wear && !current) showWardrobe();
  }
  unlockOk.addEventListener('click', () => closeUnlock(false));
  unlockWear.addEventListener('click', () => closeUnlock(true));
  unlock.m.addEventListener('click', (e) => { if (e.target === unlock.m) closeUnlock(false); });
  function showUnlock({ icon = '🎁', name = '', text = '' } = {}) {
    bagNew = true;
    refreshSideBadges();
    openModal('unlock', () => {
      unlockIcon.textContent = icon || '🎁';
      unlockName.textContent = name || '新裝扮';
      unlockText.textContent = text || '';
      unlockText.hidden = !text;
      unlockWear.hidden = !cb.getWardrobe || queue.length > 0;
      unlock.card.scrollTop = 0;
    });
  }

  // ================= v3：衣櫥（不遮住角色的側邊面板 / 底部抽屜） =================
  const wd = makeModal('wardrobe', 'tw-wd-card');
  wd.m.classList.add('tw-modal-wd');
  const wdHead = h('div', 'tw-card-head tw-wd-head');
  const wdTitle = h('h2', 'tw-card-title', '🎒 衣櫥');
  const wdCount = h('span', 'tw-wd-count', '');
  const wdClose = button('tw-close', '✕', '關閉');
  const wdTitleWrap = h('div', 'tw-wd-titlewrap');
  wdTitleWrap.append(wdTitle, wdCount);
  wdHead.append(wdTitleWrap, wdClose);
  const wdTabs = h('div', 'tw-wd-tabs');
  wdTabs.setAttribute('role', 'tablist');
  const wdGrid = h('div', 'tw-wd-grid');
  const wdHint = h('div', 'tw-wd-hint', '');
  wd.card.append(wdHead, wdTabs, wdGrid, wdHint);
  let wdSlot = 'hat';
  let wdHintTimer = 0;
  wdClose.addEventListener('click', () => { sfx('ui'); closeWardrobe(); });
  wd.m.addEventListener('click', (e) => { if (e.target === wd.m && guardOk()) { sfx('ui'); closeWardrobe(); } });

  function getWardrobeData() {
    let d = null;
    try { d = cb.getWardrobe ? cb.getWardrobe() : null; } catch { d = null; }
    d = d || {};
    const slots = Array.isArray(d.slots) && d.slots.length ? d.slots : DEFAULT_SLOTS;
    const items = Array.isArray(d.items) ? d.items.filter((it) => it && typeof it === 'object') : [];
    const equipped = d.equipped || {};
    return { slots, items, equipped };
  }
  function wdShowHint(text, kind) {
    wdHint.textContent = text;
    wdHint.className = `tw-wd-hint is-on ${kind ? 'is-' + kind : ''}`;
    retrigger(wdHint, 'is-pop');
    clearTimeout(wdHintTimer);
    wdHintTimer = setTimeout(() => wdHint.classList.remove('is-on'), 3200);
  }
  function renderWardrobe(bump) {
    const { slots, items, equipped } = getWardrobeData();
    if (!slots.some((s) => s.id === wdSlot)) wdSlot = slots[0].id;
    // 分頁
    wdTabs.textContent = '';
    let total = 0, have = 0;
    for (const s of slots) {
      const own = items.filter((it) => it.slot === s.id);
      const un = own.filter((it) => it.unlocked).length;
      total += own.length; have += un;
      const t = button('tw-wd-tab', '');
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', s.id === wdSlot ? 'true' : 'false');
      const top = h('span', 'tw-wd-tab-top');
      top.append(h('span', 'tw-wd-tab-ic', SLOT_ICON[s.id] || '✨'), h('span', 'tw-wd-tab-l', s.name || s.id));
      t.append(top, h('span', 'tw-wd-tab-n', `${un}/${own.length}`));
      t.addEventListener('click', () => {
        if (wdSlot === s.id) return;
        sfx('ui');
        wdSlot = s.id;
        wdHint.classList.remove('is-on');
        renderWardrobe();
        wdGrid.scrollTop = 0;
      });
      wdTabs.append(t);
    }
    wdCount.textContent = total ? `${have}/${total}` : '';
    // 物品
    wdGrid.textContent = '';
    const list = items.filter((it) => it.slot === wdSlot);
    const eq = equipped[wdSlot] ?? null;
    if (NONE_ITEM[wdSlot] && !list.some((it) => it.id === null || it.id === 'none')) {
      list.unshift({ id: null, slot: wdSlot, icon: NONE_ITEM[wdSlot].icon, name: NONE_ITEM[wdSlot].name, unlocked: true, none: true });
    }
    for (const it of list) {
      const on = (it.id ?? null) === eq || (it.id === 'none' && eq === null);
      const b = button('tw-wd-item', '');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-on', on);
      b.classList.toggle('is-locked', !it.unlocked);
      b.classList.toggle('is-none', !!it.none);
      const art = h('span', 'tw-wd-art');
      const color = it.color || (wdSlot === 'scarf' ? SCARF_COLORS[it.id] : null);
      if (color) { art.classList.add('has-swatch'); art.style.setProperty('--sw', color); }
      art.append(h('span', 'tw-wd-ic', it.icon || SLOT_ICON[wdSlot] || '✨'));
      b.append(art, h('span', 'tw-wd-name', it.unlocked ? (it.name || '') : (it.name || '？？？')));
      if (on) b.append(h('span', 'tw-wd-check', '✓'));
      if (!it.unlocked) b.append(h('span', 'tw-wd-lock', '🔒'));
      if (bump && on) b.classList.add('is-bump');
      b.setAttribute('aria-label', `${it.name || ''}${on ? '（穿戴中）' : ''}${it.unlocked ? '' : '（未解鎖）'}`);
      b.addEventListener('click', () => {
        if (!it.unlocked) {
          sfx('ui');
          retrigger(b, 'is-shake');
          wdShowHint(`🔒 ${it.hint || '還沒解鎖喔，繼續探索吧！'}`, 'lock');
          return;
        }
        if (on) {
          retrigger(b, 'is-bump');
          wdShowHint(`✓ 已經穿上「${it.name || ''}」了`, 'ok');
          return;
        }
        try { if (cb.onEquip) cb.onEquip(wdSlot, it.id ?? null); } catch { /* 忽略 */ }
        renderWardrobe(true);
        wdShowHint(it.none ? `已經${wdSlot === 'hat' ? '脫下帽子' : '關閉腳印特效'}` : `✨ 換上「${it.name || ''}」！`, 'ok');
      });
      wdGrid.append(b);
    }
    if (!list.length) wdGrid.append(h('p', 'tw-wd-empty', '這裡還沒有東西喔。'));
  }
  function showWardrobe() {
    if (!started || current || !cb.getWardrobe) return;
    openModal('wardrobe', () => {
      bagNew = false;
      refreshSideBadges();
      wdHint.classList.remove('is-on');
      renderWardrobe();
      wdGrid.scrollTop = 0;
    });
    try { if (cb.onWardrobeOpen) cb.onWardrobeOpen(true); } catch { /* 忽略 */ }
  }
  function closeWardrobe() {
    if (current !== 'wardrobe') return;
    closeModal('wardrobe');
    try { if (cb.onWardrobeOpen) cb.onWardrobeOpen(false); } catch { /* 忽略 */ }
  }
  forced.wardrobe = () => { try { if (cb.onWardrobeOpen) cb.onWardrobeOpen(false); } catch { /* 忽略 */ } };

  // ================= v3：圖鑑 =================
  const jn = makeModal('journal', 'tw-jn-card');
  const jnHead = h('div', 'tw-card-head tw-jn-head');
  const jnClose = button('tw-close', '✕', '關閉');
  jnHead.append(h('h2', 'tw-card-title', '📖 圖鑑'), jnClose);
  const jnBody = h('div', 'tw-jn-body');
  jn.card.append(jnHead, jnBody);
  let reopenJournal = false;
  let reopenTimer = 0;
  jnClose.addEventListener('click', () => { sfx('ui'); closeJournal(); });
  jn.m.addEventListener('click', (e) => { if (e.target === jn.m && guardOk()) { sfx('ui'); closeJournal(); } });
  function closeJournal() { closeModal('journal'); }

  function jnStat(icon, label, value, sub) {
    const s = h('div', 'tw-jn-stat');
    s.append(h('span', 'tw-jn-stat-ic', icon));
    const t = h('div', 'tw-jn-stat-t');
    t.append(h('b', 'tw-jn-stat-v', value), h('span', 'tw-jn-stat-l', label));
    s.append(t);
    if (sub) s.append(sub);
    return s;
  }
  function renderJournal() {
    let j = null;
    try { j = cb.getJournal ? cb.getJournal() : null; } catch { j = null; }
    j = j || {};
    const facts = Array.isArray(j.facts) ? j.facts.filter((f) => f && typeof f === 'object') : [];
    jnBody.textContent = '';
    // ---- 統計 ----
    const starsN = typeof j.stars === 'number' ? j.stars : (stars || 0);
    if (typeof j.stars === 'number') setStars(j.stars, false);
    const stats = h('div', 'tw-jn-stats');
    const collected = facts.filter((f) => f.collected).length;
    stats.append(jnStat('📚', '已收集知識', `${collected}/${facts.length || 12}`));
    stats.append(jnStat('⭐', '測驗星星', `${starsN}/${facts.length || 12}`));
    const ac = j.acorns || {};
    stats.append(jnStat('🌰', '金色橡實', `${ac.found | 0}/${ac.total || 6}`));
    const best = typeof j.bestTime === 'number' && isFinite(j.bestTime) && j.bestTime > 0 ? j.bestTime : null;
    const medal = MEDAL_ICON[j.medal] || '';
    stats.append(jnStat(medal || '⏱️', '計時挑戰最佳', best !== null ? fmtTrial(best) : '尚未挑戰'));
    jnBody.append(stats);
    // ---- 橡實提示 ----
    let hints = [];
    if (Array.isArray(ac.hints)) hints = ac.hints.filter(Boolean).map(String);
    else if (Array.isArray(ac.list)) hints = ac.list.filter((a) => a && !a.found && a.hint).map((a) => String(a.hint));
    if (hints.length && (ac.found | 0) < (ac.total || 6)) {
      const box = h('div', 'tw-jn-hints');
      box.append(h('div', 'tw-jn-hints-t', '🌰 還沒找到的金色橡實'));
      const ul = h('ul', 'tw-jn-hints-l');
      for (const t of hints) ul.append(h('li', '', t));
      box.append(ul);
      jnBody.append(box);
    }
    // ---- 依生態區分組 ----
    const order = BIOMES.map((b) => b.id);
    const groups = new Map();
    for (const f of facts) {
      const id = f.biome || 'other';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(f);
    }
    const ids = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
    for (const id of ids) {
      const list = groups.get(id);
      const b = BIOMES.find((x) => x.id === id);
      const name = (b && b.name) || list[0].biomeName || '其他';
      const sec = h('section', 'tw-jn-sec');
      const sh = h('div', 'tw-jn-sec-h');
      sh.append(h('span', 'tw-jn-sec-ic', (b && b.icon) || '🌍'), h('span', 'tw-jn-sec-n', name), h('span', 'tw-jn-sec-c', `${list.filter((f) => f.collected).length}/${list.length}`));
      sec.append(sh);
      const grid = h('div', 'tw-jn-grid');
      for (const f of list) grid.append(journalEntry(f, name));
      sec.append(grid);
      jnBody.append(sec);
    }
    if (!facts.length) jnBody.append(h('p', 'tw-wd-empty', '還沒有任何紀錄，去找知識晶石吧！'));
  }
  function journalEntry(f, biomeName) {
    const e = h('article', `tw-jn-entry ${f.collected ? 'is-have' : 'is-missing'}`);
    const ic = h('div', 'tw-jn-ic', f.collected ? (f.icon || '💎') : '❔');
    const body = h('div', 'tw-jn-eb');
    if (!f.collected) {
      body.append(h('div', 'tw-jn-title', '？？？'), h('div', 'tw-jn-where', `藏在${f.biomeName || biomeName}的某處`));
      e.append(ic, body);
      return e;
    }
    body.append(h('div', 'tw-jn-title', f.title || ''), h('p', 'tw-jn-text', f.text || ''));
    const foot = h('div', 'tw-jn-foot');
    if (f.quiz === 'correct') {
      foot.append(h('span', 'tw-jn-badge is-ok', '⭐ 答對了'));
    } else {
      foot.append(h('span', `tw-jn-badge ${f.quiz === 'wrong' ? 'is-bad' : 'is-none'}`, f.quiz === 'wrong' ? '❌ 答錯了' : '❔ 還沒作答'));
      if (cb.onRetryQuiz) {
        const r = button('tw-jn-retry', f.quiz === 'wrong' ? '🔁 再答一次' : '✏️ 來答題');
        r.addEventListener('click', () => {
          if (current !== 'journal') return;
          sfx('ui');
          closeJournal();
          reopenJournal = true;
          clearTimeout(reopenTimer);
          reopenTimer = setTimeout(() => { reopenJournal = false; }, 1500); // 沒有出題就不要再打開
          try { cb.onRetryQuiz(f.id); } catch { /* 忽略 */ }
        });
        foot.append(r);
      }
    }
    body.append(foot);
    e.append(ic, body);
    return e;
  }
  function showJournal() {
    if (!started || current || !cb.getJournal) return;
    openModal('journal', () => {
      bookNew = false;
      refreshSideBadges();
      renderJournal();
      jnBody.scrollTop = 0;
    });
  }

  // ================= v3：計時挑戰 HUD =================
  const timer = h('div', 'tw-timer tw-glass');
  timer.setAttribute('role', 'timer');
  const timerMain = h('div', 'tw-timer-main');
  const timerIc = h('span', 'tw-timer-ic', '⏱️');
  const timerTime = h('b', 'tw-timer-time', '00:00.0');
  timerMain.append(timerIc, timerTime);
  const timerSub = h('div', 'tw-timer-sub');
  const timerFound = h('span', 'tw-timer-found', '⌛ 0/8');
  const timerBest = h('span', 'tw-timer-best', '');
  timerSub.append(timerFound, timerBest);
  const timerCancel = button('tw-timer-cancel', '放棄挑戰', '放棄計時挑戰');
  const timerInfo = h('div', 'tw-timer-info');
  timerInfo.append(timerMain, timerSub);
  timer.append(timerInfo, timerCancel);
  timer.hidden = true;
  hud.insertBefore(timer, compass);
  let timerOn = false;
  let timerFoundN = -1;
  let cancelArmed = 0;
  timerCancel.addEventListener('click', () => {
    timerCancel.blur();
    if (!timerOn) return;
    sfx('ui');
    const now = performance.now();
    if (now - cancelArmed > 3000) {
      cancelArmed = now;
      timerCancel.textContent = '確定放棄？';
      timer.classList.add('is-confirm');
      setTimeout(() => {
        if (performance.now() - cancelArmed >= 2950) { timerCancel.textContent = '放棄挑戰'; timer.classList.remove('is-confirm'); }
      }, 3000);
      return;
    }
    cancelArmed = 0;
    timerCancel.textContent = '放棄挑戰';
    timer.classList.remove('is-confirm');
    try { if (cb.onCancelTrial) cb.onCancelTrial(); } catch { /* 忽略 */ }
  });
  function placeTimer() {
    if (mqNarrow.matches) {
      if (timer.parentNode !== leftCol) leftCol.insertBefore(timer, leftCol.firstChild);
    } else if (timer.parentNode !== hud) {
      hud.insertBefore(timer, compass.parentNode === hud ? compass : toasts);
    }
  }
  function setTimer(st) {
    const on = !!st;
    if (on !== timerOn) {
      timerOn = on;
      timer.hidden = !on;
      hud.classList.toggle('has-timer', on);
      if (on) {
        placeTimer();
        retrigger(timer, 'is-in');
        timerFoundN = -1;
        cancelArmed = 0;
        timerCancel.textContent = '放棄挑戰';
        timer.classList.remove('is-confirm');
      }
      timerCancel.hidden = !cb.onCancelTrial;
      requestAnimationFrame(() => { measureQuestMax(); layoutToasts(); });
    }
    if (!on) return;
    setText(timerTime, fmtTrial(st.time || 0));
    const total = st.total | 0;
    const found = st.found | 0;
    setText(timerFound, `⌛ ${found}/${total || CFG.TRIAL_COUNT || 8}`);
    if (found !== timerFoundN) {
      if (timerFoundN >= 0 && found > timerFoundN) retrigger(timerFound, 'is-pop');
      timerFoundN = found;
    }
    const best = typeof st.best === 'number' && isFinite(st.best) && st.best > 0 ? st.best : null;
    setText(timerBest, best !== null ? `🏆 ${fmtTrial(best)}` : '🏆 —');
    const slow = best !== null && (st.time || 0) > best;
    timer.classList.toggle('is-slow', slow);
  }

  // ================= v3：倒數 =================
  const cd = makeModal('countdown', 'tw-cd-card');
  cd.m.classList.add('tw-modal-cd');
  const cdNum = h('div', 'tw-cd-num', '');
  cd.card.append(cdNum);
  let cdToken = null;
  function showCountdown() {
    return new Promise((resolve) => {
      openModal('countdown', () => {
        const token = {};
        cdToken = token;
        const steps = ['3', '2', '1'];
        let i = 0;
        const STEP = 850;
        const tick = () => {
          if (cdToken !== token) return;
          if (i < steps.length) {
            cdNum.textContent = steps[i];
            cdNum.className = `tw-cd-num is-n${3 - i}`;
            retrigger(cdNum, 'is-show');
            sfx('countdown');
            i++;
            setTimeout(tick, STEP);
            return;
          }
          cdNum.textContent = '出發！';
          cdNum.className = 'tw-cd-num is-go';
          retrigger(cdNum, 'is-show');
          sfx('go');
          cdToken = null;
          // 「出發！」出現時就結束倒數（可以立刻開始移動），文字自己淡出
          const ghost = cdNum.cloneNode(true);
          ghost.classList.add('tw-cd-ghost');
          flyLayer.append(ghost);
          setTimeout(() => ghost.remove(), 900);
          closeModal('countdown');
          resolve();
        };
        cdNum.textContent = '';
        setTimeout(tick, 120);
        forced.countdown = () => { cdToken = null; resolve(); };
      }, () => resolve());
    });
  }

  // ================= v3：計時挑戰成績 =================
  const res = makeModal('result', 'tw-res-card');
  res.m.classList.add('tw-modal-celebrate');
  const resConfetti = h('div', 'tw-confetti');
  resConfetti.setAttribute('aria-hidden', 'true');
  res.m.insertBefore(resConfetti, res.card);
  const resArt = h('div', 'tw-res-art');
  const resRays = h('div', 'tw-rays');
  const resMedal = h('div', 'tw-res-medal', '🥇');
  const resRecord = h('div', 'tw-res-record', '新紀錄！');
  resArt.append(resRays, resMedal, resRecord);
  const resBody = h('div', 'tw-res-body');
  const resKicker = h('div', 'tw-kicker', '⏱️ 計時挑戰完成！');
  const resTitle = h('h2', 'tw-res-title', '');
  const resTime = h('div', 'tw-res-time', '00:00.0');
  const resBest = h('div', 'tw-res-best', '');
  const resLadder = h('div', 'tw-res-ladder');
  const ladderEls = {};
  for (const k of ['gold', 'silver', 'bronze']) {
    const li = h('div', 'tw-res-rung');
    li.append(h('span', 'tw-res-rung-ic', MEDAL_ICON[k]), h('span', 'tw-res-rung-t', `< ${fmtTime(MEDALS[k])}`));
    resLadder.append(li);
    ladderEls[k] = li;
  }
  const resBtns = h('div', 'tw-btnrow');
  const resRetry = button('tw-btn tw-btn-primary', '🔁 再挑戰');
  const resExit = button('tw-btn tw-btn-secondary', '結束');
  resBtns.append(resRetry, resExit);
  resBody.append(resKicker, resTitle, resTime, resBest, resLadder, resBtns);
  res.card.append(resArt, resBody);
  let resResolve = null;
  function closeResult(v) {
    if (current !== 'result' || !guardOk()) return;
    sfx('ui');
    const r = resResolve;
    resResolve = null;
    closeModal('result');
    if (r) r(v);
  }
  forced.result = () => { const r = resResolve; resResolve = null; if (r) r('exit'); };
  resRetry.addEventListener('click', () => closeResult('retry'));
  resExit.addEventListener('click', () => closeResult('exit'));
  function showTrialResult({ time = 0, best = null, medal = null, newRecord = false } = {}) {
    return new Promise((resolve) => {
      openModal('result', () => {
        resResolve = resolve;
        const m = MEDAL_ICON[medal] ? medal : null;
        res.card.classList.remove('is-gold', 'is-silver', 'is-bronze', 'is-none');
        res.card.classList.add(m ? `is-${m}` : 'is-none');
        resMedal.textContent = m ? MEDAL_ICON[m] : '💪';
        resTitle.textContent = m ? `獲得${MEDAL_NAME[m]}！` : '再接再厲！';
        resTime.textContent = fmtTrial(time);
        const b = typeof best === 'number' && isFinite(best) && best > 0 ? best : null;
        resBest.textContent = newRecord ? (b !== null && b < time - 0.05 ? `最佳紀錄 ${fmtTrial(b)}` : '🏆 這就是你的最佳紀錄！') : `最佳紀錄 ${b !== null ? fmtTrial(b) : '—'}`;
        resRecord.hidden = !newRecord;
        res.card.classList.toggle('is-record', !!newRecord);
        for (const k of Object.keys(ladderEls)) ladderEls[k].classList.toggle('is-got', k === m);
        resConfetti.textContent = '';
        if (m || newRecord) fillConfetti(resConfetti, 30);
        res.card.scrollTop = 0;
        sfx('trialEnd');
        if (!mqCoarse.matches) setTimeout(() => { try { resRetry.focus({ preventScroll: true }); } catch { /* 忽略 */ } }, 50);
      }, () => resolve('exit'));
    });
  }

  // ================= v3：夜晚（HUD 更不透明，深色場景也清楚） =================
  function setNight(on) {
    root.classList.toggle('is-night', !!on);
  }

  // ================= 鍵盤 =================
  let armedKey = null;
  const CLOSE_KEYS = new Set(['Enter', 'NumpadEnter', 'Escape', 'Space']);
  const DLG_KEYS = new Set(['Enter', 'NumpadEnter', 'Space', 'KeyF']);
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code || '';
    if (current === 'dialogue') {
      // 空白鍵 / Enter / F：按下時「上膛」、放開時才前進（避免按住的鍵誤觸）
      if (DLG_KEYS.has(code) || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!e.repeat) armedKey = code || e.key;
        return;
      }
      if (/^(Digit|Numpad)[1-4]$/.test(code) && !e.repeat && dlg.card.classList.contains('is-choosing')) {
        const b = dlgChoices.children[+code.slice(-1) - 1];
        if (b) { e.preventDefault(); b.click(); }
        return;
      }
      if (/^Arrow(Left|Right|Up|Down)$/.test(code) && dlg.card.classList.contains('is-choosing')) {
        e.preventDefault();
        const list = [...dlgChoices.children];
        if (!list.length) return;
        let i = list.indexOf(document.activeElement);
        i = i < 0 ? 0 : (i + (code === 'ArrowLeft' || code === 'ArrowUp' ? -1 : 1) + list.length) % list.length;
        list[i].focus({ preventScroll: true });
        return;
      }
      if (e.key === 'Escape' || code === 'Tab') { if (e.key === 'Escape') e.preventDefault(); }
      return;
    }
    if (current === 'fragment') {
      if (CLOSE_KEYS.has(code) || e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!e.repeat && guardOk()) armedKey = code || e.key;
      }
      return;
    }
    if (current === 'fact') {
      if (CLOSE_KEYS.has(code) || e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!e.repeat && guardOk()) armedKey = code || e.key;
      }
      return;
    }
    if (current === 'quiz') {
      const answered = Q.picked >= 0;
      if (!answered && /^(Digit|Numpad)[1-9]$/.test(code) && !e.repeat) {
        e.preventDefault();
        quizPick(+code.slice(-1) - 1);
        return;
      }
      if (answered && (CLOSE_KEYS.has(code) || e.key === 'Enter' || e.key === ' ' || e.key === 'Escape')) {
        e.preventDefault();
        if (!e.repeat) armedKey = code || e.key;
      }
      return;
    }
    if (current === 'unlock') {
      if (CLOSE_KEYS.has(code) || e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!e.repeat && guardOk()) armedKey = code || e.key;
      }
      return;
    }
    if (current === 'result') {
      if (e.key === 'Escape' && !e.repeat) { e.preventDefault(); closeResult('exit'); }
      return;
    }
    if (current === 'countdown') {
      if (code === 'Space' || e.key === 'Enter' || e.key === 'Escape') e.preventDefault();
      return;
    }
    if (current === 'wardrobe' || current === 'journal') {
      const own = current === 'wardrobe' ? 'KeyB' : 'KeyJ';
      if ((e.key === 'Escape' || code === own) && !e.repeat) {
        e.preventDefault();
        sfx('ui');
        if (current === 'wardrobe') closeWardrobe(); else closeJournal();
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
    if (code === 'KeyB' && cb.getWardrobe) { e.preventDefault(); closePicker(); sfx('ui'); showWardrobe(); return; }
    if (code === 'KeyJ' && cb.getJournal) { e.preventDefault(); closePicker(); sfx('ui'); showJournal(); return; }
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
    if (!armedKey) return;
    if ((e.code || e.key) !== armedKey) return;
    armedKey = null;
    if (current === 'fact') closeFact();
    else if (current === 'fragment') closeFragment();
    else if (current === 'quiz') closeQuiz();
    else if (current === 'unlock') closeUnlock(false);
    else if (current === 'dialogue') { e.preventDefault(); dlgAdvance(true); }
  });

  refreshMute();
  refreshQuality();
  refreshSideVisibility();
  updateProgress(lastProgress);
  relayout();

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
    // v2
    showDialogue,
    setQuests,
    setNav,
    setPrompt,
    showFragment,
    // v3
    showQuiz,
    showUnlock,
    showWardrobe,
    hideWardrobe: closeWardrobe,
    showJournal,
    setTimer,
    showCountdown,
    showTrialResult,
    setStars: (n) => setStars(n, started),
    setNight,
  };
}
