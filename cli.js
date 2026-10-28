#!/usr/bin/env node
/**
 * cogpath CLI
 *   cogpath ops
 *   cogpath parse "recall(3) > analyze(contrast) > evaluate(efficacy,safety) > synthesize(management plan)"
 *   cogpath ingest <source.pdf|.md|.txt> [--model] [--claims auto|N] [--inline-text] [--force] [--no-audit]   process once → runs/sources/<sha12>/digest.json
 *   cogpath audit <source|sha> [--apply] [--restore cl10,cl36]                        re-audit a stored digest; --apply removes flagged claims; --restore puts audit-removed claims back
 *   cogpath claim-add <source|sha> --type result --attribution this_work --section results --statement "…" --span "…"   add a claim by hand (span must be verbatim)
 *   cogpath approve <source|sha> [--drop a3,a8] [--note "…"] [--by name]               reviewer approves the digest (bound to its exact content)
 *   cogpath unapprove <source|sha> [--note "…"]                                         back to draft
 *   cogpath sources                                                                    list ingested sources
 *   cogpath digest <source|sha> [--json] [--review]                                    print the digest as the steps see it; --review: each claim with its page and passage
 *   cogpath run <source.pdf|.md|.txt|sha> "<path>" [--source auto|digest|both|raw] [--model muse-spark-1.3] [--effort high] [--deep] [--no-verify] [--out runs] [--seed 7] [--json] [--inline-text]
 *   cogpath build <source|sha> --items N [--path "…"] [--deep] [--baseline] [--seed n] [--model]   N distinct items from one approved digest (+ single-shot controls)
 *   cogpath show <runs/run-….json>
 *   cogpath rescore <build-id|runs/builds/….json|all> [--write]   re-judge a build's stored picks under the current local rules (no model calls); --write updates the record
 *   cogpath probe-cache <source> [--inline-text]     five cheap calls that show whether prefix caching engages, and where
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import * as cryptoSync from 'node:crypto';
import { parsePath, formatPath, PathError } from './core/path.js';
import { describeOps, OPS, schemaOf } from './core/ops/index.js';
import { loadSource, withDigest, sourceFromStore } from './core/source.js';
import { runPath, artifactsBlock, PREAMBLE } from './core/executor.js';
import { verifyItem } from './core/verifier.js';
import { auditDigest, applyAuditRepairs } from './core/ingest.js';
import { ingestFlow, buildFlow } from './core/flows.js';
import { summarize } from './core/build.js';
import { rescoreBuild } from './core/rescore.js';
import { loadIngest, listSources, shortSha, resolveSha, sourceDir, approveIngest, unapproveIngest, writeDigest, saveRun, loadBuild, listBuilds, storeName } from './core/store.js';
import { renderDigest, reviewPassage, checkDigest, locateClaims, CLAIM_TYPES, ATTRIBUTIONS, SECTIONS } from './core/ingest.js';
import { DEFAULT_MODEL, DEFAULT_CACHE_RETENTION, isMock, complete, part } from './core/meta.js';

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, dflt) { const i = args.indexOf(`--${name}`); if (i === -1) return dflt; const v = args[i + 1]; return v === undefined || v.startsWith('--') ? true : v; }
function has(name) { return args.includes(`--${name}`); }
const BOOL_FLAGS = ['--deep', '--no-verify', '--json', '--inline-text', '--force', '--no-audit', '--apply', '--allow-draft', '--review', '--baseline', '--write'];
const positional = args.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(arr[i - 1]?.startsWith('--') && !BOOL_FLAGS.includes(arr[i - 1])));

function die(msg, code = 1) { console.error(`error: ${msg}`); process.exit(code); }

try {
  if (cmd === 'ops') {
    for (const op of describeOps()) {
      console.log(`${op.id.padEnd(11)} bloom ${op.bloom}  effort ${op.effort.padEnd(6)} requires [${op.requires.join(', ')}]`);
      console.log(`             ${op.description}`);
      for (const p of op.params) console.log(`             • ${p.name}${p.positional ? ' (positional)' : ''}: ${p.type}${p.values ? ' ' + p.values.join('|') : ''} = ${JSON.stringify(p.default)}  ${p.description}`);
    }
    console.log('\nassemble    always runs last: key = terminal artifact, one distractor per step (failsAt), ≥4 options');
  } else if (cmd === 'parse') {
    const steps = parsePath(positional[0] ?? '');
    console.log(formatPath(steps));
    console.log(JSON.stringify(steps, null, 2));
  } else if (cmd === 'run') {
    await run();
  } else if (cmd === 'build') {
    await build();
  } else if (cmd === 'show') {
    const trace = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
    printTrace(trace);
  } else if (cmd === 'rescore') {
    const target = positional[0] ?? 'all';
    const { saveBuild } = await import('./core/store.js');
    let records;
    if (target === 'all') records = (await listBuilds(summarize)).map((s) => s.id);
    else if (fs.existsSync(target)) records = [target];
    else records = [target.startsWith('build-') ? target : `build-${target}`];
    if (!records.length) die('no build records found');
    for (const f of records) {
      const b = f.endsWith('.json') ? JSON.parse(fs.readFileSync(f, 'utf8')) : await loadBuild(f);
      if (!b) die(`unknown build ${f}`);
      const before = summarize(b).rates;
      const r = await rescoreBuild(b);
      const after = summarize(b).rates;
      const keys = ['necessity', 'digestRecall', 'sourceRecall', 'allChecks', 'baselineDigestRecall'];
      console.log(`${b.id}  ${b.source?.title ?? ''}  digest ${r.digestAvailable ? 'in store' : 'not in store (recall checks left as recorded)'}`);
      console.log('  ' + keys.map((k) => `${k} ${before[k]}${before[k] !== after[k] ? ` → ${after[k]}` : ''}`).join('  '));
      for (const c of r.changes) console.log(`    ${c.id}: ${c.what}`);
      if (!r.changes.length) console.log('    no change');
      if (has('write')) { if (f.endsWith('.json')) fs.writeFileSync(f, JSON.stringify(b, null, 2)); else await saveBuild(b, summarize); console.log(`  written ${f}`); }
    }
    if (!has('write')) console.log('(dry run; add --write to update the records)');
  } else if (cmd === 'probe-cache') {
    await probeCache();
  } else if (cmd === 'ingest') {
    await ingest();
  } else if (cmd === 'audit') {
    await audit();
  } else if (cmd === 'claim-add') {
    await claimAdd();
  } else if (cmd === 'approve' || cmd === 'unapprove') {
    const sha = await shaOf(positional[0]);
    if (cmd === 'approve') {
      const ing = await loadIngest(sha);
      if (!ing) die(`not ingested: ${shortSha(sha)}`);
      if (warnStaleSchema(ing, positional[0]) && !has('force')) die('refusing to approve a digest from an older claim schema; re-ingest first (or pass --force to approve it anyway)');
      const drop = String(flag('drop', '')).split(',').map((x) => x.trim()).filter(Boolean);
      const { meta, digest } = await approveIngest(sha, { drop, note: String(flag('note', '')), by: String(flag('by', process.env.USER ?? '')), certifyPending: true });
      console.log(`approved ${shortSha(sha)} (${meta.title}): ${digest.claims.length} claims${drop.length ? `, dropped ${drop.join(', ')}` : ''}${meta.review.by ? ` · by ${meta.review.by}` : ''}`);
    } else {
      await unapproveIngest(sha, String(flag('note', '')));
      console.log(`${shortSha(sha)} is back to draft`);
    }
  } else if (cmd === 'digest') {
    const sha = await shaOf(positional[0]);
    const ing = await loadIngest(sha);
    if (!ing) die(`not ingested: ${shortSha(sha)} (run: node cli.js ingest ${positional[0]})`);
    if (warnStaleSchema(ing, positional[0]) && !has('json')) process.exit(1);
    if (has('json')) console.log(JSON.stringify(ing.digest, null, 2));
    else if (has('review')) {
      console.log(`REVIEW ${shortSha(sha)} · ${ing.meta.title} · ${ing.digest.claims.length} claims · status ${ing.status}${ing.meta.audit ? ` · audit removed ${ing.meta.audit.removed?.length ?? 0}` : ''}\nFor each claim: statement, then the source passage with the quoted span marked »…«. Drop what is wrong: node cli.js approve ${positional[0]} --drop cl3,cl8\n`);
      for (const c of ing.digest.claims) {
        console.log(`${c.id}  [${c.type}; ${c.attribution}; ${c.section}${c.page != null ? `; p.${c.page}` : '; page not located'}]\n  ${wrap(c.statement, 110).replace(/\n/g, '\n  ')}`);
        const passage = reviewPassage(c, ing.pages, ing.text);
        console.log(passage ? `  ${wrap(passage, 110).replace(/\n/g, '\n  ')}\n` : '  (span not found in the extracted text)\n');
      }
    } else {
      console.error(`[digest] ${storeName() === 'fs' ? `${sourceDir(shortSha(sha))}/digest.json` : `${storeName()}:sources/${shortSha(sha)}`} · ${ing.digest.claims.length} claims · review: ${ing.status} · the block below is sent verbatim as the first content part of every step call in digest mode (text.txt is used only for local grounding checks)\n`);
      console.log(renderDigest(ing.digest));
    }
  } else if (cmd === 'sources') {
    const list = await listSources();
    if (!list.length) console.log('no ingested sources (run: cogpath ingest <source>)');
    for (const m of list) console.log(`${shortSha(m.sha)}  ${m.status.padEnd(9)} ${String(m.claims ?? m.atoms ?? '?').padStart(3)} claims  ${String(m.words ?? '').padStart(6)} words  ${String(m.ingestedAt ?? m.uploadedAt ?? '').slice(0, 16)}  ${m.mock ? 'MOCK ' : ''}${m.title}`);
  } else {
    console.log('usage: cogpath ops | parse "<path>" | ingest <source> [--claims auto|N] [--force] [--no-audit] | audit <source|sha> [--apply] | approve <source|sha> [--drop ids] [--note] | unapprove <source|sha> | sources | digest <source|sha> [--json|--review] | build <source> --items N [--path] [--deep] [--baseline] | run <source> "<path>" [--source auto|digest|both|raw] [--model] [--effort] [--deep] [--no-verify] [--out dir] [--seed n] [--json] [--inline-text] | show <run.json> | probe-cache <source> [--inline-text]');
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  if (err instanceof PathError) die(err.message);
  console.error(err);
  process.exit(1);
}

async function run() {
  const [srcArg, pathArg] = positional;
  if (!srcArg || !pathArg) die('run needs <source> and "<path>"');
  const steps = parsePath(pathArg);
  const model = flag('model', DEFAULT_MODEL);
  const effort = flag('effort', undefined);
  if (flag('out', undefined)) process.env.COGPATH_DATA = String(flag('out'));
  const seed = flag('seed', undefined);
  const deep = has('deep');
  const verify = !has('no-verify');
  const json = has('json');

  const log = (...m) => { if (!json) console.error(...m); };
  log(`[cogpath] ${isMock() ? 'MOCK ' : ''}model=${model} path=${formatPath(steps)}`);
  const wantMode = flag('source', 'auto');
  if (!['auto', 'digest', 'both', 'raw'].includes(wantMode)) die('--source must be auto, digest, both, or raw');
  // In digest mode the raw file is never sent, so the upload is skipped; the local text is still extracted for grounding.
  const source = await loadApprovedSource(srcArg, wantMode, log);

  const onEvent = (e) => {
    if (e.type === 'step:start') log(`  → ${e.step} (${e.op}, effort ${e.effort})`);
    if (e.type === 'step:retry') log(`    retry: ${e.problems.join('; ')}`);
    if (e.type === 'step:done') log(`    ✓ ${e.step} ${e.ms} ms · ${e.usage?.input_tokens ?? 0} in (${e.usage?.cached_tokens ?? 0} cached) / ${e.usage?.output_tokens ?? 0} out (${e.usage?.reasoning_tokens ?? 0} reasoning)${e.problems?.length ? ` · PROBLEMS: ${e.problems.join('; ')}` : ''}`);
    if (e.type === 'verify:sourceRecall' && !e.skipped) log(`    source recall: ${e.choice}${e.choice === 'UNDETERMINED' && e.lean ? ` (leans ${e.lean})` : ''} from ${e.claims.length} recommendation claims${e.override ? ` (raw ${e.raw} overridden: ${e.override})` : ''}`);
    if (e.type === 'verify:digestRecall' && !e.skipped) log(`    digest recall: ${e.choice}${e.choice === 'UNDETERMINED' && e.lean ? ` (leans ${e.lean})` : ''} from all ${e.claims} claims${e.override ? ` (raw ${e.raw} overridden: ${e.override})` : ''}`);
    if (e.type === 'verify:necessity') log(`    necessity k=${e.k}: ${e.choice}  entailed=[${e.entailed.join(',')}]${e.override ? ` (raw ${e.raw} overridden: ${e.override})` : ''}`);
    if (e.type === 'verify:mapping') log(`    mapping ${e.step}: picked ${e.picked}${e.picked === 'UNDETERMINED' && e.lean ? ` (leans ${e.lean})` : ''}${e.override ? ` (raw ${e.raw} overridden: ${e.override})` : ''} · key blocked ${e.keyBlocked ? '✓' : '✗'} · landed on tagged distractor (${e.expected.join('/')}) ${e.landed ? '✓' : '✗'}`);
  };

  const trace = await runPath({ source, path: steps, model, effort, onEvent, seed: seed ? Number(seed) : undefined });
  if (trace.status === 'failed') {
    const file = await saveRun(trace, { partial: true });
    console.error(`\n[cogpath] FAILED after ${trace.steps.length}/${steps.length} steps: ${trace.error.message}`);
    console.error(`[cogpath] partial trace (completed artifacts, usage) saved to ${file}`);
    process.exit(2);
  }
  if (verify) {
    log('[cogpath] verifying…');
    trace.verification = await verifyItem({ trace, source, model, deep, onEvent });
  }
  const file = await saveRun(trace);
  if (json) { console.log(JSON.stringify(trace, null, 2)); return; }
  printTrace(trace);
  console.log(`\nsaved ${file}`);
}

/** Load a source for item work: digest mode, approval gate, --allow-draft override. Shared by run and build. */
async function loadApprovedSource(srcArg, wantMode, log) {
  // An ingested sha (or a file that is gone but was ingested) loads from the store; otherwise the file is read.
  const storedSha = await resolveSha(srcArg);
  let raw;
  if (storedSha) raw = sourceFromStore(await loadIngest(storedSha));
  else if (!fs.existsSync(path.resolve(String(srcArg)))) {
    const byName = (await listSources()).find((m) => (m.path && path.basename(m.path) === path.basename(String(srcArg))) || m.fileName === path.basename(String(srcArg)));
    if (!byName) die(`source not found: ${srcArg} (not a file here, and no ingested source has that name; run: node cli.js sources)`);
    log(`[cogpath] file not found at ${srcArg}; using the stored copy of ${shortSha(byName.sha)} (${byName.title})`);
    raw = sourceFromStore(await loadIngest(byName.sha));
  } else raw = await loadSource(srcArg, { inlineText: has('inline-text') || wantMode === 'digest' || (wantMode === 'auto' && await hasIngest(srcArg)) });
  if (raw.fromStore && wantMode === 'raw') log('[cogpath] note: raw mode on a stored source sends the stored text inline (no file upload)');
  log(`[cogpath] source: ${raw.kind} "${raw.title}" (${raw.text ? raw.text.split(/\s+/).length : '?'} words${raw.fileId ? `, ${raw.fileId}${raw.fileCached ? ' cached' : ''}` : ''}, sha ${shortSha(raw.sha)}${raw.fromStore ? ', from store' : ''})`);
  const ing = wantMode === 'raw' ? null : await loadIngest(raw.sha);
  if (!ing && (wantMode === 'digest' || wantMode === 'both')) die(`source not ingested; run: node cli.js ingest ${srcArg}`);
  if (ing?.stale) die(`digest ${shortSha(raw.sha)} was written by an older ingest; re-ingest: node cli.js ingest ${srcArg} --inline-text --force`);
  if (ing && ing.status !== 'approved' && !has('allow-draft')) die(`digest ${shortSha(raw.sha)} is ${ing.status}, not approved. Review it (node cli.js digest ${srcArg} --review, or the web console), then approve. To use an unapproved digest anyway: --allow-draft`);
  const source = ing ? { ...withDigest(raw, ing.digest, wantMode === 'auto' ? 'digest' : wantMode), digestReview: ing.status } : raw;
  if (ing) log(`[cogpath] using digest ${shortSha(raw.sha)} (${ing.digest.claims.length} claims, ingested ${ing.meta.ingestedAt.slice(0, 16)}, ${ing.status}) · mode ${source.mode}`);
  else if (wantMode === 'auto') log(`[cogpath] no digest for this source; sending the raw source. For several items from one source: node cli.js ingest ${srcArg}`);
  return source;
}

