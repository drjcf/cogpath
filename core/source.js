/**
 * Source loading. A source is the content the cognitive path operates on.
 *   .pdf        → uploaded once to the Files API (file_id reused across every call); text also extracted
 *                 locally (pdf-parse) for grounding checks and mock mode. With { inlineText: true } the
 *                 extracted text is sent inline instead of the file (cheaper; no page images).
 *   .md/.txt    → sent inline as input_text.
 *   { text }    → inline.
 * Returns { kind, title, path, sha, text, fileId, cacheKey, mode, parts } where `parts` is the stable prefix every
 * request starts with, `sha` keys the ingest store, and `cacheKey` routes all of this source's requests together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { uploadFile, part } from './meta.js';
import { renderDigest } from './ingest.js';

const sha256 = (x) => createHash('sha256').update(x).digest('hex');
const keyOf = (sha, suffix = '') => `cogpath:${sha.slice(0, 12)}${suffix}`;

export async function loadSource(input, { inlineText = false } = {}) {
  if (typeof input === 'object' && input !== null && typeof input.text === 'string') {
    const text = input.text.trim();
    const sha = sha256(text);
    return { kind: 'text', title: input.title || text.slice(0, 60), path: null, sha, text, pages: [{ num: 1, text }], fileId: null, cacheKey: keyOf(sha), mode: 'raw', parts: [part.text(`SOURCE${input.title ? ` (${input.title})` : ''}:\n${text}`)] };
  }
  const filePath = path.resolve(String(input));
  if (!fs.existsSync(filePath)) throw new Error(`Source not found: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  const title = path.basename(filePath, ext).replace(/[-_]+/g, ' ');
  const sha = sha256(fs.readFileSync(filePath));

  if (ext === '.pdf') {
    if (inlineText) {
      // Locally extracted text sent as input_text: no upload, no page images, plain-text token cost.
      const { text, pages } = await extractPdf(filePath);
      if (!text) throw new Error(`No text layer in ${filePath} (scanned PDF?); --inline-text needs extractable text`);
      return { kind: 'pdf-text', title, path: filePath, sha, text, pages, fileId: null, cacheKey: keyOf(sha, ':t'), mode: 'raw', parts: [part.text(`SOURCE (${title}):\n${text}`)] };
    }
    const [upload, { text, pages }] = await Promise.all([uploadFile(filePath), extractPdf(filePath)]);
    return { kind: 'pdf', title, path: filePath, sha, text, pages, fileId: upload.id, fileCached: upload.cached, cacheKey: keyOf(sha), mode: 'raw', parts: [part.file(upload.id)] };
  }
  if (['.md', '.markdown', '.txt', '.text'].includes(ext)) {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    return { kind: 'text', title: heading || title, path: filePath, sha, text, pages: [{ num: 1, text }], fileId: null, cacheKey: keyOf(sha), mode: 'raw', parts: [part.text(`SOURCE (${heading || title}):\n${text}`)] };
  }
  throw new Error(`Unsupported source type '${ext}'. Use .pdf, .md, or .txt`);
}

/**
 * A source rebuilt from the store (an ingested sha) when the original file is not at hand: the stored text
 * and pages stand in for the file, sent inline. Items can be built from an approved digest alone.
 */
export function sourceFromStore(ing) {
  const text = ing.text ?? '';
  const title = ing.meta.title || ing.digest.title || shortTitle(ing.meta.sha);
  return { kind: ing.meta.kind === 'pdf' ? 'pdf-text' : (ing.meta.kind ?? 'text'), title, path: ing.meta.path ?? null, sha: ing.meta.sha, text, pages: ing.pages ?? [{ num: 1, text }], fileId: null, cacheKey: keyOf(ing.meta.sha, ':t'), mode: 'raw', fromStore: true, parts: [part.text(`SOURCE (${title}):\n${text}`)] };
}
const shortTitle = (sha) => `source ${String(sha).slice(0, 12)}`;

