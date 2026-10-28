/**
 * The store: ingested sources (digest, decisions, approval), runs, builds, jobs. One domain layer over two
 * backends chosen by COGPATH_STORE: `fs` (default; <COGPATH_DATA>/… on disk) or `gcp` (Firestore + Cloud Storage).
 * A source is keyed by the sha256 of its bytes (or of its text for inline sources), so the same article ingested
 * from any path, in file or inline mode, resolves to one digest. Every function here is async.
 */
import { createHash } from 'node:crypto';
import { locateSpan } from './ingest.js';
import * as fsBackend from './store-fs.js';

export { DATA_DIR, sourceDir } from './store-fs.js';

let backend = null;
let backendName = null;
/** Choose the backend explicitly (tests, the worker); otherwise COGPATH_STORE decides on first use. */
export function configureStore(name) { backendName = name; backend = null; }
export async function store() {
  if (!backend) {
    const name = backendName ?? process.env.COGPATH_STORE ?? 'fs';
    if (name === 'gcp') backend = await import('./store-gcp.js');
    else if (name === 'fs') backend = fsBackend;
    else throw new Error(`unknown COGPATH_STORE "${name}" (fs or gcp)`);
    backendName = name;
  }
  return backend;
}
export const storeName = () => backendName ?? process.env.COGPATH_STORE ?? 'fs';

export const shortSha = (sha) => String(sha).slice(0, 12);

/** Approval binds to the reviewable content of the digest: annotations (page, audit repairs, provenance flags) may change without re-approval. */
export const digestHash = (digest) => createHash('sha256').update(JSON.stringify({ title: digest.title, topic: digest.topic, claims: (digest.claims ?? []).map((c) => ({ id: c.id, type: c.type, statement: c.statement, span: c.span, section: c.section, attribution: c.attribution })) })).digest('hex');

export const DECISION_STATUSES = ['pending', 'certified', 'rejected'];

/** stale: written by an older ingest (atoms without attribution); must be re-ingested before use. */
export const isStale = (digest) => !digest || !Array.isArray(digest.claims) || digest.claims.some((c) => !c.attribution);

/**
 * Review status of a stored digest: 'approved' only if a reviewer approved exactly this digest (hash match);
 * 'modified' if it was approved and then edited; otherwise 'draft'.
 */
export function reviewStatus(meta, digest) {
  const r = meta?.review;
  if (r?.status !== 'approved') return 'draft';
  return r.digestHash === digestHash(digest) ? 'approved' : 'modified';
}

/** Decision counts for a stored digest. */
export function decisionCounts(digest, decisions) {
  const counts = { pending: 0, certified: 0, rejected: 0, total: digest.claims.length };
  for (const c of digest.claims) counts[decisions[c.id]?.status ?? 'pending']++;
  return counts;
}

/** Persist meta with its denormalized `status`, so listings never need the digest. */
async function putMeta(sha12, meta, digest) {
  const b = await store();
  const status = digest ? (isStale(digest) ? 'stale' : reviewStatus(meta, digest)) : (meta.status ?? 'uploaded');
  const out = { ...meta, status, updatedAt: new Date().toISOString() };
  await b.writeMeta(sha12, out);
  return out;
}

