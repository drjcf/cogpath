/**
 * Executes a cognitive path over a source: one structured-output call per step, each step seeing the
 * source plus every earlier artifact, then the ASSEMBLE op builds the item.
 *
 * Every call shares the same prefix (framework preamble + source) so the Responses API prefix cache
 * covers the source after the first step.
 */
import { randomBytes } from 'node:crypto';
import { getOp, ASSEMBLE, schemaOf } from './ops/index.js';
import { validate } from './schema.js';
import { complete, part, DEFAULT_MODEL } from './meta.js';
import { letterOptions } from './ops/assemble.js';
import { formatPath } from './path.js';
import { wordCount } from './source.js';

export const PREAMBLE = `You are an assessment-design engine. You execute one cognitive operation at a time over a SOURCE, producing a structured artifact that later operations and the final item will depend on. Be precise, grounded in the source, and write every statement as a learner would state it from understanding rather than as a summary of a document. Never refer to "the article", "the study", "the source", "the passage", or "the text". Use the field's standard technical terminology for conditions, anatomy, procedures, and outcomes (e.g. "pulmonary fat embolism", not "lung blockage"); never substitute lay paraphrases for accepted terms.`;

export function newId(prefix = 'run') { return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`; }

export function artifactsBlock(artifacts, steps) {
  const entries = steps.filter((s) => artifacts[s.id] !== undefined).map((s) => `### ${s.id} (${s.op})\n${JSON.stringify(artifacts[s.id], null, 2)}`);
  return entries.length ? `ARTIFACTS FROM EARLIER STEPS:\n\n${entries.join('\n\n')}` : 'ARTIFACTS FROM EARLIER STEPS: none (this is the first step).';
}

function makeCtx({ source, path, step, artifacts }) {
  return { source, path, step, priorSteps: path.slice(0, step.index), artifacts };
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
  const rec = { id: step.id, op: op.id, params: step.params, effort: useEffort, instruction, attempts: [] };
  onEvent?.({ type: 'step:start', step: rec.id, op: op.id, effort: useEffort });

  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const parts = [...source.parts, part.text(artifactsBlock(artifacts, path)), part.text(instruction + feedback)];
    const res = await complete({
      instructions: PREAMBLE, parts, schema, schemaName: `${op.id}_output`, effort: useEffort, model,
      maxOutputTokens: op.maxOutputTokens, summary: 'auto', label: `${label ?? ''}${step.id}`, cacheKey: source.cacheKey, mock: () => op.mock(ctx),
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
    if (problems.length === 0 || res.mock) break;
    feedback = `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED FOR THESE REASONS; FIX ALL OF THEM:\n- ${problems.join('\n- ')}`;
    onEvent?.({ type: 'step:retry', step: rec.id, problems });
  }
  onEvent?.({ type: 'step:done', step: rec.id, op: op.id, problems: rec.problems, usage: rec.usage, ms: rec.ms });
  return rec;
}

/** Run steps [fromIndex..] of `path` given artifacts for the earlier ones. Returns { steps, artifacts }. */
export async function runSteps({ source, path, fromIndex = 0, artifacts = {}, model, effort, onEvent, label }) {
  const out = [];
  const acc = { ...artifacts };
  for (const step of path.slice(fromIndex)) {
    const rec = await executeOp({ op: getOp(step.op), source, path, step, artifacts: acc, model, effort, onEvent, label });
    acc[step.id] = rec.artifact;
    out.push(rec);
  }
  return { steps: out, artifacts: acc };
}

/** Full run: all steps + assemble. */
/**
 * Full run: all steps + assemble. Never throws away completed work: on failure the returned trace has
 * status 'failed', `error`, and every step that finished (the CLI saves it as a partial run).
 */
export async function runPath({ source, path, model = DEFAULT_MODEL, effort, onEvent, seed }) {
  const id = newId();
  const t0 = Date.now();
  const trace = {
    id, status: 'running', createdAt: new Date().toISOString(),
    source: { kind: source.kind, title: source.title, path: source.path, sha: source.sha ?? null, fileId: source.fileId, words: wordCount(source.text), mode: source.mode ?? 'raw', digestClaims: source.digest?.claims?.length ?? 0, digestReview: source.digestReview ?? null, focus: source.focus ?? null },
    model, pathText: formatPath(path), path, steps: [], artifacts: {}, assemble: null, item: null, totals: null, verification: null, error: null,
  };
  try {
    for (const step of path) {
      const rec = await executeOp({ op: getOp(step.op), source, path, step, artifacts: trace.artifacts, model, effort, onEvent, label: `${id} ` });
      trace.artifacts[step.id] = rec.artifact;
      trace.steps.push(rec);
    }
    const assembleStep = { id: 'assemble', op: 'assemble', index: path.length, params: {} };
    const asm = await executeOp({ op: ASSEMBLE, source, path, step: assembleStep, artifacts: trace.artifacts, model, effort, onEvent, label: `${id} ` });
    trace.assemble = { usage: asm.usage, ms: asm.ms, problems: asm.problems, attempts: asm.attempts, instruction: asm.instruction, reasoningSummary: asm.reasoningSummary, notes: asm.notes };
    trace.item = letterOptions(asm.artifact, seed ?? hashSeed(id));
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
      if (!a?.usage) continue;
      u.input_tokens += a.usage.input_tokens ?? 0; u.output_tokens += a.usage.output_tokens ?? 0;
      u.cached_tokens += a.usage.cached_tokens ?? 0; u.reasoning_tokens += a.usage.reasoning_tokens ?? 0; u.calls++;
    }
  }
  return u;
}

function hashSeed(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h || 1; }
