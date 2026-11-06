# 地球小旅人 Tiny Earth Wanderer — 架構與模組合約

一款原創的 3D 小星球漫遊遊戲。玩家扮演一位小旅人，在一顆迷你地球上走遍六個生態區（草原、森林、沙漠、極地、火山、海洋），
收集 12 顆「知識晶石」（每顆附一則地球科學小知識），並把幼苗種在 8 塊荒地上，讓逐漸褪色的星球恢復色彩。
全部畫面都用程式產生的低多邊形幾何，沒有外部模型或貼圖，檔案很小，手機、平板、電腦瀏覽器都能玩。

## 技術

- Three.js 0.160.0（已放在 `lib/three.module.min.js`），透過 import map 以 `import * as THREE from 'three'` 載入。
- 可用附加模組：`import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'`（只放了這一個）。
- 純 ES modules，不需要建置工具。用任何靜態伺服器開啟 `game/index.html` 即可（例如 `python3 -m http.server`）。
- **不得**使用任何 CDN 或網路資源（字型除外也不要），所有東西都要能離線執行。

## 座標與共用約定

- 星球中心在原點，基準半徑 `PLANET_RADIUS = 30`。地表某點的「上」= 該點位置的單位向量（`dir`）。
- 所有「方向」都是單位 `THREE.Vector3`。地表上一點 = `dir * world.getGroundRadius(dir)`。
- 物體站在地表：`utils.placeOnSphere(object, dir, radius, facing)`，本地 +Y = 地表法線，本地 +Z = 面向。
- 常數全部在 `js/config.js`，工具函式在 `js/utils.js`（雜訊、亂數、球面數學）。這兩個檔案只有整合者能改。
- 效能預算（手機要順）：整個場景 draw call 最好 < 150；重複物件用 `InstancedMesh` 或合併幾何；
  材質用 `MeshLambertMaterial` / `MeshToonMaterial` / `MeshBasicMaterial`（`flatShading: true` 營造低多邊形風格）；
  **不使用即時陰影貼圖**（角色/NPC 用腳下的圓形假陰影）；不要每幀配置新物件（重複利用 Vector3）。

## 檔案所有權

| 檔案 | 擁有者 |
|---|---|
| `index.html`, `style.css`, `js/main.js`, `js/config.js`, `js/utils.js` | 整合者 |
| `js/world.js` | 分身 1：世界美術 |
| `js/player.js` | 分身 2：角色與物理 |
| `js/input.js`, `js/cameraRig.js`, `css/controls.css` | 分身 3：操控與鏡頭 |
| `js/gameplay.js`, `js/content.js` | 分身 4：玩法與內容 |
| `js/ui.js`, `js/audio.js`, `js/effects.js`, `css/ui.css` | 分身 5：介面、音效與特效 |

每位只改自己的檔案。需要別人的功能時，只能呼叫下面合約列出的 API。

## DOM 結構（index.html）

```html
<div id="app">
  <canvas id="game"></canvas>   <!-- WebGL 畫布，touch-action: none -->
  <div id="touch"></div>        <!-- 分身 3 在這裡放虛擬搖桿與跳躍鈕 -->
  <div id="ui"></div>           <!-- 分身 5 在這裡建立所有介面 -->
</div>
```

z-index：canvas 0、`#touch` 10、`#ui` 20。

畫面區域分配（避免按鈕重疊；`S*` = 對應的 `env(safe-area-inset-*)`）：
- 分身 3（觸控時才顯示）：左下半部是浮動搖桿區；跳躍鈕 88×88px，位於 `right: 24px+S右`、`bottom: 28px+S下`。
- 分身 5：表情鈕 56×56px，位於 `right: 40px+S右`、`bottom: 136px+S下`（桌機同位置）；
  左上是進度、上方中央是指南針與提示訊息、右上是設定與靜音鈕。底部中央 40% 寬度留給分身 3，不要放常駐 UI。`#ui` 預設 `pointer-events: none`，可點的元素自己設 `pointer-events: auto`。
`#touch` 也預設 `pointer-events: none`，搖桿/按鈕自己設 `auto`。注意手機的 safe area（`env(safe-area-inset-*)`）。

## 模組 API 合約

