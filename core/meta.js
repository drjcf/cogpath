/**
 * Meta Model API client (Responses protocol via the OpenAI SDK) with a deterministic mock mode.
 * Docs: https://dev.meta.ai/docs/quickstart · /structured-output · /reasoning · /file-handling · /prompt-caching
 *
 * complete({ instructions, parts, schema, schemaName, effort, model, maxOutputTokens, mock, label })
 *   → { json, text, usage, reasoningSummary, ms, mock, requestId, model }
 *
 * Caching: the Responses API caches a shared prefix automatically, but requests are only routed to the backend
 * holding that prefix when they share a `prompt_cache_key` (dev.meta.ai/docs/prompt-caching). Callers put the
 * stable material first (shared `instructions`, then the source file/text), the per-call instruction last, and
 * pass `cacheKey` (one per source). `prompt_cache_retention` defaults to "24h" (META_CACHE_RETENTION=in_memory|none).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';

export const DEFAULT_MODEL = process.env.COGPATH_MODEL || 'muse-spark-1.3';
export const BASE_URL = process.env.META_BASE_URL || 'https://api.meta.ai/v1';
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Reasoning tokens count against max_output_tokens; a 4k ceiling truncates any high-effort structured answer. */
export const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.META_MAX_OUTPUT_TOKENS) || 16384;
export const MAX_OUTPUT_TOKENS_CAP = 65536;
export const CACHE_RETENTIONS = ['in_memory', '24h', 'none'];
export const DEFAULT_CACHE_RETENTION = process.env.META_CACHE_RETENTION || '24h';
let cacheParamsRejected = false; // set if the API ever 400s on the cache params; they are then omitted for the process
export const cacheKeyFor = (text) => `cogpath:${createHash('sha256').update(String(text)).digest('hex').slice(0, 12)}`;

export class TruncationError extends Error {
  constructor(limit, usage) { super(`Output truncated at max_output_tokens=${limit} (output ${usage?.output_tokens ?? '?'} tokens, of which reasoning ${usage?.output_tokens_details?.reasoning_tokens ?? '?'})`); this.name = 'TruncationError'; this.limit = limit; }
}

let client = null;
export function getClient() {
  if (!client) {
    const apiKey = process.env.MODEL_API_KEY;
    if (!apiKey) throw new Error('MODEL_API_KEY is not set. Put it in cogpath/.env (see .env.example) or run with MOCK_META=1.');
    client = new OpenAI({
      apiKey,
      baseURL: BASE_URL,
      timeout: Number(process.env.META_TIMEOUT_MS) || 5 * 60 * 1000,
      maxRetries: process.env.META_MAX_RETRIES !== undefined ? Number(process.env.META_MAX_RETRIES) : 2,
    });
  }
  return client;
}
export function _setClientForTests(fake) { client = fake; }

export function isMock() { return process.env.MOCK_META === '1' || process.env.MOCK_META === 'true'; }

// ─── Files ──────────────────────────────────────────────────

/** Upload a PDF once (purpose user_data); reuse the file id for identical bytes. The id cache lives in the store. */
export async function uploadFile(filePath) {
  const { readFileCache, writeFileCache } = await import('./store.js');
  const bytes = fs.readFileSync(filePath);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const cache = await readFileCache();
  // A mock-mode upload never reaches the API; its fake id must not be reused once a real key is in play.
  if (cache[sha]?.id && Boolean(cache[sha].mock) === isMock()) return { id: cache[sha].id, cached: true, sha };
  if (isMock()) {
    const id = `file-mock${sha.slice(0, 8)}`;
    cache[sha] = { id, name: path.basename(filePath), at: new Date().toISOString(), mock: true };
    await writeFileCache(cache);
    return { id, cached: false, sha, mock: true };
  }
  const uploaded = await getClient().files.create({ file: fs.createReadStream(filePath), purpose: 'user_data' });
  cache[sha] = { id: uploaded.id, name: path.basename(filePath), at: new Date().toISOString() };
  await writeFileCache(cache);
  return { id: uploaded.id, cached: false, sha };
}

// ─── Completions ────────────────────────────────────────────

