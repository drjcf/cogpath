/**
 * Verification of a short-answer item. The same questions as the multiple-choice checks, asked of a rubric:
 *   grounding        local: every recall/analyze span is found in the source text (shared with the MCQ checks)
 *   answerability    2 calls: an expert with the source and no rubric writes an answer; a grader scores it against the
 *                    rubric, quoting the answer for every element it credits. Every element must be met. (Replaces cover-the-options.)
 *   modelAnswerScore 1 call: the same grader scores the model answer; it must earn every element (the rubric is satisfiable by the key).
 *   sourceRecall     the model answer must NOT be fully entailed by the source's recommendations alone
 *   digestRecall     the model answer must NOT be fully entailed by the source's claims alone
 *   pathNecessity    n+1 calls: for each node, notes of every node except it and the nodes that depend on it (no source, no
 *                    outside knowledge): the node's element and the terminal element must NOT be established. With every
 *                    node's notes, every element must be. (Replaces "the key is determinable only with the full path".)
 *   elementMapping   deep: corrupt a node's artifact, re-run the nodes that depend on it, and ask which elements the
 *                    notes establish; the terminal element must NOT be. Confirms an error at any node breaks the answer.
 * Entailment is judged by the same local discipline as the MCQ picker (verifier.judgeEntry): a claim stands only with
 * existing cited notes and quotes that occur in them and bear on the claim.
 */
import { obj, arr, str, enm, bool, assertStrict } from './schema.js';
import { complete, part } from './llm.js';
import { runSteps, PREAMBLE } from './executor.js';
import { descendantIds } from './path.js';
import { spanFound, notesFromClaims, entailedByNotes, notesFor, judgeEntry, verifyGrounding, corruptArtifact, withheldSource } from './verifier.js';

