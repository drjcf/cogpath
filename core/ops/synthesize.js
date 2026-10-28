/**
 * SYNTHESIZE: integrate the judgment into a plan, recommendation, or design that depends on the whole chain.
 * Also produces "incomplete alternatives": what the plan looks like if a specific earlier step is skipped.
 * Those alternatives are the raw material for step-tagged distractors.
 */
import { obj, arr, str, enm, assertStrict } from '../schema.js';
import { spanFound } from '../textmatch.js';
import { entailedByNotes, notesFromClaims } from '../entail.js';

export function buildSchema(priorStepIds, ownId = 'synthesize') {
  const stepIds = [...priorStepIds, ownId];
  return assertStrict(obj({
    caseConstraint: obj({
      feature: str('A concrete feature of one particular case (finding, history, anatomy, resource, timing) under which the evaluated best strategy applied generically is insufficient, unsafe, or inapplicable. Stated as it would appear in a vignette, 1 sentence.'),
      whyGenericInsufficient: str('Why the generic best strategy fails under this feature (1 sentence)'),
      derivedFrom: arr(str('id (c*, r*, o*, or a digest claim cl*) that establishes why the generic strategy fails here'), 'Grounding for the constraint; at least one id', { minItems: 1 }),
    }),
    synthesis: obj({
      statement: str('The plan/recommendation/design ADAPTED to the case constraint, in 1–3 sentences, concrete enough to act on'),
      integrates: arr(str('ids from earlier steps (c*, r*, o*)'), 'Everything the synthesis depends on', { minItems: 2 }),
      novelElement: str('What the synthesis adds beyond restating the best option: the adaptation to the constraint as a change in what is DONE (staging, substitution, a different threshold or sequence, an added or withheld intervention, a safeguard), plus any conditions. Counseling, consent, documentation, or reassurance alone is not an adaptation.'),
    }),
    incompleteAlternatives: arr(obj({
      skippedStep: enm(stepIds, 'Which step a learner skipped or got wrong; for this step itself, the alternative is the best strategy applied generically, ignoring the case constraint'),
      statement: str('The plausible but wrong plan that results, same length and style as the synthesis'),
      whyWrong: str('One sentence naming the fact, relation, judgment, or integration the learner missed'),
    }), 'Exactly one alternative per step INCLUDING this synthesize step, each a realistic failure'),
  }));
}