### world.js（分身 1）
```js
export function createWorld({ scene, renderer, quality }) // quality: 'low' | 'high'
returns {
  root,                         // THREE.Group，已加入 scene
  getGroundRadius(dir),         // → number：該方向「可行走表面」的半徑。海洋區回傳 max(海床, SEA_LEVEL - 0.35)，讓角色在淺水涉水
  getSurfacePoint(dir, offset = 0, out?), // → Vector3：dir * (getGroundRadius(dir) + offset)
  getBiome(dir),                // → config.BIOMES 中的物件（含 id、name、icon…）
  isWater(dir),                 // → boolean：該處地形低於海面
  obstacles,                    // Array<{ position: Vector3, radius: number }>：樹、石頭、房子等不能穿過的物件（位置在地表上）
  isFree(dir, clearance),       // → boolean：該方向附近 clearance 距離內沒有障礙物且不在深水
  setRestoration(f),            // f: 0..1，星球恢復程度。0 = 略褪色、1 = 鮮豔繽紛（可平滑過渡）
  update(dt, t, camera),        // 每幀呼叫：雲飄動、水波、太陽光方向跟隨鏡頭讓玩家看的那面永遠被照亮等
}
```
- 地形高度必須是 `dir` 的確定性函式（用 `utils.fbm3` + 生態區決定振幅），`getGroundRadius` 要和渲染出的網格吻合（誤差 < 0.15）。
- 起點生態區（草原）中心附近半徑約 0.25 rad 內地形要平緩、沒有障礙物。

### player.js（分身 2）
```js
export function createPlayer({ scene, world })
returns {
  object,            // THREE.Object3D（根節點）
  position,          // Vector3（就是 object.position 的參考）
  up,                // Vector3：目前地表法線
  forward,           // Vector3：面向（切平面內的單位向量）
  grounded,          // boolean
  inWater,           // boolean
  speed,             // number：目前水平速度
  update(dt, input, camera), // input 見下方 input.state；依鏡頭方向決定移動方向
  setDirection(dir), // 傳送到該方向的地表（開場、讀檔用）
  getDirection(out?),// → 目前位置的單位方向
  celebrate(),       // 播放一次慶祝動作（跳起轉圈）
  getHeadPosition(out?), // → 頭頂上方的世界座標（給表情泡泡用）
  onJump, onLand,    // 可被指派的 callback（main 會接到音效）：player.onJump = () => {}
  onStep,            // 每踏一步呼叫一次（給腳步聲）
}
```

### input.js（分身 3）
```js
export function createInput({ canvas, touchRoot })
returns {
  state: {
    moveX, moveY,    // -1..1，moveY > 0 = 往前（鏡頭朝向）
    run,             // boolean
    jumpPressed,     // boolean：這一幀剛按下（edge）
    lookX, lookY,    // 這一幀累計的鏡頭旋轉量（像素，滑鼠拖曳或手指在空白處拖曳）
    zoom,            // 這一幀累計縮放量（滾輪 / 雙指捏合），> 0 = 拉遠
  },
  isTouch,           // boolean：觸控裝置
  setEnabled(bool),  // false 時清空並忽略所有輸入，隱藏搖桿
  endFrame(),        // 每幀最後呼叫，清除 edge 與累計量
}
```
鍵盤：WASD/方向鍵移動、Shift 跑、Space 跳。遊戲手把（Gamepad API）可選做。表情快捷鍵 1–6 由 ui.js 負責。

### cameraRig.js（分身 3）
```js
export function createCameraRig({ camera, world, player, input })
returns {
  mode,              // 'showcase' | 'follow'
  setMode(mode),     // showcase：開始畫面時繞著整顆星球緩慢旋轉；follow：第三人稱跟隨玩家
  update(dt),
  snap(),            // 立即跳到目標位置（不平滑）
}
```
`setMode('follow')` 要從目前鏡頭位置平滑飛入（約 1.2 秒）；`snap()` 則立即到位。
鏡頭的「上」要平滑跟隨玩家所在地表法線；水平朝向要隨玩家在球面移動做平行移動（走到星球另一面也不會翻轉）；
鏡頭不可鑽進地面；可用 input 的 lookX/lookY 旋轉、zoom 縮放。

