import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.MOCK_LLM = '1';
process.env.COGPATH_DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runs');
const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../samples/retrobulbar-hematoma.md');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, formatPath } from '../core/path.js';
import { toClaudeSchema, assertStrict, validate } from '../core/schema.js';
import { OPS, ASSEMBLE_SHORT, assemblerFor, FORMATS, schemaOf } from '../core/ops/index.js';
import { loadSource } from '../core/source.js';
import { runPath, makeCtx, executeOp, sumUsage, MAX_MCQ_STEPS } from '../core/executor.js';
import { _setClientForTests } from '../core/llm.js';
import { verifyItem, assemblyOf } from '../core/verifier.js';
import { buildShortSchema, finishShort, shortShapeProblems, allowedSources, MAX_REQUIREMENT_WORDS, MAX_LEADIN_WORDS, TARGET_ANSWER_WORDS, MAX_ANSWER_WORDS } from '../core/ops/assemble-short.js';
import { judgeGrade, judgeElements, shortNecessitySummary, gradeSchema, elementPickSchema, cueSchema, checkCues, gradeAnswer, pickElements, verifyShortNecessity } from '../core/verify-short.js';
import { notesFor } from '../core/verifier.js';

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega '.repeat(12);
const LINEAR = 'recall(3) > analyze(causal) > evaluate(a, b) > synthesize(plan)';
const DAG5 = 'r1: recall(2) > a: analyze(causal, relations=1); r2: recall(2); @a, @r2 > evaluate(x, y, options=2) > synthesize(plan)';
const SIX = 'recall(2) > analyze(causal) > analyze(contrast) > evaluate(a, b) > analyze(mechanism) > synthesize(plan)';

const shortRun = async (text, extra = {}) => {
  const source = await loadSource({ title: 'T', text: WORDS });
  const path = parsePath(text);
  return { source, path, trace: await runPath({ source, path, model: 'mock', format: 'short', ...extra }) };
};

test('formats: mcq is the default, short selects the rubric assembler, anything else is refused before any call', async () => {
  assert.deepEqual(FORMATS, ['mcq', 'short']);
  assert.equal(assemblerFor().id, 'assemble');
  assert.equal(assemblerFor('short'), ASSEMBLE_SHORT);
  assert.throws(() => assemblerFor('essay'), /Unknown format 'essay'/);
  const source = await loadSource({ title: 'T', text: WORDS });
  const bad = await runPath({ source, path: parsePath(LINEAR), model: 'mock', format: 'essay' });
  assert.equal(bad.status, 'failed'); assert.match(bad.error.message, /Unknown format/); assert.equal(bad.steps.length, 0);
  const mcq = await runPath({ source, path: parsePath(LINEAR), model: 'mock' });
  assert.equal(mcq.item.format, 'mcq'); assert.equal(mcq.format, 'mcq'); assert.equal(mcq.item.options.length, 5);
});

test('short answer has no step limit: a six-step path runs where a multiple-choice item refuses it', async () => {
  const source = await loadSource({ title: 'T', text: WORDS });
  const mcq = await runPath({ source, path: parsePath(SIX), model: 'mock' });
  assert.equal(mcq.status, 'failed'); assert.match(mcq.error.message, new RegExp(`at most ${MAX_MCQ_STEPS} steps`));
  const { trace, path } = await shortRun(SIX);
  assert.equal(trace.status, 'done', trace.error?.message);
  assert.equal(trace.item.rubric.length, 6);
  assert.deepEqual(trace.item.rubric.map((e) => e.nodeId), path.map((s) => s.id));
});