export async function saveIngest({ source, result, model }) {
  const b = await store();
  const sha12 = shortSha(source.sha);
  const prior = await b.readMeta(sha12);
  const meta = {
    sha: source.sha, title: result.digest.title || source.title, path: source.path, kind: source.kind, words: source.text ? source.text.trim().split(/\s+/).length : 0,
    fileId: source.fileId ?? null, ingestedAt: new Date().toISOString(), model: result.model ?? model ?? null, mock: Boolean(result.mock),
    claims: result.digest.claims.length, maxClaims: result.maxClaims ?? null, dropped: result.dropped, attempts: result.attempts.map((a) => ({ attempt: a.attempt, claims: a.claims, dropped: a.dropped.length, usage: a.usage, ms: a.ms })), totals: result.totals,
    audit: result.audit ?? null,
    review: { status: 'draft' },
    reasoningSummary: result.reasoningSummary ?? null,
    uploadedAt: prior?.uploadedAt ?? null, uploadedBy: prior?.uploadedBy ?? null, fileName: prior?.fileName ?? (source.path ? source.path.split('/').pop() : null),
  };
  await b.writeText(sha12, source.text ?? '');
  await b.writePages(sha12, source.pages ?? []);
  await b.writeDigest(sha12, result.digest);
  await b.writeDecisions(sha12, {});
  // Keep the original document beside the digest so the review console can render it without the original path.
  if (source.pdfBytes) await b.writePdf(sha12, source.pdfBytes);
  else if (source.path && /\.pdf$/i.test(source.path) && !(await b.hasPdf(sha12))) {
    const fs = await import('node:fs');
    if (fs.existsSync(source.path)) await b.writePdf(sha12, fs.readFileSync(source.path));
  }
  const saved = await putMeta(sha12, meta, result.digest);
  return { dir: b.sourceDir ? b.sourceDir(sha12) : `${storeName()}:sources/${sha12}`, meta: saved };
}

/** Record an upload that has not been ingested yet (the cloud API's first step). */
export async function registerUpload({ sha, fileName, kind, bytes, by }) {
  const b = await store();
  const sha12 = shortSha(sha);
  const prior = await b.readMeta(sha12);
  if (prior && (await b.hasDigest(sha12))) return { meta: prior, existed: true };
  await b.writeOriginal(sha12, fileName, bytes);
  const meta = await putMeta(sha12, { ...(prior ?? {}), sha, title: fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), fileName, kind, path: null, uploadedAt: new Date().toISOString(), uploadedBy: by ?? null, status: 'uploaded', review: { status: 'draft' } }, null);
  return { meta, existed: false };
}

/** A source's meta (with lifecycle status) whether or not it has been ingested; null if unknown. */
export async function sourceMeta(sha) {
  const b = await store();
  const sha12 = shortSha(sha);
  const meta = await b.readMeta(sha12);
  if (!meta) return null;
  const digest = await b.readDigest(sha12);
  const derived = digest ? (isStale(digest) ? 'stale' : reviewStatus(meta, digest)) : null;
  const status = meta.status && !['draft', 'approved', 'modified', 'stale'].includes(meta.status) ? meta.status : (derived ?? meta.status ?? 'uploaded');
  return { ...meta, status, ingested: Boolean(digest) };
}

/** The uploaded bytes of a source (for the worker to ingest), or null. */
export async function readOriginal(sha) {
  const b = await store();
  const sha12 = shortSha(sha);
  const meta = await b.readMeta(sha12);
  const bytes = await b.readOriginal(sha12, meta?.fileName ?? meta?.path ?? null);
  return bytes ? { bytes, fileName: meta?.fileName ?? (meta?.path ? meta.path.split('/').pop() : 'source.pdf'), meta } : null;
}

/** Patch a source's meta with a lifecycle status outside the review states (uploaded | ingesting | failed) or an annotation. */
export async function patchSourceMeta(sha, patch) {
  const b = await store();
  const sha12 = shortSha(sha);
  const meta = (await b.readMeta(sha12)) ?? { sha };
  const digest = await b.readDigest(sha12);
  const next = { ...meta, ...patch };
  // A lifecycle status wins while the task runs; once a digest exists and no lifecycle status is given, the review status is derived.
  if (patch.status) { await b.writeMeta(sha12, { ...next, updatedAt: new Date().toISOString() }); return next; }
  return putMeta(sha12, next, digest);
}

/** Per-claim reviewer decisions: { [claimId]: { status, reason, by, at, edit? } }. */
export async function loadDecisions(sha) { return (await store()).readDecisions(shortSha(sha)); }

