# 星際除草王 (Planet Mower) — 開發規格

3D、可在手機 / 平板 / 電腦瀏覽器遊玩的闖關除草遊戲。玩家駕駛除草機在小星球（球體）表面行駛，
把草割到目標百分比即過關。每顆星球是一關，有不同的地形與危險。

技術：純前端、無建置步驟。three.js 0.160.0 (ES module)，`index.html` 用 importmap：
`"three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"`。
所有模組放在 `planet-mower/js/`，以 `import * as THREE from 'three'` 匯入。
不可使用其他外部函式庫。所有給玩家看的文字用繁體中文。

## 檔案分工

| 檔案 | 負責 |
|---|---|
| `index.html`, `js/main.js` | 主控（整合者）：遊戲迴圈、球面移動、草地、碰撞、相機、粒子 |
| `js/models.js` | 3D 模型（分身 A） |
| `js/audio.js` | 音效 / 音樂（分身 B） |
| `js/ui.js`, `css/style.css` | 介面、HUD、觸控搖桿（分身 C） |
| `js/world.js` | 關卡資料、星球外觀、天空與背景（分身 D） |
| 測試 | 整合後的跨裝置遊玩測試與修正（分身 E） |

## 座標慣例（所有 3D 模型共通）
- 單位：公尺。模型原點在地面（底部中心），+Y 朝上（遠離星球中心），+Z 為前方。
- 主控會用 basis(left, up, forward) 擺放模型，模型自己不要設定 position/quaternion 於最外層 group。
- 材質用 `MeshLambertMaterial` / `MeshPhongMaterial` / `MeshStandardMaterial`，低多邊形風格（flatShading 可）。

## 模組介面

### js/models.js
```js
export function makeMower()            // 騎乘式除草機 + 太空人駕駛。約 1.3 寬 × 1.7 長 × 1.9 高
  // 回傳 { group, update(dt, speed, opts) }  speed: 公尺/秒 (可負), opts: { stunned:bool, boosting:bool, blink:bool }
  // update 負責：輪子依 speed 轉動、底下刀盤旋轉、stunned 時頭頂冒星星、boosting 時排氣管火焰、blink 時閃爍(可見度切換)
export function makeBug(color)         // 外星「播種蟲」，約 1.2 寬，懸浮 0.3m。回傳 { group, update(dt, t) } (腳/觸角擺動、上下浮動)
export function makeRock(rng, size, color)      // size = 碰撞半徑(公尺)，回傳 THREE.Object3D
export function makeCactus(rng, height)         // 碰撞半徑約 0.45，回傳 Object3D
export function makeCrystal(rng, size, color)   // 冰晶/紫晶簇，size = 碰撞半徑，回傳 Object3D
export function makePickup(type)       // type: 'wide' | 'time' | 'boost'；懸浮道具(原點即中心)，約 0.8 大
  // 'wide'=橘色(加寬刀片) 'time'=青色(加時間) 'boost'=黃色(加速能量)
  // 回傳 { group, update(dt, t) } 自轉 + 上下浮動 + 發光
```
`rng` 是回傳 [0,1) 的函式。不要依賴任何全域狀態。

### js/audio.js
```js
export const Sound = {
  init(),              // 第一次使用者手勢時呼叫，建立 AudioContext（失敗要安靜地忽略）
  toggleMute(),        // 回傳新的 muted 狀態 (bool)；狀態存 localStorage 'planet-mower-muted'（try/catch）
  isMuted(),
  setEngine(speed01, on),   // 引擎聲：on=false 時淡出；speed01 0..1(加速時可 >1 到 1.6)
  setMow(level01),          // 割草聲強度 0..1（每幀呼叫，內部平滑）
  play(name),               // 'click','go','count','pickup','hit','bump','win','lose','tick','boost'
  music(on),                // 輕快的程序化背景音樂循環（WebAudio 合成，音量低）
}
```
全部用 WebAudio 合成，不要載入音檔。每個方法在 ctx 不存在時都必須安全地什麼都不做。

