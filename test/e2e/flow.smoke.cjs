// End-to-end console smoke in local mode: upload → ingest job → review (certify all, approve) → launch build → live
// progress → record. Needs a server started with MOCK_META=1 COGPATH_AUTH=none COGPATH_JOB_RUNNER=local on an empty
// COGPATH_DATA, and Playwright (npx playwright install chromium). Run: PORT=3077 node test/e2e/flow.smoke.cjs
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const base = `http://localhost:${process.env.PORT || 3077}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept('smoke')); // the approval note prompt and the re-ingest confirm
  const shot = (name) => (process.env.SHOTS ? page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) : Promise.resolve());

  await page.goto(`${base}/#/sources`, { waitUntil: 'networkidle' });
  await page.fill('.identity input', 'smoke reviewer');
  await page.press('.identity input', 'Enter');
  await page.waitForSelector('form.upload');
  await page.setInputFiles('form.upload input[type=file]', path.resolve(__dirname, '../../samples/retrobulbar-hematoma.md'));
  await page.click('form.upload button[type=submit]');
  await page.waitForSelector('tr.st-draft', { timeout: 90000 });
  await shot('flow-sources');
  const statusText = await page.locator('tr.st-draft .badge').first().textContent();

  await page.locator('tr.st-draft button', { hasText: 'Review' }).first().click();
  await page.waitForSelector('.claim');
  // certify every pending claim with J
  for (let i = 0; i < 40; i++) {
    const pending = await page.locator('.claim.st-pending').count();
    if (!pending) break;
    await page.locator('.claim.st-pending').first().click();
    await page.keyboard.press('j');
    await page.waitForTimeout(150);
  }
  await page.locator('button', { hasText: 'Approve digest' }).click();
  await page.waitForTimeout(500);
  const approved = await page.locator('.counts .badge', { hasText: 'approved' }).count();
  await shot('flow-review');
  await page.locator('button.link', { hasText: 'Sources' }).click();
  await page.waitForSelector('tr.st-approved');
  await page.locator('tr.st-approved button', { hasText: 'New build' }).first().click();
  await page.waitForSelector('form.buildform');
  await page.fill('form.buildform input[type=number]', '1');
  await page.locator('form.buildform button[type=submit]').click();
  await page.waitForURL(/#\/builds\/build-/, { timeout: 15000 });
  await page.waitForSelector('.eventlog', { timeout: 15000 });
  await shot('flow-pending');
  const sawLive = (await page.locator('.progress').count()) > 0;
  await page.waitForSelector('.itemcard', { timeout: 120000 });
  await shot('flow-done');
  const cards = await page.locator('.itemcard').count();
  await page.goto(`${base}/#/builds`, { waitUntil: 'networkidle' });
  await page.waitForSelector('table.builds tbody tr');
  const row = await page.locator('table.builds tbody tr').first().textContent();
  const result = { statusText, approved, sawLive, cards, rowHasRates: /\d\/\d/.test(row), errors };
  console.log(JSON.stringify(result));
  await browser.close();
  if (errors.length || !cards || !approved || !result.rowHasRates) { console.error('SMOKE FAILED'); process.exit(1); }
})().catch((e) => { console.error('SMOKE FAILED', e.message); process.exit(1); });