async function build() {
  const [srcArg] = positional;
  if (!srcArg) die('build needs <source>');
  const n = Number(flag('items', 3));
  if (!Number.isInteger(n) || n < 1 || n > 20) die('--items must be an integer between 1 and 20');
  const model = flag('model', DEFAULT_MODEL);
  const pathHint = flag('path', undefined);
  if (pathHint) parsePath(pathHint); // validate early
  if (flag('out', undefined)) process.env.COGPATH_DATA = String(flag('out'));
  const seed = flag('seed', undefined);
  const deep = has('deep');
  const baseline = has('baseline');
  const json = has('json');
  const log = (...m) => { if (!json) console.error(...m); };
  log(`[cogpath] ${isMock() ? 'MOCK ' : ''}build: ${n} item(s) · model=${model}${pathHint ? ` · path ${pathHint}` : ' · planner chooses paths'}${deep ? ' · deep' : ''}${baseline ? ' · with single-shot baselines' : ''}`);
  const source = await loadApprovedSource(srcArg, 'auto', log);
  if (!source.digest) die('build needs an ingested, approved digest (run: node cli.js ingest <source>; then review and approve)');

  const onEvent = (e) => {
    if (e.type === 'plan:done') { log(`[cogpath] plan: ${e.plans.length} items · ${e.usage?.input_tokens ?? 0} in / ${e.usage?.output_tokens ?? 0} out · ${e.ms} ms`); for (const p of e.plans) log(`  ${p.id}: ${p.pathText}${p.repairedFrom ? ` (repaired from "${p.repairedFrom}")` : ''}\n      focus: ${p.focus}\n      claims: ${p.claims.join(', ')}`); }
    if (e.type === 'item:start') log(`\n[cogpath] ${e.plan.id} (${e.index + 1}/${n}) · ${e.plan.pathText}`);
    if (e.type === 'step:start') log(`  → ${e.step} (${e.op}, effort ${e.effort})`);
    if (e.type === 'step:retry') log(`    retry: ${e.problems.join('; ')}`);
    if (e.type === 'step:done') log(`    ✓ ${e.step} ${e.ms} ms · ${e.usage?.input_tokens ?? 0} in / ${e.usage?.output_tokens ?? 0} out (${e.usage?.reasoning_tokens ?? 0} reasoning)${e.problems?.length ? ` · PROBLEMS: ${e.problems.join('; ')}` : ''}`);
    if (e.type === 'item:done') log(`  ${e.status === 'done' ? `verification ${e.verification?.summary.passed}/${e.verification?.summary.applicable} ${e.verification?.summary.pass ? 'PASS' : 'FAIL'}` : `FAILED: ${e.trace?.error?.message ?? e.status}`}`);
    if (e.type === 'baseline:done') log(`  baseline: ${e.verification ? `${e.verification.summary.passed}/${e.verification.summary.applicable} ${e.verification.summary.pass ? 'PASS' : 'FAIL'} (sourceRecall ${e.verification.sourceRecall.skipped ? 'n/a' : e.verification.sourceRecall.pass ? 'pass' : 'FAIL'}, form ${e.verification.form.pass ? 'pass' : 'FAIL'})` : `failed: ${e.error}`}`);
  };
  const { result, where: file } = await buildFlow({ source, n, pathHint, model, deep, baseline, seed: seed ? Number(seed) : undefined, by: process.env.USER ?? null, onEvent });
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  if (result.status === 'failed' && !result.items.length) { console.error(`\n[cogpath] build FAILED before any item was built: ${result.error.message}\n[cogpath] record saved to ${file}`); process.exit(2); }
  printBuild(result);
  console.log(`\nsaved ${file} (items: ${result.items.map((it) => it.traceId).join(', ')})`);
  if (result.status === 'failed') { console.error(`\n[cogpath] build FAILED: ${result.error.message}`); process.exit(2); }
}

