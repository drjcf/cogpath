/**
 * Op registry. An op is a module exporting:
 *   id, label, bloom, description, requires: [opId…], params: { name: { type, default, … } }, effort,
 *   schema | schemaFor(ctx), instruction(ctx) → string, verify(artifact, ctx) → string[], mock(ctx) → artifact
 *
 * ctx = { source, path, step, priorSteps, artifacts }  (see executor.js)
 * To add a cognitive operation, drop a module here and register it below.
 */
import recall from './recall.js';
import analyze from './analyze.js';
import evaluate from './evaluate.js';
import synthesize from './synthesize.js';
import assemble from './assemble.js';

export const OPS = { recall, analyze, evaluate, synthesize };
export const ASSEMBLE = assemble;

export function getOp(id) {
  const op = OPS[id];
  if (!op) throw new Error(`Unknown op '${id}'. Known: ${Object.keys(OPS).join(', ')}`);
  return op;
}

export function schemaOf(op, ctx) {
  return typeof op.schemaFor === 'function' ? op.schemaFor(ctx) : op.schema;
}

export function describeOps() {
  return Object.values(OPS).map((op) => ({
    id: op.id, label: op.label, bloom: op.bloom, description: op.description, requires: op.requires, effort: op.effort,
    params: Object.entries(op.params).map(([name, p]) => ({ name, ...p })),
  }));
}
