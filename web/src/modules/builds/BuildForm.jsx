import { useState } from 'react';
import { api } from '../../lib/api.js';
import PathComposer, { useRegistry } from '../../components/PathComposer.jsx';

/**
 * Launch a build on an ingested source. The designer chooses how many items, whether the planner designs a path
 * for each item or the items run composed paths, and the verification depth. Posts to /api/builds; the worker does the rest.
 */
export default function BuildForm({ source, onLaunched, onCancel }) {
  const registry = useRegistry();
  const [items, setItems] = useState(5);
  const [mode, setMode] = useState('planner');
  const [paths, setPaths] = useState([]);
  const [deep, setDeep] = useState(true);
  const [baseline, setBaseline] = useState(true);
  const [seed, setSeed] = useState('');
  const [allowDraft, setAllowDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const approved = source.status === 'approved';
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (mode === 'composed') {
        const chk = await api.checkPaths(paths.length ? paths : [registry?.presets?.[0]?.path].filter(Boolean));
        const bad = chk.paths.find((p) => !p.ok);
        if (bad) { setError(`Path "${bad.path}": ${bad.error}`); setBusy(false); return; }
      }
      const out = await api.createBuild({ sha: source.sha, items: Number(items), deep, baseline, seed: seed === '' ? null : Number(seed), paths: mode === 'composed' ? (paths.length ? paths : [registry?.presets?.[0]?.path].filter(Boolean)) : null, allowDraft: !approved && allowDraft });
      onLaunched(out.id);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return (
    <form className="buildform" onSubmit={submit}>
      <h2>New build on {source.title}</h2>
      <p className="muted">{source.claims} approved claims. Each item gets a focus and a reserved set of claims; its path is either designed by the planner or composed here.</p>
      <div className="field-row">
        <label className="field">Items <input type="number" min="1" max="20" value={items} onChange={(e) => setItems(e.target.value)} /></label>
        <label className="field check"><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> Deep verification <span className="muted">(corrupt each step and re-run)</span></label>
        <label className="field check"><input type="checkbox" checked={baseline} onChange={(e) => setBaseline(e.target.checked)} /> Single-shot controls <span className="muted">(one call per focus, for comparison)</span></label>
        <label className="field">Seed <input type="number" value={seed} placeholder="auto" onChange={(e) => setSeed(e.target.value)} /></label>
      </div>
      <div className="mode">
        <label className={`mode-opt ${mode === 'planner' ? 'on' : ''}`}><input type="radio" name="mode" checked={mode === 'planner'} onChange={() => setMode('planner')} /><span><strong>Planner designs a path per item</strong><span className="muted">It varies the analysis kind, the evaluation criteria and the form of the plan to fit each focus.</span></span></label>
        <label className={`mode-opt ${mode === 'composed' ? 'on' : ''}`}><input type="radio" name="mode" checked={mode === 'composed'} onChange={() => setMode('composed')} /><span><strong>Items run paths I compose</strong><span className="muted">The planner still chooses each item's focus and claims; the reasoning shape is yours.</span></span></label>
      </div>
      {mode === 'composed' ? <PathComposer value={paths} onChange={setPaths} registry={registry} itemCount={Number(items) || 0} /> : null}
      {!approved ? <label className="field check warn"><input type="checkbox" checked={allowDraft} onChange={(e) => setAllowDraft(e.target.checked)} /> Build on this {source.status} digest anyway; the record will say so.</label> : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="field-row">
        <button className="primary" type="submit" disabled={busy || (!approved && !allowDraft)}>{busy ? 'Launching…' : 'Launch build'}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <span className="muted">About five minutes per item with controls and deep verification. You can follow it live.</span>
      </div>
    </form>
  );
}
