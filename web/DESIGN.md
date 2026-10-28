# cogpath console: design notes

Who it is for: physician item writers and exam committee chairs who compile board questions from published articles, and the reviewers who certify them. The primary job of every screen is to make the reasoning visible and the controls obvious.

## Tokens

Color means a step, a verdict, or nothing.

- Paper `#FBFBF9` (page), Card `#FFFFFF`, Ink `#15202B`, Muted `#5F6B76`, Rule `#DCE1E6`, Field `#F1F3F5`
- Steps, ascending Bloom, cool to warm: recall `#2F5FA8`, analyze `#0F8B8D`, evaluate `#C47F17`, synthesize `#7B3FA0`
- Verdicts: pass `#237A57`, fail `#B23A2E`, open `#8A94A0`
- Actions are ink on white or white on ink. There is no brand blue; the steps are the color.

Type: IBM Plex Sans for the interface. Source Serif 4 for exam text (stems, options, claims, spans), because that is what a printed item looks like and a reviewer reads it as one. IBM Plex Mono only for the path grammar and claim ids, which are the two things a user types in a grammar.

Layout: left aligned, 1120px maximum, 8px rhythm, two panes for review. Cards are flat and separated by rules; an item card carries a left rule in the hue of the step the item turns on.

## The signature element

The path glyph: a chain of step pills joined by short rules, each pill in its step's hue with its parameter beside the name. It appears large and editable on the home page and in the composer, compact in the builds list and item headers, and vertical in the walkthrough where each step opens to its artifact. The same shape everywhere teaches the grammar without a manual.

## Principles

1. Every rate shows its denominator and a plain-language meaning on hover.
2. Buttons say what happens: Certify item, Reject item, Launch build, Export certified items.
3. Reasoning is first-class: the walkthrough (recalled facts with their spans, the relations, the evaluation, the synthesis) is a tab beside the item, not raw JSON behind a fold.
4. The verifier is explained in questions: "Could the answer be found in the article's claims alone?"
5. No decoration: no gradients, no shadows except the PDF page, one radius for controls, no uppercase labels, no meta strings joined with dots.

## Checked against the defaults

Not a cream page with a serif display and a terracotta accent (paper is neutral; serif is used only where the subject is a printed item; the accent is ink). Not a card kit (flat, rule-separated, one radius, no shadows). No eyebrows, no dot-joined meta strings, no mono for small labels. Numbered steps appear only on the path, which is a sequence.
