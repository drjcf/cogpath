/**
 * INGEST: process a source once into a DIGEST of verbatim-grounded claims, stored for reuse across every item
 * built from that source. Items then run over the digest (a few thousand tokens) instead of the raw article
 * (12k inline, ~38k as an uploaded file), and every item fact carries a provenance chain:
 *   item option → recall concept → claim id → verbatim span → sentence in the PDF text.
 *
 * Each claim's span is checked locally against the extracted text; claims whose span is not found are dropped
 * (and the model is asked once to repair them), so nothing enters the digest that cannot be located in the source.
 */
import { obj, arr, str, enm, bool, assertStrict, validate } from './schema.js';
import { complete, part } from './meta.js';
import { spanFound, norm, locateInText } from './textmatch.js';
import { PREAMBLE } from './executor.js';

export const CLAIM_TYPES = ['background', 'method', 'result', 'interpretation', 'limitation', 'recommendation'];

/** Default number of claims to extract for a source of `words` words: about one per 150 words, between 12 and 80. */
export function defaultClaimCount(words) { return Math.max(12, Math.min(80, Math.round((Number(words) || 0) / 150))); }
export const SECTIONS = ['abstract', 'introduction', 'methods', 'results', 'discussion', 'table_or_figure', 'other'];
export const ATTRIBUTIONS = ['this_work', 'cited_work', 'general_knowledge'];
export const AUDIT_ISSUES = ['none', 'number', 'direction', 'population', 'attribution', 'type', 'overclaim', 'unsupported'];

export const DIGEST_SCHEMA = assertStrict(obj({
  title: str('Title of the work, as a learner would cite it'),
  topic: str('Short label for the subject (≤ 8 words)'),
  claims: arr(obj({
    id: str('cl1, cl2, … in reading order'),
    type: enm(CLAIM_TYPES, 'background: established knowledge restated; method: what was done; result: a finding with its numbers; interpretation: the authors\' explanation or causal claim; limitation; recommendation: any prescriptive statement (what should be done)'),
    statement: str('One self-contained claim in the learner\'s terms, with the numbers when there are numbers; no reference to "the article" or "the authors"'),
    span: str('Verbatim quotation (≤ 40 words) copied exactly from the source that supports the statement'),
    section: enm(SECTIONS),
    attribution: enm(ATTRIBUTIONS, 'this_work: a finding, method, or conclusion of this work about its own data; cited_work: a figure or claim this work reports from other studies (common in introductions and discussions); general_knowledge: background not tied to a study'),
    importance: str('Why a learner would need this claim (one short sentence)'),
  }), 'Distinct claims covering the whole source; no two supported by the same sentence'),
}));

export function ingestInstruction({ title, maxClaims }) {
  return `Break this source into CLAIMS for assessment design. Produce between ${Math.max(8, Math.round(maxClaims / 2))} and ${maxClaims} claims (as many as the content warrants, not more).

Rules:
- Cover the whole source: every result that carries a number, every causal or mechanistic claim, every stated limitation, and every recommendation. Background only where a downstream reasoner would need it.
- Each claim is one statement. Its span is copied VERBATIM from the source (at most 40 words, no paraphrase, no ellipsis). The statement restates the claim in a learner's terms and keeps the numbers.
- Claims are distinct: no two may rest on the same sentence, and no finding appears twice. The abstract restates the body: take each finding from the body (methods, results, discussion) where it carries its full detail, and extract from the abstract only what the body does not state.
- Recommendations are never optional: every prescriptive statement in the discussion or conclusion (a numbered or bulleted list of technique recommendations, "should", "must", "avoid", "consider") becomes its own claim, one per statement, even if that means fewer result claims. A digest that omits a recommendation the source makes is incomplete.
- Type every prescriptive statement (should, must, is recommended, is the treatment of choice, avoid, never) as "recommendation", even when it appears inside results or discussion.
- Attribute carefully: a figure the introduction or discussion reports from an earlier study is cited_work, not a result of this work, even if it is a number. Only findings about this work's own data are this_work.
- Every number in a statement must appear in its span or in the sentences immediately around it; never compute, round, or infer a number.
- Never refer to "the article", "the study", "the authors", or "the text" in a statement.
Title hint: ${title}.`;
}

