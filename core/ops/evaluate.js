/**
 * EVALUATE: judge competing options against explicit criteria, using the relations from ANALYZE.
 * The learner must weigh, not just know. The runner-up must be defensible: it seeds the strongest distractor.
 */
import { obj, arr, str, int, assertStrict } from '../schema.js';

const schema = assertStrict(obj({
  decision: str('The decision being evaluated, phrased as a question a practitioner would face'),
  criteria: arr(str(), 'Criteria used, in priority order'),
  options: arr(obj({
    id: str('o1, o2, …'),
    label: str('ATOMIC strategy in at most 8 words: one intervention or approach, with no sequencing, conditions, timing, or adjuncts (e.g. "bedside surgical release", "CT confirmation first", "medical pressure-lowering alone")'),
    derivedFrom: arr(str('relation id from ANALYZE'), 'Relations that make this option a candidate', { minItems: 1 }),
    scores: arr(obj({
      criterion: str(),
      rating: int('1 (poor) to 5 (excellent)', { minimum: 1, maximum: 5 }),
      rationale: str('One sentence tied to a relation or concept'),
    }), 'One score per criterion'),
  }), 'At least two genuinely competing options', { minItems: 2 }),
  best: str('option id'),
  runnerUp: str('option id of the most defensible alternative'),
  decisiveFactor: str('The single consideration that separates best from runnerUp'),
  whyRunnerUpFails: str('Precisely which criterion or relation the runner-up loses on; this becomes a distractor rationale'),
}));

export default {
  id: 'evaluate',
  label: 'Evaluate',
  bloom: 5,
  description: 'Weigh competing options against explicit criteria using the analyzed relations; name the decisive factor.',
  requires: ['analyze'],
  params: {
    criteria: { type: 'list', default: ['benefit', 'risk'], description: 'Criteria to judge against, in priority order', positional: true },
    options: { type: 'integer', default: 3, min: 2, max: 5, description: 'How many competing options to consider' },
  },
  effort: 'high',
  maxOutputTokens: 16384,
  schema,

  instruction(ctx) {
    const { criteria, options } = ctx.step.params;
    return `STEP ${ctx.step.index + 1} of ${ctx.path.length}: EVALUATE.
Frame the decision the recalled facts and analyzed relations bear on, then weigh exactly ${options} genuinely competing options against these criteria in priority order: ${criteria.join(', ')}.

Rules:
- Options are ATOMIC strategies: one intervention or approach each, named in at most 8 words, with NO sequencing ("then"), NO conditions ("if"), NO adjuncts ("with", "plus"), and NO timing qualifiers. Combining, sequencing, and conditioning strategies is the job of the SYNTHESIZE step, not this one. If an option needs an "and", split it or drop the extra.
- Every option must be derivable from at least one relation id (derivedFrom).
- Score every option on every criterion (1–5) with a one-sentence rationale tied to a relation or concept id.
- Every option must be one a competent practitioner might actually choose; no straw men. "best" must win on the highest-priority criterion where the options differ; "runnerUp" must be the STRONGEST competitor, the option a thoughtful learner could defend and some practitioners do choose. Abstention (defer, observe, decline, no treatment) may be the runner-up only when it is itself a defensible strategy for the situation, never as a filler. State the decisive factor and exactly why the runner-up loses.
- Do not let the best option be best on every criterion; real decisions trade off.
- Never refer to "the article", "the study", or "the text".
Option ids are o1 … o${options}.`;
  },

  verify(artifact, ctx) {
    const problems = [];
    const analyze = Object.values(ctx.artifacts).find((a) => a?.relations);
    const relIds = new Set((analyze?.relations ?? []).map((r) => r.id));
    const optIds = new Set(artifact.options.map((o) => o.id));
    if (artifact.options.length !== ctx.step.params.options) problems.push(`expected ${ctx.step.params.options} options, got ${artifact.options.length}`);
    if (!optIds.has(artifact.best)) problems.push(`best '${artifact.best}' is not an option id`);
    if (!optIds.has(artifact.runnerUp)) problems.push(`runnerUp '${artifact.runnerUp}' is not an option id`);
    if (artifact.best === artifact.runnerUp) problems.push('best and runnerUp are the same option');
    for (const o of artifact.options) {
      if (o.label.trim().split(/\s+/).length > 10) problems.push(`${o.id}: label is not atomic (more than 10 words): "${o.label}"`);
      if (/\b(then|if|unless|followed by|plus|with|and|while|after|before|without waiting)\b/i.test(o.label)) problems.push(`${o.id}: label contains sequencing/condition/adjunct wording ("${o.label}"); options must be atomic`);
      for (const r of o.derivedFrom) if (!relIds.has(r)) problems.push(`${o.id}: references unknown relation ${r}`);
      const crit = new Set(o.scores.map((s) => s.criterion));
      for (const c of artifact.criteria) if (!crit.has(c)) problems.push(`${o.id}: missing score for criterion '${c}'`);
    }
    return problems;
  },

  mock(ctx) {
    const analyze = Object.values(ctx.artifacts).find((a) => a?.relations);
    const rids = (analyze?.relations ?? []).map((r) => r.id);
    const { criteria, options } = ctx.step.params;
    return {
      decision: '[MOCK] Which approach should be taken?',
      criteria,
      options: Array.from({ length: options }, (_, i) => ({
        id: `o${i + 1}`,
        label: `[MOCK] strategy ${i + 1}`,
        derivedFrom: [rids[i % rids.length]],
        scores: criteria.map((c, j) => ({ criterion: c, rating: Math.max(1, Math.min(5, 5 - i - (j % 2))), rationale: `[MOCK] because of ${rids[i % rids.length]}` })),
      })),
      best: 'o1',
      runnerUp: 'o2',
      decisiveFactor: `[MOCK] ${criteria[0]}`,
      whyRunnerUpFails: `[MOCK] o2 loses on ${criteria[0]} because of ${rids[0]}.`,
    };
  },
};
