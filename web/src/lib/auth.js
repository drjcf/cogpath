/**
 * Identity for the console. The server says which mode it runs in (/api/config):
 *   firebase: Google sign-in through Firebase Auth; every request carries the ID token; /api/me says whether the
 *             signed-in email is on the allowlist (canWrite).
 *   none:     local development; the identity is a reviewer name kept in this browser and sent as a header.
 */
import { useSyncExternalStore } from 'react';

const state = { ready: false, mode: 'none', firebaseApp: null, fbUser: null, user: null, error: '', config: null };
const listeners = new Set();
// useSyncExternalStore re-renders only when the snapshot's identity changes, so every emit publishes a fresh copy.
let snap = { ...state };
const emit = () => { snap = { ...state }; for (const l of listeners) l(); };
const snapshot = () => snap;
export function useSession() { return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, snapshot, snapshot); }

const NAME_KEY = 'cogpath.reviewer';
export const reviewerName = {
  get: () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } },
  set: (name) => { try { localStorage.setItem(NAME_KEY, name); } catch { /* storage unavailable */ } },
};

let fb = null; // { auth, GoogleAuthProvider, signInWithPopup, signOut }

async function loadMe() {
  try {
    const res = await fetch('/api/me', { headers: await authHeaders() });
    const me = await res.json();
    state.user = me.anonymous ? null : me;
    state.error = me.authError ?? '';
  } catch (e) { state.user = null; state.error = e.message; }
  emit();
}

export async function initSession() {
  if (state.ready) return;
  try {
    const cfg = await (await fetch('/api/config')).json();
    state.config = cfg;
    state.mode = cfg.auth === 'firebase' && cfg.firebase ? 'firebase' : cfg.auth === 'firebase' ? 'firebase-unconfigured' : 'none';
    if (state.mode === 'firebase') {
      const [{ initializeApp, getApps }, authMod] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
      state.firebaseApp = getApps()[0] ?? initializeApp(cfg.firebase);
      const auth = authMod.getAuth(state.firebaseApp);
      fb = { auth, GoogleAuthProvider: authMod.GoogleAuthProvider, signInWithPopup: authMod.signInWithPopup, signOut: authMod.signOut };
      authMod.onAuthStateChanged(auth, async (u) => { state.fbUser = u; await loadMe(); });
    } else if (state.mode === 'none') {
      await loadMe();
    }
  } catch (e) { state.error = e.message; }
  state.ready = true;
  emit();
}

export async function authHeaders() {
  if (state.mode === 'firebase' && state.fbUser) return { authorization: `Bearer ${await state.fbUser.getIdToken()}` };
  if (state.mode === 'none') { const n = reviewerName.get().trim(); return n ? { 'x-cogpath-user': n } : {}; }
  return {};
}

export async function signIn() {
  if (!fb) throw new Error('sign-in is not configured on this server');
  state.error = '';
  try { await fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider()); }
  catch (e) { state.error = e.code === 'auth/popup-closed-by-user' ? '' : e.message; emit(); }
}
export async function signOut() { if (fb) await fb.signOut(fb.auth); state.user = null; emit(); }
export async function setReviewerName(name) { reviewerName.set(name); await loadMe(); }

export const canWrite = (s) => Boolean(s.user?.canWrite);