function renderClaim(a) { return `${a.id} [${a.type}; ${a.attribution ?? 'unattributed'}; ${a.section}] ${a.statement}\n    "${a.span}"`; }

/** Figures (two or more digits, or any figure with a -fold or % suffix) mentioned in a text. */
export function figuresIn(text) {
  return [...new Set((String(text).match(/\d[\d,]*(?:\.\d+)?(?:-fold|%)?/g) ?? []).filter((n) => /-fold|%/.test(n) || n.replace(/\D/g, '').length >= 2))];
}

/** The normalized source passage around a span (± `chars` characters), or '' when the span cannot be located. */
export function passageAround(span, text, chars = 700) {
  const t = norm(text), s = norm(span);
  if (!s) return '';
  let idx = t.indexOf(s);
  if (idx === -1) {
    const words = s.split(' ');
    for (let i = 0; i + 4 <= words.length && idx === -1; i++) idx = t.indexOf(words.slice(i, i + 4).join(' '));
  }
  if (idx === -1) return '';
  return t.slice(Math.max(0, idx - chars), Math.min(t.length, idx + s.length + chars));
}

/** The digest as the stable source prefix for every call made over it. */
export function renderDigest(digest) {
  return `SOURCE DIGEST (${digest.title}; topic: ${digest.topic}): ${digest.claims.length} claims, each with its verbatim supporting quotation from the source. Treat the quotations as the source text: when a field asks for a verbatim span, copy it from a claim's quotation. Claims typed "recommendation" are prescriptive statements, not premises. Attribution "cited_work" marks claims this work reports from other studies; "this_work" marks its own findings.\n\n${digest.claims.map(renderClaim).join('\n')}`;
}

/** Page number (1-based) on which a span is found, or null. Exact normalized match first, then the best fuzzy page. */
export function locateSpan(span, pages) {
  if (!Array.isArray(pages) || !pages.length) return null;
  let best = null;
  for (const pg of pages) {
    const r = spanFound(span, pg.text);
    if (r.ratio === 1) return pg.num;
    if (r.found && (!best || r.ratio > best.ratio)) best = { num: pg.num, ratio: r.ratio };
  }
  if (best) return best.num;
  // A span that crosses a page break is found in no single page; try adjacent pairs and report the first page.
  for (let i = 0; i + 1 < pages.length; i++) {
    if (spanFound(span, `${pages[i].text}\n${pages[i + 1].text}`).found) return pages[i].num;
  }
  return null;
}

const RECS_SCHEMA = assertStrict(obj({
  claims: arr(obj({
    statement: str('One prescriptive statement in the learner\'s terms (what should or should not be done)'),
    span: str('Verbatim quotation (≤ 40 words) copied exactly from the source'),
    section: enm(SECTIONS),
    attribution: enm(ATTRIBUTIONS),
    importance: str('Why a learner would need this recommendation (one short sentence)'),
  }), 'Every prescriptive statement in the source, one claim each; empty if the source makes none'),
}));

/** Is `span` already covered by one of `claims` (≥ 50% of its 4-word windows inside an existing span)? */
export function spanCovered(span, claims) {
  return claims.some((c) => spanFound(span, c.span).found || spanFound(c.span, span).found);
}

/**
 * A second, cheap pass that lists EVERY prescriptive statement in the source as a recommendation claim and
 * merges the ones the main pass missed. Recommendations are the claim type that sourceRecall and the
 * synthesize step depend on, so their coverage is not left to one call's budget.
 */
