/**
 * cogpath server: the review API plus the built web console (web/dist) when it exists.
 *   node server/index.js            → http://localhost:3077
 *   PORT=4000 node server/index.js
 * In development run the Vite dev server (npm run web) which proxies /api here.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { apiRouter } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../web/dist');
const app = express();
app.disable('x-powered-by');
app.use('/api', apiRouter());
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('text').send('cogpath API is up. Build the console with: npm run build:web (or run the dev server: npm run web)'));
}

const port = Number(process.env.PORT) || 3077;
const server = app.listen(port, (err) => {
  if (err) { console.error(`[cogpath] listen failed: ${err.message}`); process.exit(1); }
  console.log(`[cogpath] server on http://localhost:${port} · store ${process.env.COGPATH_STORE ?? 'fs'}${(process.env.COGPATH_STORE ?? 'fs') === 'fs' ? ` (${path.resolve(process.env.COGPATH_DATA || 'runs')})` : ''} · auth ${process.env.COGPATH_AUTH ?? ((process.env.COGPATH_STORE ?? 'fs') === 'gcp' ? 'firebase' : 'none')} · console ${fs.existsSync(dist) ? 'built' : 'not built'}`);
});
server.on('error', (err) => { console.error(`[cogpath] server error: ${err.message}`); process.exit(1); });
