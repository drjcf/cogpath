/**
 * Cognitive-path DSL. A path is a DAG of typed steps; a chain of steps is the common case.
 *
 * Chain:      recall(3) > analyze(contrast, relations=2) > evaluate(efficacy, safety) > synthesize(management plan)
 * Branches:   r: recall(3) > a: analyze(causal); s: recall(2) > b: analyze(contrast); @a, @b > evaluate(efficacy) > synthesize(plan)
 *               - ';' separates chains; '>' links the steps of a chain; 'label:' names a step (the default name is the op,
 *                 then op2, op3 for repeats); '@x, @y >' at the start of a chain makes its first step depend on steps x and y.
 * JSON:       [{ op: 'recall', params: { concepts: 3 } }, { op: 'analyze', id: 'a', after: ['recall'] }, …]
 *               - 'after' lists the ids a step depends on (earlier entries only); left out, a step follows the previous entry.
 *
 * parsePath() returns normalized steps in a valid order: [{ id, op, index, params, deps }] with defaults applied, types
 * checked, op.requires satisfied by an ancestor, and exactly one terminal step (the item's key is its artifact).
 * A step sees the artifacts of its ancestors only. Paths stored before DAGs have no 'deps'; they read as chains.
 */
import { getOp, OPS } from './ops/index.js';
import { depsOf } from './graph.js';

export function parsePath(input) {
  const raw = typeof input === 'string' ? parseShorthand(input) : normalizeJson(input);
  if (raw.length === 0) throw new PathError('Path is empty');
  const steps = [];
  const byId = new Map();
  const ancestors = new Map(); // id → Set of ancestor ids
  const auto = {};
  for (const [index, r] of raw.entries()) {
    const op = getOp(r.op);
    let id = r.label;
    if (id) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new PathError(`Step ${index + 1}: '${id}' is not a valid step name`);
      if (OPS[id]) throw new PathError(`Step ${index + 1}: a step cannot be named '${id}', which is an op`);
    } else {
      auto[op.id] = (auto[op.id] ?? 0) + 1;
      id = auto[op.id] === 1 ? op.id : `${op.id}${auto[op.id]}`;
    }
    if (byId.has(id)) throw new PathError(`Duplicate step name '${id}'`);
    const after = r.after === null ? (index === 0 ? [] : [steps[index - 1].id]) : r.after;
    for (const d of after) if (!byId.has(d)) throw new PathError(`Step ${index + 1} '${id}' depends on '${d}', which is not an earlier step`);
    const deps = [...new Set(after)].sort((a, b) => byId.get(a).index - byId.get(b).index);
    const anc = new Set();
    for (const d of deps) { anc.add(d); for (const a of ancestors.get(d)) anc.add(a); }
    const params = resolveParams(op, r.args ?? [], r.params ?? {}, index);
    for (const need of op.requires) {
      if (![...anc].some((a) => byId.get(a).op === need)) throw new PathError(`Step ${index + 1} '${op.id}' requires an earlier '${need}' step`);
    }
    const step = { id, op: op.id, index, params, deps };
    steps.push(step); byId.set(id, step); ancestors.set(id, anc);
  }
  const sinks = steps.filter((s) => !steps.some((t) => t.deps.includes(s.id)));
  if (sinks.length > 1) throw new PathError(`Path has ${sinks.length} terminal steps (${sinks.map((s) => s.id).join(', ')}); join them in one final step, e.g. "${sinks.map((s) => '@' + s.id).join(', ')} > evaluate"`);
  return steps;
}

/** Serialize steps to the shorthand; parsePath(formatPath(steps)) returns the same steps. A chain prints as a chain. */
export function formatPath(steps) {
  const fmtStep = (s) => {
    const op = getOp(s.op);
    const parts = Object.entries(s.params).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(op.params[k]?.default))
      .map(([k, v]) => Array.isArray(v) ? `${k}=${v.join('|')}` : `${k}=${v}`);
    return parts.length ? `${s.op}(${parts.join(', ')})` : s.op;
  };
  // greedy chains: a step with a single dependency continues the chain that ends at it, otherwise it starts one
  const chains = [];
  const tail = new Map();
  for (const s of steps) {
    const deps = depsOf(steps, s);
    const open = deps.length === 1 ? tail.get(deps[0]) : null;
    if (open) { open.nodes.push(s); tail.delete(deps[0]); tail.set(s.id, open); }
    else { const c = { refs: deps, nodes: [s] }; chains.push(c); tail.set(s.id, c); }
  }
  const counts = {};
  return chains.map((c) => {
    const body = c.nodes.map((s) => {
      counts[s.op] = (counts[s.op] ?? 0) + 1;
      const autoId = counts[s.op] === 1 ? s.op : `${s.op}${counts[s.op]}`;
      if (s.id === autoId) return fmtStep(s);
      counts[s.op]--; // a named step does not use up an automatic name
      return `${s.id}: ${fmtStep(s)}`;
    }).join(' > ');
    return c.refs.length ? `${c.refs.map((r) => `@${r}`).join(', ')} > ${body}` : body;
  }).join('; ');
}

export class PathError extends Error { constructor(msg) { super(msg); this.name = 'PathError'; } }

