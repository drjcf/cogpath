// Optional end-to-end check of the review console. Needs: npx playwright install chromium; a running server (npm run serve)
// with at least one ingested, non-stale source. Run: PORT=3077 SHOT=/tmp/console.png node test/e2e/console.smoke.cjs
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://localhost:${process.env.PORT || 3077}/#/sources`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Review' }).first().click();
  await page.waitForSelector('.claim');
  await page.fill('input[placeholder="reviewer name"]', 'smoke');
  // wait for the PDF text layer and a highlight
  await page.waitForSelector('.react-pdf__Page__textContent', { timeout: 20000 });
  await page.waitForSelector('mark.pdfhl', { timeout: 20000 });
  const mode = await page.getAttribute('.pdfspan', 'data-mode');
  const marks = await page.locator('mark.pdfhl').count();
  const markText = (await page.locator('mark.pdfhl').allTextContents()).join('|').slice(0, 120);
  // click the third claim and check the highlight moves
  await page.locator('.claim').nth(2).click();
  await page.waitForTimeout(700);
  const mode2 = await page.getAttribute('.pdfspan', 'data-mode');
  const marks2 = (await page.locator('mark.pdfhl').allTextContents()).join('|').slice(0, 120);
  const focusedId = await page.locator('.claim.focused .claim-id').textContent();
  // keyboard: J certifies the focused claim and advances
  await page.keyboard.press('j');
  await page.waitForTimeout(500);
  const certified = await page.locator('.claim.st-certified').count();
  const focusedAfter = await page.locator('.claim.focused .claim-id').textContent();
  // F → reason → Enter rejects
  await page.keyboard.press('f');
  await page.fill('.editor input', 'wrong attribution');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const rejected = await page.locator('.claim.st-rejected').count();
  // E → edit statement → save
  await page.keyboard.press('e');
  await page.fill('.editor textarea', 'Edited by smoke test.');
  await page.selectOption('.editor select >> nth=1', 'cited_work');
  await page.click('.editor button.primary');
  await page.waitForTimeout(500);
  const edited = await page.locator('.claim', { hasText: 'Edited by smoke test.' }).count();
  const pending = await page.locator('.badge-pending', { hasText: 'pending' }).first().textContent();
  await page.screenshot({ path: process.env.SHOT, fullPage: false });
  console.log(JSON.stringify({ mode, marks, markText, mode2, marks2, focusedId, certified, focusedAfter, rejected, edited, pending, errors }, null, 1));
  await browser.close();
})().catch((e) => { console.error('SMOKE FAILED', e.message); process.exit(1); });
