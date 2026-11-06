// 整合者：啟動、主迴圈、存檔、模組之間的接線。
import * as THREE from 'three';
import { QUALITY, SAVE_KEY, START_BIOME, SPEED_SCALES, CHARACTERS } from './config.js';
import * as playerModule from './player.js';
import * as charactersModule from './characters.js';
import { getBiomeById, biomeCenters } from './utils.js';
import { createWorld } from './world.js';
import { createPlayer } from './player.js';
import { createInput } from './input.js';
import { createCameraRig } from './cameraRig.js';
import { createGameplay } from './gameplay.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';
import { createEffects } from './effects.js';
import { createRadar } from './radar.js';

const boot = document.getElementById('boot');
function bootError(err) {
  console.error(err);
  boot.classList.add('error');
  boot.querySelector('.boot-text').textContent = '載入失敗：' + (err && err.message ? err.message : err);
}

// ---- 存檔（localStorage 可能不可用，全部包 try/catch） ----
function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeSave(data) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch { /* 忽略 */ }
}
function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* 忽略 */ }
}
function readQuality(isTouch) {
  try {
    const q = localStorage.getItem(SAVE_KEY + ':quality');
    if (q === 'low' || q === 'high') return q;
  } catch { /* 忽略 */ }
  return isTouch && Math.min(screen.width, screen.height) < 500 ? 'low' : 'high';
}

