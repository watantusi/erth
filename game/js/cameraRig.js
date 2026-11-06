// 鏡頭（分身 3）：開始畫面環繞星球（showcase）與第三人稱跟隨（follow）。
// 合約：createCameraRig({ camera, world, player, input }) → { mode, setMode, update(dt), snap() }
//   mode：'showcase' | 'follow' | 'closeup'（v3） | 'select'（v4）
// 球面上不使用世界固定的「上」：鏡頭的上 = 平滑後的玩家地表法線，水平朝向（heading）
// 每幀投影到新的切平面再正規化（平行移動），所以走過南北極也不會翻轉。
// v2：鏡頭不會進入平台柱體（world.platforms），視線被柱子擋住時抬高或拉近；
// 站在高處時稍微拉遠、俯角加大；跳躍時垂直方向跟得慢一點，減少上下晃動。
// v3：closeup（衣櫥）＝角色正面 3/4 特寫，緩慢左右擺動，忽略視角輸入。用投影的 view offset
// 把角色放在畫面左側（橫向）或上半部（直向），讓出衣櫥面板的位置；進出都繞著角色平滑飛行。
// v4：select（選角）＝角色正面全身特寫，水平置中、放在畫面上方（下方留給選角卡片），±25° 慢慢轉動展示；
// follow 依新的較慢速度重新調整（較柔和的跟隨、依實際速度的自動回正與前瞻），
// 並避開附近有高度的障礙物（world.obstacles：房子、招牌、樹…）：視線被擋住時抬高或拉近。
import * as THREE from 'three';
import { PLANET_RADIUS, WALK_SPEED } from './config.js';
import { clamp, damp, lerp, smoothstep } from './utils.js';

const DEG = Math.PI / 180;

const FOLLOW = {
  distance: 10,
  minDist: 5,
  maxDist: 18,
  pitch: 22 * DEG,
  minPitch: 8 * DEG,
  maxPitch: 65 * DEG,
  targetHeight: 1.2,
  yawPerPx: 0.0048,     // 每 px 水平旋轉（弧度）
  pitchPerPx: 0.0036,   // 每 px 俯仰
  zoomScale: 0.13,      // 每單位 zoom 的距離倍率（指數）
  upLambda: 4.2,        // 鏡頭「上」跟隨速度（v4：稍慢，地形起伏時畫面不晃）
  targetLambda: 11,     // 注視點水平跟隨速度（一階平滑，不會過衝；跑步落後約 0.8）
  vertLambda: 9,        // 著地時注視點垂直跟隨速度
  pitchLambda: 14,
  distLambda: 9,
  groundClear: 0.8,     // 鏡頭離地最小距離
  lineClear: 0.45,      // 視線上的地形餘裕
  recenterDelay: 1.8,   // 多久沒碰視角後開始自動回正（秒）
  recenterRate: 0.8,    // 回正速度（1/秒，走路時）；乘上 實際速度 / WALK_SPEED
  recenterMaxScale: 1.7,// 速度倍率上限（跑步、快速設定時回正較快但不急躁）
  teleportDist: 6,      // 單幀位移超過此值視為傳送 → 直接 snap
  // v4：前瞻（注視點往移動方向前移，和跟隨落後大致抵消 → 角色留在畫面中央，看得到前方）
  lookAheadK: 0.13,     // 每單位速度前移多少
  lookAheadMax: 1.4,
  lookAheadLambda: 2.2, // 一階平滑（不會過衝）
  // v2
  airVertLambda: 1.8,   // 空中時注視點垂直跟隨速度（較慢 → 跳躍時鏡頭不晃）
  airVertMaxLag: 1.3,   // 空中時注視點最多落後玩家多少（確保玩家在畫面內）
  highDist: 2,          // 站在高處時多拉遠
  highPitch: 8 * DEG,   // 站在高處時多俯視
  highLambda: 1.6,      // 高處調整的平滑速度
  platClear: 0.3,       // 鏡頭與平台的最小距離
  platMaxRaise: 2.2,    // 視線被柱子擋住時，抬高少於此值就抬高，否則拉近
  minPullDist: 1.6,     // 拉近時至少離注視點這麼遠
  // v4：障礙物（房子、招牌、樹…）視為直立圓柱
  obsMargin: 0.3,       // 圓柱半徑外的餘裕
  obsTopClear: 0.35,    // 視線要高過圓柱頂多少
  obsMaxRaise: 2.4,     // 抬高少於此值就抬高，否則拉到障礙物前面
  obsHugRaise: 6,       // 障礙物緊貼在玩家背後（拉近也沒用）時最多抬高
  obsHugDist: 7,        //   同時拉近到這個距離（從屋頂上方看）
  obsPullPad: 0.7,      // 拉近時停在障礙物前方多遠
  obsLiftUp: 3.2,       // 抬高彈簧（1/秒）：上升
  obsLiftDown: 1.6,     //                    放下（慢一點，穿過樹林時不上下晃）
  obsPullIn: 4.5,       // 拉近彈簧：拉近
  obsPullOut: 1.8,      //            放開
};

// 沒有 height 欄位的障礙物：依半徑估計高度（招牌 ~1.5、樹/石 ~2.2–4、房子 ~4）；半徑太大的（熔岩池）略過
function estimateObstacleHeight(ob) {
  if (Number.isFinite(ob.height) && ob.height > 0) return ob.height;
  const r = ob.radius;
  if (r > 3) return 0;
  if (r < 0.3) return 1.55;          // 招牌、細棕櫚樹幹
  if (r < 0.8) return 1.0 + 4.0 * r;  // 樹、石頭、仙人掌、冰刺
  if (r < 2) return 4.0;              // 房子、帳篷、燈塔、冰屋
  return 5.5;                         // 火箭
}

const SHOWCASE = {
  orbitSpeed: 0.07,     // 弧度/秒
  tilt: 0.32,           // 仰角（弧度）
  tiltWobble: 0.07,
  frameRadius: 31.5,    // 取景時視為星球半徑
};

const CLOSEUP = {
  distance: 3.6,
  distancePortrait: 3.4,
  focusHeight: 1.12,    // 注視上半身（帽子在畫面內）
  pitch: 9 * DEG,       // 稍微高於視線
  yaw: 32 * DEG,        // 3/4 側面
  swayAmp: 10 * DEG,
  swaySpeed: 0.38,      // 弧度/秒（約 16 秒一個來回）
  groundClear: 0.45,
  lineClear: 0.25,
  shiftX: 0.42,         // 橫向：角色中心放在 NDC x = -0.42（畫面左側約 29%）
  shiftY: 0.5,          // 直向：角色中心放在 NDC y = +0.5（上半部）
  yawCandidates: [32, -32, 55, -55, 12, -12, 80, -80, 110, -110, 150, -150, 180],
};