### gameplay.js / content.js（分身 4）
```js
export function createGameplay({ scene, world, player, ui, audio, effects })
returns {
  update(dt, t),
  getNearestTarget(),  // → { position: Vector3, label: string } | null：最近的未完成目標（晶石 / 幼苗 / 荒地）
  onPlayerEmote(emoji),// 玩家使用表情時呼叫（附近 NPC 會回應）
  getProgress(),       // → { crystals, totalCrystals, trees, totalTrees, done }
  getSaveData(),       // → 可 JSON 序列化的物件
  loadSaveData(data),  // 還原進度（容錯：資料不完整或格式錯就忽略）
  reset(),             // 重新開始
}
```
- 呼叫 `ui.showFact / ui.toast / ui.updateProgress / ui.addBubble / ui.showVictory`、`audio.play`、
  `effects.burst / effects.ring`、`world.setRestoration`、`player.celebrate`。
- content.js 匯出知識卡內容（繁體中文、正確的地球科學知識）。

### ui.js / audio.js / effects.js（分身 5）
```js
export function createUI({ root, audio, callbacks: { onStart, onEmote, onQuality, onReset } })
returns {
  showStart({ hasSave }),   // 開始畫面（標題、開始/繼續按鈕、操作說明）；按下後呼叫 callbacks.onStart({ continue: bool })
  hideStart(),
  showFact(fact),           // fact: { icon, title, text, biomeName }；彈出知識卡（暫停遊戲），按鈕或點擊關閉
  isModalOpen(),            // → boolean（開始畫面、知識卡、設定、勝利畫面開著時為 true）
  toast(text, ms = 2200),
  updateProgress(p),        // p 同 gameplay.getProgress()
  addBubble(getWorldPos, emoji, duration = 2.5), // getWorldPos: () => Vector3；在 3D 位置上方顯示表情泡泡
  setTarget(worldPos | null, label), // 指南針指向目標
  showVictory(stats),       // stats: { timeSec, crystals, trees }；有「繼續漫遊」與「重新開始」
  update(dt, camera, player),
}
export function createAudio()
returns { unlock(), play(name), setMuted(bool), isMuted(), startMusic() }
// name: 'collect' | 'jump' | 'land' | 'plant' | 'step' | 'emote' | 'ui' | 'win' | 'splash' | 'npc' | 'seed'
// 全部用 Web Audio 即時合成，不載入音檔。unlock() 在第一次使用者手勢時呼叫。
export function createEffects(scene)
returns { burst(position, color, count = 24), ring(position, up, color), update(dt) }
```
ui 的表情按鈕/輪盤（以及鍵盤 1–6）選擇後呼叫 `callbacks.onEmote(emoji)`；設定面板含「音效開關」（直接呼叫 audio）、
「畫質 高/低」（呼叫 `callbacks.onQuality('high'|'low')`）、「重新開始」（`callbacks.onReset()`）。

## 主迴圈（main.js，整合者）

```
dt = min(clock.getDelta(), 1/20)
if (遊戲中 && !ui.isModalOpen()) { player.update(dt, input.state, camera); gameplay.update(dt, t) }
cameraRig.update(dt); world.update(dt, t, camera); effects.update(dt)
ui.setTarget(gameplay.getNearestTarget()); ui.update(dt, camera, player)
renderer.render(scene, camera); input.endFrame()
```
main 負責：renderer 建立與縮放、畫質、存檔（localStorage，try/catch）、把 player.onJump 等接到 audio、
表情 → `ui.addBubble(player.getHeadPosition, emoji)` + `gameplay.onPlayerEmote(emoji)` + `audio.play('emote')`。

---

# v2：平台挑戰、指南針解鎖、任務 NPC

v1 的合約全部保留（向下相容），以下是新增或修改的部分。之後還會加入 v3（知識測驗、收集裝扮、日夜循環、計時挑戰），設計時請預留彈性，但現在不要實作。

## 新的遊戲流程
- 12 顆晶石中，每個生態區有 **1 顆放在平台挑戰的頂端**（要跳上石柱、樹樁、冰柱等才拿得到），另 1 顆維持原本的地面擺放。
- 指南針一開始**沒有箭頭**，只顯示目前所在生態區與該區剩餘晶石數。完成居民任務可以得到 **地圖碎片**，逐步升級：
  - Lv0（0 片）：無箭頭。靠近機器人「嗶嗶」會給一次 20 秒的「訊號」，訊號期間顯示指向最近晶石的箭頭與距離（每台機器人冷卻 60 秒）。
  - Lv1（1 片）：常駐箭頭指向最近的晶石，不顯示距離。
  - Lv2（2 片）：箭頭加距離；目標也包含種子、荒地、進行中任務的目標。
  - Lv3（3 片以上）：再加上右上角的雷達小地圖（附近 30 單位內的所有目標與居民）。
