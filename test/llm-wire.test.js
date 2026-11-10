// The real Anthropic SDK against a local server that speaks the Messages API stream: proves the request that leaves
// complete() (path, headers, body) and that the streamed usage, thinking and stop reason come back as the client expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { complete, part, _setClientForTests } from '../core/llm.js';

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const streamFor = ({ text, thinking = '', stop = 'end_turn', usage = {} }) => sse([
  { type: 'message_start', message: { id: 'msg_wire', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 1 } } },
  ...(thinking ? [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
  ] : []),
  { type: 'content_block_start', index: thinking ? 1 : 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: thinking ? 1 : 0, delta: { type: 'text_delta', text: text.slice(0, 5) } },
  { type: 'content_block_delta', index: thinking ? 1 : 0, delta: { type: 'text_delta', text: text.slice(5) } },
  { type: 'content_block_stop', index: thinking ? 1 : 0 },
  { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 30, output_tokens_details: { thinking_tokens: 12 }, ...usage } },
  { type: 'message_stop' },
]);

async function withServer(handler, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { const rec = { url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null }; seen.push(rec); handler(rec, res, seen.length); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  Object.assign(process.env, { MOCK_LLM: '0', MODEL_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, LLM_MAX_RETRIES: '0' });
  _setClientForTests(null);
  try { await fn(seen); } finally {
    _setClientForTests(null);
    for (const k of ['MOCK_LLM', 'MODEL_API_KEY', 'ANTHROPIC_BASE_URL', 'LLM_MAX_RETRIES']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await new Promise((r) => server.close(r));
  }
}

const sendStream = (res, body) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body); };
const schema = { type: 'object', properties: { a: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['a', 'n'], additionalProperties: false };

test('wire: complete() streams one POST /v1/messages and maps text, thinking and usage (cache reads, cache writes, thinking tokens)', async () => {
  await withServer((rec, res) => sendStream(res, streamFor({ text: '{"a":"ok","n":2}', thinking: 'thought about it' })), async (seen) => {
    const r = await complete({
      instructions: 'SYS', parts: [part.pdfBase64(Buffer.from('%PDF-1.4'), 'p.pdf', { cache: true }), part.text('go')], schema, schemaName: 'out',
      effort: 'low', summary: 'auto', model: 'claude-sonnet-5-5', maxOutputTokens: 32768, label: 'wire',
    });
    assert.deepEqual(r.json, { a: 'ok', n: 2 });
    assert.deepEqual(r.usage, { input_tokens: 105, output_tokens: 30, cached_tokens: 80, cache_write_tokens: 5, reasoning_tokens: 12 });
    assert.equal(r.reasoningSummary, 'thought about it');
    assert.equal(r.model, 'claude-sonnet-5-5');
    assert.equal(seen.length, 1);
    const { url, headers, body } = seen[0];
    assert.match(url, /^\/v1\/messages/);
    assert.equal(headers.authorization, 'Bearer test-key');
    assert.ok(headers['anthropic-version']);
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 32768, 'above the SDK non-streaming limit, which is why calls stream');
    assert.equal(body.system, 'SYS');
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.output_config.format.schema.properties.n.minimum, undefined, 'unsupported constraint is not sent');
    assert.match(body.output_config.format.schema.properties.n.description, /minimum 1; maximum 5/);
    assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.equal(body.messages[0].content[0].type, 'document');
    assert.equal(body.messages[0].content[1].cache_control, undefined);
  });
});

test('wire: a max_tokens stop is retried once at double the limit; a refusal stop is an error', async () => {
  await withServer((rec, res, n) => sendStream(res, n === 1 ? streamFor({ text: '{"a":"cu', stop: 'max_tokens' }) : streamFor({ text: '{"a":"ok","n":1}' })), async (seen) => {
    const w = console.warn; console.warn = () => {};
    try {
      const r = await complete({ parts: [part.text('x')], schema, model: 'claude-sonnet-5-5', maxOutputTokens: 4096, label: 'wire' });
      assert.deepEqual(r.json, { a: 'ok', n: 1 });
      assert.deepEqual(seen.map((s) => s.body.max_tokens), [4096, 8192]);
    } finally { console.warn = w; }
  });
  await withServer((rec, res) => sendStream(res, streamFor({ text: 'no', stop: 'refusal' })), async () => {
    await assert.rejects(() => complete({ parts: [part.text('x')], schema, model: 'claude-sonnet-5-5', label: 'wire' }), /refused/);
  });
});

test('wire: an API error surfaces its status and message', async () => {
  await withServer((rec, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex for compilation.' } })); }, async () => {
    await assert.rejects(() => complete({ parts: [part.text('x')], schema, model: 'claude-sonnet-5-5' }), (e) => e.status === 400 && /too complex/.test(e.message));
  });
});
