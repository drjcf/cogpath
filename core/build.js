/**
 * BUILD: N items from one approved digest. Plan (focus, path, reserved claims per item, disjoint), run each
 * item through its path with recall held to its reserved claims, verify, optionally build a single-shot
 * baseline item on the same focus for comparison, and report coverage (which claims each item rests on,
 * which were never used). Never throws away finished items: a failed item is recorded and the build goes on.
 */
import { planItems } from './plan.js';
import { withFocus } from './source.js';
import { runPath, newId, sumUsage } from './executor.js';
import { verifyItem } from './verifier.js';
import { runBaseline, verifyBaseline } from './baseline.js';

/** Which claims each item's recall concepts cite, and which digest claims no item used. */
export function coverageMap(digest, items) {
  const used = new Map();
  for (const it of items) {
    const ids = new Set();
    for (const c of it.trace?.artifacts?.recall?.concepts ?? []) for (const id of c.claims ?? []) ids.add(id);
    for (const st of Object.values(it.trace?.artifacts ?? {})) for (const id of st?.caseConstraint?.derivedFrom ?? []) if (/^cl\d+$/.test(id)) ids.add(id);
    used.set(it.plan.id, [...ids]);
  }
  const all = new Set(digest.claims.map((c) => c.id));
  const touched = new Set([...used.values()].flat());
  const byType = {};
  for (const c of digest.claims) { byType[c.type] = byType[c.type] ?? { total: 0, used: 0 }; byType[c.type].total++; if (touched.has(c.id)) byType[c.type].used++; }
  return { perItem: Object.fromEntries(used), unused: [...all].filter((id) => !touched.has(id)), usedCount: touched.size, total: all.size, byType };
}

export async function buildItems({ source, n, paths, pathHint, model, deep = false, baseline = false, seed, id: givenId, onEvent }) {
  const id = givenId ?? newId('build');
  const t0 = Date.now();
  if (!paths?.length && pathHint) paths = [pathHint];
  const build = { id, status: 'running', createdAt: new Date().toISOString(), model, source: { title: source.title, sha: source.sha ?? null, mode: source.mode, claims: source.digest?.claims?.length ?? 0, digestReview: source.digestReview ?? null }, n, pathHint: paths?.[0] ?? null, paths: paths ?? null, pathMode: paths?.length ? 'composed' : 'planner', deep, plan: null, items: [], baselines: [], coverage: null, totals: null, error: null };
  try {
    onEvent?.({ type: 'plan:start', n });
    const plan = await planItems({ source, n, paths, model });
    build.plan = { plans: plan.plans.map(({ steps, ...p }) => p), usage: plan.usage, ms: plan.ms, attempts: plan.attempts, reasoningSummary: plan.reasoningSummary };
    onEvent?.({ type: 'plan:done', plans: plan.plans, usage: plan.usage, ms: plan.ms });

    const usedConstraints = [];
    for (const [i, p] of plan.plans.entries()) {
      const focused = withFocus(source, p, { usedConstraints });
      const itemSeed = (seed ?? 1) + i;
      onEvent?.({ type: 'item:start', plan: p, index: i });
      const trace = await runPath({ source: focused, path: p.steps, model, onEvent, seed: itemSeed });
      const cc = trace.path.map((st) => trace.artifacts[st.id]?.caseConstraint).filter(Boolean).pop();
      if (cc) usedConstraints.push({ item: p.id, feature: cc.feature });
      const rec = { plan: { id: p.id, focus: p.focus, path: p.pathText, claims: p.claims }, traceId: trace.id, status: trace.status, trace, verification: null, error: trace.error };
      if (trace.status === 'done') {
        try { rec.verification = await verifyItem({ trace, source: focused, model, deep, onEvent }); trace.verification = rec.verification; }
        catch (e) { rec.status = 'verify-failed'; rec.error = { message: e.message }; }
      }
      build.items.push(rec);
      onEvent?.({ type: 'item:done', plan: p, trace, verification: rec.verification, status: rec.status });

      if (baseline) {
        onEvent?.({ type: 'baseline:start', plan: p });
        try {
          const b = await runBaseline({ source: focused, focus: p.focus, model, seed: itemSeed, label: `baseline:${p.id}` });
          b.verification = await verifyBaseline({ trace: b, source: focused, model });
          build.baselines.push({ plan: { id: p.id, focus: p.focus }, traceId: b.id, status: 'done', trace: b, verification: b.verification, error: null });
          onEvent?.({ type: 'baseline:done', plan: p, trace: b, verification: b.verification });
        } catch (e) {
          build.baselines.push({ plan: { id: p.id, focus: p.focus }, traceId: null, status: 'failed', trace: null, verification: null, error: { message: e.message } });
          onEvent?.({ type: 'baseline:done', plan: p, trace: null, verification: null, status: 'failed', error: e.message });
        }
      }
    }
    build.coverage = coverageMap(source.digest, build.items);
    build.status = build.items.every((it) => it.status === 'done') ? 'done' : 'partial';
  } catch (err) {
    build.status = 'failed';
    build.error = { message: err.message, name: err.name };
  }
  build.totals = { ...buildTotals(build), ms: Date.now() - t0 };
  return build;
}

