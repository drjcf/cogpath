/**
 * GCP backend for the store: Firestore (a named database, default `cogpath`) for metadata, digests, decisions,
 * build summaries, progress events, jobs and the allowlist; Cloud Storage for anything large or binary (PDFs,
 * extracted text and pages, full build records, run traces). Build records are over Firestore's 1 MiB document
 * limit, which is why they are blobs with a summary document beside them.
 *
 * Environment: GOOGLE_CLOUD_PROJECT (set on Cloud Run), COGPATH_FIRESTORE_DB (default cogpath), COGPATH_BUCKET,
 * COGPATH_BLOBS=fs to keep blobs under COGPATH_DATA/blobs (tests, local development against the emulator).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Firestore } from '@google-cloud/firestore';

let db = null;
function fsdb() {
  if (!db) db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || undefined, databaseId: process.env.COGPATH_FIRESTORE_DB || 'cogpath', ignoreUndefinedProperties: true });
  return db;
}

// ── blobs: Cloud Storage, or a local directory ──
let bucket = null;
async function gcsBucket() {
  if (!bucket) {
    const { Storage } = await import('@google-cloud/storage');
    const name = process.env.COGPATH_BUCKET;
    if (!name) throw new Error('COGPATH_BUCKET is not set');
    bucket = new Storage().bucket(name);
  }
  return bucket;
}
const localBlobs = () => process.env.COGPATH_BLOBS === 'fs';
const localBlobPath = (key) => path.join(path.resolve(process.env.COGPATH_DATA || 'runs'), 'blobs', key);

export async function putBlob(key, data, contentType = 'application/octet-stream') {
  if (localBlobs()) { const f = localBlobPath(key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return `file://${f}`; }
  const b = await gcsBucket();
  await b.file(key).save(data, { contentType, resumable: false });
  return `gs://${b.name}/${key}`;
}
export async function getBlob(key) {
  if (localBlobs()) { try { return fs.readFileSync(localBlobPath(key)); } catch { return null; } }
  const b = await gcsBucket();
  try { const [data] = await b.file(key).download(); return data; } catch (e) { if (e.code === 404) return null; throw e; }
}
export async function hasBlob(key) {
  if (localBlobs()) return fs.existsSync(localBlobPath(key));
  const b = await gcsBucket();
  const [exists] = await b.file(key).exists();
  return exists;
}
export async function listBlobs(prefix) {
  if (localBlobs()) { const dir = localBlobPath(prefix); return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => `${prefix}${f}`) : []; }
  const b = await gcsBucket();
  const [files] = await b.getFiles({ prefix });
  return files.map((f) => f.name);
}

const json = (buf) => (buf ? JSON.parse(buf.toString('utf8')) : null);
const docData = async (ref) => { const s = await ref.get(); return s.exists ? s.data() : null; };

// ── sources ──
const srcRef = (sha12) => fsdb().doc(`sources/${sha12}`);
export const readMeta = async (sha12) => docData(srcRef(sha12));
export const writeMeta = async (sha12, meta) => { await srcRef(sha12).set(meta); };
export const readDigest = async (sha12) => (await docData(fsdb().doc(`sources/${sha12}/data/digest`)))?.digest ?? null;
export const writeDigest = async (sha12, digest) => { await fsdb().doc(`sources/${sha12}/data/digest`).set({ digest, updatedAt: new Date().toISOString() }); };
export const hasDigest = async (sha12) => (await fsdb().doc(`sources/${sha12}/data/digest`).get()).exists;
export const readDecisions = async (sha12) => (await docData(fsdb().doc(`sources/${sha12}/data/decisions`)))?.decisions ?? {};
export const writeDecisions = async (sha12, decisions) => { await fsdb().doc(`sources/${sha12}/data/decisions`).set({ decisions, updatedAt: new Date().toISOString() }); };
export const readText = async (sha12) => (await getBlob(`sources/${sha12}/text.txt`))?.toString('utf8') ?? '';
export const writeText = async (sha12, text) => { await putBlob(`sources/${sha12}/text.txt`, text ?? '', 'text/plain; charset=utf-8'); };
export const readPages = async (sha12) => json(await getBlob(`sources/${sha12}/pages.json`)) ?? [];
export const writePages = async (sha12, pages) => { await putBlob(`sources/${sha12}/pages.json`, JSON.stringify(pages ?? []), 'application/json'); };
export const hasPdf = async (sha12) => hasBlob(`sources/${sha12}/source.pdf`);
export const readPdf = async (sha12) => getBlob(`sources/${sha12}/source.pdf`);
export const writePdf = async (sha12, bytes) => { await putBlob(`sources/${sha12}/source.pdf`, bytes, 'application/pdf'); };
export async function writeOriginal(sha12, fileName, bytes) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.pdf') return writePdf(sha12, bytes);
  await putBlob(`sources/${sha12}/original${ext || '.txt'}`, bytes, 'text/plain; charset=utf-8');
}
export async function readOriginal(sha12, fileName) {
  const ext = path.extname(fileName ?? '').toLowerCase();
  if (ext === '.pdf' || !fileName) return readPdf(sha12);
  return getBlob(`sources/${sha12}/original${ext || '.txt'}`);
}
export async function listMetas() {
  const snap = await fsdb().collection('sources').get();
  return snap.docs.map((d) => d.data());
}

// ── runs and builds ──
export async function saveRun(trace, { partial = false } = {}) {
  return putBlob(`runs/${trace.id}${partial ? '.partial' : ''}.json`, JSON.stringify(trace), 'application/json');
}
export const writeBuildRecord = async (build) => putBlob(`builds/${build.id}.json`, JSON.stringify(build), 'application/json');
export const readBuildRecord = async (id) => json(await getBlob(`builds/${id}.json`));
const buildRef = (id) => fsdb().doc(`builds/${id}`);
export const writeBuildSummary = async (summary) => { await buildRef(summary.id).set(summary); };
export const readBuildSummary = async (id) => docData(buildRef(id));
export async function listBuildSummaries() {
  const snap = await fsdb().collection('builds').get();
  return snap.docs.map((d) => d.data());
}
export async function listBuildIds() { return (await listBlobs('builds/')).filter((k) => /^builds\/build-[a-z0-9-]+\.json$/i.test(k)).map((k) => k.slice('builds/'.length, -'.json'.length)); }
let eventSeq = 0;
export async function appendBuildEvent(id, event) {
  const seq = `${String(Date.now()).padStart(14, '0')}-${String(eventSeq++ % 10000).padStart(4, '0')}`;
  await buildRef(id).collection('events').doc(seq).set({ seq, ...event });
}
export async function readBuildEvents(id, { after = '', limit = 500 } = {}) {
  // A build emits a few hundred events at most; filtering in memory keeps the query a plain ordered scan.
  const snap = await buildRef(id).collection('events').orderBy('__name__').limit(2000).get();
  const all = snap.docs.map((d) => d.data());
  return (after ? all.filter((e) => e.seq > after) : all).slice(0, limit);
}

// ── Files API cache ──
export const readFileCache = async () => (await docData(fsdb().doc('meta/files')))?.cache ?? {};
export const writeFileCache = async (cache) => { await fsdb().doc('meta/files').set({ cache }); };

// ── jobs ──
const jobRef = (id) => fsdb().doc(`jobs/${id}`);
export const writeJob = async (job) => { await jobRef(job.id).set(job); };
export const readJob = async (id) => docData(jobRef(id));
export async function listJobs(limit = 50) {
  const snap = await fsdb().collection('jobs').orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((d) => d.data());
}

// ── allowlist ──
const emailKey = (email) => String(email).trim().toLowerCase();
export async function readAllowlist(email) {
  const env = String(process.env.COGPATH_ALLOWLIST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (env.includes(emailKey(email))) return { email: emailKey(email), role: 'admin', source: 'env' };
  const d = await docData(fsdb().doc(`allowlist/${emailKey(email)}`));
  return d ? { email: emailKey(email), ...d, source: 'firestore' } : null;
}
export const writeAllowlist = async (email, entry) => { await fsdb().doc(`allowlist/${emailKey(email)}`).set({ ...entry, addedAt: entry.addedAt ?? new Date().toISOString() }); };

/** For tests and shutdown. */
export async function close() { if (db) { await db.terminate(); db = null; } }
