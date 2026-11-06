# Clone Mart Rush tests

```sh
NODE_PATH=$(npm root -g) node clone-mart/tests/run.js
```

Playwright (with Chromium) comes from the global npm install, hence `NODE_PATH`. The run prints a PASS/FAIL table.
Exit code 0 = all PASS, 1 = some FAIL, 2 = crashed or timed out. It takes about 3–4 minutes under SwiftShader (longer on a loaded machine).

| Env | Meaning |
| --- | --- |
| `THREE_JS=/path/three.min.js` | serve a local three.js r128 instead of the CDN (needed offline) |
| `OUT_DIR=/dir` | screenshot folder (default: a new tmp dir, printed at the end) |
| `ONLY=smoke,flow` | run only these groups (comma list or regex): `smoke`, `controls`, `recipes`, `hazards`, `flow`, `invariants`, `edge`, `difficulty`, `progress`, `cosmetics`, `long`, `balance`, `perf` |
| `PERF_MAX_MS=ms` | the perf probe fails only above this average frame time (default 1500; it reports, it does not judge devices) |
| `PERF_MS=ms` | how long the perf probe samples frames (default 4000) |
| `SHOTS=all` | also screenshot level select, prep and countdown (each SwiftShader screenshot takes 10–30 s) |
| `GAME_HTML=/path/index.html` | test another copy of the game |
| `SUITE_TIMEOUT=secs` | hard cap (default 360) |
| `DEBUG=1` | print timestamps of slow steps |

Google Fonts are answered with empty CSS. Font failures are ignored. Any other page error or console error is a FAIL.

## How it works

Desktop 1280x760, iPhone 13, iPad and a second desktop (progression groups) run in parallel, each in its own Chromium. The mobile devices run at DPR 1.
Game logic runs through the `window.__cloneMart` hook. `sim(secs)` advances the game in 1/30 s steps without rendering, so the logic tests are fast and do not depend on the frame rate.
Input tests send real events: keyboard, mouse, CDP touch for the joystick and `#btnUse`, and taps on `#btnGrab` and `#btnSwap`. Game time then advances with `sim()`, and the game reads the held keys or touches on every step. A slow software renderer therefore makes these tests slower but not flaky.
The smoke test lets the real countdown run. If the renderer is too slow, it checks that the countdown advanced and then calls `skipCountdown()`.

The suite reads all content from the game at run time: `RECIPES`, `PLANS`, `LEVELS`, `ROLES`, `SLOTS`, `APPL` and `MAX_FAILS_ENDLESS`. When you add a recipe, level, station or clone role, the suite covers it automatically. A new recipe needs a `PLANS` entry; without one, the recipe test fails.

