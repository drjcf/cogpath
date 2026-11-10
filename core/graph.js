/**
 * Graph helpers over normalized path steps ({ id, op, index, params, deps }). Pure: no op registry, so ops can import it.
 * Steps stored before DAGs have no 'deps' and read as a chain.
 */

/** Direct dependencies of a step: its deps, or for steps stored before DAGs the step before it. */
export function depsOf(steps, step) {
  if (Array.isArray(step.deps)) return step.deps;
  const i = steps.findIndex((s) => s.id === step.id);
  return i > 0 ? [steps[i - 1].id] : [];
}

/** Ids of every step this one depends on, directly or not. 'assemble' (not in the path) depends on all of it. */
export function ancestorIds(steps, id) {
  if (!steps.some((s) => s.id === id)) return steps.map((s) => s.id);
  const out = new Set();
  const visit = (sid) => { for (const d of depsOf(steps, steps.find((s) => s.id === sid))) if (!out.has(d)) { out.add(d); visit(d); } };
  visit(id);
  return [...out];
}

/** Ids of every step that depends on this one, directly or not. */
export function descendantIds(steps, id) {
  return steps.filter((s) => s.id !== id && ancestorIds(steps, s.id).includes(id)).map((s) => s.id);
}

export const isLinear = (steps) => steps.every((s, i) => { const d = depsOf(steps, s); return i === 0 ? d.length === 0 : d.length === 1 && d[0] === steps[i - 1].id; });

/** When several recall steps share one item, each is held to its own share of the reserved claims (round robin). */
export function branchShare(steps, step, list) {
  const same = steps.filter((s) => s.op === step.op);
  if (same.length < 2) return list;
  const j = same.findIndex((s) => s.id === step.id);
  return list.filter((_, i) => i % same.length === j);
}