- 6 個生態區各有一位任務居民，各給 1 片地圖碎片（共 6 片；超過 3 片的碎片在 v3 會換成裝扮獎勵，現在只要記錄數量）。
- 星球完全恢復（勝利）需要：12 晶石 + 8 棵樹 + 6 個任務。恢復度 = (晶石 + 樹 + 任務) / 26。

## 任務（邏輯在 quests.js，模型在 characters.js）
| 生態區 | 居民 | 任務 |
|---|---|---|
| meadow | 咩咩村長（羊） | 找回 3 隻走失的小雞：碰到小雞後牠會排隊跟著你，帶回雞舍（world.questSpots.meadow.home） |
| forest | 松鼠栗栗 | 收集 5 顆松果，其中至少 2 顆在森林平台挑戰上（world.challenges 的 spots） |
| desert | 駱駝阿沙 | 到極地的冰塊點拿一塊冰（world.questSpots.polar.ice），在 120 秒內帶回沙漠；冰會在頭上慢慢變小，融化了要重拿 |
| polar | 企鵝媽媽 | 找到 3 隻企鵝寶寶（其中 1 隻在極地平台挑戰頂端），牠們會跟著你回到媽媽身邊 |
| volcano | 岩岩博士（地質機器人） | 60 秒內依序踩過 3 個量測點（在火山平台挑戰上）；超時就重來 |
| ocean | 燈塔海龜 | 收集 3 顆發光海星（在海上踏石與海蝕柱上），帶回燈塔，燈塔會亮起來 |

## 檔案所有權（v2）
| 檔案 | 擁有者 |
|---|---|
| `js/main.js`, `js/config.js`, `js/utils.js`, `index.html`, `style.css` | 整合者 |
| `js/world.js` | 分身 1 |
| `js/player.js`, `js/characters.js`（新） | 分身 2 |
| `js/input.js`, `js/cameraRig.js`, `js/radar.js`（新）, `css/controls.css` | 分身 3 |
| `js/gameplay.js`, `js/quests.js`（新）, `js/content.js` | 分身 4 |
| `js/ui.js`, `js/audio.js`, `js/effects.js`, `css/ui.css` | 分身 5 |

## API 新增

### world（分身 1）
```js
world.platforms   // Array<{ id, kind, dir: Vector3, radius, top, bottom, bounce? }>
                  //  dir：中心方向（單位向量）；radius：頂面水平半徑；top：頂面離星球中心的半徑；
                  //  bottom：底面半徑（落地的柱子 = 地面高度以下；浮空平台 > 地面）；bounce：有值就是彈跳蘑菇，落上去以這個速度往上彈
world.getSupportRadius(dir, currentRadius) // → number：腳下最高可站立的表面 = max(地面, 所有覆蓋 dir 且 top <= currentRadius + 0.4 的平台頂面)
world.lastSupport  // 最近一次 getSupportRadius 選中的平台物件（是地面時為 null）
world.challenges  // Array<{ id, biome, name, start: Vector3, goal: Vector3, spots: Vector3[] }>
                  //  每個生態區 1 個；goal = 晶石懸浮的世界座標（在最高平台上方約 1.1）；spots = 其他平台頂面上的點（放任務物品用，每個挑戰至少 3 個）
world.questSpots  // { [biomeId]: { npc: Vector3, home?: Vector3, ice?: Vector3, lighthouse?: Vector3 } }
                  //  npc：居民站的位置（平坦、無障礙、不在水裡）；meadow.home = 雞舍門口；polar.ice = 拿冰的地方；ocean.lighthouse = 燈塔門口
world.setLighthouseLit(bool) // 燈塔亮燈
```
- 平台挑戰的難度：相鄰平台高度差 ≤ 1.7、水平間隙 1.2–3.2（角色跳高約 2.3、跑跳水平約 6）。從地面走到第一階要很明顯。每個挑戰 5–9 個平台，可加 1–2 個彈跳蘑菇（bounce 約 17–19）。
- 平台不放進 `world.obstacles`（由 player 自己處理側面碰撞），但其他道具不可和平台重疊。

