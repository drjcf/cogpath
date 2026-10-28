import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MOCK_META = '1';
process.env.COGPATH_DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runs');
const { parsePath } = await import('../core/path.js');
const { loadSource } = await import('../core/source.js');
const { runPath } = await import('../core/executor.js');
const { verifyItem, spanFound, itemText } = await import('../core/verifier.js');

const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../samples/retrobulbar-hematoma.md');

test('full path compiles an item whose distractors cover every step, and verification passes (mock)', async () => {
  const source = await loadSource(SAMPLE);
  assert.equal(source.kind, 'text');
  const steps = parsePath('recall(3) > analyze(causal) > evaluate(efficacy, safety) > synthesize(management plan)');
  const events = [];
  const trace = await runPath({ source, path: steps, onEvent: (e) => events.push(e.type), seed: 7 });
  assert.equal(trace.steps.length, 4);
  assert.ok(trace.steps.every((s) => s.problems.length === 0));
  assert.equal(trace.item.options.length, 5);
  assert.equal(trace.item.options.filter((o) => o.isKey).length, 1);
  assert.deepEqual([...new Set(trace.item.options.filter((o) => !o.isKey).map((o) => o.failsAt))].sort(), ['analyze', 'evaluate', 'recall', 'synthesize']);
  assert.ok(events.includes('step:start') && events.includes('step:done'));
  assert.equal(trace.totals.calls, 5);

  const v = await verifyItem({ trace, source, deep: true });
  assert.equal(v.grounding.skipped, false);
  assert.equal(v.grounding.pass, true, JSON.stringify(v.grounding.missing));
  assert.equal(v.coverTheOptions.pass, true);
  assert.equal(v.pathNecessity.determinedAt, 4);
  assert.equal(v.pathNecessity.pass, true);
  assert.equal(v.distractorMapping.keyBlocked, 4);
  assert.equal(v.distractorMapping.landed, 4);
  assert.equal(v.summary.pass, true);
  assert.equal(v.summary.applicable, 4);
});

test('short path is padded to 4 options; shallow verify skips distractor mapping', async () => {
  const source = await loadSource({ title: 'Inline', text: 'Retrobulbar hematoma is a surgical emergency. Lateral canthotomy and inferior cantholysis decompress the orbit within the ischemic window of about ninety minutes.' });
  const trace = await runPath({ source, path: parsePath('recall(2) > analyze(contrast, relations=1)') });
  assert.equal(trace.item.options.length, 4);
  assert.equal(trace.item.options.filter((o) => o.failsAt === 'analyze').length, 2);
  const v = await verifyItem({ trace, source, deep: false });
  assert.equal(v.distractorMapping, null);
  assert.equal(v.summary.applicable, 3);
});

test('spanFound: exact, fuzzy, and missing', () => {
  const text = 'The classic presentation is sudden, severe, deep orbital pain out of proportion to the usual postoperative discomfort.';
  assert.equal(spanFound('sudden, severe, deep orbital pain', text).found, true);
  assert.equal(spanFound('"severe deep orbital pain out of proportion to the usual"', text).found, true);
  assert.equal(spanFound('sudden severe deep orbital pain that is out of proportion to the usual postoperative discomfort', text).found, true); // 4-gram overlap ≥ 0.5
  assert.equal(spanFound('completely unrelated words that never appear anywhere here', text).found, false);
  assert.equal(spanFound('', text).found, false);
});

test('itemText renders the item for the verifier', () => {
  const t = itemText({ stem: 'S', leadIn: 'Q?', options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }] });
  assert.match(t, /SCENARIO:\nS\n\nQUESTION:\nQ\?\n\nOPTIONS:\nA\. a\nB\. b/);
});

test('a failure mid-run returns a partial trace with completed steps instead of throwing', async () => {
  const { OPS } = await import('../core/ops/index.js');
  const source = await loadSource(SAMPLE);
  const orig = OPS.evaluate.mock;
  OPS.evaluate.mock = () => { throw new Error('simulated API failure'); };
  try {
    const trace = await runPath({ source, path: parsePath('recall(2) > analyze > evaluate') });
    assert.equal(trace.status, 'failed');
    assert.match(trace.error.message, /simulated API failure/);
    assert.deepEqual(trace.steps.map((s) => s.id), ['recall', 'analyze']);
    assert.ok(trace.artifacts.analyze);
    assert.equal(trace.item, null);
    assert.equal(trace.totals.calls, 2);
  } finally { OPS.evaluate.mock = orig; }
});

test('synthesize corruption is local, uses the own-step alternative, and drops whyWrong leaks; corrupted quotes are scrubbed', async () => {
  const { corruptSynthesize, scrubCorruptedQuotes } = await import('../core/verifier.js');
  const art = {
    synthesis: { statement: 'Integrated plan with sequencing and safeguards.', integrates: ['c1', 'r1', 'o2'], novelElement: 'staging rule' },
    incompleteAlternatives: [
      { skippedStep: 'recall', statement: 'Plan missing the fact.', whyWrong: 'omits the fact' },
      { skippedStep: 'synthesize', statement: 'Best strategy alone, unsequenced.', whyWrong: 'omits sequencing, safeguards, and the staging rule' },
    ],
  };
  const c = corruptSynthesize(art, 'synthesize');
  assert.equal(c.synthesis.statement, 'Best strategy alone, unsequenced.');
  assert.equal(c.synthesis.novelElement, '');
  assert.deepEqual(c.incompleteAlternatives, []);
  assert.ok(!JSON.stringify(c).includes('staging rule'));
  // falls back to the last alternative when the own step has none
  assert.equal(corruptSynthesize({ ...art, incompleteAlternatives: [art.incompleteAlternatives[0]] }, 'synthesize').synthesis.statement, 'Plan missing the fact.');

  const orig = { topic: 't', concepts: [{ id: 'c1', statement: 'true A', sourceSpan: 'quote A' }, { id: 'c2', statement: 'true B', sourceSpan: 'quote B' }] };
  const corr = { topic: 't', concepts: [{ id: 'c1', statement: 'false A', sourceSpan: 'quote A' }, { id: 'c2', statement: 'true B', sourceSpan: 'quote B' }] };
  const s = scrubCorruptedQuotes(orig, corr);
  assert.equal(s.concepts[0].sourceSpan, '');
  assert.equal(s.concepts[1].sourceSpan, 'quote B');
  const origR = { relations: [{ id: 'r1', claim: 'x causes y', implication: 'do z', evidenceSpan: 'ev' }] };
  const corrR = { relations: [{ id: 'r1', claim: 'y causes x', implication: 'do w', evidenceSpan: 'ev' }] };
  assert.equal(scrubCorruptedQuotes(origR, corrR).relations[0].evidenceSpan, '');
});

