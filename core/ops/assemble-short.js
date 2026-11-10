/**
 * ASSEMBLE, short-answer format (terminal, run in place of `assemble` when the build's format is 'short'):
 * turn the executed path into a short written-response item. The item is a vignette, a lead-in that asks for the
 * decision and the reasoning behind it, a model answer (the terminal artifact written as a concise answer), and
 * an analytic rubric with exactly one scored element per path node.
 *
 * Why a rubric rather than options: in a multiple-choice item the path's steps show up as distractors, one per
 * step, so a path is capped by the option count and a branch has no natural place. A rubric element is "what an
 * answer must show to get credit at this node", so any number of nodes, in any graph, each get a scored line, and a
 * learner who fails at a node loses exactly that line. `commonError` records what an answer that misses the element
 * typically says, the short-answer counterpart of a distractor's failure rationale.
 */
import { obj, arr, str, enm, assertStrict } from '../schema.js';
import { spanFound } from '../textmatch.js';
import { entailedByNotes, notesFromClaims } from '../entail.js';
import { stemProblems } from './assemble.js';

export const MAX_ANSWER_WORDS = 110;
export const MIN_ANSWER_WORDS = 15;

const words = (t) => String(t ?? '').trim().split(/\s+/).filter(Boolean).length;

export function buildShortSchema(path) {
  const stepIds = path.map((s) => s.id);
  return assertStrict(obj({
    stem: str('A vignette: one specific case as a learner would meet it (presentation, relevant history, findings, setting), 3–6 sentences, embedding the case constraint as a concrete feature. It states NO recalled fact, figure, rate, mechanism, judgment, or plan: the learner must bring those. No reference to any source.'),
    constraintSpan: str('The sentence or phrase of the stem (copied from the stem, ≤ 30 words) that shows the case constraint as findings in the vignette\'s own voice; empty string only when the path has no case constraint'),
    leadIn: str('One question about THIS case that asks for the decision and the reasoning behind it, answerable in 2 to 4 sentences (e.g. "What would you do for this patient, and why?")'),
    modelAnswer: str(`The answer that earns full credit: the terminal artifact written as a concise written answer of ${MIN_ANSWER_WORDS} to ${MAX_ANSWER_WORDS} words, in the voice of a clinician answering the question. It states the decision and the reasoning, so every rubric element is visible in it.`),
    rubric: arr(obj({
      nodeId: enm(stepIds, 'The path node this element scores'),
      requirement: str('What an answer must show to earn this element: ONE sentence, a claim a grader can mark met or not met from the answer alone ("Recognizes that …", "Chooses … over … because …", "Names …"). Specific to this case; not a restatement of the question.'),
      derivedFrom: str('The material this element is built from: a concept id (c*) for a recall node, a relation id (r*) for an analyze node, the best option id (o*) for an evaluate node, "alt:<nodeId>" when a synthesize alternative carries it, or "terminal" for the terminal node'),
      commonError: str('The specific error of an answer that misses this element: what such an answer says or does instead (one sentence)'),
    }), 'Exactly one element per path node, in path order'),
  }));
}

/** Deterministic element ids (e1, e2, …) in rubric order, and the points each carries. */
export function finishShort(artifact) {
  const rubric = artifact.rubric.map((e, i) => ({ id: `e${i + 1}`, points: 1, ...e }));
  return { ...artifact, format: 'short', rubric, maxPoints: rubric.length, key: null };
}

/** The ids an element of a node may be derived from (mirrors the distractor links of the multiple-choice assembler). */
export function allowedSources(path, artifacts, node) {
  const a = artifacts[node.id] ?? {};
  const set = new Set();
  if (node.op === 'recall') for (const c of a.concepts ?? []) set.add(c.id);
  if (node.op === 'analyze') for (const r of a.relations ?? []) set.add(r.id);
  if (node.op === 'evaluate') { if (a.best) set.add(a.best); if (a.runnerUp) set.add(a.runnerUp); }
  for (const s2 of path) if (artifacts[s2.id]?.incompleteAlternatives?.some((x) => x.skippedStep === node.id)) set.add(`alt:${node.id}`);
  if (node.id === path[path.length - 1].id) set.add('terminal');
  return set;
}