export async function recommendationsPass(source, digest, { model, label = 'ingest:recs' } = {}) {
  const res = await complete({
    instructions: PREAMBLE,
    parts: [...source.parts, part.text(`List EVERY prescriptive statement this source makes (recommendations, technique rules, "should", "must", "avoid", "never", "consider"), one claim each, in reading order. Quote each verbatim in span (at most 40 words, no paraphrase). Do not include findings, mechanisms, or background. If the source makes no recommendations, return an empty list.`)],
    schema: RECS_SCHEMA, schemaName: 'recommendations', effort: 'low', model, maxOutputTokens: 8192, label, cacheKey: source.cacheKey,
    mock: () => ({ claims: [] }),
  });
  const v = validate(RECS_SCHEMA, res.json);
  if (!v.ok) return { added: [], rejected: [], usage: res.usage, ms: res.ms, problems: v.errors };
  let next = Math.max(0, ...digest.claims.map((c) => Number(c.id.replace(/\D/g, '')) || 0)) + 1;
  const added = [], rejected = [];
  let claims = [...digest.claims];
  for (const r of res.json.claims) {
    if (spanCovered(r.span, claims)) continue; // the main pass already has it
    const claim = { id: `cl${next}`, type: 'recommendation', statement: r.statement, span: r.span, section: r.section, attribution: r.attribution, importance: r.importance, fromRecommendationsPass: true };
    const chk = checkDigest({ ...digest, claims: [...claims, claim] }, source.text);
    const mine = chk.problems.find((p) => p.id === claim.id);
    if (mine) { rejected.push({ id: claim.id, statement: r.statement, reasons: mine.reasons }); continue; }
    claims.push(claim); added.push(claim); next++;
  }
  return { digest: { ...digest, claims }, added, rejected, usage: res.usage, ms: res.ms, problems: [] };
}

/** Attach `page` to every claim (null when the span cannot be placed). */
export function locateClaims(digest, pages) {
  return { ...digest, claims: digest.claims.map((c) => ({ ...c, page: locateSpan(c.span, pages) })) };
}

/**
 * The passage around a claim's span for a reviewer, with the span marked »like this«: the ORIGINAL text of
 * the page (case, punctuation, and symbols intact), `chars` on each side; located by normalized matching.
 */
export function reviewPassage(claim, pages, text, chars = 350) {
  const pg = claim.page != null ? pages?.find((p) => p.num === claim.page) : null;
  const loc = locateInText(claim.span, pg ? pg.text : text, chars) ?? (pg ? locateInText(claim.span, text, chars) : null);
  if (!loc) return '';
  const p = loc.passage.replace(/\s+/g, ' ');
  // re-locate after whitespace collapse: offsets shift, so mark by re-finding the matched raw slice
  const matched = loc.passage.slice(loc.start, loc.end).replace(/\s+/g, ' ');
  const i = p.indexOf(matched);
  const body = i === -1 ? p : `${p.slice(0, i)}»${matched}«${p.slice(i + matched.length)}`;
  return `${loc.before ? '… ' : ''}${body}${loc.after ? ' …' : ''}`;
}

/** Local checks: spans must be found in the raw text, claims must be distinct, statements must not cite the source. */
export function checkDigest(digest, rawText) {
  const problems = [];
  const keep = [];
  const seenSpans = new Set();
  for (const a of digest.claims) {
    const reasons = [];
    if (rawText && !spanFound(a.span, rawText).found) reasons.push('span not found in the source text');
    if (a.span.trim().split(/\s+/).length > 60) reasons.push('span longer than 60 words');
    const key = a.span.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenSpans.has(key)) reasons.push('duplicate span');
    seenSpans.add(key);
    if (/\b(the (article|study|text|passage|paper|authors))\b/i.test(a.statement)) reasons.push('statement refers to the source');
    // Every figure in the statement must be present in the span or the passage around it (no computed or recalled numbers).
    if (rawText) {
      const passage = passageAround(a.span, rawText) || norm(a.span);
      const missing = figuresIn(a.statement).filter((f) => !passage.includes(norm(f)));
      if (missing.length) reasons.push(`figure(s) ${missing.join(', ')} in the statement are not in the source near the span`);
    }
    if (reasons.length) problems.push({ id: a.id, reasons });
    else keep.push(a);
  }
  return { problems, claims: keep };
}

/**
 * Run the ingest call over a raw source. Returns { digest, dropped, usage, ms, attempts, model, mock }.
 * `digest.claims` holds only claims that passed the local checks. `maxClaims` defaults to defaultClaimCount(words).
 */
