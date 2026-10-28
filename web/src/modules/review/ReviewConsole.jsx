/**
 * Review console: claims on the left, the source on the right with the focused claim's span highlighted.
 * One piece of state links the panes: `focused` (a claim id). Click a card or move with the keyboard.
 *   J certify · F reject · E edit · S / ↓ next · ↑ previous · Esc cancel
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession, canWrite } from '../../lib/auth.js';
import Identity from '../../components/Identity.jsx';
import PdfSpanViewer from '../../components/PdfSpanViewer.jsx';
import TextSpanViewer from '../../components/TextSpanViewer.jsx';

const STATUS_ORDER = { pending: 0, certified: 1, rejected: 2 };

function Badge({ kind, children, title }) { return <span className={`badge badge-${kind}`} title={title}>{children}</span>; }

function ClaimCard({ c, focused, onFocus, onDecide, vocab, busy, mode, setMode }) {
  const ref = useRef(null);
  const [draft, setDraft] = useState({ statement: c.statement, type: c.type, attribution: c.attribution, reason: '' });
  useEffect(() => { if (focused && ref.current) ref.current.scrollIntoView({ block: 'nearest' }); }, [focused]);
  useEffect(() => { setDraft({ statement: c.statement, type: c.type, attribution: c.attribution, reason: '' }); }, [c.statement, c.type, c.attribution, mode]);
  const st = c.decision?.status ?? 'pending';
  return (
    <div ref={ref} className={`claim ${focused ? 'focused' : ''} st-${st}`} onClick={() => onFocus(c.id)} data-claim={c.id}>
      <div className="claim-head">
        <span className="claim-id">{c.id}</span>
        <Badge kind="type">{c.type}</Badge>
        <Badge kind="attr" title="this_work: the source's own finding · cited_work: reported from another study">{c.attribution}</Badge>
        <Badge kind="sec">{c.section}{c.page != null ? ` · p.${c.page}` : ''}</Badge>
        {st !== 'pending' && <Badge kind={st}>{st}{c.decision?.edited ? ' (edited)' : ''}</Badge>}
      </div>
      <div className="claim-statement">{c.statement}</div>
      <div className="span" onClick={(e) => { e.stopPropagation(); onFocus(c.id); }} title="locate in the source">
        <label>Source span · click to locate</label>
        <blockquote>{c.span}</blockquote>
      </div>
      {c.decision?.reason ? <div className="claim-reason">Reason: {c.decision.reason}</div> : null}
      {focused && mode === 'edit' && (
        <div className="editor" onClick={(e) => e.stopPropagation()}>
          <textarea value={draft.statement} onChange={(e) => setDraft({ ...draft, statement: e.target.value })} rows={3} autoFocus />
          <div className="row">
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>{vocab.types.map((t) => <option key={t}>{t}</option>)}</select>
            <select value={draft.attribution} onChange={(e) => setDraft({ ...draft, attribution: e.target.value })}>{vocab.attributions.map((t) => <option key={t}>{t}</option>)}</select>
            <input placeholder="reason (optional)" value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
          </div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => onDecide(c.id, { action: 'edit', newStatement: draft.statement, newType: draft.type, newAttribution: draft.attribution, reason: draft.reason })}>Save and certify (Ctrl+Enter)</button>
            <button onClick={() => setMode('')}>Cancel (Esc)</button>
          </div>
        </div>
      )}
      {focused && mode === 'reject' && (
        <div className="editor" onClick={(e) => e.stopPropagation()}>
          <input autoFocus placeholder="why is this claim wrong? (Enter to reject, Esc to cancel)" value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') onDecide(c.id, { action: 'reject', reason: draft.reason }); if (e.key === 'Escape') setMode(''); }} />
        </div>
      )}
      {focused && !mode && (
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <button className="danger" disabled={busy} onClick={() => setMode('reject')}>Reject (F)</button>
          <button disabled={busy} onClick={() => setMode('edit')}>Edit (E)</button>
          <button className="primary" disabled={busy} onClick={() => onDecide(c.id, { action: 'certify' })}>Certify (J)</button>
        </div>
      )}
    </div>
  );
}

export default function ReviewConsole({ sha, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState(null);
  const [mode, setMode] = useState('');
  const [busy, setBusy] = useState(false);
  const session = useSession();
  const writer = canWrite(session);
  const [text, setText] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    try {
      const d = await api.source(sha);
      setData(d);
      setError('');
      setFocused((f) => f ?? d.claims.find((c) => c.decision.status === 'pending')?.id ?? d.claims[0]?.id ?? null);
      if (!d.hasPdf && text === null) setText((await api.text(sha)).text);
    } catch (e) { setError(e.message); }
  }, [sha, text]);
  useEffect(() => { load(); }, [load]);

  const ordered = useMemo(() => {
    if (!data) return [];
    const list = filter === 'all' ? data.claims : data.claims.filter((c) => c.decision.status === filter);
    return [...list].sort((a, b) => (STATUS_ORDER[a.decision.status] - STATUS_ORDER[b.decision.status]) || (Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, ''))));
  }, [data, filter]);
  const current = useMemo(() => data?.claims.find((c) => c.id === focused) ?? null, [data, focused]);

  const move = useCallback((delta) => {
    if (!ordered.length) return;
    const i = Math.max(0, ordered.findIndex((c) => c.id === focused));
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, i + delta))];
    if (next) { setFocused(next.id); setMode(''); }
  }, [ordered, focused]);

  const decide = useCallback(async (id, body) => {
    if (!writer) { setError(session.mode === 'none' ? 'Enter a reviewer name (top right) before deciding.' : 'Sign in with an allowlisted account to decide.'); return; }
    setBusy(true);
    try {
      const out = await api.decide(sha, id, body);
      setData((d) => ({ ...d, status: out.status, counts: out.counts, claims: d.claims.map((c) => (c.id === id ? { ...c, ...out.claim, decision: out.decision } : c)) }));
      setMode('');
      // advance to the next pending claim after this one
      const i = ordered.findIndex((c) => c.id === id);
      const nextPending = ordered.slice(i + 1).find((c) => c.decision.status === 'pending' && c.id !== id) ?? ordered.slice(0, i).find((c) => c.decision.status === 'pending');
      if (nextPending) setFocused(nextPending.id);
      setError('');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, [sha, writer, session.mode, ordered]);

  const approve = useCallback(async () => {
    if (!writer) { setError('Sign in with an allowlisted account to approve.'); return; }
    const note = window.prompt('Approval note (optional):', '') ?? null;
    if (note === null) return;
    setBusy(true);
    try { await api.approve(sha, { note }); await load(); setError(''); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, [sha, writer, load]);

  const unapprove = useCallback(async () => {
    setBusy(true);
    try { await api.unapprove(sha, {}); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }, [sha, load]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') { setMode(''); return; }
      if (typing) {
        if (mode === 'edit' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { document.querySelector('.editor button.primary')?.click(); }
        return;
      }
      if (!current) return;
      const k = e.key.toLowerCase();
      if (k === 'j') { e.preventDefault(); decide(current.id, { action: 'certify' }); }
      else if (k === 'f') { e.preventDefault(); setMode('reject'); }
      else if (k === 'e') { e.preventDefault(); setMode('edit'); }
      else if (k === 's' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, decide, move, mode]);

  if (error && !data) return <div className="page"><p className="error">{error}</p><button onClick={onBack}>Back</button></div>;
  if (!data) return <div className="page">Loading…</div>;
  const { counts } = data;
  const canApprove = counts.pending === 0 && data.status !== 'approved';
  return (
    <div className="certifypage">
      <header className="topbar">
        <button className="link" onClick={onBack}>← Sources</button>
        <div className="title"><strong>{data.title}</strong> <span className="muted">{data.short} · {data.kind} · {data.words} words{data.mock ? ' · MOCK' : ''}</span></div>
        <div className="counts">
          <Badge kind="pending">{counts.pending} pending</Badge>
          <Badge kind="certified">{counts.certified} certified</Badge>
          <Badge kind="rejected">{counts.rejected} rejected</Badge>
          {data.audit ? <Badge kind="sec" title={data.audit.flagged.map((f) => `${f.id} [${f.issue}] ${f.note}`).join('\n')}>audit removed {data.audit.removed.length}</Badge> : null}
          <Badge kind={data.status === 'approved' ? 'certified' : data.status === 'modified' ? 'rejected' : 'pending'}>{data.status}</Badge>
        </div>
        <div className="reviewer">
          <Identity />
          {data.status === 'approved'
            ? <button onClick={unapprove} disabled={busy || !writer}>Unapprove</button>
            : <button className="primary" onClick={approve} disabled={!canApprove || busy || !writer} title={!writer ? 'sign in to approve' : canApprove ? 'Approve this digest for item generation' : `${counts.pending} claim(s) still pending`}>Approve digest</button>}
        </div>
      </header>
      {error ? <div className="error bar">{error}</div> : null}
      {data.status === 'approved' && data.review?.at ? <div className="info bar">Approved by {data.review.by || 'unknown'} on {new Date(data.review.at).toLocaleString()}{data.review.note ? ` · ${data.review.note}` : ''}. Decisions on an approved digest demote it to "modified" until approved again.</div> : null}
      <div className="body">
        <section className="claims">
          <div className="toolbar">
            <span className="muted">Keys: J certify · F reject · E edit · S/↓ next · ↑ prev</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">all</option><option value="pending">pending</option><option value="certified">certified</option><option value="rejected">rejected</option>
            </select>
          </div>
          {ordered.map((c) => (
            <ClaimCard key={c.id} c={c} focused={c.id === focused} onFocus={(id) => { setFocused(id); setMode(''); }} onDecide={decide} vocab={data.vocab} busy={busy} mode={c.id === focused ? mode : ''} setMode={setMode} />
          ))}
          {!ordered.length ? <p className="muted">No claims in this filter.</p> : null}
        </section>
        <section className="source">
          <div className="source-head muted">{current ? <>Highlighting <strong>{current.id}</strong>{current.page != null ? ` (page ${current.page})` : ''}</> : 'Select a claim'}</div>
          {data.hasPdf
            ? <PdfSpanViewer sha={sha} highlight={current?.span ?? ''} page={current?.page ?? null} />
            : <TextSpanViewer text={text ?? ''} highlight={current?.span ?? ''} />}
        </section>
      </div>
    </div>
  );
}
