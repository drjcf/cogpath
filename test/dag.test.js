import fs0 from 'node:fs';
import os0 from 'node:os';
process.env.MOCK_LLM = '1';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// A private data directory: these tests ingest, approve and delete the sample source, which must never touch real work under runs/.
process.env.COGPATH_DATA = fs0.mkdtempSync(path.join(os0.tmpdir(), 'cogpath-test-'));
process.on('exit', () => fs0.rmSync(process.env.COGPATH_DATA, { recursive: true, force: true }));
const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../samples/retrobulbar-hematoma.md');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, formatPath, PathError, depsOf, ancestorIds, descendantIds, isLinear, idBaseOf, branchShare } from '../core/path.js';

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega '.repeat(12);
const DAG5 = 'r1: recall(2) > a: analyze(causal, relations=1); r2: recall(2); @a, @r2 > evaluate(x, y, options=2) > synthesize(plan)';
const ids = (steps) => steps.map((s) => s.id);

test('a chain is still a chain: same ids, same text, each step depends on the one before', () => {
  const s = parsePath('recall(3) > analyze(causal) > analyze(contrast) > evaluate(a, b) > synthesize(plan)');
  assert.deepEqual(ids(s), ['recall', 'analyze', 'analyze2', 'evaluate', 'synthesize']);
  assert.deepEqual(s.map((x) => x.deps), [[], ['recall'], ['analyze'], ['analyze2'], ['evaluate']]);
  assert.ok(isLinear(s));
  assert.equal(formatPath(s), 'recall > analyze(kind=causal) > analyze > evaluate(criteria=a|b) > synthesize(form=plan)', 'defaults are left out');
});

test('branches: labels, fan-in with @, and the text round-trips to the same steps', () => {
  const s = parsePath(DAG5);
  assert.deepEqual(ids(s), ['r1', 'a', 'r2', 'evaluate', 'synthesize']);
  assert.deepEqual(s.map((x) => x.deps), [[], ['r1'], [], ['a', 'r2'], ['evaluate']]);
  assert.ok(!isLinear(s));
  const text = formatPath(s);
  assert.deepEqual(parsePath(text), s);
  assert.match(text, /@a, @r2 > evaluate/);
  // JSON form: 'after' lists dependencies, left out a step follows the previous entry
  const j = parsePath([{ op: 'recall', id: 'r1', params: { concepts: 2 } }, { op: 'analyze', id: 'a', params: { kind: 'causal', relations: 1 } }, { op: 'recall', id: 'r2', params: { concepts: 2 }, after: [] },
    { op: 'evaluate', params: { criteria: ['x', 'y'], options: 2 }, after: ['a', 'r2'] }, { op: 'synthesize', params: { form: 'plan' } }]);
  assert.deepEqual(j, s);
});

test('automatic names count only unnamed steps, and a named step keeps its name through formatting', () => {
  const s = parsePath('x: recall(2) > recall(2)');
  assert.deepEqual(ids(s), ['x', 'recall']);
  assert.equal(formatPath(s), 'x: recall(concepts=2) > recall(concepts=2)');
  assert.deepEqual(parsePath(formatPath(s)), s);
});

test('graph helpers: ancestors, descendants, legacy steps without deps read as a chain', () => {
  const s = parsePath(DAG5);
  assert.deepEqual(ancestorIds(s, 'evaluate').sort(), ['a', 'r1', 'r2']);
  assert.deepEqual(descendantIds(s, 'r1').sort(), ['a', 'evaluate', 'synthesize']);
  assert.deepEqual(descendantIds(s, 'r2').sort(), ['evaluate', 'synthesize']);
  assert.deepEqual(ancestorIds(s, 'assemble').sort(), ['a', 'evaluate', 'r1', 'r2', 'synthesize'], 'the assembler depends on everything');
  const legacy = parsePath('recall > analyze > evaluate').map(({ deps, ...rest }) => rest);
  assert.deepEqual(depsOf(legacy, legacy[2]), ['analyze']);
  assert.deepEqual(ancestorIds(legacy, 'evaluate').sort(), ['analyze', 'recall']);
  assert.deepEqual(descendantIds(legacy, 'recall'), ['analyze', 'evaluate']);
});

