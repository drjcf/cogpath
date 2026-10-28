import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession, canWrite } from '../../lib/auth.js';
import BuildForm from '../builds/BuildForm.jsx';

const WORKING = new Set(['queued', 'ingesting']);
const badgeKind = (status) => (status === 'approved' ? 'certified' : status === 'draft' || status === 'uploaded' || WORKING.has(status) ? 'pending' : 'rejected');

function Upload({ onDone }) {
  const [file, setFile] = useState(null);
  const [claims, setClaims] = useState('auto');
  const [audit, setAudit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const input = useRef(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setMsg('');
    try {
      const out = await api.upload(file, { claims: claims === 'auto' ? 'auto' : Number(claims), audit });
      setMsg(out.existed ? `${file.name} is already here (${out.status}). Open it below, or read it again from its row.` : `${file.name} uploaded. Reading it now; the row updates as it goes.`);
      setFile(null); if (input.current) input.current.value = '';
      onDone();
    } catch (err) { setMsg(err.message); }
    finally { setBusy(false); }
  };
  return (
    <form className="upload" onSubmit={submit}>
      <input ref={input} type="file" accept=".pdf,.md,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <label className="field">Claims to extract <select value={claims} onChange={(e) => setClaims(e.target.value)}><option value="auto">about one per 150 words</option>{[12, 20, 30, 40, 50, 60, 80].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      <label className="field check"><input type="checkbox" checked={audit} onChange={(e) => setAudit(e.target.checked)} /> Audit by a second reader</label>
      <button className="primary" type="submit" disabled={!file || busy}>{busy ? 'Uploading…' : 'Upload and read'}</button>
      {msg ? <span className="muted">{msg}</span> : null}
    </form>
  );
}

export default function SourcesList({ onOpen, onBuild }) {
  const s = useSession();
  const [sources, setSources] = useState(null);
  const [error, setError] = useState('');
  const [building, setBuilding] = useState(null);
  const load = useCallback(() => api.sources().then((d) => { setSources(d.sources); setError(''); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const working = Boolean(sources?.some((x) => WORKING.has(x.status)));
  useEffect(() => { if (!working) return undefined; const t = setInterval(load, 3000); return () => clearInterval(t); }, [working, load]);
  const reingest = async (src) => {
    if (!window.confirm(`Read ${src.title} again? The current claims, decisions and approval are replaced by a new draft.`)) return;
    try { await api.ingest(src.sha, {}); await load(); } catch (e) { setError(e.message); }
  };
  if (error && !sources) return <div className="page"><p className="error">{error}</p></div>;
  if (!sources) return <div className="page">Loading…</div>;
  const writer = canWrite(s);
  return (
    <div className="page wide">
      <h1>Sources</h1>
      <p className="lede">An article is read once into claims, each tied to a verbatim span. A second reader audits them, then a person reviews and approves the set. Items are built only on approved claims.</p>
      {writer ? <Upload onDone={load} /> : <p className="empty">{s.mode === 'none' ? 'Enter a reviewer name at the top right to upload an article.' : 'Sign in with an allowlisted account to upload, review and build. Everything here is readable without signing in.'}</p>}
      {error ? <p className="error">{error}</p> : null}
      {building ? <BuildForm source={building} onLaunched={(id) => { setBuilding(null); onBuild(id); }} onCancel={() => setBuilding(null)} /> : null}
      {!sources.length ? <p className="empty">No articles yet. Upload a PDF to begin.</p> : null}
      <table className="sources">
        <thead><tr><th>status</th><th>title</th><th>claims</th><th>words</th><th>ingested</th><th></th></tr></thead>
        <tbody>
          {sources.map((x) => (
            <tr key={x.sha} className={`st-${x.status}`}>
              <td><span className={`tag ${badgeKind(x.status) === 'certified' ? 'ok' : badgeKind(x.status) === 'pending' ? 'warn' : 'bad'}`}>{x.status === 'draft' ? 'to review' : x.status}{WORKING.has(x.status) ? '…' : ''}</span>{x.status === 'failed' && x.error ? <div className="error small" title={x.error}>{x.error.slice(0, 80)}</div> : null}</td>
              <td><div className="cell-title">{x.title}{x.mock ? ' (mock)' : ''}</div><div className="muted small">{x.fileName ?? x.kind}, {x.short}</div></td>
              <td>{x.claims ?? ''}</td>
              <td>{x.words ?? ''}</td>
              <td>{x.ingestedAt ? new Date(x.ingestedAt).toLocaleString() : x.uploadedAt ? <span className="muted">uploaded {new Date(x.uploadedAt).toLocaleString()}</span> : ''}</td>
              <td className="actions">
                {['draft', 'approved', 'modified'].includes(x.status) ? <button className="primary" onClick={() => onOpen(x.sha)}>Review</button> : null}
                {writer && ['draft', 'approved', 'modified'].includes(x.status) ? <button onClick={() => setBuilding(x)} title={x.status === 'approved' ? 'build items on these claims' : 'not approved: the form offers a draft build'}>New build</button> : null}
                {writer && !WORKING.has(x.status) ? <button className="link quiet" onClick={() => reingest(x)}>{x.status === 'failed' || x.status === 'uploaded' ? 'Read' : 'Read again'}</button> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
