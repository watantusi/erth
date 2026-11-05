# Clone Mart tests

```sh
NODE_PATH=$(npm root -g) node clone-mart/tests/run.js
```

Playwright (with Chromium) comes from the global npm install, hence `NODE_PATH`. Exit code 0 = all PASS, 1 = some FAIL, 2 = crashed or timed out.

| Env | Meaning |
| --- | --- |
| `THREE_JS=/path/three.min.js` | serve a local three.js r128 instead of the CDN (needed offline) |
| `OUT_DIR=/dir` | screenshot folder (default: a new tmp dir, printed at the end) |
| `ONLY=regex` | run only matching groups: `smoke`, `input`, `path`, `logic`, `edge`, `save` |
| `FULL_DPR=1` | real device pixel ratio on iPhone/iPad (slow under SwiftShader) |
| `GAME_HTML=/path/index.html` | test another copy of the game |
| `SUITE_TIMEOUT=secs` | hard cap (default 480) |

Desktop 1280x760, iPhone 13 and iPad run in parallel, each in its own Chromium. Game logic is driven through `window.__cloneMart.sim()`; pathfinding checks use `window.__cloneMartNav` (`findPath`, `walkXZ`, `queueSpot`, named spots, `MAX_CUPS`, `DAY_LEN`). Keep both hooks when changing the game.
