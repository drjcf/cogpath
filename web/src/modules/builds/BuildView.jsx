/**
 * One build: the arm-to-arm rates, the plan, and each path item beside its single-shot control with the
 * verification evidence (necessity picks and their quotes, digest and source recall, distractor mapping,
 * cover-the-options), the step trace, and the claim coverage map.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';

const Check = ({ ok }) => (ok === null || ok === undefined ? <span className="chk na">n/a</span> : ok ? <span className="chk ok">✓</span> : <span className="chk bad">✗</span>);
const Badge = ({ kind, children, title }) => <span className={`badge badge-${kind}`} title={title}>{children}</span>;

function Options({ item }) {
  return (
    <ol className="options">
      {item.options.map((o) => (
        <li key={o.id} className={o.isKey ? 'key' : ''}>
          <span className="letter">{o.id}.</span> {o.text}
          {o.isKey ? <Badge kind="certified">key</Badge> : o.failsAt && o.failsAt !== 'unknown' ? <Badge kind="type" title={o.failureRationale ?? ''}>fails at {o.failsAt}</Badge> : null}
        </li>
      ))}
    </ol>
  );
}

function Evidence({ entailment, optionId }) {
  const e = (entailment ?? []).find((x) => x.optionId === optionId);
  if (!e) return null;
  return (
    <ul className="evidence">
      {(e.evidence ?? []).map((ev, i) => <li key={i}><span className="clause">{ev.clause}</span> <span className="muted">←</span> <code>{ev.noteId}</code> <q>{ev.quote}</q></li>)}
      {!e.fullyEntailed && e.missingClause ? <li className="muted">missing: {e.missingClause}</li> : null}
    </ul>
  );
}

function Necessity({ pn }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="necessity">
      <div className="picks">
        {pn.picks.map((p) => (
          <button key={p.k} className={`pick ${p.choice === pn.key ? 'hit' : ''} ${open === p.k ? 'open' : ''}`} onClick={() => setOpen(open === p.k ? null : p.k)} title={p.override ? `raw ${p.raw}, overridden: ${p.override}` : p.reason}>
            k{p.k}: {p.choice}{p.override ? '*' : ''}
          </button>
        ))}
        <span className={`verdict ${pn.pass ? 'ok' : 'bad'}`}>{pn.verdict}</span>
      </div>
      {open !== null && (() => { const p = pn.picks.find((x) => x.k === open); return (
        <div className="pickdetail">
          <div className="muted">notes: {p.steps.length ? p.steps.join(', ') : 'none (stem and options only)'} · raw pick {p.raw}{p.override ? ` · overridden: ${p.override}` : ''}{p.lean ? ` · leans ${p.lean}` : ''}{p.citationsFixed?.length ? ` · ${p.citationsFixed.length} quote(s) cited as ${[...new Set(p.citationsFixed.map((c) => c.cited))].join('/')} found in ${[...new Set(p.citationsFixed.map((c) => c.found))].join('/')}` : ''}</div>
          {p.reason ? <div className="reason">{p.reason}</div> : null}
          <Evidence entailment={p.entailment} optionId={p.raw !== 'UNDETERMINED' ? p.raw : (p.lean ?? pn.key)} />
        </div>
      ); })()}
    </div>
  );
}

function RecallCheck({ label, r, keyId }) {
  const [open, setOpen] = useState(false);
  if (!r || r.skipped) return <div className="row"><Check ok={null} /> <strong>{label}</strong> <span className="muted">{r?.reason ?? 'skipped'}</span></div>;
  return (
    <div className="row">
      <Check ok={r.pass} /> <strong>{label}</strong> <span>{r.verdict}</span>
      <button className="link" onClick={() => setOpen(!open)}>{open ? 'hide' : 'evidence'}</button>
      {open ? <Evidence entailment={r.entailment} optionId={r.choice !== 'UNDETERMINED' ? r.choice : (r.lean ?? keyId)} /> : null}
    </div>
  );
}

function Mapping({ dm }) {
  if (!dm) return <div className="row"><Check ok={null} /> <strong>distractorMapping</strong> <span className="muted">not run (use --deep)</span></div>;
  return (
    <div className="row">
      <Check ok={dm.pass} /> <strong>distractorMapping</strong> <span>key blocked {dm.keyBlocked}/{dm.total}, landed {dm.landed}/{dm.total}</span>
      <ul className="mapping">
        {dm.perStep.map((p) => <li key={p.step}><code>{p.step}</code> corrupted → picked <strong>{p.picked}</strong>{p.picked === 'UNDETERMINED' && p.lean ? ` (leans ${p.lean})` : ''} · expected {p.expected.join('/')} · key {p.keyBlocked ? 'blocked' : 'reached'}{p.override ? <span className="muted"> · {p.override}</span> : null}</li>)}
      </ul>
    </div>
  );
}

function Trace({ trace }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="trace">
      {trace.steps.map((s) => (
        <div key={s.id} className="step">
          <button className="link" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? '▾' : '▸'} {s.id} <span className="muted">({s.op}, effort {s.effort}, {s.attempts.length} attempt{s.attempts.length > 1 ? 's' : ''}, {s.usage?.input_tokens ?? 0} in / {s.usage?.output_tokens ?? 0} out)</span></button>
          {s.attempts.some((a) => a.problems?.length) ? <ul className="problems">{s.attempts.flatMap((a) => a.problems.map((p, i) => <li key={`${a.attempt}-${i}`}>attempt {a.attempt}: {p}</li>))}</ul> : null}
          {open === s.id ? <pre className="artifact">{JSON.stringify(s.artifact, null, 2)}</pre> : null}
        </div>
      ))}
      {trace.assemble ? (
        <div className="step">
          <button className="link" onClick={() => setOpen(open === 'assemble' ? null : 'assemble')}>{open === 'assemble' ? '▾' : '▸'} assemble <span className="muted">({trace.assemble.attempts?.length ?? 1} attempt{(trace.assemble.attempts?.length ?? 1) > 1 ? 's' : ''}, {trace.assemble.usage?.input_tokens ?? 0} in / {trace.assemble.usage?.output_tokens ?? 0} out)</span></button>
          {trace.assemble.attempts?.some((a) => a.problems?.length) ? <ul className="problems">{trace.assemble.attempts.flatMap((a) => a.problems.map((p, i) => <li key={`${a.attempt}-${i}`}>attempt {a.attempt}: {p}</li>))}</ul> : null}
          {open === 'assemble' ? <pre className="artifact">{JSON.stringify({ explanation: trace.item.explanation, constraintSpan: trace.item.constraintSpan }, null, 2)}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function ItemCard({ rec, baseline }) {
  const [tab, setTab] = useState('item');
  const t = rec.trace, v = rec.verification, item = t?.item;
  const cc = t ? t.path.map((s) => t.artifacts[s.id]?.caseConstraint).filter(Boolean).pop() : null;
  const bv = baseline?.verification, bitem = baseline?.trace?.item;
  return (
    <section className="itemcard">
      <header>
        <div>
          <strong>{rec.plan.id}</strong> <code className="path">{rec.plan.path}</code>
          <div className="muted">focus: {rec.plan.focus}</div>
          <div className="muted">reserved claims: {rec.plan.claims.join(', ')}</div>
        </div>
        <div className="verdicts">
          {v ? <Badge kind={v.summary.pass ? 'certified' : 'rejected'}>{v.summary.passed}/{v.summary.applicable} checks</Badge> : <Badge kind="rejected">{rec.status}</Badge>}
          {v ? <Badge kind={v.pathNecessity.pass ? 'certified' : 'pending'} title={v.pathNecessity.verdict}>necessity {v.pathNecessity.pass ? 'k' + v.pathNecessity.pathLength : v.pathNecessity.determinedAt == null ? 'none' : 'k' + v.pathNecessity.determinedAt + '/' + v.pathNecessity.pathLength}</Badge> : null}
          {v?.digestRecall && !v.digestRecall.skipped ? <Badge kind={v.digestRecall.pass ? 'certified' : 'rejected'}>digestRecall {v.digestRecall.pass ? 'pass' : 'FAIL'}</Badge> : null}
          {v?.distractorMapping ? <Badge kind={v.distractorMapping.pass ? 'certified' : 'pending'}>key blocked {v.distractorMapping.keyBlocked}/{v.distractorMapping.total}</Badge> : null}
        </div>
      </header>
      <nav className="tabs">
        {['item', 'verification', 'trace', ...(baseline ? ['single-shot'] : [])].map((k) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{k}</button>)}
      </nav>
      {!item ? <p className="error">{rec.error?.message ?? 'item not built'}</p> : null}
      {item && tab === 'item' && (
        <div className="tabbody">
          {cc ? <div className="constraint"><label>case constraint</label> {cc.feature} <span className="muted">({cc.whyGenericInsufficient}; from {cc.derivedFrom.join(', ')})</span></div> : null}
          <p className="stem">{item.stem}</p>
          <p className="leadin">{item.leadIn}</p>
          <Options item={item} />
          <details><summary>explanation by step and distractor rationale</summary>
            <ul>{item.explanation?.map((e) => <li key={e.step}><code>{e.step}</code> {e.reasoning}</li>)}</ul>
            <ul>{item.options.filter((o) => !o.isKey).map((o) => <li key={o.id}><strong>{o.id}</strong> ({o.failsAt}): {o.failureRationale}</li>)}</ul>
          </details>
        </div>
      )}
      {item && v && tab === 'verification' && (
        <div className="tabbody checks">
          <div className="row"><Check ok={v.grounding.skipped ? null : v.grounding.pass} /> <strong>grounding</strong> <span>{v.grounding.skipped ? v.grounding.reason : `${v.grounding.found}/${v.grounding.checked} spans found in the source text`}</span></div>
          <div className="row"><Check ok={v.coverTheOptions.pass} /> <strong>coverTheOptions</strong> <span>free answer mapped to {v.coverTheOptions.mappedTo} ({v.coverTheOptions.match}); key {v.coverTheOptions.key}</span> <details><summary>free answer</summary><p>{v.coverTheOptions.freeAnswer}</p></details></div>
          <RecallCheck label="digestRecall" r={v.digestRecall} keyId={item.key} />
          <RecallCheck label="sourceRecall" r={v.sourceRecall} keyId={item.key} />
          <div className="row"><Check ok={v.pathNecessity.pass} /> <strong>pathNecessity</strong> <span className="muted">click a k to see what the picker cited</span><Necessity pn={v.pathNecessity} /></div>
          <Mapping dm={v.distractorMapping} />
        </div>
      )}
      {t && tab === 'trace' && <div className="tabbody"><Trace trace={t} /></div>}
      {baseline && tab === 'single-shot' && (
        <div className="tabbody">
          {!bitem ? <p className="error">{baseline.error?.message ?? 'not built'}</p> : (
            <>
              <p className="muted">One call, same focus and digest, told to require recall, analysis, evaluation, and synthesis. No path, no artifacts.</p>
              <p className="stem">{bitem.stem}</p>
              <p className="leadin">{bitem.leadIn}</p>
              <Options item={bitem} />
              {bv ? (
                <div className="checks">
                  <div className="row"><Check ok={bv.grounding.skipped ? null : bv.grounding.pass} /> <strong>grounding</strong> <span>{bv.grounding.skipped ? bv.grounding.reason : `${bv.grounding.found}/${bv.grounding.checked} evidence quotes found`}</span></div>
                  <div className="row"><Check ok={bv.coverTheOptions.pass} /> <strong>coverTheOptions</strong> <span>mapped to {bv.coverTheOptions.mappedTo} ({bv.coverTheOptions.match})</span></div>
                  <RecallCheck label="digestRecall" r={bv.digestRecall} keyId={bitem.key} />
                  <RecallCheck label="sourceRecall" r={bv.sourceRecall} keyId={bitem.key} />
                  <div className="row"><Check ok={bv.form.pass} /> <strong>form</strong> <span>{bv.form.problems.join('; ') || 'ok'}</span></div>
                  <div className="row"><Check ok={null} /> <strong>pathNecessity, distractorMapping</strong> <span className="muted">not measurable: no step artifacts</span></div>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </section>
  );
}

const EVENT_LINE = {
  'plan:start': () => 'planning items',
  'plan:done': (e) => `plan: ${e.plans.length} items · ${e.usage?.input_tokens ?? 0} in / ${e.usage?.output_tokens ?? 0} out`,
  'item:start': (e) => `${e.item} · ${e.path}`,
  'step:start': (e) => `  → ${e.step} (${e.op}, effort ${e.effort})`,
  'step:retry': (e) => `    retry: ${(e.problems ?? []).join('; ')}`,
  'step:done': (e) => `    ✓ ${e.step} ${e.ms} ms · ${e.usage?.input_tokens ?? 0} in / ${e.usage?.output_tokens ?? 0} out${e.problems?.length ? ` · problems: ${e.problems.join('; ')}` : ''}`,
  'verify:sourceRecall': (e) => `    sourceRecall: ${e.skipped ? 'n/a' : e.choice}${e.lean && e.choice === 'UNDETERMINED' ? ` (leans ${e.lean})` : ''}`,
  'verify:digestRecall': (e) => `    digestRecall: ${e.skipped ? 'n/a' : e.choice}${e.lean && e.choice === 'UNDETERMINED' ? ` (leans ${e.lean})` : ''}`,
  'verify:necessity': (e) => `    necessity k${e.k}: ${e.choice}${e.override ? ` (overridden: ${e.override})` : ''}`,
  'verify:mapping': (e) => `    mapping ${e.step}: ${e.picked} · key ${e.keyBlocked ? 'blocked' : 'reached'}${e.landed ? ' · landed' : ''}`,
  'item:done': (e) => `  ${e.item} ${e.status}${e.pass ? ` · checks ${e.pass}` : ''}${e.necessity != null ? ` · necessity k${e.necessity}` : ''}${e.digestRecall != null ? ` · digestRecall ${e.digestRecall ? 'pass' : 'FAIL'}` : ''}`,
  'baseline:start': (e) => `  single-shot control for ${e.item}`,
  'baseline:done': (e) => `  control ${e.item} ${e.status}${e.pass ? ` · checks ${e.pass}` : ''}${e.error ? ` · ${e.error}` : ''}`,
};

/** A build that has a summary and no record yet: status, progress and the worker's event log, polled while it runs. */
function PendingBuild({ b, events, onBack }) {
  const p = b.progress ?? {};
  const live = ['queued', 'launched', 'running'].includes(b.status);
  return (
    <div className="page wide">
      <button className="link" onClick={onBack}>← Builds</button>
      <h1>{b.source?.title ?? b.id} <span className="muted">· {b.n} items · {b.model}</span></h1>
      <p className="muted">{b.createdAt ? new Date(b.createdAt).toLocaleString() : ''} · digest {b.source?.sha?.slice(0, 12)} ({b.source?.claims} claims, {b.source?.digestReview}){b.by ? ` · by ${b.by}` : ''}{b.jobId ? ` · job ${b.jobId}` : ''}</p>
      <div className={`progress ${b.status}`}>
        <span className={`badge badge-${b.status === 'failed' ? 'rejected' : 'pending'}`}>{b.status}{live ? '…' : ''}</span>
        {live ? <span>{p.phase === 'queued' ? 'waiting for a worker' : p.phase === 'plan' ? 'planning items' : `${p.itemsDone ?? 0}/${p.of ?? b.n} items done${p.item ? ` · ${p.item}` : ''}${p.step ? ` · ${p.step}` : ''}${p.phase === 'control' ? ' · single-shot control' : ''}`}</span> : null}
        {b.status === 'failed' ? <span className="error">{b.error?.message ?? 'failed'}</span> : null}
      </div>
      {b.plan?.length ? <ul className="planlist">{b.plan.map((x) => <li key={x.id}><strong>{x.id}</strong> <code>{x.path}</code><div className="muted">{x.focus} · claims {x.claims.join(', ')}</div></li>)}</ul> : null}
      <pre className="eventlog">{events.map((e) => (EVENT_LINE[e.type] ? EVENT_LINE[e.type](e) : e.type)).join('\n')}{live ? '\n…' : ''}</pre>
    </div>
  );
}

