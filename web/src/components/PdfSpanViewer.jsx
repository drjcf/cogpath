/**
 * Renders the source PDF with pdf.js (via react-pdf) and highlights one verbatim span.
 *
 * The span is literal source text, so it is re-found at display time against the text layer pdf.js produces:
 * no stored offsets or boxes. Matching is done on a "squashed" form (lowercase, all whitespace removed) of the
 * whole page text, so a span that pdf.js chopped into several chunks, or split mid-word, still matches as one
 * range; the chunks overlapping that range are marked, partially when the range starts or ends inside a chunk.
 * When no page contains the whole span, it falls back to per-chunk substring matching (chunks that sit inside
 * the span), which still lands the eye on the right sentence.
 *
 * The text layer is invisible overlay text on top of the rendered canvas; the mark keeps its text transparent
 * and shows only a translucent background, so the highlight reads as paint over the real glyphs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import { api } from '../lib/api.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const squash = (s) => String(s ?? '').toLowerCase().replace(/[­]/g, '').replace(/\s+/g, '');
const normChunk = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** For one page's text items: squashed concatenation plus, per item, the map from squashed index to raw index. */
function indexPage(items) {
  const chunks = [];
  let pos = 0;
  for (const it of items) {
    const raw = String(it.str ?? '');
    const map = [];
    for (let i = 0; i < raw.length; i++) if (!/\s/.test(raw[i]) && raw[i] !== '­') map.push(i);
    const sq = squash(raw);
    chunks.push({ raw, sq, map, start: pos, end: pos + sq.length });
    pos += sq.length;
  }
  return { full: chunks.map((c) => c.sq).join(''), chunks };
}

/** Where the span lands on an indexed page: { start, end } in squashed coordinates, or null. */
function findRange(index, target) {
  if (!index || !target) return null;
  const i = index.full.indexOf(target);
  return i === -1 ? null : { start: i, end: i + target.length };
}

export default function PdfSpanViewer({ sha, highlight, page, width = 640 }) {
  const [file, setFile] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState('');
  const [pageIndex, setPageIndex] = useState({}); // pageNumber → indexPage()
  const wrapRef = useRef(null);

  useEffect(() => {
    let live = true;
    setFile(null); setNumPages(0); setPageIndex({}); setError('');
    api.pdfBytes(sha).then((bytes) => { if (live) setFile({ data: bytes }); }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [sha]);

  const target = useMemo(() => squash(highlight), [highlight]);
  const targetNorm = useMemo(() => normChunk(highlight), [highlight]);

  // The page to highlight on: the claim's own page if the span is there, else the first page where it is.
  const hit = useMemo(() => {
    if (!target) return null;
    const pages = Object.keys(pageIndex).map(Number).sort((a, b) => a - b);
    const ordered = page && pages.includes(page) ? [page, ...pages.filter((p) => p !== page)] : pages;
    for (const p of ordered) {
      const range = findRange(pageIndex[p], target);
      if (range) return { page: p, range, mode: 'whole' };
    }
    return pages.length ? { page: null, range: null, mode: 'chunks' } : null;
  }, [pageIndex, target, page]);

  const rendererFor = (pageNumber) => {
    if (!target) return undefined;
    const idx = pageIndex[pageNumber];
    return ({ str, itemIndex }) => {
      if (hit?.mode === 'whole') {
        if (hit.page !== pageNumber || !idx) return esc(str);
        const c = idx.chunks[itemIndex];
        if (!c || c.end <= hit.range.start || c.start >= hit.range.end) return esc(str);
        const from = Math.max(hit.range.start, c.start) - c.start, to = Math.min(hit.range.end, c.end) - c.start; // squashed, chunk-local
        const rawFrom = c.map[from] ?? 0, rawTo = (c.map[to - 1] ?? c.raw.length - 1) + 1;
        return `${esc(c.raw.slice(0, rawFrom))}<mark class="pdfhl">${esc(c.raw.slice(rawFrom, rawTo))}</mark>${esc(c.raw.slice(rawTo))}`;
      }
      // fallback: chunks that are substrings of the span (longer than 3 chars) light up
      const s = normChunk(str);
      return s.length > 3 && targetNorm.includes(s) ? `<mark class="pdfhl">${esc(str)}</mark>` : esc(str);
    };
  };

  // Scroll the first mark into view once pdf.js has painted the text layers.
  useEffect(() => {
    if (!target || !numPages) return undefined;
    const t = setTimeout(() => {
      const el = wrapRef.current?.querySelector('mark.pdfhl');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 450);
    return () => clearTimeout(t);
  }, [target, numPages, hit]);

  if (error) return <div className="viewer-msg">PDF not available: {error}</div>;
  if (!file) return <div className="viewer-msg">Loading PDF…</div>;
  return (
    <div className="pdfspan" ref={wrapRef} data-mode={hit?.mode ?? 'none'} data-hit-page={hit?.page ?? ''}>
      <Document file={file} onLoadSuccess={({ numPages: n }) => setNumPages(n)} onLoadError={(e) => setError(e.message)} loading={<div className="viewer-msg">Rendering…</div>}>
        {Array.from({ length: numPages }, (_, i) => (
          <Page
            key={i}
            pageNumber={i + 1}
            width={width}
            renderAnnotationLayer={false}
            customTextRenderer={rendererFor(i + 1)}
            onGetTextSuccess={(tc) => setPageIndex((prev) => (prev[i + 1] ? prev : { ...prev, [i + 1]: indexPage(tc.items ?? []) }))}
          />
        ))}
      </Document>
    </div>
  );
}
