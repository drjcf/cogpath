// Optional end-to-end check of the builds console. Needs: npx playwright install chromium; a running server (npm run serve)
// with at least one build record. Run: PORT=3077 node test/e2e/builds.smoke.cjs   (BUILD=<id> to open a specific build)
const { chromium } = require('playwright');
(async () => {
  const base = `http://localhost:${process.env.PORT || 3077}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`${base}/#/builds`, { waitUntil: 'networkidle' });
  await page.waitForSelector('table.builds tbody tr');
  const rows = await page.locator('table.builds tbody tr').count();
  if (process.env.BUILD) await page.goto(`${base}/#/builds/${process.env.BUILD}`, { waitUntil: 'networkidle' });
  else await page.locator('table.builds tbody tr a.rowlink').first().click();
  await page.waitForSelector('.itemcard');
  const cards = await page.locator('.itemcard').count();
  const card = page.locator('.itemcard').first();
  await card.locator('.tabs button', { hasText: 'What the verifier found' }).click();
  const picks = await card.locator('.necessity .pick').count();
  if (picks) await card.locator('.necessity .pick').last().click();
  await page.waitForTimeout(300);
  const ev = await card.locator('ul.evidence li').count();
  if (process.env.SHOT) { await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.SHOT }); }
  const hasBaseline = await card.locator('.tabs button', { hasText: 'Single-shot' }).count();
  let bOpts = null;
  if (hasBaseline) { await card.locator('.tabs button', { hasText: 'Single-shot' }).click(); bOpts = await card.locator('ol.options li').count(); }
  await card.locator('.tabs button', { hasText: 'How the answer was made' }).click();
  const walk = await card.locator('.walk-step').count();
  const facts = await card.locator('ol.facts li').count();
  const result = { rows, cards, picks, ev, bOpts, walk, facts, errors };
  console.log(JSON.stringify(result));
  await browser.close();
  if (errors.length || !rows || !cards || walk < 2 || !facts) { console.error('SMOKE FAILED'); process.exit(1); }
})().catch((e) => { console.error('SMOKE FAILED', e.message); process.exit(1); });
