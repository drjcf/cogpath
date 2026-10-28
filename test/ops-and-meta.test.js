import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPS, ASSEMBLE, schemaOf } from '../core/ops/index.js';
import { optionPlan, letterOptions } from '../core/ops/assemble.js';
import { assertStrict, validate } from '../core/schema.js';
import { parsePath } from '../core/path.js';
import { buildRequest, complete, _setClientForTests, part } from '../core/meta.js';

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

test('buildRequest produces the Responses API shape with strict json_schema and reasoning', () => {
  const schema = assertStrict({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false });
  const body = buildRequest({ instructions: 'SYS', parts: [part.file('file-1'), part.text('hi')], schema, schemaName: 'out', effort: 'high', model: 'muse-spark-1.3', summary: 'auto', maxOutputTokens: 4096 });
  assert.equal(body.model, 'muse-spark-1.3');
  assert.equal(body.instructions, 'SYS');
  assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file-1' }, { type: 'input_text', text: 'hi' }] }]);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(body.text, { format: { type: 'json_schema', name: 'out', schema, strict: true } });
  assert.equal(body.max_output_tokens, 4096);
  assert.equal(body.temperature, undefined);
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(body.prompt_cache_retention, '24h');
  const keyed = buildRequest({ parts: [part.text('x')], cacheKey: 'cogpath:abc', cacheRetention: 'none' });
  assert.equal(keyed.prompt_cache_key, 'cogpath:abc');
  assert.equal(keyed.prompt_cache_retention, undefined);
  assert.throws(() => buildRequest({ parts: [part.text('x')], cacheRetention: '1h' }), /cacheRetention must be one of/);
  assert.throws(() => buildRequest({ parts: [part.text('x')], effort: 'turbo' }), /effort must be one of/);
  assert.throws(() => buildRequest({ parts: [] }), /non-empty/);
});

test('complete() parses a Responses API result (output_text, usage, reasoning summary) and surfaces truncation', async () => {
  const saved = process.env.MOCK_META; process.env.MOCK_META = '0';
  try {
    const calls = [];
    _setClientForTests({ responses: { create: async (body) => { calls.push(body); return {
      id: 'resp_1', model: 'muse-spark-1.3', status: 'completed', output_text: '{"a":"ok"}',
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought about it' }] }, { type: 'message', content: [{ type: 'output_text', text: '{"a":"ok"}' }] }],
      usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 20 } },
    }; } } });
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
    const r = await complete({ parts: [part.text('x')], schema, schemaName: 's', effort: 'low', model: 'muse-spark-1.3' });
    assert.deepEqual(r.json, { a: 'ok' });
    assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 30, cached_tokens: 80, reasoning_tokens: 20 });
    assert.equal(r.reasoningSummary, 'thought about it');
    assert.equal(calls[0].text.format.strict, true);

    _setClientForTests({ responses: { create: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"a":', output: [], usage: {} }) } });
    await assert.rejects(() => complete({ parts: [part.text('x')], schema, schemaName: 's', model: 'm' }), /non-JSON|truncated/);
  } finally { process.env.MOCK_META = saved; }
});

test('truncation is detected before parsing and retried once at double the limit', async () => {
  const saved = process.env.MOCK_META; process.env.MOCK_META = '0';
  try {
    const calls = [];
    _setClientForTests({ responses: { create: async (body) => {
      calls.push(body.max_output_tokens);
      if (calls.length === 1) return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"a":"cut', output: [], usage: { output_tokens: 8192, output_tokens_details: { reasoning_tokens: 7000 } } };
      return { status: 'completed', output_text: '{"a":"ok"}', output: [], usage: { input_tokens: 1, output_tokens: 5 } };
    } } });
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
    const w = console.warn; console.warn = () => {};
    try {
      const r = await complete({ parts: [part.text('x')], schema, schemaName: 's', model: 'm', maxOutputTokens: 8192, label: 't' });
      assert.deepEqual(calls, [8192, 16384]);
      assert.deepEqual(r.json, { a: 'ok' });
      assert.match(r.notes[0], /retried at max_output_tokens=16384/);
    } finally { console.warn = w; }
    // retry disabled → TruncationError with the reasoning share in the message (fresh fake: always truncated)
    _setClientForTests({ responses: { create: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"a":"cut', output: [], usage: { output_tokens: 8192, output_tokens_details: { reasoning_tokens: 7000 } } }) } });
    await assert.rejects(() => complete({ parts: [part.text('x')], schema, schemaName: 's', model: 'm', maxOutputTokens: 8192, retryOnTruncation: false }), /Output truncated at max_output_tokens=8192 \(output 8192 tokens, of which reasoning 7000\)/);
  } finally { process.env.MOCK_META = saved; }
});
