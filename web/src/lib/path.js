/**
 * The path grammar in the browser: enough to draw a glyph from a DSL string and to write one from the composer's
 * state. The server validates against the real registry (POST /api/paths/check) before anything runs.
 */
export const STEP_ORDER = ['recall', 'analyze', 'evaluate', 'synthesize'];
export const STEP_LABEL = { recall: 'Recall', analyze: 'Analyze', evaluate: 'Evaluate', synthesize: 'Synthesize' };
export const STEP_VERB = { recall: 'retrieves the facts the question will rest on, each tied to a verbatim span', analyze: 'connects the facts into relations, with the misreading each invites', evaluate: 'weighs competing strategies against explicit criteria and names the decisive factor', synthesize: 'adapts the judgment to a case the article did not cover; the result becomes the key' };

/** Split on a separator outside parentheses and quotes (mirrors core/path.js). */
function splitTop(text, seps) {
  const out = []; let cur = ''; let q = null; let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const sep = seps.find((x) => text.startsWith(x, i));
      if (sep) { out.push(cur); cur = ''; i += sep.length - 1; continue; }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Split a DSL string into steps:
 *   [{ op, id, label, positional, named, deps, chain, first }]
 * `id` is the label, or the op (then op2, op3 for repeats among unlabeled steps), as core/path.js names them.
 * `deps` are the ids the step reads from: the references at the head of its chain, the step before it in the chain,
 * or none for the first step of a chain with no references. Tolerant: unknown text is kept as an invalid step.
 */
export function parsePathText(text) {
  const steps = []; const counts = {};
  splitTop(String(text ?? ''), [';']).forEach((chainText, chain) => {
    const segs = splitTop(chainText, ['->', '→', '>']);
    let refs = [];
    if (segs.length > 1 && segs[0].startsWith('@')) refs = segs.shift().split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
    segs.forEach((seg, i) => {
      const m = seg.match(/^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\((.*)\))?$/s);
      const prev = steps[steps.length - 1];
      if (!m) { steps.push({ op: seg, id: seg, label: null, positional: [], named: {}, deps: i === 0 ? refs : (prev ? [prev.id] : []), chain, first: i === 0, invalid: true }); return; }
      const [, label, rawOp, argText] = m;
      const op = rawOp.toLowerCase();
      const positional = []; const named = {};
      if (argText && argText.trim()) {
        for (const a of splitArgs(argText)) {
          const kv = a.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/s);
          if (kv) named[kv[1]] = kv[2].trim(); else positional.push(a.trim());
        }
      }
      let id = label;
      if (!id) { counts[op] = (counts[op] ?? 0) + 1; id = counts[op] === 1 ? op : `${op}${counts[op]}`; }
      steps.push({ op, id, label: label ?? null, positional, named, deps: i === 0 ? refs : (prev ? [prev.id] : []), chain, first: i === 0 });
    });
  });
  return steps;
}

/** True when the text cannot be edited with the four fixed controls: branches, labels, repeated or reordered steps. */
export function isBranched(text) {
  const steps = parsePathText(text);
  if (!steps.length) return false;
  if (steps.some((s) => s.chain !== 0 || s.label || s.invalid)) return true;
  return steps.map((s) => s.op).join('>') !== STEP_ORDER.join('>');
}

/** The op of a step id: looked up in a path (a string, parsed steps, or recorded steps), else read off an automatic id (analyze2 → analyze). */
export function opOfStep(id, path = null) {
  const steps = typeof path === 'string' ? parsePathText(path) : (path ?? []);
  const hit = steps.find((s) => s.id === id);
  if (hit) return hit.op;
  const m = String(id ?? '').match(/^(recall|analyze|evaluate|synthesize)\d*$/);
  return m ? m[1] : null;
}

/** A readable name for a step id: "Analyze" for the op's own name, "Analyze (a)" for a label, "Analyze 2" for a repeat. */
export function stepTitle(id, path = null) {
  const op = opOfStep(id, path);
  if (!op) return id;
  const base = STEP_LABEL[op];
  if (id === op) return base;
  const rep = String(id).match(/^(?:recall|analyze|evaluate|synthesize)(\d+)$/);
  return rep ? `${base} ${rep[1]}` : `${base} (${id})`;
}

function splitArgs(text) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** The short label a glyph shows beside a step name: the positional argument(s), or the named ones. */
export function stepArgLabel(step) {
  const parts = [...(step.positional ?? [])];
  const named = { ...(step.named ?? {}) };
  // The main parameter of each step reads as a plain value; the rest keep their names.
  const main = { recall: 'concepts', analyze: 'kind', evaluate: 'criteria', synthesize: 'form' }[step.op];
  if (main && named[main] !== undefined) { parts.unshift(main === 'criteria' ? String(named[main]).split('|').join(', ') : String(named[main])); delete named[main]; }
  for (const [k, v] of Object.entries(named)) parts.push(`${k} ${v}`);
  return parts.join(', ');
}

/** Composer state → DSL. state: { recall: { concepts }, analyze: { kind, relations }, evaluate: { criteria: [] , options }, synthesize: { form } } */
export function composeText(st) {
  const r = `recall(${st.recall.concepts})`;
  const a = `analyze(${st.analyze.kind}${st.analyze.relations && st.analyze.relations !== 2 ? `, relations=${st.analyze.relations}` : ''})`;
  const crit = (st.evaluate.criteria ?? []).map((c) => c.trim()).filter(Boolean);
  const e = `evaluate(${crit.join(', ')}${st.evaluate.options && st.evaluate.options !== 3 ? `, options=${st.evaluate.options}` : ''})`;
  const s = `synthesize(${st.synthesize.form.trim()})`;
  return `${r} > ${a} > ${e} > ${s}`;
}

/** DSL → composer state (best effort; unknown pieces fall back to defaults). */
export function stateFromText(text, defaults) {
  const st = JSON.parse(JSON.stringify(defaults));
  for (const step of parsePathText(text)) {
    if (step.op === 'recall') { const n = Number(step.positional[0] ?? step.named.concepts); if (Number.isInteger(n)) st.recall.concepts = n; }
    if (step.op === 'analyze') { if (step.positional[0]) st.analyze.kind = step.positional[0]; if (step.named.kind) st.analyze.kind = step.named.kind; const rel = Number(step.named.relations); if (Number.isInteger(rel)) st.analyze.relations = rel; }
    if (step.op === 'evaluate') { const crit = step.named.criteria ? step.named.criteria.split('|') : step.positional; if (crit.length) st.evaluate.criteria = crit.map((c) => c.trim()); const o = Number(step.named.options); if (Number.isInteger(o)) st.evaluate.options = o; }
    if (step.op === 'synthesize') { const form = step.named.form ?? step.positional.join(', '); if (form) st.synthesize.form = form; }
  }
  return st;
}

export const DEFAULT_STATE = { recall: { concepts: 4 }, analyze: { kind: 'causal', relations: 2 }, evaluate: { criteria: ['efficacy', 'safety'], options: 3 }, synthesize: { form: 'management plan' } };
