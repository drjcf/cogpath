/**
 * Executes a cognitive path over a source: one structured-output call per step, each step seeing the
 * source plus the artifacts of the steps it depends on (all earlier steps, in a chain), then the ASSEMBLE op
 * builds the item. Steps whose dependencies are done run together.
 *
 * Every call shares the same prefix (framework preamble + source) so the prompt cache
 * covers the source after the first step.
 */
import { randomBytes } from 'node:crypto';
import { getOp, assemblerFor, schemaOf, DEFAULT_FORMAT } from './ops/index.js';
import { validate } from './schema.js';
import { complete, part, DEFAULT_MODEL } from './llm.js';
import { letterOptions } from './ops/assemble.js';
import { finishShort } from './ops/assemble-short.js';
import { formatPath, idBaseOf, depsOf, ancestorIds } from './path.js';
import { wordCount } from './source.js';

export const PREAMBLE = `You are an assessment-design engine. You execute one cognitive operation at a time over a SOURCE, producing a structured artifact that later operations and the final item will depend on. Be precise, grounded in the source, and write every statement as a learner would state it from understanding rather than as a summary of a document. Never refer to "the article", "the study", "the source", "the passage", or "the text". Use the field's standard technical terminology for conditions, anatomy, procedures, and outcomes (e.g. "pulmonary fat embolism", not "lung blockage"); never substitute lay paraphrases for accepted terms.`;

export function newId(prefix = 'run') { return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`; }

export function artifactsBlock(artifacts, steps) {
  const entries = steps.filter((s) => artifacts[s.id] !== undefined).map((s) => `### ${s.id} (${s.op})\n${JSON.stringify(artifacts[s.id], null, 2)}`);
  return entries.length ? `ARTIFACTS FROM EARLIER STEPS:\n\n${entries.join('\n\n')}` : 'ARTIFACTS FROM EARLIER STEPS: none (this is the first step).';
}

/** What an op sees: the steps it depends on (directly or not) and only their artifacts. The assembler sees all of them. */
export function makeCtx({ source, path, step, artifacts }) {
  const anc = new Set(ancestorIds(path, step.id));
  const priorSteps = path.filter((s) => anc.has(s.id));
  return { source, path, step, priorSteps, artifacts: Object.fromEntries(priorSteps.filter((s) => artifacts[s.id] !== undefined).map((s) => [s.id, artifacts[s.id]])), idBase: step.op === 'assemble' ? 0 : idBaseOf(path, step) };
}

/**
 * Execute one op (a path step, or the assembler when `op` is ASSEMBLE) and verify its artifact.
 * On verification problems, retries once with the problems fed back. Returns the step record.
 */
export async function executeOp({ op, source, path, step, artifacts, model, effort, onEvent, label }) {
  const ctx = makeCtx({ source, path, step, artifacts });
  const schema = schemaOf(op, ctx);
  const instruction = op.instruction(ctx);
  const useEffort = effort ?? op.effort;
  const rec = { id: step.id, op: op.id, params: step.params, deps: depsOf(path, step), effort: useEffort, instruction, attempts: [] };
  onEvent?.({ type: 'step:start', step: rec.id, op: op.id, effort: useEffort });

  let feedback = '';
  const maxAttempts = op.maxAttempts ?? 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const parts = [...source.parts, part.text(artifactsBlock(ctx.artifacts, ctx.priorSteps)), part.text(instruction + feedback)];
    const res = await complete({
      instructions: PREAMBLE, parts, schema, schemaName: `${op.id}_output`, effort: useEffort, model,
      maxOutputTokens: op.maxOutputTokens, summary: 'auto', label: `${label ?? ''}${step.id}`, mock: () => op.mock(ctx),
    });
    if (res.notes?.length) rec.notes = [...(rec.notes ?? []), ...res.notes];
    const problems = [];
    const v = validate(schema, res.json);
    if (!v.ok) problems.push(...v.errors.map((e) => `schema: ${e}`));
    else problems.push(...op.verify(res.json, ctx));
    // Model-backed checks (one cheap call) only when the local checks pass; their findings are retried like any other problem.
    let asyncCheck = null;
    if (problems.length === 0 && typeof op.verifyAsync === 'function') {
      asyncCheck = await op.verifyAsync(res.json, ctx, { model, mock: res.mock });
      problems.push(...(asyncCheck?.problems ?? []));
    }
    rec.attempts.push({ attempt, problems, usage: res.usage, ms: res.ms, asyncCheck });
    rec.artifact = res.json;
    rec.usage = res.usage;
    rec.rawUsage = res.rawUsage ?? null;
    rec.ms = (rec.ms ?? 0) + res.ms;
    rec.reasoningSummary = res.reasoningSummary;
    rec.mock = res.mock;
    rec.problems = problems;
    if (problems.length === 0 || res.mock || attempt === maxAttempts) break;
    feedback = `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED FOR THESE REASONS; FIX ALL OF THEM:\n- ${problems.join('\n- ')}`;
    onEvent?.({ type: 'step:retry', step: rec.id, problems });
  }
  onEvent?.({ type: 'step:done', step: rec.id, op: op.id, problems: rec.problems, usage: rec.usage, ms: rec.ms });
  return rec;
}