### player（分身 2）
- 站立改用 `world.getSupportRadius`；平台側面碰撞（腳低於頂面 0.4 以上又在半徑內 → 推出去）；從下方撞到浮空平台底部會停住上升；落到 `bounce` 平台時彈起並呼叫 `player.onBounce()`。
- 可變跳躍高度：`input.jumpHeld` 提早放開時截短上升。
- `player.supportPlatform`：目前站著的平台或 null。
- `player.setCarry(kind | null)`、`player.setCarryScale(s)`：頭上頂著的東西（目前只有 `'ice'`），縮放用來表示融化。

### characters.js（分身 2，新）
```js
export function createCharacter(kind) // kind: 'sheepElder' | 'squirrel' | 'camel' | 'penguinMom' | 'penguinChick' | 'chick' | 'geoBot' | 'turtle'
  → { object, update(dt, { moving, speed }), setHappy(bool), headHeight }
  // object 原點在腳底，+Y 朝上、+Z 朝前；放置與移動由 quests.js 負責（utils.placeOnSphere）
export function createItem(kind)      // kind: 'pinecone' | 'starfish' | 'mapFragment' | 'stationFlag' | 'iceBlock' → THREE.Object3D
```

### input（分身 3）
- `state.jumpHeld`（boolean）、`state.interactPressed`（edge：鍵盤 F 或 Enter、手把 X/Y、觸控互動鈕）。
- `input.setInteractHint(label | null)`：觸控時在跳躍鈕左邊顯示情境互動鈕（64px，`right: 124px+S右`、`bottom: 40px+S下`），例如「💬 對話」。

### cameraRig（分身 3）
- 鏡頭不可進入平台柱體內；站在高處時稍微拉遠、俯角加大，方便看到下一階。

### radar.js（分身 3，新）
```js
export function createRadar({ root }) → { update(nav, player, camera), setVisible(bool) }
// 圓形小地圖，放在 root（#touch）裡、右上角設定鈕下方：top: 84px+S上、right: 16px+S右，桌機 112px、手機 96px。
// 以玩家為中心、鏡頭朝向為上，顯示 nav.radar 裡的點（依 kind 用不同圖示/顏色）。nav.radar 為 null 時隱藏。
```

### gameplay / quests（分身 4）
```js
gameplay.getProgress()   // 新增 quests, totalQuests, fragments
gameplay.getNavInfo()    // → 同一個物件（每次就地更新）：
  // { level, fragments, ping (剩餘秒數), showArrow, showDistance, target: {position,label}|null,
  //   biome: {id,name,icon}, biomeLeft: {crystals, total}, radar: Array<{position, kind}>|null }
  //   radar kind: 'crystal' | 'seed' | 'plot' | 'npc' | 'quest'
gameplay.getInteractHint() // → string | null（例如「對話」），靠近任務居民時
gameplay.interact()        // 玩家按下互動
// getNearestTarget() 保留（= getNavInfo().target）
```
- 第一次靠近任務居民（2.6 內）自動開啟對話；之後要按互動。任務狀態：未接 → 進行中 → 完成（回報居民後給碎片）。
- 存檔延伸要能讀 v1 的存檔。

### ui（分身 5）
```js
ui.showDialogue({ name, icon, lines: string[], choices?: [{label, value}] }) // → Promise<value>；逐字顯示、點一下下一句；屬於 modal
ui.setQuests(list)       // [{ id, icon, title, progress: '1/3' 或 '剩 42 秒', state: 'active'|'done' }]：左側任務追蹤
ui.setNav(nav)           // 依 nav.level 顯示指南針（取代 setTarget；setTarget 保留相容）
ui.setPrompt(text|null)  // 畫面下方中央的小提示（桌機的「F 對話」）
ui.showFragment({ fragments, level, title, text }) // 取得地圖碎片的慶祝彈窗（modal）
// updateProgress 多一個「📜 任務 2/6」，勝利畫面統計加上任務
```
audio 新增：'bounce' | 'talk' | 'quest' | 'questDone' | 'fragment' | 'tick' | 'ping'

## 主迴圈新增（整合者）
```
if (input.state.interactPressed) gameplay.interact()
const hint = gameplay.getInteractHint(); input.setInteractHint(hint); ui.setPrompt(hint && !input.isTouch ? `F ${hint}` : null)
const nav = gameplay.getNavInfo(); ui.setNav(nav); radar.update(nav, player, camera)
player.onBounce = () => audio.play('bounce')
```