test('a path is rejected when it is not one connected whole with a single end, or a step lacks what it needs', () => {
  assert.throws(() => parsePath('recall(2) > analyze; recall(2)'), (e) => e instanceof PathError && /2 terminal steps \(analyze, recall2\).*@analyze, @recall2 > evaluate/.test(e.message));
  assert.throws(() => parsePath('recall > analyze; @nope > evaluate'), /depends on 'nope', which is not an earlier step/);
  assert.throws(() => parsePath('@a > recall'), /depends on 'a'/);
  assert.throws(() => parsePath('recall > recall: analyze'), /Cannot parse|named 'recall'/);
  assert.throws(() => parsePath('recall: recall'), /cannot be named 'recall'/);
  assert.throws(() => parsePath('x: recall > x: analyze'), /Duplicate step name 'x'/);
  assert.throws(() => parsePath('recall > analyze; r2: recall > evaluate'), /requires an earlier 'analyze'/, 'evaluate here depends on r2 only; analyze is not its ancestor');
  assert.throws(() => parsePath('@a'), /must be followed by a step/);
  assert.throws(() => parsePath([{ op: 'recall' }, { op: 'analyze', after: 'recall' }]), /"after" must be an array/);
});

test('ids do not collide across steps of one op, and a reserved-claim set is split between recall steps', () => {
  const s = parsePath('recall(3) > analyze(causal, relations=2); r2: recall(2); @analyze, @r2 > evaluate(a, b)');
  assert.equal(idBaseOf(s, s.find((x) => x.id === 'recall')), 0);
  assert.equal(idBaseOf(s, s.find((x) => x.id === 'r2')), 3);
  assert.equal(idBaseOf(s, s.find((x) => x.id === 'analyze')), 0);
  const claims = ['cl1', 'cl2', 'cl3', 'cl4', 'cl5'];
  assert.deepEqual(branchShare(s, s.find((x) => x.id === 'recall'), claims), ['cl1', 'cl3', 'cl5']);
  assert.deepEqual(branchShare(s, s.find((x) => x.id === 'r2'), claims), ['cl2', 'cl4']);
  assert.deepEqual(branchShare(parsePath('recall > analyze'), { id: 'recall', op: 'recall' }, claims), claims, 'a single recall step keeps them all');
});

const { loadSource } = await import('../core/source.js');
const { runPath, makeCtx } = await import('../core/executor.js');
const { verifyPathNecessity, verifyDistractorMapping, necessitySummary } = await import('../core/verifier.js');
const { OPS } = await import('../core/ops/index.js');

