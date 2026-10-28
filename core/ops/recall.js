/**
 * RECALL: extract the facts a learner must retrieve from the source before any reasoning can start.
 * Output is the evidentiary base for every later step; each concept carries a verbatim source span.
 */
import { obj, arr, str, int, assertStrict } from '../schema.js';
import { ACTION_LEAK } from '../textmatch.js';

const schema = assertStrict(obj({
  concepts: arr(obj({
    id: str('Stable identifier, c1, c2, …'),
    statement: str('One precise, testable claim stated in the learner\'s terms (no reference to "the article")'),
    sourceSpan: str('Verbatim quotation from the source (≤ 40 words) that supports the statement'),
    claims: arr(str('Digest claim id (cl1, cl2, …)'), 'When a SOURCE DIGEST is provided: the claim ids this fact rests on (at least one). Empty when there is no digest.'),
  }), 'Distinct, non-overlapping facts'),
  topic: str('Short label for the subject the concepts share'),
}));

/** Phrases that mark a statement as prescriptive (a decision, not a premise). */
export const PRESCRIPTIVE = /\b(should|must|is (indicated|recommended|preferred|required|the treatment|treated with|managed (by|with))|are (indicated|recommended|preferred|required)|first[- ]line|treatment of choice|next step|perform(ed)? (immediately|urgently)|do not (wait|delay)|never delay|requires? (immediate|urgent|emergent))\b/i;

export default {
  id: 'recall',
  label: 'Recall',
  bloom: 1,
  description: 'Retrieve the specific facts the item will depend on, each grounded in a verbatim span.',
  requires: [],
  params: {
    concepts: { type: 'integer', default: 3, min: 1, max: 8, description: 'How many distinct facts to extract', positional: true },
    mode: { type: 'enum', values: ['premises', 'all'], default: 'premises', description: 'premises: only observations, mechanisms, quantities, definitions (no recommendations/actions/conclusions, so the plan must be built downstream); all: any fact' },
  },
  effort: 'low',
  maxOutputTokens: 8192,
  schema,

  instruction(ctx) {
    const { concepts: n, mode } = ctx.step.params;
    const premises = mode === 'premises' ? `
- PREMISES ONLY. A fact may be an observation, a finding, a mechanism, a quantity, a time course, a risk factor, or a definition. It must NOT be a recommendation, a management step, an action, a decision rule, or a conclusion (nothing of the form "do X", "X should be done", "X is the treatment", "X is indicated/preferred/required"). The downstream steps must be able to BUILD the decision from these facts; if the decision is already one of the facts, the item collapses to recall.` : '';
    return `STEP ${ctx.step.index + 1} of ${ctx.path.length}: RECALL.
Extract exactly ${n} distinct, decision-relevant facts from the source that a competent learner would need to retrieve from memory before reasoning about this topic.

Rules:
- Each fact is a single precise claim the source supports; quote the supporting passage verbatim in sourceSpan (at most 40 words).
- Facts must be mutually distinct: no two may be answerable by the same sentence of the source.
- Prefer facts with consequences (what changes if the fact is true) over trivia.${premises}
- Write statements in the learner's own terms; never refer to "the article", "the study", or "the text".${ctx.source?.digest ? `
- A SOURCE DIGEST is provided. Every fact must rest on one or more claims: list their ids in \`claims\`, and copy sourceSpan verbatim from a claim's quotation.${mode === 'premises' ? ' Claims typed "recommendation" may NOT be used as facts.' : ''}${ctx.source?.focus?.claims?.length ? ` Use ONLY the reserved claims ${ctx.source.focus.claims.join(', ')}.` : ''}` : ''}
Ids are c1 … c${n}.`;
  },

  verify(artifact, ctx) {
    const problems = [];
    const n = ctx.step.params.concepts;
    if (artifact.concepts.length !== n) problems.push(`expected ${n} concepts, got ${artifact.concepts.length}`);
    const ids = new Set();
    for (const c of artifact.concepts) {
      if (ids.has(c.id)) problems.push(`duplicate concept id ${c.id}`);
      ids.add(c.id);
      if (c.sourceSpan.trim().split(/\s+/).length > 60) problems.push(`${c.id}: sourceSpan longer than 60 words`);
      if (/\b(the (article|study|text|passage|paper))\b/i.test(c.statement)) problems.push(`${c.id}: statement refers to the source`);
      if (ctx.step.params.mode === 'premises' && PRESCRIPTIVE.test(c.statement)) problems.push(`${c.id}: reads as a recommendation/action, not a premise ("${c.statement.slice(0, 70)}…")`);
      if (ctx.step.params.mode === 'premises' && ACTION_LEAK.test(c.statement)) problems.push(`${c.id}: statement reads as an instruction ("${c.statement.slice(0, 70)}…"), not a premise`);
      if (ctx.source?.digest) {
        const byId = new Map(ctx.source.digest.claims.map((a) => [a.id, a]));
        if (!c.claims?.length) problems.push(`${c.id}: no digest claims cited`);
        for (const id of c.claims ?? []) {
          const a = byId.get(id);
          if (!a) problems.push(`${c.id}: cites unknown claim ${id}`);
          else if (ctx.step.params.mode === 'premises' && a.type === 'recommendation') problems.push(`${c.id}: rests on recommendation claim ${id}; premises-only recall may not use recommendations`);
          else if (ctx.source.focus?.claims?.length && !ctx.source.focus.claims.includes(id)) problems.push(`${c.id}: cites ${id}, which is not reserved for this item (reserved: ${ctx.source.focus.claims.join(', ')})`);
        }
      }
    }
    return problems;
  },

  mock(ctx) {
    const n = ctx.step.params.concepts;
    return {
      topic: ctx.source.title || 'Mock topic',
      concepts: Array.from({ length: n }, (_, i) => ({
        id: `c${i + 1}`,
        statement: `[MOCK] Fact ${i + 1}: a precise premise about the topic.`,
        sourceSpan: ctx.source.text ? ctx.source.text.split(/\s+/).slice(i * 12, i * 12 + 10).join(' ') : `[MOCK] span ${i + 1}`,
        claims: ctx.source?.focus?.claims?.length ? [ctx.source.focus.claims[i % ctx.source.focus.claims.length]] : ctx.source?.digest ? [ctx.source.digest.claims.find((a) => a.type !== 'recommendation')?.id ?? ctx.source.digest.claims[0].id] : [],
      })),
    };
  },
};