| Group | What it checks |
| --- | --- |
| smoke | title → 開始營業 → level select → prep → 開店！ → countdown → play on all three devices. Checks tickets, touch buttons and the HUD star target. No page or console errors. |
| controls | Keyboard: WASD moves the player, Space grabs, holding E chops, Q switches character. Touch: joystick drag, `#btnGrab`, holding `#btnUse`, `#btnSwap`. Click or tap on a station walks the player there and uses it. |
| recipes | A scripted player completes every recipe using only `grab`/`useTick` at station spots, following the chain in `PLANS`. For each recipe it lists, a clone role makes and delivers it on its own (AI only). |
| hazards | burn → fire → spread → extinguisher. A spill makes the controlled player slip and can be mopped. A broken machine does not cook until repaired. The cleaner clone handles fire with a burnt item, a spill and a broken machine. |
| flow | The timer ends the level. Results show the right stars at the threshold scores on every level. Best score and stars survive a reload (the localStorage key matches `/clone.?mart/i`). The next level unlocks at ≥1★. Clone roles unlock by total stars. Endless mode ends at the maximum number of fails. |
| invariants | Every level runs with the AI bot plus clones, and with clones alone. Checks: the score stays finite; no item is in two places; every order has a live customer; no clone is stuck for more than 20 s (waiting on a hazard does not count); no food is abandoned to burn in a machine; the scene child count stays the same across restarts. |
| difficulty | `DIFFS` are ordered 輕鬆 → 挑戰 (an easier mode is never stricter). `effLevel` scales ticket timers, order gap, ★ thresholds and clone slots on every level and leaves `LEVELS` untouched. In game, per difficulty: the ticket timer, the spawn gap, a real burn in a machine (and the fire timers), the prep screen's slots, the menu demo back on base timers, the crown (挑戰 only) and coins. |
| progress | Stable level ids (`endless`, `c1-1`…). Chapter `need`, previous-level ★ and `req` unlock rules on every chapter, plus a synthetic chapter; `第 ch-n 關` labels; level-select buttons and the intro card. Save v1 (best keyed by index) → v2 ids, bad entries dropped, saved back as v2. v2 round trip of best/crown, difficulty, coins, owned, equipped (worn after reload), achievements. Corrupt and hostile saves boot with defaults. |
| cosmetics | Every cosmetic on the owner: attach, re-apply (no growth), remove; one per slot; unknown ids; a clone wears its role's cosmetic from spawn; the scene does not grow across restarts. Themes (or a throw-away theme when only the default store exists): on twice = once, on/off cycles stable, nothing left visible, door → queue / checkout and owner → pass paths walkable; a chapter's theme turns on with its level, customers still queue, and turns off in the menu. |
| long | 12 levels back to back (endless included, bot + team): the menu world, scene, world tags and DOM stay the same size; customers, orders and spills stay bounded. |
| balance | `tests/human.js` plays like a person (0.6–1.2 s reaction before each step, 80 % walk speed, wrong pick-ups, not always the oldest ticket, distracted while food cooks). 輕鬆 + default team: ≥1★ on every chapter-1 level, ≥2★ on most. 標準: ≥1★ on most. 挑戰: AI alone stays under ★★ and solo play averages under ★★. Later chapters are played and reported (WARN), not failed. |
| perf | iPhone 13 at DPR 1: average and p95 frame time over 4 s of busy play. Reported; fails only above `PERF_MAX_MS`. |
| edge | Pause during the countdown. Quitting to the menu, and results → next-level prep. Input during results. Switching character while holding or chopping. Switching to a clone that is still spawning. Two characters grabbing the same station in one frame. Dropping onto a fire. An extinguisher left on a station that catches fire. A clone's machine breaks or its order expires mid-cook. Restarting mid-fire. Hot reload snapshot. |

Balance report (not part of the suite): `node clone-mart/tests/balance.js [trials] [chapter]` plays every level of a chapter on every difficulty, solo, with the default team, and with the team alone (`MODES=solo,team,idle`), and prints stars per trial. `DIFF_OVERRIDE='{"easy":{"time":1.3}}'` tries other `DIFFS` numbers without editing the game; `HUMAN='{"pBurn":0.4}'` makes the bot sloppier.

The hook must keep `sim`, `startLevel`, `skipCountdown`, `botOwner`, `G`, `orders`, `SLOTS`, `SLOT`, `staff`, `customers`, `spills`, `LEVELS`, `RECIPES`, `ROLES`, `ROLE`, `ITEMS`, `PLANS`, `APPL`, `MAX_FAILS_ENDLESS`, `scene`, `pickables`, `grab`, `useTick`, `findTarget`, `switchChar`, `ignite`, `spawnSpill`, `breakRandomMachine`, `showLevels`, `showPrep`, `player` and `owner`; the progression groups also use `DIFFS`, `effLevel`, `CHAPTERS`, `levelUnlocked`, `lvLabel`, `bestOf`, `COSMETICS`, `applyCosmetics`, `THEMES`, `applyTheme`, `saveProgress`, `endLevel` and `spawnOrder`, and skip what is missing. The suite also uses `window.__cloneMartUX` (`camera`, `project`) and `window.__cloneMartNav.walkXZ`.