function printBuild(result) {
  const s = summarize(result);
  console.log(`\n═══ build ${result.id} · ${result.source.title} · ${result.n} items · ${result.model}`);
  for (const r of s.rows) {
    console.log(`\n${r.id}  ${r.status.toUpperCase()}  ${r.path}\n  focus: ${r.focus}`);
    if (r.status === 'done') console.log(`  path item:   checks ${r.pass} · necessity ${r.necessity} · digestRecall ${r.digestRecall} · sourceRecall ${r.sourceRecall} · cover ${r.cover}${r.mapping ? ` · key blocked ${r.mapping}` : ''} · ${r.tokens.in} in / ${r.tokens.out} out`);
    if (r.baseline) console.log(r.baseline.error ? `  single-shot: failed (${r.baseline.error})` : `  single-shot: checks ${r.baseline.pass} · digestRecall ${r.baseline.digestRecall} · sourceRecall ${r.baseline.sourceRecall} · cover ${r.baseline.cover} · form ${r.baseline.form} · evidence grounded ${r.baseline.grounding}`);
  }
  const it = result.items.filter((x) => x.status === 'done');
  if (it.length) {
    console.log('\nItems:');
    for (const x of it) {
      const item = x.trace.item;
      console.log(`\n[${x.plan.id}] ${wrap(item.stem)}\n${item.leadIn}`);
      for (const o of item.options) console.log(`  ${o.id}. ${o.text}${o.isKey ? '   [KEY]' : `   [fails at ${o.failsAt}]`}`);
    }
  }
  console.log(`\nRates (path items): necessity ${s.rates.necessity} · digestRecall ${s.rates.digestRecall} · sourceRecall ${s.rates.sourceRecall} · all checks ${s.rates.allChecks}${s.rates.baselineForm ? `\nRates (single-shot): digestRecall ${s.rates.baselineDigestRecall} · sourceRecall ${s.rates.baselineSourceRecall} · cover ${s.rates.baselineCover} · form ${s.rates.baselineForm} (necessity and distractor mapping need step artifacts; digestRecall is the check both arms share)` : ''}`);
  if (s.coverage) console.log(`Coverage: ${s.coverage.usedCount}/${s.coverage.total} claims used (${Object.entries(s.coverage.byType).map(([k, v]) => `${k} ${v.used}/${v.total}`).join(', ')}); unused: ${s.coverage.unused.join(', ') || 'none'}`);
  const t = s.totals;
  console.log(`Totals (planning, item steps, baselines; verification calls add roughly the same again): ${t.calls} calls · ${t.input_tokens} in (${t.cached_tokens} cached) / ${t.output_tokens} out (${t.reasoning_tokens} reasoning) · ${Math.round(t.ms / 1000)} s`);
}

