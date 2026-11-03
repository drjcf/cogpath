#!/usr/bin/env node
/*
 * Renders docs/video/intro.html to an MP4 (H.264, 1920x1080) by seeking the timeline frame by frame.
 *
 *   node docs/video/render.cjs [--cues=0,4.2,12.3,18.2,23.3,32.5,33.7] [--dur=34.3] [--fps=30] [--out=docs/video/intro.mp4]
 *   node docs/video/render.cjs --stills=2,8,15 [--cues=...]      writes PNGs to docs/video/stills/ and exits
 *
 * Needs: `npm install` in web/ (fonts), playwright with its Chromium, ffmpeg on PATH.
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const fps = Number(arg('fps', 30));
const cues = arg('cues', '');
const dur = arg('dur', '');
const out = path.resolve(arg('out', path.join(__dirname, 'intro.mp4')));
const stills = arg('stills', '');

(async () => {
  const q = new URLSearchParams();
  if (cues) q.set('cues', cues);
  if (dur) q.set('dur', dur);
  const url = pathToFileURL(path.join(__dirname, 'intro.html')).href + (q.toString() ? `?${q}` : '');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.goto(url);
  await page.waitForFunction('window.READY === true', null, { timeout: 30000 });
  const fontsOk = await page.evaluate(() => document.fonts.check('600 20px "IBM Plex Sans"') && document.fonts.check('400 20px "IBM Plex Mono"'));
  if (!fontsOk) throw new Error('fonts not loaded: run `npm install` in web/ first');
  const duration = await page.evaluate('window.DURATION');

  if (stills) {
    const dir = path.join(__dirname, 'stills');
    fs.mkdirSync(dir, { recursive: true });
    for (const s of stills.split(',')) {
      await page.evaluate((t) => window.seek(t), Number(s));
      await page.screenshot({ path: path.join(dir, `t${String(Number(s).toFixed(1)).padStart(5, '0')}.png`) });
    }
    await browser.close();
    return;
  }

  const frames = Math.round(duration * fps);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => { ff.on('exit', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))); });
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.seek(t), i / fps);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log(`frame ${i}/${frames}`);
  }
  ff.stdin.end();
  await done;
  await browser.close();
  console.log(`wrote ${out} (${frames} frames, ${duration}s at ${fps} fps)`);
})().catch((e) => { console.error(e); process.exit(1); });
