/**
 * Verification of a compiled item. Four checks:
 *   grounding          local: every recall/analyze span is found in the source text
 *   coverTheOptions    2 calls: free answer from stem + lead-in only, then mapped to an option; must map to the key
 *   pathNecessity      n+1 calls: with notes from steps 1..k only (no source, no outside knowledge), the key should
 *                      become determinable only at k = n. Earlier = the item is answerable without the later steps.
 *   distractorMapping  deep: corrupt artifact k, re-run the downstream steps, pick an option; expect the distractor
 *                      tagged failsAt = step k. Confirms each distractor really is "what a learner who failed there picks".
 */
import { obj, arr, str, enm, num, bool, assertStrict } from './schema.js';
import { complete, part } from './meta.js';
import { getOp, schemaOf } from './ops/index.js';
import { runSteps, PREAMBLE } from './executor.js';

const UNDETERMINED = 'UNDETERMINED';

export function itemText(item) {
  return `SCENARIO:\n${item.stem}\n\nQUESTION:\n${item.leadIn}\n\nOPTIONS:\n${item.options.map((o) => `${o.id}. ${o.text}`).join('\n')}`;
}

export function notesFor(artifacts, steps) {
  const ids = new Set();
  const byId = new Map(); // id → the JSON text a quote may be checked against
  for (const st of steps) {
    const a = artifacts[st.id];
    const whole = JSON.stringify(a, null, 2);
    ids.add(st.id); byId.set(st.id, whole);
    for (const c of a?.concepts ?? []) { ids.add(c.id); byId.set(c.id, JSON.stringify(c)); }
    for (const r of a?.relations ?? []) { ids.add(r.id); byId.set(r.id, JSON.stringify(r)); }
    for (const o of a?.options ?? []) { ids.add(o.id); byId.set(o.id, JSON.stringify(o)); }
  }
  const text = steps.length === 0 ? 'NOTES: none.'
    : `NOTES (everything you may use; do not use outside knowledge):\n\n${steps.map((st) => `### ${st.id}\n${byId.get(st.id)}`).join('\n\n')}`;
  return { text, ids, textOf: (id) => byId.get(id) ?? '' };
}

function pickSchema(item) {
  const letters = item.options.map((o) => o.id);
  return assertStrict(obj({
    entailment: arr(obj({
      optionId: enm(letters),
      fullyEntailed: bool('true only if EVERY clause of the option is stated or strictly implied by the notes'),
      citedNotes: arr(str('note id (step id, c*, r*, o*) that entails part of the option'), 'Ids of the notes that entail the option; empty if none'),
      evidence: arr(obj({
        clause: str('A clause of the option, in the option\'s own words'),
        noteId: str('The note id that entails this clause'),
        quote: str('VERBATIM text copied from that note (≤ 25 words) that establishes the clause'),
      }), 'For a fully-entailed option: one entry per clause. Empty when not fully entailed.'),
      missingClause: str('The first clause of the option that the notes do not establish; empty if fully entailed'),
    }), 'One entry per option, in order'),
    bestSupported: enm(letters, 'If forced to choose: the option most consistent with the notes, even when no option is fully entailed'),
    choice: enm([...letters, UNDETERMINED], `The single fully-entailed option, or ${UNDETERMINED} when zero or more than one option is fully entailed`),
    reason: str('One sentence'),
  }));
}

/**
 * Ask for a choice given only the item and the supplied notes, with per-option entailment citations.
 * Knowledge leakage is contained locally: a choice is honored only if the picker marked it fully entailed AND
 * every cited note id exists in the notes; otherwise the pick is overridden to UNDETERMINED and the reason recorded.
 */