async function hasIngest(srcArg) {
  try {
    const p = path.resolve(String(srcArg));
    if (!fs.existsSync(p)) return false;
    const { createHash } = cryptoSync;
    return Boolean(await loadIngest(createHash('sha256').update(fs.readFileSync(p)).digest('hex')));
  } catch { return false; }
}

async function ingest() {
  const [srcArg] = positional;
  if (!srcArg) die('ingest needs <source>');
  const model = flag('model', DEFAULT_MODEL);
  const claimsArg = String(flag('claims', 'auto'));
  const maxClaims = claimsArg === 'auto' ? undefined : Number(claimsArg);
  if (maxClaims !== undefined && (!Number.isInteger(maxClaims) || maxClaims < 8 || maxClaims > 120)) die('--claims must be "auto" or an integer between 8 and 120');
  const source = await loadSource(srcArg, { inlineText: has('inline-text') });
  console.error(`[ingest] ${isMock() ? 'MOCK ' : ''}model=${model} source: ${source.kind} "${source.title}" (${source.text ? source.text.split(/\s+/).length : '?'} words${source.fileId ? `, ${source.fileId}` : ''}, sha ${shortSha(source.sha)})`);
  const existing = await loadIngest(source.sha);
  if (existing && !has('force')) {
    console.error(`[ingest] already ingested (${existing.digest.claims.length} claims, ${existing.meta.ingestedAt.slice(0, 16)}) at ${existing.dir ?? shortSha(source.sha)}; use --force to redo`);
    return;
  }
  const { result, meta, dir } = await ingestFlow({ source, model, maxClaims, audit: !has('no-audit'), log: (m) => console.log(m) });
  for (const a of result.digest.claims) console.log(`  ${a.id.padEnd(4)} [${a.type}; ${a.attribution}; ${a.section}] ${a.statement}`);
  console.log(`saved ${dir} (${meta.title})`);
}

