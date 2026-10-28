/**
 * Entailment helpers shared by the verifier and by in-loop op checks. No dependency on the executor or the ops,
 * so an op may import this without a cycle.
 */
import { obj, arr, str, bool, assertStrict } from './schema.js';
import { complete, part } from './meta.js';
import { spanFound, clauseSupported, NOTE_SUPPORT_FRACTION } from './textmatch.js';

export function notesFromClaims(claims, heading) {
  const byId = new Map(claims.map((a) => [a.id, JSON.stringify({ id: a.id, statement: a.statement, quote: a.span })]));
  return { text: `NOTES (${heading}; the only material you may use):\n\n${claims.map((a) => `${a.id}: ${a.statement}\n    "${a.span}"`).join('\n')}`, ids: new Set(byId.keys()), textOf: (id) => byId.get(id) ?? '' };
}

/**
 * Is a free-standing statement fully entailed by a set of notes? Same discipline as the option picker: per-clause
 * quotes that must exist in the cited note and share content with the clause. Used in-loop by the synthesize
 * step to refuse a plan the source's recommendations already state.
 */
export async function entailedByNotes({ statement, notes, model, label, mockEntailed = false }) {
  const schema = assertStrict(obj({
    fullyEntailed: bool('true only if EVERY clause of the statement is stated or strictly implied by the notes'),
    evidence: arr(obj({ clause: str('A clause of the statement, in its own words'), noteId: str('The note id that entails this clause'), quote: str('VERBATIM text copied from that note (≤ 25 words)') }), 'One entry per clause when fully entailed; empty otherwise'),
    missingClause: str('The first clause the notes do not establish; empty if fully entailed'),
  }));
  const res = await complete({
    instructions: 'You decide entailment strictly and use no knowledge outside the NOTES. A statement is fully entailed only if every clause of it is stated or strictly implied by the notes; cite the note ids and quote them verbatim.',
    parts: [part.text(`STATEMENT:\n${statement}`), part.text(notes.text), part.text('Is the STATEMENT fully entailed by the NOTES? Quote the note text that establishes each clause.')],
    schema, schemaName: 'entailment', effort: 'low', model, label, maxOutputTokens: 4096, cacheKey: 'cogpath:verify',
    mock: () => ({ fullyEntailed: mockEntailed, evidence: [], missingClause: mockEntailed ? '' : '[MOCK] clause' }),
  });
  const j = res.json;
  let entailed = Boolean(j.fullyEntailed);
  let why = '';
  if (entailed && !res.mock) {
    if (!(j.evidence ?? []).length) { entailed = false; why = 'no quoted evidence'; }
    else {
      // Same discipline as the option picker (verifier.judgePick): the quote must occur in some note (the cited one or
      // another), and must bear on its clause, or the notes as a whole must carry at least half of the clause's content.
      const ids = [...notes.ids];
      const allNotes = ids.map((id) => notes.textOf(id)).join('\n');
      const bad = j.evidence.filter((ev) => {
        const inSome = (notes.ids.has(ev.noteId) && spanFound(ev.quote, notes.textOf(ev.noteId)).found) || ids.some((id) => spanFound(ev.quote, notes.textOf(id)).found);
        return !inSome || !(clauseSupported(ev.clause, ev.quote) || clauseSupported(ev.clause, allNotes, NOTE_SUPPORT_FRACTION));
      });
      if (bad.length) { entailed = false; why = 'evidence not verified'; }
    }
  }
  return { entailed, missingClause: j.missingClause, evidence: j.evidence ?? [], citedNotes: [...new Set((j.evidence ?? []).map((e) => e.noteId))], why, usage: res.usage };
}