const scenario = (item) => `SCENARIO:\n${item.stem}\n\nQUESTION:\n${item.leadIn}`;
const rubricText = (item) => item.rubric.map((e) => `${e.id}: ${e.requirement}`).join('\n');
const firstWords = (t, n) => String(t).replace(/[{}\[\]"]/g, ' ').trim().split(/\s+/).slice(0, n).join(' ');

// ─── grading an answer against the rubric ───────────────────

export function gradeSchema(item) {
  return assertStrict(obj({
    marks: arr(obj({
      elementId: enm(item.rubric.map((e) => e.id)),
      met: bool('true only if the answer, as written, shows what the requirement asks for'),
      evidence: str('VERBATIM text copied from the ANSWER (≤ 30 words) that shows it; empty string when not met'),
    }), 'One entry per element, in order'),
  }));
}

/** A credit stands only if the grader quoted the answer, and the quote is in it. Pure. */
export function judgeGrade(json, item, answer) {
  const marks = item.rubric.map((el) => {
    const m = (json.marks ?? []).find((x) => x.elementId === el.id);
    const rawMet = Boolean(m?.met);
    const found = rawMet && Boolean(m.evidence) && spanFound(m.evidence, answer).found;
    return { elementId: el.id, nodeId: el.nodeId, rawMet, met: found, evidence: m?.evidence ?? '', override: rawMet && !found ? 'credited without a quote from the answer' : null };
  });
  return { marks, score: marks.filter((m) => m.met).length, max: item.rubric.length };
}

export async function gradeAnswer({ item, answer, model, label }) {
  const schema = gradeSchema(item);
  const res = await complete({
    instructions: 'You grade a short written answer against an analytic rubric. For each element decide, from the ANSWER alone, whether it shows what the requirement asks for, and quote the answer text that shows it. Credit only what the answer says; do not credit what it might have meant, and do not use outside knowledge to fill gaps in the answer.',
    parts: [part.text(scenario(item)), part.text(`ANSWER:\n${answer}`), part.text(`RUBRIC ELEMENTS:\n${rubricText(item)}\n\nFor EACH element: met or not met, with a verbatim quote from the ANSWER when met.`)],
    schema, schemaName: 'grade', effort: 'low', model, label, maxOutputTokens: 4096,
    mock: () => ({ marks: item.rubric.map((e) => ({ elementId: e.id, met: true, evidence: firstWords(answer, 6) })) }),
  });
  return { ...judgeGrade(res.json, item, answer), usage: res.usage };
}

export async function verifyAnswerability({ trace, source, model }) {
  const item = trace.item;
  const schema = assertStrict(obj({ answer: str('Your written answer: the decision and the reasoning behind it, 2 to 4 sentences') }));
  const free = await complete({
    instructions: PREAMBLE,
    parts: [...source.parts, part.text(`${scenario(item)}\n\nAnswer the question for this scenario from the source. Every constraint the scenario states is binding: do not propose anything the scenario rules out or makes unavailable, and address any acute problem the scenario presents before anything elective. No rubric is provided; state the decision and the reasoning behind it in 2 to 4 sentences.`)],
    schema, schemaName: 'short_answer', effort: 'medium', model, label: 'verify:answerability:answer', maxOutputTokens: 4096,
    mock: () => ({ answer: `[MOCK] ${item.modelAnswer}` }),
  });
  const g = await gradeAnswer({ item, answer: free.json.answer, model, label: 'verify:answerability:grade' });
  return { answer: free.json.answer, marks: g.marks, score: g.score, max: g.max, pass: g.score === g.max, usage: [free.usage, g.usage] };
}

export async function verifyModelAnswerScore({ trace, model }) {
  const item = trace.item;
  const g = await gradeAnswer({ item, answer: item.modelAnswer, model, label: 'verify:modelAnswer:grade' });
  return { marks: g.marks, score: g.score, max: g.max, pass: g.score === g.max, usage: g.usage };
}

// ─── source recall ──────────────────────────────────────────

/** Is the model answer entailed by the source's claims alone? which: 'sourceRecall' (recommendations) | 'digestRecall' (every claim). */
export async function verifyShortRecall({ trace, source, model, which }) {
  const item = trace.item;
  if (!source.digest) return { skipped: true, reason: which === 'sourceRecall' ? 'no digest (claim types unknown)' : 'no digest' };
  const all = source.digest.claims ?? [];
  const use = which === 'sourceRecall' ? all.filter((c) => c.type === 'recommendation') : all;
  if (!use.length) return { skipped: true, reason: which === 'sourceRecall' ? 'no recommendation claims in the digest' : 'no digest' };
  const noun = which === 'sourceRecall' ? `the ${use.length} recommendation claims` : `the source's ${use.length} claims`;
  const notes = notesFromClaims(use, which === 'sourceRecall' ? 'the source\'s recommendations' : 'every claim of the source');
  const r = await entailedByNotes({ statement: item.modelAnswer, notes, model, label: `verify:${which}`, mockEntailed: false });
  return {
    skipped: false, claims: which === 'sourceRecall' ? use.map((c) => c.id) : use.length, entailed: r.entailed, citedNotes: r.citedNotes, missingClause: r.missingClause, evidence: r.evidence, why: r.why, usage: r.usage, pass: !r.entailed,
    verdict: r.entailed ? `the model answer is entailed by ${noun} alone (${r.citedNotes.join(', ')}): the item is answerable by recall of the source` : `the model answer is not entailed by ${noun} alone${r.missingClause ? ` (not established: ${r.missingClause})` : ''}`,
  };
}

// ─── which elements do these notes establish? ───────────────

export function elementPickSchema(item) {
  return assertStrict(obj({
    elements: arr(obj({
      elementId: enm(item.rubric.map((e) => e.id)),
      fullyEntailed: bool('true only if the point this requirement asks an answer to make is stated or strictly implied by the notes'),
      citedNotes: arr(str('note id (step id, c*, r*, o*) that establishes part of the point'), 'Ids of the notes that establish the point; empty if none'),
      evidence: arr(obj({
        clause: str('A part of the point, in your own words'),
        noteId: str('The note id that establishes this part'),
        quote: str('VERBATIM text copied from that note (≤ 25 words) that establishes it'),
      }), 'For an established element: one entry per part of the point. Empty when not established.'),
      missingClause: str('The first part of the point that the notes do not establish; empty if established'),
    }), 'One entry per element, in order'),
  }));
}

/**
 * Ask which rubric elements the supplied notes establish. Each element stands only under the same local discipline as
 * an MCQ pick (judgeEntry). `mockEntailed` is the set of element ids the mock picker establishes.
 */
export async function pickElements({ item, notes, model, label, mockEntailed = new Set() }) {
  const schema = elementPickSchema(item);
  const res = await complete({
    instructions: 'You are a careful reader who is forbidden from using any knowledge outside the NOTES provided. You decide by entailment: the point a requirement asks an answer to make is established only if every part of it is stated or strictly implied by the notes. Cite the note ids you rely on and quote them verbatim.',
    parts: [part.text(scenario(item)), part.text(notes.text), part.text(`RUBRIC ELEMENTS (each asks a written answer to make a point):\n${rubricText(item)}\n\nFor EACH element, state whether the notes fully establish the point it asks for, citing and quoting the notes that do. Never use outside knowledge; if you find yourself knowing the point rather than reading it in the notes, that is not entailment.`)],
    schema, schemaName: 'element_pick', effort: 'low', model, label, maxOutputTokens: 4096,
    mock: () => ({ elements: item.rubric.map((e) => {
      const on = mockEntailed.has(e.id);
      const id = [...notes.ids][0];
      const q = id ? firstWords(notes.textOf(id), 8) : '';
      return { elementId: e.id, fullyEntailed: on, citedNotes: on && id ? [id] : [], evidence: on && id ? [{ clause: q, noteId: id, quote: q }] : [], missingClause: on ? '' : '[MOCK] part' };
    }) }),
  });
  return { elements: judgeElements(res.json, item, notes), usage: res.usage };
}

/** The picker's per-element answers under the local discipline. Pure, so stored picks can be re-judged. */
export function judgeElements(json, item, notes) {
  return item.rubric.map((el) => {
    const e = (json.elements ?? []).find((x) => x.elementId === el.id);
    const j = judgeEntry(e, notes, 'element');
    return { elementId: el.id, nodeId: el.nodeId, raw: Boolean(e?.fullyEntailed), entailed: j.entailed, override: e?.fullyEntailed ? j.override : null, citationsFixed: j.citationsFixed, citedNotes: e?.citedNotes ?? [], evidence: e?.evidence ?? [], missingClause: e?.missingClause ?? '' };
  });
}

// ─── path necessity ─────────────────────────────────────────

/**
 * The verdict on a set of necessity picks (pure, so stored picks can be re-summarized): with every node's notes every
 * element must be established, and with a node (and the nodes that depend on it) withheld, neither that node's element
 * nor the terminal element may be.
 */
export function shortNecessitySummary({ picks, rubric, path }) {
  const terminalEl = rubric.find((e) => e.nodeId === path[path.length - 1].id);
  const full = picks.find((p) => p.without == null);
  const unsupported = rubric.filter((e) => !full?.entailed.includes(e.id)).map((e) => e.id);
  const leaked = [];
  for (const p of picks) {
    if (p.without == null) continue;
    const own = rubric.find((e) => e.nodeId === p.without);
    const watch = [...new Set([own, terminalEl].filter(Boolean))];
    const hit = watch.filter((e) => p.entailed.includes(e.id)).map((e) => e.id);
    if (hit.length) leaked.push({ without: p.without, elements: hit });
  }
  const pass = unsupported.length === 0 && leaked.length === 0;
  const verdict = pass ? 'every node is needed: with it withheld its element and the final element are not established, and the full path establishes every element'
    : unsupported.length ? `the full path does not establish element${unsupported.length > 1 ? 's' : ''} ${unsupported.join(', ')}: the rubric asks for more than the path supplies`
    : `${leaked.map((l) => `${l.elements.join(', ')} still established without ${l.without}`).join('; ')} (and the nodes that depend on it): not necessary`;
  return { pass, unsupported, leaked, verdict, leaksContained: picks.filter((p) => p.elements?.some((e) => e.override)).length };
}

export async function verifyShortNecessity({ trace, model, onEvent }) {
  const item = trace.item;
  const path = trace.path;
  const all = new Set(item.rubric.map((e) => e.id));
  const cases = [...path.map((v) => ({ without: v.id, drop: new Set([v.id, ...descendantIds(path, v.id)]) })), { without: null, drop: new Set() }];
  const picks = [];
  for (const c of cases) {
    const steps = path.filter((s) => !c.drop.has(s.id));
    const notes = notesFor(trace.artifacts, steps);
    const r = await pickElements({ item, notes, model, label: `verify:necessity:${c.without ?? 'all'}`, mockEntailed: c.without === null ? all : new Set() });
    const entailed = r.elements.filter((e) => e.entailed).map((e) => e.elementId);
    picks.push({ k: steps.length, without: c.without, steps: steps.map((s) => s.id), entailed, elements: r.elements, usage: r.usage });
    onEvent?.({ type: 'verify:necessity', k: steps.length, without: c.without, entailed });
  }
  picks.sort((x, y) => x.k - y.k);
  return { picks, pathLength: path.length, ...shortNecessitySummary({ picks, rubric: item.rubric, path }) };
}

// ─── element mapping (deep) ─────────────────────────────────

export async function verifyElementMapping({ trace, source, model, onEvent }) {
  const item = trace.item;
  const path = trace.path;
  const terminalEl = item.rubric.find((e) => e.nodeId === path[path.length - 1].id);
  const perStep = [];
  for (let k = 0; k < path.length; k++) {
    const step = path[k];
    const corrupted = await corruptArtifact({ trace, source, stepIndex: k, model });
    const cone = descendantIds(path, step.id);
    const kept = Object.fromEntries(path.filter((s) => s.id !== step.id && !cone.includes(s.id)).map((s) => [s.id, trace.artifacts[s.id]]));
    const { artifacts } = await runSteps({ source: withheldSource(source), path, only: cone, artifacts: { ...kept, [step.id]: corrupted }, model, effort: 'low', label: `verify:map:${step.id} ` });
    const notes = notesFor(artifacts, path);
    const r = await pickElements({ item, notes, model, label: `verify:map:pick:${step.id}` });
    const entailed = r.elements.filter((e) => e.entailed).map((e) => e.elementId);
    const own = item.rubric.find((e) => e.nodeId === step.id);
    const terminalBlocked = !terminalEl || !entailed.includes(terminalEl.id);
    perStep.push({ step: step.id, entailed, elements: r.elements, terminalBlocked, ownBroken: !own || !entailed.includes(own.id), corruptedArtifact: corrupted, downstream: artifacts });
    onEvent?.({ type: 'verify:mapping', step: step.id, entailed, terminalBlocked });
  }
  const blocked = perStep.filter((p) => p.terminalBlocked).length;
  const own = perStep.filter((p) => p.ownBroken).length;
  // Pass = an error at any node leaves the final element unestablished.
  return { perStep, terminalBlocked: blocked, ownBroken: own, total: path.length, pass: blocked === path.length };
}

// ─── runner ─────────────────────────────────────────────────

export async function verifyShortItem({ trace, source, model, deep = false, onEvent }) {
  const grounding = verifyGrounding(trace, source.text);
  const answerability = await verifyAnswerability({ trace, source, model });
  const modelAnswerScore = await verifyModelAnswerScore({ trace, model });
  const sourceRecall = await verifyShortRecall({ trace, source, model, which: 'sourceRecall' });
  onEvent?.({ type: 'verify:sourceRecall', ...sourceRecall });
  const digestRecall = await verifyShortRecall({ trace, source, model, which: 'digestRecall' });
  onEvent?.({ type: 'verify:digestRecall', ...digestRecall });
  const pathNecessity = await verifyShortNecessity({ trace, model, onEvent });
  const elementMapping = deep ? await verifyElementMapping({ trace, source, model, onEvent }) : null;
  const checks = [
    ['grounding', grounding.skipped ? null : grounding.pass],
    ['answerability', answerability.pass],
    ['modelAnswerScore', modelAnswerScore.pass],
    ['sourceRecall', sourceRecall.skipped ? null : sourceRecall.pass],
    ['digestRecall', digestRecall.skipped ? null : digestRecall.pass],
    ['pathNecessity', pathNecessity.pass],
    ['elementMapping', elementMapping ? elementMapping.pass : null],
  ];
  const applicable = checks.filter(([, v]) => v !== null);
  return {
    format: 'short', grounding, answerability, modelAnswerScore, sourceRecall, digestRecall, pathNecessity, elementMapping,
    summary: { passed: applicable.filter(([, v]) => v).length, applicable: applicable.length, pass: applicable.every(([, v]) => v), checks: Object.fromEntries(checks) },
  };
}
