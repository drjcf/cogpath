import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import PathGlyph, { StepDot } from '../../components/PathGlyph.jsx';
import { STEP_LABEL } from '../../lib/path.js';

/** Certified items across every build, with export. Rejected and pending items can be listed too. */
export default function ItemsBank({ onOpenBuild }) {
  const [status, setStatus] = useState('certified');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { setData(null); api.items(status).then(setData).catch((e) => setError(e.message)); }, [status]);
  return (
    <div className="page wide">
      <h1>Items</h1>
      <p className="lede">Items a reviewer has certified, from every build. Each carries its article, its path, the step every wrong option fails at, and the verifier's findings, so an item bank receives provenance with the text.</p>
      <div className="field-row">
        <label className="field">Show <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="certified">certified</option><option value="pending">awaiting review</option><option value="rejected">rejected</option><option value="all">all</option></select></label>
        <a className="button" href={`/api/items?status=${status}&download=1`}>Export {status === 'all' ? 'all' : status} items as JSON</a>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {!data ? <p>Loading…</p> : !data.items.length ? <p className="empty">{status === 'certified' ? 'No certified items yet. Open a build and certify the items that hold up.' : 'Nothing here.'}</p> : (
        <ol className="bank">
          {data.items.map((it) => (
            <li key={it.id} className="bankitem">
              <div className="bankhead">
                <PathGlyph path={it.path} />
                <span className="muted small">{it.source.title}</span>
                <button type="button" className="link" onClick={() => onOpenBuild(it.build)}>open build</button>
              </div>
              <p className="stem exam">{it.stem}</p>
              <p className="leadin exam">{it.leadIn}</p>
              <ol className="options compact">
                {it.options.map((o) => <li key={o.letter} className={o.key ? 'key' : ''}><span className="letter">{o.letter}</span><span className="exam">{o.text}</span>{o.key ? <span className="keytag">key</span> : o.failsAt ? <StepDot step={o.failsAt}>fails at {STEP_LABEL[o.failsAt] ?? o.failsAt}</StepDot> : null}</li>)}
              </ol>
              <p className="muted small">{it.decision.status === 'certified' ? `Certified by ${it.decision.by}` : it.decision.status === 'rejected' ? `Rejected by ${it.decision.by}${it.decision.reason ? `: ${it.decision.reason}` : ''}` : 'Awaiting review'}{it.verification ? `. Verifier: ${it.verification.passed} of ${it.verification.applicable} checks${it.verification.necessity != null ? `, needs steps 1–${it.verification.necessity}` : ''}.` : ''}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
