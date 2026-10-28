/**
 * The path grammar in the browser: enough to draw a glyph from a DSL string and to write one from the composer's
 * state. The server validates against the real registry (POST /api/paths/check) before anything runs.
 */
export const STEP_ORDER = ['recall', 'analyze', 'evaluate', 'synthesize'];
export const STEP_LABEL = { recall: 'Recall', analyze: 'Analyze', evaluate: 'Evaluate', synthesize: 'Synthesize' };
export const STEP_VERB = { recall: 'retrieves the facts the question will rest on, each tied to a verbatim span', analyze: 'connects the facts into relations, with the misreading each invites', evaluate: 'weighs competing strategies against explicit criteria and names the decisive factor', synthesize: 'adapts the judgment to a case the article did not cover; the result becomes the key' };

/** Split a DSL string into steps: [{ op, params: { positional: [...], named: {...} } }]. Tolerant: unknown text is kept. */
export function parsePathText(text) {
  return String(text ?? '').split(/\s*(?:>|->|→)\s*/).map((s) => s.trim()).filter(Boolean).map((seg) => {
    const m = seg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\((.*)\))?$/s);
    if (!m) return { op: seg, positional: [], named: {}, invalid: true };
    const [, op, argText] = m;
    const positional = []; const named = {};
    if (argText && argText.trim()) {
      for (const a of splitArgs(argText)) {
        const kv = a.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/s);
        if (kv) named[kv[1]] = kv[2].trim(); else positional.push(a.trim());
      }
    }
    return { op: op.toLowerCase(), positional, named };
  });
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