test('loadSource --inline-text sends extracted PDF text inline and never uploads', async () => {
  const fs = await import('node:fs');
  const tmp = path.resolve(process.env.COGPATH_DATA, 'inline-probe.pdf');
  // minimal single-page PDF with a text layer
  const pdf = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 60>>stream\nBT /F1 14 Tf 10 50 Td (Retrobulbar hematoma is an emergency) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>';
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, pdf);
  try {
    const src = await loadSource(tmp, { inlineText: true });
    assert.equal(src.kind, 'pdf-text');
    assert.equal(src.fileId, null);
    assert.match(src.text, /Retrobulbar hematoma is an emergency/);
    assert.equal(src.parts.length, 1);
    assert.equal(src.parts[0].type, 'input_text');
    assert.match(src.parts[0].text, /^SOURCE \(inline probe\):/);
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('ingest → store → digest-mode run: claims are grounded, recall cites claims, verification passes (mock)', async () => {
  const fs = await import('node:fs');
  const { ingestSource, checkDigest, renderDigest } = await import('../core/ingest.js');
  const { saveIngest, loadIngest, listSources, sourceDir } = await import('../core/store.js');
  const { withDigest } = await import('../core/source.js');
  const { OPS } = await import('../core/ops/index.js');
  const raw = await loadSource(SAMPLE);
  assert.match(raw.sha, /^[0-9a-f]{64}$/);
  const result = await ingestSource(raw, { maxClaims: 16 });
  assert.ok(result.digest.claims.length >= 8);
  assert.equal(result.dropped.length, 0);
  assert.ok(result.digest.claims.every((a) => spanFound(a.span, raw.text).found));
  assert.ok(result.digest.claims.every((a) => ['this_work', 'cited_work', 'general_knowledge'].includes(a.attribution)));
  // a figure in the statement that is not in the source near the span is rejected
  const { figuresIn, passageAround, auditDigest } = await import('../core/ingest.js');
  assert.deepEqual(figuresIn('1 in 6,214 and 4-fold, 39%, 4 mm, 2019'), ['6,214', '4-fold', '39%', '2019']);
  const a0 = result.digest.claims[0];
  const fig = checkDigest({ ...result.digest, claims: [{ ...a0, statement: a0.statement + ' with a rate of 1 in 9,999' }] }, raw.text);
  assert.equal(fig.problems.length, 1);
  assert.match(fig.problems[0].reasons[0], /9,999/);
  assert.ok(passageAround(a0.span, raw.text, 50).length > 0);
  assert.equal(passageAround('completely absent words here', raw.text), '');
  // claims are located on pages and a reviewer passage marks the span
  const { locateSpan, reviewPassage } = await import('../core/ingest.js');
  assert.ok(result.digest.claims.every((c) => c.page === 1));
  assert.equal(locateSpan('words that are nowhere in this source at all', raw.pages), null);
  assert.equal(locateSpan(result.digest.claims[0].span, [{ num: 1, text: 'unrelated page' }, { num: 2, text: raw.text }]), 2);
  const passage = reviewPassage(result.digest.claims[0], raw.pages, raw.text, 40);
  assert.match(passage, /»[^«]+«/);
  assert.equal(reviewPassage({ span: 'nothing like this appears anywhere', page: null }, raw.pages, raw.text), '');
  const audit = await auditDigest(result.digest, raw.text, { batch: 5 });
  assert.equal(audit.findings.length, result.digest.claims.length);
  const { defaultClaimCount } = await import('../core/ingest.js');
  assert.equal(defaultClaimCount(6585), 44);
  assert.equal(defaultClaimCount(500), 12);
  assert.equal(defaultClaimCount(50000), 80);
  assert.equal(audit.flagged.length, 0);
  assert.equal(audit.usage.calls, Math.ceil(result.digest.claims.length / 5));
  // local checks drop a fabricated span and a duplicate
  const bad = { ...result.digest, claims: [...result.digest.claims, { id: 'x1', type: 'result', statement: 'made up', span: 'words that are nowhere in this source at all', section: 'other', importance: 'i' }, { ...result.digest.claims[0], id: 'x2' }] };
  const chk = checkDigest(bad, raw.text);
  assert.deepEqual(chk.problems.map((p) => p.id), ['x1', 'x2']);
  assert.equal(chk.claims.length, result.digest.claims.length);

  const { dir } = await saveIngest({ source: raw, result, model: 'mock' });
  try {
    const loaded = await loadIngest(raw.sha);
    assert.equal(loaded.digest.claims.length, result.digest.claims.length);
    assert.equal(loaded.pages.length, 1);
    assert.ok((await listSources()).some((s) => s.sha === raw.sha));
    const src = withDigest(raw, loaded.digest, 'digest');
    assert.equal(src.mode, 'digest');
    assert.equal(src.parts.length, 1);
    assert.match(src.parts[0].text, /^SOURCE DIGEST/);
    assert.notEqual(src.cacheKey, raw.cacheKey);
    assert.equal(src.text, raw.text); // grounding still checks the raw text
    assert.equal(withDigest(raw, loaded.digest, 'both').parts.length, 2);
    assert.equal(withDigest(raw, null, 'digest').mode, 'raw');
    assert.ok(renderDigest(loaded.digest).includes(loaded.digest.claims[0].span));

    const steps = parsePath('recall(3) > analyze(causal) > evaluate(efficacy, safety) > synthesize(management plan)');
    const trace = await runPath({ source: src, path: steps, seed: 7 });
    assert.equal(trace.status, 'done');
    assert.equal(trace.source.mode, 'digest');
    assert.equal(trace.source.digestClaims, loaded.digest.claims.length);
    assert.ok(trace.artifacts.recall.concepts.every((c) => c.claims.length >= 1));
    const v = await verifyItem({ trace, source: src, deep: true });
    assert.equal(v.summary.pass, true);
    assert.equal(v.sourceRecall.skipped, true); // mock digest has no recommendation claims
    const srcRec = { ...src, digest: { ...src.digest, claims: [...src.digest.claims, { id: 'cl98', type: 'recommendation', statement: 'do the thing', span: 'x', section: 'other', importance: 'i' }] } };
    const v2 = await verifyItem({ trace, source: srcRec, deep: false });
    assert.equal(v2.sourceRecall.skipped, false);
    assert.equal(v2.sourceRecall.pass, true);
    assert.equal(v2.digestRecall.skipped, false);
    assert.equal(v2.digestRecall.pass, true);
    assert.equal(v2.summary.applicable, 5);

    // recall verify: unknown claim, missing claims, recommendation claim in premises mode
    const ctx = { source: { ...src, digest: { ...loaded.digest, claims: [...loaded.digest.claims, { id: 'cl99', type: 'recommendation', statement: 'do X', span: 's', section: 'other', attribution: 'this_work', importance: 'i' }] } }, path: steps, step: steps[0], priorSteps: [], artifacts: {} };
    const art = OPS.recall.mock(ctx);
    art.concepts[0].claims = ['zz9'];
    art.concepts[1].claims = [];
    art.concepts[2].claims = ['cl99'];
    const problems = OPS.recall.verify(art, ctx);
    assert.ok(problems.some((p) => /unknown claim zz9/.test(p)));
    assert.ok(problems.some((p) => /no digest claims cited/.test(p)));
    assert.ok(problems.some((p) => /recommendation claim cl99/.test(p)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('assemble rejects a stem that restates recalled facts or omits the case constraint', async () => {
  const { OPS, ASSEMBLE } = await import('../core/ops/index.js');
  const source = await loadSource(SAMPLE);
  const steps = parsePath('recall(2) > analyze > evaluate(a, b) > synthesize(plan)');
  const artifacts = {};
  for (const [i, s] of steps.entries()) artifacts[s.id] = OPS[s.op].mock({ source, path: steps, step: s, priorSteps: steps.slice(0, i), artifacts });
  artifacts.recall.concepts[0].statement = 'Reported incidence is on the order of 1 in 2,000 cases and events rise 4-fold with deep placement';
  const ctx = { source, path: steps, step: { id: 'assemble', op: 'assemble', index: 4, params: {} }, priorSteps: steps, artifacts };
  const good = ASSEMBLE.mock(ctx);
  assert.deepEqual(ASSEMBLE.verify(good, ctx), []);
  assert.equal(good.constraintSpan, artifacts.synthesize.caseConstraint.feature);
  const leaky = { ...good, stem: good.stem + ' Reported incidence is on the order of 1 in 2,000 cases and events rise 4-fold with deep placement.' };
  const p1 = ASSEMBLE.verify(leaky, ctx);
  assert.ok(p1.some((p) => /restates recalled fact c1/.test(p)), p1.join('; '));
  assert.ok(p1.some((p) => /figures from recalled fact c1/.test(p)), p1.join('; '));
  const noConstraint = { ...good, stem: '[MOCK] A patient presents with nothing in particular and the decision point follows.', constraintSpan: good.constraintSpan };
  assert.ok(ASSEMBLE.verify(noConstraint, ctx).some((p) => /constraintSpan is not found/.test(p)));
  const blank = { ...good, constraintSpan: '' };
  assert.ok(ASSEMBLE.verify(blank, ctx).some((p) => /constraintSpan is empty/.test(p)));
  // synthesize verify: constraint must be grounded in known ids
  const synCtx = { source, path: steps, step: steps[3], priorSteps: steps.slice(0, 3), artifacts };
  const badSyn = JSON.parse(JSON.stringify(artifacts.synthesize));
  badSyn.caseConstraint.derivedFrom = ['q9'];
  badSyn.caseConstraint.feature = 'short';
  const p2 = OPS.synthesize.verify(badSyn, synCtx);
  assert.ok(p2.some((p) => /unknown id q9/.test(p)));
  assert.ok(p2.some((p) => /too short/.test(p)));
});

test('digest approval is bound to content: approve drops claims, an edit demotes to modified, unapprove returns to draft', async () => {
  const fs = await import('node:fs');
  const { ingestSource } = await import('../core/ingest.js');
  const { saveIngest, loadIngest, approveIngest, unapproveIngest, listSources } = await import('../core/store.js');
  const raw = await loadSource({ title: 'Approval probe', text: 'Retrobulbar hematoma is a surgical emergency that threatens vision within hours. Lateral canthotomy with inferior cantholysis decompresses the orbit. Mannitol and acetazolamide lower intraocular pressure while surgical release is arranged. Imaging must never delay decompression when vision is failing.' });
  const result = await ingestSource(raw, { maxClaims: 8 });
  const { dir } = await saveIngest({ source: raw, result, model: 'mock' });
  try {
    assert.equal((await loadIngest(raw.sha)).status, 'draft');
    await assert.rejects(() => approveIngest(raw.sha, { drop: ['zz1'] }), /unknown claim/);
    const { decideClaim, loadDecisions, decisionCounts } = await import('../core/store.js');
    const n = (await loadIngest(raw.sha)).digest.claims.length;
    const [c0, c1, c2] = result.digest.claims;
    // per-claim decisions: certify, reject, edit (span immutable)
    await decideClaim(raw.sha, c1.id, { action: 'certify', by: 'tester' });
    const edited = await decideClaim(raw.sha, c2.id, { action: 'edit', by: 'tester', newStatement: 'Edited statement text.', newAttribution: 'cited_work' });
    assert.equal(edited.claim.statement, 'Edited statement text.');
    assert.equal(edited.claim.attribution, 'cited_work');
    assert.equal(edited.claim.span, c2.span);
    assert.equal((await loadDecisions(raw.sha))[c2.id].edited, true);
    await assert.rejects(() => decideClaim(raw.sha, 'zz1', { action: 'certify' }), /unknown claim/);
    await assert.rejects(() => decideClaim(raw.sha, c0.id, { action: 'maybe' }), /action must be/);
    const counts = decisionCounts((await loadIngest(raw.sha)).digest, await loadDecisions(raw.sha));
    assert.deepEqual([counts.certified, counts.rejected, counts.pending], [2, 0, n - 2]);
    // console-style approval refuses while claims are pending; CLI-style certifies them
    await assert.rejects(() => approveIngest(raw.sha, { by: 'tester' }), /still pending/);
    const { digest } = await approveIngest(raw.sha, { drop: [c0.id], note: 'ok', by: 'tester', certifyPending: true });
    assert.equal(digest.claims.length, n - 1);
    assert.equal((await loadDecisions(raw.sha))[c0.id].status, 'rejected');
    const ing = await loadIngest(raw.sha);
    assert.equal(ing.status, 'approved');
    assert.equal(ing.meta.review.by, 'tester');
    assert.deepEqual(ing.meta.review.dropped, [c0.id]);
    assert.ok((await listSources()).some((s) => s.sha === raw.sha && s.status === 'approved'));
    const p = path.join(dir, 'digest.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    d.claims[0].statement += ' (edited)';
    fs.writeFileSync(p, JSON.stringify(d));
    assert.equal((await loadIngest(raw.sha)).status, 'modified');
    await unapproveIngest(raw.sha, 'redo');
    assert.equal((await loadIngest(raw.sha)).status, 'draft');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build: planner checks, reserved-claim enforcement in recall, coverage map, and a full mock build with baselines', async () => {
  const fs = await import('node:fs');
  const { ingestSource } = await import('../core/ingest.js');
  const { saveIngest, loadIngest, approveIngest } = await import('../core/store.js');
  const { withDigest, withFocus } = await import('../core/source.js');
  const { checkPlans, planItems } = await import('../core/plan.js');
  const { buildItems, coverageMap, summarize } = await import('../core/build.js');
  const { OPS } = await import('../core/ops/index.js');
  const raw = await loadSource(SAMPLE);
  const result = await ingestSource(raw, { maxClaims: 16 });
  const { dir } = await saveIngest({ source: raw, result, model: 'mock' });
  try {
    await approveIngest(raw.sha, { by: 'tester', certifyPending: true });
    const ing = await loadIngest(raw.sha);
    const src = { ...withDigest(raw, ing.digest, 'digest'), digestReview: ing.status };
    const claims = ing.digest.claims;
    // local plan checks
    const bad = { plans: [
      { id: 'item1', focus: 'A', path: 'recall(3) > analyze(causal) > evaluate(a, b) > synthesize(plan)', claims: [claims[0].id, claims[1].id, claims[2].id], rationale: 'r' },
      { id: 'item2', focus: 'a', path: 'recall(3) > analyze', claims: [claims[2].id, 'zz9'], rationale: 'r' },
    ] };
    const { repairPath } = await import('../core/plan.js');
    assert.equal(repairPath('recall(cl3, cl7, cl9) > analyze(causal relations) > evaluate(a, b) > synthesize()', ['cl3', 'cl7', 'cl9']), 'recall(3) > analyze(causal) > evaluate(a, b) > synthesize');
    assert.equal(repairPath('recall > analyze(kind=mechanism) > evaluate(x, y) > synthesize(plan)', []), 'recall(3) > analyze(mechanism) > evaluate(x, y) > synthesize(plan)');
    assert.equal(repairPath('recall(3) > analyze(contrast) > evaluate(x, y) > synthesize(plan)', []), 'recall(3) > analyze(contrast) > evaluate(x, y) > synthesize(plan)');
    const repaired = checkPlans({ plans: [{ id: 'item1', focus: 'A', path: 'recall(cl1, cl2, cl3) > analyze(causal) > evaluate(a, b) > synthesize(plan)', claims: [claims[0].id, claims[1].id, claims[2].id], rationale: 'r' }] }, { n: 1, claims });
    assert.deepEqual(repaired.problems, []);
    assert.ok(repaired.plans[0].repairedFrom);
    const chk = checkPlans(bad, { n: 2, claims });
    assert.ok(chk.problems.some((p) => /must end with synthesize/.test(p)));
    assert.ok(chk.problems.some((p) => /already reserved by item1/.test(p)));
    assert.ok(chk.problems.some((p) => /unknown claim\(s\) zz9/.test(p)));
    assert.ok(chk.problems.some((p) => /reserve 3 to 6/.test(p)));
    assert.ok(chk.problems.some((p) => /share the same focus/.test(p)));
    const plan = await planItems({ source: src, n: 2 });
    assert.equal(plan.plans.length, 2);
    const all = plan.plans.flatMap((p) => p.claims);
    assert.equal(new Set(all).size, all.length); // disjoint
    // recall held to the reserved set
    const focused = withFocus(src, plan.plans[0]);
    assert.ok(focused.parts[focused.parts.length - 1].text.includes('RESERVED CLAIMS'));
    const steps = plan.plans[0].steps;
    const ctx = { source: focused, path: steps, step: steps[0], priorSteps: [], artifacts: {} };
    const art = OPS.recall.mock(ctx);
    assert.deepEqual(OPS.recall.verify(art, ctx), []);
    art.concepts[0].claims = [plan.plans[1].claims[0]];
    assert.ok(OPS.recall.verify(art, ctx).some((p) => /not reserved for this item/.test(p)));
    // full build
    const build = await buildItems({ source: src, n: 2, deep: true, baseline: true, seed: 5 });
    assert.equal(build.status, 'done');
    assert.equal(build.items.length, 2);
    assert.ok(build.items.every((it) => it.verification?.summary.pass));
    assert.equal(build.baselines.length, 2);
    assert.ok(build.baselines.every((b) => b.verification?.summary.pass));
    assert.ok(build.baselines[0].trace.item.options.filter((o) => o.isKey).length === 1);
    assert.equal(build.items[0].trace.source.focus.id, 'item1');
    const cov = coverageMap(ing.digest, build.items);
    assert.ok(cov.usedCount > 0 && cov.usedCount + cov.unused.length === cov.total);
    const s = summarize(build);
    assert.equal(s.rates.necessity, '2/2');
    assert.equal(s.rates.baselineForm, '2/2');
    assert.equal(s.rows[0].baseline.form, 'pass');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('passages shown to reviewers and the audit keep the original symbols (<, >, ×) that normalization strips', async () => {
  const { locateInText, normWithMap } = await import('../core/textmatch.js');
  const { reviewPassage } = await import('../core/ingest.js');
  const text = 'Other notable risk factors were a downward cannula angulation (3.8× increase PFE), cannula diameter (<4mm, 5× increase PFE), and multiple hole cannula (2.4× increase PFE). Use a smooth 4 mm or > blunt tip cannula to inject fat.';
  const m = normWithMap('A “quoted” 4 mm or > blunt-tip');
  assert.equal(m.norm, 'a quoted 4 mm or blunt-tip');
  assert.equal('A “quoted” 4 mm or > blunt-tip'[m.map[2]], 'q'); // map points back into the raw string
  const loc = locateInText('cannula diameter (<4mm, 5× increase PFE)', text, 20);
  assert.ok(loc.passage.includes('<4mm') && loc.passage.includes('5×'));
  assert.match(loc.passage.slice(loc.start, loc.end), /^cannula diameter \(<4mm, 5× increase PFE/);
  assert.equal(locateInText('nothing like this is present', text), null);
  const rp = reviewPassage({ span: 'Use a smooth 4 mm or > blunt tip cannula', page: 1 }, [{ num: 1, text }], text, 15);
  assert.match(rp, /»Use a smooth 4 mm or > blunt tip cannula«/);
});

test('audit repairs label issues in place and removes only content issues; recommendations pass merges uncovered spans', async () => {
  const { applyAuditRepairs, spanCovered, AUDIT_REPAIRABLE } = await import('../core/ingest.js');
  const digest = { title: 't', topic: 'x', claims: [
    { id: 'cl1', type: 'result', attribution: 'cited_work', statement: 'a', span: 'alpha beta gamma delta epsilon', section: 'introduction', importance: 'i' },
    { id: 'cl2', type: 'result', attribution: 'this_work', statement: 'b', span: 'one two three four five six', section: 'results', importance: 'i' },
  ] };
  const repaired = [{ id: 'cl1', supported: false, issue: 'attribution', correctedType: 'none', correctedAttribution: 'general_knowledge', note: 'background reasoning' }];
  const fixed = applyAuditRepairs(digest, repaired);
  assert.equal(fixed.claims[0].attribution, 'general_knowledge');
  assert.equal(fixed.claims[0].auditFix.before, 'cited_work');
  assert.equal(fixed.claims[1].auditFix, undefined);
  assert.ok(AUDIT_REPAIRABLE.has('attribution') && AUDIT_REPAIRABLE.has('type') && !AUDIT_REPAIRABLE.has('number'));
  assert.equal(spanCovered('alpha beta gamma delta epsilon', digest.claims), true);
  assert.equal(spanCovered('beta gamma delta epsilon zeta eta', digest.claims), true); // ≥ 50% of 4-grams inside cl1
  assert.equal(spanCovered('wholly different words appear in this span', digest.claims), false);
});

test('leak guards: prescriptive relations and importance, scenario focuses, reserved recommendations, duplicate constraints, consequence in stem, spelled-out figures', async () => {
  const { OPS, ASSEMBLE } = await import('../core/ops/index.js');
  const { checkPlans } = await import('../core/plan.js');
  const { wordsToDigits } = await import('../core/ops/assemble.js');
  const { withFocus } = await import('../core/source.js');
  const source = await loadSource(SAMPLE);
  const steps = parsePath('recall(2) > analyze > evaluate(a, b) > synthesize(plan)');
  const artifacts = {};
  for (const [i, s] of steps.entries()) artifacts[s.id] = OPS[s.op].mock({ source, path: steps, step: s, priorSteps: steps.slice(0, i), artifacts });
  // analyze: a prescriptive implication is rejected
  const actx = { source, path: steps, step: steps[1], priorSteps: [steps[0]], artifacts: { recall: artifacts.recall } };
  const rel = OPS.analyze.mock(actx);
  rel.relations[0].implication = 'Fat should be placed subcutaneously only.';
  assert.ok(OPS.analyze.verify(rel, actx).some((p) => /reads as a recommendation/.test(p)));
  // recall: an imperative statement is rejected in premises mode (no importance field remains to leak through)
  const rctx = { source, path: steps, step: steps[0], priorSteps: [], artifacts: {} };
  const rec = OPS.recall.mock(rctx);
  rec.concepts[0].statement = 'Stay superficial to the gluteus muscles when grafting.';
  assert.ok(OPS.recall.verify(rec, rctx).some((p) => /reads as an instruction/.test(p)));
  assert.equal(Object.keys(OPS.recall.schema.properties.concepts.items.properties).includes('importance'), false);
  // planner: reserved recommendation and scenario focus are rejected
  const claims = [{ id: 'cl1', type: 'result' }, { id: 'cl2', type: 'result' }, { id: 'cl3', type: 'recommendation' }, { id: 'cl4', type: 'result' }];
  const chk = checkPlans({ plans: [{ id: 'item1', focus: 'A 28-year-old woman presents requesting augmentation', path: 'recall(3) > analyze(causal) > evaluate(a, b) > synthesize(plan)', claims: ['cl1', 'cl2', 'cl3'], rationale: 'r' }] }, { n: 1, claims });
  assert.ok(chk.problems.some((p) => /reserved recommendation claim\(s\) cl3/.test(p)));
  assert.ok(chk.problems.some((p) => /describes a patient scenario/.test(p)));
  // synthesize: a constraint that duplicates another item's is rejected
  const used = [{ item: 'item1', feature: '[MOCK] The patient has a feature that makes the generic strategy insufficient here.' }];
  const focused = withFocus(source, { id: 'item2', focus: 'f', claims: [] }, { usedConstraints: used });
  assert.ok(focused.parts[focused.parts.length - 1].text.includes('ALREADY USED'));
  const sctx = { source: focused, path: steps, step: steps[3], priorSteps: steps.slice(0, 3), artifacts };
  assert.ok(OPS.synthesize.verify(artifacts.synthesize, sctx).some((p) => /duplicates item1/.test(p)));
  // assemble: stem that states the constraint's consequence or the plan is rejected; spelled-out figures are caught
  const asmctx = { source, path: steps, step: { id: 'assemble', op: 'assemble', index: 4, params: {} }, priorSteps: steps, artifacts };
  const good = ASSEMBLE.mock(asmctx);
  const leaky = { ...good, stem: good.stem + ' ' + artifacts.synthesize.caseConstraint.whyGenericInsufficient };
  assert.ok(ASSEMBLE.verify(leaky, asmctx).some((p) => /states the consequence/.test(p)));
  const planLeak = { ...good, stem: good.stem + ' ' + artifacts.synthesize.synthesis.statement };
  assert.ok(ASSEMBLE.verify(planLeak, asmctx).some((p) => /restates the synthesized plan/.test(p)));
  artifacts.recall.concepts[0].statement = 'About 400 mL fits in the subcutaneous plane.';
  const spelled = { ...good, stem: good.stem + ' Only four hundred mL fits per side.' };
  assert.ok(ASSEMBLE.verify(spelled, asmctx).some((p) => /figures from recalled fact c1 \(400\)/.test(p)));
  assert.equal(wordsToDigits('twenty-two thousand eight hundred cases'), '22800 cases');
});

test('leak guards from build 1: action-leak regex, clause support in the picker, analyze evidence from recommendations, in-loop recommendation entailment', async () => {
  const { ACTION_LEAK, clauseSupported } = await import('../core/textmatch.js');
  const { OPS } = await import('../core/ops/index.js');
  const { entailedByNotes, notesFromClaims } = await import('../core/entail.js');
  for (const leak of ['Stay superficial to the gluteus muscles, staging for more volume.', 'A consent discussion should present zero recent deaths as observed.', 'A surgeon cannot select a specific cannula size on the basis of these counts alone.', 'When desired volume exceeds subcutaneous capacity, stage a second graft rather than placing extra fat into muscle.', 'Do not dismiss zero events as just lower caseload.']) assert.ok(ACTION_LEAK.test(leak), leak);
  for (const ok of ['Deep placement puts fat where injured veins can take it up.', 'Falling from 3 to 0 emboli at P = .03 meets conventional significance while 2 to 0 deaths at P = .07 does not.', 'Fat placed subcutaneously carries lower risk of death than fat placed into muscle.']) assert.ok(!ACTION_LEAK.test(ok), ok);
  assert.equal(clauseSupported('stage a second subcutaneous graft later for added projection', 'A surgeon who restricts all fat placement to above muscle preserves the mortality reduction'), false);
  assert.equal(clauseSupported('stage a delayed second graft', 'the surgeon should consider staging the procedure'), true);
  assert.equal(clauseSupported('Decline the smaller-cannula inferior-port request', 'cannot select a specific cannula size, port, or angle'), true);
  // analyze: evidence quoting a recommendation claim is rejected
  const source = await loadSource(SAMPLE);
  const digest = { title: 't', topic: 'x', claims: [{ id: 'cl9', type: 'recommendation', statement: 'Stage when volume exceeds capacity.', span: 'If the aesthetic goal requires more fat than can be placed in the subcutaneous layer, the surgeon should consider staging', section: 'discussion', attribution: 'this_work', importance: 'i' }] };
  const steps = parsePath('recall(2) > analyze');
  const src = { ...source, digest };
  const rctx = { source: src, path: steps, step: steps[0], priorSteps: [], artifacts: {} };
  const recall = OPS.recall.mock({ ...rctx, source });
  const actx = { source: src, path: steps, step: steps[1], priorSteps: [steps[0]], artifacts: { recall } };
  const rel = OPS.analyze.mock(actx);
  rel.relations[0].evidenceSpan = 'the surgeon should consider staging the procedure rather than injecting into muscle if the aesthetic goal requires more fat than can be placed in the subcutaneous layer';
  assert.ok(OPS.analyze.verify(rel, actx).some((p) => /quotes recommendation cl9/.test(p)));
  // in-loop: synthesize refuses a plan entailed by the recommendations (mock entailment reports not entailed → no problem; entailed → problem)
  const notes = notesFromClaims(digest.claims, 'recs');
  const r = await entailedByNotes({ statement: 'Stage the procedure.', notes, mockEntailed: false });
  assert.equal(r.entailed, false);
  const sctx = { source: src, path: parsePath('recall(2) > analyze > evaluate(a, b) > synthesize(plan)'), step: { id: 'synthesize', op: 'synthesize', index: 3, params: { form: 'plan' } }, priorSteps: [], artifacts: {} };
  const out = await OPS.synthesize.verifyAsync({ synthesis: { statement: 'Stage the procedure.' } }, sctx, { mock: true });
  assert.equal(out.skipped, false);
  assert.deepEqual(out.problems, []);
  const none = await OPS.synthesize.verifyAsync({ synthesis: { statement: 'x' } }, { ...sctx, source }, { mock: true });
  assert.equal(none.skipped, true);
  const { ASSEMBLE } = await import('../core/ops/index.js');
  const asm = await ASSEMBLE.verifyAsync({ options: [{ text: 'Stage it.', failsAt: 'none' }, { text: 'Do not.', failsAt: 'recall' }] }, sctx, { mock: true });
  assert.equal(asm.skipped, false);
  assert.deepEqual(asm.problems, []);
  assert.equal((await ASSEMBLE.verifyAsync({ options: [{ text: 'x', failsAt: 'none' }] }, { ...sctx, source }, { mock: true })).skipped, true);
});

test('item form: odd-one-out tail clause, option length cap, constraint in the vignette voice', async () => {
  const { itemShapeProblems, default: ASSEMBLE } = await import('../core/ops/assemble.js');
  const { OPS } = await import('../core/ops/index.js');
  const mk = (texts, keyIdx) => ({ stem: 'S', leadIn: 'Q?', options: texts.map((t, i) => ({ text: t, isKey: i === keyIdx })) });
  const same = 'and accept the complete augmentation as the final single-session result';
  const odd = mk([`Inject into muscle ${same}`, `Inject only superficial and stop short of the requested volume now`, `Inject beyond compliance ${same}`, `Fill to capacity then muscle ${same}`, `Inject deep central muscle ${same}`], 1);
  assert.ok(itemShapeProblems(odd).some((p) => /odd-one-out cue/.test(p)));
  const fine = mk(['Inject into muscle and accept the full volume as the result', 'Inject only superficial and stop short of the requested volume', 'Inject beyond compliance and accept the full volume as the result', 'Fill to capacity then add muscle for the remaining requested volume', 'Inject deep central muscle and accept the full requested volume'], 1);
  assert.ok(!itemShapeProblems(fine).some((p) => /odd-one-out/.test(p)));
  const long = mk(['a '.repeat(40).trim(), 'b '.repeat(38).trim(), 'c '.repeat(39).trim(), 'd '.repeat(37).trim()], 0);
  assert.ok(itemShapeProblems(long).some((p) => /longer than 25 words/.test(p)));
  // constraint must be carried in the vignette's voice, not pasted as "A patient requests …"
  const source = await loadSource(SAMPLE);
  const steps = parsePath('recall(2) > analyze > evaluate(a, b) > synthesize(plan)');
  const artifacts = {};
  for (const [i, s] of steps.entries()) artifacts[s.op === 'synthesize' ? 'synthesize' : s.id] = OPS[s.op].mock({ source, path: steps, step: s, priorSteps: steps.slice(0, i), artifacts });
  const ctx = { source, path: steps, step: { id: 'assemble', op: 'assemble', index: 4, params: {} }, priorSteps: steps, artifacts };
  const good = ASSEMBLE.mock(ctx);
  assert.deepEqual(ASSEMBLE.verify(good, ctx), []);
  const pasted = { ...good, stem: 'She is a 30-year-old woman who is healthy. A patient requests single-session augmentation and declines a second stage.', constraintSpan: 'A patient requests single-session augmentation and declines a second stage.' };
  const probs = ASSEMBLE.verify(pasted, ctx);
  assert.ok(probs.some((p) => /vignette's voice/.test(p)), probs.join('; '));
  const unrelated = { ...good, constraintSpan: 'She is healthy with no prior surgery.', stem: good.stem + ' She is healthy with no prior surgery.' };
  assert.ok(ASSEMBLE.verify(unrelated, ctx).some((p) => /does not carry the case constraint/.test(p)));
});

test('running headers are stripped, cross-page spans are located, pages are filled on load, and approval ignores annotations', async () => {
  const fs = await import('node:fs');
  const { stripRunningLines } = await import('../core/source.js');
  const { locateSpan, ingestSource } = await import('../core/ingest.js');
  const { saveIngest, loadIngest, approveIngest } = await import('../core/store.js');
  const bodies = ['Vitamin D modulates glycemic control through activation of insulin receptor expression.', 'Arginine is a precursor to nitric oxide and proline, both required for collagen synthesis.', 'Glutamine fuels enterocytes, lymphocytes, fibroblasts and macrophages in wound healing.', 'Omega-3 fatty acids improve wound healing and glucose homeostasis in several studies.'];
  const pages = bodies.map((b, i) => ({ num: i + 1, text: `Copyright © 2020 Society. Unauthorized reproduction of this article is prohibited.\nVolume 146, Number 2 • Recommendations ${421 + i}\n${b}\n-- ${i + 1} of 13 --\n${421 + i}` }));
  const clean = stripRunningLines(pages);
  assert.equal(clean[0].text, bodies[0]);
  assert.equal(clean[3].text, bodies[3]);
  // a span that straddles a page break resolves to the first page
  const split = [{ num: 1, text: 'alpha beta gamma delta epsilon zeta' }, { num: 2, text: 'eta theta iota kappa lambda mu nu' }];
  assert.equal(locateSpan('delta epsilon zeta eta theta iota', split), 1);
  assert.equal(locateSpan('theta iota kappa lambda', split), 2);
  // claims saved without a page get one on load; approval hash ignores page and audit annotations
  const raw = await loadSource({ title: 'Pages probe', text: 'Retrobulbar hematoma is a surgical emergency that threatens vision within hours. Lateral canthotomy with inferior cantholysis decompresses the orbit. Mannitol and acetazolamide lower intraocular pressure while surgical release is arranged.' });
  const result = await ingestSource(raw, { maxClaims: 8 });
  for (const c of result.digest.claims) delete c.page;
  const { dir } = await saveIngest({ source: raw, result, model: 'mock' });
  try {
    const ing = await loadIngest(raw.sha);
    assert.ok(ing.digest.claims.every((c) => c.page === 1));
    await approveIngest(raw.sha, { by: 't', certifyPending: true });
    const p = path.join(dir, 'digest.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    d.claims[0].page = 7; d.claims[0].auditFix = { field: 'type', before: 'result', after: 'background' };
    fs.writeFileSync(p, JSON.stringify(d));
    assert.equal((await loadIngest(raw.sha)).status, 'approved');
    d.claims[0].statement += ' changed';
    fs.writeFileSync(p, JSON.stringify(d));
    assert.equal((await loadIngest(raw.sha)).status, 'modified');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('picker judgment: a mis-cited quote is re-attributed to the note that holds it; a clause the notes do not carry overrides the pick; stored records re-score locally', async () => {
  const { judgePick, notesFor } = await import('../core/verifier.js');
  const { clauseSupported } = await import('../core/textmatch.js');
  const { rescoreBuild } = await import('../core/rescore.js');
  // a long clause needs two shared content words even against a quote; a short one needs one; a whole note needs half
  assert.equal(clauseSupported('Maintain current volume and supervision thresholds', 'differences in respondent pool and volume are competing explanations'), false);
  assert.equal(clauseSupported('Maintain current volume and supervision thresholds', 'maintain the current supervision rules and volume floors'), true);
  assert.equal(clauseSupported('2-of-3 lethality', '2 of which were fatal'), true);
  assert.equal(clauseSupported('Maintain current volume and supervision thresholds', 'differences in respondent pool and volume are competing explanations', 0.5), false);
  assert.equal(clauseSupported('withhold gluteal grafting unless she accepts it', 'Withhold gluteal fat grafting and do not schedule surgery unless she explicitly accepts this small residual lethal risk', 0.5), true);
  const artifacts = {
    recall: { concepts: [{ id: 'c1', statement: 'Zero emboli occurred in 12172 cases.', sourceSpan: 'zero emboli in 12 172 cases', claims: ['cl1'] }], topic: 't' },
    analyze: { relations: [{ id: 'r1', between: ['c1', 'c1'], claim: 'An observed zero leaves a small residual probability of embolism.', implication: 'A fall to zero looks less convincing once volume differences are recognized.', evidenceSpan: 'x', kind: 'causal', commonMisreading: 'm' }] },
    synthesize: { synthesis: { statement: 'Withhold gluteal fat grafting and do not schedule surgery unless she explicitly accepts this small residual lethal risk.', integrates: ['c1', 'r1'], novelElement: 'withholds' }, incompleteAlternatives: [] },
  };
  const path = [{ id: 'recall', op: 'recall' }, { id: 'analyze', op: 'analyze' }, { id: 'synthesize', op: 'synthesize' }];
  const k3 = notesFor(artifacts, path);
  // picker quoted the synthesize note but named r1: re-attributed, pick stands
  const miscited = { choice: 'A', entailment: [{ optionId: 'A', fullyEntailed: true, citedNotes: ['r1'], evidence: [{ clause: 'withhold grafting unless she accepts the residual lethal risk', noteId: 'r1', quote: 'Withhold gluteal fat grafting and do not schedule surgery unless she explicitly accepts this small residual lethal risk' }], missingClause: '' }] };
  const j1 = judgePick(miscited, k3);
  assert.equal(j1.choice, 'A'); assert.equal(j1.override, null); assert.deepEqual(j1.citationsFixed.map((c) => c.found), ['synthesize']);
  // at k2 the same clause has no note carrying half its content: overridden
  const k2 = notesFor(artifacts, path.slice(0, 2));
  const weak = { choice: 'A', entailment: [{ optionId: 'A', fullyEntailed: true, citedNotes: ['r1'], evidence: [{ clause: 'Maintain current volume and supervision thresholds', noteId: 'r1', quote: 'A fall to zero looks less convincing once volume differences are recognized.' }], missingClause: '' }] };
  const j2 = judgePick(weak, k2);
  assert.equal(j2.choice, 'UNDETERMINED'); assert.match(j2.override, /do not carry the content/);
  // a quote found nowhere is still a leak
  const j3 = judgePick({ choice: 'A', entailment: [{ optionId: 'A', fullyEntailed: true, citedNotes: ['r1'], evidence: [{ clause: 'maintain thresholds', noteId: 'r1', quote: 'keep the thresholds where they are' }], missingClause: '' }] }, k3);
  assert.equal(j3.choice, 'UNDETERMINED'); assert.match(j3.override, /not found in any note/);
  // rescore: a record whose k2 pick stood under the old rule and whose k3 pick was overridden for the mis-citation flips to determinedAt 3 = pass
  const item = { stem: 's', leadIn: 'q', key: 'A', options: [{ id: 'A', text: 'a', isKey: true }, { id: 'B', text: 'b', isKey: false, failsAt: 'recall' }] };
  const picks = [
    { k: 0, steps: [], raw: 'UNDETERMINED', choice: 'UNDETERMINED', override: null, entailment: [] },
    { k: 1, steps: ['recall'], raw: 'UNDETERMINED', choice: 'UNDETERMINED', override: null, entailment: [] },
    { k: 2, steps: ['recall', 'analyze'], raw: 'A', choice: 'A', override: null, entailment: weak.entailment },
    { k: 3, steps: ['recall', 'analyze', 'synthesize'], raw: 'A', choice: 'UNDETERMINED', override: 'quoted evidence not found in the cited notes', entailment: miscited.entailment },
  ];
  const build = { id: 'build-test', source: { sha: 'nope', title: 't' }, items: [{ plan: { id: 'item1' }, status: 'done', trace: { item, path, artifacts }, verification: { grounding: { skipped: true }, coverTheOptions: { pass: true }, sourceRecall: { skipped: true }, digestRecall: { skipped: true }, pathNecessity: { picks, key: 'A', pathLength: 3, determinedAt: 2, pass: false }, distractorMapping: null, summary: { passed: 1, applicable: 2, pass: false } } }], baselines: [] };
  const r = await rescoreBuild(build);
  const pn = build.items[0].verification.pathNecessity;
  assert.equal(pn.determinedAt, 3); assert.equal(pn.pass, true);
  assert.equal(build.items[0].verification.summary.pass, true);
  assert.equal(r.digestAvailable, false);
  assert.ok(r.changes.some((c) => /k2: A → UNDETERMINED/.test(c.what)) && r.changes.some((c) => /k3: UNDETERMINED → A/.test(c.what)));
});
