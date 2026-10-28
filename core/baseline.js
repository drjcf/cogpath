/**
 * SINGLE-SHOT BASELINE: the control arm for the path-compiled items. One call is asked for a board-style
 * item on the same focus, from the same digest, with the same stem and option rules, and told to require
 * recall, analysis, evaluation, and synthesis. It gets no cognitive path, no artifacts, no step verification.
 * The same item-level checks are then run on it (grounding of its evidence spans, cover-the-options,
 * source recall, form). Path necessity and distractor mapping cannot be run: there are no step artifacts,
 * which is the point of the comparison.
 */
import { obj, arr, str, bool, assertStrict, validate } from './schema.js';
import { complete, part } from './meta.js';
import { PREAMBLE } from './executor.js';
import { itemShapeProblems } from './ops/assemble.js';
import { verifyCoverTheOptions, verifySourceRecall, verifyDigestRecall, spanFound } from './verifier.js';
import { newId } from './executor.js';

export const BASELINE_SCHEMA = assertStrict(obj({
  stem: str('A vignette: one specific case as a learner would meet it, 3–6 sentences. No recalled figures, rates, mechanisms, judgments, or plans; no reference to any source.'),
  leadIn: str('One focused question about this case'),
  options: arr(obj({
    text: str('Option text; all options parallel in form and length'),
    isKey: bool('true for exactly one option'),
    rationale: str('Why this option is right or wrong (one sentence)'),
  }), 'Exactly 5 options, one key'),
  evidence: arr(str('Verbatim quotation (≤ 40 words) from the source supporting a fact the item depends on'), 'The source facts the item rests on, quoted verbatim'),
  explanation: str('What the learner must recall, analyze, evaluate, and synthesize to reach the key (3–5 sentences)'),
}));

export function baselineInstruction({ focus }) {
  return `Write ONE single-best-answer item for specialty board examinees${focus ? ` on this focus: ${focus}` : ''}.
The item must require the examinee to recall the relevant facts, analyze the causal relations among them, evaluate competing strategies, and synthesize a plan adapted to the specific case. Make the correct answer depend on all four, not on remembering a recommendation.

Rules:
- The stem is a vignette: one specific case (presentation, history, findings, setting). It states none of the facts, figures, rates, mechanisms, judgments, or plans the examinee must bring. Never refer to "the article", "the study", or "the source".
- Exactly 5 options, exactly one correct. Options are homogeneous: same grammatical form, at most 3 clauses, lengths within 25% of each other; the key is not the longest or most complete option. No absolute terms; no "all/none of the above".
- Each wrong option must be the plan a learner would choose after one specific error of reasoning.
- Quote, verbatim, the source facts the item rests on in "evidence".`;
}

export function letterBaseline(json, seed = 1) {
  let h = seed >>> 0 || 1;
  const rnd = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 0x100000000; };
  const opts = json.options.map((o) => ({ ...o }));
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
  const options = opts.map((o, i) => ({ id: 'ABCDEFGHIJ'[i], text: o.text, isKey: Boolean(o.isKey), failsAt: o.isKey ? 'none' : 'unknown', rationale: o.rationale }));
  return { stem: json.stem, leadIn: json.leadIn, options, key: options.find((o) => o.isKey)?.id ?? null, evidence: json.evidence, explanation: json.explanation };
}

export function baselineProblems(json) {
  const problems = [];
  const keys = json.options.filter((o) => o.isKey).length;
  if (keys !== 1) problems.push(`expected exactly 1 key, got ${keys}`);
  if (json.options.length !== 5) problems.push(`expected 5 options, got ${json.options.length}`);
  if (!json.evidence?.length) problems.push('no evidence quoted');
  problems.push(...itemShapeProblems({ stem: json.stem, leadIn: json.leadIn, options: json.options }));
  return problems;
}