function start() {
  const canvas = document.getElementById('game');
  const touchRoot = document.getElementById('touch');
  const uiRoot = document.getElementById('ui');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);

  const input = createInput({ canvas, touchRoot });
  let quality = readQuality(input.isTouch);

  function applySize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY[quality].pixelRatioMax);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // 直立螢幕時加大視野，讓手機直拿也看得到周圍
    camera.fov = w < h ? 68 : 55;
    camera.updateProjectionMatrix();
  }
  applySize();
  window.addEventListener('resize', applySize);
  window.addEventListener('orientationchange', () => setTimeout(applySize, 200));

  const world = createWorld({ scene, renderer, quality });
  const player = createPlayer({ scene, world });
  const startDir = biomeCenters(getBiomeById(START_BIOME))[0];
  player.setDirection(startDir);

  const cameraRig = createCameraRig({ camera, world, player, input });
  cameraRig.setMode('showcase');
  cameraRig.snap();

  const audio = createAudio();
  const effects = createEffects(scene);

  let playing = false;
  let saveTimer = 0;
  let gameplay = null;

  const ui = createUI({
    root: uiRoot,
    audio,
    callbacks: {
      async onStart({ continue: cont } = {}) {
        audio.unlock();
        audio.startMusic();
        if (cont) {
          const data = readSave();
          if (data) gameplay.loadSaveData(data);
          ui.hideStart();
        } else {
          clearSave();
          gameplay.reset();
          player.setDirection(startDir);
          ui.hideStart();
          // v4：新遊戲先選角
          if (ui.showCharacterSelect) {
            cameraRig.setMode('select');
            const current = gameplay.getCharacter ? gameplay.getCharacter() : CHARACTERS[0];
            let id = current;
            try { id = await ui.showCharacterSelect({ characters: characterList(), current }); } catch { /* 用預設 */ }
            setCharacter(id || current);
          }
        }
        cameraRig.setMode('follow'); // 平滑飛入
        input.setEnabled(true);
        playing = true;
        save();
      },
      onEmote(emoji) {
        if (!playing) return;
        audio.play('emote');
        ui.addBubble((out) => player.getHeadPosition(out), emoji, 2.5);
        gameplay.onPlayerEmote(emoji);
      },
      onQuality(level) {
        if (!QUALITY[level]) return;
        quality = level;
        try { localStorage.setItem(SAVE_KEY + ':quality', level); } catch { /* 忽略 */ }
        applySize();
      },
      onReset() {
        clearSave();
        if (gameplay.cancelTimeTrial) gameplay.cancelTimeTrial();
        gameplay.reset();
        player.setDirection(startDir);
        cameraRig.snap();
        save();
      },
      // ---- v3 ----
      getWardrobe: () => (gameplay.getWardrobe ? gameplay.getWardrobe() : { slots: [], items: [], equipped: {} }),
      onEquip(slot, id) { if (gameplay.equip) { gameplay.equip(slot, id); save(); } },
      onWardrobeOpen(open) {
        if (!playing) return;
        cameraRig.setMode(open ? 'closeup' : 'follow');
      },
      getJournal: () => (gameplay.getJournal ? gameplay.getJournal() : { facts: [] }),
      onRetryQuiz(id) { if (gameplay.retryQuiz) gameplay.retryQuiz(id); },
      getDayNight: () => dayNight,
      onDayNight(on) {
        dayNight = !!on;
        try { localStorage.setItem(SAVE_KEY + ':daynight', dayNight ? '1' : '0'); } catch { /* 忽略 */ }
        if (world.setDayNightEnabled) world.setDayNightEnabled(dayNight);
      },
      canTimeTrial: () => !!(playing && gameplay.canTimeTrial && gameplay.canTimeTrial()),
      onTimeTrial() { if (playing && gameplay.startTimeTrial && gameplay.canTimeTrial()) gameplay.startTimeTrial(); },
      onCancelTrial() { if (gameplay.cancelTimeTrial) gameplay.cancelTimeTrial(); },
      // ---- v4 ----
      onPreviewCharacter(id) { if (player.setCharacter && CHARACTERS.includes(id)) player.setCharacter(id); },
      getCharacters: () => characterList(),
      onSelectCharacter(id) { setCharacter(id); save(); },
      getSpeed: () => speedKey,
      onSpeed(key) {
        if (!SPEED_SCALES[key]) return;
        speedKey = key;
        try { localStorage.setItem(SAVE_KEY + ':speed', key); } catch { /* 忽略 */ }
        if (player.setSpeedScale) player.setSpeedScale(SPEED_SCALES[key]);
      },
    },
  });

  // ---- v4：角色與速度 ----
  const CHARACTER_INFO = charactersModule.CHARACTER_INFO || playerModule.CHARACTER_INFO || {};
  function characterList() {
    const cur = gameplay && gameplay.getCharacter ? gameplay.getCharacter() : (player.character || CHARACTERS[0]);
    return CHARACTERS.map((id) => {
      const info = CHARACTER_INFO[id] || {};
      return { id, name: info.name || id, desc: info.desc || '', icon: info.icon || '🙂', selected: id === cur };
    });
  }
  function setCharacter(id) {
    if (!CHARACTERS.includes(id)) return;
    if (gameplay.setCharacter) gameplay.setCharacter(id);
    else if (player.setCharacter) player.setCharacter(id);
  }
  let speedKey = 'normal';
  try { const k = localStorage.getItem(SAVE_KEY + ':speed'); if (SPEED_SCALES[k]) speedKey = k; } catch { /* 忽略 */ }
  if (player.setSpeedScale) player.setSpeedScale(SPEED_SCALES[speedKey]);

  // 日夜循環偏好（預設開）
  let dayNight = true;
  try { dayNight = localStorage.getItem(SAVE_KEY + ':daynight') !== '0'; } catch { /* 忽略 */ }
  if (world.setDayNightEnabled) world.setDayNightEnabled(dayNight);

  gameplay = createGameplay({ scene, world, player, ui, audio, effects });
  ui.updateProgress(gameplay.getProgress());

  // 存檔資料包含玩家位置
  function save() {
    if (!playing) return;
    const data = gameplay.getSaveData() || {};
    const d = player.getDirection(new THREE.Vector3());
    data.__player = [d.x, d.y, d.z];
    if (world.getTimeOfDay) data.__time = world.getTimeOfDay();
    writeSave(data);
  }
  const origLoad = gameplay.loadSaveData.bind(gameplay);
  gameplay.loadSaveData = (data) => {
    origLoad(data);
    if (data && Array.isArray(data.__player) && data.__player.length === 3) {
      const v = new THREE.Vector3(...data.__player);
      if (v.lengthSq() > 0.5) player.setDirection(v.normalize());
    }
    if (data && Number.isFinite(data.__time) && world.setTimeOfDay && dayNight) world.setTimeOfDay(data.__time);
  };

  // 角色事件 → 音效
  player.onJump = () => audio.play('jump');
  player.onLand = () => audio.play(player.inWater ? 'splash' : 'land');
  const _trailPos = new THREE.Vector3();
  player.onStep = () => {
    audio.play(player.inWater ? 'splash' : 'step');
    const eq = gameplay.getEquipped ? gameplay.getEquipped() : null;
    if (eq && eq.trail && effects.trail) {
      _trailPos.copy(player.position).addScaledVector(player.up, 0.1);
      effects.trail(_trailPos, player.up, eq.trail);
    }
  };
  player.onBounce = () => audio.play('bounce');

  const radar = createRadar({ root: touchRoot });

  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  window.addEventListener('pagehide', save);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  input.setEnabled(false);
  ui.showStart({ hasSave: !!readSave() });

  const clock = new THREE.Clock();
  let t = 0;
  let wasModal = false;
  let wasNight = null;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 1 / 20);
    t += dt;

    const modal = ui.isModalOpen();
    if (modal !== wasModal) {
      input.setEnabled(playing && !modal);
      wasModal = modal;
    }

    if (playing && !modal) {
      player.update(dt, input.state, camera);
      if (input.state.interactPressed && gameplay.interact) gameplay.interact();
      gameplay.update(dt, t);
      saveTimer += dt;
      if (saveTimer > 8) { saveTimer = 0; save(); }
    }

    cameraRig.update(dt);
    world.update(dt, t, camera);
    if (world.isNight && audio.setNight) {
      const night = world.isNight();
      if (night !== wasNight) { audio.setNight(night); if (ui.setNight) ui.setNight(night); wasNight = night; }
    }
    effects.update(dt);

    // v2：互動提示、導航（指南針等級）與雷達
    const hint = playing && !modal && gameplay.getInteractHint ? gameplay.getInteractHint() : null;
    if (input.setInteractHint) input.setInteractHint(hint);
    if (ui.setPrompt) ui.setPrompt(hint && !input.isTouch ? `F ${hint}` : null);

    if (playing && gameplay.getNavInfo && ui.setNav) {
      const nav = gameplay.getNavInfo();
      ui.setNav(nav);
      radar.setVisible(!modal);
      radar.update(nav, player, camera);
    } else {
      const target = playing ? gameplay.getNearestTarget() : null;
      ui.setTarget(target ? target.position : null, target ? target.label : '');
      radar.setVisible(false);
    }
    ui.update(dt, camera, player);

    renderer.render(scene, camera);
    input.endFrame();
  });

  // 開發/測試用掛勾
  window.__game = { THREE, scene, camera, renderer, world, player, input, cameraRig, gameplay, ui, audio, effects, radar };

  requestAnimationFrame(() => {
    boot.classList.add('hidden');
    setTimeout(() => boot.remove(), 700);
  });
}

try {
  start();
} catch (err) {
  bootError(err);
}
window.addEventListener('error', (e) => { if (document.getElementById('boot')) bootError(e.error || e.message); });
