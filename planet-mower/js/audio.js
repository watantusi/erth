// 星際除草王 — 音效 / 音樂（全部 WebAudio 程序合成，不載入任何音檔）
// 介面：Sound.init / toggleMute / isMuted / setEngine / setMow / play / music
// 所有方法在 AudioContext 不存在時都安靜地什麼都不做。

const MUTE_KEY = 'planet-mower-muted';
const MASTER_VOL = 0.8;

let ctx = null;
let master = null;   // 總音量（靜音控制）
let sfxBus = null;   // 音效
let musicBus = null; // 音樂
let noiseBuf = null;

let muted = false;
try {
  muted = typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1';
} catch (e) { muted = false; }

// ---------- 小工具 ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function now() { return ctx ? ctx.currentTime : 0; }

function makeNoiseBuffer(seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// 單音：含音高滑動與 ADSR 風格包絡
function tone(freq, t, dur, opts = {}) {
  if (!ctx) return;
  const {
    type = 'square', vol = 0.2, slideTo = null, attack = 0.005,
    release = null, dest = sfxBus, detune = 0, filter = null,
  } = opts;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (detune) o.detune.setValueAtTime(detune, t);
  if (slideTo != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
  const rel = release != null ? release : dur * 0.6;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.setValueAtTime(vol, t + Math.max(attack, dur - rel));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = o;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = filter.type || 'lowpass';
    f.frequency.setValueAtTime(filter.freq || 2000, t);
    if (filter.to) f.frequency.exponentialRampToValueAtTime(filter.to, t + dur);
    f.Q.value = filter.Q || 1;
    o.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.05);
}

// 噪音爆發（打擊、碰撞、沙沙聲）
function noise(t, dur, opts = {}) {
  if (!ctx || !noiseBuf) return;
  const { vol = 0.3, type = 'bandpass', freq = 1500, to = null, Q = 1, dest = sfxBus, attack = 0.002 } = opts;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
  f.Q.value = Q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(dest);
  const off = Math.random() * 1.5;
  s.start(t, off);
  s.stop(t + dur + 0.05);
}

// ---------- 引擎聲 ----------
let eng = null;
let engLast = { speed: -1, on: null };

function buildEngine() {
  if (!ctx || eng) return;
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  const sq = ctx.createOscillator();
  sq.type = 'square';
  const sqGain = ctx.createGain();
  sqGain.gain.value = 0.5;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 400;
  lp.Q.value = 3;

  // 「噗噗噗」：低頻振幅調變
  const am = ctx.createGain();
  am.gain.value = 0.55;
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 9;
  const lfoSmooth = ctx.createBiquadFilter(); // 讓方波 LFO 圓一點，避免喀喀聲
  lfoSmooth.type = 'lowpass';
  lfoSmooth.frequency.value = 60;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.45;

  const out = ctx.createGain();
  out.gain.value = 0;

  saw.connect(lp);
  sq.connect(sqGain); sqGain.connect(lp);
  lp.connect(am);
  lfo.connect(lfoSmooth); lfoSmooth.connect(lfoDepth); lfoDepth.connect(am.gain);
  am.connect(out);
  out.connect(sfxBus);

  const t = now();
  saw.frequency.setValueAtTime(55, t);
  sq.frequency.setValueAtTime(27.5, t);
  saw.start(t); sq.start(t); lfo.start(t);
  eng = { saw, sq, lp, lfo, out };
}

// ---------- 割草聲 ----------
let mow = null;
let mowLevel = 0;

function buildMow() {
  if (!ctx || mow || !noiseBuf) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2600;
  bp.Q.value = 0.9;
  const bp2 = ctx.createBiquadFilter(); // 第二層：低一點的「嘶嘶」厚度
  bp2.type = 'bandpass';
  bp2.frequency.value = 900;
  bp2.Q.value = 1.2;
  const g2 = ctx.createGain();
  g2.gain.value = 0.5;
  // 刀片旋轉的輕微顫動
  const flut = ctx.createOscillator();
  flut.type = 'sine';
  flut.frequency.value = 23;
  const flutDepth = ctx.createGain();
  flutDepth.gain.value = 0.25;
  const trem = ctx.createGain();
  trem.gain.value = 0.75;
  const out = ctx.createGain();
  out.gain.value = 0;

  src.connect(bp); bp.connect(trem);
  src.connect(bp2); bp2.connect(g2); g2.connect(trem);
  flut.connect(flutDepth); flutDepth.connect(trem.gain);
  trem.connect(out);
  out.connect(sfxBus);
  const t = now();
  src.start(t);
  flut.start(t);
  mow = { src, bp, out };
}

// ---------- 音樂（lookahead 排程器） ----------
const BPM = 116;
const STEP = 60 / BPM / 4;        // 16 分音符
const LOOKAHEAD = 0.12;            // 秒：往前排程的範圍
const TICK_MS = 25;                // 排程器呼叫間隔
let musicOn = false;
let musicTimer = null;
let nextStepTime = 0;
let stepIdx = 0;

// 和弦進行（根音 MIDI）：C - Am - F - G，帶點太空感的加九音
const CHORDS = [
  { root: 48, notes: [60, 64, 67, 74] },
  { root: 45, notes: [57, 60, 64, 71] },
  { root: 41, notes: [57, 60, 65, 67] },
  { root: 43, notes: [59, 62, 67, 69] },
];
const PENTA = [72, 74, 76, 79, 81, 84];
// 旋律樣板（每小節 16 步，-1 = 休止，數字 = PENTA 索引偏移）
const MELODY = [
  [0, -1, 2, -1, 3, -1, 2, -1, 4, -1, -1, 3, 2, -1, -1, -1],
  [1, -1, 2, -1, 0, -1, -1, 1, 2, -1, 4, -1, 3, -1, -1, -1],
  [2, -1, 3, -1, 4, -1, 5, -1, 4, -1, 3, -1, 2, -1, 0, -1],
  [3, -1, -1, 2, 1, -1, 3, -1, 4, -1, -1, -1, -1, -1, -1, -1],
];

function scheduleStep(i, t) {
  const bar = Math.floor(i / 16) % 4;
  const s = i % 16;
  const phrase = Math.floor(i / 64) % 2; // 每兩輪換旋律變奏
  const ch = CHORDS[bar];
  const dest = musicBus;

  // 低音：八分音符跳動
  if (s % 4 === 0) {
    tone(mtof(ch.root), t, STEP * 1.8, { type: 'triangle', vol: 0.22, dest, release: STEP });
  } else if (s % 4 === 2) {
    tone(mtof(ch.root + 12), t, STEP * 1.2, { type: 'triangle', vol: 0.12, dest, release: STEP * 0.8 });
  }

  // 琶音：閃爍的太空琶音（正弦+微 detune）
  if (s % 2 === 0) {
    const n = ch.notes[(s / 2) % ch.notes.length] + (s >= 8 ? 12 : 0);
    tone(mtof(n), t, STEP * 1.6, { type: 'sine', vol: 0.06, dest, release: STEP * 1.2 });
    tone(mtof(n), t, STEP * 1.6, { type: 'sine', vol: 0.03, dest, detune: 9, release: STEP * 1.2 });
  }

  // 主旋律：方波經低通，像小玩具合成器
  const m = MELODY[(bar + phrase * 2) % 4][s];
  if (m >= 0) {
    const n = PENTA[m % PENTA.length];
    tone(mtof(n), t, STEP * 1.7, {
      type: 'square', vol: 0.045, dest, release: STEP,
      filter: { type: 'lowpass', freq: 2400, to: 900, Q: 2 },
    });
  }

  // 輕打擊：hi-hat 與輕柔大鼓
  if (s % 2 === 1) noise(t, 0.04, { vol: 0.035, type: 'highpass', freq: 7000, dest });
  if (s === 0 || s === 8) {
    tone(120, t, 0.18, { type: 'sine', vol: 0.25, slideTo: 45, dest, release: 0.15 });
  }
  if (s === 4 || s === 12) noise(t, 0.12, { vol: 0.06, type: 'bandpass', freq: 1800, Q: 0.7, dest });
}

function scheduler() {
  if (!ctx || !musicOn) return;
  const ct = ctx.currentTime;
  // 分頁背景化後 setInterval 被節流：落後太多時直接跳到現在，避免一次爆量排程
  if (nextStepTime < ct - 0.2) nextStepTime = ct + 0.05;
  while (nextStepTime < ct + LOOKAHEAD) {
    if (!muted) scheduleStep(stepIdx, nextStepTime);
    nextStepTime += STEP;
    stepIdx = (stepIdx + 1) % 128;
  }
}

function startMusicTimer() {
  if (!ctx || musicTimer) return;
  nextStepTime = ctx.currentTime + 0.1;
  stepIdx = 0;
  musicBus.gain.cancelScheduledValues(ctx.currentTime);
  musicBus.gain.setTargetAtTime(0.5, ctx.currentTime, 0.3);
  try { musicTimer = setInterval(scheduler, TICK_MS); } catch (e) { musicTimer = null; }
  scheduler();
}

function stopMusicTimer() {
  if (musicTimer) { try { clearInterval(musicTimer); } catch (e) { /* ignore */ } }
  musicTimer = null;
  if (ctx && musicBus) {
    musicBus.gain.cancelScheduledValues(ctx.currentTime);
    musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
  }
}

// ---------- 音效庫 ----------
const SFX = {
  click(t) {
    tone(1200, t, 0.05, { type: 'square', vol: 0.12, slideTo: 800, release: 0.04 });
  },
  count(t) {
    tone(660, t, 0.16, { type: 'square', vol: 0.15, release: 0.1, filter: { freq: 3000 } });
    tone(1320, t, 0.12, { type: 'sine', vol: 0.06, release: 0.1 });
  },
  go(t) {
    // 「出發！」高八度長音 + 往上滑
    tone(880, t, 0.45, { type: 'square', vol: 0.15, release: 0.3, filter: { freq: 3500 } });
    tone(1320, t, 0.45, { type: 'sawtooth', vol: 0.07, release: 0.3, filter: { freq: 3000 } });
    tone(440, t, 0.5, { type: 'triangle', vol: 0.15, slideTo: 880, release: 0.3 });
  },
  pickup(t) {
    // 上升琶音
    [0, 4, 7, 12, 16].forEach((st, i) => {
      tone(mtof(76 + st), t + i * 0.05, 0.14, { type: 'square', vol: 0.09, release: 0.1, filter: { freq: 4000 } });
      tone(mtof(88 + st), t + i * 0.05, 0.12, { type: 'sine', vol: 0.05, release: 0.1 });
    });
  },
  hit(t) {
    // 受傷：刺耳下滑 + 噪音
    tone(420, t, 0.4, { type: 'sawtooth', vol: 0.2, slideTo: 70, release: 0.3, filter: { freq: 2000, to: 300 } });
    tone(300, t, 0.35, { type: 'square', vol: 0.1, slideTo: 60, detune: 30, release: 0.25 });
    noise(t, 0.3, { vol: 0.25, type: 'lowpass', freq: 3000, to: 400 });
  },
  bump(t) {
    // 撞到：悶悶的「咚」
    tone(140, t, 0.18, { type: 'sine', vol: 0.35, slideTo: 50, release: 0.15 });
    noise(t, 0.08, { vol: 0.18, type: 'lowpass', freq: 900 });
  },
  tick(t) {
    // 剩餘時間滴答
    tone(1800, t, 0.03, { type: 'square', vol: 0.06, release: 0.02, filter: { type: 'highpass', freq: 1000 } });
    noise(t, 0.025, { vol: 0.05, type: 'highpass', freq: 5000 });
  },
  boost(t) {
    // 加速：噴射嘶聲往上 + 上滑音
    noise(t, 0.5, { vol: 0.25, type: 'bandpass', freq: 500, to: 4000, Q: 1.5, attack: 0.03 });
    tone(200, t, 0.4, { type: 'sawtooth', vol: 0.08, slideTo: 900, release: 0.2, filter: { freq: 1500, to: 4000 } });
  },
  win(t) {
    // 小號角勝利旋律：G C E G - E G(長)
    const seq = [[67, 0, 0.12], [72, 0.12, 0.12], [76, 0.24, 0.12], [79, 0.36, 0.28], [76, 0.66, 0.12], [79, 0.78, 0.7]];
    seq.forEach(([n, off, d]) => {
      const f = mtof(n);
      const o = { release: Math.min(d, 0.2), attack: 0.02 };
      tone(f, t + off, d, { ...o, type: 'sawtooth', vol: 0.09, filter: { freq: 2200, Q: 1.5 } });
      tone(f, t + off, d, { ...o, type: 'square', vol: 0.05, detune: 7, filter: { freq: 1800 } });
      tone(f / 2, t + off, d, { ...o, type: 'triangle', vol: 0.1 });
    });
    // 結尾和弦
    [60, 64, 67, 72].forEach((n) => tone(mtof(n), t + 0.78, 0.9, { type: 'triangle', vol: 0.06, attack: 0.03, release: 0.6 }));
  },
  lose(t) {
    // 下降悲傷音：三連降 + 長嗚
    [[67, 0], [66, 0.3], [65, 0.6]].forEach(([n, off]) => {
      tone(mtof(n), t + off, 0.28, { type: 'square', vol: 0.1, release: 0.15, filter: { freq: 1400 } });
    });
    tone(mtof(64), t + 0.9, 1.0, { type: 'square', vol: 0.1, slideTo: mtof(52), release: 0.7, filter: { freq: 1400, to: 300 } });
    tone(mtof(40), t + 0.9, 1.0, { type: 'triangle', vol: 0.15, slideTo: mtof(33), release: 0.7 });
  },
};

// iOS：在手勢中播一個無聲 buffer 以解鎖輸出
function unlockIOS() {
  try {
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start(0);
  } catch (e) { /* ignore */ }
}

function applyMute() {
  if (!ctx || !master) return;
  try {
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(muted ? 0 : MASTER_VOL, t, 0.03);
  } catch (e) { /* ignore */ }
}

export const Sound = {
  init() {
    try {
      if (!ctx) {
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : MASTER_VOL;
        // 輕微壓縮，避免多個音效疊加爆音
        let out = master;
        if (ctx.createDynamicsCompressor) {
          const comp = ctx.createDynamicsCompressor();
          comp.threshold.value = -14;
          comp.ratio.value = 4;
          master.connect(comp);
          out = comp;
        }
        out.connect(ctx.destination);
        sfxBus = ctx.createGain();
        sfxBus.gain.value = 1;
        sfxBus.connect(master);
        musicBus = ctx.createGain();
        musicBus.gain.value = 0;
        musicBus.connect(master);
        noiseBuf = makeNoiseBuffer(2);
        buildEngine();
        buildMow();
        unlockIOS();
        if (musicOn) startMusicTimer();
      }
      if (ctx.state !== 'running' && ctx.resume) {
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) {
      // 建立失敗：安靜忽略，之後所有方法都會是 no-op
      ctx = null; master = null; sfxBus = null; musicBus = null; eng = null; mow = null;
    }
  },

  toggleMute() {
    muted = !muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
    applyMute();
    return muted;
  },

  isMuted() { return muted; },

  setEngine(speed01, on) {
    if (!ctx || !eng) return;
    try {
      const s = clamp(Number(speed01) || 0, 0, 1.6);
      const isOn = !!on;
      if (isOn === engLast.on && Math.abs(s - engLast.speed) < 0.01) return;
      engLast.on = isOn; engLast.speed = s;
      const t = ctx.currentTime;
      const base = 48 + s * 70;              // 主頻 48→~160 Hz
      eng.saw.frequency.setTargetAtTime(base, t, 0.06);
      eng.sq.frequency.setTargetAtTime(base * 0.5, t, 0.06);
      eng.lfo.frequency.setTargetAtTime(8 + s * 18, t, 0.08);      // 噗噗節奏變快
      eng.lp.frequency.setTargetAtTime(300 + s * 900, t, 0.08);   // 越快越亮
      const vol = isOn ? 0.09 + Math.min(s, 1.2) * 0.07 : 0;
      eng.out.gain.setTargetAtTime(vol, t, isOn ? 0.08 : 0.25);
    } catch (e) { /* ignore */ }
  },

  setMow(level01) {
    if (!ctx || !mow) return;
    try {
      const target = clamp(Number(level01) || 0, 0, 1);
      // 內部平滑：上升快、下降慢
      const k = target > mowLevel ? 0.3 : 0.08;
      mowLevel += (target - mowLevel) * k;
      if (mowLevel < 0.002) mowLevel = 0;
      const t = ctx.currentTime;
      mow.out.gain.setTargetAtTime(mowLevel * 0.22, t, 0.05);
      mow.bp.frequency.setTargetAtTime(2000 + mowLevel * 1800, t, 0.1);
    } catch (e) { /* ignore */ }
  },

  play(name) {
    if (!ctx || muted) return;
    const fn = SFX[name];
    if (!fn) return;
    try {
      if (ctx.state !== 'running' && ctx.resume) {
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
      fn(ctx.currentTime + 0.01);
    } catch (e) { /* ignore */ }
  },

  music(on) {
    musicOn = !!on;
    if (!ctx || !musicBus) return;
    try {
      if (musicOn) startMusicTimer();
      else stopMusicTimer();
    } catch (e) { /* ignore */ }
  },
};

export default Sound;
