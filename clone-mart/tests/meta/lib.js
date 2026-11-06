// Helpers for the progression/meta checks:  NODE_PATH=$(npm root -g) THREE_JS=/path/three.min.js node clone-mart/tests/meta/meta-tests.js
const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path');
const THREE = process.env.THREE_JS;   // local three.js r128 (CDN blocked); unset = load from the CDN
const GAME = 'file://' + path.resolve(process.env.GAME_HTML || path.join(__dirname, '..', '..', 'index.html'));
async function launch(){ return chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] }); }
async function open(browser, opts, init){
  const ctx = await browser.newContext(opts || { viewport: { width: 1280, height: 760 } });
  if (THREE) await ctx.route('**/three.min.js', r => r.fulfill({ body: fs.readFileSync(THREE), contentType: 'application/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/font/i.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(GAME);
  await page.waitForFunction(() => window.__cloneMart && window.__cloneMartMeta && document.getElementById('titleNav'), null, { timeout: 30000 });
  return { ctx, page, errors };
}
module.exports = { launch, open, devices };
