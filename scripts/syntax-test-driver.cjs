// Drive the real Firefox (headless) against the live server's syntax test page.
const puppeteer = require('/home/dgadelha/HD_Externo/desenv/dsh-explorer-plugni/.pnpm-home/node_modules/puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: '/usr/bin/firefox',
    headless: true,
    args: ['--no-sandbox', '-profile', '/home/dgadelha/HD_Externo/desenv/dsh-explorer-plugni/.ff-profile'],
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (msg) => logs.push('[console] ' + msg.text()));
  page.on('pageerror', (err) => logs.push('[pageerror] ' + String(err)));
  await page.goto('http://127.0.0.1:3080/explorer-assets/_syntax-test.html', { waitUntil: 'networkidle0', timeout: 60000 });
  // wait for the async pipeline to finish
  await page.waitForFunction('window.__RESULT__ && window.__RESULT__ !== "pending"', { timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  const result = await page.evaluate(() => window.__RESULT__ || document.getElementById('result').textContent);
  console.log('=== RESULT ===');
  console.log(result);
  console.log('=== LOGS ===');
  console.log(logs.slice(0, 20).join('\n') || '(no console output)');
  await page.screenshot({ path: '/home/dgadelha/HD_Externo/desenv/dsh-explorer-plugni/.syntax-test.png' });
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('DRIVER FAIL:', e); process.exit(1); });
