import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, formatPath, PathError } from '../core/path.js';
import { obj, arr, str, enm, assertStrict, validate } from '../core/schema.js';

test('shorthand parsing with positional, named, list, and quoted args', () => {
  const steps = parsePath('recall(4) > analyze(causal, relations=3) > evaluate(efficacy, "patient safety", cost) > synthesize(\'discharge protocol\')');
  assert.deepEqual(steps.map((s) => s.id), ['recall', 'analyze', 'evaluate', 'synthesize']);
  assert.equal(steps[0].params.concepts, 4);
  assert.deepEqual(steps[1].params, { kind: 'causal', relations: 3 });
  assert.deepEqual(steps[2].params.criteria, ['efficacy', 'patient safety', 'cost']);
  assert.equal(steps[2].params.options, 3);
  assert.equal(steps[3].params.form, 'discharge protocol');
});

test('defaults applied; JSON form equivalent; repeated ops get numbered ids; alternative arrows', () => {
  const a = parsePath('recall > analyze');
  assert.deepEqual(a[1].params, { kind: 'contrast', relations: 2 });
  const b = parsePath([{ op: 'recall' }, { op: 'analyze', params: { kind: 'contrast', relations: 2 } }]);
  assert.deepEqual(a, b);
  const c = parsePath('recall -> analyze(causal) → analyze(contrast)');
  assert.deepEqual(c.map((s) => s.id), ['recall', 'analyze', 'analyze2']);
  assert.equal(formatPath(c), 'recall > analyze(kind=causal) > analyze');
});

test('dependency and param errors are specific', () => {
  assert.throws(() => parsePath('analyze'), (e) => e instanceof PathError && /requires an earlier 'recall'/.test(e.message));
  assert.throws(() => parsePath('recall > evaluate'), /requires an earlier 'analyze'/);
  assert.throws(() => parsePath('recall(0)'), /must be ≥ 1/);
  assert.throws(() => parsePath('recall(x)'), /must be an integer/);
  assert.throws(() => parsePath('recall > analyze(sideways)'), /must be one of/);
  assert.throws(() => parsePath('recall(foo=1)'), /unknown param 'foo'/);
  assert.throws(() => parsePath('recall > analyze(a, b)'), /only one positional/);
  assert.throws(() => parsePath('recall > bogus'), /Unknown op 'bogus'/);
  assert.throws(() => parsePath(''), /empty/);
});

test('schema helpers produce strict-mode schemas and assertStrict rejects violations', () => {
  const s = obj({ a: str(), b: arr(obj({ c: enm(['x', 'y']) })) });
  assert.doesNotThrow(() => assertStrict(s));
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['a', 'b']);
  assert.throws(() => assertStrict({ type: 'array', items: str() }), /root must be an object/);
  assert.throws(() => assertStrict({ type: 'object', properties: { a: str() }, required: ['a'] }), /additionalProperties/);
  assert.throws(() => assertStrict({ type: 'object', properties: { a: str(), b: str() }, required: ['a'], additionalProperties: false }), /missing: b/);
  assert.throws(() => assertStrict(obj({ a: { oneOf: [str(), str()] } })), /oneOf/);
  const r = validate(s, { a: 'x', b: [{ c: 'z' }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /allowed values/.test(e)));
});