### js/ui.js（+ css/style.css）
UI 模組自行建立所有 DOM（附加到 `document.body`），主控只呼叫 API：
```js
export function createUI(cb)  // cb: { onPlay, onSelect(idx), onGo, onPause, onResume, onRestart, onMenu, onNext, onMute }
// 回傳：
{
  showTitle(), showSelect(levels, save),   // levels = world.js 的 LEVELS；save = { unlocked: n, stars: [..] }
  showBriefing(level, idx), showCountdown(text) /* '3','2','1','出發!' ；text=null 隱藏 */,
  showPause(), showResult(r) /* r={win, stars, reason, pct, target, timeLeft, idx, hasNext, allClear} */,
  hideScreens(), showHUD(bool),
  updateHUD(h) /* h={idx, name, pct, target, time, lives, maxLives, boost(0..100), powers:[{label, t}], radar:bool} 每幀呼叫，請做差異更新 */,
  toast(msg), flash(color /* css 色 */), setMuted(bool),
  input /* 物件，UI 持續寫入觸控輸入：{ throttle:-1..1, steer:-1..1 (正=左轉), boost:bool } */
}
```
- 需同時支援滑鼠、觸控（手機直/橫向、平板）與鍵盤顯示說明。觸控：左半螢幕動態虛擬搖桿（上=前進、左右=轉向），右下大顆「加速」按鈕，右上暫停鍵。只有偵測到觸控裝置（`matchMedia('(pointer: coarse)')` 或首次 touch）才顯示觸控控制。
- 畫面：標題（遊戲名、開始、操作說明、靜音鈕）、關卡選擇（星球卡片：CSS 漸層球、名字、星數、鎖定）、任務簡報、暫停、結算（星星動畫、下一關/重玩/選單）、全破慶祝。
- HUD：關卡名、進度條（含目標標記）、倒數計時（<10 秒變紅閃爍）、生命（愛心）、加速能量條、道具倒數、radar=true 時顯示「↑ 跟著箭頭找剩下的草」。
- 版面適應 320px 寬手機到桌機，尊重 `env(safe-area-inset-*)`，避免文字選取與雙擊縮放。
- 風格：可愛太空卡通，深色半透明面板、圓角、粗體、鮮明綠色主按鈕。

### js/world.js
```js
export const LEVELS = [ /* 6 顆星球 */ {
  id, name, sub,            // 名稱、副標
  radius,                   // 星球半徑(公尺) 8~11
  time, target,             // 限時(秒)、目標比例(0.78~0.82)
  density,                  // 每平方公尺草叢數 ~5.5
  traction,                 // 抓地力：一般 9，冰 1.3
  rocks, cacti, crystals, lava, bugs,  // 各種物件數量
  regrow,                   // 0 或 0.12：會重新長回的草比例
  colors: { ground:[a,b], grass:[a,b], sky, hemiSky, hemiGround, sun, atmo, rock, crystal, bug, lava },
  emissiveGrass,            // 0 或小數，夜光草
  hazards: ['…'],           // 簡報顯示的危險說明
  tip,                      // 提示文字
  css: 'radial-gradient(...)' // 關卡卡片上的星球外觀
}]
export function makePlanetMesh(def)   // 回傳 Mesh：半徑 def.radius 的平滑球體，頂點色雜訊(ground 兩色)，不可位移頂點(遊戲假設完美球體)
export function makeLavaPool(def, R, angR)  // 球冠形熔岩池(以 +Y 為中心，角半徑 angR)，回傳 { mesh, update(t) } 脈動發光
export function createEnvironment(scene)  // 建立一次：星空 Points、太陽 sprite 等；回傳 { setLevel(def), update(dt, t, camera) }
  // setLevel：背景色、遠方裝飾天體（每關不同：月亮、環狀行星、巨大氣體行星…）、大氣光暈球(def.radius*1.15, BackSide 加法混合 shader)
```
關卡設計（由易到難）：
1. 翠綠星 — 新手：岩石少，R=8，100 秒
2. 沙丘星 — 仙人掌（撞到暈眩），R=9，110 秒
3. 冰晶星 — 地面很滑 traction 1.3，冰晶障礙，R=9，120 秒
4. 熔岩星 — 熔岩池（燒傷扣命），R=10，130 秒
5. 紫晶星 — 播種蟲(會把割過的草種回去、碰到扣命)，部分草會再長，R=10.5，170 秒
6. 暗影星 — 終章：夜光草、全部危險綜合、traction 3.5，R=11，200 秒

## 遊戲規則（主控實作）
- 3 條命；時間到或沒命 = 失敗。達到目標比例即過關。
- 星數：剩餘時間 ≥40% 三星、≥20% 兩星，其餘一星。存檔 localStorage `planet-mower-save-v1`。
- 操作：W/S/↑/↓ 前進後退，A/D/←/→ 轉向，Shift/空白 加速，P/Esc 暫停，M 靜音。