/**
 * Narrow a digest-backed source to one item plan: the steps still see the whole digest, but the focus and
 * the reserved claims are stated, and the recall op is held to the reserved set.
 */
export function withFocus(source, plan, { usedConstraints = [] } = {}) {
  if (!plan) return source;
  const focus = { id: plan.id, focus: plan.focus, claims: [...(plan.claims ?? [])], usedConstraints: usedConstraints.map((u) => ({ item: u.item, feature: u.feature })) };
  const used = usedConstraints.length ? `\nCASE CONSTRAINTS ALREADY USED BY OTHER ITEMS FROM THIS SOURCE (this item's case must turn on a DIFFERENT feature):\n${usedConstraints.map((u) => `- ${u.item}: ${u.feature}`).join('\n')}` : '';
  const text = `ITEM FOCUS (${focus.id}): ${focus.focus}\nRESERVED CLAIMS for this item's recall step: ${focus.claims.join(', ') || '(none)'}. Other items built from this digest use the other claims; do not build this item's facts on them.${used}`;
  return { ...source, focus, parts: [...source.parts, part.text(text)] };
}

/**
 * Re-base a source on its digest. mode 'digest': calls see only the digest (cheap, provenance-checked);
 * 'both': raw source followed by the digest; 'raw': unchanged. `text` stays the raw extracted text so
 * grounding is always checked against the source itself, never against the digest.
 */
export function withDigest(source, digest, mode = 'digest') {
  if (mode === 'raw' || !digest) return { ...source, mode: 'raw', digest: null };
  const dpart = part.text(renderDigest(digest));
  if (mode === 'both') return { ...source, mode, digest, parts: [...source.parts, dpart] };
  if (mode === 'digest') return { ...source, mode, digest, cacheKey: keyOf(source.sha, ':d'), parts: [dpart] };
  throw new Error(`unknown source mode '${mode}' (raw | digest | both)`);
}

const cleanText = (t) => String(t ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2') // re-join words hyphenated across a line break (hema-\ntoma → hematoma)
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Remove running headers and footers: short lines that recur on many pages once digits are masked
 * (journal name, "Volume 146, Number 2", "Copyright © …", "-- 5 of 13 --", bare page numbers).
 */
export function stripRunningLines(pages) {
  if (pages.length < 3) return pages;
  const key = (line) => line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const counts = new Map();
  for (const pg of pages) {
    const seen = new Set();
    for (const line of pg.text.split('\n')) {
      const k = key(line);
      if (!k || k.length > 120 || seen.has(k)) continue;
      seen.add(k); counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  const running = new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
  return pages.map((pg) => ({ ...pg, text: pg.text.split('\n').filter((line) => { const k = key(line); return !(k && running.has(k)) && !/^\s*(--\s*\d+\s+of\s+\d+\s*--|\d{1,4})\s*$/.test(line); }).join('\n').replace(/\n{3,}/g, '\n\n').trim() }));
}

/** Whole text plus per-page text (page numbers are what a reviewer sees in the PDF viewer). The whole text is the cleaned pages joined, so the two agree. */
async function extractPdf(filePath) {
  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  try {
    const r = await parser.getText();
    const pages = stripRunningLines((r.pages ?? []).map((pg) => ({ num: pg.num, text: cleanText(pg.text) })));
    return { text: pages.length ? pages.map((pg) => pg.text).join('\n\n') : cleanText(r.text), pages };
  } catch (err) {
    console.warn(`[source] local PDF text extraction failed (${err.message}); grounding checks will be skipped`);
    return { text: '', pages: [] };
  } finally {
    await parser.destroy().catch(() => {});
  }
}
const extractPdfText = async (filePath) => (await extractPdf(filePath)).text;

export function wordCount(text) { const t = String(text ?? '').trim(); return t ? t.split(/\s+/).length : 0; }
