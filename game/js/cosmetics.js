// 分身 4：裝扮（v3）—— 目錄、解鎖規則、目前穿戴、存檔。由 gameplay.js 建立（模組內部 API）。
// 對外合約透過 gameplay.getWardrobe / equip / getEquipped 提供。
// v4：獎牌門檻文字讀 config.TRIAL_MEDALS；⭐ 也可以從地形測驗得到。
import { TRIAL_MEDALS } from './config.js';

const medalSec = (m) => (TRIAL_MEDALS && Number.isFinite(TRIAL_MEDALS[m]) ? `（${TRIAL_MEDALS[m]} 秒內完成）` : '');

export const SLOTS = [
  { id: 'hat', name: '帽子' },
  { id: 'scarf', name: '圍巾' },
  { id: 'trail', name: '腳印' },
];

export const DEFAULT_EQUIPPED = Object.freeze({ hat: null, scarf: 'sunny', trail: null });

/** 金色橡實對應的生態區順序（world.secretSpots 的 biome 對不上時，依索引對應） */
export const ACORN_BIOMES = ['meadow', 'forest', 'desert', 'polar', 'volcano', 'ocean'];

export const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };
export const MEDAL_NAMES = { bronze: '銅牌', silver: '銀牌', gold: '金牌' };

// rule：
//   { type: 'default' }
//   { type: 'stars', n }        ⭐ 數量門檻（答對測驗）
//   { type: 'fragments', n }    第 n 片地圖碎片
//   { type: 'acorn', biome }    找到該生態區的金色橡實
//   { type: 'medal', medal }    計時挑戰獎牌（拿到更好的獎牌也算）
//   { type: 'victory' }         星球恢復色彩（通關）
export const COSMETICS = [
  // ---- 帽子 ----
  { id: 'straw', slot: 'hat', name: '草帽', icon: '👒', rule: { type: 'fragments', n: 4 }, hint: '集到第 4 片地圖碎片' },
  { id: 'explorer', slot: 'hat', name: '探險帽', icon: '🤠', rule: { type: 'acorn', biome: 'desert' }, hint: '找到金色沙漠的金色橡實' },
  { id: 'beanie', slot: 'hat', name: '毛線帽', icon: '🧶', rule: { type: 'fragments', n: 5 }, hint: '集到第 5 片地圖碎片' },
  { id: 'flower', slot: 'hat', name: '花圈', icon: '🌸', rule: { type: 'acorn', biome: 'meadow' }, hint: '找到青青草原的金色橡實' },
  { id: 'penguin', slot: 'hat', name: '企鵝帽', icon: '🐧', rule: { type: 'medal', medal: 'gold' }, hint: '計時挑戰拿到金牌' + medalSec('gold') },
  { id: 'crown', slot: 'hat', name: '皇冠', icon: '👑', rule: { type: 'victory' }, hint: '讓星球恢復色彩（通關）' },
  // ---- 圍巾 ----
  { id: 'sunny', slot: 'scarf', name: '陽光黃圍巾', icon: '🟡', rule: { type: 'default' }, hint: '旅行一開始就有的圍巾' },
  { id: 'sky', slot: 'scarf', name: '天空藍圍巾', icon: '🔵', rule: { type: 'stars', n: 6 }, hint: '答對測驗（知識晶石或地形知識牌），集滿 6 顆 ⭐' },
  { id: 'mint', slot: 'scarf', name: '薄荷綠圍巾', icon: '🟢', rule: { type: 'fragments', n: 6 }, hint: '集到第 6 片地圖碎片' },
  { id: 'rose', slot: 'scarf', name: '玫瑰粉圍巾', icon: '🌹', rule: { type: 'medal', medal: 'bronze' }, hint: '計時挑戰拿到銅牌' + medalSec('bronze') },
  { id: 'lava', slot: 'scarf', name: '熔岩紅圍巾', icon: '🔴', rule: { type: 'acorn', biome: 'volcano' }, hint: '找到火山高地的金色橡實' },
  { id: 'night', slot: 'scarf', name: '星夜紫圍巾', icon: '🟣', rule: { type: 'acorn', biome: 'polar' }, hint: '找到冰雪極地的金色橡實（只在夜晚的極光下出現）' },
  // ---- 腳印特效 ----
  { id: 'leaf', slot: 'trail', name: '葉子腳印', icon: '🍃', rule: { type: 'acorn', biome: 'forest' }, hint: '找到翠綠森林的金色橡實' },
  { id: 'star', slot: 'trail', name: '星光腳印', icon: '⭐', rule: { type: 'stars', n: 12 }, hint: '答對測驗（知識晶石或地形知識牌），集滿 12 顆 ⭐' },
  { id: 'bubble', slot: 'trail', name: '泡泡腳印', icon: '🫧', rule: { type: 'acorn', biome: 'ocean' }, hint: '找到蔚藍海洋的金色橡實' },
  { id: 'snow', slot: 'trail', name: '雪花腳印', icon: '❄️', rule: { type: 'medal', medal: 'silver' }, hint: '計時挑戰拿到銀牌' + medalSec('silver') },
];

