/**
 * Claude client (Anthropic Messages API) with a deterministic mock mode.
 * Docs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs · /adaptive-thinking · /pdf-support · /prompt-caching
 *
 * complete({ instructions, parts, schema, schemaName, effort, model, maxOutputTokens, summary, cacheTtl, mock, label })
 *   → { json, text, usage, reasoningSummary, ms, mock, requestId, model, notes, rawUsage }
 *
 * Mapping from the call to the request:
 *   instructions → system                    parts → one user message of text and document (PDF) blocks
 *   schema       → output_config.format      effort → output_config.effort (low … max)
 *   summary      → thinking {adaptive, display: summarized}; without it thinking text is omitted by default on Claude 5 models
 *   cache        → a part built with { cache: true } ends the cached prefix (cache_control on that block)
 *
 * Caching: the prefix is built tools → system → messages and must match exactly up to the breakpoint, so callers put
 * the stable material first (shared `instructions`, then the source parts, the last one marked { cache: true }) and
 * the per-call text last. Changing the schema or the effort may invalidate the prefix; `cogpath probe-cache` measures it.
 * `usage.input_tokens` is the total input (uncached + cache reads + cache writes); `cached_tokens` is the cache-read share.
 *
 * Calls stream and return the final message: the SDK refuses non-streaming requests above ~21k max_tokens, and a
 * stream keeps long adaptive-thinking calls from idling out.
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { toClaudeSchema, canonicalizeEnums } from './schema.js';

export const DEFAULT_MODEL = process.env.COGPATH_MODEL || 'claude-sonnet-5-5';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** max_tokens covers thinking and the answer together; a 4k ceiling truncates any high-effort structured answer. */
export const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.LLM_MAX_OUTPUT_TOKENS) || 16384;
export const MAX_OUTPUT_TOKENS_CAP = Number(process.env.LLM_MAX_OUTPUT_TOKENS_CAP) || 64000;
export const CACHE_TTLS = ['5m', '1h', 'none'];
export const DEFAULT_CACHE_TTL = process.env.LLM_CACHE_TTL || '5m';
const MAX_BREAKPOINTS = 4;

export class TruncationError extends Error {
  constructor(limit, usage) { super(`Output truncated at max_tokens=${limit} (output ${usage?.output_tokens ?? '?'} tokens, of which reasoning ${usage?.output_tokens_details?.thinking_tokens ?? '?'})`); this.name = 'TruncationError'; this.limit = limit; }
}
/** stop_reason "refusal": the output may not match the schema and is not parsed. */
export class RefusalError extends Error {
  constructor(label) { super(`The model refused the request${label ? ` (${label})` : ''}; the output was not parsed`); this.name = 'RefusalError'; }
}

let client = null;
export function getClient() {
  if (!client) {
    const apiKey = process.env.MODEL_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('MODEL_API_KEY (an Anthropic API key) is not set. Put it in cogpath/.env (see .env.example) or run with MOCK_LLM=1.');
    client = new Anthropic({
      apiKey,
      timeout: Number(process.env.LLM_TIMEOUT_MS) || 10 * 60 * 1000,
      maxRetries: process.env.LLM_MAX_RETRIES !== undefined ? Number(process.env.LLM_MAX_RETRIES) : 2,
    });
  }
  return client;
}
export function _setClientForTests(fake) { client = fake; }

export function isMock() { return process.env.MOCK_LLM === '1' || process.env.MOCK_LLM === 'true'; }

// ─── Completions ────────────────────────────────────────────

const toBlock = ({ cache, ...block }, ttl) => (cache && ttl !== 'none'
  ? { ...block, cache_control: ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' } }
  : block);

/** Build the Messages API request body. Exported for tests. `schemaName` is kept for call-site labels; the API takes no name. */
export function buildRequest({ instructions, parts, schema, effort, model, maxOutputTokens, summary, cacheTtl }) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('parts must be a non-empty array of content parts');
  if (effort && !EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
  const ttl = cacheTtl ?? DEFAULT_CACHE_TTL;
  if (!CACHE_TTLS.includes(ttl)) throw new Error(`cacheTtl must be one of ${CACHE_TTLS.join(', ')}`);
  parts.forEach((p, i) => { if (p.type === 'text' && !String(p.text ?? '').trim()) throw new Error(`parts[${i}] is an empty text block; the API rejects those`); });
  const content = parts.map((p) => toBlock(p, ttl));
  if (content.filter((b) => b.cache_control).length > MAX_BREAKPOINTS) throw new Error(`at most ${MAX_BREAKPOINTS} parts can carry { cache: true }`);
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content }],
  };
  if (instructions) body.system = instructions;
  if (summary) body.thinking = { type: 'adaptive', display: 'summarized' };
  const outputConfig = {};
  if (effort) outputConfig.effort = effort;
  if (schema) outputConfig.format = { type: 'json_schema', schema: toClaudeSchema(schema) };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  return body;
}

