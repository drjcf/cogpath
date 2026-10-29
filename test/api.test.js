/**
 * The API end to end on the filesystem store with the local job runner, in mock mode: upload → ingest job (a worker
 * child process) → review decisions and approval → build job → record and events. Identity is the x-cogpath-user
 * header (auth mode none); write routes refuse without it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 60000, every = 300 } = {}) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error('timed out'); await sleep(every); }
}

test('api: upload, ingest job, review, approve, build job, record and events', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogpath-api-'));
  Object.assign(process.env, { MOCK_META: '1', COGPATH_DATA: dir, COGPATH_STORE: 'fs', COGPATH_AUTH: 'none', COGPATH_JOB_RUNNER: 'local', COGPATH_JOB_QUIET: '1' });
  const { apiRouter } = await import('../server/api.js');
  const app = express();
  app.use('/api', apiRouter());
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const as = (user) => ({ 'x-cogpath-user': user });
  const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
  const post = async (p, body, headers = {}) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  assert.equal((await get('/config')).body.auth, 'none');
  assert.equal((await get('/me')).body.anonymous, true);

  // upload requires an identity
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync('samples/retrobulbar-hematoma.md')], { type: 'text/markdown' }), 'retrobulbar-hematoma.md');
  const anon = await fetch(`${base}/sources/upload`, { method: 'POST', body: form });
  assert.equal(anon.status, 401);
  const form2 = new FormData();
  form2.append('file', new Blob([fs.readFileSync('samples/retrobulbar-hematoma.md')], { type: 'text/markdown' }), 'retrobulbar-hematoma.md');
  const up = await fetch(`${base}/sources/upload`, { method: 'POST', body: form2, headers: as('rev@example.com') });
  assert.equal(up.status, 202);
  const { sha, jobId } = await up.json();
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.ok((await get(`/sources`)).body.sources.some((s) => s.sha === sha && ['queued', 'ingesting', 'draft'].includes(s.status)));

  // the worker ingests in the background
  const job = await until(async () => { const j = (await get(`/jobs/${jobId}`)).body; return j.status === 'done' ? j : j.status === 'failed' ? (() => { throw new Error(`ingest job failed: ${j.error}`); })() : null; });
  assert.equal(job.kind, 'ingest'); assert.ok(job.result.claims > 5);
  const src = (await get(`/sources/${sha.slice(0, 12)}`)).body;
  assert.equal(src.status, 'draft'); assert.equal(src.uploadedBy, 'rev@example.com');

  // uploading the same bytes again is a no-op
  const form3 = new FormData();
  form3.append('file', new Blob([fs.readFileSync('samples/retrobulbar-hematoma.md')]), 'again.md');
  const again = await (await fetch(`${base}/sources/upload`, { method: 'POST', body: form3, headers: as('rev@example.com') })).json();
  assert.equal(again.existed, true);

  // a build on a draft is refused; review, approve, then build
  assert.equal((await post('/builds', { sha, items: 1 }, as('rev@example.com'))).status, 409);
  const first = src.claims[0];
  const dec = await post(`/sources/${sha}/claims/${first.id}/decide`, { action: 'reject', reason: 'test', by: 'ignored-in-none-mode?' }, as('rev@example.com'));
  assert.equal(dec.status, 200); assert.equal(dec.body.decision.by, 'rev@example.com');
  const pending = await post(`/sources/${sha}/approve`, { note: 'x' }, as('rev@example.com'));
  assert.equal(pending.status, 409);
  const ok = await post(`/sources/${sha}/approve`, { note: 'x', certifyPending: true }, as('rev@example.com'));
  assert.equal(ok.status, 200); assert.equal(ok.body.claims, src.claims.length - 1);

  // the composer's registry and path check
  const ops = (await get('/ops')).body;
  assert.ok(ops.ops.some((o) => o.id === 'analyze' && o.params.some((p) => p.name === 'kind' && p.values.includes('mechanism'))));
  assert.ok(ops.presets.length >= 3);
  const chk = (await post('/paths/check', { paths: [ops.presets[0].path, 'recall(3) > evaluate(x)'] })).body.paths;
  assert.equal(chk[0].ok, true); assert.equal(chk[1].ok, false); assert.match(chk[1].error, /requires an earlier/);
  assert.equal((await post('/builds', { sha, items: 1, paths: ['recall(3) > nonsense'] }, as('rev@example.com'))).status, 400);

  const b = await post('/builds', { sha, items: 2, deep: true, baseline: true, seed: 3, paths: [ops.presets[0].path, ops.presets[2].path] }, as('rev@example.com'));
  assert.equal(b.status, 202);
  const buildId = b.body.id;
  const queued = (await get(`/builds/${buildId}`)).body;
  assert.equal(queued.pending, true); assert.ok(['queued', 'running'].includes(queued.status));
  const done = await until(async () => { const j = (await get(`/jobs/${b.body.jobId}`)).body; if (j.status === 'failed') throw new Error(`build job failed: ${j.error}`); return j.status === 'done' ? j : null; });
  assert.equal(done.result.buildId, buildId);
  const rec = (await get(`/builds/${buildId}`)).body;
  assert.equal(rec.pending, undefined); assert.equal(rec.items.length, 2); assert.equal(rec.by, 'rev@example.com'); assert.equal(rec.jobId, b.body.jobId);
  assert.equal(rec.summary.rates.necessity, '2/2');
  // composed paths are assigned round-robin and held exactly
  assert.equal(rec.pathMode, 'composed'); assert.deepEqual(rec.paths, [ops.presets[0].path, ops.presets[2].path]);
  assert.match(rec.items[0].plan.path, /^recall\(concepts=4\) > analyze\(kind=causal\)/); assert.match(rec.items[1].plan.path, /analyze\(kind=mechanism\)/);
  assert.deepEqual(rec.review, { pending: 2, certified: 0, rejected: 0, total: 2 });
  const list = (await get('/builds')).body.builds;
  assert.equal(list[0].id, buildId); assert.equal(list[0].status, rec.status); assert.equal(list[0].pathMode, 'composed');

  // item review and export
  assert.equal((await post(`/builds/${buildId}/items/item1/decide`, { action: 'certify' })).status, 401);
  const d1 = await post(`/builds/${buildId}/items/item1/decide`, { action: 'certify', reason: 'good' }, as('rev@example.com'));
  assert.equal(d1.status, 200); assert.equal(d1.body.decision.status, 'certified'); assert.equal(d1.body.decision.by, 'rev@example.com'); assert.deepEqual(d1.body.review, { pending: 1, certified: 1, rejected: 0, total: 2 });
  const d2 = await post(`/builds/${buildId}/items/item2/decide`, { action: 'reject', reason: 'weak key' }, as('rev@example.com'));
  assert.equal(d2.body.review.rejected, 1);
  assert.equal((await post(`/builds/${buildId}/items/item9/decide`, { action: 'certify' }, as('rev@example.com'))).status, 404);
  assert.equal((await post(`/builds/${buildId}/items/item1/decide`, { action: 'maybe' }, as('rev@example.com'))).status, 400);
  const ex = (await get(`/builds/${buildId}/export`)).body;
  assert.equal(ex.count, 1); assert.equal(ex.items[0].item, 'item1'); assert.equal(ex.items[0].options.filter((o) => o.key).length, 1); assert.ok(ex.items[0].options.some((o) => o.failsAt === 'recall')); assert.equal(ex.items[0].decision.status, 'certified');
  assert.equal(typeof ex.items[0].control.pass, 'boolean'); assert.ok('digestRecall' in ex.items[0].control);
  assert.equal((await get(`/builds/${buildId}/export?status=all`)).body.count, 2);
  const bank = (await get('/items')).body;
  assert.equal(bank.count, 1); assert.equal(bank.items[0].build, buildId);
  assert.equal((await get('/builds')).body.builds[0].review.certified, 1);
  await post(`/builds/${buildId}/items/item1/decide`, { action: 'clear' }, as('rev@example.com'));
  assert.equal((await get('/items')).body.count, 0);
  const events = (await get(`/builds/${buildId}/events`)).body.events;
  assert.ok(events.some((e) => e.type === 'plan:done') && events.some((e) => e.type === 'item:done') && events.some((e) => e.type === 'verify:necessity'));
  assert.ok(events.every((e) => JSON.stringify(e).length < 4000));
});
