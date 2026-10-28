#!/usr/bin/env node
// Extract the Firebase web app config from `firebase apps:sdkconfig web` output (plain or --json) into
// deploy/firebase-web-config.json.   Usage: firebase apps:sdkconfig web --project <id> | node deploy/web-config.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'firebase-web-config.json');
const text = fs.readFileSync(0, 'utf8');
const KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId'];
let cfg = null;
try { const j = JSON.parse(text); cfg = j?.result?.sdkConfig ?? j?.sdkConfig ?? (j?.projectId && j?.apiKey ? j : null); } catch { /* not JSON */ }
if (!cfg) {
  const m = text.match(/initializeApp\(\s*(\{[\s\S]*?\})\s*\)/);
  if (m) { try { cfg = JSON.parse(m[1]); } catch { cfg = null; } }
}
if (!cfg) {
  // last resort: key/value lines in the plain output
  cfg = {};
  for (const k of KEYS) { const m = text.match(new RegExp(`"?${k}"?\\s*:\\s*"([^"]+)"`)); if (m) cfg[k] = m[1]; }
}
const picked = Object.fromEntries(KEYS.filter((k) => cfg[k]).map((k) => [k, cfg[k]]));
if (!picked.apiKey || !picked.projectId || !picked.appId) { console.error('could not find apiKey, projectId and appId in the input'); process.exit(1); }
fs.writeFileSync(out, JSON.stringify(picked, null, 2) + '\n');
console.log(`wrote ${out} (${Object.keys(picked).join(', ')})`);
