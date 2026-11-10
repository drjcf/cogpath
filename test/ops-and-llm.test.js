import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPS, ASSEMBLE, schemaOf } from '../core/ops/index.js';
import { optionPlan, letterOptions } from '../core/ops/assemble.js';
import { assertStrict, validate, toClaudeSchema, canonicalizeEnums, obj, str, int, num, arr, enm } from '../core/schema.js';
import { parsePath } from '../core/path.js';
import { buildRequest, complete, _setClientForTests, part, RefusalError, TruncationError } from '../core/llm.js';

const source = { kind: 'text', title: 'T', text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega '.repeat(8), parts: [part.text('SOURCE: …')] };

function ctxFor(path, index, artifacts) {
  const step = path[index];
  return { source, path, step, priorSteps: path.slice(0, index), artifacts };
}

test('every op schema is strict and every mock artifact validates and passes verify()', () => {
  const path = parsePath('recall(3) > analyze(causal, relations=2) > evaluate(a, b, options=3) > synthesize(plan)');
  const artifacts = {};
  for (const [i, step] of path.entries()) {
    const op = OPS[step.op];
    const ctx = ctxFor(path, i, artifacts);
    const schema = schemaOf(op, ctx);
    assert.doesNotThrow(() => assertStrict(schema), `${op.id} schema not strict`);
    const art = op.mock(ctx);
    const v = validate(schema, art);
    assert.ok(v.ok, `${op.id} mock invalid: ${v.errors.join('; ')}`);
    assert.deepEqual(op.verify(art, ctx), [], `${op.id} verify problems`);
    artifacts[step.id] = art;
  }
  const actx = { source, path, step: { id: 'assemble', op: 'assemble', index: path.length, params: {} }, priorSteps: path, artifacts };
  const aschema = schemaOf(ASSEMBLE, actx);
  assert.doesNotThrow(() => assertStrict(aschema));
  const item = ASSEMBLE.mock(actx);
  assert.ok(validate(aschema, item).ok);
  assert.deepEqual(ASSEMBLE.verify(item, actx), []);
});

test('verify() catches broken references and counts', () => {
  const path = parsePath('recall(2) > analyze(contrast, relations=1)');
  const r = OPS.recall.mock(ctxFor(path, 0, {}));
  const ctx = ctxFor(path, 1, { recall: r });
  const bad = { relations: [{ id: 'r1', kind: 'contrast', between: ['c1', 'c9'], claim: 'x', evidenceSpan: 'y', implication: 'z', commonMisreading: 'w' }] };
  const problems = OPS.analyze.verify(bad, ctx);
  assert.ok(problems.some((p) => /unknown concept c9/.test(p)));
  const badRecall = { topic: 't', concepts: [{ id: 'c1', statement: 'The article says X', sourceSpan: 's', claims: [] }] };
  const p2 = OPS.recall.verify(badRecall, ctxFor(path, 0, {}));
  assert.ok(p2.some((p) => /expected 2 concepts/.test(p)));
  assert.ok(p2.some((p) => /refers to the source/.test(p)));
});

test('option plan pads short paths to 4 options and tags every step; lettering is seeded and has one key', () => {
  const short = parsePath('recall > analyze');
  assert.deepEqual(optionPlan(short), { stepIds: ['recall', 'analyze'], distractors: ['recall', 'analyze', 'analyze'], total: 4 });
  const full = parsePath('recall > analyze > evaluate > synthesize');
  assert.equal(optionPlan(full).total, 5);
  const artifacts = {};
  for (const [i, s] of full.entries()) artifacts[s.id] = OPS[s.op].mock(ctxFor(full, i, artifacts));
  const actx = { source, path: full, step: { id: 'assemble', op: 'assemble', index: 4, params: {} }, priorSteps: full, artifacts };
  const raw = ASSEMBLE.mock(actx);
  const a = letterOptions(raw, 42), b = letterOptions(raw, 42), c = letterOptions(raw, 43);
  assert.deepEqual(a.options.map((o) => o.text), b.options.map((o) => o.text));
  assert.notDeepEqual(a.options.map((o) => o.text), c.options.map((o) => o.text));
  assert.equal(a.options.filter((o) => o.isKey).length, 1);
  assert.equal(a.options.find((o) => o.isKey).id, a.key);
  assert.deepEqual(a.options.map((o) => o.id), ['A', 'B', 'C', 'D', 'E']);
  // assembler rejects a key length cue
  const cue = { ...raw, options: raw.options.map((o) => (o.failsAt === 'none' ? { ...o, text: 'a much longer key option '.repeat(8) } : o)) };
  assert.ok(ASSEMBLE.verify(cue, actx).some((p) => /length cue/.test(p)));
  assert.ok(ASSEMBLE.verify(cue, actx).some((p) => /not homogeneous/.test(p)));
});


const flat = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
const fakeMessage = (over = {}) => ({ id: 'msg_1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":"ok"}' }], usage: { input_tokens: 20, output_tokens: 30 }, ...over });
const fakeClient = (fn) => ({ messages: { stream: (body) => ({ finalMessage: async () => fn(body) }) } });
const withReal = async (fn) => { const saved = process.env.MOCK_LLM; process.env.MOCK_LLM = '0'; try { await fn(); } finally { process.env.MOCK_LLM = saved; } };