export default function BuildView({ id, onBack }) {
  const [b, setB] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');
  const live = b?.pending && ['queued', 'launched', 'running'].includes(b.status);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const d = await api.build(id);
        if (stop) return;
        setB(d); setError('');
        if (d.pending) setEvents((await api.buildEvents(id)).events);
      } catch (e) { if (!stop) setError(e.message); }
    };
    tick();
    const t = setInterval(() => { if (live || !b) tick(); }, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [id, live, b === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const rates = b?.summary?.rates;
  const cov = b?.coverage;
  if (error && !b) return <div className="page"><p className="error">{error}</p><button onClick={onBack}>Back</button></div>;
  if (!b) return <div className="page">Loading…</div>;
  if (b.pending) return <PendingBuild b={b} events={events} onBack={onBack} />;
  return (
    <div className="page wide">
      <button className="link" onClick={onBack}>← Builds</button>
      <h1>{b.source.title} <span className="muted">· {b.n} items · {b.model}</span></h1>
      <p className="muted">{new Date(b.createdAt).toLocaleString()} · digest {b.source.sha?.slice(0, 12)} ({b.source.claims} claims, {b.source.digestReview}) · {b.totals.calls} generation calls · {b.totals.input_tokens.toLocaleString()} in ({b.totals.cached_tokens.toLocaleString()} cached) / {b.totals.output_tokens.toLocaleString()} out · {Math.round(b.totals.ms / 60000)} min{b.pathHint ? ` · path pinned: ${b.pathHint}` : ' · planner chose paths'}{b.rescored?.length ? ` · re-scored ${new Date(b.rescored[b.rescored.length - 1].at).toLocaleString()} (${b.rescored.reduce((n, r) => n + r.changes.length, 0)} pick changes under current rules)` : ''}</p>

      <table className="arms">
        <thead><tr><th></th><th>digestRecall</th><th>sourceRecall</th><th>necessity</th><th>all checks</th><th>cover</th><th>form</th></tr></thead>
        <tbody>
          <tr><th>path items</th><td className={rateClass(rates.digestRecall)}>{rates.digestRecall}</td><td>{rates.sourceRecall}</td><td className={rateClass(rates.necessity)}>{rates.necessity}</td><td>{rates.allChecks}</td><td>{b.summary.rows.filter((r) => r.cover === 'pass').length}/{b.summary.rows.filter((r) => r.status === 'done').length}</td><td className="muted">checked at assembly</td></tr>
          {b.baselines?.length ? <tr><th>single-shot controls</th><td className={rateClass(rates.baselineDigestRecall)}>{rates.baselineDigestRecall}</td><td>{rates.baselineSourceRecall}</td><td className="muted">n/a</td><td className="muted">n/a</td><td>{rates.baselineCover}</td><td>{rates.baselineForm}</td></tr> : null}
        </tbody>
      </table>
      <p className="muted small">digestRecall: the key is not entailed by the source's claims alone (the one check both arms can take). necessity: the key becomes determinable only with the full path's artifacts. The checks are conservative: a picker that over-reads a note counts against the path item, never for it.</p>

      {b.items.map((rec) => <ItemCard key={rec.plan.id} rec={rec} baseline={b.baselines?.find((x) => x.plan.id === rec.plan.id)} />)}

      {cov ? (
        <section className="coverage">
          <h2>Coverage</h2>
          <p>{cov.usedCount}/{cov.total} claims used by the items' recall steps and case constraints · {Object.entries(cov.byType).map(([k, v]) => `${k} ${v.used}/${v.total}`).join(' · ')}</p>
          <ul>{Object.entries(cov.perItem).map(([k, ids]) => <li key={k}><strong>{k}</strong>: {ids.join(', ') || 'none'}</li>)}</ul>
          <p className="muted">unused: {cov.unused.join(', ') || 'none'}</p>
        </section>
      ) : null}
    </div>
  );
}

function rateClass(v) {
  if (!v || v === 'n/a') return '';
  const [a, c] = String(v).split('/').map(Number);
  if (!c) return '';
  return a === c ? 'good' : a === 0 ? 'bad' : 'mid';
}
