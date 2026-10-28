/**
 * Review API over the source store. No auth: this is a single-reviewer local tool. The reviewer's name is
 * supplied by the client (`by`) and recorded on every decision; a multi-user deployment must replace that
 * with a verified identity (the certifier of record is always a human, never the agent).
 */
import { createHash } from 'node:crypto';
import express from 'express';
import busboy from 'busboy';
import { listSources, loadIngest, loadDecisions, decideClaim, decisionCounts, approveIngest, unapproveIngest, resolveSha, shortSha, readPdf, listBuilds, loadBuild, listBuildEvents, registerUpload, patchSourceMeta, sourceMeta, createJob, getJob, listJobs, updateBuildSummary, storeName } from '../core/store.js';
import { ATTRIBUTIONS, CLAIM_TYPES, SECTIONS, reviewPassage } from '../core/ingest.js';
import { summarize } from '../core/build.js';
import { parsePath } from '../core/path.js';
import { newId } from '../core/executor.js';
import { DEFAULT_MODEL, isMock } from '../core/meta.js';
import { identify, requireWriter, authMode } from './auth.js';
import { launchJob, runnerMode } from './jobs.js';

const MAX_UPLOAD = 40 * 1024 * 1024;
const ALLOWED_EXT = /\.(pdf|md|markdown|txt|text)$/i;

/** Read one multipart file field into memory (uploads are a few MB; the worker re-reads them from the store). */
function readUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try { bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD } }); } catch (e) { return reject(e); }
    let out = null;
    const fields = {};
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (_name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => reject(Object.assign(new Error(`file exceeds ${MAX_UPLOAD / 1048576} MB`), { status: 413 })));
      stream.on('end', () => { out = { bytes: Buffer.concat(chunks), fileName: String(info.filename ?? 'source').replace(/[\\/]+/g, '_').trim() || 'source', mimeType: info.mimeType }; });
    });
    bb.on('error', reject);
    bb.on('close', () => resolve({ file: out, fields }));
    req.pipe(bb);
  });
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function shaParam(req) {
  const sha = await resolveSha(req.params.sha);
  if (!sha) { const e = new Error(`unknown source ${req.params.sha}`); e.status = 404; throw e; }
  return sha;
}