/** Add one claim by hand. The span must be verbatim in the source text (same check as ingest); figures in the statement must be near it. */
async function claimAdd() {
  const sha = await shaOf(positional[0]);
  const ing = await loadIngest(sha);
  if (!ing) die(`not ingested: ${shortSha(sha)}`);
  const type = String(flag('type', '')), attribution = String(flag('attribution', '')), section = String(flag('section', 'other'));
  const statement = String(flag('statement', '')).trim(), span = String(flag('span', '')).trim(), importance = String(flag('importance', 'added by reviewer'));
  if (!CLAIM_TYPES.includes(type)) die(`--type must be one of ${CLAIM_TYPES.join(', ')}`);
  if (!ATTRIBUTIONS.includes(attribution)) die(`--attribution must be one of ${ATTRIBUTIONS.join(', ')}`);
  if (!SECTIONS.includes(section)) die(`--section must be one of ${SECTIONS.join(', ')}`);
  if (!statement || !span) die('--statement and --span are required');
  const nextNum = Math.max(0, ...ing.digest.claims.map((c) => Number(c.id.replace(/\D/g, '')) || 0), ...(ing.meta.audit?.removedClaims ?? []).map((c) => Number(c.id.replace(/\D/g, '')) || 0)) + 1;
  const claim = { id: `cl${nextNum}`, type, statement, span, section, attribution, importance };
  const chk = checkDigest({ ...ing.digest, claims: [...ing.digest.claims, claim] }, ing.text);
  const mine = chk.problems.find((p) => p.id === claim.id);
  if (mine) die(`claim rejected: ${mine.reasons.join('; ')}`);
  const located = locateClaims({ claims: [claim] }, ing.pages).claims[0];
  const claims = [...ing.digest.claims, located];
  const meta = await writeDigest(sha, { ...ing.digest, claims }, { added: [...(ing.meta.added ?? []), { id: claim.id, at: new Date().toISOString(), by: String(flag('by', process.env.USER ?? '')) }] });
  console.log(`added ${claim.id} [${type}; ${attribution}; ${section}${located.page != null ? `; p.${located.page}` : ''}] ${statement}\n${claims.length} claims; status ${meta.status} (approve again if it was approved)`);
}

