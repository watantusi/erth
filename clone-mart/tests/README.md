# Clone Mart Rush tests

```sh
NODE_PATH=$(npm root -g) node clone-mart/tests/run.js
```

Playwright (with Chromium) comes from the global npm install, hence `NODE_PATH`. The run prints a PASS/FAIL table.
Exit code 0 = all PASS, 1 = some FAIL, 2 = crashed or timed out. It takes about 2.5–3 minutes under SwiftShader.

| Env | Meaning |
| --- | --- |
| `THREE_JS=/path/three.min.js` | serve a local three.js r128 instead of the CDN (needed offline) |
| `OUT_DIR=/dir` | screenshot folder (default: a new tmp dir, printed at the end) |
| `ONLY=smoke,flow` | run only these groups (comma list or regex): `smoke`, `controls`, `recipes`, `hazards`, `flow`, `invariants`, `edge` |
| `SHOTS=all` | also screenshot level select, prep and countdown (each SwiftShader screenshot takes 10–30 s) |
| `GAME_HTML=/path/index.html` | test another copy of the game |
| `SUITE_TIMEOUT=secs` | hard cap (default 360) |
| `DEBUG=1` | print timestamps of slow steps |

Google Fonts are answered with empty CSS. Font failures are ignored. Any other page error or console error is a FAIL.

## How it works

Desktop 1280x760, iPhone 13 and iPad run in parallel, each in its own Chromium. The mobile devices run at DPR 1.
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
| edge | Pause during the countdown. Quitting to the menu, and results → next-level prep. Input during results. Switching character while holding or chopping. Switching to a clone that is still spawning. Two characters grabbing the same station in one frame. Dropping onto a fire. An extinguisher left on a station that catches fire. A clone's machine breaks or its order expires mid-cook. Restarting mid-fire. Hot reload snapshot. |

The hook must keep `sim`, `startLevel`, `skipCountdown`, `botOwner`, `G`, `orders`, `SLOTS`, `SLOT`, `staff`, `customers`, `spills`, `LEVELS`, `RECIPES`, `ROLES`, `ROLE`, `ITEMS`, `PLANS`, `APPL`, `MAX_FAILS_ENDLESS`, `scene`, `pickables`, `grab`, `useTick`, `findTarget`, `switchChar`, `ignite`, `spawnSpill`, `breakRandomMachine`, `showLevels`, `showPrep`, `player` and `owner`. The suite also uses `window.__cloneMartUX` (`camera`, `project`) and `window.__cloneMartNav.walkXZ`.

## Local co-op checks (`coop.js`)

```sh
NODE_PATH=$(npm root -g) THREE_JS=/path/three.min.js node clone-mart/tests/coop.js
```

A separate desktop + iPhone run for 👥 雙人同樂 (about 3 minutes). It uses real keyboard events for both players at once (WASD + arrows, Space / Enter, holding E and /, Q and "."), a stubbed `navigator.getGamepads` with two pads, and `window.__cloneMartCoop`. It checks the prep toggle (always on desktop; on touch only with 2 pads), 2P taking a clone that leaves the AI loop, 2P delivering a coffee while 1P delivers a drink, the 1P / 2P line on the receipt, switching without landing on the other player, the empty-team partner, the camera keeping both players on screen at opposite corners when zoomed in, and co-op off behaving exactly like single player.
