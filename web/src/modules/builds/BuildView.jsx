/**
 * One build: the scorecard (path items beside their single-shot controls), then each item with four views:
 * the item as a reviewer reads it, how the answer was made (the path's artifacts in words), what the verifier
 * found (every check as a question, with the evidence), and the single-shot control built on the same focus.
 * Reviewers certify or reject items here; certified items go to the item bank.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession, canWrite } from '../../lib/auth.js';
import PathGlyph, { StepDot } from '../../components/PathGlyph.jsx';
import Walkthrough from '../../components/Walkthrough.jsx';
import ShortKey from '../../components/ShortKey.jsx';
import { isBranched, stepTitle } from '../../lib/path.js';

const Verdict = ({ ok, children }) => <span className={`verdict ${ok === null || ok === undefined ? 'na' : ok ? 'ok' : 'bad'}`}>{children ?? (ok === null || ok === undefined ? 'not run' : ok ? 'yes' : 'no')}</span>;

export function Options({ item, compact = false, path = null }) {
  return (
    <ol className={`options ${compact ? 'compact' : ''}`}>
      {item.options.map((o) => (
        <li key={o.id} className={o.isKey ? 'key' : ''}>
          <span className="letter">{o.id}</span>
          <span className="exam">{o.text}</span>
          {o.isKey ? <span className="keytag">key</span> : o.failsAt && o.failsAt !== 'unknown' && o.failsAt !== 'none' ? <StepDot step={o.failsAt} path={path}>fails at {stepTitle(o.failsAt, path)}</StepDot> : null}
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
      {(e.evidence ?? []).map((ev, i) => <li key={i}><span className="clause">{ev.clause}</span><span className="from">{ev.noteId}</span><q>{ev.quote}</q></li>)}
      {!e.fullyEntailed && e.missingClause ? <li className="muted">not established by the notes: {e.missingClause}</li> : null}
    </ul>
  );
}

/**
 * The necessity picks. A pick is labelled by what it was denied: "without X" (X and the steps that depend on it),
 * or "all steps". Picks stored before paths could branch carry no `without` and read as "steps 1 to k".
 */
function Necessity({ pn, path = null }) {
  const lastIdx = pn.picks.length - 1;
  const firstHit = pn.picks.findIndex((x) => x.choice === pn.key);
  const [open, setOpen] = useState(!pn.pass && firstHit >= 0 ? firstHit : lastIdx);
  const p = pn.picks[open];
  const label = (x) => ('without' in x ? (x.without ? `without ${stepTitle(x.without, path)}` : 'all steps') : x.k === 0 ? 'no notes' : `steps 1\u2013${x.k}`);
  return (
    <div className="necessity">
      <div className="picks">
        {pn.picks.map((x, i) => (
          <button key={i} type="button" className={`pick ${x.choice === pn.key ? 'hit' : ''} ${open === i ? 'open' : ''}`} onClick={() => setOpen(i)} title={x.override ? `the picker said ${x.raw}; overridden because ${x.override}` : x.reason}>
            <span className="pick-k">{label(x)}</span><span className="pick-v">{x.choice === 'UNDETERMINED' ? 'cannot tell' : x.choice}</span>
          </button>
        ))}
      </div>
      {p ? (
        <div className="pickdetail">
          <p className="muted">{p.steps.length ? `Given only the artifacts of ${p.steps.map((s) => stepTitle(s, path)).join(', ')}` : 'Given only the question and its options'}, the picker {p.raw === 'UNDETERMINED' ? 'could not determine the answer' : `chose ${p.raw}`}{p.override ? `; the verifier overrode that because ${p.override}` : ''}{p.lean && p.choice === 'UNDETERMINED' ? ` (if forced, it would lean ${p.lean})` : ''}.{p.citationsFixed?.length ? ` ${p.citationsFixed.length} quote${p.citationsFixed.length > 1 ? 's' : ''} it attributed to ${[...new Set(p.citationsFixed.map((c) => c.cited))].join('/')} came from ${[...new Set(p.citationsFixed.map((c) => c.found))].join('/')}.` : ''}</p>
          {p.reason ? <p className="reason">{p.reason}</p> : null}
          <Evidence entailment={p.entailment} optionId={p.raw !== 'UNDETERMINED' ? p.raw : (p.lean ?? pn.key)} />
        </div>
      ) : null}
    </div>
  );
}