/** Build the Responses API request body. Exported for tests. */
export function buildRequest({ instructions, parts, schema, schemaName, effort, model, maxOutputTokens, summary, cacheKey, cacheRetention }) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('parts must be a non-empty array of content parts');
  if (effort && !EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
  const retention = cacheRetention ?? DEFAULT_CACHE_RETENTION;
  if (!CACHE_RETENTIONS.includes(retention)) throw new Error(`cacheRetention must be one of ${CACHE_RETENTIONS.join(', ')}`);
  const body = {
    model: model || DEFAULT_MODEL,
    input: [{ type: 'message', role: 'user', content: parts }],
    max_output_tokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (!cacheParamsRejected) {
    if (cacheKey) body.prompt_cache_key = String(cacheKey).slice(0, 64);
    if (retention !== 'none') body.prompt_cache_retention = retention;
  }
  if (instructions) body.instructions = instructions;
  if (effort) body.reasoning = { effort, ...(summary ? { summary } : {}) };
  else if (summary) body.reasoning = { summary };
  if (schema) {
    body.text = { format: { type: 'json_schema', name: schemaName || 'output', schema, strict: true } };
  }
  return body;
}

export async function complete(req) {
  const t0 = Date.now();
  const body = buildRequest(req);
  if (isMock()) {
    if (typeof req.mock !== 'function') throw new Error(`MOCK_META is on but no mock() was supplied for '${req.label ?? 'call'}'`);
    await new Promise((r) => setTimeout(r, 40));
    const json = req.schema ? req.mock() : null;
    const text = json ? JSON.stringify(json) : String(req.mock());
    const inTok = Math.ceil(JSON.stringify(body).length / 4);
    return { json, text, usage: { input_tokens: inTok, output_tokens: Math.ceil(text.length / 4), cached_tokens: 0, reasoning_tokens: 0 }, reasoningSummary: '[MOCK] no reasoning', ms: Date.now() - t0, mock: true, requestId: null, model: body.model };
  }
  let notes = [];
  let res;
  try {
    res = await getClient().responses.create(body);
  } catch (err) {
    // If this API build rejects the cache params, drop them for the rest of the process and retry once.
    const msg = String(err?.message ?? '');
    if (err?.status === 400 && /prompt_cache/i.test(msg) && (body.prompt_cache_key || body.prompt_cache_retention)) {
      cacheParamsRejected = true;
      delete body.prompt_cache_key; delete body.prompt_cache_retention;
      console.warn(`[${req.label ?? 'meta'}] API rejected prompt_cache_* params (${msg.slice(0, 120)}); continuing without them`);
      notes.push('cache params rejected by API; sent without them');
      res = await getClient().responses.create(body);
    } else throw err;
  }
  // Truncation is checked BEFORE parsing so the real cause is reported, and retried once at double the limit.
  if (isTruncated(res)) {
    const bigger = Math.min(MAX_OUTPUT_TOKENS_CAP, body.max_output_tokens * 2);
    if (req.retryOnTruncation === false || bigger <= body.max_output_tokens) throw new TruncationError(body.max_output_tokens, res.usage);
    console.warn(`[${req.label ?? 'meta'}] truncated at max_output_tokens=${body.max_output_tokens} (reasoning ${res.usage?.output_tokens_details?.reasoning_tokens ?? '?'} tokens); retrying at ${bigger}`);
    notes.push(`retried at max_output_tokens=${bigger} after truncation at ${body.max_output_tokens}`);
    body.max_output_tokens = bigger;
    res = await getClient().responses.create(body);
    if (isTruncated(res)) throw new TruncationError(bigger, res.usage);
  }
  const text = extractText(res);
  let json = null;
  if (req.schema) {
    try { json = JSON.parse(text); }
    catch (err) { throw new Error(`Model returned non-JSON despite json_schema format (${err.message}; status=${res.status ?? '?'}): ${text.slice(0, 200)}`); }
  }
  return {
    notes,
    json,
    text,
    usage: {
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
      cached_tokens: res.usage?.input_tokens_details?.cached_tokens ?? res.usage?.prompt_tokens_details?.cached_tokens ?? res.usage?.cached_tokens ?? 0,
      reasoning_tokens: res.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    },
    rawUsage: res.usage ?? null,
    reasoningSummary: extractReasoningSummary(res),
    ms: Date.now() - t0,
    mock: false,
    requestId: res._request_id ?? res.id ?? null,
    model: res.model ?? body.model,
  };
}

function isTruncated(res) {
  return res?.status === 'incomplete' && (res.incomplete_details?.reason ?? '') === 'max_output_tokens';
}

function extractText(res) {
  if (typeof res.output_text === 'string' && res.output_text.length) return res.output_text;
  const parts = [];
  for (const item of res.output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) if (c.type === 'output_text') parts.push(c.text);
  }
  return parts.join('');
}

function extractReasoningSummary(res) {
  const out = [];
  for (const item of res.output ?? []) {
    if (item.type !== 'reasoning') continue;
    for (const s of item.summary ?? []) if (s.text) out.push(s.text);
  }
  return out.join('\n\n');
}

/** Content-part helpers (Responses API). */
export const part = {
  text: (text) => ({ type: 'input_text', text }),
  file: (fileId) => ({ type: 'input_file', file_id: fileId }),
  pdfBase64: (bytes, filename = 'document.pdf') => ({ type: 'input_file', filename, file_data: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}` }),
};