// v4：選角（正面全身，水平置中、畫面上方；下方約 40% 是選角卡片）
const SELECT = {
  charHeight: 2.05,     // 取景用的角色高度（含帽子/耳朵/天線）
  fillPortrait: 0.4,    // 角色佔畫面高度的比例
  fillLandscape: 0.44,
  focusHeight: 0.95,    // 注視全身中央
  pitch: 11 * DEG,      // 稍微俯視：前景的草不會擋住腳
  yaw: 0,               // 正面
  swayAmp: 25 * DEG,
  swaySpeed: 0.42,      // 約 15 秒一個來回
  groundClear: 0.45,
  lineClear: 0.25,
  shiftYPortrait: 0.4,  // 角色中心的 NDC y（直向：畫面上方約 30%）
  shiftYLandscape: 0.3, // 橫向：畫面上方約 35%
  yawCandidates: [0, 20, -20, 40, -40, 70, -70, 110, -110, 150, -150, 180],
};

const FLY_TIME = 1.2;
const LINE_SAMPLES = [0.3, 0.5, 0.7, 0.85, 1.0];
const PLAT_SAMPLES = [0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84, 0.94, 1.0];
const MAX_NEAR_PLATS = 48;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const finite3 = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

export function createCameraRig({ camera, world, player, input }) {
  let mode = 'showcase';

  // ---- 共用暫存（不在每幀配置） ----
  const ORIGIN = new THREE.Vector3(0, 0, 0);
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const _m = new THREE.Matrix4();
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _q1 = new THREE.Quaternion();
  const _qI = new THREE.Quaternion();

  // 目前模式的理想鏡頭
  const idealPos = new THREE.Vector3();
  const idealQuat = new THREE.Quaternion();
  const idealUp = new THREE.Vector3(0, 1, 0);

  // ---- showcase 狀態 ----
  let orbitAngle = 0.5;
  let showcaseT = 0;

  // ---- follow 狀態 ----
  const smoothUp = new THREE.Vector3(0, 1, 0);
  const heading = new THREE.Vector3(0, 0, 1);
  const target = new THREE.Vector3();
  const desiredTarget = new THREE.Vector3();
  const lastPlayerPos = new THREE.Vector3();
  let havePlayerPos = false;
  let pitch = FOLLOW.pitch, pitchGoal = FOLLOW.pitch;
  let dist = FOLLOW.distance, distGoal = FOLLOW.distance;
  let lift = 0;
  const obsLift = { x: -1, v: 0 };   // v4：障礙物抬高（彈簧狀態）
  const obsPull = { x: -1, v: 0 };   // v4：障礙物拉近的距離上限（彈簧狀態）
  let pullDist = -1;          // 被柱子擋住時的距離上限（平滑），< 0 = 沒有限制
  let pullVel = 0;
  let highBlend = 0;          // 0..1 站在高處的程度（平滑）
  let highGoal = 0;
  let vertLambda = FOLLOW.targetLambda;
  let idleLook = 99;
  // 附近平台（每幀預先篩選，存索引；不配置）
  const nearPlats = new Int32Array(MAX_NEAR_PLATS);
  let nearCount = 0;
  let platList = null;
  let recenterBlend = 0;

  // ---- closeup 狀態 ----
  const cuFocus = new THREE.Vector3();
  const cuFront = new THREE.Vector3(0, 0, 1);
  let cuYaw = CLOSEUP.yaw;
  let cuT = 0;
  let cuLift = -1;
  let cu = CLOSEUP;            // 目前特寫參數（closeup / select）
  const nearObs = new Int32Array(64);
  let nearObsCount = 0;

  // ---- 模式切換的平滑過渡 ----
  let blendT = 1;
  const blendFromPos = new THREE.Vector3();
  const blendFromQuat = new THREE.Quaternion();
  const blendFromUp = new THREE.Vector3(0, 1, 0);
  let blendPivot = false;           // true：繞著角色飛（closeup 進出），false：繞著星球中心
  const pivot = new THREE.Vector3();
  const _q2 = new THREE.Quaternion();
  // view offset（closeup / select 時把角色放到畫面一側；NDC 位移，切換時從目前值平滑過渡）
  let viewX = 0, viewY = 0;           // 目前套用的 NDC 位移
  let viewFromX = 0, viewFromY = 0;
  const viewTo = { x: 0, y: 0 };
  let viewSX = 0, viewSY = 0;

  // ---- v4：障礙物快取（world.obstacles 變動時才重建；每幀只依角度篩選） ----
  let obsSrc = null, obsLen = -1, obsN = 0;
  let obsDir = new Float32Array(0);   // 單位方向 xyz
  let obsBase = new Float32Array(0);  // 底部離星球中心的半徑
  let obsRad = new Float32Array(0);   // 碰撞圓柱半徑（含視覺寬度）
  let obsH = new Float32Array(0);     // 高度（0 = 略過）
  const MAX_NEAR_OBS = 48;
  const nearFollowObs = new Int32Array(MAX_NEAR_OBS);
  let nearFollowCount = 0;
  const lookAhead = new THREE.Vector3();

  function groundRadius(dir) {
    let r = PLANET_RADIUS;
    try {
      if (world && world.getGroundRadius) r = world.getGroundRadius(dir);
    } catch { /* 忽略 */ }
    return Number.isFinite(r) ? r : PLANET_RADIUS;
  }

  /** 確保 p 在地表上方至少 clear 的距離（就地修改） */
  function enforceGround(p, clear) {
    const r = p.length();
    if (r < 1e-6) { p.set(0, PLANET_RADIUS + clear, 0); return; }
    _v3.copy(p).divideScalar(r);
    const g = groundRadius(_v3) + clear;
    if (r < g) p.copy(_v3).multiplyScalar(g);
  }

  // ---- 平台（柱體）：軸 = p.dir，徑向範圍 bottom..top，水平半徑 radius ----
  function platformsArray() {
    const ps = world && world.platforms;
    return Array.isArray(ps) && ps.length ? ps : null;
  }
  function validPlat(pl) {
    return !!pl && pl.dir && Number.isFinite(pl.radius) && Number.isFinite(pl.top) && Number.isFinite(pl.bottom);
  }
  /** 依角度預先篩選中心 dir 附近 reach（世界單位）內的平台 */
  function gatherPlatforms(centerDir, reach) {
    nearCount = 0;
    platList = platformsArray();
    if (!platList) return;
    for (let i = 0; i < platList.length && nearCount < MAX_NEAR_PLATS; i++) {
      const pl = platList[i];
      if (!validPlat(pl)) continue;
      // 角距離 < (reach + radius) / top
      const ang = (reach + pl.radius + 1) / Math.max(pl.top, 1);
      if (ang < Math.PI && centerDir.dot(pl.dir) < Math.cos(ang)) continue;
      nearPlats[nearCount++] = i;
    }
  }
  /** p 是否在平台柱體內（含 margin）。回傳 0 = 不在；否則回傳往上抬出柱頂所需距離（>0） */
  function insidePlat(pl, p, margin) {
    const r = p.length();
    if (r < pl.bottom - margin || r > pl.top + margin) return 0;
    const h = p.dot(pl.dir);
    if (h <= 0) return 0;
    const d2 = r * r - h * h;
    const rr = pl.radius + margin;
    if (d2 >= rr * rr) return 0;
    return pl.top + margin - r + 1e-3;
  }
  /** 鏡頭位置 p 在任何附近平台內？回傳第一個平台索引或 -1 */
  function insideAnyPlat(p, margin) {
    for (let k = 0; k < nearCount; k++) {
      const pl = platList[nearPlats[k]];
      if (insidePlat(pl, p, margin) > 0) return nearPlats[k];
    }
    return -1;
  }
  /** 注視點本身是否在平台內（例如穿過浮空平台）→ 這個平台不參與視線檢查 */
  function targetInside(pl) {
    return insidePlat(pl, target, 0) > 0;
  }

  /**
   * 視線（target → eye）被平台擋住的處理：回傳需要的抬高量，並在 out.pull 寫入距離上限（或 -1）
   */
  const platRes = { raise: 0, pull: -1 };
  function platformLineOfSight(eye, curDist) {
    platRes.raise = 0; platRes.pull = -1;
    if (!nearCount) return platRes;
    let firstBlock = 2;
    for (let k = 0; k < nearCount; k++) {
      const pl = platList[nearPlats[k]];
      if (targetInside(pl)) continue;
      for (let i = 0; i < PLAT_SAMPLES.length; i++) {
        const f = PLAT_SAMPLES[i];
        _v1.lerpVectors(target, eye, f);
        // 用稍大的餘裕提早發現，讓拉近可以平滑進行
        const need = insidePlat(pl, _v1, i === PLAT_SAMPLES.length - 1 ? FOLLOW.platClear + 0.3 : 0.45);
        if (need <= 0) continue;
        const raise = need / f;
        if (raise <= FOLLOW.platMaxRaise) {
          if (raise > platRes.raise) platRes.raise = raise;
        } else if (f < firstBlock) {
          firstBlock = f;
        }
        break;
      }
    }
    if (firstBlock <= 1) {
      // 拉到柱子前面一點（往前退一個取樣間隔再留一點空間）
      const fPrev = Math.max(0, firstBlock - 0.12);
      platRes.pull = Math.max(FOLLOW.minPullDist, fPrev * curDist - 0.2);
    }
    return platRes;
  }

  /**
   * 最後的硬性保證：p 不可在平台內（就地修改）。候選解：沿視線往注視點拉、往上抬出柱頂、
   * 從柱子側面水平推出去；選位移最小且不會落入其他平台的那個，避免鏡頭突然跳動。
   */
  function enforcePlatforms(p, from) {
    if (!nearCount) return;
    const clear = FOLLOW.platClear;
    for (let iter = 0; iter < 3; iter++) {
      const idx = insideAnyPlat(p, clear);
      if (idx < 0) return;
      const pl = platList[idx];
      let best = Infinity;
      // (1) 往上抬
      const raise = insidePlat(pl, p, clear);
      const r = p.length();
      if (r > 1e-6) {
        _v2.copy(p).multiplyScalar((r + raise + 0.02) / r);
        if (insideAnyPlat(_v2, clear) < 0) { best = raise; _v3.copy(_v2); }
      }
      // (2) 從側面推出去
      const h = p.dot(pl.dir);
      _v2.copy(p).addScaledVector(pl.dir, -h);
      const d = _v2.length();
      if (d > 1e-4) {
        const push = pl.radius + clear - d + 0.02;
        if (push < best) {
          _v2.multiplyScalar(push / d).add(p);
          if (insideAnyPlat(_v2, clear) < 0) { best = push; _v3.copy(_v2); }
        }
      }
      // (3) 沿視線往注視點拉
      if (from) {
        const total = p.distanceTo(from);
        for (let s = 1; s <= 32; s++) {
          const f = s / 32;
          if (f * total >= best) break;
          _v2.lerpVectors(p, from, f);
          if (insideAnyPlat(_v2, clear) < 0) {
            if ((1 - f) * total >= FOLLOW.minPullDist) { best = f * total; _v3.copy(_v2); }
            break;
          }
        }
      }
      if (best === Infinity) {
        // 都不行（被多根柱子包圍）：直接抬到柱頂上方
        if (r > 1e-6) p.multiplyScalar((r + raise + 0.02) / r);
      } else {
        p.copy(_v3);
      }
    }
  }

  // ---- v4：障礙物（直立圓柱：軸 = 障礙物方向，底 = 地面，高 = obsH） ----
  function syncObstacles() {
    const list = world && Array.isArray(world.obstacles) ? world.obstacles : null;
    if (!list) { obsN = 0; obsSrc = null; obsLen = -1; return; }
    if (list === obsSrc && list.length === obsLen) return;
    obsSrc = list; obsLen = list.length;
    if (obsDir.length < list.length * 3) {
      const cap = list.length + 32;      // 只有障礙物清單變大時才重新配置
      obsDir = new Float32Array(cap * 3);
      obsBase = new Float32Array(cap);
      obsRad = new Float32Array(cap);
      obsH = new Float32Array(cap);
    }
    obsN = list.length;
    for (let i = 0; i < obsN; i++) {
      const ob = list[i];
      const p = ob && ob.position;
      const len = p && finite3(p) ? p.length() : 0;
      if (!(len > 1) || !Number.isFinite(ob.radius) || ob.radius <= 0) { obsH[i] = 0; continue; }
      obsDir[i * 3] = p.x / len; obsDir[i * 3 + 1] = p.y / len; obsDir[i * 3 + 2] = p.z / len;
      obsBase[i] = len;
      obsH[i] = estimateObstacleHeight(ob);
      // 細的招牌：碰撞半徑小，但看板本身約 0.9 寬
      obsRad[i] = ob.radius < 0.3 ? 0.45 : ob.radius;
    }
  }
  /** 依角度篩選 up 方向附近 reach 內的障礙物（索引存進 nearFollowObs） */
  function gatherObstacles(up, reach) {
    nearFollowCount = 0;
    syncObstacles();
    const ux = up.x, uy = up.y, uz = up.z;
    for (let i = 0; i < obsN && nearFollowCount < MAX_NEAR_OBS; i++) {
      if (obsH[i] <= 0) continue;
      const d = ux * obsDir[i * 3] + uy * obsDir[i * 3 + 1] + uz * obsDir[i * 3 + 2];
      const ang = (reach + obsRad[i]) / obsBase[i];
      if (d < Math.cos(Math.min(ang, 3))) continue;
      nearFollowObs[nearFollowCount++] = i;
    }
  }
  /**
   * 視線 target → eye 被障礙物擋住：解析求出線段進入/離開圓柱的參數 f0..f1，
   * 若那段的高度低於圓柱頂 → 需要抬高 (H + clear - y(f)) / f；抬太多就改成拉到障礙物前面。
   */
  const obsRes = { raise: 0, pull: -1 };
  function obstacleLineOfSight(eye, curDist) {
    obsRes.raise = 0; obsRes.pull = -1;
    if (!nearFollowCount) return obsRes;
    const dx = eye.x - target.x, dy = eye.y - target.y, dz = eye.z - target.z;
    let pull = Infinity;
    for (let k = 0; k < nearFollowCount; k++) {
      const i = nearFollowObs[k];
      const ux = obsDir[i * 3], uy = obsDir[i * 3 + 1], uz = obsDir[i * 3 + 2];
      const b = obsBase[i];
      const rx = target.x - ux * b, ry = target.y - uy * b, rz = target.z - uz * b;
      const ah = rx * ux + ry * uy + rz * uz;          // 注視點在圓柱底上方多高
      const dh = dx * ux + dy * uy + dz * uz;
      const H = obsH[i];
      // 比玩家頭還矮的（招牌、矮石頭）：只要看得到頭和上半身就好，不必整個越過
      const top = H < FOLLOW.targetHeight + 0.5 ? H - 0.25 : H + FOLLOW.obsTopClear;
      if (ah >= top && ah + dh >= top) continue;       // 整條視線都在圓柱頂上方
      // 水平分量
      const Ax = rx - ux * ah, Ay = ry - uy * ah, Az = rz - uz * ah;
      const Bx = dx - ux * dh, By = dy - uy * dh, Bz = dz - uz * dh;
      const rr = obsRad[i] + FOLLOW.obsMargin;
      const aa = Ax * Ax + Ay * Ay + Az * Az - rr * rr;
      if (aa <= 0) continue;                            // 玩家就在圓柱裡（站在屋頂、貼著樹）→ 不處理
      const bb = Bx * Bx + By * By + Bz * Bz;
      if (bb < 1e-8) continue;
      const ab = Ax * Bx + Ay * By + Az * Bz;
      const disc = ab * ab - bb * aa;
      if (disc <= 0) continue;
      const sq = Math.sqrt(disc);
      let f0 = (-ab - sq) / bb, f1 = (-ab + sq) / bb;
      if (f1 <= 0.02 || f0 >= 1) continue;
      if (f0 < 0.02) f0 = 0.02;
      if (f1 > 1) f1 = 1;
      const y0 = ah + f0 * dh, y1 = ah + f1 * dh;
      if (y0 >= top && y1 >= top) continue;
      if (y0 < -1 && y1 < -1) continue;
      const need = Math.max((top - y0) / f0, (top - y1) / f1);
      const pullTo = f0 * curDist - FOLLOW.obsPullPad;
      if (need <= FOLLOW.obsMaxRaise) {
        if (need > obsRes.raise) obsRes.raise = need;
      } else if (pullTo >= FOLLOW.minPullDist + 0.4) {
        if (pullTo < pull) pull = pullTo;
      } else {
        // 高的障礙物緊貼在玩家背後：拉近到屋頂附近並抬高（越過屋頂從上方看）
        const r = Math.min(need, FOLLOW.obsHugRaise);
        if (r > obsRes.raise) obsRes.raise = r;
        if (FOLLOW.obsHugDist < pull && FOLLOW.obsHugDist < curDist) pull = FOLLOW.obsHugDist;
      }
    }
    if (pull < Infinity) obsRes.pull = pull;
    return obsRes;
  }

  /** 臨界阻尼彈簧（就地更新 s.x、s.v）：速度連續，目標不變時不會過衝 */
  function spring(s, goal, w, dt) {
    s.v += (w * w * (goal - s.x) - 2 * w * s.v) * dt;
    s.x += s.v * dt;
  }

  function lookQuat(eye, at, up, outQuat) {
    _m.lookAt(eye, at, up);
    outQuat.setFromRotationMatrix(_m);
  }

  /** 讀取玩家的地表法線到 _up */
  function readPlayerUp() {
    const pu = player && player.up;
    if (pu && finite3(pu) && pu.lengthSq() > 1e-8) _up.copy(pu).normalize();
    else if (player && player.position && player.position.lengthSq() > 1e-8) _up.copy(player.position).normalize();
    else _up.set(0, 1, 0);
    return _up;
  }

  /** heading = 玩家面向投影到 smoothUp 的切平面（失敗時用穩定的切線） */
  function initHeading() {
    const f = player && player.forward;
    if (f && finite3(f)) heading.copy(f); else heading.set(0, 0, 0);
    heading.addScaledVector(smoothUp, -heading.dot(smoothUp));
    if (heading.lengthSq() < 1e-6) {
      // 備援：任何與 up 不平行的參考向量
      _v1.set(1, 0, 0);
      if (Math.abs(smoothUp.x) > 0.9) _v1.set(0, 0, 1);
      heading.crossVectors(smoothUp, _v1);
    }
    heading.normalize();
  }

  function computeDesiredTarget() {
    desiredTarget.copy(player.position).addScaledVector(_up, FOLLOW.targetHeight).add(lookAhead);
  }
  /** v4：前瞻量平滑跟隨「面向 × 速度」（一階平滑 → 不會過衝），並保持在切平面內 */
  function updateLookAhead(dt, speed) {
    const f = player.forward;
    const amt = clamp((speed - 0.4) * FOLLOW.lookAheadK, 0, FOLLOW.lookAheadMax);
    if (amt > 0 && f && finite3(f)) {
      _v2.copy(f).addScaledVector(_up, -f.dot(_up));
      const l = _v2.length();
      if (l > 1e-4) _v2.multiplyScalar(amt / l); else _v2.set(0, 0, 0);
    } else {
      _v2.set(0, 0, 0);
    }
    lookAhead.lerp(_v2, 1 - Math.exp(-FOLLOW.lookAheadLambda * dt));
    lookAhead.addScaledVector(_up, -lookAhead.dot(_up));
    if (!finite3(lookAhead)) lookAhead.set(0, 0, 0);
  }

  /** follow 的平滑狀態立即到位 */
  function snapFollow(resetView, keepHeading) {
    readPlayerUp();
    smoothUp.copy(_up);
    if (keepHeading && finite3(heading)) {
      heading.addScaledVector(smoothUp, -heading.dot(smoothUp));
      if (heading.lengthSq() < 1e-6) initHeading(); else heading.normalize();
    } else {
      initHeading();
    }
    if (resetView) { pitchGoal = FOLLOW.pitch; distGoal = FOLLOW.distance; }
    pitch = pitchGoal;
    dist = distGoal;
    lookAhead.set(0, 0, 0);
    computeDesiredTarget();
    target.copy(desiredTarget);
    lastPlayerPos.copy(player.position);
    havePlayerPos = true;
    lift = -1; // 下一次計算時直接採用目標值
    pullDist = -1;
    obsLift.x = -1; obsPull.x = -1;
    vertLambda = FOLLOW.vertLambda;
    idleLook = 99;
    recenterBlend = 0;
  }

  // ---- showcase ----
  function showcaseDistance() {
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    const tanV = Math.tan(((camera.fov || 55) * DEG) / 2);
    const tanMin = Math.min(tanV, tanV * aspect);
    const k = aspect < 1 ? 0.86 : 0.72; // 星球佔較短邊的比例
    const ang = Math.atan(k * tanMin);
    return clamp(SHOWCASE.frameRadius / Math.sin(ang), 60, 170);
  }

  function computeShowcase(dt) {
    showcaseT += dt;
    orbitAngle += dt * SHOWCASE.orbitSpeed;
    const D = showcaseDistance();
    const tilt = SHOWCASE.tilt + Math.sin(showcaseT * 0.11) * SHOWCASE.tiltWobble;
    const c = Math.cos(tilt);
    idealPos.set(Math.sin(orbitAngle) * c, Math.sin(tilt), Math.cos(orbitAngle) * c).multiplyScalar(D);
    idealUp.copy(WORLD_UP);
    lookQuat(idealPos, ORIGIN, idealUp, idealQuat);
  }

  // ---- follow ----
  function computeFollow(dt) {
    if (!player || !player.position || !finite3(player.position)) return false;
    readPlayerUp();

    // 傳送（setDirection、讀檔）→ 直接到位
    if (havePlayerPos && player.position.distanceToSquared(lastPlayerPos) > FOLLOW.teleportDist * FOLLOW.teleportDist) {
      snapFollow(false);
    }
    lastPlayerPos.copy(player.position);
    havePlayerPos = true;

    // 平滑的「上」
    if (smoothUp.dot(_up) < -0.2) smoothUp.copy(_up);
    else {
      smoothUp.lerp(_up, 1 - Math.exp(-FOLLOW.upLambda * dt));
      if (smoothUp.lengthSq() < 1e-8) smoothUp.copy(_up);
      smoothUp.normalize();
    }

    // 平行移動 heading：投影到新的切平面再正規化
    heading.addScaledVector(smoothUp, -heading.dot(smoothUp));
    if (heading.lengthSq() < 1e-6 || !finite3(heading)) initHeading();
    else heading.normalize();

    // 視角輸入
    const st = input && input.state;
    const lx = st ? st.lookX || 0 : 0;
    const ly = st ? st.lookY || 0 : 0;
    const zm = st ? st.zoom || 0 : 0;
    if (lx !== 0 || ly !== 0) idleLook = 0; else idleLook += dt;
    if (lx !== 0) heading.applyAxisAngle(smoothUp, -lx * FOLLOW.yawPerPx).normalize(); // 往右拖 → 往右看
    if (ly !== 0) pitchGoal = clamp(pitchGoal + ly * FOLLOW.pitchPerPx, FOLLOW.minPitch, FOLLOW.maxPitch);
    if (zm !== 0) distGoal = clamp(distGoal * Math.exp(zm * FOLLOW.zoomScale), FOLLOW.minDist, FOLLOW.maxDist);

    // 自動回正：一段時間沒動視角且玩家在移動 → 慢慢轉到玩家背後
    const speed = Number.isFinite(player.speed) ? player.speed : 0;
    const wantRecenter = idleLook > FOLLOW.recenterDelay && speed > 0.6;
    recenterBlend = damp(recenterBlend, wantRecenter ? 1 : 0, 2.5, dt);
    if (recenterBlend > 0.01 && player.forward && finite3(player.forward)) {
      _v1.copy(player.forward).addScaledVector(smoothUp, -player.forward.dot(smoothUp));
      if (_v1.lengthSq() > 1e-6) {
        _v1.normalize();
        const cosA = heading.dot(_v1);
        const sinA = _v2.crossVectors(heading, _v1).dot(smoothUp);
        const a = Math.atan2(sinA, cosA);
        // 角度越大越不追（朝鏡頭走時 >150° 完全忽略）
        const w = 1 - smoothstep(100 * DEG, 150 * DEG, Math.abs(a));
        // 依實際速度（含速度設定倍率）：走路 = 1、跑步 ≈ 1.6
        const sf = clamp(speed / WALK_SPEED, 0, FOLLOW.recenterMaxScale);
        const step = a * (1 - Math.exp(-FOLLOW.recenterRate * dt)) * w * sf * recenterBlend;
        if (step !== 0) heading.applyAxisAngle(smoothUp, step).normalize();
        pitchGoal = damp(pitchGoal, FOLLOW.pitch, 0.35 * recenterBlend * w, dt);
      }
    }

    pitch = damp(pitch, pitchGoal, FOLLOW.pitchLambda, dt);
    dist = damp(dist, distGoal, FOLLOW.distLambda, dt);

    // 注視點：水平照常跟隨；垂直在空中時跟得慢一點（但不讓玩家跑出畫面）
    updateLookAhead(dt, speed);
    computeDesiredTarget();
    const airborne = player.grounded === false;
    vertLambda = damp(vertLambda, airborne ? FOLLOW.airVertLambda : FOLLOW.vertLambda, airborne ? 30 : 4, dt);
    _v1.subVectors(target, desiredTarget);               // 落後量
    let vert = _v1.dot(_up);
    _v1.addScaledVector(_up, -vert);                      // 水平落後
    _v1.multiplyScalar(Math.exp(-FOLLOW.targetLambda * dt));
    vert *= Math.exp(-vertLambda * dt);
    const maxV = airborne ? FOLLOW.airVertMaxLag : 1.5;
    if (vert > maxV) vert = maxV; else if (vert < -maxV) vert = -maxV;
    target.copy(desiredTarget).add(_v1).addScaledVector(_up, vert);
    // 高速時不要落後太多
    const lagSq = target.distanceToSquared(desiredTarget);
    if (lagSq > 2.25) target.sub(desiredTarget).multiplyScalar(1.5 / Math.sqrt(lagSq)).add(desiredTarget);

    // 站在高處：拉遠一點、俯角加大，看得到下一階（只在著地時更新目標，跳躍中維持）
    if (!airborne) {
      const pr = player.position.length();
      let elev = 0;
      if (player.supportPlatform) elev = pr - groundRadius(_up);
      if (camera.position.lengthSq() > 1e-6) {
        _v2.copy(camera.position).normalize();
        elev = Math.max(elev, pr - groundRadius(_v2));
      }
      const high = smoothstep(0.9, 2.6, elev);
      highGoal = player.supportPlatform ? Math.max(high, 0.35) * (elev > 0.5 ? 1 : 0) : high;
    }
    highBlend = damp(highBlend, highGoal, FOLLOW.highLambda, dt);
    const effPitch = Math.min(pitch + FOLLOW.highPitch * highBlend, FOLLOW.maxPitch + 4 * DEG);
    let effDist = dist + FOLLOW.highDist * highBlend;

    // 附近平台與障礙物（依角度預篩）
    gatherPlatforms(_up, effDist + 3);
    gatherObstacles(_up, effDist + 2);

    // 視線被柱子或高的障礙物擋住：拉近（快進慢出）
    const cp = Math.cos(effPitch), sp = Math.sin(effPitch);
    idealPos.copy(target)
      .addScaledVector(heading, -cp * effDist)
      .addScaledVector(smoothUp, sp * effDist);
    const los = platformLineOfSight(idealPos, effDist);
    const pullGoal = los.pull >= 0 ? los.pull : effDist;
    // 障礙物：另外一組較柔和的彈簧（被擋一下不要緊，鏡頭平穩比較重要）
    const olos = obstacleLineOfSight(idealPos, effDist);
    const obsPullGoal = olos.pull >= 0 ? olos.pull : effDist;
    if (obsPull.x < 0) { obsPull.x = effDist; obsPull.v = 0; }
    spring(obsPull, obsPullGoal, obsPullGoal < obsPull.x ? FOLLOW.obsPullIn : FOLLOW.obsPullOut, dt);
    if (obsPullGoal >= effDist && obsPull.x >= effDist) { obsPull.x = effDist; obsPull.v = 0; }
    if (pullDist < 0) { pullDist = effDist; pullVel = 0; }
    // 臨界阻尼彈簧（速度連續 → 開始拉近時不會突然跳）：拉近快、放開慢
    {
      const w = pullGoal < pullDist ? 11 : 3;
      pullVel += (w * w * (pullGoal - pullDist) - 2 * w * pullVel) * dt;
      pullDist += pullVel * dt;
      if (pullGoal >= effDist && pullDist >= effDist) { pullDist = effDist; pullVel = 0; }
    }
    if (pullDist < effDist) effDist = Math.max(FOLLOW.minPullDist, pullDist);
    if (obsPull.x < effDist) effDist = Math.max(FOLLOW.minPullDist, obsPull.x);

    // 理想位置：目標後上方
    idealPos.copy(target)
      .addScaledVector(heading, -cp * effDist)
      .addScaledVector(smoothUp, sp * effDist);

    // 視線被地形擋住 → 把鏡頭往上抬（快上慢下）
    let need = 0;
    for (let i = 0; i < LINE_SAMPLES.length; i++) {
      const f = LINE_SAMPLES[i];
      _v1.lerpVectors(target, idealPos, f);
      const r = _v1.length();
      if (r < 1e-6) continue;
      _v1.divideScalar(r);
      const clear = f >= 1 ? FOLLOW.groundClear : FOLLOW.lineClear;
      const deficit = groundRadius(_v1) + clear - r;
      if (deficit > 0) need = Math.max(need, deficit / f);
    }
    // 矮的柱子、障礙物擋住視線 → 抬高
    if (nearCount) {
      const pr2 = platformLineOfSight(idealPos, effDist);
      if (pr2.raise > need) need = pr2.raise;
    }
    need = Math.min(need, 9);
    if (lift < 0) lift = need;
    else lift = need > lift ? damp(lift, need, 22, dt) : damp(lift, need, 2.5, dt);
    // 障礙物擋住 → 柔和地抬高（彈簧：速度連續、不突然跳）
    const obsNeed = nearFollowCount ? obstacleLineOfSight(idealPos, effDist).raise : 0;
    if (obsLift.x < 0) { obsLift.x = obsNeed; obsLift.v = 0; }
    spring(obsLift, obsNeed, obsNeed > obsLift.x ? FOLLOW.obsLiftUp : FOLLOW.obsLiftDown, dt);
    if (obsLift.x < 0) { obsLift.x = 0; obsLift.v = Math.max(0, obsLift.v); }
    const raise = Math.max(lift, obsLift.x);
    if (raise > 1e-4) idealPos.addScaledVector(smoothUp, raise);
    enforceGround(idealPos, FOLLOW.groundClear);
    enforcePlatforms(idealPos, target);

    idealUp.copy(smoothUp);
    lookQuat(idealPos, target, idealUp, idealQuat);
    return true;
  }

  // ---- closeup（衣櫥特寫） ----
  /** 玩家正面（切平面內）→ cuFront */
  function readFront() {
    const f = player && player.forward;
    if (f && finite3(f)) cuFront.copy(f); else cuFront.copy(heading).negate();
    cuFront.addScaledVector(_up, -cuFront.dot(_up));
    if (cuFront.lengthSq() < 1e-6) {
      _v1.set(1, 0, 0);
      if (Math.abs(_up.x) > 0.9) _v1.set(0, 0, 1);
      cuFront.crossVectors(_up, _v1);
    }
    cuFront.normalize();
  }
  function closeupDistance() {
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    if (cu === SELECT) {
      // 依垂直視野算距離：角色（含帽子）約佔畫面高度的 fill
      const tanV = Math.tan(((camera.fov || 55) * DEG) / 2);
      const fill = aspect < 0.9 ? SELECT.fillPortrait : SELECT.fillLandscape;
      return clamp(SELECT.charHeight / (fill * 2 * tanV), 3, 6.5);
    }
    return aspect < 0.9 ? CLOSEUP.distancePortrait : CLOSEUP.distance;
  }
  /** 依偏航角算出特寫鏡頭位置（不含地形修正）→ out */
  function closeupEye(yaw, out) {
    const D = closeupDistance();
    _v2.copy(cuFront).applyAxisAngle(_up, yaw);
    return out.copy(cuFocus)
      .addScaledVector(_v2, Math.cos(cu.pitch) * D)
      .addScaledVector(_up, Math.sin(cu.pitch) * D);
  }
  /** 視線 focus → eye 的遮擋程度（地形、平台、樹木等障礙物）；0 = 完全看得到 */
  function closeupBlock(eye) {
    let block = 0;
    const obs = world && Array.isArray(world.obstacles) ? world.obstacles : null;
    for (let i = 1; i <= 8; i++) {
      const f = i / 8;
      _v1.lerpVectors(cuFocus, eye, f);
      const r = _v1.length();
      if (r < 1e-6) continue;
      _v3.copy(_v1).divideScalar(r);
      const g = groundRadius(_v3);
      const d = g + (i === 8 ? cu.groundClear : cu.lineClear) - r;
      if (d > 0) block += d * 2;
      if (insideAnyPlat(_v1, 0.25) >= 0) block += 1.5;
      if (obs) {
        for (let k = 0; k < nearObsCount; k++) {
          const ob = obs[nearObs[k]];
          // 障礙物視為從地面往上的直立圓柱（高度依 height 或半徑估計）
          _v2.subVectors(_v1, ob.position);
          const h = _v2.dot(_v3);
          if (h > estimateObstacleHeight(ob) + 0.3 || h < -1) continue;
          _v2.addScaledVector(_v3, -h);
          if (_v2.lengthSq() < (ob.radius + 0.35) * (ob.radius + 0.35)) block += 1;
        }
      }
    }
    return block;
  }
  /** 進入特寫時挑一個看得清楚的角度（優先右前 3/4，擋住就換邊或轉更多） */
  function chooseCloseupYaw() {
    readPlayerUp();
    readFront();
    cuFocus.copy(player.position).addScaledVector(_up, cu.focusHeight);
    gatherPlatforms(_up, 8);
    // 附近障礙物（只在切換時做一次）
    nearObsCount = 0;
    const obs = world && Array.isArray(world.obstacles) ? world.obstacles : null;
    if (obs) {
      for (let i = 0; i < obs.length && nearObsCount < nearObs.length; i++) {
        const ob = obs[i];
        if (!ob || !ob.position || !Number.isFinite(ob.radius)) continue;
        if (ob.position.distanceToSquared(player.position) < 81) nearObs[nearObsCount++] = i;
      }
    }
    let best = cu.yaw, bestScore = Infinity;
    const c = cu.yawCandidates;
    for (let i = 0; i < c.length; i++) {
      const y = c[i] * DEG;
      let score = 0;
      for (let s = -1; s <= 1; s += 0.5) {
        score += closeupBlock(closeupEye(y + s * cu.swayAmp, idealPos));
      }
      score += i * 0.02; // 同分時照偏好順序
      if (score < bestScore) { bestScore = score; best = y; }
      if (score < 0.05) break;
    }
    cuYaw = best;
  }
  function computeCloseup(dt) {
    if (!player || !player.position || !finite3(player.position)) return false;
    readPlayerUp();
    readFront();
    cuT += dt;
    cuFocus.copy(player.position).addScaledVector(_up, cu.focusHeight);
    const yaw = cuYaw + Math.sin(cuT * cu.swaySpeed) * cu.swayAmp;
    closeupEye(yaw, idealPos);
    // 視線被地形擋住 → 抬高（快上慢下）
    let need = 0;
    for (let i = 0; i < LINE_SAMPLES.length; i++) {
      const f = LINE_SAMPLES[i];
      _v1.lerpVectors(cuFocus, idealPos, f);
      const r = _v1.length();
      if (r < 1e-6) continue;
      _v1.divideScalar(r);
      const clear = f >= 1 ? cu.groundClear : cu.lineClear;
      const deficit = groundRadius(_v1) + clear - r;
      if (deficit > 0) need = Math.max(need, deficit / f);
    }
    need = Math.min(need, 5);
    if (cuLift < 0) cuLift = need;
    else cuLift = need > cuLift ? damp(cuLift, need, 22, dt) : damp(cuLift, need, 2.5, dt);
    if (cuLift > 1e-4) idealPos.addScaledVector(_up, cuLift);
    enforceGround(idealPos, cu.groundClear);
    gatherPlatforms(_up, 7);
    enforcePlatforms(idealPos, cuFocus);
    idealUp.copy(_up);
    lookQuat(idealPos, cuFocus, idealUp, idealQuat);
    return true;
  }

  function computeIdeal(dt) {
    if (mode === 'follow') {
      if (!computeFollow(dt)) computeShowcase(dt);
    } else if (mode === 'closeup' || mode === 'select') {
      if (!computeCloseup(dt)) computeShowcase(dt);
    } else {
      computeShowcase(dt);
    }
  }

  /** 過渡時繞行的中心：closeup 進出 = 角色上半身；其他 = 星球中心 */
  function updatePivot() {
    if (!blendPivot) { pivot.set(0, 0, 0); return; }
    readPlayerUp();
    pivot.copy(player.position).addScaledVector(_up, cu.focusHeight);
  }

  function apply() {
    if (blendT < 1) {
      const t = blendT;
      const eDir = easeInOut(Math.min(1, t * 1.15));
      const eRad = easeInOut(t);
      updatePivot();
      _v1.subVectors(blendFromPos, pivot);
      _v2.subVectors(idealPos, pivot);
      let orbited = false;
      if (blendPivot) {
        // 繞著角色：以角色的「上」為軸，方位角、高度、水平距離分別插值
        // → 一律從側面繞過去（選角正面 → 跟隨背後也不會從頭頂翻過去）
        const h0 = _v1.dot(_up), h1 = _v2.dot(_up);
        _v1.addScaledVector(_up, -h0);
        _v2.addScaledVector(_up, -h1);
        const l0 = _v1.length(), l1 = _v2.length();
        if (l0 > 0.05 && l1 > 0.05) {
          const az = Math.atan2(_v3.crossVectors(_v1, _v2).dot(_up), _v1.dot(_v2));
          _v1.applyAxisAngle(_up, az * eDir).multiplyScalar(lerp(l0, l1, eRad) / l0)
            .addScaledVector(_up, lerp(h0, h1, eRad)).add(pivot);
          orbited = true;
        } else {
          _v1.addScaledVector(_up, h0);
          _v2.addScaledVector(_up, h1);
        }
      }
      if (!orbited) {
        // 繞著 pivot 做球面插值（星球中心 → 不會穿過星球）
        const r0 = _v1.length();
        const r1 = _v2.length();
        _v1.divideScalar(r0 || 1);
        _v2.divideScalar(r1 || 1);
        if (_v1.dot(_v2) < -0.999) {
          // 正對面：避免 setFromUnitVectors 任意選軸
          _v3.copy(pivot).lengthSq() > 1e-6 ? _v3.normalize() : _v3.set(0, 1, 0);
          _v3.cross(_v1);
          if (_v3.lengthSq() < 1e-8) _v3.set(1, 0, 0);
          _q1.setFromAxisAngle(_v3.normalize(), Math.PI);
        } else {
          _q1.setFromUnitVectors(_v1, _v2);
        }
        _qI.identity().slerp(_q1, eDir);
        _v1.applyQuaternion(_qI).multiplyScalar(lerp(r0, r1, eRad)).add(pivot);
      }
      enforceGround(_v1, blendPivot ? cu.groundClear : FOLLOW.groundClear);
      if (mode !== 'showcase') {
        // 飛行過程也不穿過平台
        _v3.copy(_v1).normalize();
        gatherPlatforms(_v3, 4);
        enforcePlatforms(_v1, blendPivot ? pivot : null);
      }
      camera.position.copy(_v1);
      // camera.up：記錄用，也拿來當 pivot 過渡的注視上方向
      _q1.setFromUnitVectors(blendFromUp, idealUp);
      _qI.identity().slerp(_q1, eRad);
      camera.up.copy(blendFromUp).applyQuaternion(_qI).normalize();
      if (blendPivot) {
        // 一路看著角色：開頭從原本的朝向接過來、結尾交給目標朝向
        lookQuat(_v1, pivot, camera.up, _q2);
        const w0 = 1 - smoothstep(0, 0.22, t);
        const w1 = smoothstep(0.78, 1, t);
        camera.quaternion.slerpQuaternions(_q2, blendFromQuat, w0);
        if (w1 > 0) camera.quaternion.slerp(idealQuat, w1);
      } else {
        camera.quaternion.slerpQuaternions(blendFromQuat, idealQuat, eRad);
      }
    } else {
      camera.position.copy(idealPos);
      camera.quaternion.copy(idealQuat);
      camera.up.copy(idealUp);
    }
    camera.updateMatrixWorld();
  }

  /** 各模式的畫面偏移（角色中心要出現的 NDC 位置）→ viewTo */
  function shiftFor(m) {
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    const f = smoothstep(0.8, 1.15, aspect); // 0 = 直向、1 = 橫向
    if (m === 'closeup') { viewTo.x = lerp(0, CLOSEUP.shiftX, f); viewTo.y = lerp(CLOSEUP.shiftY, 0.04, f); }
    else if (m === 'select') { viewTo.x = 0; viewTo.y = lerp(SELECT.shiftYPortrait, SELECT.shiftYLandscape, f); }
    else { viewTo.x = 0; viewTo.y = 0; }
    return viewTo;
  }

  /** 套用畫面偏移（NDC）：closeup 橫向往左、直向往上；select 往上；(0,0) 時清除 */
  function applyViewOffset(nx, ny) {
    if (!(Math.abs(nx) > 1e-4 || Math.abs(ny) > 1e-4)) {
      if (camera.view && camera.view.enabled && camera.clearViewOffset) camera.clearViewOffset();
      viewSX = viewSY = 0;
      return;
    }
    if (!camera.setViewOffset) return;
    // 注意：setViewOffset 會把 camera.aspect 設成 fullWidth / fullHeight，所以虛擬畫面要用真正的長寬比
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    const fw = 1000 * aspect, fh = 1000;
    // NDC 位移 s → 視窗位移 s / 2 個畫面寬（高）
    const sx = Math.round(nx * 0.5 * fw * 100) / 100;
    const sy = Math.round(ny * 0.5 * fh * 100) / 100;
    const v = camera.view;
    if (v && v.enabled && sx === viewSX && sy === viewSY && Math.abs(v.fullWidth - fw) < 1e-6) return;
    viewSX = sx; viewSY = sy;
    camera.setViewOffset(fw, fh, sx, sy, fw, fh);
  }
  function updateViewOffset() {
    shiftFor(mode);
    const e = blendT < 1 ? easeInOut(blendT) : 1;
    viewX = lerp(viewFromX, viewTo.x, e);
    viewY = lerp(viewFromY, viewTo.y, e);
    applyViewOffset(viewX, viewY);
  }

  function update(dt) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    computeIdeal(dt);
    if (blendT < 1) blendT = Math.min(1, blendT + dt / FLY_TIME);
    apply();
    updateViewOffset();
  }

  const isPortraitMode = (m) => m === 'closeup' || m === 'select';

  function setMode(m) {
    if (m !== 'showcase' && m !== 'follow' && m !== 'closeup' && m !== 'select') return;
    if (m === mode) return;
    const prev = mode;
    // 從目前鏡頭姿態平滑過渡
    blendFromPos.copy(camera.position);
    if (blendFromPos.lengthSq() < 1e-6 || !finite3(blendFromPos)) blendFromPos.set(0, 20, 90);
    blendFromQuat.copy(camera.quaternion);
    blendFromUp.copy(camera.up).normalize();
    if (!finite3(blendFromUp) || blendFromUp.lengthSq() < 0.5) blendFromUp.set(0, 1, 0);
    blendT = 0;
    mode = m;
    const hasPlayer = !!(player && player.position && finite3(player.position));
    blendPivot = hasPlayer && (isPortraitMode(m) || isPortraitMode(prev)) && m !== 'showcase'
      && blendFromPos.distanceTo(player.position) < 40;
    viewFromX = viewX; viewFromY = viewY;
    if (m === 'follow') {
      // 從衣櫥特寫回來：保留原本的視角（方向、俯角、距離）；選角後：站到角色背後
      if (prev === 'closeup') snapFollow(false, true);
      else snapFollow(true);
    } else if (isPortraitMode(m)) {
      cu = m === 'select' ? SELECT : CLOSEUP;
      if (hasPlayer) chooseCloseupYaw();
      cuT = 0;
      cuLift = -1;
    } else {
      orbitAngle = Math.atan2(camera.position.x, camera.position.z);
      showcaseT = 0;
    }
  }

  function snap() {
    blendT = 1;
    if (mode === 'follow') snapFollow(false);
    if (isPortraitMode(mode)) { cuLift = -1; if (player && player.position) chooseCloseupYaw(); }
    computeIdeal(0);
    apply();
    shiftFor(mode);
    viewFromX = viewTo.x; viewFromY = viewTo.y;
    updateViewOffset();
  }

  return {
    get mode() { return mode; },
    setMode,
    update,
    snap,
    /** 是否正在模式切換的飛行過渡中 */
    get transitioning() { return blendT < 1; },
  };
}