test('running a DAG: branches start together, each step sees only its ancestors, ids stay unique, the item is assembled', async () => {
  const source = await loadSource({ title: 'T', text: WORDS });
  const path = parsePath(DAG5);
  const events = [];
  const trace = await runPath({ source, path, model: 'mock', onEvent: (e) => events.push(e) });
  assert.equal(trace.status, 'done', trace.error?.message);
  assert.deepEqual(trace.steps.map((s) => s.id), ids(path), 'steps are recorded in path order');
  assert.deepEqual(trace.steps.map((s) => s.deps), path.map((s) => s.deps));
  // r1 and r2 have no dependencies: both start before either finishes
  const firstDone = events.findIndex((e) => e.type === 'step:done');
  assert.deepEqual(events.slice(0, firstDone).filter((e) => e.type === 'step:start').map((e) => e.step).sort(), ['r1', 'r2']);
  // numbering: r1 owns c1-c2, r2 owns c3-c4
  assert.deepEqual(trace.artifacts.r1.concepts.map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual(trace.artifacts.r2.concepts.map((c) => c.id), ['c3', 'c4']);
  assert.deepEqual(trace.artifacts.a.relations[0].between.every((c) => ['c1', 'c2'].includes(c)), true, 'analyze on r1 relates r1 concepts only');
  // isolation
  assert.deepEqual(Object.keys(makeCtx({ source, path, step: path[1], artifacts: trace.artifacts }).artifacts), ['r1']);
  assert.deepEqual(Object.keys(makeCtx({ source, path, step: path[3], artifacts: trace.artifacts }).artifacts).sort(), ['a', 'r1', 'r2']);
  // every artifact passes its own op's local verification in the context it ran in
  for (const st of path) {
    const ctx = makeCtx({ source, path, step: st, artifacts: trace.artifacts });
    assert.deepEqual(OPS[st.op].verify(trace.artifacts[st.id], ctx), [], `${st.id} verify`);
  }
  assert.equal(trace.item.options.length, 6);
});

test('a path with more steps than an MCQ has distractors is refused before any call, not truncated', async () => {
  const source = await loadSource({ title: 'T', text: WORDS });
  const six = parsePath('r: recall > a: analyze; s: recall > b: analyze; @a, @b > evaluate > synthesize');
  const trace = await runPath({ source, path: six, model: 'mock' });
  assert.equal(trace.status, 'failed');
  assert.match(trace.error.message, /at most 5 steps/);
  assert.equal(trace.steps.length, 0);
});

test('necessity on a DAG withholds each step together with what depends on it', async () => {
  const source = await loadSource({ title: 'T', text: WORDS });
  const path = parsePath(DAG5);
  const trace = await runPath({ source, path, model: 'mock' });
  const seen = [];
  const res = await verifyPathNecessity({ trace, model: 'mock', onEvent: (e) => seen.push(e) });
  const by = Object.fromEntries(res.picks.map((p) => [p.without ?? 'all', p.steps.slice().sort()]));
  assert.deepEqual(by.r1, ['r2'], 'without r1: its analyze and everything downstream go too');
  assert.deepEqual(by.a, ['r1', 'r2']);
  assert.deepEqual(by.r2, ['a', 'r1'], 'without r2: evaluate and synthesize go, the other branch stays');
  assert.deepEqual(by.evaluate, ['a', 'r1', 'r2']);
  assert.deepEqual(by.synthesize, ['a', 'evaluate', 'r1', 'r2']);
  assert.deepEqual(by.all, ['a', 'evaluate', 'r1', 'r2', 'synthesize']);
  assert.equal(res.picks.length, 6);
  assert.deepEqual(res.picks.map((p) => p.k), [...res.picks.map((p) => p.k)].sort((x, y) => x - y), 'picks are ordered by notes size');
  assert.equal(res.pass, true);
  assert.equal(res.verdict, 'key determinable only with the full path');
  assert.equal(seen.length, 6);
});

test('necessitySummary: a pick that still finds the key without a step fails that step, named; a chain keeps its wording', () => {
  const dag = parsePath(DAG5);
  const mk = (without, k, choice) => ({ without, k, choice });
  const ok = [mk('r1', 1, 'UNDETERMINED'), mk('a', 2, 'UNDETERMINED'), mk('r2', 2, 'UNDETERMINED'), mk('evaluate', 3, 'UNDETERMINED'), mk('synthesize', 4, 'UNDETERMINED'), mk(null, 5, 'C')];
  assert.equal(necessitySummary({ picks: ok, key: 'C', path: dag }).pass, true);
  const leaky = ok.map((p) => (p.without === 'r2' ? { ...p, choice: 'C' } : p));
  const sum = necessitySummary({ picks: leaky, key: 'C', path: dag });
  assert.equal(sum.pass, false);
  assert.match(sum.verdict, /still determinable without r2 .*not necessary/);
  assert.equal(necessitySummary({ picks: ok.map((p) => ({ ...p, choice: 'UNDETERMINED' })), key: 'C', path: dag }).determinedAt, null);
  // chain: old wording, and old stored picks (no 'without', no 'steps') summarize the same way
  const chain = parsePath('recall > analyze > evaluate');
  const stored = [{ k: 0, choice: 'UNDETERMINED' }, { k: 1, choice: 'C' }, { k: 2, choice: 'C' }, { k: 3, choice: 'C' }];
  const cs = necessitySummary({ picks: stored, key: 'C', path: chain });
  assert.equal(cs.determinedAt, 1);
  assert.equal(cs.pass, false);
  assert.equal(cs.verdict, 'key determinable after step 1 of 3 (steps analyze, evaluate not necessary)');
});

test('distractor mapping on a DAG corrupts one step and re-runs only the steps that depend on it', async () => {
  const source = await loadSource({ title: 'T', text: WORDS });
  const path = parsePath(DAG5);
  const trace = await runPath({ source, path, model: 'mock' });
  const res = await verifyDistractorMapping({ trace, source, model: 'mock' });
  assert.equal(res.total, 5);
  const byStep = Object.fromEntries(res.perStep.map((p) => [p.step, p]));
  // after corrupting r2, the other branch's artifacts are the originals and only evaluate and synthesize were re-run
  assert.deepEqual(byStep.r2.downstream.r1, trace.artifacts.r1);
  assert.deepEqual(byStep.r2.downstream.a, trace.artifacts.a);
  assert.deepEqual(Object.keys(byStep.r2.downstream).sort(), ['a', 'evaluate', 'r1', 'r2', 'synthesize']);
  assert.deepEqual(byStep.synthesize.downstream.evaluate, trace.artifacts.evaluate, 'a terminal step has nothing downstream to re-run');
});

test('a whole build on a branched path: planned, run, verified deeply, summarized, and rescored from the stored picks', async () => {
  const fs = await import('node:fs');
  const { ingestSource } = await import('../core/ingest.js');
  const { saveIngest, loadIngest, approveIngest } = await import('../core/store.js');
  const { withDigest } = await import('../core/source.js');
  const { buildItems, summarize } = await import('../core/build.js');
  const { rescoreBuild } = await import('../core/rescore.js');
  const raw = await loadSource(SAMPLE);
  const result = await ingestSource(raw, { maxClaims: 16 });
  const { dir } = await saveIngest({ source: raw, result, model: 'mock' });
  try {
    await approveIngest(raw.sha, { by: 'tester', certifyPending: true });
    const ing = await loadIngest(raw.sha);
    const src = { ...withDigest(raw, ing.digest, 'digest'), digestReview: ing.status };
    const build = await buildItems({ source: src, n: 2, paths: [DAG5], model: 'mock', deep: true, baseline: true, seed: 7 });
    assert.equal(build.status, 'done', build.error?.message);
    assert.equal(build.items.length, 2);
    for (const it of build.items) {
      assert.equal(it.status, 'done', it.error?.message);
      assert.equal(it.plan.path, formatPath(parsePath(DAG5)), 'the item records the path as text, branches intact');
      assert.equal(it.verification.pathNecessity.picks.length, 6);
      assert.equal(it.verification.pathNecessity.pass, true);
      assert.equal(it.verification.distractorMapping.total, 5);
      const recall = ['r1', 'r2'].map((id) => it.trace.artifacts[id].concepts.map((c) => c.id));
      assert.equal(new Set(recall.flat()).size, recall.flat().length, 'recall branches number their facts apart');
    }
    assert.equal(summarize(build).rates.necessity, '2/2');
    // rescoring rebuilds each pick's notes from the steps it recorded and reaches the same verdict
    await rescoreBuild(build);
    for (const it of build.items) { assert.equal(it.verification.pathNecessity.pass, true); assert.equal(it.verification.pathNecessity.picks.length, 6); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