/** Returns { meta, digest, text, pages, status, stale, hasPdf } or null when the source has not been ingested. */
export async function loadIngest(sha) {
  const b = await store();
  const sha12 = shortSha(sha);
  const digest = await b.readDigest(sha12);
  if (!digest) return null;
  const meta = await b.readMeta(sha12);
  const stale = isStale(digest);
  const [text, pages, hasPdf] = await Promise.all([b.readText(sha12), b.readPages(sha12), b.hasPdf(sha12)]);
  // Claims written before their page was known (older ingests, the recommendations pass) are located on read; nothing is written.
  if (pages.length && Array.isArray(digest.claims)) for (const c of digest.claims) if (c.page == null) c.page = locateSpan(c.span, pages);
  return { dir: b.sourceDir ? b.sourceDir(sha12) : null, meta, digest, text, pages, status: stale ? 'stale' : reviewStatus(meta, digest), stale, hasPdf };
}

/** Replace a stored digest (claim-add, audit apply/restore) and patch its meta; status is recomputed. */
export async function writeDigest(sha, digest, metaPatch = {}) {
  const b = await store();
  const sha12 = shortSha(sha);
  const meta = await b.readMeta(sha12);
  if (!meta) throw new Error(`not ingested: ${sha12}`);
  await b.writeDigest(sha12, digest);
  return putMeta(sha12, { ...meta, ...metaPatch, claims: digest.claims.length }, digest);
}

/**
 * Record one reviewer decision on one claim. `certify` and `reject` record status; `edit` rewrites the
 * claim's statement / type / attribution in the digest (the verbatim span is immutable: provenance) and
 * certifies it as edited. Returns { claim, decision }.
 */
export async function decideClaim(sha, claimId, { action, reason = '', by = '', newStatement, newType, newAttribution } = {}) {
  const b = await store();
  const sha12 = shortSha(sha);
  const ing = await loadIngest(sha);
  if (!ing) throw new Error(`not ingested: ${sha12}`);
  const idx = ing.digest.claims.findIndex((c) => c.id === claimId);
  if (idx === -1) throw new Error(`unknown claim ${claimId}`);
  if (!['certify', 'reject', 'edit'].includes(action)) throw new Error(`action must be certify, reject, or edit (got ${action})`);
  const decisions = await b.readDecisions(sha12);
  const at = new Date().toISOString();
  let claim = ing.digest.claims[idx];
  let decision;
  if (action === 'edit') {
    const before = { statement: claim.statement, type: claim.type, attribution: claim.attribution };
    const after = {
      statement: typeof newStatement === 'string' && newStatement.trim() ? newStatement.trim() : claim.statement,
      type: newType ?? claim.type,
      attribution: newAttribution ?? claim.attribution,
    };
    claim = { ...claim, ...after };
    const digest = { ...ing.digest, claims: ing.digest.claims.map((c, i) => (i === idx ? claim : c)) };
    await writeDigest(sha, digest);
    decision = { status: 'certified', edited: true, edit: { before, after }, reason, by, at };
  } else {
    decision = { status: action === 'certify' ? 'certified' : 'rejected', reason, by, at };
  }
  decisions[claimId] = decision;
  await b.writeDecisions(sha12, decisions);
  return { claim, decision };
}

/**
 * Finalize a reviewer's approval of a digest. Claims listed in `drop` are recorded as rejected; with
 * `certifyPending` every still-pending claim is recorded as certified by `by` (the CLI's whole-digest
 * approval); otherwise any pending claim is an error (the console decides claim by claim first).
 * Rejected claims are removed from the digest (the decisions keep the record) and the approval is bound
 * to the exact remaining content, so any later edit demotes it to 'modified' until approved again.
 */