// ─── graph helpers live in graph.js; re-exported here ───
export { depsOf, ancestorIds, descendantIds, isLinear, branchShare } from './graph.js';

/**
 * Items an op numbers (concepts c1…, relations r1…, options o1…) must not collide across steps of the same op:
 * a step's ids start after those of the earlier steps of its op.
 */
export function idBaseOf(steps, step) {
  const key = getOp(step.op).countParam;
  if (!key) return 0;
  return steps.filter((s) => s.op === step.op && s.index < step.index).reduce((n, s) => n + (Number(s.params[key]) || 0), 0);
}

// ─── shorthand ──────────────────────────────────────────────

/** Split on a separator that is not inside parentheses or quotes. */
function splitTop(text, sepRe) {
  const out = [];
  let cur = '', q = null, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const m = text.slice(i).match(sepRe);
      if (m && m.index === 0) { out.push(cur); cur = ''; i += m[0].length - 1; continue; }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseShorthand(text) {
  const raw = [];
  for (const chain of splitTop(String(text), /^;/)) {
    const segments = splitTop(chain, /^(?:->|→|>)/);
    let refs = null;
    if (segments.length && /^@/.test(segments[0])) {
      const list = segments.shift().split(',').map((x) => x.trim());
      if (!list.every((x) => /^@[A-Za-z_][A-Za-z0-9_]*$/.test(x))) throw new PathError(`Cannot parse the dependency list "${list.join(', ')}"; write @name, @name > step`);
      refs = list.map((x) => x.slice(1));
      if (!segments.length) throw new PathError(`"${list.join(', ')}" must be followed by a step`);
    }
    segments.forEach((seg, i) => {
      const m = seg.match(/^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\((.*)\))?$/s);
      if (!m) throw new PathError(`Cannot parse step ${raw.length + 1}: "${seg}"`);
      const [, label, op, argText] = m;
      const args = [];
      const params = {};
      if (argText && argText.trim()) {
        for (const a of splitArgs(argText)) {
          const kv = a.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/s);
          if (kv) params[kv[1]] = kv[2].trim();
          else args.push(a.trim());
        }
      }
      // the first step of a chain depends on the chain's references (none: a root); the others on the step before
      raw.push({ op: op.toLowerCase(), label: label ?? null, args, params, after: i === 0 ? (refs ?? []) : null });
    });
  }
  return raw;
}

function splitArgs(s) {
  // split on commas not inside quotes; strip surrounding quotes
  const out = [];
  let cur = '', q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

function normalizeJson(input) {
  const arr = Array.isArray(input) ? input : input?.path;
  if (!Array.isArray(arr)) throw new PathError('JSON path must be an array of steps or { path: [...] }');
  return arr.map((s, i) => {
    if (typeof s === 'string') return { op: s.toLowerCase(), label: null, args: [], params: {}, after: null };
    if (!s || typeof s.op !== 'string') throw new PathError(`Step ${i + 1} must have an "op"`);
    if (s.after !== undefined && !Array.isArray(s.after)) throw new PathError(`Step ${i + 1}: "after" must be an array of step ids`);
    return { op: s.op.toLowerCase(), label: s.id ?? null, args: [], params: { ...(s.params ?? {}) }, after: s.after ?? null };
  });
}

// ─── params ─────────────────────────────────────────────────

function resolveParams(op, positional, named, index) {
  const out = {};
  const defs = op.params;
  const posName = Object.entries(defs).find(([, d]) => d.positional)?.[0];
  if (positional.length) {
    if (!posName) throw new PathError(`Step ${index + 1} '${op.id}' takes no positional arguments`);
    const def = defs[posName];
    if (def.type === 'list') named[posName] = positional;
    else if (positional.length === 1) named[posName] = positional[0];
    else throw new PathError(`Step ${index + 1} '${op.id}': only one positional argument allowed (${posName})`);
  }
  for (const k of Object.keys(named)) if (!defs[k]) throw new PathError(`Step ${index + 1} '${op.id}': unknown param '${k}' (allowed: ${Object.keys(defs).join(', ') || 'none'})`);
  for (const [name, def] of Object.entries(defs)) {
    const v = named[name];
    if (v === undefined) { out[name] = structuredClone(def.default); continue; }
    out[name] = coerce(def, v, `Step ${index + 1} '${op.id}' param '${name}'`);
  }
  return out;
}

function coerce(def, v, where) {
  switch (def.type) {
    case 'integer': {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new PathError(`${where} must be an integer`);
      if (def.min != null && n < def.min) throw new PathError(`${where} must be ≥ ${def.min}`);
      if (def.max != null && n > def.max) throw new PathError(`${where} must be ≤ ${def.max}`);
      return n;
    }
    case 'enum': {
      const s = String(v).toLowerCase();
      if (!def.values.includes(s)) throw new PathError(`${where} must be one of ${def.values.join(', ')}`);
      return s;
    }
    case 'list': {
      const list = Array.isArray(v) ? v.map(String) : String(v).split(/[|,]/).map((x) => x.trim()).filter(Boolean);
      if (!list.length) throw new PathError(`${where} must be a non-empty list`);
      return list;
    }
    default: {
      const s = String(v).trim();
      if (!s) throw new PathError(`${where} must be non-empty`);
      return s;
    }
  }
}

export function listOpIds() { return Object.keys(OPS); }
