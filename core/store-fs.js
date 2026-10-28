/**
 * Filesystem backend for the store: <COGPATH_DATA>/sources/<sha12>/{source.json,text.txt,pages.json,digest.json,
 * decisions.json,source.pdf}, runs/<traceId>.json, builds/<id>.json (+ .status.json, .events.json), jobs/<id>.json,
 * .files.json. The CLI, the tests and local development use this backend; the cloud uses store-gcp.js.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = () => path.resolve(process.env.COGPATH_DATA || 'runs');
export const sourceDir = (sha12) => path.join(DATA_DIR(), 'sources', sha12);
const buildsDir = () => path.join(DATA_DIR(), 'builds');
const jobsDir = () => path.join(DATA_DIR(), 'jobs');

const readJson = (f, dflt = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const sf = (sha12, name) => path.join(sourceDir(sha12), name);

export const readMeta = async (sha12) => readJson(sf(sha12, 'source.json'));
export const writeMeta = async (sha12, meta) => writeJson(sf(sha12, 'source.json'), meta);
export const readDigest = async (sha12) => readJson(sf(sha12, 'digest.json'));
export const writeDigest = async (sha12, digest) => writeJson(sf(sha12, 'digest.json'), digest);
export const readDecisions = async (sha12) => readJson(sf(sha12, 'decisions.json'), {});
export const writeDecisions = async (sha12, d) => writeJson(sf(sha12, 'decisions.json'), d);
export const readText = async (sha12) => { try { return fs.readFileSync(sf(sha12, 'text.txt'), 'utf8'); } catch { return ''; } };
export const writeText = async (sha12, text) => { fs.mkdirSync(sourceDir(sha12), { recursive: true }); fs.writeFileSync(sf(sha12, 'text.txt'), text ?? ''); };
export const readPages = async (sha12) => readJson(sf(sha12, 'pages.json'), []);
export const writePages = async (sha12, pages) => { fs.mkdirSync(sourceDir(sha12), { recursive: true }); fs.writeFileSync(sf(sha12, 'pages.json'), JSON.stringify(pages ?? [])); };
export const hasPdf = async (sha12) => fs.existsSync(sf(sha12, 'source.pdf'));
export const readPdf = async (sha12) => { try { return fs.readFileSync(sf(sha12, 'source.pdf')); } catch { return null; } };
export const writePdf = async (sha12, bytes) => { fs.mkdirSync(sourceDir(sha12), { recursive: true }); fs.writeFileSync(sf(sha12, 'source.pdf'), bytes); };
export const hasDigest = async (sha12) => fs.existsSync(sf(sha12, 'digest.json'));
/** The uploaded file as received: PDFs as source.pdf (the review console renders it), anything else as original.<ext>. */
export async function writeOriginal(sha12, fileName, bytes) {
  const ext = path.extname(fileName).toLowerCase();
  const name = ext === '.pdf' ? 'source.pdf' : `original${ext || '.txt'}`;
  fs.mkdirSync(sourceDir(sha12), { recursive: true });
  fs.writeFileSync(sf(sha12, name), bytes);
}
export async function readOriginal(sha12, fileName) {
  const ext = path.extname(fileName ?? '').toLowerCase();
  const name = ext === '.pdf' || !fileName ? 'source.pdf' : `original${ext || '.txt'}`;
  try { return fs.readFileSync(sf(sha12, name)); } catch { return null; }
}

export async function listMetas() {
  const root = path.join(DATA_DIR(), 'sources');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((d) => readJson(path.join(root, d, 'source.json'))).filter(Boolean);
}

// ── runs and builds ──
export async function saveRun(trace, { partial = false } = {}) {
  const f = path.join(DATA_DIR(), `${trace.id}${partial ? '.partial' : ''}.json`);
  writeJson(f, trace);
  return f;
}
export const writeBuildRecord = async (build) => { const f = path.join(buildsDir(), `${build.id}.json`); writeJson(f, build); return f; };
export const readBuildRecord = async (id) => readJson(path.join(buildsDir(), `${id}.json`));
export const writeBuildSummary = async (summary) => writeJson(path.join(buildsDir(), `${summary.id}.status.json`), summary);
export const readBuildSummary = async (id) => readJson(path.join(buildsDir(), `${id}.status.json`));
export async function listBuildSummaries() {
  const dir = buildsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.status.json')).map((f) => readJson(path.join(dir, f))).filter(Boolean);
}
export async function listBuildIds() {
  const dir = buildsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^build-[a-z0-9-]+\.json$/i.test(f)).map((f) => f.replace(/\.json$/, ''));
}
export const readBuildDecisions = async (id) => readJson(path.join(buildsDir(), `${id}.decisions.json`), {});
export const writeBuildDecisions = async (id, d) => writeJson(path.join(buildsDir(), `${id}.decisions.json`), d);
export async function appendBuildEvent(id, event) {
  const f = path.join(buildsDir(), `${id}.events.json`);
  const events = readJson(f, []);
  events.push({ seq: `${String(Date.now()).padStart(14, '0')}-${String(events.length % 10000).padStart(4, '0')}`, ...event });
  writeJson(f, events);
}
export async function readBuildEvents(id, { after = '', limit = 500 } = {}) {
  const all = readJson(path.join(buildsDir(), `${id}.events.json`), []);
  return (after ? all.filter((e) => e.seq > after) : all).slice(0, limit);
}

// ── Files API cache ──
export const readFileCache = async () => readJson(path.join(DATA_DIR(), '.files.json'), {});
export const writeFileCache = async (c) => writeJson(path.join(DATA_DIR(), '.files.json'), c);

// ── jobs ──
export const writeJob = async (job) => writeJson(path.join(jobsDir(), `${job.id}.json`), job);
export const readJob = async (id) => readJson(path.join(jobsDir(), `${id}.json`));
export async function listJobs(limit = 50) {
  const dir = jobsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f))).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
}

// ── allowlist (local: the environment) ──
export async function readAllowlist(email) {
  const list = String(process.env.COGPATH_ALLOWLIST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(email).toLowerCase()) ? { email, role: 'reviewer', source: 'env' } : null;
}
export const writeAllowlist = async () => { throw new Error('the filesystem backend reads its allowlist from COGPATH_ALLOWLIST'); };
