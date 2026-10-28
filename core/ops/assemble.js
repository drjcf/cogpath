/**
 * ASSEMBLE (terminal, always run): turn the executed cognitive path into a single-best-answer item whose
 * key is the terminal artifact and whose distractors are failures at specific steps of the path.
 *
 * Policy "one-per-step": one distractor per path step (tagged failsAt=<stepId>), padded with extra
 * terminal-step distractors so every item has at least 4 options. Letters are assigned after a seeded
 * shuffle so the key position is not predictable.
 */
import { obj, arr, str, enm, assertStrict } from '../schema.js';
import { spanFound, clauseSupported } from '../textmatch.js';
import { entailedByNotes, notesFromClaims } from '../entail.js';

export const MIN_OPTIONS = 4;

export function optionPlan(path) {
  const stepIds = path.map((s) => s.id);
  const distractors = [...stepIds];
  while (distractors.length + 1 < MIN_OPTIONS) distractors.push(stepIds[stepIds.length - 1]);
  return { stepIds, distractors, total: distractors.length + 1 };
}

export function buildSchema(path) {
  const { stepIds } = optionPlan(path);
  return assertStrict(obj({
    stem: str('A vignette: one specific case as a learner would meet it (presentation, relevant history, findings, setting), 3–6 sentences, embedding the case constraint as a concrete feature. It states NO recalled fact, figure, rate, mechanism, judgment, or plan: the learner must bring those. No reference to any source.'),
    constraintSpan: str('The sentence or phrase of the stem (copied from the stem, ≤ 30 words) that shows the case constraint as findings in the vignette\'s own voice; empty string only when the path has no synthesize step'),
    leadIn: str('The focused question about THIS case, answerable with the options covered (e.g. "Which of the following is the most appropriate … for this patient?")'),
    options: arr(obj({
      text: str('Option text, 12 to 25 words, at most 2 clauses; all options parallel in length, grammar, and specificity'),
      failsAt: enm([...stepIds, 'none'], '"none" for the key; otherwise the step a learner who picks this option failed at'),
      derivedFrom: str('The failure material this option was built from: a concept id (c*) for a recall failure, a relation id (r*) whose commonMisreading it embodies for an analyze failure, the runnerUp option id (o*) for an evaluate failure, "alt:<stepId>" for a synthesize incompleteAlternative, or "terminal" for the key'),
      failureRationale: str('For a distractor: the specific error at that step that leads here. For the key: why it requires the full path.'),
    }), 'Exactly one option with failsAt="none" (the key); every path step appears as failsAt of at least one distractor'),
    explanation: arr(obj({
      step: enm(stepIds),
      reasoning: str('What the learner must do at this step to move toward the key (1–2 sentences)'),
    }), 'One entry per path step, in order'),
  }));
}

const NUM_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** "four hundred" → "400", "twenty-two thousand eight hundred" → "22800", so a figure spelled out to dodge the figure check is still caught. */
export function wordsToDigits(text) {
  const word = Object.keys(NUM_WORDS).join('|');
  const re = new RegExp(`\\b((?:(?:${word}|hundred|thousand|and)(?:[\\s-]+|(?=\\b)))+)`, 'gi');
  return String(text).replace(re, (m) => {
    const tokens = m.toLowerCase().split(/[\s-]+/).filter(Boolean);
    const trailing = m.match(/[\s-]+$/)?.[0] ?? '';
    // drop a leading or trailing "and" that is not part of a number
    while (tokens.length && tokens[0] === 'and') tokens.shift();
    while (tokens.length && tokens[tokens.length - 1] === 'and') tokens.pop();
    if (!tokens.some((t) => t in NUM_WORDS)) return m;
    let total = 0, cur = 0;
    for (const t of tokens) {
      if (t in NUM_WORDS) cur += NUM_WORDS[t];
      else if (t === 'hundred') cur = (cur || 1) * 100;
      else if (t === 'thousand') { total += (cur || 1) * 1000; cur = 0; }
    }
    return String(total + cur) + (trailing ? ' ' : '');
  });
}

/**
 * Form checks any single-best-answer item must pass, whatever produced it (used by the assembler and by the
 * single-shot baseline): no length cue on the key, homogeneous option lengths, no source reference, one question.
 * `options[].isKey` or `failsAt === 'none'` marks the key.
 */
const norm5 = (t) => String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).slice(-5).join(' ');

