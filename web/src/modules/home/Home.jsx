import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import PathComposer, { useRegistry } from '../../components/PathComposer.jsx';
import PathGlyph from '../../components/PathGlyph.jsx';

function sumRates(builds, key) {
  let a = 0, b = 0;
  for (const x of builds) { const v = x.rates?.[key]; if (!v || v === 'n/a') continue; const [p, q] = String(v).split('/').map(Number); a += p; b += q; }
  return b ? `${a} of ${b}` : null;
}

const CHECKS = [
  ['Could the key be found in the article\'s claims alone?', 'A picker given every claim of the article, and nothing else, must not be able to determine the key. If it can, the item tests recall.'],
  ['Is the key reachable only with the full path?', 'The picker is given the artifacts of the first k steps and must quote them. The key should become determinable only at the last step.'],
  ['Does corrupting any one step make the key unreachable?', 'Each step is corrupted in turn, the later steps re-run without the article, and the picker asked again.'],
  ['Does an expert answering from the article land on the key?', 'A free answer to the scenario, bound by its constraints and with no options shown, is mapped onto the options.'],
  ['Are the quoted facts really in the article?', 'Every span a step quotes is found verbatim in the extracted text.'],
];

export default function Home() {
  const registry = useRegistry();
  const [paths, setPaths] = useState([]);
  const [builds, setBuilds] = useState(null);
  useEffect(() => { api.builds().then((d) => setBuilds(d.builds.filter((b) => b.rates))).catch(() => setBuilds([])); }, []);
  useEffect(() => { if (registry?.presets?.length && !paths.length) setPaths([registry.presets[0].path]); }, [registry]); // eslint-disable-line react-hooks/exhaustive-deps
  const pathStated = builds ? sumRates(builds, 'digestRecall') : null;
  const ctrlStated = builds ? sumRates(builds, 'baselineDigestRecall') : null;
  const necessity = builds ? sumRates(builds, 'necessity') : null;
  return (
    <div className="page wide home">
      <section className="hero">
        <h1>Exam questions compiled from an article, one cognitive step at a time.</h1>
        <p className="lede">A question is designed as a path. The model executes each step over the article's certified claims and leaves a typed artifact behind; the last artifact becomes the key, and every wrong option is what a learner who failed at one step would choose. Then a verifier tries to break the question. Compose a path here, then build from an article.</p>
        <PathComposer value={paths} onChange={setPaths} registry={registry} showHelp />
        <div className="hero-actions">
          <a className="button primary" href="#/sources">Start with an article</a>
          <a className="button" href="#/builds">See the builds</a>
        </div>
      </section>

      <section className="how">
        <div className="how-step">
          <h2>The article becomes claims a person certifies</h2>
          <p>A PDF is read once into claims, each a statement tied to a verbatim span and a page. A second reader audits them. A reviewer certifies, rejects or edits each claim beside the highlighted passage, and approves the digest. Nothing is built on an unapproved digest.</p>
        </div>
        <div className="how-step">
          <h2>The path turns claims into an item</h2>
          <p>Recall retrieves facts; analyze connects them; evaluate weighs strategies; synthesize adapts the judgment to a case the article did not cover. The planner designs a path per item, or you compose the paths yourself.</p>
          <PathGlyph path={registry?.presets?.[2]?.path ?? 'recall(4) > analyze(mechanism) > evaluate(safety, feasibility) > synthesize(operative protocol)'} size="large" />
        </div>
        <div className="how-step">
          <h2>The verifier asks five questions of every item</h2>
          <dl className="questions">{CHECKS.map(([q, a]) => <div key={q}><dt>{q}</dt><dd>{a}</dd></div>)}</dl>
          <p>A single-shot control item is built on the same focus by one call and takes the same questions where they apply, so the comparison is in the record, not in the pitch.</p>
        </div>
      </section>

      {builds?.length ? (
        <section className="numbers">
          <h2>So far, across {builds.length} build{builds.length > 1 ? 's' : ''}</h2>
          <div className="numbers-row">
            <div><span className="num">{pathStated}</span><span className="num-label">path items whose key the article does not already state</span></div>
            <div><span className="num">{ctrlStated ?? 'none'}</span><span className="num-label">single-shot controls whose key the article does not already state</span></div>
            <div><span className="num">{necessity}</span><span className="num-label">path items whose key needs every step</span></div>
          </div>
          <p className="muted">The checks are conservative: a picker that over-reads a note counts against the path item, never for it. What the verifier cannot judge is whether the key is good medicine; that is what the item review is for.</p>
        </section>
      ) : null}
    </div>
  );
}