function RecallCheck({ question, r, keyId, passMeans, noun = 'claims' }) {
  const [open, setOpen] = useState(false);
  if (!r || r.skipped) return <div className="check"><div className="check-q">{question}</div><Verdict ok={null} /><span className="muted">{r?.reason ?? 'not run'}</span></div>;
  return (
    <div className="check">
      <div className="check-q">{question}</div>
      <Verdict ok={r.pass}>{r.pass ? 'no' : 'yes'}</Verdict>
      <span className="check-a">{r.pass ? `The picker could not determine the key from the ${noun}${r.lean === keyId ? ', though it leaned to it' : ''}. ${passMeans}` : `The picker chose the key from the ${noun} alone, citing ${(r.entailment?.find((e) => e.optionId === keyId)?.citedNotes ?? []).join(', ')}. The item tests recall of the article.`} <button type="button" className="link" onClick={() => setOpen(!open)}>{open ? 'hide evidence' : 'evidence'}</button></span>
      {open ? <Evidence entailment={r.entailment} optionId={r.choice !== 'UNDETERMINED' ? r.choice : (r.lean ?? keyId)} /> : null}
    </div>
  );
}

/** Which rubric elements a set of notes established: element chips, lit when established. */
function Elements({ rubric, entailed }) {
  return <span className="elements">{rubric.map((e) => <span key={e.id} className={`el ${entailed.includes(e.id) ? 'on' : ''}`} title={e.requirement}>{e.id}</span>)}</span>;
}

/** The marks a grader gave an answer: every rubric element, met or not, with the quote that earned it. */
function Marks({ rubric, marks }) {
  return (
    <ul className="marks">
      {rubric.map((e) => { const m = marks.find((x) => x.elementId === e.id); return <li key={e.id}><span className={`verdict ${m?.met ? 'ok' : 'bad'}`}>{m?.met ? 'met' : 'not met'}</span> <span className="exam">{e.requirement}</span>{m?.met ? <blockquote className="span">{m.evidence}</blockquote> : m?.override ? <span className="muted small"> ({m.override})</span> : null}</li>; })}
    </ul>
  );
}

