import { useState } from 'react';
import { useSession, signIn, signOut, setReviewerName, reviewerName } from '../lib/auth.js';

/** Who is acting. Firebase mode: Google sign-in and the allowlist verdict. Local mode: a reviewer name kept in this browser. */
export default function Identity() {
  const s = useSession();
  const [name, setName] = useState(reviewerName.get());
  if (!s.ready) return <span className="identity muted">…</span>;
  if (s.mode === 'none') {
    return (
      <span className="identity">
        <input placeholder="reviewer name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setReviewerName(name.trim())} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} />
        <span className="muted" title="local mode: no sign-in on this server">local</span>
      </span>
    );
  }
  if (s.mode === 'firebase-unconfigured') return <span className="identity muted" title="COGPATH_FIREBASE_WEB_CONFIG is not set on the server">sign-in not configured</span>;
  if (!s.user) {
    return (
      <span className="identity">
        <button className="primary" onClick={signIn}>Sign in with Google</button>
        {s.error ? <span className="error" title={s.error}>sign-in failed</span> : null}
      </span>
    );
  }
  return (
    <span className="identity">
      {s.user.picture ? <img className="avatar" src={s.user.picture} alt="" referrerPolicy="no-referrer" /> : null}
      <span title={s.user.email}>{s.user.name || s.user.email}</span>
      <span className={`badge badge-${s.user.canWrite ? 'certified' : 'pending'}`} title={s.user.canWrite ? 'may upload, review, approve and build' : 'read-only: this account is not on the allowlist'}>{s.user.canWrite ? (s.user.role ?? 'reviewer') : 'read-only'}</span>
      <button className="link" onClick={signOut}>Sign out</button>
    </span>
  );
}