const send = (body) => getClient().messages.stream(body).finalMessage();

export async function complete(req) {
  const t0 = Date.now();
  const body = buildRequest(req);
  if (isMock()) {
    if (typeof req.mock !== 'function') throw new Error(`MOCK_LLM is on but no mock() was supplied for '${req.label ?? 'call'}'`);
    await new Promise((r) => setTimeout(r, 40));
    const json = req.schema ? req.mock() : null;
    const text = json ? JSON.stringify(json) : String(req.mock());
    const inTok = Math.ceil(JSON.stringify(body).length / 4);
    return { json, text, usage: { input_tokens: inTok, output_tokens: Math.ceil(text.length / 4), cached_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 }, reasoningSummary: '[MOCK] no reasoning', ms: Date.now() - t0, mock: true, requestId: null, model: body.model, notes: [] };
  }
  const notes = [];
  let msg = await send(body);
  if (msg.stop_reason === 'refusal') throw new RefusalError(req.label);
  // Truncation is checked BEFORE parsing so the real cause is reported, and retried once at double the limit.
  if (msg.stop_reason === 'max_tokens') {
    const bigger = Math.min(MAX_OUTPUT_TOKENS_CAP, body.max_tokens * 2);
    if (req.retryOnTruncation === false || bigger <= body.max_tokens) throw new TruncationError(body.max_tokens, msg.usage);
    console.warn(`[${req.label ?? 'llm'}] truncated at max_tokens=${body.max_tokens} (reasoning ${msg.usage?.output_tokens_details?.thinking_tokens ?? '?'} tokens); retrying at ${bigger}`);
    notes.push(`retried at max_tokens=${bigger} after truncation at ${body.max_tokens}`);
    body.max_tokens = bigger;
    msg = await send(body);
    if (msg.stop_reason === 'refusal') throw new RefusalError(req.label);
    if (msg.stop_reason === 'max_tokens') throw new TruncationError(bigger, msg.usage);
  }
  if (msg.stop_reason === 'model_context_window_exceeded') throw new Error(`The request exceeded the model's context window (${req.label ?? 'call'}); use a smaller source or --inline-text`);
  const text = extractText(msg);
  let json = null;
  if (req.schema) {
    try { json = canonicalizeEnums(JSON.parse(text), req.schema); }
    catch (err) { throw new Error(`Model returned non-JSON despite json_schema format (${err.message}; stop_reason=${msg.stop_reason ?? '?'}): ${text.slice(0, 200)}`); }
  }
  const u = msg.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    notes,
    json,
    text,
    usage: {
      input_tokens: (u.input_tokens ?? 0) + cacheRead + cacheWrite,
      output_tokens: u.output_tokens ?? 0,
      cached_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      reasoning_tokens: u.output_tokens_details?.thinking_tokens ?? 0,
    },
    rawUsage: msg.usage ?? null,
    reasoningSummary: extractThinking(msg),
    ms: Date.now() - t0,
    mock: false,
    requestId: msg._request_id ?? msg.id ?? null,
    model: msg.model ?? body.model,
  };
}

const extractText = (msg) => (msg.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
const extractThinking = (msg) => (msg.content ?? []).filter((b) => b.type === 'thinking' && b.thinking).map((b) => b.thinking).join('\n\n');

/** Content-part helpers. `{ cache: true }` ends the cached prefix at this part. */
export const part = {
  text: (text, { cache = false } = {}) => ({ type: 'text', text, ...(cache ? { cache: true } : {}) }),
  pdfBase64: (bytes, title = 'document.pdf', { cache = false } = {}) => ({
    type: 'document', title, source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') }, ...(cache ? { cache: true } : {}),
  }),
};
