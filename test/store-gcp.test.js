/**
 * The GCP store backend against a Firestore emulator (the Node implementation in @firestore-emulator/server, which
 * runs without a download) with blobs on local disk. Same contract the filesystem backend passes in pipeline.test.js:
 * ingest → decisions → approval → status; builds, progress, events; jobs; allowlist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FirestoreServer } from '@firestore-emulator/server';

const PORT = 8790 + Math.floor(Math.random() * 100);

test('gcp store: sources, decisions, approval, builds, jobs, allowlist on the Firestore emulator', async (t) => {
  const server = new FirestoreServer();
  await server.start(PORT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogpath-gcp-'));
  process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORT}`;
  process.env.GOOGLE_CLOUD_PROJECT = 'demo-cogpath';
  process.env.COGPATH_FIRESTORE_DB = 'cogpath-test';
  process.env.COGPATH_BLOBS = 'fs';
  process.env.COGPATH_DATA = dir;
  process.env.COGPATH_ALLOWLIST = 'env-admin@example.com';
  process.env.MOCK_META = '1';
  const store = await import('../core/store.js');
  store.configureStore('gcp');
  const gcp = await import('../core/store-gcp.js');
  t.after(async () => { await gcp.close(); await server.stop?.(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.FIRESTORE_EMULATOR_HOST; store.configureStore('fs'); });

  const { loadSource } = await import('../core/source.js');
  const { ingestSource } = await import('../core/ingest.js');
  const { summarize, buildItems } = await import('../core/build.js');
  const { withDigest } = await import('../core/source.js');

  // upload first (the cloud API's path), then ingest
  const file = path.resolve('samples/retrobulbar-hematoma.md');
  const bytes = fs.readFileSync(file);
  const raw = await loadSource(file);
  const up = await store.registerUpload({ sha: raw.sha, fileName: 'retrobulbar-hematoma.md', kind: 'text', bytes, by: 'uploader@example.com' });
  assert.equal(up.existed, false); assert.equal(up.meta.status, 'uploaded');
  assert.equal((await store.listSources())[0].status, 'uploaded');
  assert.equal(await store.loadIngest(raw.sha), null);

  const result = await ingestSource(raw, { model: 'mock' });
  const { meta } = await store.saveIngest({ source: raw, result, model: 'mock' });
  assert.equal(meta.status, 'draft'); assert.equal(meta.uploadedBy, 'uploader@example.com');
  const ing = await store.loadIngest(raw.sha);
  assert.equal(ing.status, 'draft'); assert.equal(ing.digest.claims.length, result.digest.claims.length); assert.ok(ing.text.length > 100); assert.ok(ing.pages.length >= 1); assert.equal(ing.hasPdf, false);
  assert.equal(await store.resolveSha(raw.sha.slice(0, 8)), raw.sha);

  // decisions and approval
  const [c0, c1, c2] = ing.digest.claims;
  await store.decideClaim(raw.sha, c1.id, { action: 'certify', by: 'rev' });
  const edited = await store.decideClaim(raw.sha, c2.id, { action: 'edit', by: 'rev', newStatement: 'Edited.', newAttribution: 'cited_work' });
  assert.equal(edited.claim.statement, 'Edited.');
  assert.equal((await store.loadIngest(raw.sha)).digest.claims[2].attribution, 'cited_work');
  await assert.rejects(() => store.approveIngest(raw.sha, { by: 'rev' }), /still pending/);
  const { digest } = await store.approveIngest(raw.sha, { drop: [c0.id], by: 'rev', certifyPending: true });
  assert.equal(digest.claims.length, result.digest.claims.length - 1);
  assert.equal((await store.loadIngest(raw.sha)).status, 'approved');
  assert.equal((await store.listSources()).find((s) => s.sha === raw.sha).status, 'approved');
  const d = await store.loadDecisions(raw.sha);
  assert.equal(d[c0.id].status, 'rejected'); assert.equal(d[c2.id].edited, true);
  // an edit after approval demotes to modified; the listing reads the stored status
  await store.decideClaim(raw.sha, c1.id, { action: 'edit', by: 'rev', newStatement: 'Changed again.' });
  assert.equal((await store.loadIngest(raw.sha)).status, 'modified');
  assert.equal((await store.listSources()).find((s) => s.sha === raw.sha).status, 'modified');
  await store.unapproveIngest(raw.sha, 'redo');
  assert.equal((await store.loadIngest(raw.sha)).status, 'draft');

  // builds: summary while running, record + summary at the end, events
  const src = { ...withDigest(raw, (await store.loadIngest(raw.sha)).digest, 'digest'), digestReview: 'approved' };
  const id = 'build-test00-abcdef';
  await store.updateBuildSummary(id, { status: 'running', source: { title: src.title, sha: src.sha }, n: 1, progress: { phase: 'plan' } });
  await store.appendBuildEvent(id, { type: 'plan:start' });
  await store.appendBuildEvent(id, { type: 'item:start', item: 'item1' });
  const pending = (await store.listBuilds(summarize)).find((b) => b.id === id);
  assert.equal(pending.status, 'running'); assert.equal(pending.progress.phase, 'plan');
  const ev = await store.listBuildEvents(id);
  assert.deepEqual(ev.map((e) => e.type), ['plan:start', 'item:start']);
  assert.equal((await store.listBuildEvents(id, { after: ev[0].seq })).length, 1);
  const build = await buildItems({ source: src, n: 1, model: 'mock', deep: false, baseline: true, id });
  const saved = await store.saveBuild(build, summarize);
  assert.match(saved.where, /^file:\/\/.*builds\/build-test00-abcdef\.json$/);
  const rec = await store.loadBuild(id);
  assert.equal(rec.items.length, 1); assert.equal(rec.baselines.length, 1);
  const list = await store.listBuilds(summarize);
  assert.equal(list.length, 1); assert.equal(list[0].status, build.status); assert.equal(list[0].rates.necessity, '1/1');
  assert.ok(fs.existsSync(path.join(dir, 'blobs', 'runs', `${rec.items[0].traceId}.json`)));

  // jobs
  const job = await store.createJob({ kind: 'build', params: { sha: raw.sha, items: 1 }, by: 'rev' });
  assert.equal(job.status, 'queued');
  await store.updateJob(job.id, { status: 'running', startedAt: 'now' });
  assert.equal((await store.getJob(job.id)).status, 'running');
  assert.equal((await store.listJobs())[0].id, job.id);
  await assert.rejects(() => store.updateJob('job-nope', {}), /unknown job/);

  // allowlist: the environment and the collection
  assert.equal((await store.allowlistEntry('ENV-Admin@example.com')).role, 'admin');
  assert.equal(await store.allowlistEntry('nobody@example.com'), null);
  await store.allowEmail('Reviewer@Example.com', { role: 'reviewer' });
  assert.equal((await store.allowlistEntry('reviewer@example.com')).role, 'reviewer');

  // the Files API id cache lives in the store too
  await store.writeFileCache({ abc: { id: 'file-1' } });
  assert.equal((await store.readFileCache()).abc.id, 'file-1');
});
