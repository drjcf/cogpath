import { StepDot } from './PathGlyph.jsx';

/**
 * The answer side of a short-answer item: the model answer, then the rubric, one scored element per path node with the
 * step it scores and what an answer that misses it typically says. Works on a built item (`nodeId`) and on an exported
 * one (`node`). `path` (DSL text) lets a named or repeated node take its step's hue.
 */
export default function ShortKey({ item, path = null, compact = false }) {
  const rubric = item.rubric ?? [];
  return (
    <div className={`shortkey ${compact ? 'compact' : ''}`}>
      <div className="modelanswer"><span className="lead">Model answer</span> <span className="exam">{item.modelAnswer}</span></div>
      <table className="rubric">
        <thead><tr><th>Rubric</th><th>Scores</th><th>What an answer that misses it says</th></tr></thead>
        <tbody>
          {rubric.map((e) => {
            const node = e.nodeId ?? e.node;
            return (
              <tr key={e.id}>
                <td className="exam">{e.requirement}</td>
                <td>{node && node !== 'none' ? <StepDot step={node} path={path} /> : <span className="muted small">no step</span>}<div className="muted small">{e.points ?? 1} point</div></td>
                <td className="muted">{e.commonError}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