export default {
  id: 'synthesize',
  label: 'Synthesize',
  bloom: 6,
  description: 'Integrate the judgment into an actionable plan and enumerate what the plan becomes when each earlier step is skipped.',
  requires: ['evaluate'],
  params: {
    form: { type: 'string', default: 'management plan', description: 'What kind of artifact to synthesize (management plan, recommendation, protocol, design)', positional: true },
  },
  effort: 'high',
  maxOutputTokens: 16384,
  schemaFor(ctx) { return buildSchema(ctx.priorSteps.map((s) => s.id), ctx.step.id); },

  instruction(ctx) {
    const { form } = ctx.step.params;
    const prior = ctx.priorSteps.map((s) => s.id);
    return `STEP ${ctx.step.index + 1} of ${ctx.path.length}: SYNTHESIZE (${form}).

First choose a CASE CONSTRAINT: one concrete feature of a particular case (a finding, history, anatomy, resource, or timing detail) under which the EVALUATE step's best strategy, applied generically, is insufficient, unsafe, or inapplicable. The constraint must be grounded: derivedFrom cites the ids (c*, r*, o*${ctx.source?.digest ? ', or digest claim ids cl*' : ''}) that establish why the generic strategy fails under it. It will become the defining feature of the item's vignette, so a learner who merely knows the standard recommendation must still fail without adapting it.${ctx.source?.digest?.claims?.some((c) => c.type === 'recommendation') ? `
The source's own recommendations (claims typed "recommendation") are what such a learner knows. Choose a constraint the recommendations do NOT already resolve: if a recommendation states what to do under your feature (for example a staging rule for volume beyond capacity), the adapted plan is just that recommendation and the item is recall. Your plan will be checked against the recommendations; a plan they fully entail is rejected.` : ''}

Then produce the ${form} ADAPTED to that constraint: it follows from the EVALUATE judgment, integrates specific recalled facts and analyzed relations, and says what changes for this case (sequencing, conditions "if … then", timing, safeguards, staging, substitution). The plan must be more than the best strategy restated, and the adaptation must change what is DONE: a plan whose only adaptation is counseling, consent, documentation, or reassurance is the best strategy plus talk, and is rejected.

Then produce exactly one incomplete alternative for each step (${prior.join(', ')}, ${ctx.step.id}): the plan a learner would produce if that step were skipped or done wrong. For "${ctx.step.id}" itself, the alternative is the evaluated best strategy applied generically, ignoring the case constraint (a learner who judged correctly but did not adapt). Each must be plausible, the same length and register as the real synthesis, and wrong for a nameable reason.

Rules:
- "integrates" lists ids (c*, r*, o*) the synthesis depends on; at least one from each earlier step.
- Never refer to "the article", "the study", or "the text".`;
  },

  verify(artifact, ctx) {
    const problems = [];
    const expected = [...ctx.priorSteps.map((s) => s.id), ctx.step.id];
    const seen = artifact.incompleteAlternatives.map((a) => a.skippedStep);
    for (const p of expected) if (!seen.includes(p)) problems.push(`missing incomplete alternative for step '${p}'`);
    if (seen.length !== expected.length) problems.push(`expected ${expected.length} alternatives, got ${seen.length}`);
    if (artifact.synthesis.statement.trim().split(/\s+/).length < 18) problems.push('synthesis statement is too short to carry sequencing/conditions/safeguards');
    const known = new Set();
    for (const a of Object.values(ctx.artifacts)) {
      for (const c of a?.concepts ?? []) known.add(c.id);
      for (const r of a?.relations ?? []) known.add(r.id);
      for (const o of a?.options ?? []) known.add(o.id);
    }
    for (const id of artifact.synthesis.integrates) if (!known.has(id)) problems.push(`integrates unknown id ${id}`);
    const cc = artifact.caseConstraint;
    if (!cc || cc.feature.trim().split(/\s+/).length < 5) problems.push('caseConstraint.feature is missing or too short to define a case');
    const novel = String(artifact.synthesis.novelElement ?? '');
    const SOFT = /\b(counsel(?:ing)?|consent|document(?:ation|ing)?|discuss(?:ion|ing)?|explain(?:ing)?|inform(?:ing)?|reassur(?:e|ance|ing)|teach-?back|educat(?:e|ion|ing)|disclos(?:e|ure|ing)|acknowledg(?:e|ement|ing)|warn(?:ing)?)\b/i;
    const HARD = /\b(stag(?:e|ed|ing)|substitut(?:e|ion|ing)|defer(?:red|ral|ring)?|postpon(?:e|ed|ing)|withh(?:o|e)ld(?:ing)?|switch(?:ing|ed)?|limit(?:ed|ing)?|cap(?:ped|ping)?|reduc(?:e|ed|ing|tion)|increas(?:e|ed|ing)|add(?:ed|ing|ition)?|remov(?:e|ed|ing|al)|omit(?:ted|ting)?|us(?:e|ing) (?:a|an|the)|choos(?:e|ing)|select(?:ed|ing|ion)?|threshold|sequenc(?:e|ed|ing)|order(?:ed|ing)?|timing|delay(?:ed|ing)?|monitor(?:ed|ing)?|imag(?:e|ing)|ultrasound|guidance|cannula|port|plane|volume|dose|aliquot|session|stop(?:ped|ping)?|halt(?:ed|ing)?|abort(?:ed|ing)?|convert(?:ed|ing)?|declin(?:e|ed|ing)|refus(?:e|ed|ing)|refer(?:ral|red|ring)?|admit(?:ted|ting)?|observ(?:e|ation|ing)|test(?:ing|s)?|measur(?:e|ed|ing)|check(?:ed|ing)?|verif(?:y|ied|ication)|confirm(?:ed|ing)? (?:the )?(?:plane|position|depth)|safeguard|protocol|technique|dressing|antibiotic|anticoagul|transfus|surgery|surgical|operat(?:e|ive|ion)|procedure)\b/i;
    if (SOFT.test(novel) && !HARD.test(novel)) problems.push(`novelElement adapts only by counseling/consent/documentation ("${novel.slice(0, 70)}…"); the adaptation must change what is done`);
    for (const a of ctx.source?.digest?.claims ?? []) known.add(a.id);
    for (const id of cc?.derivedFrom ?? []) if (!known.has(id)) problems.push(`caseConstraint cites unknown id ${id}`);
    for (const u of ctx.source?.focus?.usedConstraints ?? []) {
      if (cc && (spanFound(cc.feature, u.feature).found || spanFound(u.feature, cc.feature).found)) problems.push(`caseConstraint duplicates ${u.item}'s ("${u.feature.slice(0, 60)}…"); choose a different feature of a different case`);
    }
    return problems;
  },

  /** The adapted plan must not be fully entailed by the source's claims (else the item is recall of the source, whatever path built it). */
  async verifyAsync(artifact, ctx, { model, mock } = {}) {
    const claims = ctx.source?.digest?.claims ?? [];
    if (!claims.length) return { skipped: true, problems: [] };
    const notes = notesFromClaims(claims, 'every claim of the source');
    const r = await entailedByNotes({ statement: artifact.synthesis.statement, notes, model, label: `${ctx.step.id}:digest-entailment`, mockEntailed: false });
    const problems = r.entailed ? [`the synthesized plan is fully entailed by the source's own claims (${r.citedNotes.join(', ')}); it tests recall of the source, not adaptation. Choose a case constraint the source does not resolve and a plan whose adaptation the source does not state`] : [];
    return { skipped: false, entailed: r.entailed, citedNotes: r.citedNotes, missingClause: r.missingClause, usage: r.usage, problems };
  },

  mock(ctx) {
    const prior = ctx.priorSteps.map((s) => s.id);
    const ids = [];
    for (const a of Object.values(ctx.artifacts)) {
      if (a?.concepts) ids.push(a.concepts[0].id);
      if (a?.relations) ids.push(a.relations[0].id);
      if (a?.best) ids.push(a.best);
    }
    return {
      caseConstraint: {
        feature: '[MOCK] The patient has a feature that makes the generic strategy insufficient here.',
        whyGenericInsufficient: '[MOCK] The generic strategy does not account for that feature.',
        derivedFrom: [ids[0] ?? 'c1'],
      },
      synthesis: {
        statement: `[MOCK] Integrated ${ctx.step.params.form}: perform the best strategy first, then escalate to the second strategy if the first fails, while maintaining the safeguard throughout and reassessing.`,
        integrates: ids.length >= 2 ? ids : [...ids, 'c1'],
        novelElement: '[MOCK] Adds sequencing and a safeguard.',
      },
      incompleteAlternatives: [...prior, ctx.step.id].map((p) => ({
        skippedStep: p,
        statement: `[MOCK] Plan that results when ${p} is skipped or done wrong, in the same register.`,
        whyWrong: `[MOCK] Misses what ${p} establishes.`,
      })),
    };
  },
};