export function itemShapeProblems(item) {
  const problems = [];
  const wc = (t) => String(t).trim().split(/\s+/).length;
  const isKey = (o) => o.isKey === true || o.failsAt === 'none';
  const byLen = [...item.options].sort((a, b) => wc(b.text) - wc(a.text));
  if (byLen.length > 1) {
    const [longest, second] = byLen;
    if (isKey(longest) && wc(longest.text) > wc(second.text) * 1.2) problems.push(`key is the longest option by ${Math.round((wc(longest.text) / wc(second.text) - 1) * 100)}% (length cue); equalize option lengths`);
    const shortest = byLen[byLen.length - 1];
    if (wc(longest.text) > wc(shortest.text) * 1.6) problems.push(`option lengths are not homogeneous (${wc(shortest.text)} to ${wc(longest.text)} words); keep every option within 25% of the others`);
  }
  const over = item.options.filter((o) => wc(o.text) > 28);
  if (over.length) problems.push(`option(s) longer than 25 words: ${over.map((o) => `${wc(o.text)} words`).join(', ')}; tighten every option to 12 to 25 words`);
  // Odd-one-out cue: a clause (last 5 words) shared by most distractors and absent from the key, or present only in the key.
  const tail = (t) => norm5(t);
  const keyOpt = item.options.find(isKey);
  if (keyOpt && item.options.length >= 4) {
    const tails = item.options.filter((o) => !isKey(o)).map((o) => tail(o.text));
    const counts = tails.reduce((m, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
    const [common, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (common && n >= Math.max(3, tails.length - 1) && tail(keyOpt.text) !== common) problems.push(`odd-one-out cue: ${n} distractors end with the same clause ("…${common}") and the key does not`);
  }
  if (/\b(the (article|study|source|text|passage))\b/i.test(item.stem + ' ' + item.leadIn)) problems.push('item refers to the source');
  if ((item.leadIn.match(/\?/g) ?? []).length > 1 || /\b(and|as well as)\b[^?]*\?$/i.test(item.leadIn) && /\b(what|which|how)\b.*\b(and|as well as)\b.*\b(what|which|how|the)\b/i.test(item.leadIn)) problems.push('lead-in appears double-barreled (asks two things)');
  return problems;
}

export default {
  id: 'assemble',
  label: 'Assemble item',
  bloom: 0,
  description: 'Build the item: stem, lead-in, key = terminal artifact, distractors = step failures.',
  requires: [],
  params: {},
  effort: 'high',
  maxOutputTokens: 24576,
  schemaFor(ctx) { return buildSchema(ctx.path); },

  instruction(ctx) {
    const plan = optionPlan(ctx.path);
    const terminal = ctx.path[ctx.path.length - 1];
    const counts = plan.distractors.reduce((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});
    const synStep = [...ctx.path].reverse().find((s) => ctx.artifacts[s.id]?.caseConstraint);
    const cc = synStep ? ctx.artifacts[synStep.id].caseConstraint : null;
    return `FINAL STEP: ASSEMBLE a single-best-answer item from the executed path (${plan.stepIds.join(' > ')}).

Construct:
1. A stem that is a VIGNETTE: one specific case as the learner would meet it (presentation, relevant history, findings, setting, timing), 3–6 sentences.${cc ? `
   It MUST embed the case constraint from step "${synStep.id}" as a concrete feature of this case: "${cc.feature}" (${cc.whyGenericInsufficient}). Rewrite the feature in the vignette's own voice as findings, history, or the patient's words (never paste it as a sentence about "a patient", never label it, never hint at its consequence), then copy the stem sentence that carries it into constraintSpan.` : `
   constraintSpan is "" (no synthesize step in this path).`}
   The stem states NONE of the recalled facts, figures, rates, incidences, study results, mechanisms, judgments, or plans; the learner must bring them. It must be answerable with the options covered.
   Every option describes ACTIONS; differences between options must be visible as different actions, settings, sequences, or conditions, never only as different reasons or risks named in passing.
2. A focused lead-in asking ONE question (never two joined by "and") for the terminal artifact of the path (the "${terminal.op}" output).
3. Exactly ${plan.total} options:
   - exactly one key (failsAt = "none"): the "${terminal.op}" artifact, rewritten as an option;
   - ${plan.distractors.length} distractors, one per path step as follows: ${Object.entries(counts).map(([s, n]) => `${n} × failsAt="${s}"`).join(', ')}. Each distractor MUST be built from that step's own failure material and name it in derivedFrom:
       · recall failure → a false version of one recalled fact (derivedFrom = that concept id, or alt:<recall step> if a synthesize step provided an incompleteAlternative for it);
       · analyze failure → the plan that FOLLOWS FROM the commonMisreading of one relation (derivedFrom = that relation id, or alt:<analyze step>). The misreading must change what is done, not merely the stated rationale: an option that takes the same actions as the key for a different reason is not a distractor. If a relation's misreading leads to the key's actions, use another relation;
       · evaluate failure → the runnerUp strategy carried into a plan (derivedFrom = the runnerUp option id, or alt:<evaluate step>);
       · synthesize failure → the synthesize step's own incompleteAlternative: the best strategy applied generically, ignoring the case constraint (derivedFrom = alt:<synthesize step>).
     The key has derivedFrom = "terminal".
   - Options must be homogeneous and parallel: the same grammatical form, at most 2 clauses, 12 to 25 words each, and similar length (every option within 25% of the others by word count). The key must not be the longest, the most complete, or the most qualified option, and must not be the only option that lacks (or has) a clause the others share; move safeguards that would make it so into the stem or drop them. No absolute terms; no "all/none of the above".
4. An explanation with one entry per step, in path order, describing what the learner must do at that step.

Never refer to "the article", "the study", "the source", or "the text" anywhere in the item.`;
  },

  verify(artifact, ctx) {
    const problems = [];
    const plan = optionPlan(ctx.path);
    const keys = artifact.options.filter((o) => o.failsAt === 'none');
    if (keys.length !== 1) problems.push(`expected exactly 1 key, got ${keys.length}`);
    if (artifact.options.length !== plan.total) problems.push(`expected ${plan.total} options, got ${artifact.options.length}`);
    const tagged = new Set(artifact.options.filter((o) => o.failsAt !== 'none').map((o) => o.failsAt));
    for (const s of plan.stepIds) if (!tagged.has(s)) problems.push(`no distractor tagged failsAt="${s}"`);
    // Mechanical link between each distractor and the failure material of its tagged step.
    const allowed = {};
    for (const st of ctx.path) {
      const a = ctx.artifacts[st.id] ?? {};
      const set = new Set();
      if (st.op === 'recall') for (const c of a.concepts ?? []) set.add(c.id);
      if (st.op === 'analyze') for (const r of a.relations ?? []) set.add(r.id);
      if (st.op === 'evaluate' && a.runnerUp) set.add(a.runnerUp);
      for (const s2 of ctx.path) {
        const syn = ctx.artifacts[s2.id];
        if (syn?.incompleteAlternatives?.some((x) => x.skippedStep === st.id)) set.add(`alt:${st.id}`);
      }
      allowed[st.id] = set;
    }
    for (const o of artifact.options) {
      if (o.failsAt === 'none') { if (o.derivedFrom !== 'terminal') problems.push(`key must have derivedFrom="terminal" (got "${o.derivedFrom}")`); continue; }
      const ok = allowed[o.failsAt];
      if (ok && !ok.has(o.derivedFrom)) problems.push(`distractor tagged failsAt="${o.failsAt}" has derivedFrom="${o.derivedFrom}", allowed: ${[...ok].join(', ') || '(none)'}`);
    }
    const explained = artifact.explanation.map((e) => e.step);
    if (explained.join(',') !== plan.stepIds.join(',')) problems.push(`explanation steps ${explained.join(',')} ≠ path ${plan.stepIds.join(',')}`);
    // The vignette must carry the case constraint verbatim and must not hand over the recalled facts.
    const cc = ctx.path.map((s) => ctx.artifacts[s.id]?.caseConstraint).filter(Boolean).pop();
    if (cc) {
      if (!artifact.constraintSpan.trim()) problems.push('constraintSpan is empty but the path has a case constraint');
      else if (!spanFound(artifact.constraintSpan, artifact.stem).found) problems.push('constraintSpan is not found in the stem');
      else if (!clauseSupported(cc.feature, artifact.constraintSpan)) problems.push('constraintSpan does not carry the case constraint (no content in common with the feature)');
      if (/\b(a|the) patient (requests|presents|declines|with|who)\b/i.test(artifact.stem) && /\b(she|he|her|his)\b/i.test(artifact.stem)) problems.push('stem switches from the vignette\'s voice to "a patient …": write the constraint as this patient\'s findings or words');
      // The stem shows the feature; it must not state why the generic plan fails (that inference is the examinee's).
      if (spanFound(cc.whyGenericInsufficient, artifact.stem).found) problems.push('stem states the consequence of the case constraint (whyGenericInsufficient); show the feature as findings only');
      const synth = ctx.artifacts[ctx.path[ctx.path.length - 1].id]?.synthesis?.statement;
      if (synth && spanFound(synth, artifact.stem).found) problems.push('stem restates the synthesized plan');
    }
    for (const st of ctx.path.filter((s) => s.op === 'recall')) {
      for (const c of ctx.artifacts[st.id]?.concepts ?? []) {
        if (spanFound(c.statement, artifact.stem).found || spanFound(c.sourceSpan, artifact.stem).found) problems.push(`stem restates recalled fact ${c.id}; the learner must bring it`);
        // Figures (with thousands separators, decimals, -fold, %) of two or more digits, or any figure with a suffix.
        const nums = (`${c.statement} ${c.sourceSpan}`.match(/\d[\d,]*(?:\.\d+)?(?:-fold|%)?/g) ?? []).filter((n) => /-fold|%/.test(n) || n.replace(/\D/g, '').length >= 2);
        const stemDigits = wordsToDigits(artifact.stem);
        const leaked = [...new Set(nums)].filter((n) => artifact.stem.includes(n) || stemDigits.includes(n.replace(/,/g, '')));
        if (leaked.length) problems.push(`stem states figures from recalled fact ${c.id} (${leaked.join(', ')}); remove them`);
      }
    }
    problems.push(...itemShapeProblems(artifact));
    return problems;
  },

  /** The key, as written, must not be entailed by the source's claims: the synthesis may carry an adaptation that the key then drops. */
  async verifyAsync(artifact, ctx, { model } = {}) {
    const claims = ctx.source?.digest?.claims ?? [];
    const key = artifact.options.find((o) => o.failsAt === 'none');
    if (!claims.length || !key) return { skipped: true, problems: [] };
    const notes = notesFromClaims(claims, 'every claim of the source');
    const r = await entailedByNotes({ statement: key.text, notes, model, label: 'assemble:key-digest-entailment', mockEntailed: false });
    const problems = r.entailed ? [`the key as written is fully entailed by the source's own claims (${r.citedNotes.join(', ')}); it dropped the adaptation. Rewrite the key so it carries what the synthesized plan adds for this case (the clause the source does not state), keeping it the same length and form as the distractors`] : [];
    return { skipped: false, entailed: r.entailed, citedNotes: r.citedNotes, missingClause: r.missingClause, usage: r.usage, problems };
  },

  mock(ctx) {
    const plan = optionPlan(ctx.path);
    const cc = ctx.path.map((s) => ctx.artifacts[s.id]?.caseConstraint).filter(Boolean).pop();
    return {
      stem: `[MOCK] A patient presents as a learner would meet the case. ${cc ? cc.feature : 'No constraint applies.'} It ends at a decision point.`,
      constraintSpan: cc ? cc.feature : '',
      leadIn: '[MOCK] Which of the following is the most appropriate plan?',
      options: [
        { text: '[MOCK] The integrated plan that results from the full path.', failsAt: 'none', derivedFrom: 'terminal', failureRationale: '[MOCK] Requires the full path.' },
        ...plan.distractors.map((s, i) => ({ text: `[MOCK] Plan that results from failing at ${s} (${i + 1}).`, failsAt: s, derivedFrom: mockDerived(ctx, s), failureRationale: `[MOCK] Error at ${s}.` })),
      ],
      explanation: plan.stepIds.map((s) => ({ step: s, reasoning: `[MOCK] What to do at ${s}.` })),
    };
  },
};

function mockDerived(ctx, stepId) {
  const st = ctx.path.find((x) => x.id === stepId);
  const a = ctx.artifacts[stepId] ?? {};
  if (st.op === 'recall') return a.concepts?.[0]?.id ?? 'c1';
  if (st.op === 'analyze') return a.relations?.[0]?.id ?? 'r1';
  if (st.op === 'evaluate') return a.runnerUp ?? 'o2';
  return `alt:${stepId}`;
}

/** Deterministic shuffle + letter assignment. Returns a new item object with lettered options and `key`. */
export function letterOptions(artifact, seed = 1) {
  let h = seed >>> 0 || 1;
  const rnd = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 0x100000000; };
  const opts = artifact.options.map((o) => ({ ...o }));
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
  const letters = 'ABCDEFGHIJ';
  const options = opts.map((o, i) => ({ id: letters[i], ...o, isKey: o.failsAt === 'none' }));
  return { ...artifact, options, key: options.find((o) => o.isKey)?.id ?? null };
}
