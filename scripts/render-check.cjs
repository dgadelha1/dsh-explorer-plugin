// Render check for docs/index.html (GitHub Pages landing page).
// Drives the real Firefox (headless) via puppeteer-core and verifies:
//   - page loads with no console/page errors
//   - the screenshot image actually loads (naturalWidth > 0)
//   - the macOS-style frame shrink-wraps the image width exactly
//     (frame width = image width + 2*8px padding + 2*1px border = +18px;
//      the title bar adds height by design, so only width is asserted)
//   - no horizontal overflow at 1280px
// All paths are derived from this file's location, so it works from any
// checkout (same pattern as syntax-test-driver.cjs).
const path = require('path');
const ws = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ws, '.pnpm-home/node_modules/puppeteer-core'));

(async () => {
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: '/usr/bin/firefox',
    headless: true,
    args: ['--no-sandbox', '-profile', path.join(ws, '.ff-profile')],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + String(e)));
  await page.goto('file://' + path.join(ws, 'docs/index.html'), { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(
    `document.querySelector('.shot img') && document.querySelector('.shot img').complete && document.querySelector('.shot img').naturalWidth > 0`,
    { timeout: 15000 }
  ).catch(() => {});
  const m = await page.evaluate(() => {
    const img = document.querySelector('.shot img');
    const shot = document.querySelector('.shot');
    const ir = img.getBoundingClientRect();
    const sr = shot.getBoundingClientRect();
    return {
      viewport: [window.innerWidth, window.innerHeight],
      imgNatural: [img.naturalWidth, img.naturalHeight],
      imgRendered: [Math.round(ir.width), Math.round(ir.height)],
      frameRendered: [Math.round(sr.width), Math.round(sr.height)],
      frameWidthDelta: Math.round(sr.width - ir.width), // expect 18 (padding+border)
      imgLoaded: img.complete && img.naturalWidth > 0,
      imgSrc: img.getAttribute('src'),
      versionBadge: document.querySelector('.version-badge')?.textContent,
      ctaAnchor: !!document.querySelector('#install'),
      horizontalOverflow: document.body.scrollWidth > window.innerWidth,
    };
  });
  console.log('=== RENDER CHECK ===');
  console.log(JSON.stringify(m, null, 2));
  console.log('=== ERRORS ===');
  console.log(errors.length ? errors.join('\n') : '(none)');
  const ok = errors.length === 0 && m.imgLoaded && m.frameWidthDelta === 18 && !m.horizontalOverflow && m.versionBadge === 'v0.2.0 · MIT';
  console.log(ok ? 'RENDER CHECK PASSED' : 'RENDER CHECK FAILED');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('RENDER FAIL:', e); process.exit(1); });
