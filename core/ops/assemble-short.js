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
/** What the prompt asks for; the check allows up to MAX_ANSWER_WORDS, so a model that runs a little over does not cost a retry. */
export const TARGET_ANSWER_WORDS = MAX_ANSWER_WORDS - 10;
/** A rubric element is one point. The prompt asks for at most MAX_REQUIREMENT_WORDS; the check allows a little slack so a clause does not cost a retry. */
export const MAX_REQUIREMENT_WORDS = 25;
/** A lead-in that grows a clause per rubric element becomes a checklist; it stays a question. */
export const MAX_LEADIN_WORDS = 40;
const REQUIREMENT_SLACK = 5;

const words = (t) => String(t ?? '').trim().split(/\s+/).filter(Boolean).length;

export function buildShortSchema(path) {
  const stepIds = path.map((s) => s.id);
  return assertStrict(obj({
    stem: str('A vignette: one specific case as a learner would meet it (presentation, relevant history, findings, setting), 3–6 sentences, embedding the case constraint as a concrete feature. It states NO recalled fact, figure, rate, mechanism, judgment, or plan: the learner must bring those. No reference to any source.'),
    constraintSpan: str('The sentence or phrase of the stem (copied from the stem, ≤ 30 words) that shows the case constraint as findings in the vignette\'s own voice; empty string only when the path has no case constraint'),
    leadIn: str(`ONE question (one question mark) about THIS case, answerable in about ${MAX_ANSWER_WORDS} words, worded so that every rubric element is something it asks for: the decision, what is going on or why it matters, and why this choice rather than the alternatives (e.g. "What is happening to this patient, what would you do right now, and why that rather than the alternatives?"). It names no fact, mechanism, or option.`),
    modelAnswer: str(`The answer that earns full credit: the terminal artifact written as a concise written answer of ${MIN_ANSWER_WORDS} to ${TARGET_ANSWER_WORDS} words, in the voice of a clinician answering the question. It states the decision and the reasoning, so every rubric element is visible in it.`),
    rubric: arr(obj({
      nodeId: enm(stepIds, 'The path node this element scores'),
      requirement: str(`What an answer must show to earn this element: ONE atomic point in at most ${MAX_REQUIREMENT_WORDS} words, a claim a grader can mark met or not met from the answer alone ("Recognizes that …", "Chooses … over … because …", "Names …"). Do not join two ideas with "and"; if there are two, keep the one this node adds. Specific to this case; not a restatement of the question; and stated in the model answer.`),
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
  maxAttempts: 3, // the form checks, the digest check and the answer-vs-rubric check can each need a pass
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
2. A lead-in that is ONE question (one question mark, which may have several parts) worded so that every rubric element is something the question asks for. An expert who answers it fully, from the source and without seeing the rubric, must have reason to say each element; "What would you do, and why?" alone cues only the decision, not the mechanism or the comparison. Cue each kind of element by what it needs: a fact node by asking what is going on or why it matters, a relation node by asking what the findings show, an evaluate node by asking why this choice rather than the alternatives, the terminal node by asking what to do. For example: "What is happening to this patient, what would you do right now, and why that rather than the alternatives?" Each part of the lead-in is generic, a question that could be asked of any case in this field ("what is happening", "how urgent is it", "what would you do", "why that rather than the alternatives"); it never points at a feature, a finding, or the time course of this case, and it is at most ${MAX_LEADIN_WORDS} words. The lead-in names no fact, mechanism, or option. No options are given.
3. A model answer of ${MIN_ANSWER_WORDS} to ${TARGET_ANSWER_WORDS} words (count them; the limit is ${MAX_ANSWER_WORDS}): the "${terminal.op}" artifact of step "${terminal.id}" written as the answer a strong clinician would give, with its reasoning. It must carry what the synthesized plan adds for this case; an answer that only repeats what the source recommends is not the model answer.
4. A rubric with EXACTLY ONE element per path node, in path order (${ctx.path.map((s) => s.id).join(', ')}). An element is what an answer must show to earn credit at that node:
   - recall node → the fact(s) the answer must bring (derivedFrom = one of that node's concept ids);
   - analyze node → the relation the answer must draw, so that it avoids the node's commonMisreading (derivedFrom = a relation id of that node);
   - evaluate node → the choice of the best strategy over the runner-up for the decisive reason (derivedFrom = the best option id of that node);
   - the terminal node → the decision itself, adapted to the case (derivedFrom = "terminal").
   derivedFrom is NEVER a node id. The values allowed for each node are exactly:
${ctx.path.map((s) => `   - node "${s.id}" (${s.op}): ${[...allowedSources(ctx.path, ctx.artifacts, s)].join(' | ')}`).join('\n')}
   Each requirement is ONE atomic point (at most ${MAX_REQUIREMENT_WORDS} words, no two ideas joined by "and") that a grader can mark met or not met from the answer alone, specific to this case. Every requirement must be stated in the model answer in words a grader can quote, so write the model answer and the rubric together and check each element against a sentence of the answer: if the answer does not say it, either add it to the answer (within the word limit) or narrow the requirement to what the answer does say. An answer that shows only the point of that node must earn that element, however it is worded. commonError says what an answer that misses it typically says or does instead (one sentence, built from the node's own failure material).

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
      else if (words(e.requirement) > MAX_REQUIREMENT_WORDS + REQUIREMENT_SLACK) problems.push(`element for "${e.nodeId}" is ${words(e.requirement)} words; an element is ONE point in at most ${MAX_REQUIREMENT_WORDS} words (split it and keep the point this node adds)`);
      if (words(e.commonError) < 3) problems.push(`element for "${e.nodeId}" has no usable commonError`);
      if (spanFound(e.requirement, artifact.stem).found) problems.push(`element for "${e.nodeId}" restates the stem; it must name what the learner brings`);
    }
    if (words(artifact.leadIn) > MAX_LEADIN_WORDS) problems.push(`the lead-in is ${words(artifact.leadIn)} words; write at most ${MAX_LEADIN_WORDS}, as generic parts that do not point at a feature, finding, or time course of this case`);
    const reqs = artifact.rubric.map((e) => e.requirement.toLowerCase().trim());
    if (new Set(reqs).size !== reqs.length) problems.push('two rubric elements have the same requirement');
    problems.push(...stemProblems(artifact, ctx));
    problems.push(...shortShapeProblems(artifact));
    return problems;
  },

  /**
   * Model-backed checks on the assembled item, run together:
   *  1. the model answer, as written, is not entailed by the source's claims (the synthesis may carry an adaptation that the answer drops);
   *  2. the model answer earns every element of its own rubric (the in-loop counterpart of the modelAnswerScore verification);
   *  3. every element is one point, and the lead-in, as worded, asks for what it requires (the in-loop counterpart of the answerability verification:
   *     an element no answer to the question is expected to say can never be earned by an expert who has not seen the rubric).
   * An element the answer does not show, or the question does not ask for, or that joins several points, is a defect of the item found here while the assembler can still fix it.
   */
  async verifyAsync(artifact, ctx, { model } = {}) {
    const claims = ctx.source?.digest?.claims ?? [];
    const { gradeAnswer, checkCues } = await import('../verify-short.js'); // dynamic: verify-short imports the executor, which imports this module
    const item = finishShort(artifact);
    const [ent, grade, cue] = await Promise.all([
      claims.length ? entailedByNotes({ statement: artifact.modelAnswer, notes: notesFromClaims(claims, 'every claim of the source'), model, label: 'assemble_short:answer-digest-entailment', mockEntailed: false }) : null,
      gradeAnswer({ item, answer: artifact.modelAnswer, model, label: 'assemble_short:answer-vs-rubric' }),
      checkCues({ item, model, label: 'assemble_short:leadin-cues' }),
    ]);
    const problems = [];
    if (ent?.entailed) problems.push(`the model answer as written is fully entailed by the source's own claims (${ent.citedNotes.join(', ')}); it dropped the adaptation. Rewrite it so it carries what the synthesized plan adds for this case (the clause the source does not state)`);
    const unmet = grade.marks.filter((m) => !m.met).map((m) => item.rubric.find((e) => e.id === m.elementId));
    for (const e of unmet) problems.push(`the model answer does not earn its own element for "${e.nodeId}" (${e.id}): "${e.requirement}". State that point in the model answer (within ${MAX_ANSWER_WORDS} words), or rewrite the requirement as one point the answer already shows`);
    const uncued = cue.cues.filter((c) => !c.cued);
    // The cue and one-point verdicts are a judge's opinion and vary between runs: advice for one revision, never a failed assembly.
    const advice = [];
    const compound = cue.cues.filter((c) => c.cued && !c.onePoint);
    for (const c of compound) advice.push(`element "${c.nodeId}" (${c.elementId}) joins several points (${c.reason}); an answer giving only one would be marked not met. Keep the ONE point this node adds, in a single clause`);
    for (const c of uncued) advice.push(`the lead-in does not ask for element "${c.nodeId}" (${c.elementId}): "${item.rubric.find((e) => e.id === c.elementId).requirement}" (${c.reason}). Reword the lead-in (still ONE question, naming no fact, mechanism, or option) so that an answer showing this point is a direct answer to it`);
    return {
      skipped: false, entailed: ent?.entailed ?? null, citedNotes: ent?.citedNotes ?? [], missingClause: ent?.missingClause ?? null,
      answerScore: grade.score, answerMax: grade.max, unmet: unmet.map((e) => e.id), uncued: uncued.map((c) => c.elementId), compound: compound.map((c) => c.elementId),
      usage: [ent?.usage, grade.usage, cue.usage].filter(Boolean), problems, advice,
    };
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
