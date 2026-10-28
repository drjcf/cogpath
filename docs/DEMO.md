# Demo script (about 3 minutes)

Record the browser at 1400 wide. Server running (`npm run serve`), builds and sources already in `runs/`. Suggested build: `mvrvace5` (GCA arterial lesions, 0.5.1); suggested item: item4 (full pass, necessity k4, cover pass with a stem constraint the free answerer had to honor).

## 0:00 The claim (voice over the builds list, `#/builds`)

"A model asked for a question that requires analysis and synthesis writes one whose answer the article already states. cogpath makes the model execute the reasoning instead, one typed step at a time, and then tries to prove the question needs every step."

Point at the two digestRecall columns: path 19 of 20 keys not stated by the source; single-shot 6 of 20.

## 0:30 One article, once (`#/sources`, then Review on the GCA source)

Click two claims. The span highlights in the PDF. "Every claim is a verbatim span, located in the PDF, audited by a second pass, and certified by a person before any item is built on it."

Move between claims with `S` and `↑` (navigation only). Do not certify, reject, edit or approve anything on camera.

## 1:00 The item (`#/builds/<mvrvace5 id>`, item4, item tab)

Read the path line: `recall(4) > analyze(mechanism) > evaluate(accuracy, harm) > synthesize(interpretation guide)`.

Read the case constraint box: stage 4 kidney disease, eGFR 22, occlusion on MRA where CTA was patent. "The source does not cover this patient. The synthesize step had to adapt."

Point at the option tags: fails at recall, fails at analyze, fails at evaluate, fails at synthesize. "Each wrong answer is what a learner who failed at that step would choose."

## 1:40 The proof (verification tab)

pathNecessity: click k2, then k3, then k4. "With the facts and the relations only, the picker cannot determine the key. With the evaluation, still not. With the synthesis, it can, and here is the quoted evidence for each clause, re-checked locally."

distractorMapping: "Corrupt any one step, re-run the rest without the source, and the key is unreachable: 4 of 4."

coverTheOptions: open the free answer. "Asked to answer from the article with no options, bound by the scenario, the model lands on the key."

## 2:20 The control (single-shot tab)

"Same focus, same digest, one call, asked for an item requiring all four cognitive levels." Point at its digestRecall FAIL where present (item1, item2 or item5 of this build): "its key is a sentence from the article."

## 2:40 What it costs and what it does not do

Builds list, tokens column: "Five items with controls, about 150k tokens in, a third cached, 25 minutes, generation and verification."

"The verifier judges structure, not medicine. Two of twenty clean keys are clinically weak. The reviewer is still the last step, and the console shows them the evidence."

End on the builds list.

## Capture notes

- Keep every pane at default zoom; the evidence lists are the point and must be legible.
- Pause one second after each click; the necessity panel re-renders on each k.
- No approvals, rejections or edits on camera: the records in `runs/` are the submission's evidence.