test('buildRequest produces the Messages API shape: system, document block, cache breakpoint, schema, effort, thinking summary', () => {
  const schema = assertStrict(flat);
  const pdf = part.pdfBase64(Buffer.from('%PDF-1.4 x'), 'paper.pdf', { cache: true });
  const body = buildRequest({ instructions: 'SYS', parts: [pdf, part.text('hi')], schema, schemaName: 'out', effort: 'high', model: 'claude-sonnet-5-5', summary: 'auto', maxOutputTokens: 4096 });
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.system, 'SYS');
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.messages, [{ role: 'user', content: [
    { type: 'document', title: 'paper.pdf', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4 x').toString('base64') }, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'hi' },
  ] }]);
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body.output_config, { effort: 'high', format: { type: 'json_schema', schema: flat } });
  for (const k of ['temperature', 'top_p', 'top_k', 'tools', 'stream']) assert.equal(body[k], undefined, `${k} must not be sent`);
  assert.equal(buildRequest({ parts: [part.text('x')] }).output_config, undefined);
  assert.equal(buildRequest({ parts: [part.text('x')] }).thinking, undefined);
  assert.equal(buildRequest({ parts: [part.text('x')] }).model, 'claude-sonnet-5-5');
});

test('cache breakpoints: ttl 5m by default, 1h on request, none removes them; at most four; empty text rejected', () => {
  const parts = [part.text('stable prefix', { cache: true }), part.text('per call')];
  assert.deepEqual(buildRequest({ parts }).messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(buildRequest({ parts, cacheTtl: '1h' }).messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(buildRequest({ parts, cacheTtl: 'none' }).messages[0].content[0].cache_control, undefined);
  assert.equal(buildRequest({ parts }).messages[0].content[0].cache, undefined, 'the internal marker is not sent');
  assert.equal(buildRequest({ parts }).messages[0].content[1].cache_control, undefined);
  assert.throws(() => buildRequest({ parts, cacheTtl: '24h' }), /cacheTtl must be one of/);
  assert.throws(() => buildRequest({ parts: Array.from({ length: 5 }, (_, i) => part.text(`p${i}`, { cache: true })) }), /at most 4/);
  assert.throws(() => buildRequest({ parts: [part.text('  ')] }), /empty text block/);
  assert.throws(() => buildRequest({ parts: [part.text('x')], effort: 'minimal' }), /effort must be one of/);
  assert.throws(() => buildRequest({ parts: [] }), /non-empty/);
});

test('complete() maps a Messages result: JSON text, usage with cache reads and writes, thinking summary, enum case', async () => {
  await withReal(async () => {
    const calls = [];
    _setClientForTests(fakeClient((body) => { calls.push(body); return fakeMessage({
      content: [{ type: 'thinking', thinking: 'thought about it', signature: 's' }, { type: 'thinking', thinking: '', signature: 's2' }, { type: 'text', text: '{"kind":"Causal chain","n":2}' }],
      usage: { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 30, output_tokens_details: { thinking_tokens: 12 } },
      _request_id: 'req_1',
    }); }));
    const schema = obj({ kind: enm(['causal chain', 'contrast']), n: int() });
    const r = await complete({ parts: [part.text('x')], schema, schemaName: 's', effort: 'low', model: 'claude-sonnet-5-5', summary: 'auto' });
    assert.deepEqual(r.json, { kind: 'causal chain', n: 2 }, 'enum capitalization snapped back to the canonical value');
    assert.deepEqual(r.usage, { input_tokens: 105, output_tokens: 30, cached_tokens: 80, cache_write_tokens: 5, reasoning_tokens: 12 });
    assert.equal(r.reasoningSummary, 'thought about it');
    assert.equal(r.requestId, 'req_1');
    assert.equal(calls[0].output_config.format.type, 'json_schema');
  });
});

test('refusal and non-JSON are errors, not parsed output', async () => {
  await withReal(async () => {
    _setClientForTests(fakeClient(() => fakeMessage({ stop_reason: 'refusal', content: [{ type: 'text', text: 'I cannot' }] })));
    await assert.rejects(() => complete({ parts: [part.text('x')], schema: flat, model: 'm', label: 'lbl' }), (e) => e instanceof RefusalError && /lbl/.test(e.message));
    _setClientForTests(fakeClient(() => fakeMessage({ content: [{ type: 'text', text: 'not json' }] })));
    await assert.rejects(() => complete({ parts: [part.text('x')], schema: flat, model: 'm' }), /non-JSON/);
    _setClientForTests(fakeClient(() => fakeMessage({ stop_reason: 'model_context_window_exceeded' })));
    await assert.rejects(() => complete({ parts: [part.text('x')], schema: flat, model: 'm' }), /context window/);
  });
});

test('truncation is detected before parsing and retried once at double the limit, up to the cap', async () => {
  await withReal(async () => {
    const calls = [];
    _setClientForTests(fakeClient((body) => {
      calls.push(body.max_tokens);
      if (calls.length === 1) return fakeMessage({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":"cut' }], usage: { output_tokens: 8192, output_tokens_details: { thinking_tokens: 7000 } } });
      return fakeMessage();
    }));
    const w = console.warn; console.warn = () => {};
    try {
      const r = await complete({ parts: [part.text('x')], schema: flat, model: 'm', maxOutputTokens: 8192, label: 't' });
      assert.deepEqual(calls, [8192, 16384]);
      assert.deepEqual(r.json, { a: 'ok' });
      assert.match(r.notes[0], /retried at max_tokens=16384/);
    } finally { console.warn = w; }
    // retry disabled, or truncated twice → TruncationError with the reasoning share in the message
    const always = () => fakeMessage({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":"cut' }], usage: { output_tokens: 8192, output_tokens_details: { thinking_tokens: 7000 } } });
    _setClientForTests(fakeClient(always));
    await assert.rejects(() => complete({ parts: [part.text('x')], schema: flat, model: 'm', maxOutputTokens: 8192, retryOnTruncation: false }), (e) => e instanceof TruncationError && /Output truncated at max_tokens=8192 \(output 8192 tokens, of which reasoning 7000\)/.test(e.message));
    const w2 = console.warn; console.warn = () => {};
    try { await assert.rejects(() => complete({ parts: [part.text('x')], schema: flat, model: 'm', maxOutputTokens: 8192 }), /truncated at max_tokens=16384/); } finally { console.warn = w2; }
  });
});

test('toClaudeSchema strips constraints the API rejects, states them in the description, and leaves the input alone', () => {
  const s = obj({
    rating: int('1 (poor) to 5 (excellent)', { minimum: 1, maximum: 5 }),
    confidence: num('0 to 1', { minimum: 0, maximum: 1 }),
    note: str('A note', { maxLength: 200 }),
    ids: arr(str('an id'), 'Ids', { minItems: 2, maxItems: 6 }),
    one: arr(str(), 'At least one', { minItems: 1 }),
  });
  const before = JSON.stringify(s);
  const out = toClaudeSchema(s);
  assert.equal(JSON.stringify(s), before, 'input not mutated');
  assert.deepEqual(out.properties.rating, { type: 'integer', description: '1 (poor) to 5 (excellent) (minimum 1; maximum 5)' });
  assert.equal(out.properties.note.description, 'A note (at most 200 characters)');
  assert.deepEqual(out.properties.ids, { type: 'array', items: { type: 'string', description: 'an id' }, description: 'Ids (at least 2 items; at most 6 items)' });
  assert.equal(out.properties.one.minItems, 1, 'minItems 1 is supported and kept');
  assert.deepEqual(out.required, s.required);
  assert.equal(out.additionalProperties, false);
  // a field literally named "minimum" is data, not a keyword
  assert.deepEqual(toClaudeSchema(obj({ minimum: int('x') })).properties.minimum, { type: 'integer', description: 'x' });
  // local validation still enforces the original
  assert.equal(validate(s, { rating: 9, confidence: 0.5, note: 'n', ids: ['a', 'b'], one: ['x'] }).ok, false);
});

test('every op and assembler schema is accepted by the Claude form: strict, no rejected keywords, at most 16 unions', () => {
  const path = parsePath('recall(3) > analyze(causal, relations=2) > evaluate(a, b, options=3) > synthesize(plan)');
  const artifacts = {};
  const banned = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'allOf', 'oneOf', '$ref', 'not'];
  const scan = (node, where) => {
    if (Array.isArray(node)) return node.forEach((n, i) => scan(n, `${where}[${i}]`));
    if (node == null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'properties') { for (const [pk, pv] of Object.entries(v)) scan(pv, `${where}.${pk}`); continue; }
      assert.ok(!banned.includes(k), `${where}: '${k}' would be rejected`);
      if (k === 'minItems') assert.ok(v <= 1, `${where}: minItems ${v} would be rejected`);
      scan(v, `${where}.${k}`);
    }
  };
  for (const [i, step] of path.entries()) {
    const op = OPS[step.op];
    const ctx = ctxFor(path, i, artifacts);
    const claude = toClaudeSchema(assertStrict(schemaOf(op, ctx)));
    scan(claude, op.id);
    assertStrict(claude);
    artifacts[step.id] = op.mock(ctx);
  }
  const actx = { source, path, step: { id: 'assemble', op: 'assemble', index: path.length, params: {} }, priorSteps: path, artifacts };
  scan(toClaudeSchema(assertStrict(schemaOf(ASSEMBLE, actx))), 'assemble');
});

test('assertStrict enforces the union budget and primitive enums; canonicalizeEnums only snaps unambiguous case differences', () => {
  const unions = (n) => obj(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { anyOf: [{ type: 'string' }, { type: 'null' }] }])));
  assert.doesNotThrow(() => assertStrict(unions(16)));
  assert.throws(() => assertStrict(unions(17)), /more than 16 unions/);
  assert.throws(() => assertStrict(obj({ a: { type: 'string', enum: [{ x: 1 }] } })), /enum values must be/);
  const s = obj({ one: enm(['causal chain', 'contrast']), many: arr(obj({ k: enm(['none', 'recall']) })), free: str() });
  const v = { one: 'Causal Chain', many: [{ k: 'NONE' }, { k: 'recall' }, { k: 'other' }], free: 'Keep Case' };
  assert.deepEqual(canonicalizeEnums(v, s), { one: 'causal chain', many: [{ k: 'none' }, { k: 'recall' }, { k: 'other' }], free: 'Keep Case' });
  assert.equal(canonicalizeEnums('A', { enum: ['a', 'A'] }), 'A', 'exact match wins');
  assert.equal(canonicalizeEnums('ab', { enum: ['aB', 'Ab'] }), 'ab', 'an ambiguous case match is left for validate() to reject');
  assert.equal(canonicalizeEnums('zzz', { enum: ['aB'] }), 'zzz', 'no match is left for validate() to reject');
});
