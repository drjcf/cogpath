/**
 * Identity for the API. Two modes:
 *   firebase (default when COGPATH_STORE=gcp): a Firebase ID token in `Authorization: Bearer …` is verified with the
 *            Admin SDK; the verified email is the identity, and write routes require it to be on the allowlist.
 *   none     (local development): no verification; the identity is the `x-cogpath-user` header or the body's `by`.
 * Reads are public in both modes. The reviewer of record on every decision is the verified identity, never a
 * client-supplied name, when verification is on.
 */
import { allowlistEntry } from '../core/store.js';

export const authMode = () => process.env.COGPATH_AUTH ?? (process.env.COGPATH_STORE === 'gcp' ? 'firebase' : 'none');

let adminAuth = null;
async function firebaseAuth() {
  if (!adminAuth) {
    const { initializeApp, getApps, applicationDefault } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId });
    adminAuth = getAuth();
  }
  return adminAuth;
}

/** Resolve the caller's identity without requiring one. Sets req.user = { email, name, uid, role } or null. */
export function identify() {
  return async (req, _res, next) => {
    try {
      req.user = null;
      if (authMode() === 'none') {
        const email = String(req.get('x-cogpath-user') ?? req.body?.by ?? '').trim().toLowerCase();
        if (email) req.user = { email, name: email, uid: email, role: (await allowlistEntry(email))?.role ?? 'reviewer', verified: false };
        return next();
      }
      const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
      if (!m) return next();
      const auth = await firebaseAuth();
      const decoded = await auth.verifyIdToken(m[1]);
      const email = String(decoded.email ?? '').toLowerCase();
      const entry = email ? await allowlistEntry(email) : null;
      req.user = { email, name: decoded.name ?? email, uid: decoded.uid, role: entry?.role ?? null, verified: Boolean(decoded.email_verified), picture: decoded.picture ?? null };
      next();
    } catch (e) {
      // A bad token is treated as anonymous; write routes will refuse.
      req.user = null; req.authError = e.message;
      next();
    }
  };
}

/** Write routes: a verified, allowlisted identity (in `none` mode, any named identity). */
export function requireWriter() {
  return (req, res, next) => {
    if (!req.user?.email) return res.status(401).json({ error: authMode() === 'none' ? 'reviewer name is required (x-cogpath-user header or body.by)' : `sign in to do this${req.authError ? ` (${req.authError})` : ''}` });
    if (authMode() !== 'none' && !req.user.role) return res.status(403).json({ error: `${req.user.email} is not on the allowlist; ask the project owner to add you` });
    next();
  };
}