export async function approveIngest(sha, { drop = [], note = '', by = '', certifyPending = false } = {}) {
  const b = await store();
  const sha12 = shortSha(sha);
  const ing = await loadIngest(sha);
  if (!ing) throw new Error(`not ingested: ${sha12}`);
  const unknown = drop.filter((id) => !ing.digest.claims.some((a) => a.id === id));
  if (unknown.length) throw new Error(`cannot drop unknown claim(s): ${unknown.join(', ')}`);
  const decisions = await b.readDecisions(sha12);
  const at = new Date().toISOString();
  for (const id of drop) decisions[id] = { status: 'rejected', reason: 'dropped at approval', by, at };
  const pending = ing.digest.claims.filter((c) => (decisions[c.id]?.status ?? 'pending') === 'pending');
  if (pending.length) {
    if (!certifyPending) throw new Error(`${pending.length} claim(s) still pending: ${pending.map((c) => c.id).join(', ')}`);
    for (const c of pending) decisions[c.id] = { status: 'certified', reason: 'certified at approval', by, at };
  }
  const rejected = new Set(ing.digest.claims.filter((c) => decisions[c.id]?.status === 'rejected').map((c) => c.id));
  const digest = { ...ing.digest, claims: ing.digest.claims.filter((a) => !rejected.has(a.id)) };
  if (!digest.claims.length) throw new Error('every claim was rejected; nothing to approve');
  const meta = { ...ing.meta, claims: digest.claims.length, review: { status: 'approved', at, by, note, dropped: [...rejected], digestHash: digestHash(digest) } };
  await b.writeDecisions(sha12, decisions);
  await b.writeDigest(sha12, digest);
  const saved = await putMeta(sha12, meta, digest);
  return { dir: ing.dir, meta: saved, digest };
}

/** Return a digest to draft (e.g. after rejecting it) without deleting anything. */
export async function unapproveIngest(sha, note = '') {
  const b = await store();
  const sha12 = shortSha(sha);
  const ing = await loadIngest(sha);
  if (!ing) throw new Error(`not ingested: ${sha12}`);
  const meta = await putMeta(sha12, { ...ing.meta, review: { status: 'draft', at: new Date().toISOString(), note } }, ing.digest);
  return { dir: ing.dir, meta };
}

/** Every source the store knows, newest first, each with its `status` (uploaded | ingesting | draft | approved | modified | stale | failed). */
export async function listSources() {
  const b = await store();
  const metas = await b.listMetas();
  const out = [];
  for (const meta of metas) {
    let status = meta.status;
    if (!status || ['draft', 'approved', 'modified', 'stale'].includes(status)) {
      // Older records carry no status, and a stored one is re-derived from the digest so a hand edit of the files cannot leave it wrong.
      const digest = await b.readDigest(shortSha(meta.sha));
      status = digest ? (isStale(digest) ? 'stale' : reviewStatus(meta, digest)) : (status ?? 'uploaded');
    }
    out.push({ ...meta, status });
  }
  return out.sort((a, b2) => String(b2.ingestedAt ?? b2.uploadedAt ?? '').localeCompare(String(a.ingestedAt ?? a.uploadedAt ?? '')));
}

/** Resolve an argument to a sha: a 6+ hex prefix of a known source, or null. */
export async function resolveSha(arg) {
  if (!/^[0-9a-f]{6,64}$/i.test(String(arg))) return null;
  const hit = (await listSources()).find((s) => s.sha.startsWith(arg.toLowerCase()));
  return hit ? hit.sha : null;
}

export async function readPdf(sha) { return (await store()).readPdf(shortSha(sha)); }

// ── runs and builds ──

export async function saveRun(trace, opts) { return (await store()).saveRun(trace, opts); }

