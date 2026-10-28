/** Text matching shared by the verifier and the ops: normalization and fuzzy verbatim-span lookup. */
export const norm = (s) => String(s).toLowerCase().replace(/[“”"'’‘]/g, '').replace(/[^a-z0-9%.\-\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Is `span` in `text`? Exact after normalization, or at least half of its 4-word windows found verbatim. */
export function spanFound(span, text) {
  const t = norm(text), s = norm(span);
  if (!s) return { found: false, ratio: 0 };
  if (t.includes(s)) return { found: true, ratio: 1 };
  const words = s.split(' ');
  if (words.length < 4) return { found: false, ratio: 0 };
  let hits = 0, total = 0;
  for (let i = 0; i + 4 <= words.length; i++) { total++; if (t.includes(words.slice(i, i + 4).join(' '))) hits++; }
  const ratio = total ? hits / total : 0;
  return { found: ratio >= 0.5, ratio };
}

/**
 * norm() with a map back to the original string: normalized[i] came from raw[map[i]]. Lets a match found in
 * normalized text be shown or sliced in the original (punctuation, symbols, and case intact).
 */
export function normWithMap(raw) {
  const src = String(raw);
  let out = '';
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < src.length; i++) {
    let ch = src[i].toLowerCase();
    if ('“”"\'’‘'.includes(ch)) continue;
    if (!/[a-z0-9%.\-\s]/.test(ch)) ch = ' ';
    if (/\s/.test(ch)) { pendingSpace = out.length > 0; continue; }
    if (pendingSpace) { out += ' '; map.push(i); pendingSpace = false; }
    out += ch; map.push(i);
  }
  return { norm: out, map };
}

/**
 * Locate `span` in `text` and return the ORIGINAL text around it: { passage, start, end } where start/end
 * are offsets of the matched span inside `passage`. Exact normalized match first, then from the first found
 * 4-word window to the last. Returns null when the span cannot be placed.
 */
export function locateInText(span, text, chars = 350) {
  const { norm: t, map } = normWithMap(text);
  const s = norm(span);
  if (!s || !t) return null;
  let idx = t.indexOf(s), len = s.length;
  if (idx === -1) {
    const words = s.split(' ');
    let first = -1, last = -1;
    for (let i = 0; i + 4 <= words.length; i++) {
      const w = words.slice(i, i + 4).join(' ');
      const j = t.indexOf(w);
      if (j !== -1) { if (first === -1) first = j; last = j + w.length; }
    }
    if (first === -1) return null;
    idx = first; len = Math.max(last - first, 1);
  }
  const rawStart = map[idx], rawEnd = (map[Math.min(idx + len, map.length) - 1] ?? map[map.length - 1]) + 1;
  const a = Math.max(0, rawStart - chars), b = Math.min(String(text).length, rawEnd + chars);
  return { passage: String(text).slice(a, b), start: rawStart - a, end: rawEnd - a, before: a > 0, after: b < String(text).length };
}

/**
 * Does a sentence tell someone what to do? Modal prescriptions, imperative openers, agent-plus-modal
 * ("the surgeon should/cannot/must"), and standing prohibitions. Used to keep decisions out of the artifacts
 * of steps that are supposed to explain, not decide.
 */
const IMPERATIVES = 'stay|stage|avoid|consider|inject|place|use|perform|obtain|counsel|defer|decline|schedule|require|keep|limit|choose|select|restrict|discuss|explain|present|document|monitor|retain|prefer|proceed|stop|start|give|administer|withhold|offer|recommend|advise|ensure|confirm|verify|treat|manage|refer|order|check|apply|hold|continue|discontinue|switch|reduce|increase|add|remove|repeat|reassess|cap|respect|prioritize|weigh|do not|don\'t|never|always';
export const ACTION_LEAK = new RegExp(`(^\\s*(?:${IMPERATIVES})\\b)|\\b(should|must|ought to|needs? to|has to|have to|is (?:indicated|recommended|required|preferred|advised|warranted|mandatory)|are (?:indicated|recommended|required|preferred|advised)|(?:surgeon|clinician|practitioner|physician|one|provider|team)s? (?:should|must|cannot|can|may|needs? to|ought to|has to|have to)|rather than (?:placing|injecting|proceeding|accepting|using))\\b`, 'i');

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'that', 'this', 'than', 'then', 'into', 'over', 'under', 'after', 'before', 'while', 'when', 'where', 'which', 'who', 'whom', 'whose', 'what', 'about', 'above', 'below', 'between', 'through', 'during', 'without', 'within', 'only', 'also', 'both', 'each', 'every', 'more', 'most', 'less', 'least', 'very', 'such', 'same', 'other', 'another', 'some', 'any', 'all', 'not', 'rather', 'later', 'first', 'second', 'third', 'their', 'there', 'these', 'those', 'they', 'them', 'will', 'would', 'could', 'should', 'must', 'shall', 'being', 'been', 'have', 'has', 'had', 'does', 'did', 'done', 'were', 'was', 'are', 'is', 'be', 'by', 'as', 'at', 'it', 'its', 'if', 'so', 'no', 'nor', 'but', 'yet', 'per', 'via', 'until', 'unless', 'because', 'since', 'thus', 'therefore', 'here', 'now', 'well', 'just', 'still', 'even', 'much', 'many', 'own', 'off', 'out', 'up', 'down', 'again', 'once', 'cannot', 'could', 'alone', 'basis', 'these', 'specific', 'patient', 'case', 'plan', 'option', 'approach', 'strategy', 'session', 'operation', 'procedure']);
// Content words: 4+ letters outside the stoplist, plus any token carrying a digit (figures, P values, ratios are content).
const contentWords = (t) => norm(t).split(/[\s-]+/).map((w) => w.replace(/^[.,;:]+|[.,;:]+$/g, '')).filter((w) => /\d/.test(w) || (w.length >= 4 && !STOP.has(w)));
const stem5 = (w) => w.slice(0, 5);

/**
 * Does `quote` lexically support `clause`? Content words of the clause (≥ 4 letters outside the stoplist, or any token
 * with a digit) are matched in the quote on a 5-letter prefix so inflections count. A quote that shares no content
 * word with the clause cannot be its evidence, whatever the picker claims; a long clause needs two shared words.
 */
export function clauseSupported(clause, quote, minFraction = 0) {
  const cw = contentWords(clause);
  if (!cw.length) return true;
  const qw = contentWords(quote);
  const same = (a, b) => a === b || (!/\d/.test(a) && !/\d/.test(b) && (stem5(a) === stem5(b) || (a.length >= 5 && b.length >= 5 && a.slice(0, 4) === b.slice(0, 4)) || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)))));
  const hits = cw.filter((w) => qw.some((q) => same(w, q))).length;
  // Default (a short quote chosen for the clause): one shared content word for a clause of up to three, two beyond that.
  // With a fraction (a whole note or all notes at a depth, where one shared word is chance): that share of the clause's words.
  const need = minFraction > 0 ? Math.max(1, Math.ceil(cw.length * minFraction)) : (cw.length <= 3 ? 1 : 2);
  return hits >= need;
}

/** Share of a clause's content words a whole note (or every note at a depth) must carry to count as support. */
export const NOTE_SUPPORT_FRACTION = 0.5;