/** One single-shot item with one repair attempt. Returns a trace-like record { id, kind:'baseline', item, usage, ms, problems, attempts }. */
export async function runBaseline({ source, focus, model, seed, label = 'baseline' }) {
  const id = newId('base');
  const t0 = Date.now();
  const instruction = baselineInstruction({ focus });
  const attempts = [];
  let feedback = '';
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await complete({
      instructions: PREAMBLE, parts: [...source.parts, part.text(instruction + feedback)],
      schema: BASELINE_SCHEMA, schemaName: 'baseline_item', effort: 'high', model, maxOutputTokens: 16384, summary: 'auto', label: `${label}:${attempt}`, cacheKey: source.cacheKey,
      mock: () => mockBaseline(source),
    });
    const v = validate(BASELINE_SCHEMA, res.json);
    const problems = v.ok ? baselineProblems(res.json) : v.errors.map((e) => `schema: ${e}`);
    attempts.push({ attempt, problems, usage: res.usage, ms: res.ms });
    last = { json: res.json, problems, usage: res.usage, reasoningSummary: res.reasoningSummary, mock: res.mock, notes: res.notes };
    if (res.mock || problems.length === 0) break;
    feedback = `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED FOR THESE REASONS; FIX ALL OF THEM:\n- ${problems.join('\n- ')}`;
  }
  const item = letterBaseline(last.json, seed ?? 1);
  const usage = attempts.reduce((u, a) => ({ input_tokens: u.input_tokens + (a.usage?.input_tokens ?? 0), output_tokens: u.output_tokens + (a.usage?.output_tokens ?? 0), cached_tokens: u.cached_tokens + (a.usage?.cached_tokens ?? 0), reasoning_tokens: u.reasoning_tokens + (a.usage?.reasoning_tokens ?? 0), calls: u.calls + 1 }), { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, calls: 0 });
  return { id, kind: 'baseline', status: 'done', createdAt: new Date().toISOString(), model, focus: focus ?? null, source: { kind: source.kind, title: source.title, sha: source.sha ?? null, mode: source.mode ?? 'raw' }, item, problems: last.problems, attempts, reasoningSummary: last.reasoningSummary, totals: { ...usage, ms: Date.now() - t0 }, verification: null };
}

/** Item-level checks that apply to any item: evidence grounding, cover-the-options, source recall, form. */
export async function verifyBaseline({ trace, source, model }) {
  const item = trace.item;
  const checks = (item.evidence ?? []).map((span) => ({ span, ...spanFound(span, source.text ?? '') }));
  const grounding = source.text ? { skipped: false, checked: checks.length, found: checks.filter((c) => c.found).length, missing: checks.filter((c) => !c.found), pass: checks.length > 0 && checks.every((c) => c.found) } : { skipped: true, reason: 'no local source text' };
  const coverTheOptions = await verifyCoverTheOptions({ trace, source, model });
  const sourceRecall = await verifySourceRecall({ trace, source, model });
  const digestRecall = await verifyDigestRecall({ trace, source, model });
  const form = { problems: itemShapeProblems(item), pass: itemShapeProblems(item).length === 0 };
  const list = [['grounding', grounding.skipped ? null : grounding.pass], ['coverTheOptions', coverTheOptions.pass], ['sourceRecall', sourceRecall.skipped ? null : sourceRecall.pass], ['digestRecall', digestRecall.skipped ? null : digestRecall.pass], ['form', form.pass]];
  const applicable = list.filter(([, v]) => v !== null);
  return { grounding, coverTheOptions, sourceRecall, digestRecall, form, pathNecessity: null, distractorMapping: null, summary: { passed: applicable.filter(([, v]) => v).length, applicable: applicable.length, pass: applicable.every(([, v]) => v), checks: Object.fromEntries(list) } };
}

function mockBaseline(source) {
  const words = String(source.text ?? '').split(/\s+/);
  return {
    stem: '[MOCK] A patient presents with a specific feature of the case. The setting is an outpatient clinic. A decision is needed now.',
    leadIn: '[MOCK] Which of the following is the most appropriate plan for this patient?',
    options: [
      { text: '[MOCK] The plan that integrates every step of the reasoning.', isKey: true, rationale: '[MOCK] key' },
      { text: '[MOCK] The plan that follows from a misremembered fact here.', isKey: false, rationale: '[MOCK] wrong' },
      { text: '[MOCK] The plan that follows from a misread relation here.', isKey: false, rationale: '[MOCK] wrong' },
      { text: '[MOCK] The plan that follows from the runner-up strategy here.', isKey: false, rationale: '[MOCK] wrong' },
      { text: '[MOCK] The generic plan that ignores the case feature here.', isKey: false, rationale: '[MOCK] wrong' },
    ],
    evidence: [words.slice(5, 14).join(' '), words.slice(30, 40).join(' ')],
    explanation: '[MOCK] Recall, analyze, evaluate, synthesize.',
  };
}
