import { parsePathText, stepArgLabel, STEP_LABEL } from '../lib/path.js';

/**
 * The path as a chain of step pills in their hues. `size`: 'compact' (lists, headers) or 'large' (home, composer).
 * `active` highlights one step id (e.g. the step a distractor fails at). `onStep` makes pills clickable.
 */
export default function PathGlyph({ path, size = 'compact', active = null, onStep = null, title = null }) {
  const steps = typeof path === 'string' ? parsePathText(path) : (path ?? []);
  return (
    <span className={`glyph ${size}`} title={title ?? (typeof path === 'string' ? path : '')}>
      {steps.map((st, i) => {
        const arg = stepArgLabel(st);
        const Tag = onStep ? 'button' : 'span';
        return (
          <span key={i} className="glyph-seg">
            <Tag type={onStep ? 'button' : undefined} className={`pill step-${st.op} ${active === st.op ? 'active' : ''} ${st.invalid ? 'invalid' : ''}`} onClick={onStep ? () => onStep(st.op, i) : undefined}>
              <span className="pill-name">{STEP_LABEL[st.op] ?? st.op}</span>
              {arg ? <span className="pill-arg">{arg}</span> : null}
            </Tag>
            {i < steps.length - 1 ? <span className="glyph-rule" aria-hidden="true" /> : null}
          </span>
        );
      })}
    </span>
  );
}

/** A dot in the step's hue followed by text: the tag for "fails at <step>" and similar. */
export function StepDot({ step, children }) {
  return <span className={`stepdot step-${step}`}><i aria-hidden="true" />{children ?? STEP_LABEL[step] ?? step}</span>;
}
