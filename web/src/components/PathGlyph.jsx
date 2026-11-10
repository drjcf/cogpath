import { parsePathText, stepArgLabel, opOfStep, stepTitle, STEP_LABEL } from '../lib/path.js';

/**
 * The path as step pills in their hues, one run per chain. A branched path shows its chains side by side, a
 * join says what it reads from ("after a, r2"), and a named step shows its name. `size`: 'compact' (lists,
 * headers) or 'large' (home, composer). `active` highlights one step (by id or op, e.g. where a distractor
 * fails). `onStep` makes pills clickable.
 */
export default function PathGlyph({ path, size = 'compact', active = null, onStep = null, title = null }) {
  const steps = typeof path === 'string' ? parsePathText(path) : (path ?? []);
  const chains = [];
  steps.forEach((st) => { if (st.first || !chains.length) chains.push([]); chains[chains.length - 1].push(st); });
  return (
    <span className={`glyph ${size}`} title={title ?? (typeof path === 'string' ? path : '')}>
      {chains.map((chain, c) => (
        <span key={c} className={`glyph-chain ${chains.length > 1 ? 'branch' : ''}`}>
          {chain[0].deps?.length ? <span className="glyph-from">after {chain[0].deps.join(', ')}</span> : null}
          {chain.map((st, i) => {
            const arg = stepArgLabel(st);
            const Tag = onStep ? 'button' : 'span';
            const on = active != null && (active === st.id || active === st.op);
            return (
              <span key={st.id + i} className="glyph-seg">
                <Tag type={onStep ? 'button' : undefined} className={`pill step-${st.op} ${on ? 'active' : ''} ${st.invalid ? 'invalid' : ''}`} onClick={onStep ? () => onStep(st.op, steps.indexOf(st), st.id) : undefined}>
                  <span className="pill-name">{STEP_LABEL[st.op] ?? st.op}</span>
                  {st.label ? <span className="pill-label">{st.label}</span> : null}
                  {arg ? <span className="pill-arg">{arg}</span> : null}
                </Tag>
                {i < chain.length - 1 ? <span className="glyph-rule" aria-hidden="true" /> : null}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}

/**
 * A dot in the step's hue followed by text: the tag for "fails at <step>" and similar. `step` is a step id; give
 * `path` (DSL text or parsed steps) so a named or repeated step takes its op's hue; without it the id is read as an op.
 */
export function StepDot({ step, path = null, children }) {
  const op = opOfStep(step, path) ?? step;
  return <span className={`stepdot step-${op}`}><i aria-hidden="true" />{children ?? stepTitle(step, path)}</span>;
}
