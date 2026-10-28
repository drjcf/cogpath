/**
 * The two long tasks as functions, shared by the CLI and the cloud worker:
 *   ingestFlow: extraction → recommendations pass → audit → page location → store
 *   buildFlow:  plan → items (+ controls) → store, with progress reported through onEvent
 */
import { ingestSource, auditDigest, applyAuditRepairs, recommendationsPass, defaultClaimCount, locateClaims } from './ingest.js';
import { buildItems, summarize } from './build.js';
import { saveIngest, saveBuild, updateBuildSummary, shortSha } from './store.js';

export async function ingestFlow({ source, model, maxClaims, audit = true, log = () => {} }) {
  const words = source.text ? source.text.trim().split(/\s+/).length : 0;
  log(`[ingest] claim budget: ${maxClaims ?? defaultClaimCount(words)}${maxClaims === undefined ? ` (auto: about one per 150 words of ${words})` : ''}`);
  const result = await ingestSource(source, { model, maxClaims });
  const t = result.totals;
  log(`ingested ${result.digest.claims.length} claims in ${t.calls} call${t.calls > 1 ? 's' : ''} · ${t.input_tokens} in (${t.cached_tokens} cached) / ${t.output_tokens} out (${t.reasoning_tokens} reasoning) · ${t.ms} ms`);
  if (result.dropped.length) log(`dropped ${result.dropped.length} claim(s) that failed local checks: ${result.dropped.map((d) => `${d.id} (${d.reasons.join(', ')})`).join('; ')}`);
  const recs = await recommendationsPass(source, result.digest, { model });
  if (recs.digest) result.digest = recs.digest;
  result.recommendationsPass = { added: recs.added.map((c) => c.id), rejected: recs.rejected, usage: recs.usage, ms: recs.ms };
  result.totals = { ...t, input_tokens: t.input_tokens + (recs.usage?.input_tokens ?? 0), output_tokens: t.output_tokens + (recs.usage?.output_tokens ?? 0), calls: t.calls + 1, ms: t.ms + (recs.ms ?? 0) };
  log(`recommendations pass: ${recs.added.length} added${recs.rejected.length ? `, ${recs.rejected.length} rejected (${recs.rejected.map((r) => `${r.id}: ${r.reasons.join(', ')}`).join('; ')})` : ''} · ${recs.usage?.input_tokens ?? 0} in / ${recs.usage?.output_tokens ?? 0} out`);
  if (audit) {
    const a = await auditDigest(result.digest, source.text, { model });
    const badIds = new Set(a.flagged.map((f) => f.id));
    result.audit = { at: new Date().toISOString(), findings: a.findings, removed: [...badIds], removedClaims: result.digest.claims.filter((x) => badIds.has(x.id)), repaired: a.repaired, usage: a.usage };
    log(`audit: ${a.findings.length} claims checked by an independent reader in ${a.usage.calls} call${a.usage.calls > 1 ? 's' : ''} · ${a.usage.input_tokens} in / ${a.usage.output_tokens} out · ${a.repaired.length} label(s) corrected · ${a.flagged.length} removed`);
    for (const f of a.repaired) log(`  ✎ ${f.id} [${f.issue}] → ${f.issue === 'type' ? f.correctedType : f.correctedAttribution}: ${f.note}`);
    for (const f of a.flagged) log(`  ✗ ${f.id} [${f.issue}] ${f.note}`);
    result.digest = applyAuditRepairs(result.digest, a.repaired);
    if (a.flagged.length) result.digest = { ...result.digest, claims: result.digest.claims.filter((x) => !badIds.has(x.id)) };
  }
  result.digest = locateClaims(result.digest, source.pages); // after the recommendations pass and the audit, so every kept claim has its page
  const { dir, meta } = await saveIngest({ source, result, model });
  const byType = {};
  for (const a of result.digest.claims) byType[a.type] = (byType[a.type] ?? 0) + 1;
  log(`kept ${result.digest.claims.length} claims (${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}; ${result.digest.claims.filter((a) => a.attribution === 'this_work').length} this_work, ${result.digest.claims.filter((a) => a.attribution === 'cited_work').length} cited_work)`);
  return { result, meta, dir, byType };
}

/**
 * Build N items (and controls) and store the record. `onEvent` receives the build events; the summary in the
 * store is patched as items finish so a console can follow a build that is still running.
 */
export async function buildFlow({ source, n, pathHint, model, deep, baseline, seed, id, by, jobId, onEvent }) {
  let itemsDone = 0;
  let currentItem = null;
  const progress = async (patch) => { try { await updateBuildSummary(id, patch); } catch { /* progress is best-effort */ } };
  const wrapped = async (e) => {
    onEvent?.(e);
    if (!id) return;
    if (e.type === 'plan:done') await progress({ status: 'running', phase: 'items', plan: e.plans.map((p) => ({ id: p.id, focus: p.focus, path: p.pathText, claims: p.claims })), progress: { phase: 'items', itemsDone: 0, of: n, at: new Date().toISOString() } });
    if (e.type === 'item:start') { currentItem = e.plan.id; await progress({ progress: { phase: 'item', item: e.plan.id, index: e.index, itemsDone, of: n, step: null, at: new Date().toISOString() } }); }
    if (e.type === 'step:start') await progress({ progress: { phase: 'step', item: currentItem, step: e.step, itemsDone, of: n, at: new Date().toISOString() } });
    if (e.type === 'verify:necessity' || e.type === 'verify:mapping') await progress({ progress: { phase: 'verify', item: currentItem, step: e.type === 'verify:necessity' ? `necessity k${e.k}` : `mapping ${e.step}`, itemsDone, of: n, at: new Date().toISOString() } });
    if (e.type === 'item:done') { itemsDone++; await progress({ progress: { phase: 'item-done', item: e.plan.id, itemsDone, of: n, pass: e.verification ? `${e.verification.summary.passed}/${e.verification.summary.applicable}` : e.status, at: new Date().toISOString() } }); }
    if (e.type === 'baseline:start') await progress({ progress: { phase: 'control', item: e.plan.id, itemsDone, of: n, at: new Date().toISOString() } });
  };
  if (id) await progress({ id, status: 'running', phase: 'plan', createdAt: new Date().toISOString(), model, source: { title: source.title, sha: source.sha ?? null, claims: source.digest?.claims?.length ?? 0, mode: source.mode, digestReview: source.digestReview ?? null }, n, deep, pathHint: pathHint ?? null, by: by ?? null, jobId: jobId ?? null, progress: { phase: 'plan', itemsDone: 0, of: n, at: new Date().toISOString() } });
  const result = await buildItems({ source, n, pathHint, model, deep, baseline, seed, id, onEvent: wrapped });
  result.by = by ?? null; result.jobId = jobId ?? null; result.finishedAt = new Date().toISOString();
  const saved = await saveBuild(result, summarize);
  return { result, ...saved };
}