async function pickWithNotes({ item, notes, model, mockChoice, label }) {
  const schema = pickSchema(item);
  const res = await complete({
    instructions: 'You are a careful test-taker who is forbidden from using any knowledge outside the NOTES provided. You decide by entailment: an option is determined only if every clause of it is stated or strictly implied by the notes. Cite the note ids you rely on.',
    parts: [part.text(itemText(item)), part.text(notes.text), part.text(`For EACH option, state whether the notes fully entail it and cite the note ids that do. Then choose: the one fully-entailed option, or ${UNDETERMINED} if none or several are fully entailed. Never use outside knowledge; if you find yourself knowing the answer rather than reading it in the notes, that is not entailment.`)],
    schema, schemaName: 'pick', effort: 'low', model, label, maxOutputTokens: 4096, cacheKey: 'cogpath:verify',
    mock: () => ({ entailment: item.options.map((o) => {
      const on = o.id === mockChoice;
      const id = [...notes.ids][0];
      const q = id ? notes.textOf(id).replace(/[{}\[\]"]/g, ' ').trim().split(/\s+/).slice(0, 8).join(' ') : '';
      return { optionId: o.id, fullyEntailed: on, citedNotes: on && id ? [id] : [], evidence: on && id ? [{ clause: q, noteId: id, quote: q }] : [], missingClause: on ? '' : '[MOCK] clause' };
    }), bestSupported: mockChoice === UNDETERMINED ? item.options[0].id : mockChoice, choice: mockChoice, reason: '[MOCK]' }),
  });
  const judged = judgePick(res.json, notes);
  return { raw: res.json.choice, choice: judged.choice, lean: res.json.bestSupported, reason: res.json.reason, entailment: res.json.entailment, override: judged.override, citationsFixed: judged.citationsFixed, usage: res.usage };
}

/**
 * The local discipline applied to a picker's answer (pure: no model call), so stored picks can be re-judged when the
 * rule changes. A choice stands only if the picker marked it fully entailed, cited notes that exist, and gave quoted
 * evidence for it; each quote must occur verbatim in a note at this depth (the cited one, or another: a quote that
 * sits in a different note than the picker named is a mis-citation, not a leak, and is re-attributed), and must share
 * content with the clause it is cited for. When a quote does not bear on its clause, the note it came from and then
 * every note at this depth must carry at least half of the clause's content words; otherwise the clause came from
 * outside the notes and the pick is overridden to UNDETERMINED.
 */
export function judgePick(json, notes) {
  const out = { choice: json.choice, override: null, citationsFixed: [] };
  if (out.choice === UNDETERMINED) return out;
  const e = (json.entailment ?? []).find((x) => x.optionId === out.choice);
  const unknown = (e?.citedNotes ?? []).filter((id) => !notes.ids.has(id));
  if (!e || !e.fullyEntailed) out.override = 'chosen option not marked fully entailed';
  else if ((e.citedNotes ?? []).length === 0) out.override = 'no notes cited (answer came from outside knowledge)';
  else if (unknown.length) out.override = `cited notes that do not exist: ${unknown.join(', ')}`;
  else if ((e.evidence ?? []).length === 0) out.override = 'no quoted evidence for the chosen option';
  else {
    const ids = [...notes.ids];
    const located = (e.evidence ?? []).map((ev) => {
      if (notes.ids.has(ev.noteId) && spanFound(ev.quote, notes.textOf(ev.noteId)).found) return { ev, noteId: ev.noteId };
      const elsewhere = ids.find((id) => id !== ev.noteId && spanFound(ev.quote, notes.textOf(id)).found);
      if (elsewhere) { out.citationsFixed.push({ clause: ev.clause, cited: ev.noteId, found: elsewhere }); return { ev, noteId: elsewhere }; }
      return { ev, noteId: null };
    });
    const bad = located.filter((l) => !l.noteId);
    if (bad.length) out.override = `quoted evidence not found in any note at this depth: ${bad.map((b) => `${b.ev.noteId}: "${String(b.ev.quote).slice(0, 50)}"`).join('; ')}`;
    else {
      const allNotes = ids.map((id) => notes.textOf(id)).join('\n');
      const weak = located.filter(({ ev, noteId }) => !clauseSupported(ev.clause, ev.quote) && !clauseSupported(ev.clause, notes.textOf(noteId), NOTE_SUPPORT_FRACTION) && !clauseSupported(ev.clause, allNotes, NOTE_SUPPORT_FRACTION));
      if (weak.length) out.override = `the notes do not carry the content of the clause(s): ${weak.map((b) => `"${String(b.ev.clause).slice(0, 50)}" (cited ${b.ev.noteId})`).join('; ')}`;
    }
  }
  if (out.override) out.choice = UNDETERMINED;
  return out;
}

// ─── 1. grounding ───────────────────────────────────────────

import { spanFound, clauseSupported, NOTE_SUPPORT_FRACTION } from './textmatch.js';
import { notesFromClaims, entailedByNotes } from './entail.js';
export { spanFound, notesFromClaims, entailedByNotes };

export function verifyGrounding(trace, sourceText) {
  if (!sourceText) return { skipped: true, reason: 'no local source text' };
  const checks = [];
  for (const s of trace.path) {
    const a = trace.artifacts[s.id];
    for (const c of a?.concepts ?? []) checks.push({ step: s.id, id: c.id, span: c.sourceSpan, ...spanFound(c.sourceSpan, sourceText) });
    for (const r of a?.relations ?? []) checks.push({ step: s.id, id: r.id, span: r.evidenceSpan, ...spanFound(r.evidenceSpan, sourceText) });
  }
  const missing = checks.filter((c) => !c.found);
  return { skipped: false, checked: checks.length, found: checks.length - missing.length, missing, pass: missing.length === 0 };
}

// ─── 2. cover the options ───────────────────────────────────

export async function verifyCoverTheOptions({ trace, source, model }) {
  const item = trace.item;
  const freeSchema = assertStrict(obj({ answer: str('Your answer in one or two sentences'), confidence: num('0–1', { minimum: 0, maximum: 1 }) }));
  const free = await complete({
    instructions: PREAMBLE,
    // The free answer must be for THIS scenario: a constraint the scenario states (a modality unavailable, a limit the
    // patient sets, a complication present) rules its alternatives out, and an emergency in the scenario is answered
    // before anything elective. Otherwise the free answer is the generic one and the mapping is a coin toss between the
    // key and the distractor built from the generic plan.
    parts: [...source.parts, part.text(`SCENARIO:\n${item.stem}\n\nQUESTION:\n${item.leadIn}\n\nAnswer the question for this scenario from the source. Every constraint the scenario states is binding: do not propose anything the scenario rules out or makes unavailable, and address any acute problem the scenario presents before anything elective. No options are provided; state your answer.`)],
    schema: freeSchema, schemaName: 'free_answer', effort: 'medium', model, label: 'verify:cover:free', maxOutputTokens: 4096, cacheKey: source.cacheKey,
    mock: () => ({ answer: '[MOCK] ' + item.options.find((o) => o.isKey).text, confidence: 0.8 }),
  });
  const mapSchema = assertStrict(obj({ optionId: enm(item.options.map((o) => o.id)), match: enm(['exact', 'close', 'none'], 'How well the free answer matches the chosen option') }));
  const mapped = await complete({
    instructions: 'You map a free-text answer onto the closest multiple-choice option.',
    parts: [part.text(`FREE ANSWER:\n${free.json.answer}\n\nOPTIONS:\n${item.options.map((o) => `${o.id}. ${o.text}`).join('\n')}\n\nWhich option is closest in meaning to the free answer?`)],
    schema: mapSchema, schemaName: 'map_answer', effort: 'minimal', model, label: 'verify:cover:map', maxOutputTokens: 2048, cacheKey: 'cogpath:verify',
    mock: () => ({ optionId: item.key, match: 'close' }),
  });
  return { freeAnswer: free.json.answer, confidence: free.json.confidence, mappedTo: mapped.json.optionId, match: mapped.json.match, key: item.key, pass: mapped.json.optionId === item.key && mapped.json.match !== 'none', usage: [free.usage, mapped.usage] };
}

// ─── 2b. source recall (digest mode) ────────────────────────


/**
 * Is the key entailed by the source's own recommendations alone? If so, the item tests recall of the
 * source's conclusions, whatever path built it: an examinee who knows the recommendation list answers it
 * without analysis, evaluation, or synthesis. Only possible in digest mode (claims carry types).
 */
export async function verifySourceRecall({ trace, source, model }) {
  const item = trace.item;
  if (!source.digest) return { skipped: true, reason: 'no digest (claim types unknown)' };
  const recs = source.digest.claims.filter((a) => a.type === 'recommendation');
  if (!recs.length) return { skipped: true, reason: 'no recommendation claims in the digest' };
  const notes = notesFromClaims(recs, 'the source\'s recommendations');
  const r = await pickWithNotes({ item, notes, model, label: 'verify:sourceRecall', mockChoice: UNDETERMINED });
  const pass = r.choice !== item.key;
  return {
    skipped: false, claims: recs.map((a) => a.id), choice: r.choice, lean: r.lean, raw: r.raw, override: r.override, entailment: r.entailment, usage: r.usage, pass,
    verdict: pass ? `key not entailed by the ${recs.length} recommendation claims alone${r.lean === item.key ? ' (but leans to it)' : ''}` : `key is entailed by the source's recommendations alone (${(r.entailment.find((e) => e.optionId === item.key)?.citedNotes ?? []).join(', ')}): the item is recall of the source's conclusions`,
  };
}

/**
 * Is the key entailed by the source's claims alone (every claim in the digest, no step artifacts)? This is the
 * check that applies equally to a path item and a single-shot item: an item whose key the source states is
 * answerable by recall of the source, whatever reasoning the stem asks for.
 */
export async function verifyDigestRecall({ trace, source, model }) {
  const item = trace.item;
  const claims = source.digest?.claims ?? [];
  if (!claims.length) return { skipped: true, reason: 'no digest' };
  const notes = notesFromClaims(claims, 'every claim of the source');
  const r = await pickWithNotes({ item, notes, model, label: 'verify:digestRecall', mockChoice: UNDETERMINED });
  const pass = r.choice !== item.key;
  return {
    skipped: false, claims: claims.length, choice: r.choice, lean: r.lean, raw: r.raw, override: r.override, entailment: r.entailment, usage: r.usage, pass,
    verdict: pass ? `key not entailed by the source's ${claims.length} claims alone${r.lean === item.key ? ' (but leans to it)' : ''}` : `key is entailed by the source's claims alone (${(r.entailment.find((e) => e.optionId === item.key)?.citedNotes ?? []).join(', ')}): the item is answerable by recall of the source`,
  };
}

// ─── 3. path necessity ──────────────────────────────────────

export async function verifyPathNecessity({ trace, model, onEvent }) {
  const item = trace.item;
  const n = trace.path.length;
  const picks = [];
  for (let k = 0; k <= n; k++) {
    const steps = trace.path.slice(0, k);
    const notes = notesFor(trace.artifacts, steps);
    const r = await pickWithNotes({ item, notes, model, label: `verify:necessity:k${k}`, mockChoice: k === n ? item.key : UNDETERMINED });
    const entailed = r.entailment.filter((e) => e.fullyEntailed).map((e) => e.optionId);
    picks.push({ k, steps: steps.map((s) => s.id), choice: r.choice, lean: r.lean, raw: r.raw, override: r.override, citationsFixed: r.citationsFixed, entailed, reason: r.reason, entailment: r.entailment, usage: r.usage });
    onEvent?.({ type: 'verify:necessity', k, choice: r.choice, lean: r.lean, raw: r.raw, override: r.override, entailed });
  }
  const first = picks.find((p) => p.choice === item.key);
  const determinedAt = first ? first.k : null;
  const leaks = picks.filter((p) => p.override).length;
  return {
    picks, key: item.key, pathLength: n, determinedAt, leaksContained: leaks,
    pass: determinedAt === n,
    verdict: determinedAt === null ? 'key never determined from notes (item may be unanswerable from the path, or the key is not the terminal artifact)'
      : determinedAt === n ? 'key determinable only with the full path'
      : `key determinable after step ${determinedAt} of ${n} (steps ${trace.path.slice(determinedAt).map((s) => s.id).join(', ')} not necessary)`,
  };
}

// ─── 4. distractor mapping (deep) ───────────────────────────

/**
 * Synthesize is corrupted locally and deterministically: the synthesis becomes its own "best strategy alone,
 * unintegrated" alternative (the material the synthesize-tagged distractor is built from) and the
 * incompleteAlternatives are dropped, because their whyWrong fields describe the correct integrated plan.
 */
export function corruptSynthesize(artifact, stepId) {
  const alts = artifact.incompleteAlternatives ?? [];
  const alt = alts.find((a) => a.skippedStep === stepId) ?? alts[alts.length - 1];
  if (!alt) return { ...artifact, incompleteAlternatives: [] };
  return { synthesis: { statement: alt.statement, integrates: artifact.synthesis?.integrates ?? [], novelElement: '' }, incompleteAlternatives: [] };
}

/** Blank the verbatim source quotes of whichever recall facts / analyze relations the corruption changed, so the true text cannot leak through them. */
export function scrubCorruptedQuotes(original, corrupted) {
  const out = JSON.parse(JSON.stringify(corrupted));
  const byId = (xs) => new Map((xs ?? []).map((x) => [x.id, x]));
  const oc = byId(original.concepts);
  for (const c of out.concepts ?? []) if (!oc.has(c.id) || oc.get(c.id).statement !== c.statement) c.sourceSpan = '';
  const orl = byId(original.relations);
  for (const r of out.relations ?? []) if (!orl.has(r.id) || orl.get(r.id).claim !== r.claim || orl.get(r.id).implication !== r.implication) r.evidenceSpan = '';
  return out;
}

async function corruptArtifact({ trace, source, stepIndex, model }) {
  const step = trace.path[stepIndex];
  const op = getOp(step.op);
  if (op.id === 'synthesize') return corruptSynthesize(trace.artifacts[step.id], step.id);
  const ctx = { source, path: trace.path, step, priorSteps: trace.path.slice(0, stepIndex), artifacts: Object.fromEntries(trace.path.slice(0, stepIndex).map((s) => [s.id, trace.artifacts[s.id]])) };
  const schema = schemaOf(op, ctx);
  const hints = {
    recall: 'replace exactly one fact with a subtly false version of itself (plausible, same topic, wrong detail)',
    analyze: 'replace exactly one relation\'s claim and implication with its commonMisreading (and update commonMisreading to the original claim)',
    evaluate: 'swap best and runnerUp (and rewrite decisiveFactor and whyRunnerUpFails to defend the swap); keep options and scores',
  };
  const res = await complete({
    instructions: PREAMBLE,
    parts: [...source.parts, part.text(`CORRECT ARTIFACT for step "${step.id}" (${op.id}):\n${JSON.stringify(trace.artifacts[step.id], null, 2)}`),
      part.text(`Produce a CORRUPTED version of this artifact that a learner who failed at the ${op.id} step would produce: ${hints[op.id] ?? 'introduce exactly one realistic error of the kind a learner makes at this step'}. Change nothing else. The output must satisfy the same schema.`)],
    schema, schemaName: `${op.id}_corrupted`, effort: 'low', model, label: `verify:corrupt:${step.id}`, cacheKey: source.cacheKey,
    mock: () => ({ ...trace.artifacts[step.id], _corrupted: undefined }),
  });
  return scrubCorruptedQuotes(trace.artifacts[step.id], res.json);
}

/** A source stand-in for re-runs that must not be able to repair a corrupted artifact from the text. */
function withheldSource(source) {
  return { ...source, text: '', cacheKey: 'cogpath:verify', parts: [part.text('SOURCE: withheld for this exercise. Work ONLY from the artifacts of earlier steps. Where a field asks for a quotation, copy the most relevant text from those artifacts.')] };
}

export async function verifyDistractorMapping({ trace, source, model, onEvent }) {
  const item = trace.item;
  const n = trace.path.length;
  const perStep = [];
  for (let k = 0; k < n; k++) {
    const step = trace.path[k];
    const corrupted = await corruptArtifact({ trace, source, stepIndex: k, model });
    const prior = Object.fromEntries(trace.path.slice(0, k).map((s) => [s.id, trace.artifacts[s.id]]));
    const { artifacts } = await runSteps({ source: withheldSource(source), path: trace.path, fromIndex: k + 1, artifacts: { ...prior, [step.id]: corrupted }, model, effort: 'low', label: `verify:map:${step.id} ` });
    const expected = item.options.filter((o) => o.failsAt === step.id).map((o) => o.id);
    const notes = notesFor(artifacts, trace.path);
    const r = await pickWithNotes({ item, notes, model, label: `verify:map:pick:${step.id}`, mockChoice: expected[0] ?? UNDETERMINED });
    // keyBlocked is strict (entailment pick); landed uses the forced choice when entailment is undetermined.
    const effective = r.choice !== UNDETERMINED ? r.choice : r.lean;
    const landed = expected.includes(effective);
    const keyBlocked = r.choice !== item.key;
    perStep.push({ step: step.id, expected, picked: r.choice, lean: r.lean, raw: r.raw, override: r.override, citationsFixed: r.citationsFixed, keyBlocked, landed, reason: r.reason, entailment: r.entailment, corruptedArtifact: corrupted, downstream: artifacts });
    onEvent?.({ type: 'verify:mapping', step: step.id, picked: r.choice, lean: r.lean, raw: r.raw, expected, keyBlocked, landed, override: r.override });
  }
  const blocked = perStep.filter((p) => p.keyBlocked).length;
  const landedN = perStep.filter((p) => p.landed).length;
  // Pass = every step failure makes the key unreachable (necessary). Landing on the tagged distractor is reported separately.
  return { perStep, keyBlocked: blocked, landed: landedN, total: n, pass: blocked === n };
}

// ─── runner ─────────────────────────────────────────────────

export async function verifyItem({ trace, source, model, deep = false, onEvent }) {
  const grounding = verifyGrounding(trace, source.text);
  const coverTheOptions = await verifyCoverTheOptions({ trace, source, model });
  const sourceRecall = await verifySourceRecall({ trace, source, model });
  onEvent?.({ type: 'verify:sourceRecall', ...sourceRecall });
  const digestRecall = await verifyDigestRecall({ trace, source, model });
  onEvent?.({ type: 'verify:digestRecall', ...digestRecall });
  const pathNecessity = await verifyPathNecessity({ trace, model, onEvent });
  const distractorMapping = deep ? await verifyDistractorMapping({ trace, source, model, onEvent }) : null;
  const checks = [
    ['grounding', grounding.skipped ? null : grounding.pass],
    ['coverTheOptions', coverTheOptions.pass],
    ['sourceRecall', sourceRecall.skipped ? null : sourceRecall.pass],
    ['digestRecall', digestRecall.skipped ? null : digestRecall.pass],
    ['pathNecessity', pathNecessity.pass],
    ['distractorMapping', distractorMapping ? distractorMapping.pass : null],
  ];
  const applicable = checks.filter(([, v]) => v !== null);
  return {
    grounding, coverTheOptions, sourceRecall, digestRecall, pathNecessity, distractorMapping,
    summary: { passed: applicable.filter(([, v]) => v).length, applicable: applicable.length, pass: applicable.every(([, v]) => v), checks: Object.fromEntries(checks) },
  };
}
