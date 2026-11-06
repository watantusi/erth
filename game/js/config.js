// 共用設定：所有模組都從這裡讀常數。改動前請先同步給整合者（main.js 擁有者）。

export const GAME_TITLE = '地球小旅人';
export const GAME_SUBTITLE = 'Tiny Earth Wanderer';

export const WORLD_SEED = 20251106;

// 星球幾何（世界座標，星球中心在原點）
export const PLANET_RADIUS = 30;     // 基準地表半徑
export const SEA_LEVEL = 29.7;       // 海面半徑（海洋區地形低於此值）
export const MAX_TERRAIN = 3.2;      // 地形最高約可高出基準多少（火山口可更高）

// 角色物理
export const GRAVITY = 32;
export const WALK_SPEED = 7.5;
export const RUN_SPEED = 12;
export const JUMP_SPEED = 12.5;
export const PLAYER_RADIUS = 0.45;   // 與障礙物碰撞的半徑
export const PLAYER_HEIGHT = 1.4;

// 玩法
export const CRYSTALS_PER_BIOME = 2; // 6 個生態區 × 2 = 12 顆知識晶石
export const SEEDLING_PLOTS = 8;     // 需要種下的幼苗數
export const PICKUP_RADIUS = 1.7;

export const SAVE_KEY = 'tiny-earth-wanderer-save-v1';

// 生態區：方向（未正規化）→ 用最接近的 center 決定所屬生態區（world.getBiome 負責，可加雜訊擾動邊界）
// 同一生態區可有多個 center。
export const BIOMES = [
  {
    id: 'meadow', name: '青青草原', icon: '🌼',
    centers: [[0, 0.25, 1]],
    ground: 0x8fd16a, accent: 0xf7e26b,
  },
  {
    id: 'forest', name: '翠綠森林', icon: '🌲',
    centers: [[1, 0.25, 0.15]],
    ground: 0x4f9e5a, accent: 0x2f6e3b,
  },
  {
    id: 'desert', name: '金色沙漠', icon: '🏜️',
    centers: [[-1, -0.05, 0.35]],
    ground: 0xe9c77b, accent: 0xd49a4a,
  },
  {
    id: 'polar', name: '冰雪極地', icon: '🧊',
    centers: [[0, 1, -0.15], [0.1, -1, 0.2]],
    ground: 0xeef6fb, accent: 0xa8d8f0,
  },
  {
    id: 'volcano', name: '火山高地', icon: '🌋',
    centers: [[0.55, -0.35, -0.85]],
    ground: 0x6b5a55, accent: 0xff6a3d,
  },
  {
    id: 'ocean', name: '蔚藍海洋', icon: '🐋',
    centers: [[-0.6, -0.2, -0.9], [-0.35, -0.75, 0.55]],
    ground: 0xd8c79a, accent: 0x3fa7d6, // ground = 海床/沙灘色
  },
];

export const START_BIOME = 'meadow';

// 色票（低多邊形、柔和粉彩）
export const PALETTE = {
  skyTop: 0x7cc6ff,
  skyBottom: 0xffe3c2,
  water: 0x4fb8e8,
  waterDeep: 0x2a7fc0,
  sun: 0xfff1d6,
  player: 0xff8a5c,
  playerAccent: 0x3b7bd9,
  crystal: 0x8ef0ff,
  seed: 0x9be15d,
  npc: 0xc9d3e6,
  ui: 0x2f3b52,
};

export const EMOTES = ['👋', '😊', '❤️', '🎉', '😮', '👍'];

// 品質等級
export const QUALITY = {
  low: { pixelRatioMax: 1, props: 0.6 },
  high: { pixelRatioMax: 2, props: 1 },
};

// ---- v2：平台挑戰、指南針解鎖、任務 ----
export const INTERACT_RADIUS = 2.6;     // 與任務居民對話的距離
export const PING_DURATION = 20;        // 機器人訊號持續秒數（指南針 Lv0）
export const PING_COOLDOWN = 60;        // 每台機器人的訊號冷卻
export const COMPASS_LEVELS = [0, 1, 2, 3]; // 碎片數 → 指南針等級（3 片以上 = Lv3）
export const ICE_MELT_TIME = 120;       // 駱駝任務：冰塊融化時間
export const VOLCANO_TIME = 60;         // 火山任務：量測時限
export const RADAR_RANGE = 30;          // 雷達顯示範圍（世界單位）
export const TOTAL_QUESTS = 6;
