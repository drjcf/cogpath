/**
 * Cognitive-path DSL.
 *
 * Shorthand:  recall(3) > analyze(contrast, relations=2) > evaluate(efficacy, safety) > synthesize(management plan)
 * JSON:       [{ op: 'recall', params: { concepts: 3 } }, { op: 'analyze', params: { kind: 'contrast' } }, …]
 *
 * parsePath() returns normalized steps: [{ id, op, index, params }] with defaults applied, types checked,
 * dependencies (op.requires) satisfied by an earlier step, and unique ids for repeated ops (analyze, analyze2).
 */
import { getOp, OPS } from './ops/index.js';

export function parsePath(input) {
  const raw = typeof input === 'string' ? parseShorthand(input) : normalizeJson(input);
  if (raw.length === 0) throw new PathError('Path is empty');
  const steps = [];
  const counts = {};
  for (const [index, r] of raw.entries()) {
    const op = getOp(r.op);
    counts[op.id] = (counts[op.id] ?? 0) + 1;
    const id = counts[op.id] === 1 ? op.id : `${op.id}${counts[op.id]}`;
    const params = resolveParams(op, r.args ?? [], r.params ?? {}, index);
    for (const dep of op.requires) {
      if (!steps.some((s) => s.op === dep)) throw new PathError(`Step ${index + 1} '${op.id}' requires an earlier '${dep}' step`);
    }
    steps.push({ id, op: op.id, index, params });
  }
  return steps;
}

export function formatPath(steps) {
  return steps.map((s) => {
    const op = getOp(s.op);
    const parts = Object.entries(s.params).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(op.params[k]?.default))
      .map(([k, v]) => Array.isArray(v) ? `${k}=${v.join('|')}` : `${k}=${v}`);
    return parts.length ? `${s.op}(${parts.join(', ')})` : s.op;
  }).join(' > ');
}

export class PathError extends Error { constructor(msg) { super(msg); this.name = 'PathError'; } }

// ─── shorthand ──────────────────────────────────────────────

function parseShorthand(text) {
  const segments = String(text).split(/\s*(?:>|->|→)\s*/).map((s) => s.trim()).filter(Boolean);
  return segments.map((seg, i) => {
    const m = seg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\((.*)\))?$/s);
    if (!m) throw new PathError(`Cannot parse step ${i + 1}: "${seg}"`);
    const [, op, argText] = m;
    const args = [];
    const params = {};
    if (argText && argText.trim()) {
      for (const a of splitArgs(argText)) {
        const kv = a.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/s);
        if (kv) params[kv[1]] = kv[2].trim();
        else args.push(a.trim());
      }
    }
    return { op: op.toLowerCase(), args, params };
  });
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
    if (typeof s === 'string') return { op: s.toLowerCase(), args: [], params: {} };
    if (!s || typeof s.op !== 'string') throw new PathError(`Step ${i + 1} must have an "op"`);
    return { op: s.op.toLowerCase(), args: [], params: { ...(s.params ?? {}) } };
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
