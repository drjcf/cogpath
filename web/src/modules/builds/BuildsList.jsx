import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

const Rate = ({ v }) => <span className={`rate ${rateClass(v)}`}>{v ?? 'n/a'}</span>;
function rateClass(v) {
  if (!v || v === 'n/a') return '';
  const [a, b] = String(v).split('/').map(Number);
  if (!b) return '';
  return a === b ? 'good' : a === 0 ? 'bad' : 'mid';
}

const LIVE = new Set(['queued', 'launched', 'running']);

export default function BuildsList({ onOpen }) {
  const [builds, setBuilds] = useState(null);
  const [error, setError] = useState('');
  const load = () => api.builds().then((d) => { setBuilds(d.builds); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const live = Boolean(builds?.some((b) => LIVE.has(b.status)));
  useEffect(() => { if (!live) return undefined; const t = setInterval(load, 4000); return () => clearInterval(t); }, [live]);
  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!builds) return <div className="page">Loading…</div>;
  return (
    <div className="page wide">
      <h1>Builds</h1>
      <p className="muted">Each build: N path-compiled items from one approved digest, with a single-shot control item on each focus. <strong>digestRecall</strong> is the check both arms share (is the key something the source states?); <strong>necessity</strong> and <strong>key blocked</strong> exist only for path items, which have step artifacts.</p>
      {!builds.length ? <p>No builds yet. Open <a href="#/sources">Sources</a> and launch one on an approved digest.</p> : null}
      <table className="builds">
        <thead><tr><th>build</th><th>source</th><th>items</th><th>path: necessity</th><th>path: digestRecall</th><th>path: all checks</th><th>single-shot: digestRecall</th><th>tokens in / out</th><th></th></tr></thead>
        <tbody>
          {builds.map((b) => (
            <tr key={b.id}>
              <td><div>{b.id.replace(/^build-/, '')}</div><div className="muted">{b.createdAt ? new Date(b.createdAt).toLocaleString() : ''} · {b.model}{b.status !== 'done' ? ` · ${b.status}` : ''}{b.by ? ` · ${b.by}` : ''}</div></td>
              <td>{b.source?.title}<div className="muted">{b.source?.claims} claims · {b.source?.mode ?? 'digest'}</div></td>
              <td>{b.n}{b.baselines ? ` + ${b.baselines} controls` : ''}</td>
              {LIVE.has(b.status) ? <td colSpan={4}><span className="badge badge-pending">{b.status}…</span> <span className="muted">{b.progress?.phase === 'plan' || b.progress?.phase === 'queued' ? (b.progress.phase === 'plan' ? 'planning' : 'waiting for a worker') : `${b.progress?.itemsDone ?? 0}/${b.progress?.of ?? b.n} items${b.progress?.item ? ` · ${b.progress.item}` : ''}${b.progress?.step ? ` · ${b.progress.step}` : ''}`}</span></td> : b.status === 'failed' && !b.rates ? <td colSpan={4}><span className="badge badge-rejected">failed</span> <span className="error small">{b.error?.message ?? ''}</span></td> : (
                <>
                  <td><Rate v={b.rates?.necessity} /></td>
                  <td><Rate v={b.rates?.digestRecall} /></td>
                  <td><Rate v={b.rates?.allChecks} /></td>
                  <td><Rate v={b.rates?.baselineDigestRecall} /></td>
                </>
              )}
              <td className="muted">{b.totals ? `${(b.totals.input_tokens / 1000).toFixed(0)}k / ${(b.totals.output_tokens / 1000).toFixed(0)}k` : ''}</td>
              <td><button className="primary" onClick={() => onOpen(b.id)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
