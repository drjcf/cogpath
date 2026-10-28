import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { composeText, stateFromText, DEFAULT_STATE, STEP_VERB } from '../lib/path.js';
import PathGlyph from './PathGlyph.jsx';

/** The registry (ops, parameters, presets) once per page. */
export function useRegistry() {
  const [reg, setReg] = useState(null);
  useEffect(() => { api.ops().then(setReg).catch(() => setReg({ ops: [], presets: [] })); }, []);
  return reg;
}

function Chips({ values, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const commit = () => { const v = draft.trim(); if (v) onChange([...values, v]); setDraft(''); };
  return (
    <span className="chips">
      {values.map((v, i) => <span key={`${v}-${i}`} className="chip">{v}<button type="button" aria-label={`remove ${v}`} onClick={() => onChange(values.filter((_, j) => j !== i))}>×</button></span>)}
      <input value={draft} placeholder={values.length ? 'add' : placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1)); }} onBlur={commit} />
    </span>
  );
}

/** One path: four step editors, the glyph, and the grammar text they produce. */
function OnePath({ text, onChange, registry, showHelp, index, onRemove, canRemove }) {
  const [asText, setAsText] = useState(false);
  const [raw, setRaw] = useState(text);
  const st = useMemo(() => stateFromText(text, DEFAULT_STATE), [text]);
  const kinds = registry?.ops?.find((o) => o.id === 'analyze')?.params?.find((p) => p.name === 'kind')?.values ?? ['contrast', 'causal', 'mechanism', 'comparison'];
  const set = (patch) => onChange(composeText({ ...st, ...patch }));
  useEffect(() => { setRaw(text); }, [text]);
  return (
    <div className="composer-path">
      <div className="composer-head">
        <span className="composer-n">Path {index + 1}</span>
        <select aria-label="preset" value="" onChange={(e) => { if (e.target.value) onChange(e.target.value); }}>
          <option value="">Start from a preset</option>
          {(registry?.presets ?? []).map((p) => <option key={p.id} value={p.path}>{p.name}</option>)}
        </select>
        <button type="button" className="link" onClick={() => setAsText((v) => !v)}>{asText ? 'Edit with controls' : 'Edit as text'}</button>
        {canRemove ? <button type="button" className="link quiet" onClick={onRemove}>Remove</button> : null}
      </div>
      {asText ? (
        <input className="mono wide" value={raw} onChange={(e) => setRaw(e.target.value)} onBlur={() => onChange(raw)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onChange(raw); } }} />
      ) : (
        <div className="composer-steps">
          <div className="composer-step step-recall">
            <div className="composer-step-name">Recall</div>
            <label>facts <input type="number" min="2" max="8" value={st.recall.concepts} onChange={(e) => set({ recall: { concepts: Number(e.target.value) || 4 } })} /></label>
            {showHelp ? <p>{STEP_VERB.recall}</p> : null}
          </div>
          <div className="composer-step step-analyze">
            <div className="composer-step-name">Analyze</div>
            <label>kind <select value={st.analyze.kind} onChange={(e) => set({ analyze: { ...st.analyze, kind: e.target.value } })}>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
            <label>relations <input type="number" min="1" max="4" value={st.analyze.relations} onChange={(e) => set({ analyze: { ...st.analyze, relations: Number(e.target.value) || 2 } })} /></label>
            {showHelp ? <p>{STEP_VERB.analyze}</p> : null}
          </div>
          <div className="composer-step step-evaluate">
            <div className="composer-step-name">Evaluate</div>
            <label className="block">criteria, in priority order <Chips values={st.evaluate.criteria} placeholder="efficacy, safety" onChange={(criteria) => set({ evaluate: { ...st.evaluate, criteria } })} /></label>
            <label>strategies weighed <input type="number" min="2" max="5" value={st.evaluate.options} onChange={(e) => set({ evaluate: { ...st.evaluate, options: Number(e.target.value) || 3 } })} /></label>
            {showHelp ? <p>{STEP_VERB.evaluate}</p> : null}
          </div>
          <div className="composer-step step-synthesize">
            <div className="composer-step-name">Synthesize</div>
            <label className="block">what the key is <input value={st.synthesize.form} placeholder="management plan" onChange={(e) => set({ synthesize: { form: e.target.value } })} /></label>
            {showHelp ? <p>{STEP_VERB.synthesize}</p> : null}
          </div>
        </div>
      )}
      <div className="composer-out">
        <PathGlyph path={text} size="large" />
        <code className="dsl">{text}</code>
      </div>
    </div>
  );
}

/**
 * Compose one or more paths. `value` is an array of DSL strings (empty array = let the planner design one per item).
 * The build form decides what to do with them; the home page uses it as the explainer.
 */
export default function PathComposer({ value, onChange, registry, showHelp = false, itemCount = null }) {
  const paths = value.length ? value : [registry?.presets?.[0]?.path ?? composeText(DEFAULT_STATE)];
  const setAt = (i, t) => { const next = [...paths]; next[i] = t; onChange(next); };
  return (
    <div className="composer">
      {paths.map((t, i) => <OnePath key={i} index={i} text={t} registry={registry} showHelp={showHelp && i === 0} onChange={(nt) => setAt(i, nt)} onRemove={() => onChange(paths.filter((_, j) => j !== i))} canRemove={paths.length > 1} />)}
      <div className="composer-foot">
        <button type="button" onClick={() => onChange([...paths, registry?.presets?.[(paths.length) % Math.max(1, registry?.presets?.length ?? 1)]?.path ?? composeText(DEFAULT_STATE)])}>Add another path</button>
        {paths.length > 1 && itemCount ? <span className="muted">Items take the paths in turn: {Array.from({ length: Math.min(itemCount, 6) }, (_, i) => `item ${i + 1} on path ${(i % paths.length) + 1}`).join(', ')}{itemCount > 6 ? ', and so on' : ''}.</span> : null}
      </div>
    </div>
  );
}