export async function ingestSource(source, { model, maxClaims, effort = 'medium', label = 'ingest' } = {}) {
  maxClaims = maxClaims ?? defaultClaimCount(source.text ? source.text.trim().split(/\s+/).length : 0);
  const instruction = ingestInstruction({ title: source.title, maxClaims });
  const attempts = [];
  let feedback = '';
  let best = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await complete({
      instructions: PREAMBLE,
      parts: [...source.parts, part.text(instruction + feedback)],
      schema: DIGEST_SCHEMA, schemaName: 'digest', effort, model, maxOutputTokens: 32768, summary: 'auto', label: `${label}:${attempt}`, cacheKey: source.cacheKey,
      mock: () => mockDigest(source, maxClaims),
    });
    const v = validate(DIGEST_SCHEMA, res.json);
    const schemaProblems = v.ok ? [] : v.errors.map((e) => `schema: ${e}`);
    const { problems, claims } = v.ok ? checkDigest(res.json, source.text) : { problems: [], claims: [] };
    attempts.push({ attempt, usage: res.usage, ms: res.ms, claims: claims.length, dropped: problems, schemaProblems, notes: res.notes });
    const candidate = { digest: v.ok ? { ...res.json, claims } : null, dropped: problems, usage: res.usage, ms: res.ms, reasoningSummary: res.reasoningSummary, mock: res.mock, model: res.model };
    if (!best || (candidate.digest && candidate.digest.claims.length > (best.digest?.claims.length ?? 0))) best = candidate;
    const tooFew = (candidate.digest?.claims.length ?? 0) < Math.max(8, Math.round(maxClaims / 2));
    if (res.mock || (schemaProblems.length === 0 && problems.length === 0 && !tooFew)) break;
    feedback = `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED; FIX ALL OF THESE AND RETURN THE COMPLETE DIGEST:\n- ${[...schemaProblems, ...problems.map((p) => `${p.id}: ${p.reasons.join(', ')} (quote the source EXACTLY)`), ...(tooFew ? ['too few claims survived the checks'] : [])].join('\n- ')}`;
  }
  if (!best?.digest) throw new Error(`ingest produced no valid digest: ${JSON.stringify(attempts.at(-1)?.schemaProblems ?? [])}`);
  best.digest = locateClaims(best.digest, source.pages);
  const totals = attempts.reduce((u, a) => ({ input_tokens: u.input_tokens + (a.usage?.input_tokens ?? 0), output_tokens: u.output_tokens + (a.usage?.output_tokens ?? 0), cached_tokens: u.cached_tokens + (a.usage?.cached_tokens ?? 0), reasoning_tokens: u.reasoning_tokens + (a.usage?.reasoning_tokens ?? 0), ms: u.ms + (a.ms ?? 0), calls: u.calls + 1 }), { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, ms: 0, calls: 0 });
  return { ...best, attempts, totals, maxClaims };
}

// ─── audit: an independent reader checks each claim against the passage it came from ───

const AUDIT_SCHEMA = assertStrict(obj({
  findings: arr(obj({
    id: str('claim id'),
    supported: bool('true only if the statement, its type, and its attribution are all correct for the passage'),
    issue: enm(AUDIT_ISSUES, 'The most serious problem, or none'),
    correctedType: enm(['none', ...CLAIM_TYPES], 'When the issue is type: the type the passage supports; otherwise none'),
    correctedAttribution: enm(['none', ...ATTRIBUTIONS], 'When the issue is attribution: the attribution the passage supports; otherwise none'),
    note: str('What is wrong and what the passage actually says (one sentence); empty when supported'),
  }), 'One finding per claim, in the order given'),
}));

/** Label problems are repaired in place; content problems remove the claim. */
export const AUDIT_REPAIRABLE = new Set(['type', 'attribution']);

/**
 * Audit a digest: for each claim, a separate low-effort call that has NOT seen the ingest reasoning gets only the
 * claim and the source passage around its span, and judges whether the statement, type, and attribution are
 * faithful to that passage. Returns { findings, flagged, usage }.
 */