/** The listing row for a build: everything the builds page shows without the record. */
export function buildSummary(build, summarize) {
  const s = summarize(build);
  return {
    id: build.id, status: build.status, createdAt: build.createdAt, finishedAt: build.finishedAt ?? null, model: build.model, source: build.source, n: build.n, deep: build.deep, pathHint: build.pathHint ?? null, paths: build.paths ?? null, pathMode: build.pathMode ?? (build.pathHint ? 'composed' : 'planner'),
    baselines: build.baselines?.length ?? 0, rates: s.rates, totals: build.totals, error: build.error ?? null, by: build.by ?? null, jobId: build.jobId ?? null,
    items: s.rows.map((r) => ({ id: r.id, status: r.status, pass: r.pass, necessity: r.necessity, digestRecall: r.digestRecall, focus: r.focus, path: r.path })),
    progress: build.progress ?? null, rescored: build.rescored?.length ?? 0,
  };
}

/** Save a finished (or failed) build: the record, its item and control traces as runs, and its summary. */
export async function saveBuild(build, summarize) {
  const b = await store();
  for (const it of build.items ?? []) if (it.trace) await b.saveRun(it.trace, { partial: it.status !== 'done' });
  for (const bl of build.baselines ?? []) if (bl.trace) await b.saveRun(bl.trace);
  const where = await b.writeBuildRecord(build);
  const summary = buildSummary(build, summarize);
  await b.writeBuildSummary({ ...summary, record: where });
  return { where, summary };
}

/** Patch a build's summary (status, progress) while it runs. Creates the summary if it does not exist yet. */
export async function updateBuildSummary(id, patch) {
  const b = await store();
  const cur = (await b.readBuildSummary(id)) ?? { id };
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await b.writeBuildSummary(next);
  return next;
}

export async function loadBuild(id) {
  if (!/^build-[a-z0-9-]+$/i.test(String(id))) return null;
  return (await store()).readBuildRecord(id);
}

/** Summaries of every build, newest first; records without a summary (older filesystem builds) are summarized on the fly. */
export async function listBuilds(summarize) {
  const b = await store();
  const summaries = await b.listBuildSummaries();
  const have = new Set(summaries.map((s) => s.id));
  for (const id of await b.listBuildIds()) {
    if (have.has(id)) continue;
    const rec = await b.readBuildRecord(id);
    if (rec) summaries.push(buildSummary(rec, summarize));
  }
  return summaries.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
}

export async function appendBuildEvent(id, event) { return (await store()).appendBuildEvent(id, { at: new Date().toISOString(), ...event }); }

// ── item review ──

export const ITEM_ACTIONS = ['certify', 'reject', 'clear'];

/** Reviewer decisions on a build's items: { [itemId]: { status: certified | rejected, reason, by, at } }. */
export async function loadBuildDecisions(id) { return (await store()).readBuildDecisions(id); }

export function itemReviewCounts(build, decisions) {
  const counts = { pending: 0, certified: 0, rejected: 0, total: 0 };
  for (const it of build.items ?? []) { if (it.status !== 'done') continue; counts.total++; counts[decisions[it.plan.id]?.status ?? 'pending']++; }
  return counts;
}

/** Record a decision on one built item and keep the build summary's review counts current. */
export async function decideItem(buildId, itemId, { action, reason = '', by = '' } = {}) {
  const b = await store();
  if (!ITEM_ACTIONS.includes(action)) throw new Error(`action must be certify, reject, or clear (got ${action})`);
  const build = await loadBuild(buildId);
  if (!build) throw new Error(`unknown build ${buildId}`);
  const item = build.items.find((it) => it.plan.id === itemId);
  if (!item) throw new Error(`unknown item ${itemId}`);
  if (item.status !== 'done') throw new Error(`item ${itemId} was not built (${item.status})`);
  const decisions = await b.readBuildDecisions(buildId);
  if (action === 'clear') delete decisions[itemId];
  else decisions[itemId] = { status: action === 'certify' ? 'certified' : 'rejected', reason, by, at: new Date().toISOString() };
  await b.writeBuildDecisions(buildId, decisions);
  const review = itemReviewCounts(build, decisions);
  await updateBuildSummary(buildId, { review });
  return { decision: decisions[itemId] ?? { status: 'pending' }, review };
}

