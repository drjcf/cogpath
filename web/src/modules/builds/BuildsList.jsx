import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import PathGlyph from '../../components/PathGlyph.jsx';

const LIVE = new Set(['queued', 'launched', 'running']);
const Rate = ({ v, title }) => <span className={`rate ${rateClass(v)}`} title={title}>{v ?? 'n/a'}</span>;
export function rateClass(v) {
  if (!v || v === 'n/a') return 'na';
  const [a, b] = String(v).split('/').map(Number);
  if (!b) return '';
  return a === b ? 'good' : a === 0 ? 'bad' : 'mid';
}

export default function BuildsList({ onOpen }) {
  const [builds, setBuilds] = useState(null);
  const [error, setError] = useState('');
  const load = () => api.builds().then((d) => { setBuilds(d.builds); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const live = Boolean(builds?.some((b) => LIVE.has(b.status)));
  useEffect(() => { if (!live) return undefined; const t = setInterval(load, 4000); return () => clearInterval(t); }, [live]);
  if (error && !builds) return <div className="page"><p className="error">{error}</p></div>;
  if (!builds) return <div className="page">Loading…</div>;
  return (
    <div className="page wide">
      <h1>Builds</h1>
      <p className="lede">A build is a set of items compiled from one approved article, each with a single-shot control on the same focus. The first two columns are the comparison that matters: a path item's key should not be something the article already states, and it should need every step of its path.</p>
      {!builds.length ? <p className="empty">No builds yet. Open <a href="#/sources">Sources</a>, approve an article's claims, and launch one.</p> : null}
      <table className="builds">
        <thead><tr><th>article</th><th>paths</th><th title="path items whose key the article does not already state">key not stated</th><th title="path items whose key is reachable only with the full path">needs full path</th><th title="path items passing every applicable check">all checks</th><th title="single-shot controls whose key the article does not already state">controls not stated</th><th>review</th><th>cost</th></tr></thead>
        <tbody>
          {builds.map((b) => (
            <tr key={b.id} className={LIVE.has(b.status) ? 'live' : ''}>
              <td><a className="rowlink cell-title" href={`#/builds/${b.id}`} onClick={(e) => { e.preventDefault(); onOpen(b.id); }}>{b.source?.title}</a><div className="muted small">{b.n} items{b.baselines ? ` with controls` : ''}, {b.createdAt ? new Date(b.createdAt).toLocaleDateString() : ''}{b.by ? `, ${b.by}` : ''}</div></td>
              <td className="cell-paths">{b.pathMode === 'composed' && b.paths?.length ? b.paths.map((p, i) => <PathGlyph key={i} path={p} />) : b.items?.length ? <><PathGlyph path={b.items[0].path} /><span className="muted small">{b.items.length > 1 ? `and ${b.items.length - 1} more, planner-designed` : 'planner-designed'}</span></> : <span className="muted small">planner-designed</span>}</td>
              {LIVE.has(b.status) ? <td colSpan={4}><span className="tag warn">{b.status}…</span> <span className="muted">{b.progress?.phase === 'plan' || b.progress?.phase === 'queued' ? (b.progress.phase === 'plan' ? 'planning' : 'waiting for a worker') : `${b.progress?.itemsDone ?? 0} of ${b.progress?.of ?? b.n} items${b.progress?.item ? `, ${b.progress.item}` : ''}${b.progress?.step ? ` (${b.progress.step})` : ''}`}</span></td>
                : b.status === 'failed' && !b.rates ? <td colSpan={4}><span className="tag bad">failed</span> <span className="error small">{b.error?.message ?? ''}</span></td> : (
                <>
                  <td><Rate v={b.rates?.digestRecall} /></td>
                  <td><Rate v={b.rates?.necessity} /></td>
                  <td><Rate v={b.rates?.allChecks} /></td>
                  <td><Rate v={b.rates?.baselineDigestRecall} /></td>
                </>
              )}
              <td className="small nowrap">{b.review ? <>{b.review.certified} certified{b.review.rejected ? <><br />{b.review.rejected} rejected</> : null}{b.review.pending ? <><br />{b.review.pending} to review</> : null}</> : <span className="muted">{LIVE.has(b.status) ? '' : 'not reviewed'}</span>}</td>
              <td className="muted small nowrap">{b.totals ? <>{(b.totals.input_tokens / 1000).toFixed(0)}k in<br />{(b.totals.output_tokens / 1000).toFixed(0)}k out<br />{Math.round(b.totals.ms / 60000)} min</> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
