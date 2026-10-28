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
      setMsg(out.existed ? `${file.name} was already ingested (${out.status}); open it below, or re-ingest from its row.` : `${file.name} uploaded; ingesting (${out.jobId}).`);
      setFile(null); if (input.current) input.current.value = '';
      onDone();
    } catch (err) { setMsg(err.message); }
    finally { setBusy(false); }
  };
  return (
    <form className="upload" onSubmit={submit}>
      <input ref={input} type="file" accept=".pdf,.md,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <label>claims <select value={claims} onChange={(e) => setClaims(e.target.value)}><option value="auto">auto (one per 150 words)</option>{[12, 20, 30, 40, 50, 60, 80].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      <label><input type="checkbox" checked={audit} onChange={(e) => setAudit(e.target.checked)} /> audit</label>
      <button className="primary" type="submit" disabled={!file || busy}>{busy ? 'Uploading…' : 'Upload and ingest'}</button>
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
    if (!window.confirm(`Re-ingest ${src.title}? The current digest, decisions and approval are replaced by a new draft.`)) return;
    try { await api.ingest(src.sha, {}); await load(); } catch (e) { setError(e.message); }
  };
  if (error && !sources) return <div className="page"><p className="error">{error}</p></div>;
  if (!sources) return <div className="page">Loading…</div>;
  const writer = canWrite(s);
  return (
    <div className="page wide">
      <h1>Sources</h1>
      <p className="muted">An article is ingested once into a digest of verbatim claims, audited, then reviewed and approved by a person. Items are built only on approved digests.</p>
      {writer ? <Upload onDone={load} /> : <p className="muted">{s.mode === 'none' ? 'Enter a reviewer name (top right) to upload.' : 'Sign in with an allowlisted account to upload, review and build.'}</p>}
      {error ? <p className="error">{error}</p> : null}
      {building ? <BuildForm source={building} onLaunched={(id) => { setBuilding(null); onBuild(id); }} onCancel={() => setBuilding(null)} /> : null}
      {!sources.length ? <p>No sources yet.</p> : null}
      <table className="sources">
        <thead><tr><th>status</th><th>title</th><th>claims</th><th>words</th><th>ingested</th><th></th></tr></thead>
        <tbody>
          {sources.map((x) => (
            <tr key={x.sha} className={`st-${x.status}`}>
              <td><span className={`badge badge-${badgeKind(x.status)}`}>{x.status}{WORKING.has(x.status) ? '…' : ''}</span>{x.status === 'failed' && x.error ? <div className="error small" title={x.error}>{x.error.slice(0, 80)}</div> : null}</td>
              <td>{x.title}{x.mock ? ' (mock)' : ''}<div className="muted">{x.short} · {x.kind}{x.fileName ? ` · ${x.fileName}` : ''}</div></td>
              <td>{x.claims ?? ''}</td>
              <td>{x.words ?? ''}</td>
              <td>{x.ingestedAt ? new Date(x.ingestedAt).toLocaleString() : x.uploadedAt ? <span className="muted">uploaded {new Date(x.uploadedAt).toLocaleString()}</span> : ''}</td>
              <td className="actions">
                {['draft', 'approved', 'modified'].includes(x.status) ? <button className="primary" onClick={() => onOpen(x.sha)}>Review</button> : null}
                {writer && ['draft', 'approved', 'modified'].includes(x.status) ? <button onClick={() => setBuilding(x)} title={x.status === 'approved' ? 'build items on this digest' : 'not approved: the form offers a draft build'}>New build</button> : null}
                {writer && !WORKING.has(x.status) ? <button className="link" onClick={() => reingest(x)}>{x.status === 'failed' || x.status === 'uploaded' ? 'Ingest' : 'Re-ingest'}</button> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
