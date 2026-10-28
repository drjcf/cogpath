import { useEffect, useState } from 'react';
import SourcesList from './modules/review/SourcesList.jsx';
import ReviewConsole from './modules/review/ReviewConsole.jsx';
import BuildsList from './modules/builds/BuildsList.jsx';
import BuildView from './modules/builds/BuildView.jsx';
import Identity from './components/Identity.jsx';
import { initSession, useSession } from './lib/auth.js';

/** Hash routing: #/ (builds) · #/sources · #/review/<sha> · #/builds/<id>. No router dependency. */
function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => { const f = () => setHash(window.location.hash); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return hash;
}

function Nav({ active }) {
  const s = useSession();
  return (
    <nav className="topnav">
      <span className="brand">cogpath</span>
      <a href="#/builds" className={active === 'builds' ? 'on' : ''}>Builds</a>
      <a href="#/sources" className={active === 'sources' ? 'on' : ''}>Sources</a>
      <span className="spacer" />
      {s.config?.mock ? <span className="badge badge-rejected" title="MOCK_META=1: no model calls">mock</span> : null}
      <Identity />
    </nav>
  );
}

export default function App() {
  const hash = useHashRoute();
  useEffect(() => { initSession(); }, []);
  const review = hash.match(/^#\/review\/([0-9a-f]{6,64})/i);
  if (review) return <ReviewConsole sha={review[1]} onBack={() => { window.location.hash = '#/sources'; }} />;
  const build = hash.match(/^#\/builds\/(build-[a-z0-9-]+)/i);
  if (build) return <><Nav active="builds" /><BuildView id={build[1]} onBack={() => { window.location.hash = '#/builds'; }} /></>;
  if (/^#\/sources/.test(hash)) return <><Nav active="sources" /><SourcesList onOpen={(sha) => { window.location.hash = `#/review/${sha.slice(0, 12)}`; }} onBuild={(id) => { window.location.hash = `#/builds/${id}`; }} /></>;
  return <><Nav active="builds" /><BuildsList onOpen={(id) => { window.location.hash = `#/builds/${id}`; }} /></>;
}