test('the short item: one rubric element per node in path order, ids e1.., no options or key, points add up', async () => {
  const { trace, path } = await shortRun(DAG5);
  assert.equal(trace.status, 'done', trace.error?.message);
  const it = trace.item;
  assert.equal(it.format, 'short'); assert.equal(it.key, null); assert.equal(it.options, undefined);
  assert.deepEqual(it.rubric.map((e) => e.id), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(it.rubric.map((e) => e.nodeId), path.map((s) => s.id));
  assert.equal(it.maxPoints, 5);
  assert.ok(it.modelAnswer.length > 20);
  assert.equal(trace.assemble.problems.length, 0);
  assert.equal(trace.steps.at(-1).id, 'synthesize');
  assert.match(trace.steps.at(-1).deps.join(), /evaluate/);
});

test('schemas for the assembler, the grader and the element picker are accepted by the Claude form', async () => {
  const { path, trace } = await shortRun(LINEAR);
  const banned = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'allOf', 'oneOf', '$ref', 'not'];
  const scan = (node, where) => {
    if (Array.isArray(node)) return node.forEach((n, i) => scan(n, `${where}[${i}]`));
    if (node == null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'properties') { for (const [pk, pv] of Object.entries(v)) scan(pv, `${where}.${pk}`); continue; }
      assert.ok(!banned.includes(k), `${where}: '${k}' would be rejected`);
      if (k === 'minItems') assert.ok(v <= 1, `${where}: minItems ${v}`);
      scan(v, `${where}.${k}`);
    }
  };
  for (const [name, schema] of [['assemble_short', buildShortSchema(path)], ['grade', gradeSchema(trace.item)], ['element_pick', elementPickSchema(trace.item)]]) {
    const claude = toClaudeSchema(assertStrict(schema));
    scan(claude, name); assertStrict(claude);
  }
  assert.equal(validate(buildShortSchema(path), OPS.recall && ASSEMBLE_SHORT.mock(makeCtx({ source: await loadSource({ title: 'T', text: WORDS }), path, step: { id: 'assemble', op: 'assemble' }, artifacts: trace.artifacts }))).ok, true);
});

test('assembler checks: wrong node order, a derivedFrom outside the node, a stem that leaks a recalled fact, a long model answer, a missing question', async () => {
  const { trace, path, source } = await shortRun(LINEAR);
  const ctx = makeCtx({ source, path, step: { id: 'assemble', op: 'assemble' }, artifacts: trace.artifacts });
  const good = ASSEMBLE_SHORT.mock(ctx);
  assert.deepEqual(ASSEMBLE_SHORT.verify(good, ctx), []);
  const swapped = { ...good, rubric: [good.rubric[1], good.rubric[0], ...good.rubric.slice(2)] };
  assert.ok(ASSEMBLE_SHORT.verify(swapped, ctx).some((p) => /one element per node, in path order/.test(p)));
  const wrong = { ...good, rubric: good.rubric.map((e, i) => (i === 1 ? { ...e, derivedFrom: 'c1' } : e)) };
  assert.ok(ASSEMBLE_SHORT.verify(wrong, ctx).some((p) => /element for "analyze" has derivedFrom="c1", allowed: r1/.test(p)));
  const fact = trace.artifacts.recall.concepts[0];
  const leaky = { ...good, stem: `${good.stem} ${fact.statement}` };
  assert.ok(ASSEMBLE_SHORT.verify(leaky, ctx).some((p) => /stem restates recalled fact c1/.test(p)));
  assert.ok(ASSEMBLE_SHORT.verify({ ...good, modelAnswer: 'word '.repeat(200) }, ctx).some((p) => /model answer is 200 words/.test(p)));
  assert.ok(ASSEMBLE_SHORT.verify({ ...good, leadIn: 'What would you do? Why?' }, ctx).some((p) => /exactly one question/.test(p)), 'two questions');
  assert.ok(!ASSEMBLE_SHORT.verify({ ...good, leadIn: 'What would you do for this patient, and why?' }, ctx).some((p) => /exactly one question/.test(p)), 'one question asking for the decision and the reasoning is the intended form');
  assert.ok(shortShapeProblems({ ...good, leadIn: 'Describe the plan.' }).some((p) => /exactly one question/.test(p)));
  assert.ok(shortShapeProblems({ ...good, modelAnswer: `${good.modelAnswer} The article says so.` }).some((p) => /refers to the source/.test(p)));
  assert.ok(ASSEMBLE_SHORT.verify({ ...good, rubric: good.rubric.map((e) => ({ ...e, requirement: good.rubric[0].requirement })) }, ctx).some((p) => /same requirement/.test(p)));
  // terminal element is derived from 'terminal'; allowed sources per node
  assert.ok(allowedSources(path, trace.artifacts, path.at(-1)).has('terminal'));
  const fromRecall = allowedSources(path, trace.artifacts, path[0]);
  for (const c of trace.artifacts.recall.concepts) assert.ok(fromRecall.has(c.id), c.id);
  assert.ok(fromRecall.has('alt:recall'), 'a synthesize alternative for the node is an allowed source too');
  assert.ok(!fromRecall.has('terminal'));
});