/** Token and call totals across planning, every item (steps + assemble + verification picks are not counted here: see each trace), and baselines. */
export function buildTotals(build) {
  const u = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, calls: 0 };
  const add = (x) => { if (!x) return; u.input_tokens += x.input_tokens ?? 0; u.output_tokens += x.output_tokens ?? 0; u.cached_tokens += x.cached_tokens ?? 0; u.reasoning_tokens += x.reasoning_tokens ?? 0; u.calls += x.calls ?? 1; };
  add(build.plan?.usage);
  for (const it of build.items) add(it.trace?.totals);
  for (const b of build.baselines) add(b.trace?.totals);
  return u;
}

/** Side-by-side summary rows for the CLI and the report. */
export function summarize(build) {
  const rows = build.items.map((it) => {
    const v = it.verification;
    const b = build.baselines.find((x) => x.plan.id === it.plan.id);
    const bv = b?.verification;
    return {
      id: it.plan.id, focus: it.plan.focus, path: it.plan.path, status: it.status,
      necessity: v ? (v.pathNecessity.pass ? 'pass' : `k${v.pathNecessity.determinedAt ?? '?'}/${v.pathNecessity.pathLength}`) : '',
      sourceRecall: v ? (v.sourceRecall.skipped ? 'n/a' : v.sourceRecall.pass ? 'pass' : 'FAIL') : '',
      digestRecall: v ? (!v.digestRecall || v.digestRecall.skipped ? 'n/a' : v.digestRecall.pass ? 'pass' : 'FAIL') : '',
      mapping: v?.distractorMapping ? `${v.distractorMapping.keyBlocked}/${v.distractorMapping.total}` : '',
      cover: v ? (v.coverTheOptions.pass ? 'pass' : 'FAIL') : '',
      pass: v ? `${v.summary.passed}/${v.summary.applicable}` : '',
      baseline: bv ? { sourceRecall: bv.sourceRecall.skipped ? 'n/a' : bv.sourceRecall.pass ? 'pass' : 'FAIL', digestRecall: !bv.digestRecall || bv.digestRecall.skipped ? 'n/a' : bv.digestRecall.pass ? 'pass' : 'FAIL', cover: bv.coverTheOptions.pass ? 'pass' : 'FAIL', form: bv.form.pass ? 'pass' : 'FAIL', grounding: bv.grounding.skipped ? 'n/a' : `${bv.grounding.found}/${bv.grounding.checked}`, pass: `${bv.summary.passed}/${bv.summary.applicable}` } : (b ? { error: b.error?.message } : null),
      tokens: it.trace?.totals ? { in: it.trace.totals.input_tokens, out: it.trace.totals.output_tokens } : null,
    };
  });
  const done = rows.filter((r) => r.status === 'done');
  const rate = (rowsIn, f) => (rowsIn.length ? `${rowsIn.filter(f).length}/${rowsIn.length}` : 'n/a');
  const srRows = done.filter((r) => r.sourceRecall !== 'n/a');
  const drRows = done.filter((r) => r.digestRecall !== 'n/a');
  const bRows = rows.filter((r) => r.baseline && !r.baseline.error);
  const bsrRows = bRows.filter((r) => r.baseline.sourceRecall !== 'n/a');
  const bdrRows = bRows.filter((r) => r.baseline.digestRecall !== 'n/a');
  return {
    rows,
    rates: {
      necessity: rate(done, (r) => r.necessity === 'pass'),
      sourceRecall: rate(srRows, (r) => r.sourceRecall === 'pass'),
      digestRecall: rate(drRows, (r) => r.digestRecall === 'pass'),
      allChecks: rate(done, (r) => r.pass && r.pass.split('/')[0] === r.pass.split('/')[1]),
      baselineSourceRecall: build.baselines.length ? rate(bsrRows, (r) => r.baseline.sourceRecall === 'pass') : null,
      baselineDigestRecall: build.baselines.length ? rate(bdrRows, (r) => r.baseline.digestRecall === 'pass') : null,
      baselineForm: build.baselines.length ? rate(bRows, (r) => r.baseline.form === 'pass') : null,
      baselineCover: build.baselines.length ? rate(bRows, (r) => r.baseline.cover === 'pass') : null,
    },
    coverage: build.coverage,
    totals: build.totals,
  };
}

export { sumUsage };
