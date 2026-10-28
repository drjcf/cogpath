/** Thin client for the cogpath API (same origin; Vite proxies /api in development). Every request carries the session's identity. */
import { authHeaders, reviewerName } from './auth.js';

async function req(path, opts = {}) {
  const headers = { ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(await authHeaders()), ...(opts.headers ?? {}) };
  const res = await fetch(`/api${path}`, { ...opts, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!res.ok) { const e = new Error(body?.error ?? `${res.status} ${res.statusText}`); e.status = res.status; e.body = body; throw e; }
  return body;
}

export const api = {
  config: () => req('/config'),
  me: () => req('/me'),
  sources: () => req('/sources'),
  source: (sha) => req(`/sources/${sha}`),
  text: (sha) => req(`/sources/${sha}/text`),
  upload: (file, { claims = 'auto', audit = true, force = false } = {}) => { const fd = new FormData(); fd.append('claims', String(claims)); fd.append('audit', String(audit)); fd.append('force', String(force)); fd.append('file', file, file.name); return req('/sources/upload', { method: 'POST', body: fd }); },
  ingest: (sha, body = {}) => req(`/sources/${sha}/ingest`, { method: 'POST', body: JSON.stringify(body) }),
  decide: (sha, id, body) => req(`/sources/${sha}/claims/${id}/decide`, { method: 'POST', body: JSON.stringify(body) }),
  approve: (sha, body) => req(`/sources/${sha}/approve`, { method: 'POST', body: JSON.stringify(body) }),
  unapprove: (sha, body = {}) => req(`/sources/${sha}/unapprove`, { method: 'POST', body: JSON.stringify(body) }),
  builds: () => req('/builds'),
  build: (id) => req(`/builds/${id}`),
  buildEvents: (id, after = '') => req(`/builds/${id}/events${after ? `?after=${encodeURIComponent(after)}` : ''}`),
  createBuild: (body) => req('/builds', { method: 'POST', body: JSON.stringify(body) }),
  job: (id) => req(`/jobs/${id}`),
  jobs: () => req('/jobs'),
  /** PDF bytes for the viewer (fetched, not referenced by URL, so the identity header travels with it). */
  pdfBytes: async (sha) => {
    const res = await fetch(`/api/sources/${sha}/pdf`, { headers: await authHeaders() });
    if (!res.ok) throw new Error(`pdf ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

/** Kept for the review console's local-mode name box. */
export const reviewer = reviewerName;