test('grading: a credit stands only with a quote that is in the answer', () => {
  const item = { rubric: [{ id: 'e1', nodeId: 'recall' }, { id: 'e2', nodeId: 'analyze' }, { id: 'e3', nodeId: 'synthesize' }] };
  const answer = 'Release the lateral canthus now because pressure on the optic nerve is time critical, then reassess vision.';
  const g = judgeGrade({ marks: [
    { elementId: 'e1', met: true, evidence: 'Release the lateral canthus now' },
    { elementId: 'e2', met: true, evidence: 'it is a compartment syndrome of the orbit' }, // not in the answer
    { elementId: 'e3', met: false, evidence: '' },
  ] }, item, answer);
  assert.deepEqual(g.marks.map((m) => m.met), [true, false, false]);
  assert.match(g.marks[1].override, /without a quote from the answer/);
  assert.equal(g.score, 1); assert.equal(g.max, 3);
  assert.equal(judgeGrade({ marks: [] }, item, answer).score, 0, 'an element the grader never marked is not credited');
});

test('element entailment is judged with the MCQ discipline: raw yes without notes, quotes or support is overridden', async () => {
  const { trace, path } = await shortRun(LINEAR);
  const item = trace.item;
  const notes = notesFor(trace.artifacts, path.slice(0, 1));
  const q = notes.textOf('c1').replace(/[{}\[\]"]/g, ' ').trim().split(/\s+/).slice(0, 8).join(' ');
  const ok = { elementId: 'e1', fullyEntailed: true, citedNotes: ['c1'], evidence: [{ clause: q, noteId: 'c1', quote: q }], missingClause: '' };
  const judged = (e) => judgeElements({ elements: [e] }, item, notes).find((x) => x.elementId === 'e1');
  assert.equal(judged(ok).entailed, true);
  assert.match(judged({ ...ok, citedNotes: [] }).override, /no notes cited/);
  assert.match(judged({ ...ok, citedNotes: ['zz9'] }).override, /do not exist/);
  assert.match(judged({ ...ok, evidence: [] }).override, /no quoted evidence for the element/);
  assert.match(judged({ ...ok, evidence: [{ clause: q, noteId: 'c1', quote: 'a sentence that no note contains at all' }] }).override, /not found in any note/);
  assert.equal(judged({ ...ok, fullyEntailed: false }).entailed, false);
  assert.equal(judged({ ...ok, fullyEntailed: false }).raw, false);
  // elements the picker did not answer are simply not established
  assert.equal(judgeElements({ elements: [] }, item, notes).every((e) => !e.entailed), true);
});

test('necessity summary: the full path must establish every element, and withholding a node must not establish its element or the final one', async () => {
  const { trace, path } = await shortRun(LINEAR);
  const rubric = trace.item.rubric; // e1 recall, e2 analyze, e3 evaluate, e4 synthesize
  const mk = (without, entailed) => ({ without, entailed, k: 0 });
  const good = [mk('recall', []), mk('analyze', ['e1']), mk('evaluate', ['e1', 'e2']), mk('synthesize', ['e1', 'e2', 'e3']), mk(null, ['e1', 'e2', 'e3', 'e4'])];
  assert.equal(shortNecessitySummary({ picks: good, rubric, path }).pass, true);
  const leaky = good.map((p) => (p.without === 'analyze' ? mk('analyze', ['e1', 'e2']) : p));
  const l = shortNecessitySummary({ picks: leaky, rubric, path });
  assert.equal(l.pass, false); assert.deepEqual(l.leaked, [{ without: 'analyze', elements: ['e2'] }]); assert.match(l.verdict, /e2 still established without analyze/);
  const finalLeak = good.map((p) => (p.without === 'recall' ? mk('recall', ['e4']) : p));
  assert.deepEqual(shortNecessitySummary({ picks: finalLeak, rubric, path }).leaked, [{ without: 'recall', elements: ['e4'] }]);
  const thin = good.map((p) => (p.without === null ? mk(null, ['e1', 'e2', 'e3']) : p));
  const t = shortNecessitySummary({ picks: thin, rubric, path });
  assert.equal(t.pass, false); assert.deepEqual(t.unsupported, ['e4']); assert.match(t.verdict, /does not establish element e4/);
});

test('verification of a short item in mock mode, on a chain and on a branched path, with deep checks', async () => {
  for (const text of [LINEAR, DAG5]) {
    const { trace, source } = await shortRun(text);
    const v = await verifyItem({ trace, source, model: 'mock', deep: true });
    assert.equal(v.format, 'short');
    assert.equal(v.summary.pass, true, JSON.stringify(v.summary));
    assert.equal(v.answerability.score, v.answerability.max);
    assert.equal(v.modelAnswerScore.pass, true);
    assert.equal(v.pathNecessity.picks.length, trace.path.length + 1);
    assert.equal(v.elementMapping.total, trace.path.length);
    assert.equal(v.elementMapping.terminalBlocked, trace.path.length);
    // the path needed to establish each element: withholding a node leaves nothing established in the mock
    for (const p of v.pathNecessity.picks.filter((x) => x.without)) assert.deepEqual(p.entailed, []);
    const full = v.pathNecessity.picks.find((p) => p.without == null);
    assert.deepEqual(full.entailed, trace.item.rubric.map((e) => e.id));
    // every pick keeps what a re-judge needs
    assert.ok(full.elements.every((e) => 'raw' in e && 'citedNotes' in e && 'evidence' in e));
  }
});

test('a full short-answer build with controls: planned, verified deeply, summarized, exported, rescored', async () => {
  const fs = await import('node:fs');
  const { ingestSource } = await import('../core/ingest.js');
  const { saveIngest, loadIngest, approveIngest, exportItem } = await import('../core/store.js');
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
    const build = await buildItems({ source: src, n: 2, paths: [DAG5, SIX], model: 'mock', deep: true, baseline: true, seed: 3, format: 'short' });
    assert.equal(build.format, 'short');
    assert.equal(build.status, 'done', build.error?.message);
    assert.equal(build.items.length, 2);
    for (const it of build.items) { assert.equal(it.status, 'done', it.error?.message); assert.equal(it.verification.format, 'short'); assert.equal(it.verification.summary.pass, true); }
    assert.equal(build.baselines.length, 2);
    for (const b of build.baselines) {
      assert.equal(b.trace.item.format, 'short'); assert.equal(b.status, 'done');
      assert.ok(b.trace.item.rubric.length >= 3);
      assert.equal(b.verification.format, 'short'); assert.equal(b.verification.summary.pass, true);
      assert.equal(b.verification.pathNecessity, null);
    }
    const s = summarize(build);
    assert.equal(s.rates.necessity, '2/2'); assert.equal(s.rows[0].cover, 'pass'); assert.equal(s.rows[0].mapping, '5/5'); assert.equal(s.rows[1].mapping, '6/6');
    assert.equal(s.rates.baselineCover, '2/2'); assert.equal(s.rates.baselineForm, '2/2');
    const out = exportItem(build, build.items[0], { status: 'certified' });
    assert.equal(out.format, 'short'); assert.equal(out.options, null); assert.equal(out.key, null);
    assert.equal(out.rubric.length, 5); assert.deepEqual(out.rubric.map((e) => e.node), ['r1', 'a', 'r2', 'evaluate', 'synthesize']);
    assert.equal(out.maxPoints, 5); assert.equal(out.verification.cover, true); assert.equal(out.verification.keyBlocked, '5/5');
    assert.equal(out.control.cover, true);
    // an MCQ export is unchanged in shape
    const mcq = await buildItems({ source: src, n: 1, paths: [LINEAR], model: 'mock', deep: false, baseline: false, seed: 3 });
    const m = exportItem(mcq, mcq.items[0], { status: 'certified' });
    assert.equal(m.format, 'mcq'); assert.equal(m.options.length, 5); assert.ok(m.key);
    // rescoring re-judges the stored element picks and reaches the same verdicts
    const before = JSON.stringify(build.items.map((it) => it.verification.summary));
    await rescoreBuild(build);
    assert.equal(JSON.stringify(build.items.map((it) => it.verification.summary)), before);
    // a stored pick whose evidence no longer holds is overturned by the re-judge
    const full = build.items[0].verification.pathNecessity.picks.find((p) => p.without == null);
    full.elements[0].evidence = [{ clause: 'x', noteId: full.elements[0].citedNotes[0], quote: 'a sentence that no note contains at all' }];
    const r = await rescoreBuild(build);
    assert.ok(r.changes.some((c) => /necessity all/.test(c.what)));
    assert.equal(build.items[0].verification.pathNecessity.pass, false);
    assert.match(build.items[0].verification.pathNecessity.verdict, /does not establish element e1/);
    assert.equal(build.items[0].verification.summary.pass, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── the item must satisfy its own rubric ───────────────────

const withReal = async (fn) => { const saved = process.env.MOCK_LLM; process.env.MOCK_LLM = '0'; process.env.MODEL_API_KEY = process.env.MODEL_API_KEY || 'test-key'; try { await fn(); } finally { process.env.MOCK_LLM = saved; _setClientForTests(null); } };
const msg = (json) => ({ id: 'm', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(json) }], usage: { input_tokens: 10, output_tokens: 10 } });
const isGrade = (body) => Boolean(body.output_config?.format?.schema?.properties?.marks);
const isCue = (body) => Boolean(body.output_config?.format?.schema?.properties?.elements);
const allCued = (item) => ({ elements: item.rubric.map((e) => ({ elementId: e.id, cued: true, onePoint: true, reason: 'asked for' })) });
const allMet = (item, answer) => ({ marks: item.rubric.map((e) => ({ elementId: e.id, met: true, evidence: answer.split(/\s+/).slice(1, 5).join(' ') })) });

test('an element is one point: a requirement past the length limit is sent back, a short one passes', async () => {
  const { trace, path, source } = await shortRun(LINEAR);
  const ctx = makeCtx({ source, path, step: { id: 'assemble', op: 'assemble' }, artifacts: trace.artifacts });
  const good = ASSEMBLE_SHORT.mock(ctx);
  const long = 'Recognizes that the swelling raises pressure behind the eye and that this impairs venous outflow and that the delay in lowering it risks permanent damage to the optic nerve within minutes unless a clinician acts at once at the bedside'.split(' ');
  assert.ok(long.length > MAX_REQUIREMENT_WORDS + 5);
  const bad = { ...good, rubric: good.rubric.map((e, i) => (i === 0 ? { ...e, requirement: long.join(' ') } : e)) };
  assert.ok(ASSEMBLE_SHORT.verify(bad, ctx).some((p) => new RegExp(`element for "${path[0].id}" is ${long.length} words; an element is ONE point in at most ${MAX_REQUIREMENT_WORDS}`).test(p)));
  assert.deepEqual(ASSEMBLE_SHORT.verify(good, ctx), []);
  assert.match(ASSEMBLE_SHORT.instruction(ctx), /ONE atomic point/);
  assert.match(JSON.stringify(buildShortSchema(path)), /Do not join two ideas/);
});

test('verifyAsync grades the model answer against its own rubric and checks the lead-in asks for every element', async () => {
  const { trace, path, source } = await shortRun(LINEAR);
  const ctx = makeCtx({ source, path, step: { id: 'assemble', op: 'assemble' }, artifacts: trace.artifacts });
  const art = ASSEMBLE_SHORT.mock(ctx);
  await withReal(async () => {
    const calls = [];
    _setClientForTests({ messages: { stream: (body) => ({ finalMessage: async () => {
      const item = finishShort(art);
      if (isGrade(body)) {
        calls.push('grade');
        const g = allMet(item, art.modelAnswer);
        g.marks[1] = { elementId: 'e2', met: false, evidence: '' };
        g.marks[3] = { elementId: 'e4', met: true, evidence: 'words that are not in the answer' }; // credited without a quote from the answer
        return msg(g);
      }
      assert.ok(isCue(body), 'only the grader and the cue check are called: the source has no digest, so there is no entailment call');
      calls.push('cue');
      const c = allCued(item);
      c.elements[0] = { elementId: 'e1', cued: false, reason: 'the question asks only what to do' };
      return msg(c);
    } }) } });
    const r = await ASSEMBLE_SHORT.verifyAsync(art, ctx, { model: 'claude-sonnet-5-5' });
    assert.deepEqual(calls.sort(), ['cue', 'grade']);
    assert.equal(r.answerScore, 2); assert.equal(r.answerMax, 4);
    assert.deepEqual(r.unmet, ['e2', 'e4']);
    assert.deepEqual(r.uncued, ['e1']);
    assert.equal(r.problems.length, 3);
    assert.match(r.problems[0], /does not earn its own element for "analyze" \(e2\)/);
    assert.match(r.problems[1], /\(e4\)/);
    assert.match(r.problems[2], new RegExp(`the lead-in does not ask for element "${path[0].id}" \\(e1\\).*the question asks only what to do.*ONE question`));
    assert.equal(r.usage.length, 2);
  });
});

test('the assembler retries until the model answer earns every element, and the retry carries the unmet elements', async () => {
  const { trace, path, source } = await shortRun(LINEAR);
  const mockCtx = makeCtx({ source, path, step: { id: 'assemble', op: 'assemble' }, artifacts: trace.artifacts });
  const art = ASSEMBLE_SHORT.mock(mockCtx);
  const seen = [];
  let grades = 0;
  await withReal(async () => {
    _setClientForTests({ messages: { stream: (body) => ({ finalMessage: async () => {
      if (isCue(body)) return msg(allCued(finishShort(art)));
      if (!isGrade(body)) { seen.push(body.messages[0].content.at(-1).text); return msg(art); }
      grades++;
      const g = allMet(finishShort(art), art.modelAnswer);
      if (grades <= 2) g.marks[2] = { elementId: 'e3', met: false, evidence: '' };
      return msg(g);
    } }) } });
    const rec = await executeOp({ op: ASSEMBLE_SHORT, source, path, step: { id: 'assemble', op: 'assemble', index: path.length, params: {}, deps: [path.at(-1).id] }, artifacts: trace.artifacts, model: 'claude-sonnet-5-5' });
    assert.equal(rec.attempts.length, 3, 'the short assembler is allowed a third pass');
    assert.deepEqual(rec.attempts.map((a) => a.problems.length), [1, 1, 0]);
    assert.equal(rec.problems.length, 0);
    assert.equal(seen.length, 3);
    assert.doesNotMatch(seen[0], /PREVIOUS ATTEMPT WAS REJECTED/);
    assert.match(seen[1], /PREVIOUS ATTEMPT WAS REJECTED[\s\S]*does not earn its own element for "evaluate" \(e3\)/);
    // the checks are part of the cost: 3 assembler calls + 3 grader calls + 3 cue checks
    assert.equal(sumUsage([rec]).calls, 9);
  });
});

test('after the last attempt the step stops and reports what is still wrong, rather than retrying forever', async () => {
  const { trace, path, source } = await shortRun(LINEAR);
  const art = ASSEMBLE_SHORT.mock(makeCtx({ source, path, step: { id: 'assemble', op: 'assemble' }, artifacts: trace.artifacts }));
  await withReal(async () => {
    _setClientForTests({ messages: { stream: (body) => ({ finalMessage: async () => {
      if (isCue(body)) return msg(allCued(finishShort(art)));
      if (!isGrade(body)) return msg(art);
      const g = allMet(finishShort(art), art.modelAnswer); g.marks[0] = { elementId: 'e1', met: false, evidence: '' };
      return msg(g);
    } }) } });
    const rec = await executeOp({ op: ASSEMBLE_SHORT, source, path, step: { id: 'assemble', op: 'assemble', index: path.length, params: {}, deps: [path.at(-1).id] }, artifacts: trace.artifacts, model: 'claude-sonnet-5-5' });
    assert.equal(rec.attempts.length, 3);
    assert.equal(rec.problems.length, 1); assert.match(rec.problems[0], /\(e1\)/);
  });
});

test('the lead-in is asked to cue every element: instruction, schema, and a cue verdict that sends the item back', async () => {
  const { trace, path, source } = await shortRun(LINEAR);
  const ctx = makeCtx({ source, path, step: { id: 'assemble', op: 'assemble' }, artifacts: trace.artifacts });
  assert.match(ASSEMBLE_SHORT.instruction(ctx), /worded so that every rubric element is something the question asks for/);
  assert.match(ASSEMBLE_SHORT.instruction(ctx), /why this choice rather than the alternatives/);
  assert.match(JSON.stringify(buildShortSchema(path)), /worded so that every rubric element is something it asks for/);
  assert.ok(toClaudeSchema(cueSchema(finishShort(ASSEMBLE_SHORT.mock(ctx)))));
  // in mock mode every element is cued
  const r = await checkCues({ item: finishShort(ASSEMBLE_SHORT.mock(ctx)), model: 'mock', label: 't' });
  assert.deepEqual(r.uncued, []); assert.equal(r.cues.length, path.length);
  // a verdict naming an unknown element id cannot slip in: the schema's enum rejects it
  assert.equal(validate(cueSchema(finishShort(ASSEMBLE_SHORT.mock(ctx))), { elements: [{ elementId: 'e9', cued: false, reason: 'x' }] }).ok, false);
});

test('an element that joins several points is sent back, and a lead-in that grows into a checklist is rejected', async () => {
  const { trace, path, source } = await shortRun(LINEAR);
  const ctx = makeCtx({ source, path, step: { id: 'assemble', op: 'assemble' }, artifacts: trace.artifacts });
  const art = ASSEMBLE_SHORT.mock(ctx);
  await withReal(async () => {
    _setClientForTests({ messages: { stream: (body) => ({ finalMessage: async () => {
      const item = finishShort(art);
      if (isGrade(body)) return msg(allMet(item, art.modelAnswer));
      assert.ok(isCue(body));
      const c = allCued(item);
      c.elements[2] = { elementId: 'e3', cued: true, onePoint: false, reason: 'a choice, plus two reasons' };
      c.elements[3] = { elementId: 'e4', cued: false, onePoint: false, reason: 'not asked' };
      return msg(c);
    } }) } });
    const r = await ASSEMBLE_SHORT.verifyAsync(art, ctx, { model: 'claude-sonnet-5-5' });
    assert.deepEqual(r.compound, ['e3'], 'an uncued element is reported once, as uncued');
    assert.deepEqual(r.uncued, ['e4']);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems[0], /element "evaluate" \(e3\) joins several points \(a choice, plus two reasons\).*ONE point this node adds/);
    assert.match(r.problems[1], /does not ask for element "synthesize" \(e4\)|does not ask for element "[a-z]+" \(e4\)/);
  });
  const long = 'What is happening to this patient, what do the findings and the elapsed time tell you about how fast you must act, what would you do right now, and why that rather than the alternatives and the other options you would also consider before deciding?';
  assert.ok(long.split(' ').length > MAX_LEADIN_WORDS);
  assert.ok(ASSEMBLE_SHORT.verify({ ...art, leadIn: long }, ctx).some((p) => new RegExp(`the lead-in is ${long.split(' ').length} words; write at most ${MAX_LEADIN_WORDS}`).test(p)));
  assert.deepEqual(ASSEMBLE_SHORT.verify(art, ctx), []);
  assert.match(ASSEMBLE_SHORT.instruction(ctx), /Each part of the lead-in is generic/);
  assert.match(ASSEMBLE_SHORT.instruction(ctx), new RegExp(`at most ${MAX_LEADIN_WORDS} words`));
});

test('a retry shows the model its previous output and every earlier reason, and the best attempt is kept when the last one regresses', async () => {
  const { trace, path, source } = await shortRun(LINEAR);
  const ctx = makeCtx({ source, path, step: { id: 'assemble', op: 'assemble' }, artifacts: trace.artifacts });
  const good = ASSEMBLE_SHORT.mock(ctx);
  const a1 = { ...good, rubric: good.rubric.map((e, i) => (i === 1 || i === 2 ? { ...e, derivedFrom: 'c1' } : e)) }; // two form problems
  const a2 = { ...good, modelAnswer: 'word '.repeat(MAX_ANSWER_WORDS + 3).trim() };                                  // one form problem
  const seen = [];
  const replies = [a1, a2, a1];
  await withReal(async () => {
    _setClientForTests({ messages: { stream: (body) => ({ finalMessage: async () => { seen.push(body.messages[0].content.at(-1).text); return msg(replies[seen.length - 1]); } }) } });
    const rec = await executeOp({ op: ASSEMBLE_SHORT, source, path, step: { id: 'assemble', op: 'assemble', index: path.length, params: {}, deps: [path.at(-1).id] }, artifacts: trace.artifacts, model: 'claude-sonnet-5-5' });
    assert.deepEqual(rec.attempts.map((a) => a.problems.length), [2, 1, 2]);
    assert.deepEqual(rec.artifact, a2, 'the attempt with the fewest problems is the one kept');
    assert.equal(rec.problems.length, 1); assert.match(rec.problems[0], /model answer is 113 words/);
    // attempt 2 sees attempt 1's output and reasons
    assert.match(seen[1], /FIX ALL OF THEM:\n- element for "analyze" has derivedFrom="c1"/);
    assert.ok(seen[1].includes(JSON.stringify(a1)), 'the previous output is shown for correction');
    assert.doesNotMatch(seen[1], /EARLIER ATTEMPTS/);
    // attempt 3 sees attempt 2's output, attempt 2's reason as current, and attempt 1's reasons as still binding
    assert.ok(seen[2].includes(JSON.stringify(a2)));
    assert.match(seen[2], /FIX ALL OF THEM:\n- the model answer is 113 words/);
    assert.match(seen[2], /DO NOT REINTRODUCE THEM:\n- element for "analyze" has derivedFrom="c1"[\s\S]*element for "evaluate" has derivedFrom="c1"/);
  });
});

test('the instruction lists the derivedFrom values allowed for each node, so a node id is never offered', async () => {
  const { trace, path, source } = await shortRun(DAG5);
  const ctx = makeCtx({ source, path, step: { id: 'assemble', op: 'assemble' }, artifacts: trace.artifacts });
  const ins = ASSEMBLE_SHORT.instruction(ctx);
  assert.match(ins, /derivedFrom is NEVER a node id/);
  for (const node of path) {
    const line = ins.split('\n').find((l) => l.includes(`node "${node.id}" (${node.op}):`));
    assert.ok(line, node.id);
    for (const id of allowedSources(path, trace.artifacts, node)) assert.ok(line.includes(id), `${node.id} lists ${id}`);
  }
  // the recall node named r2 must be offered its concepts, not "r2"
  const r2 = ins.split('\n').find((l) => l.includes('node "r2" (recall):'));
  assert.ok(/\bc\d\b/.test(r2) && !/: r2\b|\| r2\b/.test(r2), r2);
  assert.match(ins, new RegExp(`15 to ${TARGET_ANSWER_WORDS} words \\(count them; the limit is ${MAX_ANSWER_WORDS}\\)`));
});

test('an item whose assembly ended with unresolved problems cannot pass, in either format; clean items keep their check counts', async () => {
  const { trace, source } = await shortRun(LINEAR);
  assert.equal(assemblyOf(trace), null);
  const clean = await verifyItem({ trace, source, model: 'mock' });
  assert.equal(clean.assembly, null); assert.equal(clean.summary.checks.assembly, null); assert.equal(clean.summary.pass, true);
  const dirty = { ...trace, assemble: { ...trace.assemble, problems: ['stem states figures from recalled fact c1 (90); remove them'] } };
  const v = await verifyItem({ trace: dirty, source, model: 'mock' });
  assert.equal(v.summary.checks.assembly, false); assert.equal(v.summary.pass, false);
  assert.equal(v.summary.applicable, clean.summary.applicable + 1);
  assert.deepEqual(v.assembly.problems, dirty.assemble.problems);
  // multiple choice too
  const mcq = await runPath({ source, path: parsePath(LINEAR), model: 'mock' });
  const mv = await verifyItem({ trace: { ...mcq, assemble: { ...mcq.assemble, problems: ['x'] } }, source, model: 'mock' });
  assert.equal(mv.summary.checks.assembly, false); assert.equal(mv.summary.pass, false);
  assert.equal((await verifyItem({ trace: mcq, source, model: 'mock' })).assembly, null);
});

test('a digest too small for the requested item count is refused before any call, with the count it supports', async () => {
  const { planItems } = await import('../core/plan.js');
  const claims = [...Array.from({ length: 7 }, (_, i) => ({ id: `cl${i + 1}`, type: 'result', text: 'x' })), ...Array.from({ length: 15 }, (_, i) => ({ id: `cl${i + 8}`, type: 'recommendation', text: 'y' }))];
  await assert.rejects(planItems({ source: { digest: { claims }, parts: [] }, n: 5, model: 'mock' }), /7 premise claims .* at most 2 items, not 5/);
});