/** Form checks for a short-answer item, whatever produced it: one question, no source reference, a usable model answer. */
export function shortShapeProblems(item) {
  const problems = [];
  if (/\b(the (article|study|source|text|passage))\b/i.test(`${item.stem} ${item.leadIn} ${item.modelAnswer}`)) problems.push('item refers to the source');
  if ((String(item.leadIn).match(/\?/g) ?? []).length !== 1) problems.push('the lead-in must be exactly one question');
  const n = words(item.modelAnswer);
  if (n < MIN_ANSWER_WORDS || n > MAX_ANSWER_WORDS) problems.push(`the model answer is ${n} words; write ${MIN_ANSWER_WORDS} to ${MAX_ANSWER_WORDS}`);
  const sentences = String(item.stem).split(/(?<=[.!?])\s+/).filter(Boolean).length;
  if (sentences < 3 || sentences > 8) problems.push(`the stem is ${sentences} sentences; write 3 to 6`);
  return problems;
}

export default {
  id: 'assemble_short',
  label: 'Assemble short-answer item',
  bloom: 0,
  description: 'Build the item: stem, lead-in, model answer = terminal artifact, rubric = one scored element per path node.',
  requires: [],
  params: {},
  effort: 'high',
  maxOutputTokens: 24576,
  schemaFor(ctx) { return buildShortSchema(ctx.path); },

  instruction(ctx) {
    const terminal = ctx.path[ctx.path.length - 1];
    const synStep = [...ctx.path].reverse().find((s) => ctx.artifacts[s.id]?.caseConstraint);
    const cc = synStep ? ctx.artifacts[synStep.id].caseConstraint : null;
    return `FINAL STEP: ASSEMBLE a short-answer item from the executed path (${ctx.path.map((s) => s.id).join(', ')}; the "${terminal.id}" step is the terminal one).

Construct:
1. A stem that is a VIGNETTE: one specific case as the learner would meet it (presentation, relevant history, findings, setting, timing), 3–6 sentences.${cc ? `
   It MUST embed the case constraint from step "${synStep.id}" as a concrete feature of this case: "${cc.feature}" (${cc.whyGenericInsufficient}). Rewrite the feature in the vignette's own voice as findings, history, or the patient's words (never paste it as a sentence about "a patient", never label it, never hint at its consequence), then copy the stem sentence that carries it into constraintSpan.` : `
   constraintSpan is "" (the path has no case constraint).`}
   The stem states NONE of the recalled facts, figures, rates, incidences, study results, mechanisms, judgments, or plans; the learner must bring them.
2. A lead-in that is ONE question asking for the decision and the reasoning behind it, so that an answer can show every step of the path (for example "What would you do for this patient, and why?"). No options are given.
3. A model answer of ${MIN_ANSWER_WORDS} to ${MAX_ANSWER_WORDS} words: the "${terminal.op}" artifact of step "${terminal.id}" written as the answer a strong clinician would give, with its reasoning. It must carry what the synthesized plan adds for this case; an answer that only repeats what the source recommends is not the model answer.
4. A rubric with EXACTLY ONE element per path node, in path order (${ctx.path.map((s) => s.id).join(', ')}). An element is what an answer must show to earn credit at that node:
   - recall node → the fact(s) the answer must bring (derivedFrom = one of that node's concept ids);
   - analyze node → the relation the answer must draw, so that it avoids the node's commonMisreading (derivedFrom = a relation id of that node);
   - evaluate node → the choice of the best strategy over the runner-up for the decisive reason (derivedFrom = the best option id of that node);
   - the terminal node → the decision itself, adapted to the case (derivedFrom = "terminal").
   Each requirement is ONE sentence a grader can mark met or not met from the answer alone, specific to this case, and visible in the model answer. commonError says what an answer that misses it typically says or does instead (one sentence, built from the node's own failure material).

Never refer to "the article", "the study", "the source", or "the text" anywhere in the item.`;
  },

  verify(artifact, ctx) {
    const problems = [];
    const ids = ctx.path.map((s) => s.id);
    const got = artifact.rubric.map((e) => e.nodeId);
    if (got.join(',') !== ids.join(',')) problems.push(`rubric nodes ${got.join(',') || '(none)'} ≠ path ${ids.join(',')}: one element per node, in path order`);
    for (const e of artifact.rubric) {
      const node = ctx.path.find((s) => s.id === e.nodeId);
      if (!node) continue;
      const ok = allowedSources(ctx.path, ctx.artifacts, node);
      if (ok.size && !ok.has(e.derivedFrom)) problems.push(`element for "${e.nodeId}" has derivedFrom="${e.derivedFrom}", allowed: ${[...ok].join(', ')}`);
      if (words(e.requirement) < 4) problems.push(`element for "${e.nodeId}" has no usable requirement`);
      if (words(e.commonError) < 3) problems.push(`element for "${e.nodeId}" has no usable commonError`);
      if (spanFound(e.requirement, artifact.stem).found) problems.push(`element for "${e.nodeId}" restates the stem; it must name what the learner brings`);
    }
    const reqs = artifact.rubric.map((e) => e.requirement.toLowerCase().trim());
    if (new Set(reqs).size !== reqs.length) problems.push('two rubric elements have the same requirement');
    problems.push(...stemProblems(artifact, ctx));
    problems.push(...shortShapeProblems(artifact));
    return problems;
  },

  /** The model answer, as written, must not be entailed by the source's claims: the synthesis may carry an adaptation that the answer then drops. */
  async verifyAsync(artifact, ctx, { model } = {}) {
    const claims = ctx.source?.digest?.claims ?? [];
    if (!claims.length) return { skipped: true, problems: [] };
    const notes = notesFromClaims(claims, 'every claim of the source');
    const r = await entailedByNotes({ statement: artifact.modelAnswer, notes, model, label: 'assemble_short:answer-digest-entailment', mockEntailed: false });
    const problems = r.entailed ? [`the model answer as written is fully entailed by the source's own claims (${r.citedNotes.join(', ')}); it dropped the adaptation. Rewrite it so it carries what the synthesized plan adds for this case (the clause the source does not state)`] : [];
    return { skipped: false, entailed: r.entailed, citedNotes: r.citedNotes, missingClause: r.missingClause, usage: r.usage, problems };
  },

  mock(ctx) {
    const cc = ctx.path.map((s) => ctx.artifacts[s.id]?.caseConstraint).filter(Boolean).pop();
    const derived = (node) => {
      const a = ctx.artifacts[node.id] ?? {};
      if (node.id === ctx.path[ctx.path.length - 1].id) return 'terminal';
      if (node.op === 'recall') return a.concepts?.[0]?.id ?? 'c1';
      if (node.op === 'analyze') return a.relations?.[0]?.id ?? 'r1';
      if (node.op === 'evaluate') return a.best ?? 'o1';
      return `alt:${node.id}`;
    };
    return {
      stem: `[MOCK] A patient presents as a learner would meet the case. ${cc ? cc.feature : 'No constraint applies.'} The setting is an outpatient clinic. It ends at a decision point.`,
      constraintSpan: cc ? cc.feature : '',
      leadIn: '[MOCK] What would you do for this patient, and why?',
      modelAnswer: '[MOCK] The integrated plan that results from the full path, with the reasoning that connects the recalled facts, the relations among them, and the strategy chosen for this case.',
      rubric: ctx.path.map((s) => ({ nodeId: s.id, requirement: `[MOCK] The answer shows what step ${s.id} contributes.`, derivedFrom: derived(s), commonError: `[MOCK] An answer that misses step ${s.id}.` })),
    };
  },
};