/**
 * Run the steps of `path` named in `only` (default: all), given artifacts for the others. A step runs once every step it
 * depends on has finished; steps that are ready together run together. `onStep(rec)` is called as each finishes, so a
 * caller keeps finished work if a later step fails (the first failure is thrown after the running steps settle).
 * Returns { steps, artifacts }.
 */
export async function runSteps({ source, path, only, artifacts = {}, model, effort, onEvent, onStep, label }) {
  const todo = new Set(only ?? path.map((s) => s.id));
  const acc = { ...artifacts };
  const out = [];
  const done = new Set(path.filter((s) => !todo.has(s.id)).map((s) => s.id));
  while (todo.size) {
    const ready = path.filter((s) => todo.has(s.id) && depsOf(path, s).every((d) => done.has(d)));
    if (!ready.length) throw new Error(`cannot run ${[...todo].join(', ')}: a step it depends on is neither finished nor scheduled`);
    const settled = await Promise.allSettled(ready.map((step) => executeOp({ op: getOp(step.op), source, path, step, artifacts: acc, model, effort, onEvent, label })));
    for (const [i, r] of settled.entries()) {
      if (r.status !== 'fulfilled') continue;
      acc[ready[i].id] = r.value.artifact; out.push(r.value); onStep?.(r.value);
    }
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    for (const step of ready) { todo.delete(step.id); done.add(step.id); }
  }
  return { steps: out, artifacts: acc };
}

/** One distractor per step, so an MCQ takes at most this many steps; the short-answer format has no such limit. */
export const MAX_MCQ_STEPS = 5;

/**
 * Full run: all steps + assemble. Never throws away completed work: on failure the returned trace has
 * status 'failed', `error`, and every step that finished (the CLI saves it as a partial run).
 */
export async function runPath({ source, path, model = DEFAULT_MODEL, effort, onEvent, seed, format = DEFAULT_FORMAT }) {
  const id = newId();
  const t0 = Date.now();
  const trace = {
    id, status: 'running', createdAt: new Date().toISOString(),
    source: { kind: source.kind, title: source.title, path: source.path, sha: source.sha ?? null, words: wordCount(source.text), mode: source.mode ?? 'raw', digestClaims: source.digest?.claims?.length ?? 0, digestReview: source.digestReview ?? null, focus: source.focus ?? null },
    format, model, pathText: formatPath(path), path, steps: [], artifacts: {}, assemble: null, item: null, totals: null, verification: null, error: null,
  };
  try {
    const assembler = assemblerFor(format); // rejects an unknown format before any call
    if (format === 'mcq' && path.length > MAX_MCQ_STEPS) throw new Error(`A multiple-choice item has one distractor per step, so it takes at most ${MAX_MCQ_STEPS} steps (this path has ${path.length})`);
    await runSteps({
      source, path, model, effort, onEvent, label: `${id} `,
      onStep: (rec) => { trace.artifacts[rec.id] = rec.artifact; trace.steps.push(rec); },
    });
    trace.steps.sort((x, y) => path.findIndex((s) => s.id === x.id) - path.findIndex((s) => s.id === y.id));
    const assembleStep = { id: 'assemble', op: 'assemble', index: path.length, params: {}, deps: [path[path.length - 1].id] };
    const asm = await executeOp({ op: assembler, source, path, step: assembleStep, artifacts: trace.artifacts, model, effort, onEvent, label: `${id} ` });
    trace.assemble = { usage: asm.usage, ms: asm.ms, problems: asm.problems, attempts: asm.attempts, instruction: asm.instruction, reasoningSummary: asm.reasoningSummary, notes: asm.notes };
    trace.item = format === 'short' ? finishShort(asm.artifact) : { format: 'mcq', ...letterOptions(asm.artifact, seed ?? hashSeed(id)) };
    trace.status = 'done';
  } catch (err) {
    trace.status = 'failed';
    trace.error = { message: err.message, name: err.name, at: new Date().toISOString() };
  }
  const recs = [...trace.steps, ...(trace.assemble ? [trace.assemble] : [])];
  trace.totals = { ...sumUsage(recs), ms: Date.now() - t0 };
  return trace;
}

export function sumUsage(recs) {
  const u = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, calls: 0 };
  for (const r of recs) {
    for (const a of r.attempts ?? [{ usage: r.usage }]) {
      // an attempt's own call, plus the model-backed checks run on it (verifyAsync)
      for (const x of [a?.usage, ...[a?.asyncCheck?.usage].flat()]) {
        if (!x) continue;
        u.input_tokens += x.input_tokens ?? 0; u.output_tokens += x.output_tokens ?? 0;
        u.cached_tokens += x.cached_tokens ?? 0; u.reasoning_tokens += x.reasoning_tokens ?? 0; u.calls++;
      }
    }
  }
  return u;
}

function hashSeed(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h || 1; }
