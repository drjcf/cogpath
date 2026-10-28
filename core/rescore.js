/**
 * Re-judge the stored picks of a build record under the current local discipline (verifier.judgePick) without any
 * model call. A pick is the picker's raw answer plus its per-option entailment evidence; what the verifier does with
 * that evidence is a local rule, and when the rule changes the records can be re-scored instead of re-run.
 *
 * Re-judged: path necessity (notes rebuilt from the stored step artifacts), distractor mapping (notes rebuilt from
 * the stored downstream artifacts; only records that stored the pick's entailment), and source / digest recall when
 * the digest the build used is still in the store with the same claims. Everything else is left as it was.
 */
import { judgePick, notesFor } from './verifier.js';
import { notesFromClaims } from './entail.js';
import { loadIngest } from './store.js';

const UNDETERMINED = 'UNDETERMINED';

/** Re-judge one stored pick in place; returns the previous choice when it changed, else null. */
function rejudge(pick, notes) {
  if (!pick || pick.raw == null || !Array.isArray(pick.entailment)) return null;
  const before = pick.choice;
  const j = judgePick({ choice: pick.raw, entailment: pick.entailment }, notes);
  Object.assign(pick, { choice: j.choice, override: j.override, citationsFixed: j.citationsFixed });
  return j.choice !== before ? before : null;
}

function summaryOf(list) {
  const applicable = list.filter(([, v]) => v !== null);
  return { passed: applicable.filter(([, v]) => v).length, applicable: applicable.length, pass: applicable.every(([, v]) => v), checks: Object.fromEntries(list) };
}

function rescoreRecallCheck(check, claims, item, heading) {
  if (!check || check.skipped || !claims?.length) return false;
  const notes = notesFromClaims(claims, heading);
  const changed = rejudge(check, notes);
  if (changed === null) return false;
  check.rescoredFrom = changed;
  check.pass = check.choice !== item.key;
  check.verdict = check.pass ? `key not entailed by the ${claims.length} ${heading} alone${check.lean === item.key ? ' (but leans to it)' : ''}` : `key is entailed by the ${heading} alone (${(check.entailment.find((e) => e.optionId === item.key)?.citedNotes ?? []).join(', ')})`;
  return changed;
}

/** Digest claims to re-judge against, or null when the store no longer holds the digest this build used. */
async function digestFor(build) {
  const ing = build.source?.sha ? await loadIngest(build.source.sha) : null;
  if (!ing || ing.stale) return null;
  const n = build.items.find((it) => it.verification?.digestRecall?.claims)?.verification.digestRecall.claims;
  if (n && ing.digest.claims.length !== n) return null;
  return ing.digest.claims;
}

export async function rescoreBuild(build) {
  const claims = await digestFor(build);
  const recs = claims?.filter((c) => c.type === 'recommendation') ?? null;
  const changes = [];
  const note = (id, what) => changes.push({ id, what });
  for (const it of build.items) {
    const v = it.verification; const tr = it.trace;
    if (!v || !tr?.item) continue;
    const item = tr.item;
    const pn = v.pathNecessity;
    if (pn?.picks) {
      for (const p of pn.picks) { const was = rejudge(p, notesFor(tr.artifacts, tr.path.slice(0, p.k))); if (was !== null) note(it.plan.id, `necessity k${p.k}: ${was} → ${p.choice}${p.override ? ` (${p.override.slice(0, 80)})` : ' (mis-cited quote re-attributed)'}`); }
      const first = pn.picks.find((p) => p.choice === item.key);
      const determinedAt = first ? first.k : null;
      if (determinedAt !== pn.determinedAt) note(it.plan.id, `necessity determinedAt ${pn.determinedAt} → ${determinedAt}`);
      Object.assign(pn, { determinedAt, leaksContained: pn.picks.filter((p) => p.override).length, pass: determinedAt === pn.pathLength,
        verdict: determinedAt === null ? 'key never determined from notes (item may be unanswerable from the path, or the key is not the terminal artifact)' : determinedAt === pn.pathLength ? 'key determinable only with the full path' : `key determinable after step ${determinedAt} of ${pn.pathLength} (steps ${tr.path.slice(determinedAt).map((s) => s.id).join(', ')} not necessary)` });
    }
    const dm = v.distractorMapping;
    if (dm?.perStep) {
      for (const p of dm.perStep) {
        if (!Array.isArray(p.entailment) || !p.downstream) continue;
        const before = p.picked;
        const j = judgePick({ choice: p.raw, entailment: p.entailment }, notesFor(p.downstream, tr.path));
        Object.assign(p, { picked: j.choice, override: j.override, citationsFixed: j.citationsFixed, keyBlocked: j.choice !== item.key, landed: p.expected.includes(j.choice !== UNDETERMINED ? j.choice : p.lean) });
        if (before !== p.picked) note(it.plan.id, `mapping ${p.step}: ${before} → ${p.picked}`);
      }
      dm.keyBlocked = dm.perStep.filter((p) => p.keyBlocked).length; dm.landed = dm.perStep.filter((p) => p.landed).length; dm.pass = dm.keyBlocked === dm.total;
    }
    if (rescoreRecallCheck(v.digestRecall, claims, item, 'claims')) note(it.plan.id, `digestRecall pick ${v.digestRecall.rescoredFrom} → ${v.digestRecall.choice} (${v.digestRecall.pass ? 'pass' : 'FAIL'})`);
    if (rescoreRecallCheck(v.sourceRecall, recs, item, 'recommendation claims')) note(it.plan.id, `sourceRecall pick ${v.sourceRecall.rescoredFrom} → ${v.sourceRecall.choice} (${v.sourceRecall.pass ? 'pass' : 'FAIL'})`);
    v.summary = summaryOf([
      ['grounding', v.grounding?.skipped ? null : v.grounding?.pass ?? null], ['coverTheOptions', v.coverTheOptions?.pass ?? null],
      ['sourceRecall', !v.sourceRecall || v.sourceRecall.skipped ? null : v.sourceRecall.pass], ['digestRecall', !v.digestRecall || v.digestRecall.skipped ? null : v.digestRecall.pass],
      ['pathNecessity', pn ? pn.pass : null], ['distractorMapping', dm ? dm.pass : null],
    ]);
  }
  for (const bl of build.baselines ?? []) {
    const v = bl.verification; const item = bl.trace?.item;
    if (!v || !item) continue;
    if (rescoreRecallCheck(v.digestRecall, claims, item, 'claims')) note(`${bl.plan.id} (single-shot)`, `digestRecall pick ${v.digestRecall.rescoredFrom} → ${v.digestRecall.choice} (${v.digestRecall.pass ? 'pass' : 'FAIL'})`);
    if (rescoreRecallCheck(v.sourceRecall, recs, item, 'recommendation claims')) note(`${bl.plan.id} (single-shot)`, `sourceRecall pick ${v.sourceRecall.rescoredFrom} → ${v.sourceRecall.choice} (${v.sourceRecall.pass ? 'pass' : 'FAIL'})`);
    v.summary = summaryOf([['grounding', v.grounding?.skipped ? null : v.grounding?.pass ?? null], ['coverTheOptions', v.coverTheOptions?.pass ?? null], ['sourceRecall', !v.sourceRecall || v.sourceRecall.skipped ? null : v.sourceRecall.pass], ['digestRecall', !v.digestRecall || v.digestRecall.skipped ? null : v.digestRecall.pass], ['form', v.form?.pass ?? null]]);
  }
  const rescored = { at: new Date().toISOString(), digestAvailable: Boolean(claims), changes };
  build.rescored = [...(build.rescored ?? []), rescored];
  return rescored;
}
