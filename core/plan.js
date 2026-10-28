/**
 * PLAN: from one approved digest, design N distinct items: for each, a focus (the decision the item turns
 * on), a cognitive path in the DSL, and a reserved set of claims that no other item in the build may use
 * for its recall step. Reserved sets are disjoint, so N items from one article test N different things
 * and the build reports a coverage map (which claims each item rests on, and which went unused).
 */
import { obj, arr, str, assertStrict, validate } from './schema.js';
import { complete, part } from './meta.js';
import { PREAMBLE } from './executor.js';
import { parsePath, formatPath, PathError } from './path.js';
import { describeOps, OPS } from './ops/index.js';

export const PLAN_SCHEMA = assertStrict(obj({
  plans: arr(obj({
    id: str('item1, item2, …'),
    focus: str('The decision or judgment this item turns on, one sentence, as a domain ("choice of injection plane for volume goals", "how to counsel on what a zero-event period proves"); NOT a patient scenario: the specific case is designed later by the synthesize step'),
    path: str('Cognitive path in the DSL, e.g. recall(3) > analyze(causal) > evaluate(efficacy, safety) > synthesize(management plan)'),
    claims: arr(str('claim id (cl*)'), 'Claims reserved for this item\'s recall step: 3 to 6 ids, disjoint from every other plan, premises only (result, interpretation, method, limitation, background); recommendation claims are shared context and are never reserved', { minItems: 1 }),
    rationale: str('Why these claims and this path make a different item from the others (one sentence)'),
  }), 'Exactly the requested number of plans'),
}));

function opsMenu() {
  return describeOps().map((op) => `- ${op.id}: ${op.description} Params: ${op.params.map((p) => `${p.name}: ${p.type}${p.values ? ' (' + p.values.join(' | ') + ')' : ''}${p.default !== undefined ? ', default ' + JSON.stringify(p.default) : ''}`).join('; ') || 'none'}`).join('\n');
}

const PATH_GRAMMAR = `Path grammar (exact):
  recall(N)                              N = how many facts to recall, an integer 2 to 5. Nothing else goes in the parentheses: the reserved claim ids go in the "claims" field, never in the path.
  analyze(KIND)                          KIND = one of ${OPS.analyze.params.kind.values.join(' | ')}
  evaluate(CRITERION, CRITERION, …)      two or three criteria in priority order, plain words (efficacy, safety, cost, speed, durability, …)
  synthesize(FORM)                       FORM = the artifact to produce (management plan, protocol, recommendation, counseling plan, …)
Valid examples:
  recall(3) > analyze(causal) > evaluate(efficacy, safety) > synthesize(management plan)
  recall(4) > analyze(comparison) > evaluate(safety, durability, cost) > synthesize(operative protocol)
  recall(3) > analyze(mechanism) > evaluate(risk, benefit) > synthesize(counseling plan)`;

/**
 * Deterministic repair of the paths models tend to write: claim ids or words inside recall(), an analyze kind
 * outside the enum, missing parentheses. Returns the repaired text, or the original when nothing applied.
 */
export function repairPath(text, reserved = []) {
  let t = String(text ?? '').trim();
  const kinds = OPS.analyze.params.kind.values;
  const n = Math.max(2, Math.min(4, reserved.length || 3));
  t = t.replace(/\brecall(?:\s*\(([^)]*)\))?/i, (m, args) => {
    const a = (args ?? '').trim();
    if (/^\d+$/.test(a)) return `recall(${Math.max(2, Math.min(5, Number(a)))})`;
    const kv = a.match(/concepts\s*=\s*(\d+)/i);
    return `recall(${kv ? Math.max(2, Math.min(5, Number(kv[1]))) : n})`;
  });
  t = t.replace(/\banalyze(?:\s*\(([^)]*)\))?/i, (m, args) => {
    const a = (args ?? '').trim().toLowerCase();
    const hit = kinds.find((k) => a.split(/[,\s=]+/).includes(k)) ?? kinds.find((k) => a.includes(k));
    return hit ? `analyze(${hit})` : 'analyze';
  });
  t = t.replace(/synthesize\s*\(\s*\)/i, 'synthesize');
  return t;
}

