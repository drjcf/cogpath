/**
 * For sources that are text (markdown, txt, or a PDF without a stored copy): renders the extracted text and
 * wraps the verbatim span in a mark. We own the DOM here, so the whole span is matched across any boundary
 * (lowercase, whitespace collapsed) and mapped back to the original characters.
 */
import { useEffect, useMemo, useRef } from 'react';

function normalizeWithMap(raw) {
  // lowercase + collapse whitespace runs to one space; map[i] = index in raw of normalized char i
  let out = '';
  const map = [];
  let inWs = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) { if (!inWs && out.length) { out += ' '; map.push(i); } inWs = true; continue; }
    inWs = false;
    out += ch.toLowerCase();
    map.push(i);
  }
  return { norm: out, map };
}

export default function TextSpanViewer({ text, highlight }) {
  const ref = useRef(null);
  const { norm, map } = useMemo(() => normalizeWithMap(text ?? ''), [text]);
  const parts = useMemo(() => {
    const target = String(highlight ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!target) return [{ t: text }];
    let i = norm.indexOf(target);
    if (i === -1) {
      // fuzzy: first 6 words of the span
      const head = target.split(' ').slice(0, 6).join(' ');
      i = head.length > 12 ? norm.indexOf(head) : -1;
      if (i === -1) return [{ t: text }];
      const a = map[i], b = map[Math.min(i + head.length, map.length) - 1] + 1;
      return [{ t: text.slice(0, a) }, { t: text.slice(a, b), mark: true }, { t: text.slice(b) }];
    }
    const a = map[i], b = map[Math.min(i + target.length, map.length) - 1] + 1;
    return [{ t: text.slice(0, a) }, { t: text.slice(a, b), mark: true }, { t: text.slice(b) }];
  }, [norm, map, text, highlight]);

  useEffect(() => {
    const el = ref.current?.querySelector('mark.txthl');
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [parts]);

  return (
    <div className="textspan" ref={ref}>
      <pre>{parts.map((p, i) => (p.mark ? <mark key={i} className="txthl">{p.t}</mark> : <span key={i}>{p.t}</span>))}</pre>
    </div>
  );
}
