/**
 * ANALYZE: relate the recalled facts to each other. The learner must see structure (cause, contrast,
 * mechanism, comparison) that is not stated as a single fact anywhere in the source.
 */
import { obj, arr, str, enm, assertStrict } from '../schema.js';
import { PRESCRIPTIVE } from './recall.js';
import { ACTION_LEAK, spanFound } from '../textmatch.js';

export const KINDS = ['contrast', 'causal', 'mechanism', 'comparison'];

const schema = assertStrict(obj({
  relations: arr(obj({
    id: str('r1, r2, …'),
    kind: enm(KINDS),
    between: arr(str('concept id from the RECALL step'), 'Two or more concept ids this relation connects', { minItems: 2 }),
    claim: str('The relationship, stated as a learner would articulate it after thinking it through'),
    evidenceSpan: str('Verbatim quotation (≤ 40 words) that, combined with the concepts, supports the claim'),
    implication: str('What follows for a decision if this relation holds (one sentence)'),
    commonMisreading: str('The most likely wrong relationship a learner would draw between these same concepts'),
  }), 'Relations that require integrating at least two recalled facts'),
}));

export default {
  id: 'analyze',
  label: 'Analyze',
  bloom: 4,
  description: 'Connect recalled facts into relations (contrast, causal, mechanism, comparison) with the common misreading of each.',
  requires: ['recall'],
  params: {
    kind: { type: 'enum', values: KINDS, default: 'contrast', description: 'Dominant relation type to look for', positional: true },
    relations: { type: 'integer', default: 2, min: 1, max: 6, description: 'How many relations to produce' },
  },
  effort: 'medium',
  maxOutputTokens: 12288,
  schema,

  instruction(ctx) {
    const { kind, relations } = ctx.step.params;
    return `STEP ${ctx.step.index + 1} of ${ctx.path.length}: ANALYZE (${kind}).
Using the RECALL concepts provided, identify exactly ${relations} relations of kind "${kind}" (other kinds allowed only if the source forces them). Each relation must connect at least two concept ids and must NOT be stated as a single sentence anywhere in the source: it has to be constructed by the learner.

Rules:
- Reference concepts only by their ids in "between".
- "claim" is the relationship itself; "implication" is what it changes for a decision, stated as understanding ("deep placement puts fat where injured veins can take it up"), never as an instruction ("fat should be placed subcutaneously"). Deciding is the EVALUATE and SYNTHESIZE steps' job; a relation that already names the action is rejected.
- "commonMisreading" is the specific wrong relation a plausible learner would draw from the same facts. This will seed a distractor, so make it realistic, not absurd.
- Never refer to "the article", "the study", or "the text".
Ids are r1 … r${relations}.`;
  },

  verify(artifact, ctx) {
    const problems = [];
    const recall = Object.values(ctx.artifacts).find((a) => a?.concepts);
    const conceptIds = new Set((recall?.concepts ?? []).map((c) => c.id));
    const n = ctx.step.params.relations;
    if (artifact.relations.length !== n) problems.push(`expected ${n} relations, got ${artifact.relations.length}`);
    const ids = new Set();
    for (const r of artifact.relations) {
      if (ids.has(r.id)) problems.push(`duplicate relation id ${r.id}`);
      ids.add(r.id);
      for (const c of r.between) if (!conceptIds.has(c)) problems.push(`${r.id}: references unknown concept ${c}`);
      if (new Set(r.between).size < 2) problems.push(`${r.id}: must connect two distinct concepts`);
      // A relation explains; it does not decide. A prescriptive claim or implication hands the later steps' answer to a learner who only reads this step.
      for (const f of ['claim', 'implication']) if (PRESCRIPTIVE.test(r[f] ?? '') || ACTION_LEAK.test(r[f] ?? '')) problems.push(`${r.id}: ${f} reads as a recommendation/action ("${String(r[f]).slice(0, 70)}…"); state what follows for understanding (what is true, what it means), not what anyone should do`);
      const recs = (ctx.source?.digest?.claims ?? []).filter((c) => c.type === 'recommendation');
      const quoted = recs.find((c) => spanFound(r.evidenceSpan, c.span).found || spanFound(c.span, r.evidenceSpan).found);
      if (quoted) problems.push(`${r.id}: evidenceSpan quotes recommendation ${quoted.id}; relations rest on premises (results, mechanisms, data), never on the source's recommendations`);
    }
    return problems;
  },

  mock(ctx) {
    const recall = Object.values(ctx.artifacts).find((a) => a?.concepts);
    const cids = (recall?.concepts ?? []).map((c) => c.id);
    const n = ctx.step.params.relations;
    return {
      relations: Array.from({ length: n }, (_, i) => ({
        id: `r${i + 1}`,
        kind: ctx.step.params.kind,
        between: [cids[i % cids.length], cids[(i + 1) % cids.length]],
        claim: `[MOCK] Relation ${i + 1}: how ${cids[i % cids.length]} and ${cids[(i + 1) % cids.length]} interact.`,
        evidenceSpan: ctx.source.text ? ctx.source.text.split(/\s+/).slice(40 + i * 15, 40 + i * 15 + 10).join(' ') : `[MOCK] evidence ${i + 1}`,
        implication: `[MOCK] Implication ${i + 1} for the decision.`,
        commonMisreading: `[MOCK] A learner might invert relation ${i + 1}.`,
      })),
    };
  },
};
