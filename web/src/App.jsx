import { useEffect, useState } from 'react';
import Home from './modules/home/Home.jsx';
import SourcesList from './modules/review/SourcesList.jsx';
import ReviewConsole from './modules/review/ReviewConsole.jsx';
import BuildsList from './modules/builds/BuildsList.jsx';
import BuildView from './modules/builds/BuildView.jsx';
import ItemsBank from './modules/items/ItemsBank.jsx';
import Identity from './components/Identity.jsx';
import { initSession, useSession } from './lib/auth.js';

/** Hash routing: #/ (home) · #/sources · #/review/<sha> · #/builds · #/builds/<id> · #/items. No router dependency. */
function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => { const f = () => { setHash(window.location.hash); window.scrollTo(0, 0); }; window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return hash;
}

function Nav({ active }) {
  const s = useSession();
  return (
    <nav className="topnav" aria-label="main">
      <a href="#/" className="brand">cogpath</a>
      <a href="#/sources" className={active === 'sources' ? 'on' : ''}>Sources</a>
      <a href="#/builds" className={active === 'builds' ? 'on' : ''}>Builds</a>
      <a href="#/items" className={active === 'items' ? 'on' : ''}>Items</a>
      <span className="spacer" />
      {s.config?.mock ? <span className="tag bad" title="MOCK_META=1: no model calls">mock</span> : null}
      <Identity />
    </nav>
  );
}

export default function App() {
  const hash = useHashRoute();
  useEffect(() => { initSession(); }, []);
  const go = (h) => { window.location.hash = h; };
  const review = hash.match(/^#\/review\/([0-9a-f]{6,64})/i);
  if (review) return <ReviewConsole sha={review[1]} onBack={() => go('#/sources')} />;
  const build = hash.match(/^#\/builds\/(build-[a-z0-9-]+)/i);
  if (build) return <><Nav active="builds" /><BuildView id={build[1]} onBack={() => go('#/builds')} /></>;
  if (/^#\/builds/.test(hash)) return <><Nav active="builds" /><BuildsList onOpen={(id) => go(`#/builds/${id}`)} /></>;
  if (/^#\/sources/.test(hash)) return <><Nav active="sources" /><SourcesList onOpen={(sha) => go(`#/review/${sha.slice(0, 12)}`)} onBuild={(id) => go(`#/builds/${id}`)} /></>;
  if (/^#\/items/.test(hash)) return <><Nav active="items" /><ItemsBank onOpenBuild={(id) => go(`#/builds/${id}`)} /></>;
  return <><Nav active="home" /><Home /></>;
}
