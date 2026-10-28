/**
 * cogpath worker: one job per process. Runs as a Cloud Run Job execution (the API launches it with
 * COGPATH_JOB_ID set) or as a local child process (COGPATH_JOB_RUNNER=local). Reads the job from the store,
 * runs ingest or build with the shared flows, reports progress to the store, and exits 0 on success.
 *
 *   COGPATH_STORE=gcp COGPATH_JOB_ID=job-… node worker/index.js
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getJob, updateJob, readOriginal, patchSourceMeta, loadIngest, updateBuildSummary, appendBuildEvent, shortSha } from '../core/store.js';
import { loadSource, sourceFromStore, withDigest } from '../core/source.js';
import { ingestFlow, buildFlow } from '../core/flows.js';
import { parsePath } from '../core/path.js';
import { DEFAULT_MODEL } from '../core/meta.js';

const log = (...m) => console.log(`[worker ${new Date().toISOString()}]`, ...m);

/** Events worth keeping for a live trace: what is happening, never the artifacts themselves. */
function slim(e) {
  const base = { type: e.type };
  switch (e.type) {
    case 'plan:done': return { ...base, plans: e.plans.map((p) => ({ id: p.id, focus: p.focus, path: p.pathText, claims: p.claims })), usage: e.usage, ms: e.ms };
    case 'item:start': return { ...base, item: e.plan.id, index: e.index, path: e.plan.pathText };
    case 'step:start': return { ...base, step: e.step, op: e.op, effort: e.effort };
    case 'step:retry': return { ...base, step: e.step, problems: (e.problems ?? []).slice(0, 6) };
    case 'step:done': return { ...base, step: e.step, ms: e.ms, usage: e.usage, problems: (e.problems ?? []).slice(0, 6) };
    case 'item:done': return { ...base, item: e.plan.id, status: e.status, pass: e.verification ? `${e.verification.summary.passed}/${e.verification.summary.applicable}` : null, necessity: e.verification?.pathNecessity?.determinedAt ?? null, digestRecall: e.verification?.digestRecall?.pass ?? null };
    case 'baseline:start': return { ...base, item: e.plan.id };
    case 'baseline:done': return { ...base, item: e.plan.id, status: e.status ?? 'done', pass: e.verification ? `${e.verification.summary.passed}/${e.verification.summary.applicable}` : null, error: e.error ?? null };
    case 'verify:sourceRecall': case 'verify:digestRecall': return { ...base, choice: e.choice, lean: e.lean ?? null, skipped: Boolean(e.skipped) };
    case 'verify:necessity': return { ...base, k: e.k, choice: e.choice, lean: e.lean ?? null, override: e.override ?? null };
    case 'verify:mapping': return { ...base, step: e.step, picked: e.picked, lean: e.lean ?? null, keyBlocked: e.keyBlocked, landed: e.landed };
    default: return null;
  }
}

async function runIngest(job) {
  const { sha, claims, audit = true, model = DEFAULT_MODEL } = job.params;
  const orig = await readOriginal(sha);
  if (!orig) throw new Error(`no uploaded file for ${shortSha(sha)}`);
  await patchSourceMeta(sha, { status: 'ingesting', jobId: job.id, error: null });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogpath-'));
  const file = path.join(tmp, orig.fileName);
  fs.writeFileSync(file, orig.bytes);
  try {
    const source = await loadSource(file, { inlineText: true });
    if (source.sha !== sha) throw new Error(`stored bytes hash to ${shortSha(source.sha)}, not ${shortSha(sha)}`);
    const { result, meta } = await ingestFlow({ source, model, maxClaims: claims ? Number(claims) : undefined, audit, log });
    await patchSourceMeta(sha, { jobId: job.id, error: null });
    return { claims: result.digest.claims.length, title: meta.title };
  } catch (e) {
    await patchSourceMeta(sha, { status: 'failed', jobId: job.id, error: e.message });
    throw e;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function runBuild(job) {
  const { sha, items = 5, path: pathHint = null, paths = null, deep = true, baseline = true, seed, model = DEFAULT_MODEL, buildId, allowDraft = false } = job.params;
  const composed = paths?.length ? paths : pathHint ? [pathHint] : null;
  for (const p of composed ?? []) parsePath(p);
  const ing = await loadIngest(sha);
  if (!ing) throw new Error(`not ingested: ${shortSha(sha)}`);
  if (ing.stale) throw new Error('stale digest: re-ingest first');
  if (ing.status !== 'approved' && !allowDraft) throw new Error(`digest is ${ing.status}, not approved`);
  const raw = sourceFromStore(ing);
  const source = { ...withDigest(raw, ing.digest, 'digest'), digestReview: ing.status };
  const onEvent = (e) => { const s = slim(e); if (s) appendBuildEvent(buildId, s).catch((err) => log('event write failed', err.message)); };
  try {
    const { result } = await buildFlow({ source, n: Number(items), paths: composed, model, deep: Boolean(deep), baseline: Boolean(baseline), seed: seed != null ? Number(seed) : undefined, id: buildId, by: job.by, jobId: job.id, onEvent });
    return { buildId, status: result.status, items: result.items.length };
  } catch (e) {
    await updateBuildSummary(buildId, { status: 'failed', error: { message: e.message }, finishedAt: new Date().toISOString() });
    throw e;
  }
}

async function main() {
  const jobId = process.env.COGPATH_JOB_ID;
  if (!jobId) throw new Error('COGPATH_JOB_ID is not set');
  const job = await getJob(jobId);
  if (!job) throw new Error(`unknown job ${jobId}`);
  if (job.status === 'done') { log(`job ${jobId} already done`); return; }
  log(`job ${jobId} ${job.kind} ${JSON.stringify(job.params)}`);
  await updateJob(jobId, { status: 'running', startedAt: new Date().toISOString(), execution: process.env.CLOUD_RUN_EXECUTION ?? null, attempt: Number(process.env.CLOUD_RUN_TASK_ATTEMPT ?? 0) });
  try {
    const result = job.kind === 'ingest' ? await runIngest(job) : job.kind === 'build' ? await runBuild(job) : (() => { throw new Error(`unknown job kind ${job.kind}`); })();
    await updateJob(jobId, { status: 'done', finishedAt: new Date().toISOString(), result });
    log(`job ${jobId} done ${JSON.stringify(result)}`);
  } catch (e) {
    await updateJob(jobId, { status: 'failed', finishedAt: new Date().toISOString(), error: e.message });
    log(`job ${jobId} FAILED: ${e.stack ?? e.message}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