export function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));
  r.use(identify());

  // ── who am I, how is this deployment configured ──
  r.get('/config', (_req, res) => {
    let firebase = null;
    try { firebase = process.env.COGPATH_FIREBASE_WEB_CONFIG ? JSON.parse(process.env.COGPATH_FIREBASE_WEB_CONFIG) : null; } catch { firebase = null; }
    res.json({ auth: authMode(), store: storeName(), runner: runnerMode(), mock: isMock(), model: DEFAULT_MODEL, firebase, version: process.env.COGPATH_VERSION ?? null });
  });
  r.get('/me', (req, res) => {
    if (!req.user) return res.json({ anonymous: true, authError: req.authError ?? null });
    res.json({ email: req.user.email, name: req.user.name, role: req.user.role, canWrite: authMode() === 'none' ? Boolean(req.user.email) : Boolean(req.user.role), picture: req.user.picture ?? null });
  });

  // ── upload and ingest (write) ──
  r.post('/sources/upload', requireWriter(), wrap(async (req, res) => {
    const { file, fields } = await readUpload(req);
    if (!file || !file.bytes.length) return res.status(400).json({ error: 'a file field is required' });
    if (!ALLOWED_EXT.test(file.fileName)) return res.status(400).json({ error: 'upload a .pdf, .md or .txt file' });
    const sha = createHash('sha256').update(file.bytes).digest('hex');
    const kind = /\.pdf$/i.test(file.fileName) ? 'pdf' : 'text';
    const { meta, existed } = await registerUpload({ sha, fileName: file.fileName, kind, bytes: file.bytes, by: req.user.email });
    if (existed && !['true', '1'].includes(String(fields.force ?? ''))) return res.json({ sha, short: shortSha(sha), status: meta.status, existed: true, title: meta.title });
    const claims = fields.claims && fields.claims !== 'auto' ? Number(fields.claims) : null;
    if (claims !== null && (!Number.isInteger(claims) || claims < 8 || claims > 120)) return res.status(400).json({ error: 'claims must be auto or an integer between 8 and 120' });
    const job = await createJob({ kind: 'ingest', params: { sha, claims, audit: !['false', '0'].includes(String(fields.audit ?? '')), model: fields.model || DEFAULT_MODEL }, by: req.user.email });
    await patchSourceMeta(sha, { status: 'queued', jobId: job.id, error: null });
    const launched = await launchJob(job);
    res.status(202).json({ sha, short: shortSha(sha), status: 'queued', existed, jobId: job.id, launched });
  }));

  r.post('/sources/:sha/ingest', requireWriter(), wrap(async (req, res) => {
    const sha = await shaParam(req);
    const { claims = null, audit = true, model } = req.body ?? {};
    if (claims !== null && (!Number.isInteger(claims) || claims < 8 || claims > 120)) return res.status(400).json({ error: 'claims must be null (auto) or an integer between 8 and 120' });
    const job = await createJob({ kind: 'ingest', params: { sha, claims, audit: Boolean(audit), model: model || DEFAULT_MODEL }, by: req.user.email });
    await patchSourceMeta(sha, { status: 'queued', jobId: job.id, error: null });
    const launched = await launchJob(job);
    res.status(202).json({ sha, short: shortSha(sha), status: 'queued', jobId: job.id, launched });
  }));

  // ── builds (write) ──
  r.post('/builds', requireWriter(), wrap(async (req, res) => {
    const { sha: shaArg, items = 5, path: pathHint = null, deep = true, baseline = true, seed = null, allowDraft = false, model } = req.body ?? {};
    const sha = shaArg ? await resolveSha(String(shaArg)) : null;
    if (!sha) return res.status(400).json({ error: 'sha of an ingested source is required' });
    if (!Number.isInteger(items) || items < 1 || items > 20) return res.status(400).json({ error: 'items must be an integer between 1 and 20' });
    if (pathHint) { try { parsePath(String(pathHint)); } catch (e) { return res.status(400).json({ error: `path: ${e.message}` }); } }
    const ing = await loadIngest(sha);
    if (!ing) return res.status(404).json({ error: 'not ingested' });
    if (ing.stale) return res.status(409).json({ error: 'stale digest: re-ingest first' });
    if (ing.status !== 'approved' && !allowDraft) return res.status(409).json({ error: `digest is ${ing.status}, not approved` });
    const buildId = newId('build');
    const job = await createJob({ kind: 'build', params: { sha, items, path: pathHint || null, deep: Boolean(deep), baseline: Boolean(baseline), seed: seed === null || seed === '' ? null : Number(seed), allowDraft: Boolean(allowDraft), model: model || DEFAULT_MODEL, buildId }, by: req.user.email });
    await updateBuildSummary(buildId, { id: buildId, status: 'queued', createdAt: new Date().toISOString(), model: model || DEFAULT_MODEL, source: { title: ing.meta.title, sha, claims: ing.digest.claims.length, mode: 'digest', digestReview: ing.status }, n: items, deep: Boolean(deep), pathHint: pathHint || null, by: req.user.email, jobId: job.id, progress: { phase: 'queued', itemsDone: 0, of: items, at: new Date().toISOString() } });
    const launched = await launchJob(job);
    res.status(202).json({ id: buildId, jobId: job.id, launched });
  }));

  // ── jobs (read) ──
  r.get('/jobs', wrap(async (_req, res) => { res.json({ jobs: await listJobs(50) }); }));
  r.get('/jobs/:id', wrap(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    res.json(job);
  }));

  r.get('/sources', wrap(async (_req, res) => {
    res.json({ sources: (await listSources()).map((m) => ({ sha: m.sha, short: shortSha(m.sha), title: m.title, kind: m.kind, words: m.words ?? null, claims: m.claims ?? m.atoms ?? null, status: m.status, ingestedAt: m.ingestedAt ?? null, uploadedAt: m.uploadedAt ?? null, fileName: m.fileName ?? null, jobId: m.jobId ?? null, error: m.error ?? null, mock: Boolean(m.mock) })) });
  }));

  r.get('/sources/:sha', wrap(async (req, res) => {
    const sha = await shaParam(req);
    const ing = await loadIngest(sha);
    if (!ing) { const m = await sourceMeta(sha); return res.status(404).json({ error: 'not ingested', sha, status: m?.status ?? null, jobId: m?.jobId ?? null, jobError: m?.error ?? null, title: m?.title ?? null }); }
    if (ing.stale) return res.status(409).json({ error: 'stale digest: re-ingest before review', sha });
    const decisions = await loadDecisions(sha);
    const claims = ing.digest.claims.map((c) => ({ ...c, decision: decisions[c.id] ?? { status: 'pending' }, passage: reviewPassage(c, ing.pages, ing.text, 220) }));
    res.json({
      sha, short: shortSha(sha), title: ing.meta.title, kind: ing.meta.kind, words: ing.meta.words, status: ing.status, hasPdf: ing.hasPdf,
      ingestedAt: ing.meta.ingestedAt, model: ing.meta.model, mock: Boolean(ing.meta.mock), maxClaims: ing.meta.maxClaims ?? null, jobId: ing.meta.jobId ?? null, lifecycle: ing.meta.status ?? null, uploadedBy: ing.meta.uploadedBy ?? null,
      audit: ing.meta.audit ? { at: ing.meta.audit.at, removed: ing.meta.audit.removed ?? [], flagged: (ing.meta.audit.findings ?? []).filter((f) => !f.supported) } : null,
      dropped: ing.meta.dropped ?? [], review: ing.meta.review ?? { status: 'draft' },
      counts: decisionCounts(ing.digest, decisions), topic: ing.digest.topic,
      claims, vocab: { types: CLAIM_TYPES, attributions: ATTRIBUTIONS, sections: SECTIONS },
    });
  }));

  r.get('/sources/:sha/pdf', wrap(async (req, res) => {
    const sha = await shaParam(req);
    const bytes = await readPdf(sha);
    if (!bytes) return res.status(404).json({ error: 'no PDF stored for this source' });
    res.set('Content-Type', 'application/pdf');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(bytes);
  }));

  r.get('/sources/:sha/text', wrap(async (req, res) => {
    const sha = await shaParam(req);
    const ing = await loadIngest(sha);
    if (!ing) return res.status(404).json({ error: 'not ingested' });
    res.json({ text: ing.text, pages: ing.pages });
  }));

  r.post('/sources/:sha/claims/:id/decide', requireWriter(), wrap(async (req, res) => {
    const sha = await shaParam(req);
    const { action, reason, newStatement, newType, newAttribution } = req.body ?? {};
    const by = req.user.email;
    if (newType && !CLAIM_TYPES.includes(newType)) return res.status(400).json({ error: `type must be one of ${CLAIM_TYPES.join(', ')}` });
    if (newAttribution && !ATTRIBUTIONS.includes(newAttribution)) return res.status(400).json({ error: `attribution must be one of ${ATTRIBUTIONS.join(', ')}` });
    try {
      const out = await decideClaim(sha, req.params.id, { action, reason, by, newStatement, newType, newAttribution });
      const ing = await loadIngest(sha);
      res.json({ ...out, counts: decisionCounts(ing.digest, await loadDecisions(sha)), status: ing.status });
    } catch (e) { res.status(400).json({ error: e.message }); }
  }));

  r.post('/sources/:sha/approve', requireWriter(), wrap(async (req, res) => {
    const sha = await shaParam(req);
    const { note, certifyPending } = req.body ?? {};
    try {
      const { meta, digest } = await approveIngest(sha, { by: req.user.email, note: note ?? '', certifyPending: Boolean(certifyPending) });
      res.json({ status: 'approved', review: meta.review, claims: digest.claims.length });
    } catch (e) { res.status(/pending/.test(e.message) ? 409 : 400).json({ error: e.message }); }
  }));

  r.post('/sources/:sha/unapprove', requireWriter(), wrap(async (req, res) => {
    const sha = await shaParam(req);
    await unapproveIngest(sha, req.body?.note ?? '');
    res.json({ status: 'draft' });
  }));

  // ── builds ──
  r.get('/builds', wrap(async (_req, res) => {
    res.json({ builds: await listBuilds(summarize) });
  }));

  r.get('/builds/:id', wrap(async (req, res) => {
    const b = await loadBuild(req.params.id);
    if (!b) {
      // A build still running has a summary and no record yet.
      const s = (await listBuilds(summarize)).find((x) => x.id === req.params.id);
      if (!s) return res.status(404).json({ error: 'unknown build' });
      return res.json({ ...s, pending: true });
    }
    res.json({ ...b, summary: summarize(b) });
  }));

  r.get('/builds/:id/events', wrap(async (req, res) => {
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    res.json({ events: await listBuildEvents(req.params.id, { after }) });
  }));

  r.use((err, _req, res, _next) => { res.status(err.status ?? 500).json({ error: err.message }); });
  return r;
}