/** A built item in the shape an item bank wants: text, lettered options with the step each distractor fails at, explanation, provenance. */
export function exportItem(build, rec, decision) {
  const item = rec.trace.item;
  const v = rec.verification;
  return {
    id: `${build.id}/${rec.plan.id}`, build: build.id, item: rec.plan.id,
    source: { title: build.source?.title ?? null, sha: build.source?.sha ?? null, claims: rec.plan.claims ?? [] },
    focus: rec.plan.focus, path: rec.plan.path, model: build.model,
    stem: item.stem, leadIn: item.leadIn,
    options: item.options.map((o) => ({ letter: o.id, text: o.text, key: Boolean(o.isKey), failsAt: o.failsAt === 'none' ? null : o.failsAt, rationale: o.failureRationale ?? null })),
    key: item.key,
    explanation: item.explanation ?? null,
    verification: v ? { passed: v.summary.passed, applicable: v.summary.applicable, pass: v.summary.pass, necessity: v.pathNecessity?.determinedAt ?? null, pathLength: v.pathNecessity?.pathLength ?? null, digestRecall: v.digestRecall?.skipped ? null : v.digestRecall?.pass ?? null, sourceRecall: v.sourceRecall?.skipped ? null : v.sourceRecall?.pass ?? null, cover: v.coverTheOptions?.pass ?? null, keyBlocked: v.distractorMapping ? `${v.distractorMapping.keyBlocked}/${v.distractorMapping.total}` : null } : null,
    decision: decision ?? { status: 'pending' },
    builtAt: rec.trace.createdAt ?? build.createdAt, by: build.by ?? null,
  };
}

/** Items of one build (status: certified | rejected | pending | all). */
export async function exportBuild(buildId, { status = 'certified' } = {}) {
  const build = await loadBuild(buildId);
  if (!build) throw new Error(`unknown build ${buildId}`);
  const decisions = await loadBuildDecisions(buildId);
  return build.items.filter((it) => it.status === 'done').map((it) => exportItem(build, it, decisions[it.plan.id])).filter((x) => status === 'all' || x.decision.status === status);
}

/** Items across every build (the item bank). */
export async function exportAll(summarize, { status = 'certified' } = {}) {
  const out = [];
  for (const s of await listBuilds(summarize)) {
    if (status === 'certified' && !(s.review?.certified > 0)) continue;
    if (!['done', 'partial'].includes(s.status)) continue;
    try { out.push(...(await exportBuild(s.id, { status }))); } catch { /* a summary without a record */ }
  }
  return out;
}
export async function listBuildEvents(id, opts) { return (await store()).readBuildEvents(id, opts); }

// ── Files API cache (PDF uploads to the model provider) ──
export async function readFileCache() { return (await store()).readFileCache(); }
export async function writeFileCache(c) { return (await store()).writeFileCache(c); }

// ── jobs ──
export async function createJob({ kind, params, by }) {
  const b = await store();
  const id = `job-${Date.now().toString(36)}-${createHash('sha256').update(`${kind}${JSON.stringify(params)}${Math.random()}`).digest('hex').slice(0, 6)}`;
  const job = { id, kind, params, by: by ?? null, status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, execution: null, result: null };
  await b.writeJob(job);
  return job;
}
export async function updateJob(id, patch) {
  const b = await store();
  const cur = await b.readJob(id);
  if (!cur) throw new Error(`unknown job ${id}`);
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await b.writeJob(next);
  return next;
}
export async function getJob(id) { return (await store()).readJob(id); }
export async function listJobs(limit) { return (await store()).listJobs(limit); }

// ── allowlist ──
export async function allowlistEntry(email) { return email ? (await store()).readAllowlist(email) : null; }
export async function allowEmail(email, entry = {}) { return (await store()).writeAllowlist(email, { role: 'reviewer', ...entry }); }