export async function auditDigest(digest, rawText, { model, batch = 10, label = 'audit' } = {}) {
  const findings = [];
  const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, calls: 0, ms: 0 };
  for (let i = 0; i < digest.claims.length; i += batch) {
    const claims = digest.claims.slice(i, i + batch);
    const block = claims.map((a) => `CLAIM ${a.id}\n  type: ${a.type}\n  attribution: ${a.attribution ?? 'unattributed'}\n  statement: ${a.statement}\n  passage: "${(locateInText(a.span, rawText, 900)?.passage ?? a.span).replace(/\s+/g, ' ')}"`).join('\n\n');
    const res = await complete({
      instructions: 'You audit extracted claims against the passage they were taken from. You have no other knowledge of the document. Judge strictly: a wrong number, a reversed direction, the wrong population, a figure from another study presented as this work\'s own finding (attribution), a prescriptive statement typed as anything but recommendation (type), or a claim stronger than the passage (overclaim) all make the claim unsupported.',
      parts: [part.text(`${block}\n\nFor each claim, decide whether statement, type, and attribution are faithful to its passage. Attribution rule: this_work only when the passage reports the document's own data or conclusions; cited_work when the passage reports another study's figure or claim (citations, "previously reported", "in a prior survey", other authors' results); general_knowledge for background.`)],
      schema: AUDIT_SCHEMA, schemaName: 'digest_audit', effort: 'low', model, maxOutputTokens: 8192, label: `${label}:${i / batch + 1}`,
      mock: () => ({ findings: claims.map((a) => ({ id: a.id, supported: true, issue: 'none', correctedType: 'none', correctedAttribution: 'none', note: '' })) }),
    });
    for (const f of res.json.findings) if (claims.some((a) => a.id === f.id)) findings.push(f);
    usage.input_tokens += res.usage.input_tokens; usage.output_tokens += res.usage.output_tokens; usage.cached_tokens += res.usage.cached_tokens; usage.reasoning_tokens += res.usage.reasoning_tokens; usage.calls++; usage.ms += res.ms;
  }
  const unsupported = findings.filter((f) => !f.supported);
  // A label disagreement is repaired (the claim is kept with the auditor's label); anything else removes the claim.
  const repaired = unsupported.filter((f) => AUDIT_REPAIRABLE.has(f.issue) && ((f.issue === 'type' && CLAIM_TYPES.includes(f.correctedType)) || (f.issue === 'attribution' && ATTRIBUTIONS.includes(f.correctedAttribution))));
  const flagged = unsupported.filter((f) => !repaired.includes(f));
  return { findings, flagged, repaired, usage };
}

/** Apply an audit's repairs to a digest: returns the digest with corrected labels and `auditFix` records on the claims touched. */
export function applyAuditRepairs(digest, repaired) {
  if (!repaired?.length) return digest;
  const byId = new Map(repaired.map((f) => [f.id, f]));
  return { ...digest, claims: digest.claims.map((c) => {
    const f = byId.get(c.id);
    if (!f) return c;
    const fix = f.issue === 'type' ? { field: 'type', before: c.type, after: f.correctedType } : { field: 'attribution', before: c.attribution, after: f.correctedAttribution };
    return { ...c, [fix.field]: fix.after, auditFix: { ...fix, note: f.note } };
  }) };
}

function mockDigest(source, maxClaims) {
  const sentences = String(source.text ?? '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 6);
  const n = Math.min(maxClaims, Math.max(8, Math.min(sentences.length, 16)));
  const claims = Array.from({ length: n }, (_, i) => {
    const sent = sentences[i % Math.max(1, sentences.length)] ?? `[MOCK] sentence ${i + 1}`;
    const span = sent.split(/\s+/).slice(0, 30).join(' ');
    return { id: `cl${i + 1}`, type: CLAIM_TYPES[i % 4], statement: `[MOCK] claim: ${span}`, span, section: SECTIONS[i % SECTIONS.length], attribution: ATTRIBUTIONS[i % 3], importance: '[MOCK] needed downstream' };
  });
  return { title: source.title || 'Mock source', topic: 'mock topic', claims };
}