/** The path each item is held to when the user composed paths: item i gets paths[i % paths.length]. */
export function assignPaths(n, paths) {
  if (!paths?.length) return null;
  const normalized = paths.map((p) => formatPath(parsePath(p)));
  return Array.from({ length: n }, (_, i) => normalized[i % normalized.length]);
}

export function planInstruction({ n, paths, claims }) {
  const byType = {};
  for (const c of claims) byType[c.type] = (byType[c.type] ?? 0) + 1;
  const assigned = assignPaths(n, paths);
  return `Design ${n} DISTINCT assessment items from this digest. For each, choose a focus (the decision or judgment the item turns on)${assigned ? '' : ', a cognitive path'}, and the claims the item's RECALL step may rest on.

Cognitive operations available (every path starts with recall and ends with synthesize; each op requires the one before it):
${opsMenu()}

${PATH_GRAMMAR}
${assigned ? `\nThe path of each item is FIXED by the item designer; copy it exactly into the plan's path field and choose a focus and claims that suit it:\n${assigned.map((p, i) => `- item${i + 1}: ${p}`).join('\n')}` : '\nVary analyze kinds and evaluate criteria across items so the items differ in the thinking they demand, not only in the facts they rest on.'}

Rules:
- Reserved claims are DISJOINT across plans: no claim id appears in two plans. Reserve 3 to 6 per item from the PREMISE claims (result, interpretation, limitation, method, background; ${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')} available). Never reserve a recommendation claim: the recall step is forbidden from using recommendations, so a reserved one is wasted; recommendations stay visible to every item as shared context.
- Focuses must be distinct decisions, not the same decision from different angles, and each focus is a decision DOMAIN, not a patient scenario (no ages, presentations, or requests): the synthesize step designs the specific case later, and a scenario in the focus pre-empts it.
- Across the set, prefer decisions that the premises settle differently from how a learner who only knows the source's recommendations would answer; an item whose answer is simply one of the recommendations tests recall of the source, not reasoning.
- Prefer items that a competent practitioner could get wrong by reasoning badly over items that only test whether a figure was remembered.
Ids are item1 … item${n}.`;
}

/** Local checks on a plan set; returns { problems, plans } with parsed paths attached. */
export function checkPlans(json, { n, claims, paths }) {
  const problems = [];
  const known = new Map(claims.map((c) => [c.id, c]));
  const seen = new Map();
  const plans = [];
  const assigned = assignPaths(n, paths);
  if (json.plans.length !== n) problems.push(`expected ${n} plans, got ${json.plans.length}`);
  for (let [i, p] of json.plans.entries()) {
    let steps = null;
    let pathText = p.path;
    // A composed path is the designer's decision: whatever the planner wrote, the item runs the assigned path.
    if (assigned) { const want = assigned[i] ?? assigned[0]; if (pathText !== want) p = { ...p, path: want, plannerPath: p.path, pathAssigned: true }; pathText = want; }
    try { steps = parsePath(pathText); }
    catch {
      pathText = repairPath(p.path, p.claims);
      try { steps = parsePath(pathText); }
      catch (e) { problems.push(`${p.id}: path "${p.path}" does not parse: ${e instanceof PathError ? e.message : e.message}. Follow the grammar exactly, e.g. recall(3) > analyze(causal) > evaluate(efficacy, safety) > synthesize(management plan)`); }
    }
    if (steps && pathText !== p.path) p = { ...p, path: pathText, repairedFrom: p.path };
    if (steps && steps[0]?.op !== 'recall') problems.push(`${p.id}: path must start with recall`);
    if (steps && steps[steps.length - 1]?.op !== 'synthesize') problems.push(`${p.id}: path must end with synthesize`);
    const unknown = p.claims.filter((id) => !known.has(id));
    if (unknown.length) problems.push(`${p.id}: unknown claim(s) ${unknown.join(', ')}`);
    for (const id of p.claims) { if (seen.has(id)) problems.push(`${p.id}: claim ${id} is already reserved by ${seen.get(id)}`); seen.set(id, p.id); }
    if (p.claims.length < 3 || p.claims.length > 6) problems.push(`${p.id}: reserve 3 to 6 claims (got ${p.claims.length})`);
    const recs = p.claims.filter((id) => known.get(id)?.type === 'recommendation');
    if (recs.length) problems.push(`${p.id}: reserved recommendation claim(s) ${recs.join(', ')}; reserve premise claims only`);
    if (/\b(\d{1,2}[- ]year[- ]old|presents|patient who|a (woman|man|patient) (with|who))\b/i.test(p.focus)) problems.push(`${p.id}: focus describes a patient scenario; state the decision domain instead`);
    plans.push({ ...p, steps, pathText: steps ? formatPath(steps) : p.path });
  }
  const focuses = json.plans.map((p) => p.focus.toLowerCase().trim());
  if (new Set(focuses).size !== focuses.length) problems.push('two plans share the same focus');
  return { problems, plans };
}

/** One planning call (plus one repair attempt). Returns { plans, usage, ms, attempts }. */
export async function planItems({ source, n, paths, pathHint, model, label = 'plan' }) {
  const claims = source.digest?.claims ?? [];
  if (!claims.length) throw new Error('planning needs a digest with claims');
  if (!paths?.length && pathHint) paths = [pathHint];
  const instruction = planInstruction({ n, paths, claims });
  const attempts = [];
  let feedback = '';
  let best = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await complete({
      instructions: PREAMBLE, parts: [...source.parts, part.text(instruction + feedback)],
      schema: PLAN_SCHEMA, schemaName: 'item_plans', effort: 'medium', model, maxOutputTokens: 16384, summary: 'auto', label: `${label}:${attempt}`, cacheKey: source.cacheKey,
      mock: () => mockPlans({ n, claims, pathHint: paths?.[0] }),
    });
    const v = validate(PLAN_SCHEMA, res.json);
    const schemaProblems = v.ok ? [] : v.errors.map((e) => `schema: ${e}`);
    const { problems, plans } = v.ok ? checkPlans(res.json, { n, claims, paths }) : { problems: [], plans: [] };
    attempts.push({ attempt, usage: res.usage, ms: res.ms, problems: [...schemaProblems, ...problems] });
    const all = [...schemaProblems, ...problems];
    best = { plans, problems: all, usage: res.usage, ms: res.ms, reasoningSummary: res.reasoningSummary, mock: res.mock };
    if (res.mock || all.length === 0) break;
    feedback = `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED; FIX ALL OF THESE AND RETURN ALL ${n} PLANS:\n- ${all.join('\n- ')}`;
  }
  if (best.problems.length) throw new Error(`planning failed: ${best.problems.join('; ')}`);
  return { ...best, attempts };
}

function mockPlans({ n, claims, pathHint }) {
  const usable = claims.filter((c) => c.type !== 'recommendation');
  const per = Math.max(3, Math.min(6, Math.floor(usable.length / Math.max(1, n))));
  const kinds = ['causal', 'contrast', 'mechanism', 'comparison'];
  return {
    plans: Array.from({ length: n }, (_, i) => ({
      id: `item${i + 1}`,
      focus: `[MOCK] Decision ${i + 1} about the topic`,
      path: pathHint || `recall(3) > analyze(${kinds[i % kinds.length]}) > evaluate(efficacy, safety) > synthesize(management plan)`,
      claims: usable.slice(i * per, i * per + per).map((c) => c.id),
      rationale: `[MOCK] Rests on a different claim set and analyze kind.`,
    })),
  };
}