function ShortRecallCheck({ question, r, passMeans }) {
  if (!r || r.skipped) return <div className="check"><div className="check-q">{question}</div><Verdict ok={null} /><span className="muted">{r?.reason ?? 'not run'}</span></div>;
  return (
    <div className="check">
      <div className="check-q">{question}</div>
      <Verdict ok={r.pass}>{r.pass ? 'no' : 'yes'}</Verdict>
      <span className="check-a">{r.pass ? `${r.missingClause ? `The model answer's "${r.missingClause}" is not established by them. ` : ''}${passMeans}` : `Every part of the model answer is established by them, citing ${(r.citedNotes ?? []).join(', ')}.`}</span>
    </div>
  );
}

function ShortChecks({ v, item, path = null }) {
  const pn = v.pathNecessity;
  const em = v.elementMapping;
  const [open, setOpen] = useState(() => Math.max(0, pn.picks.findIndex((p) => p.without != null && ((p.entailed ?? []).length > 0))));
  const p = pn.picks[open];
  const label = (x) => (x.without ? `without ${stepTitle(x.without, path)}` : 'every step');
  return (
    <div className="checks">
      {v.assembly ? <div className="check"><div className="check-q">Did assembly finish clean?</div><Verdict ok={false} /><span className="check-a">No. Still unresolved after the last attempt: {v.assembly.problems.join("; ")}</span></div> : null}
      <div className="check"><div className="check-q">Are the quoted facts really in the article?</div><Verdict ok={v.grounding.skipped ? null : v.grounding.pass} /><span className="check-a">{v.grounding.skipped ? v.grounding.reason : `${v.grounding.found} of ${v.grounding.checked} quoted spans found verbatim in the extracted text.`}</span></div>
      <div className="check tall"><div className="check-q">Can an expert with the article, shown no rubric, earn every element?</div><Verdict ok={v.answerability.pass}>{v.answerability.score} of {v.answerability.max}</Verdict><span className="check-a">An expert with the article wrote an answer; a grader scored it against the rubric and quoted the answer for each element it credited.<details><summary>the expert's answer and the marks</summary><p className="exam">{v.answerability.answer}</p><Marks rubric={item.rubric} marks={v.answerability.marks} /></details></span></div>
      <div className="check tall"><div className="check-q">Does the model answer earn every element?</div><Verdict ok={v.modelAnswerScore.pass}>{v.modelAnswerScore.score} of {v.modelAnswerScore.max}</Verdict><span className="check-a">The same grader scored the model answer. A rubric the model answer cannot satisfy is not a usable key.<details><summary>marks</summary><Marks rubric={item.rubric} marks={v.modelAnswerScore.marks} /></details></span></div>
      <ShortRecallCheck question="Could the model answer be found in the article's claims alone?" r={v.digestRecall} passMeans="The answer needs reasoning beyond what the article states." />
      <ShortRecallCheck question="Could the model answer be found in the article's recommendations alone?" r={v.sourceRecall} passMeans="The item is not a restatement of a recommendation." />
      <div className="check tall"><div className="check-q">Does every step earn its element?</div><Verdict ok={pn.pass}>{pn.pass ? 'yes' : 'no'}</Verdict><span className="check-a">For each step in turn, a reader who may use only the artifacts of the other steps (without the steps that depend on it), and must quote them, is asked which rubric elements those notes establish; then once with every step. With a step withheld, neither its element nor the final element may be established; with every step, all of them must be. {pn.verdict}.</span>
        <div className="necessity">
          <div className="picks">{pn.picks.map((x, i) => <button key={i} type="button" className={`pick ${x.without != null && x.entailed.length ? 'hit' : ''} ${open === i ? 'open' : ''}`} onClick={() => setOpen(i)}><span className="pick-k">{label(x)}</span><span className="pick-v">{x.entailed.length ? x.entailed.join(' ') : 'none'}</span></button>)}</div>
          {p ? <div className="pickdetail"><p className="muted">Given only the artifacts of {p.steps.length ? p.steps.map((s) => stepTitle(s, path)).join(', ') : 'no steps'}, the reader found these elements established: <Elements rubric={item.rubric} entailed={p.entailed} /></p>
            <ul className="marks">{p.elements.filter((e) => e.raw || e.entailed).map((e) => <li key={e.elementId}><span className={`verdict ${e.entailed ? 'ok' : 'na'}`}>{e.entailed ? 'established' : 'claimed, not verified'}</span> {e.elementId}{e.override ? <span className="muted small"> ({e.override})</span> : null}{(e.evidence ?? []).slice(0, 2).map((ev, j) => <blockquote key={j} className="span">{ev.quote}</blockquote>)}</li>)}</ul></div> : null}
        </div></div>
      <div className="check tall"><div className="check-q">Does an error at any step break the answer?</div>{em ? <><Verdict ok={em.pass}>{em.terminalBlocked} of {em.total}</Verdict><span className="check-a">Each step in turn is replaced by the error a learner who failed there would make, the steps that depend on it are re-run, and the reader is asked which elements the notes now establish. The final element must not be among them.</span>
        <ul className="mapping">{em.perStep.map((x) => <li key={x.step}><StepDot step={x.step} path={path}>{stepTitle(x.step, path)} corrupted</StepDot><span>{x.entailed.length ? <>still established: <Elements rubric={item.rubric} entailed={x.entailed} /></> : 'nothing established'}, final element {x.terminalBlocked ? 'blocked' : 'still reached'}{x.ownBroken ? ', its own element broken' : ''}</span></li>)}</ul></> : <><Verdict ok={null} /><span className="muted">not run for this build (deep verification was off)</span></>}</div>
    </div>
  );
}

function Checks({ v, item, path = null }) {
  const pn = v.pathNecessity;
  const branched = isBranched(path ?? '');
  return (
    <div className="checks">
      {v.assembly ? <div className="check"><div className="check-q">Did assembly finish clean?</div><Verdict ok={false} /><span className="check-a">No. Still unresolved after the last attempt: {v.assembly.problems.join("; ")}</span></div> : null}
      <div className="check"><div className="check-q">Are the quoted facts really in the article?</div><Verdict ok={v.grounding.skipped ? null : v.grounding.pass} /><span className="check-a">{v.grounding.skipped ? v.grounding.reason : `${v.grounding.found} of ${v.grounding.checked} quoted spans found verbatim in the extracted text.`}</span></div>
      <div className="check"><div className="check-q">Does an expert answering from the article, with no options shown, land on the key?</div><Verdict ok={v.coverTheOptions.pass} /><span className="check-a">The free answer mapped to option {v.coverTheOptions.mappedTo} ({v.coverTheOptions.match}); the key is {v.coverTheOptions.key}. <details><summary>free answer</summary><p className="exam">{v.coverTheOptions.freeAnswer}</p></details></span></div>
      <RecallCheck question="Could the key be found in the article's claims alone?" r={v.digestRecall} keyId={item.key} passMeans="The answer needs reasoning beyond what the article states." />
      <RecallCheck question="Could the key be found in the article's recommendations alone?" r={v.sourceRecall} keyId={item.key} passMeans="The item is not a restatement of a recommendation." noun="recommendations" />
      <div className="check tall"><div className="check-q">Is the key reachable only with the full path?</div><Verdict ok={pn.pass}>{pn.pass ? 'yes' : pn.determinedAt == null ? 'never reached' : branched ? 'a step is not needed' : `after step ${pn.determinedAt} of ${pn.pathLength}`}</Verdict><span className="check-a">{branched ? 'For each step in turn, a picker that may use only the artifacts of the steps left once that step and the steps that depend on it are taken away, and must quote them, is asked to answer; then once more with every step.' : 'A picker that may use only the artifacts of the first k steps, and must quote them, is asked to answer.'} {pn.pass ? 'It could only with every step.' : pn.determinedAt == null ? 'It could not answer even with every step, which counts against the item.' : branched ? `${pn.verdict}.` : `It answered after step ${pn.determinedAt}, so the later steps were not needed.`}</span><Necessity pn={pn} path={path} /></div>
      <div className="check tall"><div className="check-q">Does corrupting any one step make the key unreachable?</div>{v.distractorMapping ? <><Verdict ok={v.distractorMapping.pass}>{v.distractorMapping.keyBlocked} of {v.distractorMapping.total}</Verdict><span className="check-a">Each step was corrupted in turn (a wrong fact, a misread relation, the runner-up strategy, an unintegrated plan), the later steps re-run without the article, and the picker asked again.</span>
        <ul className="mapping">{v.distractorMapping.perStep.map((p) => <li key={p.step}><StepDot step={p.step} path={path}>{stepTitle(p.step, path)} corrupted</StepDot><span>{p.picked === 'UNDETERMINED' ? `cannot tell${p.lean ? ` (leans ${p.lean})` : ''}` : `picked ${p.picked}`}, {p.keyBlocked ? 'key blocked' : 'key still reached'}{p.landed ? ', landed on the tagged distractor' : ''}</span></li>)}</ul></> : <><Verdict ok={null} /><span className="muted">not run for this build (deep verification was off)</span></>}</div>
    </div>
  );
}

function Review({ build, rec, decision, onDecided }) {
  const s = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const act = async (action) => {
    let reason = '';
    if (action === 'reject') { reason = window.prompt('Why is this item rejected? (kept with the record)', '') ?? null; if (reason === null) return; }
    setBusy(true); setErr('');
    try { const out = await api.decideItem(build.id, rec.plan.id, { action, reason }); onDecided(out); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const st = decision?.status ?? 'pending';
  return (
    <div className={`review review-${st}`}>
      {st === 'pending' ? <span className="muted">Not yet reviewed</span> : <span>{st === 'certified' ? 'Certified' : 'Rejected'} by {decision.by}{decision.reason ? `: ${decision.reason}` : ''}</span>}
      {canWrite(s) ? (
        <span className="review-actions">
          {st !== 'certified' ? <button type="button" className="primary" disabled={busy} onClick={() => act('certify')}>Certify item</button> : null}
          {st !== 'rejected' ? <button type="button" className="danger" disabled={busy} onClick={() => act('reject')}>Reject item</button> : null}
          {st !== 'pending' ? <button type="button" className="link quiet" disabled={busy} onClick={() => act('clear')}>Undo</button> : null}
        </span>
      ) : null}
      {err ? <span className="error">{err}</span> : null}
    </div>
  );
}

function ItemCard({ build, rec, baseline, decision, onDecided }) {
  const [tab, setTab] = useState('item');
  const t = rec.trace, v = rec.verification, item = t?.item;
  const cc = t ? t.path.map((s) => t.artifacts[s.id]?.caseConstraint).filter(Boolean).pop() : null;
  const bv = baseline?.verification, bitem = baseline?.trace?.item;
  const tabs = [['item', 'Item'], ['made', 'How the answer was made'], ['verification', 'What the verifier found'], ...(baseline ? [['single-shot', 'Single-shot control']] : [])];
  const nec = v?.pathNecessity;
  return (
    <section className={`itemcard ${decision?.status ? `is-${decision.status}` : ''}`} id={rec.plan.id}>
      <header>
        <div className="itemhead">
          <span className="item-n">{rec.plan.id.replace('item', 'Item ')}</span>
          <PathGlyph path={rec.plan.path} />
        </div>
        <p className="focus">{rec.plan.focus}</p>
        <div className="verdicts">
          {v ? <span className={`tag ${v.summary.pass ? 'ok' : 'warn'}`} title="checks passed of those that apply">{v.summary.passed}/{v.summary.applicable} checks</span> : <span className="tag bad">{rec.status}</span>}
          {nec ? <span className={`tag ${nec.pass ? 'ok' : 'warn'}`} title={nec.verdict}>{nec.pass ? 'needs the full path' : nec.determinedAt == null && v.format !== 'short' ? 'key never reached' : isBranched(rec.plan.path) || v.format === 'short' ? 'answerable without a step' : `answerable after step ${nec.determinedAt}`}</span> : null}
          {v?.digestRecall && !v.digestRecall.skipped ? <span className={`tag ${v.digestRecall.pass ? 'ok' : 'bad'}`}>{v.digestRecall.pass ? 'not in the article as stated' : 'stated by the article'}</span> : null}
          {v?.distractorMapping ? <span className={`tag ${v.distractorMapping.pass ? 'ok' : 'warn'}`}>key blocked {v.distractorMapping.keyBlocked}/{v.distractorMapping.total}</span> : null}
          {v?.elementMapping ? <span className={`tag ${v.elementMapping.pass ? 'ok' : 'warn'}`}>final element blocked {v.elementMapping.terminalBlocked}/{v.elementMapping.total}</span> : null}
          {item?.format === 'short' ? <span className="tag" title="one scored element per path node">short answer, {item.maxPoints} points</span> : null}
        </div>
      </header>
      <nav className="tabs">{tabs.map(([k, label]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}</nav>
      {!item ? <p className="error pad">{rec.error?.message ?? 'The item was not built.'}</p> : null}
      {item && tab === 'item' ? (
        <div className="tabbody">
          {cc ? <div className="constraint"><span className="lead">The case</span> <span className="exam">{cc.feature}</span></div> : null}
          <p className="stem exam">{item.stem}</p>
          <p className="leadin exam">{item.leadIn}</p>
          {item.format === 'short' ? <ShortKey item={item} path={rec.plan.path} /> : <>
          <Options item={item} path={rec.plan.path} />
          <details className="explain"><summary>Explanation and distractor rationale</summary>
            <ol className="bystep">{item.explanation?.map((e) => <li key={e.step}><StepDot step={e.step} path={rec.plan.path} /> <span>{e.reasoning}</span></li>)}</ol>
            <ul className="rationale">{item.options.filter((o) => !o.isKey).map((o) => <li key={o.id}><span className="letter">{o.id}</span><span>{o.failureRationale}</span></li>)}</ul>
          </details></>}
          {rec.status === 'done' ? <Review build={build} rec={rec} decision={decision} onDecided={onDecided} /> : null}
        </div>
      ) : null}
      {item && tab === 'made' ? <div className="tabbody"><Walkthrough trace={t} /></div> : null}
      {item && v && tab === 'verification' ? <div className="tabbody">{v.format === 'short' ? <ShortChecks v={v} item={item} path={rec.plan.path} /> : <Checks v={v} item={item} path={rec.plan.path} />}</div> : null}
      {baseline && tab === 'single-shot' ? (
        <div className="tabbody">
          {!bitem ? <p className="error">{baseline.error?.message ?? 'not built'}</p> : (
            <>
              <p className="muted">One call, same focus and digest, asked for an item that requires recall, analysis, evaluation and synthesis. No path, no artifacts, no step checks.</p>
              <p className="stem exam">{bitem.stem}</p>
              <p className="leadin exam">{bitem.leadIn}</p>
              {bitem.format === 'short' ? <ShortKey item={bitem} /> : <Options item={bitem} />}
              {bv && bv.format === 'short' ? (
                <div className="checks">
                  <div className="check"><div className="check-q">Are the quoted facts really in the article?</div><Verdict ok={bv.grounding.skipped ? null : bv.grounding.pass} /><span className="check-a">{bv.grounding.skipped ? bv.grounding.reason : `${bv.grounding.found} of ${bv.grounding.checked} evidence quotes found.`}</span></div>
                  <div className="check"><div className="check-q">Can an expert with the article earn every element?</div><Verdict ok={bv.answerability.pass}>{bv.answerability.score} of {bv.answerability.max}</Verdict></div>
                  <div className="check"><div className="check-q">Does the model answer earn every element?</div><Verdict ok={bv.modelAnswerScore.pass}>{bv.modelAnswerScore.score} of {bv.modelAnswerScore.max}</Verdict></div>
                  <ShortRecallCheck question="Could the model answer be found in the article's claims alone?" r={bv.digestRecall} passMeans="" />
                  <ShortRecallCheck question="Could the model answer be found in the article's recommendations alone?" r={bv.sourceRecall} passMeans="" />
                  <div className="check"><div className="check-q">Is the item well formed?</div><Verdict ok={bv.form.pass} /><span className="check-a">{bv.form.problems.join('; ') || 'one question, a model answer within limits'}</span></div>
                  <div className="check"><div className="check-q">Path necessity and element mapping</div><Verdict ok={null} /><span className="muted">cannot be measured: there are no step artifacts</span></div>
                </div>
              ) : bv ? (
                <div className="checks">
                  <div className="check"><div className="check-q">Are the quoted facts really in the article?</div><Verdict ok={bv.grounding.skipped ? null : bv.grounding.pass} /><span className="check-a">{bv.grounding.skipped ? bv.grounding.reason : `${bv.grounding.found} of ${bv.grounding.checked} evidence quotes found.`}</span></div>
                  <div className="check"><div className="check-q">Does an expert answering from the article land on the key?</div><Verdict ok={bv.coverTheOptions.pass} /><span className="check-a">mapped to {bv.coverTheOptions.mappedTo} ({bv.coverTheOptions.match})</span></div>
                  <RecallCheck question="Could the key be found in the article's claims alone?" r={bv.digestRecall} keyId={bitem.key} passMeans="" />
                  <RecallCheck question="Could the key be found in the article's recommendations alone?" r={bv.sourceRecall} keyId={bitem.key} passMeans="" noun="recommendations" />
                  <div className="check"><div className="check-q">Is the item well formed?</div><Verdict ok={bv.form.pass} /><span className="check-a">{bv.form.problems.join('; ') || 'option lengths, clause counts and cues within limits'}</span></div>
                  <div className="check"><div className="check-q">Path necessity and distractor mapping</div><Verdict ok={null} /><span className="muted">cannot be measured: there are no step artifacts</span></div>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

const EVENT_LINE = {
  'plan:start': () => 'planning items',
  'plan:done': (e) => `plan: ${e.plans.length} items (${e.usage?.input_tokens ?? 0} in / ${e.usage?.output_tokens ?? 0} out)`,
  'item:start': (e) => `${e.item}: ${e.path}`,
  'step:start': (e) => `  ${e.step} (${e.op}, effort ${e.effort})`,
  'step:retry': (e) => `    sent back: ${(e.problems ?? []).join('; ')}`,
  'step:done': (e) => `    done in ${e.ms} ms, ${e.usage?.input_tokens ?? 0} in / ${e.usage?.output_tokens ?? 0} out${e.problems?.length ? `; problems: ${e.problems.join('; ')}` : ''}`,
  'verify:sourceRecall': (e) => `    recommendations alone: ${e.skipped ? 'n/a' : (e.choice ?? (e.entailed ? 'answer entailed' : 'answer not entailed'))}${e.lean && e.choice === 'UNDETERMINED' ? ` (leans ${e.lean})` : ''}`,
  'verify:digestRecall': (e) => `    claims alone: ${e.skipped ? 'n/a' : (e.choice ?? (e.entailed ? 'answer entailed' : 'answer not entailed'))}${e.lean && e.choice === 'UNDETERMINED' ? ` (leans ${e.lean})` : ''}`,
  'verify:necessity': (e) => `    ${e.without ? `without ${e.without}` : 'with every step'}: ${e.choice ?? `elements established ${(e.entailed ?? []).join(' ') || 'none'}`}${e.override ? ` (overridden: ${e.override})` : ''}`,
  'verify:mapping': (e) => (e.terminalBlocked != null && e.picked == null ? `    ${e.step} corrupted: elements established ${(e.entailed ?? []).join(' ') || 'none'}, final element ${e.terminalBlocked ? 'blocked' : 'reached'}` : `    ${e.step} corrupted: ${e.picked}, key ${e.keyBlocked ? 'blocked' : 'reached'}${e.landed ? ', landed' : ''}`),
  'item:done': (e) => `  ${e.item} ${e.status}${e.pass ? `, checks ${e.pass}` : ''}${e.necessity != null ? `, needs steps 1–${e.necessity}` : ''}${e.digestRecall != null ? `, claims alone: ${e.digestRecall ? 'no' : 'yes'}` : ''}`,
  'baseline:start': (e) => `  single-shot control for ${e.item}`,
  'baseline:done': (e) => `  control ${e.item} ${e.status}${e.pass ? `, checks ${e.pass}` : ''}${e.error ? `, ${e.error}` : ''}`,
};

function PendingBuild({ b, events, onBack }) {
  const p = b.progress ?? {};
  const live = ['queued', 'launched', 'running'].includes(b.status);
  return (
    <div className="page wide">
      <button type="button" className="link back" onClick={onBack}>Builds</button>
      <h1>{b.source?.title ?? b.id}</h1>
      <p className="meta">{b.n} {b.format === 'short' ? 'short-answer ' : ''}items, {b.pathMode === 'composed' ? `${b.paths?.length ?? 1} composed path${(b.paths?.length ?? 1) > 1 ? 's' : ''}` : 'planner-designed paths'}, {b.model}{b.by ? `, started by ${b.by}` : ''}{b.createdAt ? ` on ${new Date(b.createdAt).toLocaleString()}` : ''}</p>
      <div className={`progress ${b.status}`}>
        <span className={`tag ${b.status === 'failed' ? 'bad' : 'warn'}`}>{b.status}{live ? '…' : ''}</span>
        {live ? <span>{p.phase === 'queued' ? 'Waiting for a worker to start' : p.phase === 'plan' ? 'Planning the items' : `${p.itemsDone ?? 0} of ${p.of ?? b.n} items done${p.item ? `, working on ${p.item}` : ''}${p.step ? ` (${p.step})` : ''}${p.phase === 'control' ? ', single-shot control' : ''}`}</span> : null}
        {b.status === 'failed' ? <span className="error">{b.error?.message ?? 'failed'}</span> : null}
      </div>
      {b.plan?.length ? <ol className="planlist">{b.plan.map((x) => <li key={x.id}><PathGlyph path={x.path} /><div className="exam">{x.focus}</div><div className="muted small">claims {x.claims.join(', ')}</div></li>)}</ol> : null}
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
  if (error && !b) return <div className="page"><p className="error">{error}</p><button type="button" onClick={onBack}>Back to builds</button></div>;
  if (!b) return <div className="page">Loading…</div>;
  if (b.pending) return <PendingBuild b={b} events={events} onBack={onBack} />;
  const rates = b.summary.rates;
  const cov = b.coverage;
  const review = b.review ?? { certified: 0, rejected: 0, pending: 0, total: 0 };
  const onDecided = (itemId) => (out) => setB((cur) => ({ ...cur, review: out.review, decisions: { ...cur.decisions, [itemId]: out.decision.status === 'pending' ? undefined : out.decision } }));
  const done = b.summary.rows.filter((r) => r.status === 'done').length;
  return (
    <div className="page wide">
      <button type="button" className="link back" onClick={onBack}>Builds</button>
      <h1>{b.source.title}</h1>
      <p className="meta">{b.n} {b.format === 'short' ? 'short-answer ' : ''}items with {b.baselines?.length ? 'single-shot controls' : 'no controls'}, {b.pathMode === 'composed' ? `${b.paths?.length ?? 1} composed path${(b.paths?.length ?? 1) > 1 ? 's' : ''}` : 'paths designed by the planner'}, {b.model}. Built {new Date(b.createdAt).toLocaleString()}{b.by ? ` by ${b.by}` : ''} from digest {b.source.sha?.slice(0, 12)} ({b.source.claims} claims, {b.source.digestReview}). {b.totals.calls} generation calls, {b.totals.input_tokens.toLocaleString()} tokens in ({b.totals.cached_tokens.toLocaleString()} cached), {b.totals.output_tokens.toLocaleString()} out, {Math.round(b.totals.ms / 60000)} minutes.{b.rescored?.length ? ` Re-scored ${new Date(b.rescored[b.rescored.length - 1].at).toLocaleDateString()} under current rules (${b.rescored.reduce((n, r) => n + r.changes.length, 0)} picks changed).` : ''}</p>
      {b.pathMode === 'composed' && b.paths?.length ? <div className="pathrow">{b.paths.map((p, i) => <span key={i}><PathGlyph path={p} /></span>)}</div> : null}

      <div className="scorecard">
        <table className="arms">
          <thead><tr><th></th><th title="the key is not something the article's claims already state">not stated by the article</th><th title="the key is not a restatement of a recommendation">not a recommendation</th><th title="the key becomes reachable only with the last step's artifact">needs the full path</th><th title="corrupting any one step blocks the key">every step blocks</th><th title="an expert answering from the article lands on the key">expert lands on key</th><th title="all applicable checks">all checks</th></tr></thead>
          <tbody>
            <tr><th>path items</th><td className={rateClass(rates.digestRecall)}>{rates.digestRecall}</td><td>{rates.sourceRecall}</td><td className={rateClass(rates.necessity)}>{rates.necessity}</td><td>{b.summary.rows.filter((r) => r.mapping && r.mapping.split('/')[0] === r.mapping.split('/')[1]).length}/{done}</td><td>{b.summary.rows.filter((r) => r.cover === 'pass').length}/{done}</td><td>{rates.allChecks}</td></tr>
            {b.baselines?.length ? <tr><th>single-shot controls</th><td className={rateClass(rates.baselineDigestRecall)}>{rates.baselineDigestRecall}</td><td>{rates.baselineSourceRecall}</td><td className="na">no artifacts</td><td className="na">no artifacts</td><td>{rates.baselineCover}</td><td className="na"></td></tr> : null}
          </tbody>
        </table>
        <div className="reviewbar">
          <span><strong>{review.certified}</strong> certified, <strong>{review.rejected}</strong> rejected, <strong>{review.pending}</strong> to review</span>
          <a className="button" href={`/api/builds/${b.id}/export?status=certified&download=1`}>Export certified items</a>
          <a className="link" href={`/api/builds/${b.id}/export?status=all&download=1`}>all items as JSON</a>
        </div>
      </div>

      {b.items.map((rec) => <ItemCard key={rec.plan.id} build={b} rec={rec} baseline={b.baselines?.find((x) => x.plan.id === rec.plan.id)} decision={b.decisions?.[rec.plan.id]} onDecided={onDecided(rec.plan.id)} />)}

      {cov ? (
        <section className="coverage">
          <h2>Claims used</h2>
          <p>{cov.usedCount} of {cov.total} claims were used by the items' recall steps and case constraints ({Object.entries(cov.byType).map(([k, v]) => `${k} ${v.used}/${v.total}`).join(', ')}).</p>
          <ul>{Object.entries(cov.perItem).map(([k, ids]) => <li key={k}><strong>{k}</strong> {ids.join(', ') || 'none'}</li>)}</ul>
          <p className="muted">Not used: {cov.unused.join(', ') || 'none'}</p>
        </section>
      ) : null}
    </div>
  );
}

function rateClass(v) {
  if (!v || v === 'n/a') return 'na';
  const [a, c] = String(v).split('/').map(Number);
  if (!c) return '';
  return a === c ? 'good' : a === 0 ? 'bad' : 'mid';
}
