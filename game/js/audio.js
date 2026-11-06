// 分身 5：音效。全部用 Web Audio API 即時合成，不載入任何音檔。
// v3：夜晚環境音（蟲鳴、貓頭鷹、夜風）與柔和的夜晚音樂；測驗、解鎖、換裝、橡實、計時挑戰音效。
import { SAVE_KEY } from './config.js';

const MUTE_KEY = SAVE_KEY + ':muted';

// C 大調五聲音階（MIDI）
const PENTA = [0, 2, 4, 7, 9];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

function readMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}
function writeMuted(m) {
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* 忽略 */ }
}

export function createAudio() {
  let muted = readMuted();
  let ctx = null;
  let master = null, sfxBus = null, musicBus = null, musicDuck = null;
  let noiseBuf = null;
  let delayIn = null; // 音樂撥弦的回授延遲
  let musicOn = false;
  let musicTimer = 0;
  let nextBeat = 0;
  let beatIndex = 0;
  let lastStep = 0;
  let lastSplash = 0;
  let lastTalk = 0;
  let lastTick = 0;
  let lastBounce = 0;
  let userSuspended = false;
  // v3：夜晚
  let night = false;
  let nightBus = null, musicNight = null, musicLP = null, nightBed = null;
  let nightTimer = 0;
  let nightOffAt = 0;
  let nextOwl = 0;
  const crickets = [
    { f: 4300, pan: -0.55, period: 0.95, pulses: 3, next: 0 },
    { f: 4750, pan: 0.5, period: 1.2, pulses: 4, next: 0 },
    { f: 3900, pan: 0.1, period: 1.55, pulses: 3, next: 0 },
  ];

  // ---------- 建立音訊圖 ----------
  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      try { ctx = new AC(); } catch { ctx = null; return false; }
    }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;

    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(comp);
    comp.connect(ctx.destination);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.8;
    sfxBus.connect(master);

    musicDuck = ctx.createGain();
    musicDuck.gain.value = 1;
    musicDuck.connect(master);
    // 音樂：musicBus → 夜晚低通 → 夜晚音量 → 閃避 → master
    musicNight = ctx.createGain();
    musicNight.gain.value = night ? 0.6 : 1;
    musicNight.connect(musicDuck);
    musicLP = ctx.createBiquadFilter();
    musicLP.type = 'lowpass';
    musicLP.frequency.value = night ? 1500 : 18000;
    musicLP.Q.value = 0.5;
    musicLP.connect(musicNight);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.16;
    musicBus.connect(musicLP);
    // 夜晚環境音
    nightBus = ctx.createGain();
    nightBus.gain.value = 0;
    nightBus.connect(master);

    // 撥弦用回授延遲（迴圈裡加低通讓回音越來越柔）
    delayIn = ctx.createGain();
    delayIn.gain.value = 1;
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.62;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    delayIn.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    lp.connect(wet);
    wet.connect(musicBus);

    // 1 秒白噪音
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    if (night) applyNight(true);
    return true;
  }

  function ready() {
    return !!ctx && !muted && ctx.state === 'running';
  }

  // ---------- 合成小工具 ----------
  /** 單一振盪器音符，含 ADSR 式包絡 */
  function tone(freq, t0, dur, o = {}) {
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + (o.glide || dur));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const peak = o.gain ?? 0.2;
    const atk = o.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    let out = g;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.filter;
      g.connect(f);
      out = f;
    }
    out.connect(o.dest || sfxBus);
    if (o.send) out.connect(o.send);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    return osc;
  }

  /** 濾波噪音 */
  function noise(t0, dur, o = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = o.rate || 1;
    const f = ctx.createBiquadFilter();
    f.type = o.filterType || 'bandpass';
    f.frequency.setValueAtTime(o.freq || 1200, t0);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + dur);
    f.Q.value = o.Q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.2, t0 + (o.attack ?? 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(o.dest || sfxBus);
    const off = Math.random() * 0.5;
    src.start(t0, off, dur + 0.05);
  }

  function duck(amount = 0.3, hold = 0.6, release = 1.2) {
    const t = ctx.currentTime;
    const p = musicDuck.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(amount, t + 0.08);
    p.setValueAtTime(amount, t + 0.08 + hold);
    p.linearRampToValueAtTime(1, t + 0.08 + hold + release);
  }

  /** 頻率帶顫音的振盪器（彈簧「啵嚶」用） */
  function wobble(f0, f1, t0, dur, o = {}) {
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f1, t0 + (o.glide || dur * 0.5));
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(o.rate || 16, t0);
    lfo.frequency.linearRampToValueAtTime((o.rate || 16) * 0.6, t0 + dur);
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(f1 * (o.depth || 0.12), t0);
    depth.gain.exponentialRampToValueAtTime(Math.max(0.5, f1 * 0.01), t0 + dur);
    lfo.connect(depth);
    depth.connect(osc.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.18, t0 + (o.attack ?? 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(o.dest || sfxBus);
    osc.start(t0);
    lfo.start(t0);
    osc.stop(t0 + dur + 0.05);
    lfo.stop(t0 + dur + 0.05);
  }

  // ---------- 音效 ----------
  const sounds = {
    collect() {
      const t = ctx.currentTime + 0.01;
      const root = 72 + pick([0, 2, 4]);
      const steps = [0, 4, 7, 12, 16];
      steps.forEach((s, i) => {
        const f = mtof(root + s) * rand(0.995, 1.005);
        tone(f, t + i * 0.065, 0.55, { type: 'sine', gain: 0.16, attack: 0.004 });
        tone(f * 2, t + i * 0.065, 0.3, { type: 'triangle', gain: 0.035, attack: 0.004 });
      });
      tone(mtof(root + 24), t + 0.36, 0.9, { type: 'sine', gain: 0.07 });
      duck(0.3, 0.7, 1.2);
    },
    jump() {
      const t = ctx.currentTime + 0.005;
      const f = rand(260, 300);
      tone(f, t, 0.22, { type: 'sine', gain: 0.16, freqEnd: f * 2.1, glide: 0.14, attack: 0.008 });
      tone(f * 1.5, t, 0.12, { type: 'triangle', gain: 0.03, freqEnd: f * 3, glide: 0.1 });
    },
    land() {
      const t = ctx.currentTime + 0.005;
      tone(rand(110, 130), t, 0.16, { type: 'sine', gain: 0.22, freqEnd: 55, glide: 0.12, attack: 0.003 });
      noise(t, 0.09, { filterType: 'lowpass', freq: 700, gain: 0.08, attack: 0.003 });
    },
    step() {
      const now = ctx.currentTime;
      if (now - lastStep < 0.12) return;
      lastStep = now;
      const t = now + 0.003;
      noise(t, 0.045, { filterType: 'bandpass', freq: rand(1600, 2600), Q: 2.5, gain: 0.035, attack: 0.002 });
      tone(rand(170, 210), t, 0.05, { type: 'sine', gain: 0.03, attack: 0.002 });
    },
    splash() {
      const now = ctx.currentTime;
      if (now - lastSplash < 0.1) return;
      lastSplash = now;
      const t = now + 0.005;
      noise(t, 0.32, { filterType: 'bandpass', freq: rand(1800, 2400), freqEnd: 500, Q: 0.9, gain: 0.12, attack: 0.01 });
      noise(t + 0.03, 0.18, { filterType: 'highpass', freq: 3500, gain: 0.03, attack: 0.01 });
      tone(rand(500, 700), t, 0.12, { type: 'sine', gain: 0.03, freqEnd: 1200, glide: 0.1 });
    },
    plant() {
      const t = ctx.currentTime + 0.01;
      const base = 60 + pick([0, 2]);
      for (let i = 0; i < 8; i++) {
        const m = base + 12 * Math.floor(i / 5) + PENTA[i % 5] + 12;
        tone(mtof(m) * rand(0.997, 1.003), t + i * 0.055, 0.5, { type: 'triangle', gain: 0.08, attack: 0.006 });
      }
      tone(mtof(base), t, 0.8, { type: 'sine', gain: 0.1, freqEnd: mtof(base + 12), glide: 0.45, attack: 0.05 });
      noise(t, 0.6, { filterType: 'highpass', freq: 5000, freqEnd: 9000, gain: 0.025, attack: 0.2 });
      duck(0.5, 0.4, 0.8);
    },
    seed() {
      const t = ctx.currentTime + 0.005;
      const f = mtof(84 + pick(PENTA)) * rand(0.99, 1.01);
      tone(f, t, 0.18, { type: 'square', gain: 0.04, filter: 3200, attack: 0.003 });
      tone(f * 1.5, t + 0.06, 0.2, { type: 'sine', gain: 0.08, attack: 0.003 });
    },
    emote() {
      const t = ctx.currentTime + 0.005;
      const f = rand(520, 620);
      tone(f, t, 0.12, { type: 'sine', gain: 0.16, freqEnd: f * 1.8, glide: 0.06, attack: 0.003 });
      tone(f * 2.2, t + 0.06, 0.1, { type: 'sine', gain: 0.06, attack: 0.003 });
    },
    ui() {
      const t = ctx.currentTime + 0.003;
      const f = rand(1150, 1300);
      tone(f, t, 0.06, { type: 'triangle', gain: 0.09, freqEnd: f * 0.7, glide: 0.05, attack: 0.002 });
    },
    npc() {
      const t = ctx.currentTime + 0.01;
      const notes = [rand(600, 700), rand(380, 440), rand(700, 820)];
      notes.forEach((f, i) => {
        tone(f, t + i * 0.11, 0.09, { type: 'square', gain: 0.035, filter: 2200, attack: 0.004 });
        tone(f, t + i * 0.11, 0.09, { type: 'sine', gain: 0.06, attack: 0.004 });
      });
    },
    win() {
      const t = ctx.currentTime + 0.02;
      const seq = [[67, 0], [72, 0.14], [76, 0.28], [79, 0.42], [76, 0.6], [79, 0.72]];
      seq.forEach(([m, dt]) => {
        tone(mtof(m), t + dt, 0.35, { type: 'triangle', gain: 0.12, attack: 0.006 });
        tone(mtof(m + 12), t + dt, 0.2, { type: 'sine', gain: 0.03, attack: 0.006 });
      });
      [72, 76, 79, 84].forEach((m) => {
        tone(mtof(m) * rand(0.998, 1.002), t + 0.9, 1.6, { type: 'sine', gain: 0.07, attack: 0.02 });
        tone(mtof(m) * 1.003, t + 0.9, 1.6, { type: 'triangle', gain: 0.025, attack: 0.02 });
      });
      for (let i = 0; i < 6; i++) {
        tone(mtof(96 + pick(PENTA)), t + 0.95 + i * 0.09, 0.3, { type: 'sine', gain: 0.03 });
      }
      duck(0.15, 2.0, 2.0);
    },

    // ---- v2 ----
    bounce() {
      // 彈跳蘑菇：比跳躍更大、更有彈性的「啵嚶～」
      const now = ctx.currentTime;
      if (now - lastBounce < 0.08) return;
      lastBounce = now;
      const t = now + 0.005;
      const f = rand(150, 175);
      tone(f * 0.55, t, 0.12, { type: 'sine', gain: 0.2, freqEnd: f * 0.35, glide: 0.1, attack: 0.003 }); // 踩下去的悶聲
      wobble(f, f * 3.6, t + 0.02, 0.5, { type: 'sine', gain: 0.2, glide: 0.2, rate: 17, depth: 0.1 });
      wobble(f * 2, f * 7.2, t + 0.02, 0.32, { type: 'triangle', gain: 0.04, glide: 0.2, rate: 17, depth: 0.08 });
      noise(t, 0.05, { filterType: 'lowpass', freq: 900, gain: 0.06, attack: 0.002 });
    },
    talk() {
      // 對話：輕柔可愛的「噗」，音高隨機，限速
      const now = ctx.currentTime;
      if (now - lastTalk < 0.07) return;
      lastTalk = now;
      const t = now + 0.003;
      const f = mtof(76 + pick(PENTA)) * rand(0.97, 1.03);
      tone(f, t, 0.09, { type: 'sine', gain: 0.075, freqEnd: f * rand(1.08, 1.25), glide: 0.05, attack: 0.004 });
      tone(f * 2, t, 0.05, { type: 'triangle', gain: 0.012, attack: 0.003 });
    },
    quest() {
      // 接下任務：「噠～叮！」上行小號角 + 亮晶晶
      const t = ctx.currentTime + 0.01;
      const seq = [[67, 0, 0.16], [72, 0.11, 0.16], [79, 0.22, 0.42]];
      seq.forEach(([m, dt, d]) => {
        tone(mtof(m), t + dt, d, { type: 'square', gain: 0.03, filter: 2600, attack: 0.006 });
        tone(mtof(m), t + dt, d + 0.1, { type: 'triangle', gain: 0.1, attack: 0.006 });
      });
      tone(mtof(91), t + 0.26, 0.6, { type: 'sine', gain: 0.05, attack: 0.004 });
      noise(t + 0.22, 0.4, { filterType: 'highpass', freq: 6000, gain: 0.02, attack: 0.05 });
      duck(0.6, 0.3, 0.6);
    },
    questDone() {
      // 任務完成：溫暖的大和弦琶音 + 低音
      const t = ctx.currentTime + 0.02;
      const arp = [60, 64, 67, 72, 76];
      arp.forEach((m, i) => {
        tone(mtof(m) * rand(0.998, 1.002), t + i * 0.08, 0.9 - i * 0.05, { type: 'triangle', gain: 0.1, attack: 0.008 });
        tone(mtof(m + 12), t + i * 0.08, 0.3, { type: 'sine', gain: 0.025, attack: 0.006 });
      });
      tone(mtof(48), t, 1.1, { type: 'sine', gain: 0.12, attack: 0.02 });
      [72, 76, 79].forEach((m) => {
        tone(mtof(m) * 1.002, t + 0.45, 1.3, { type: 'sine', gain: 0.05, attack: 0.08 });
        tone(mtof(m) * 0.998, t + 0.45, 1.3, { type: 'triangle', gain: 0.02, attack: 0.08 });
      });
      tone(mtof(84), t + 0.55, 0.9, { type: 'sine', gain: 0.04, attack: 0.01 });
      duck(0.25, 1.2, 1.4);
    },
    fragment() {
      // 地圖碎片：神秘的上行琶音 + 閃爍 + 終止和弦
      const t = ctx.currentTime + 0.02;
      const scale = [0, 2, 4, 7, 9];
      for (let i = 0; i < 12; i++) {
        const m = 62 + 12 * Math.floor(i / 5) + scale[i % 5];
        const tt = t + i * 0.06;
        tone(mtof(m), tt, 0.5, { type: 'sine', gain: 0.07, attack: 0.004 });
        tone(mtof(m) * 2.005, tt, 0.25, { type: 'triangle', gain: 0.015, attack: 0.004 });
      }
      noise(t, 1.2, { filterType: 'bandpass', freq: 3000, freqEnd: 11000, Q: 2, gain: 0.035, attack: 0.4 });
      const tc = t + 0.8;
      [62, 69, 74, 78, 81].forEach((m, i) => {
        tone(mtof(m) * rand(0.998, 1.002), tc + i * 0.015, 2.0, { type: 'sine', gain: 0.055, attack: 0.03 });
      });
      tone(mtof(50), tc, 2.0, { type: 'triangle', gain: 0.06, attack: 0.05, filter: 800 });
      for (let i = 0; i < 8; i++) {
        tone(mtof(93 + pick(PENTA)), tc + 0.1 + i * 0.11 + rand(0, 0.04), 0.35, { type: 'sine', gain: 0.025, attack: 0.003 });
      }
      duck(0.15, 2.0, 1.8);
    },
    tick() {
      // 計時：細小的時鐘「滴答」（交替高低）
      const now = ctx.currentTime;
      if (now - lastTick < 0.15) return;
      lastTick = now;
      const t = now + 0.003;
      const hi = (beatTick = !beatTick);
      noise(t, 0.025, { filterType: 'highpass', freq: hi ? 5200 : 3800, gain: 0.05, attack: 0.001 });
      tone(hi ? 1900 : 1500, t, 0.03, { type: 'sine', gain: 0.03, attack: 0.001 });
    },
    ping() {
      // 機器人訊號：無線電掃頻「咻嗚～」兩次 + 嗶
      const t = ctx.currentTime + 0.01;
      for (let k = 0; k < 2; k++) {
        const tt = t + k * 0.28;
        const g = k === 0 ? 0.08 : 0.045;
        tone(520, tt, 0.3, { type: 'sine', gain: g, freqEnd: 1700, glide: 0.24, attack: 0.02 });
        tone(780, tt, 0.26, { type: 'triangle', gain: g * 0.25, freqEnd: 2500, glide: 0.22, attack: 0.02 });
      }
      tone(1760, t + 0.62, 0.1, { type: 'square', gain: 0.025, filter: 3000, attack: 0.003 });
      tone(1760, t + 0.62, 0.14, { type: 'sine', gain: 0.06, attack: 0.003 });
      tone(2350, t + 0.76, 0.18, { type: 'sine', gain: 0.05, attack: 0.003 });
      noise(t, 0.6, { filterType: 'bandpass', freq: 2000, Q: 4, gain: 0.012, attack: 0.1 });
    },

    // ---- v3 ----
    correct() {
      // 答對：明亮的「叮咚↑」+ 閃亮
      const t = ctx.currentTime + 0.01;
      [[79, 0], [84, 0.1], [88, 0.2]].forEach(([m, dt], i) => {
        tone(mtof(m), t + dt, i === 2 ? 0.7 : 0.3, { type: 'triangle', gain: 0.11, attack: 0.004 });
        tone(mtof(m + 12), t + dt, 0.22, { type: 'sine', gain: 0.035, attack: 0.004 });
      });
      tone(mtof(76), t + 0.2, 0.7, { type: 'sine', gain: 0.06, attack: 0.01 });
      for (let i = 0; i < 5; i++) tone(mtof(96 + pick(PENTA)), t + 0.28 + i * 0.06, 0.25, { type: 'sine', gain: 0.025, attack: 0.003 });
      noise(t + 0.2, 0.5, { filterType: 'highpass', freq: 6500, gain: 0.02, attack: 0.05 });
      duck(0.45, 0.5, 0.8);
    },
    wrong() {
      // 答錯：溫柔的「嘟嗚～」往下兩聲，不刺耳
      const t = ctx.currentTime + 0.01;
      tone(mtof(67), t, 0.22, { type: 'triangle', gain: 0.09, freqEnd: mtof(66), glide: 0.2, attack: 0.012, filter: 1800 });
      tone(mtof(64), t + 0.2, 0.45, { type: 'triangle', gain: 0.085, freqEnd: mtof(62), glide: 0.4, attack: 0.012, filter: 1600 });
      tone(mtof(52), t + 0.2, 0.45, { type: 'sine', gain: 0.06, attack: 0.02 });
      duck(0.6, 0.3, 0.6);
    },
    unlock() {
      // 解鎖新裝扮：上行號角 + 和弦 + 一串閃光
      const t = ctx.currentTime + 0.02;
      [[60, 0], [64, 0.09], [67, 0.18], [72, 0.27], [76, 0.36]].forEach(([m, dt]) => {
        tone(mtof(m), t + dt, 0.3, { type: 'square', gain: 0.022, filter: 2600, attack: 0.005 });
        tone(mtof(m), t + dt, 0.38, { type: 'triangle', gain: 0.09, attack: 0.005 });
      });
      [72, 76, 79, 84].forEach((m, i) => {
        tone(mtof(m) * rand(0.998, 1.002), t + 0.48 + i * 0.012, 1.5, { type: 'sine', gain: 0.06, attack: 0.02 });
        tone(mtof(m) * 1.003, t + 0.48, 1.4, { type: 'triangle', gain: 0.02, attack: 0.02 });
      });
      tone(mtof(48), t + 0.48, 1.3, { type: 'sine', gain: 0.1, attack: 0.02 });
      for (let i = 0; i < 9; i++) tone(mtof(96 + pick(PENTA)), t + 0.55 + i * 0.07 + rand(0, 0.03), 0.3, { type: 'sine', gain: 0.025, attack: 0.003 });
      noise(t + 0.45, 1.0, { filterType: 'bandpass', freq: 5000, freqEnd: 11000, Q: 1.5, gain: 0.03, attack: 0.2 });
      duck(0.2, 1.4, 1.4);
    },
    equip() {
      // 換裝：布料「咻」+ 小「啵」+ 一聲小鈴
      const t = ctx.currentTime + 0.005;
      noise(t, 0.2, { filterType: 'bandpass', freq: 900, freqEnd: 3800, Q: 1.2, gain: 0.07, attack: 0.04 });
      tone(rand(520, 580), t + 0.12, 0.12, { type: 'sine', gain: 0.13, freqEnd: 900, glide: 0.07, attack: 0.003 });
      tone(mtof(88), t + 0.18, 0.4, { type: 'sine', gain: 0.05, attack: 0.003 });
      tone(mtof(95), t + 0.22, 0.3, { type: 'sine', gain: 0.025, attack: 0.003 });
    },
    acorn() {
      // 金色橡實：木頭「叩」+ 神奇的金色琶音
      const t = ctx.currentTime + 0.01;
      tone(rand(820, 900), t, 0.08, { type: 'sine', gain: 0.18, freqEnd: 520, glide: 0.06, attack: 0.002 });
      noise(t, 0.04, { filterType: 'bandpass', freq: 1800, Q: 3, gain: 0.08, attack: 0.002 });
      const seq = [69, 72, 76, 81, 84, 88];
      seq.forEach((m, i) => {
        tone(mtof(m), t + 0.1 + i * 0.06, 0.6, { type: 'triangle', gain: 0.08, attack: 0.004 });
        tone(mtof(m) * 2.003, t + 0.1 + i * 0.06, 0.3, { type: 'sine', gain: 0.02, attack: 0.004 });
      });
      [81, 85, 88].forEach((m) => tone(mtof(m), t + 0.5, 1.4, { type: 'sine', gain: 0.045, attack: 0.03 }));
      noise(t + 0.15, 1.0, { filterType: 'highpass', freq: 7000, gain: 0.025, attack: 0.3 });
      duck(0.3, 1.0, 1.2);
    },
    countdown() {
      // 倒數：清脆的「嗶」
      const t = ctx.currentTime + 0.005;
      tone(660, t, 0.2, { type: 'sine', gain: 0.17, attack: 0.003 });
      tone(660, t, 0.12, { type: 'square', gain: 0.025, filter: 2400, attack: 0.003 });
      tone(1320, t, 0.08, { type: 'sine', gain: 0.03, attack: 0.002 });
    },
    go() {
      // 出發：高八度的長「嗶～」+ 往上衝的風聲
      const t = ctx.currentTime + 0.005;
      tone(1320, t, 0.5, { type: 'sine', gain: 0.16, attack: 0.003 });
      tone(990, t, 0.45, { type: 'triangle', gain: 0.07, attack: 0.003 });
      tone(1320, t, 0.25, { type: 'square', gain: 0.02, filter: 3200, attack: 0.003 });
      noise(t, 0.45, { filterType: 'bandpass', freq: 600, freqEnd: 4200, Q: 0.8, gain: 0.06, attack: 0.05 });
      duck(0.5, 0.4, 0.8);
    },
    trialEnd() {
      // 計時挑戰結束：小號角終止式
      const t = ctx.currentTime + 0.02;
      const seq = [[67, 0, 0.14], [72, 0.12, 0.14], [76, 0.24, 0.14], [79, 0.36, 0.3], [76, 0.62, 0.12], [79, 0.72, 0.9]];
      seq.forEach(([m, dt, d]) => {
        tone(mtof(m), t + dt, d + 0.15, { type: 'square', gain: 0.025, filter: 2400, attack: 0.006 });
        tone(mtof(m), t + dt, d + 0.2, { type: 'triangle', gain: 0.1, attack: 0.006 });
      });
      tone(mtof(43), t, 0.25, { type: 'sine', gain: 0.16, freqEnd: mtof(36), glide: 0.2, attack: 0.004 });
      tone(mtof(43), t + 0.72, 0.6, { type: 'sine', gain: 0.14, freqEnd: mtof(36), glide: 0.5, attack: 0.004 });
      [72, 76, 79, 84].forEach((m) => tone(mtof(m) * rand(0.998, 1.002), t + 0.72, 1.6, { type: 'sine', gain: 0.05, attack: 0.03 }));
      for (let i = 0; i < 6; i++) tone(mtof(96 + pick(PENTA)), t + 0.8 + i * 0.09, 0.3, { type: 'sine', gain: 0.025 });
      duck(0.15, 1.8, 1.6);
    },
  };
  let beatTick = false;

  // ---------- v3：夜晚環境音 ----------
  /** 一聲蟋蟀：幾個很快的高頻脈衝 */
  function cricketChirp(t, c) {
    const n = c.pulses + (Math.random() < 0.3 ? 1 : 0);
    const f = c.f * rand(0.985, 1.015);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = f * 2.01;
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    const peak = rand(0.016, 0.026);
    for (let i = 0; i < n; i++) {
      const t0 = t + i * 0.046;
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.034);
    }
    osc.connect(amp);
    osc2.connect(g2);
    g2.connect(amp);
    let out = amp;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = c.pan;
      amp.connect(p);
      out = p;
    }
    out.connect(nightBus);
    const end = t + n * 0.046 + 0.05;
    osc.start(t); osc2.start(t);
    osc.stop(end); osc2.stop(end);
  }
  /** 遠方貓頭鷹「咕—咕咕」 */
  function owl(t) {
    const f = rand(370, 410);
    const hoot = (t0, d, g) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f * 1.04, t0);
      osc.frequency.exponentialRampToValueAtTime(f * 0.94, t0 + d);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const gg = ctx.createGain();
      gg.gain.setValueAtTime(0.0001, t0);
      gg.gain.exponentialRampToValueAtTime(g, t0 + 0.06);
      gg.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      osc.connect(lp); lp.connect(gg); gg.connect(nightBus);
      osc.start(t0); osc.stop(t0 + d + 0.05);
    };
    hoot(t, 0.45, 0.045);
    hoot(t + 0.62, 0.22, 0.032);
    hoot(t + 0.9, 0.4, 0.038);
  }
  function startNightBed() {
    if (nightBed) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      src.playbackRate.value = 0.5;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 520;
      const g = ctx.createGain();
      g.gain.value = 0.05;
      src.connect(lp); lp.connect(g); g.connect(nightBus);
      src.start();
      nightBed = src;
    } catch { nightBed = null; }
  }
  function scheduleNight() {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (!night && now > nightOffAt) {
      clearInterval(nightTimer);
      nightTimer = 0;
      return;
    }
    if (muted) return;
    for (const c of crickets) {
      if (c.next < now - 0.5) c.next = now + rand(0.05, c.period);
      while (c.next < now + 0.3) {
        // 偶爾休息一下，聽起來比較自然
        if (Math.random() < 0.12) c.next += rand(1.5, 4);
        else cricketChirp(c.next, c);
        c.next += c.period * rand(0.85, 1.2);
      }
    }
    if (!nextOwl) nextOwl = now + rand(8, 16);
    if (now > nextOwl) {
      owl(now + 0.05);
      nextOwl = now + rand(22, 40);
    }
  }
  function applyNight(instant) {
    if (!ctx || !nightBus) return;
    const t = ctx.currentTime;
    const ramp = (param, v, dur, exp) => {
      param.cancelScheduledValues(t);
      if (instant) { param.setValueAtTime(v, t); return; }
      param.setValueAtTime(param.value, t);
      if (exp) param.exponentialRampToValueAtTime(v, t + dur);
      else param.linearRampToValueAtTime(v, t + dur);
    };
    ramp(nightBus.gain, night ? 1 : 0, night ? 3.5 : 2.5);
    ramp(musicNight.gain, night ? 0.6 : 1, 4);
    ramp(musicLP.frequency, night ? 1500 : 18000, 4, true);
    if (night) {
      startNightBed();
      nextOwl = 0;
      if (!nightTimer) nightTimer = setInterval(scheduleNight, 100);
      scheduleNight();
    } else {
      nightOffAt = t + 3;
    }
  }

  // ---------- 生成式環境音樂 ----------
  const BEAT = 60 / 66;            // 每拍秒數
  const BEATS_PER_CHORD = 8;
  const CHORDS = [
    [48, 55, 64, 71], // Cmaj7
    [45, 52, 60, 67], // Am7
    [41, 48, 57, 64], // Fmaj7
    [43, 50, 59, 64], // G6
  ];

  function padChord(notes, t0, dur) {
    for (const m of notes) {
      const f = mtof(m);
      for (const det of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = f;
        osc.detune.value = det + rand(-2, 2);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.05, t0 + 2.2);
        g.gain.setValueAtTime(0.05, t0 + dur - 1.2);
        g.gain.linearRampToValueAtTime(0.0001, t0 + dur + 1.6);
        osc.connect(lp);
        lp.connect(g);
        g.connect(musicBus);
        osc.start(t0);
        osc.stop(t0 + dur + 1.7);
      }
    }
  }

  function pluck(m, t0) {
    const f = mtof(m);
    tone(f, t0, 1.4, { type: 'sine', gain: 0.12, attack: 0.004, dest: musicBus, send: delayIn });
    tone(f * 2, t0, 0.35, { type: 'triangle', gain: 0.025, attack: 0.003, dest: musicBus, send: delayIn });
  }

  function scheduleMusic() {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (nextBeat < now - 0.5) nextBeat = now + 0.05; // 從暫停回來
    while (nextBeat < now + 0.35) {
      const t = nextBeat;
      const chordIdx = Math.floor(beatIndex / BEATS_PER_CHORD) % CHORDS.length;
      const inChord = beatIndex % BEATS_PER_CHORD;
      if (!muted) {
        if (inChord === 0) padChord(CHORDS[chordIdx], t, BEAT * BEATS_PER_CHORD);
        // 稀疏的五聲音階撥弦（夜晚更少、更低）
        const p = (inChord === 0 ? 0.6 : inChord % 2 === 0 ? 0.32 : 0.14) * (night ? 0.7 : 1);
        if (Math.random() < p) {
          const oct = night ? (Math.random() < 0.75 ? 72 : 60) : (Math.random() < 0.7 ? 72 : 84);
          pluck(oct + pick(PENTA), t + (Math.random() < 0.25 ? BEAT * 0.5 : 0));
        }
      }
      beatIndex++;
      nextBeat += BEAT;
    }
  }

  // 背景時暫停，回來時恢復
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) {
      if (ctx.state === 'running') { ctx.suspend().catch(() => {}); userSuspended = true; }
    } else if (userSuspended || ctx.state !== 'running') {
      userSuspended = false;
      ctx.resume().catch(() => {});
    }
  });

  return {
    unlock() {
      if (!ctx && !build()) return;
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      // iOS：播一個無聲緩衝區以解鎖
      try {
        const b = ctx.createBuffer(1, 1, 22050);
        const s = ctx.createBufferSource();
        s.buffer = b;
        s.connect(ctx.destination);
        s.start(0);
      } catch { /* 忽略 */ }
    },
    play(name) {
      if (!ready()) return;
      const fn = sounds[name];
      if (!fn) return;
      try { fn(); } catch { /* 合成失敗不影響遊戲 */ }
    },
    setMuted(m) {
      muted = !!m;
      writeMuted(muted);
      if (ctx && master) {
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(muted ? 0 : 0.9, t + 0.15);
      }
    },
    isMuted() { return muted; },
    /** v3：夜晚蟲鳴環境音、音樂變柔和（約 3–4 秒交叉淡入淡出） */
    setNight(on) {
      on = !!on;
      if (on === night) return;
      night = on;
      if (ctx) { try { applyNight(false); } catch { /* 忽略 */ } }
    },
    isNight() { return night; },
    startMusic() {
      if (!ctx || musicOn) return;
      musicOn = true;
      nextBeat = ctx.currentTime + 0.3;
      beatIndex = 0;
      musicTimer = setInterval(scheduleMusic, 100);
      scheduleMusic();
    },
  };
}
