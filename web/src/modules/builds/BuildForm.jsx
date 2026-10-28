import { useState } from 'react';
import { api } from '../../lib/api.js';

/** Launch a build on an ingested source. Posts to /api/builds; the worker does the rest. */
export default function BuildForm({ source, onLaunched, onCancel }) {
  const [items, setItems] = useState(5);
  const [deep, setDeep] = useState(true);
  const [baseline, setBaseline] = useState(true);
  const [seed, setSeed] = useState('');
  const [pathHint, setPathHint] = useState('');
  const [allowDraft, setAllowDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const approved = source.status === 'approved';
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const out = await api.createBuild({ sha: source.sha, items: Number(items), deep, baseline, seed: seed === '' ? null : Number(seed), path: pathHint.trim() || null, allowDraft: !approved && allowDraft });
      onLaunched(out.id);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return (
    <form className="buildform" onSubmit={submit}>
      <div className="row"><strong>New build</strong> <span className="muted">on {source.title} ({source.claims} claims, {source.status})</span></div>
      <div className="row">
        <label>items <input type="number" min="1" max="20" value={items} onChange={(e) => setItems(e.target.value)} /></label>
        <label><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> deep (distractor mapping)</label>
        <label><input type="checkbox" checked={baseline} onChange={(e) => setBaseline(e.target.checked)} /> single-shot controls</label>
        <label>seed <input type="number" value={seed} placeholder="auto" onChange={(e) => setSeed(e.target.value)} /></label>
      </div>
      <div className="row">
        <label className="grow">path (optional, pins every item) <input value={pathHint} placeholder="recall(4) > analyze(causal) > evaluate(safety, feasibility) > synthesize(operative plan)" onChange={(e) => setPathHint(e.target.value)} /></label>
      </div>
      {!approved ? <div className="row"><label><input type="checkbox" checked={allowDraft} onChange={(e) => setAllowDraft(e.target.checked)} /> build on this <strong>{source.status}</strong> digest anyway (the record will say so)</label></div> : null}
      {error ? <div className="error">{error}</div> : null}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || (!approved && !allowDraft)}>{busy ? 'Launching…' : 'Launch build'}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <span className="muted">about 5 minutes per item with controls and deep verification</span>
      </div>
    </form>
  );
}
