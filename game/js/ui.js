// 分身 5：介面（開始畫面、HUD、指南針、表情、知識卡、設定、勝利畫面、提示訊息、表情泡泡）
// v2：居民對話框、任務追蹤、分級指南針（setNav）、互動提示、地圖碎片彈窗
import * as THREE from 'three';
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
  const chipQ = makeChip('📜', '任務');
  chipQ.c.hidden = true;
  const bar = h('div', 'tw-bar');
  const barFill = h('div', 'tw-bar-fill');
  bar.append(barFill);
  progress.append(chips, bar);

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

  hud.append(leftCol, compass, toasts, topRight, emoteWrap, prompt);

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
  const QUEUE_SAME = new Set(['dialogue', 'fragment', 'fact']);
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
  }
  function closeModal(name) {
    if (current !== name) return;
    const m = modals[name];
    m.classList.remove('is-open');
    m.hidden = true;
    current = null;
    hud.classList.remove('is-dimmed', 'is-talking');
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
      current = null;
      hud.classList.remove('is-dimmed', 'is-talking');
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
  const vQuest = stat('📜', '完成任務');
  const vFrag = stat('🗺️', '地圖碎片');
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
      const q = stats.quests ?? p.quests;
      const fr = stats.fragments ?? p.fragments;
      vQuest.textContent = `${q ?? 0}`;
      vFrag.textContent = `${fr ?? 0}`;
      vQuest.parentElement.hidden = q === undefined && !p.hasQuests;
      vFrag.parentElement.hidden = fr === undefined && !p.hasQuests;
      vStats.classList.toggle('is-five', !vQuest.parentElement.hidden && !vFrag.parentElement.hidden);
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
    const dt = Math.min(0.1, Math.max(0, (now - D.lastT) / 1000));
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
    let top, width;
    if (mqNarrow.matches) {
      // 窄螢幕：放在左欄與右上雷達區的下方
      const lb = leftCol.getBoundingClientRect().bottom;
      top = Math.max(lb, st + RADAR_ZONE_BOTTOM) + 8;
      width = Math.min(vw * 0.88, 420);
    } else {
      const cr = compass.getBoundingClientRect();
      top = (compassVisible && cr.height ? cr.bottom : st + 12) + 10;
      // 左邊避開任務卡、右邊避開雷達區
      const qr = quests.getBoundingClientRect();
      const leftEdge = qr.height > 0 && qr.top < top + 120 ? qr.right : 0;
      const half = vw / 2 - Math.max(leftEdge, 140) - 8;
      width = Math.max(220, Math.min(420, half * 2));
    }
    toasts.style.top = `${Math.round(top)}px`;
    toasts.style.width = `${Math.round(width)}px`;
  }
  function relayout() {
    placeCompass();
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
    if (!armedKey) return;
    if ((e.code || e.key) !== armedKey) return;
    armedKey = null;
    if (current === 'fact') closeFact();
    else if (current === 'fragment') closeFragment();
    else if (current === 'dialogue') { e.preventDefault(); dlgAdvance(true); }
  });

  refreshMute();
  refreshQuality();
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
  };
}