const BY_ID = new Map(COSMETICS.map((c) => [c.id, c]));
export const getCosmetic = (id) => BY_ID.get(id) || null;

/** 解鎖時彈窗的說明文字 */
export function unlockReason(item) {
  const r = item && item.rule;
  if (!r) return '';
  switch (r.type) {
    case 'stars': return `答對測驗集滿 ${r.n} 顆 ⭐ 的獎勵！`;
    case 'fragments': return `第 ${r.n} 片地圖碎片變成了驚喜裝扮！`;
    case 'acorn': return '找到金色橡實的獎勵！';
    case 'medal': return `計時挑戰拿到${MEDAL_NAMES[r.medal] || '獎牌'}的獎勵！`;
    case 'victory': return '星球恢復色彩了！這是送給地球小旅人的通關獎勵！';
    default: return '';
  }
}

function ruleMet(rule, ctx) {
  switch (rule.type) {
    case 'default': return true;
    case 'stars': return (ctx.stars || 0) >= rule.n;
    case 'fragments': return (ctx.fragments || 0) >= rule.n;
    case 'acorn': return !!(ctx.acorns && ctx.acorns.has(rule.biome));
    case 'medal': return (MEDAL_RANK[ctx.medal] || 0) >= (MEDAL_RANK[rule.medal] || 99);
    case 'victory': return !!ctx.victory;
    default: return false;
  }
}

/**
 * createCosmetics({ player, audio })
 *  → { check(ctx) → 新解鎖的物品陣列, isUnlocked(id), equip(slot, id) → bool, getEquipped(),
 *      getWardrobe(), apply(), getSaveData(), loadSaveData(d), reset() }
 *  ctx = { stars, fragments, acorns: Set<biomeId>, medal, victory }
 */
export function createCosmetics({ player, audio } = {}) {
  const unlocked = new Set();
  const equipped = { ...DEFAULT_EQUIPPED };
  const safe = (fn) => { try { return fn(); } catch (e) { console.warn('[cosmetics]', e); return undefined; } };

  function addDefaults() {
    for (const c of COSMETICS) if (c.rule.type === 'default') unlocked.add(c.id);
  }
  addDefaults();

  function apply() {
    if (player && typeof player.setCosmetics === 'function') {
      safe(() => player.setCosmetics({ hat: equipped.hat, scarf: equipped.scarf, trail: equipped.trail }));
    }
  }

  function check(ctx = {}) {
    const fresh = [];
    for (const c of COSMETICS) {
      if (unlocked.has(c.id)) continue;
      if (ruleMet(c.rule, ctx)) { unlocked.add(c.id); fresh.push(c); }
    }
    return fresh;
  }

  const isUnlocked = (id) => unlocked.has(id);

  function equip(slot, id) {
    if (!SLOTS.some((s) => s.id === slot)) return false;
    if (id === null || id === undefined || id === '' || id === 'none') {
      // 帽子、腳印可以拿掉；圍巾回到預設
      id = slot === 'scarf' ? DEFAULT_EQUIPPED.scarf : null;
    } else {
      const c = getCosmetic(id);
      if (!c || c.slot !== slot || !unlocked.has(id)) return false;
    }
    equipped[slot] = id;
    apply();
    if (audio) safe(() => audio.play('equip'));
    return true;
  }

  const getEquipped = () => ({ hat: equipped.hat, scarf: equipped.scarf, trail: equipped.trail });

  function getWardrobe() {
    return {
      slots: SLOTS.map((s) => ({ id: s.id, name: s.name })),
      items: COSMETICS.map((c) => ({
        id: c.id, slot: c.slot, name: c.name, icon: c.icon,
        unlocked: unlocked.has(c.id), hint: c.hint,
        equipped: equipped[c.slot] === c.id,
      })),
      equipped: getEquipped(),
    };
  }

  function getSaveData() {
    return { unlocked: [...unlocked], equipped: getEquipped() };
  }

  /** 讀檔：先還原已解鎖清單（之後由 gameplay 用 check 補上應得的），再還原穿戴（必須已解鎖且欄位正確） */
  function loadSaveData(d) {
    unlocked.clear();
    addDefaults();
    Object.assign(equipped, DEFAULT_EQUIPPED);
    if (d && typeof d === 'object') {
      if (Array.isArray(d.unlocked)) for (const id of d.unlocked) if (BY_ID.has(id)) unlocked.add(id);
    }
  }
  /** 讀檔後（解鎖清單補齊後）套用存檔裡的穿戴 */
  function restoreEquipped(eq) {
    Object.assign(equipped, DEFAULT_EQUIPPED);
    if (eq && typeof eq === 'object') {
      for (const s of SLOTS) {
        const id = eq[s.id];
        const c = typeof id === 'string' ? getCosmetic(id) : null;
        if (c && c.slot === s.id && unlocked.has(id)) equipped[s.id] = id;
      }
    }
    apply();
  }

  function reset() {
    unlocked.clear();
    addDefaults();
    Object.assign(equipped, DEFAULT_EQUIPPED);
    apply();
  }

  return { check, isUnlocked, equip, getEquipped, getWardrobe, apply, getSaveData, loadSaveData, restoreEquipped, reset };
}
