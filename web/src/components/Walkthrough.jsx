import { useState } from 'react';
import { STEP_LABEL } from '../lib/path.js';
import { stepArgLabel, parsePathText } from '../lib/path.js';

/**
 * How the answer was made: the path, vertical, each step opened to what it produced, in words rather than JSON.
 * Everything shown is the recorded artifact of that step; nothing is re-generated for display.
 */
export default function Walkthrough({ trace }) {
  const [open, setOpen] = useState(() => new Set(trace.path.map((s) => s.id)));
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const parsed = parsePathText(trace.pathText ?? '');
  const key = trace.item?.options?.find((o) => o.isKey);
  return (
    <div className="walk">
      {trace.path.map((s, i) => {
        const a = trace.artifacts[s.id];
        const rec = trace.steps?.find((x) => x.id === s.id);
        const arg = parsed[i] ? stepArgLabel(parsed[i]) : '';
        return (
          <section key={s.id} className={`walk-step step-${s.op}`}>
            <button type="button" className="walk-head" onClick={() => toggle(s.id)} aria-expanded={open.has(s.id)}>
              <span className="walk-n">{i + 1}</span>
              <span className="walk-title">{STEP_LABEL[s.op]}{arg ? <span className="walk-arg">{arg}</span> : null}</span>
              <span className="walk-meta">{rec ? `${rec.attempts.length > 1 ? `${rec.attempts.length} attempts, ` : ''}${Math.round((rec.ms ?? 0) / 1000)} s, ${((rec.usage?.output_tokens ?? 0) / 1000).toFixed(1)}k tokens out` : ''}</span>
            </button>
            {open.has(s.id) ? <div className="walk-body">{a ? <Artifact op={s.op} a={a} /> : <p className="muted">no artifact (the step failed)</p>}{rec?.attempts?.some((x) => x.problems?.length) ? <div className="walk-retry">Sent back once: {rec.attempts.flatMap((x) => x.problems ?? []).slice(0, 3).join('; ')}</div> : null}</div> : null}
          </section>
        );
      })}
      <section className="walk-step step-key">
        <div className="walk-head static"><span className="walk-n">{trace.path.length + 1}</span><span className="walk-title">The key</span></div>
        <div className="walk-body"><p className="exam">{key?.text}</p><p className="muted">The synthesized plan, condensed to one option. Each wrong option is what a learner who failed at one step would choose.</p></div>
      </section>
    </div>
  );
}

function Artifact({ op, a }) {
  if (op === 'recall') return (
    <ol className="facts">
      {a.concepts.map((c) => <li key={c.id}><span className="fact-id">{c.id}</span><p className="exam">{c.statement}</p><blockquote className="span">{c.sourceSpan}</blockquote>{c.claims?.length ? <span className="muted small">from claim{c.claims.length > 1 ? 's' : ''} {c.claims.join(', ')}</span> : null}</li>)}
    </ol>
  );
  if (op === 'analyze') return (
    <ol className="relations">
      {a.relations.map((r) => (
        <li key={r.id}>
          <span className="fact-id">{r.id}</span><span className="kind">{r.kind}, from {r.between.join(' and ')}</span>
          <p className="exam">{r.claim}</p>
          <p><span className="lead">So</span> {r.implication}</p>
          <p className="muted"><span className="lead">The misreading</span> {r.commonMisreading}</p>
          {r.evidenceSpan ? <blockquote className="span">{r.evidenceSpan}</blockquote> : null}
        </li>
      ))}
    </ol>
  );
  if (op === 'evaluate') return (
    <div className="evaluation">
      <p className="exam">{a.decision}</p>
      <table>
        <thead><tr><th>strategy</th>{a.criteria.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {a.options.map((o) => (
            <tr key={o.id} className={o.id === a.best ? 'best' : o.id === a.runnerUp ? 'runner' : ''}>
              <td><span className="fact-id">{o.id}</span>{o.label}{o.id === a.best ? <span className="tag">best</span> : o.id === a.runnerUp ? <span className="tag quiet">runner-up</span> : null}<div className="muted small">from {o.derivedFrom.join(', ')}</div></td>
              {a.criteria.map((c) => { const sc = o.scores.find((x) => x.criterion === c); return <td key={c} title={sc?.rationale ?? ''}><span className="rating">{sc?.rating ?? ''}</span><div className="muted small">{sc?.rationale}</div></td>; })}
            </tr>
          ))}
        </tbody>
      </table>
      <p><span className="lead">Decisive factor</span> {a.decisiveFactor}</p>
      {a.whyRunnerUpFails ? <p className="muted"><span className="lead">Why the runner-up loses</span> {a.whyRunnerUpFails}</p> : null}
    </div>
  );
  if (op === 'synthesize') return (
    <div className="synthesis">
      {a.caseConstraint ? <div className="constraint"><span className="lead">The case</span> <span className="exam">{a.caseConstraint.feature}</span><p className="muted">Why the article's generic answer is not enough here: {a.caseConstraint.whyGenericInsufficient}</p></div> : null}
      <p className="exam">{a.synthesis.statement}</p>
      {a.synthesis.novelElement ? <p><span className="lead">What the case changes</span> {a.synthesis.novelElement}</p> : null}
      {a.incompleteAlternatives?.length ? (
        <div className="alts">
          <p className="muted">What a learner who skipped a step would conclude (the material the distractors are built from):</p>
          <ul>{a.incompleteAlternatives.map((x) => <li key={x.skippedStep}><span className={`stepdot step-${x.skippedStep}`}><i aria-hidden="true" />skipped {STEP_LABEL[x.skippedStep] ?? x.skippedStep}</span><p className="exam">{x.statement}</p><p className="muted small">{x.whyWrong}</p></li>)}</ul>
        </div>
      ) : null}
    </div>
  );
  return <pre className="artifact">{JSON.stringify(a, null, 2)}</pre>;
}