/** True (and a warning printed) when a stored digest predates the current claim schema. */
function warnStaleSchema(ing, arg) {
  const stale = ing.stale;
  if (stale) console.error(`[digest] WARNING: ${shortSha(ing.meta.sha)} was ingested with an older claim schema (atoms without attribution, no audit). Re-ingest before review: node cli.js ingest ${arg} --inline-text --force`);
  return stale;
}

/** A CLI argument → sha: an ingested sha prefix, or the sha256 of a file's bytes. */
async function shaOf(arg) {
  if (!arg) die('this command needs <source file> or <sha prefix>');
  const sha = await resolveSha(arg);
  if (sha) return sha;
  const p = path.resolve(String(arg));
  if (!fs.existsSync(p)) die(`not an ingested sha and not a file: ${arg}`);
  return cryptoSync.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function audit() {
  const sha = await shaOf(positional[0]);
  const ing = await loadIngest(sha);
  if (!ing) die(`not ingested: ${shortSha(sha)}`);
  if (warnStaleSchema(ing, positional[0])) process.exit(1);
  const restore = String(flag('restore', '')).split(',').map((x) => x.trim()).filter(Boolean);
  if (restore.length) {
    const pool = ing.meta.audit?.removedClaims ?? [];
    const missing = restore.filter((id) => !pool.some((c) => c.id === id));
    if (missing.length) die(`not among audit-removed claims (${pool.map((c) => c.id).join(', ') || 'none recorded'}): ${missing.join(', ')}`);
    const back = pool.filter((c) => restore.includes(c.id));
    const claims = [...ing.digest.claims, ...back].sort((a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
    const meta = await writeDigest(sha, { ...ing.digest, claims }, { audit: { ...ing.meta.audit, removed: (ing.meta.audit?.removed ?? []).filter((id) => !restore.includes(id)), restored: [...(ing.meta.audit?.restored ?? []), ...restore] } });
    console.log(`restored ${back.map((c) => c.id).join(', ')}; ${claims.length} claims (status: ${meta.status})`);
    return;
  }
  const model = flag('model', DEFAULT_MODEL);
  const a = await auditDigest(ing.digest, ing.text, { model });
  console.log(`audit of ${shortSha(sha)}: ${a.findings.length} claims checked · ${a.usage.calls} calls · ${a.usage.input_tokens} in / ${a.usage.output_tokens} out · ${a.repaired.length} label(s) to correct · ${a.flagged.length} to remove`);
  for (const f of a.findings) console.log(`  ${f.supported ? '✓' : a.repaired.includes(f) ? '✎' : '✗'} ${f.id.padEnd(4)} ${f.supported ? '' : `[${f.issue}${a.repaired.includes(f) ? ` → ${f.issue === 'type' ? f.correctedType : f.correctedAttribution}` : ''}] ${f.note}`}`);
  if (has('apply') && (a.flagged.length || a.repaired.length)) {
    const bad = new Set(a.flagged.map((f) => f.id));
    const digest = { ...applyAuditRepairs(ing.digest, a.repaired), claims: applyAuditRepairs(ing.digest, a.repaired).claims.filter((x) => !bad.has(x.id)) };
    await writeDigest(sha, digest, { audit: { at: new Date().toISOString(), findings: a.findings, removed: [...bad], removedClaims: [...(ing.meta.audit?.removedClaims ?? []), ...ing.digest.claims.filter((x) => bad.has(x.id))], usage: a.usage } });
    console.log(`corrected ${a.repaired.length} label(s), removed ${bad.size} claim(s); ${digest.claims.length} remain`);
  } else if (a.flagged.length || a.repaired.length) console.log('(no changes written; rerun with --apply to correct labels and remove flagged claims)');
}

/**
 * Prefix-cache probe. Same source, five calls:
 *   1. recall            2. recall again (identical request)      3. analyze (same source prefix, different schema + tail)
 * Prints input/cached tokens and the raw usage object of each, so the question "does caching engage, and
 * does the schema or the file break it" is answered by numbers rather than guesses.
 */
async function probeCache() {
  const [srcArg] = positional;
  if (!srcArg) die('probe-cache needs <source>');
  const model = flag('model', DEFAULT_MODEL);
  const source = await loadSource(srcArg, { inlineText: has('inline-text') });
  console.error(`[probe] ${isMock() ? 'MOCK ' : ''}model=${model} source: ${source.kind} "${source.title}" (${source.text ? source.text.split(/\s+/).length : '?'} words${source.fileId ? `, ${source.fileId}` : ''})`);
  console.error(`[probe] prompt_cache_key=${source.cacheKey} retention=${DEFAULT_CACHE_RETENTION}`);
  const steps = parsePath('recall(3) > analyze(causal)');
  const ctx = (i, artifacts) => ({ source, path: steps, step: steps[i], priorSteps: steps.slice(0, i), artifacts });
  const report = (label, res) => {
    console.log(`${label.padEnd(18)} ${String(res.usage.input_tokens).padStart(7)} in  ${String(res.usage.cached_tokens).padStart(7)} cached  ${String(res.usage.output_tokens).padStart(6)} out  ${res.ms} ms${res.notes?.length ? '  ' + res.notes.join('; ') : ''}`);
    console.log(`                   raw usage: ${JSON.stringify(res.rawUsage ?? res.usage)}`);
  };
  const call = async (label, op, artifacts, i) => {
    const c = ctx(i, artifacts);
    const res = await complete({
      instructions: PREAMBLE, parts: [...source.parts, part.text(artifactsBlock(artifacts, steps)), part.text(op.instruction(c))],
      schema: schemaOf(op, c), schemaName: `${op.id}_output`, effort: 'minimal', model, maxOutputTokens: 8192, label: `probe:${label}`, cacheKey: source.cacheKey, mock: () => op.mock(c),
    });
    report(label, res);
    return res.json;
  };
  const plain = async (label) => {
    const res = await complete({
      instructions: PREAMBLE, parts: [...source.parts, part.text('Reply with the single word OK.')],
      effort: 'minimal', model, maxOutputTokens: 1024, label: `probe:${label}`, cacheKey: source.cacheKey, mock: () => 'OK',
    });
    report(label, res);
  };
  const art = await call('recall #1', OPS.recall, {}, 0);
  await call('recall #2 (same)', OPS.recall, {}, 0);
  await call('analyze', OPS.analyze, { recall: art }, 1);
  await plain('plain #1 (no schema)');
  await plain('plain #2 (same)');
  console.log(`
Reading the numbers:
  recall #2 cached ≈ #1 in     caching works with the cache key; a 0 on step 2+ of a run then means the schema or tail breaks the prefix
  analyze cached > 0           the source prefix survives a schema change: runs should show cached ≥ source tokens from step 2 on
  plain #2 cached > 0 only     structured output (json_schema) is what disables caching
  all zero                     caching is not engaging for this source type even with a key; compare with/without --inline-text`);
}

function printTrace(trace) {
  const { item } = trace;
  console.log(`\n═══ ${trace.pathText}  ·  ${trace.model}  ·  ${trace.source.title}`);
  for (const s of trace.steps) {
    console.log(`  ${s.id.padEnd(11)} ${String(s.ms).padStart(6)} ms  ${String(s.usage?.input_tokens ?? 0).padStart(6)} in / ${String(s.usage?.output_tokens ?? 0).padStart(5)} out  ${s.problems?.length ? '⚠ ' + s.problems.join('; ') : '✓'}`);
  }
  console.log(`  ${'assemble'.padEnd(11)} ${String(trace.assemble.ms).padStart(6)} ms  ${String(trace.assemble.usage?.input_tokens ?? 0).padStart(6)} in / ${String(trace.assemble.usage?.output_tokens ?? 0).padStart(5)} out  ${trace.assemble.problems?.length ? '⚠ ' + trace.assemble.problems.join('; ') : '✓'}`);
  const t = trace.totals;
  console.log(`  total       ${String(t.ms).padStart(6)} ms  ${t.calls} calls · ${t.input_tokens} in (${t.cached_tokens} cached) / ${t.output_tokens} out (${t.reasoning_tokens} reasoning)`);

  console.log(`\n${wrap(item.stem)}\n\n${item.leadIn}\n`);
  const cc = trace.path.map((s) => trace.artifacts[s.id]?.caseConstraint).filter(Boolean).pop();
  if (cc) console.log(`  [case constraint: ${cc.feature} (${cc.whyGenericInsufficient}; from ${cc.derivedFrom.join(', ')})${item.constraintSpan ? ` · in stem: "${item.constraintSpan}"` : ''}]\n`);
  for (const o of item.options) console.log(`  ${o.id}. ${o.text}${o.isKey ? '   [KEY]' : `   [fails at ${o.failsAt}]`}`);
  console.log('\nExplanation by step:');
  for (const e of item.explanation) console.log(`  ${e.step}: ${e.reasoning}`);
  console.log('\nDistractor rationale:');
  for (const o of item.options.filter((x) => !x.isKey)) console.log(`  ${o.id} (${o.failsAt}): ${o.failureRationale}`);

  const v = trace.verification;
  if (v) {
    console.log(`\nVerification: ${v.summary.passed}/${v.summary.applicable} ${v.summary.pass ? 'PASS' : 'FAIL'}`);
    if (!v.grounding.skipped) console.log(`  grounding        ${v.grounding.pass ? '✓' : '✗'} ${v.grounding.found}/${v.grounding.checked} spans found${v.grounding.missing.length ? ' · missing: ' + v.grounding.missing.map((m) => `${m.id}`).join(', ') : ''}`);
    console.log(`  coverTheOptions  ${v.coverTheOptions.pass ? '✓' : '✗'} free answer mapped to ${v.coverTheOptions.mappedTo} (${v.coverTheOptions.match}); key ${v.coverTheOptions.key}`);
    if (v.sourceRecall && !v.sourceRecall.skipped) console.log(`  sourceRecall     ${v.sourceRecall.pass ? '✓' : '✗'} ${v.sourceRecall.verdict}`);
    if (v.digestRecall && !v.digestRecall.skipped) console.log(`  digestRecall     ${v.digestRecall.pass ? '✓' : '✗'} ${v.digestRecall.verdict}`);
    console.log(`  pathNecessity    ${v.pathNecessity.pass ? '✓' : '✗'} picks by notes depth: ${v.pathNecessity.picks.map((p) => `k${p.k}=${p.choice}${p.override ? `(raw ${p.raw})` : ''}`).join(' ')} → ${v.pathNecessity.verdict}${v.pathNecessity.leaksContained ? ` · ${v.pathNecessity.leaksContained} outside-knowledge pick(s) contained` : ''}`);
    if (v.distractorMapping) console.log(`  distractorMapping ${v.distractorMapping.pass ? '✓' : '✗'} key blocked ${v.distractorMapping.keyBlocked}/${v.distractorMapping.total}, landed ${v.distractorMapping.landed}/${v.distractorMapping.total}: ${v.distractorMapping.perStep.map((p) => `${p.step}→${p.picked}${p.picked === 'UNDETERMINED' && p.lean ? '~' + p.lean : ''}${p.landed ? '' : '(exp ' + p.expected.join('/') + ')'}`).join(' ')}`);
  }
}

function wrap(s, w = 100) { return String(s).replace(new RegExp(`(.{1,${w}})(\\s+|$)`, 'g'), '$1\n').trimEnd(); }
