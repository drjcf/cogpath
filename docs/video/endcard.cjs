#!/usr/bin/env node
/*
 * Renders docs/video/endcard.html to docs/video/endcard.png (1920x1080).
 *
 *   node docs/video/endcard.cjs [--out=docs/video/endcard.png]
 *
 * Needs: `npm install` in web/ (fonts), playwright with its Chromium.
 */
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const out = path.resolve(arg('out', path.join(__dirname, 'endcard.png')));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.goto(pathToFileURL(path.join(__dirname, 'endcard.html')).href);
  await page.waitForFunction('window.READY === true', null, { timeout: 30000 });
  const fontsOk = await page.evaluate(() => document.fonts.check('600 20px "IBM Plex Sans"') && document.fonts.check('400 20px "IBM Plex Mono"'));
  if (!fontsOk) throw new Error('fonts not loaded: run `npm install` in web/ first');
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
  await browser.close();
  console.log(`wrote ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
