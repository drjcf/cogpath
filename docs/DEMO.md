# Demo video: 3 minutes, on the live app

The video is the primary judging artifact (rubric: Impact 30, Meta AI tooling 25, Demo 25, Technical depth 20). Hard cap 3:00. The script is 459 words: at 165 words a minute it runs about 2:53, at 150 about 3:07, over the cap. Record at a brisk, even pace, and if the take runs long cut the 1:25 walkthrough shot first (29 words); the times below assume 165. The first 34 seconds are the opening animation (`docs/video/intro.mp4`, see the last section); the rest is screen capture of https://cogpath.org at 1400 wide, signed in. Voice-over recorded separately and laid over both. No music, no slides except the end card, captions on.

Prepare before recording: the Oct 28 GCA build (41 claims) open in a second tab at item 1, the Review console of that article open in a third tab, the Items bank with at least the certified items from that build. Navigation only on camera: no decisions, no approvals, no launches.

## Shot list and voice-over

### 0:00 Opening animation (docs/video/intro.mp4, no screen capture)

On screen: the old flow (source article, item writer, review committee, revision loop, hours and weeks), then a model given one prompt whose key is a sentence the source already states, then EdAI Systems, then the path glyph with an artifact and a check per step, ending on the cogpath wordmark and cogpath.org.

VO: "Writing a high-stakes board exam question is slow, expert work. An item that assesses competency rather than memory takes a specialist hours to draft and a committee weeks to review, and a model asked to help writes questions whose answers the source already states. At EdAI Systems we set out to change that process with AI. The goal: an algorithmic process that builds exam questions well beyond simple recall, and makes every step transparent and easy to verify. This is cogpath."

### 0:34 Home page, composer: pick the Evidence appraisal preset, switch the analysis kind to mechanism

On camera: cut in on the composer already visible; the glyph and the grammar text follow the change.

VO: "The question is designed as a cognitive path: recall, analyze, evaluate, synthesize, each with parameters and a strict schema for what it produces. You compose it, or the planner designs one per item. Every step is a Muse Spark call on the Meta Model API: structured output, reasoning effort set per step, the PDF read natively, prefixes cached."

### 0:55 Sources, then Review on the GCA article: click two claims, move with S and the arrow keys

On camera: each claim's span highlights in the PDF; the approved tag and the reviewer of record.

VO: "Before any item exists, the article becomes claims: verbatim spans, located in the PDF, audited by a second pass, certified by a person. Items rest on approved claims, not on the article as the model read it."

### 1:09 Builds, the GCA build, item 1, Item tab

On camera: read the glyph; the case box; the option tags.

VO: "This item ran recall four, analyze, evaluate benefit against burden, synthesize a counseling plan. The case is one the article does not cover, so the last step had to adapt. Each wrong option is tagged with the step a learner who chose it failed at."

### 1:25 Second tab: How the answer was made

On camera: scroll once through the four steps.

VO: "These are the artifacts the steps left behind: facts with spans, relations with their misreadings, strategies scored, the plan adapted to the case. Nothing here was generated for display."

### 1:36 Third tab: What the verifier found. Click the necessity buttons in order: no notes, 1, 1 to 2, 1 to 3, 1 to 4

On camera: pause a second on each depth; the evidence list appears at the last one. Then the corruption list.

VO: "Now the proof. The model is asked to pick the answer with the notes of step one only: undetermined. Steps one and two: undetermined. Three: undetermined. All four: the key, with quoted evidence that a judge in code re-checks against the notes. Then each step is corrupted the way a learner who fails there would, the rest re-run without the article, and the key is unreachable: four of four."

### 2:02 Fourth tab: Single-shot control

On camera: the control's answer to "Could the key be found in the article's claims alone?"

VO: "The control: same focus, same claims, one call, asked for an item requiring all four cognitive levels. Its key is something the article already states."

### 2:11 Home page foot, then Items

On camera: the summed numbers; the bank with certified items and their decisions.

VO: "On this server, six builds on five sources, including a physics preprint, a statute and a policy article: 21 of 30 path keys are not stated by the source and 20 of 30 need every step; for single-shot items, 9 of 30. The verifier judges structure; the reviewer judges the field."

### 2:30 End card

Text on screen: cogpath.org · github.com/drjcf/cogpath · Meta Model API, Muse Spark 1.3.

VO: "What used to take weeks now takes minutes with Meta AI: an item compiled from an executed cognitive path, verified against the source and a single-shot control, transparent at every step, and certified by a person who judges the field. Now we can assess competency over recall, and show the proof in the item. cogpath, live at cogpath.org, built on the Meta Model API."

## Capture notes

- Read the numbers off the home page as they stand on recording day; the foot sums every build with rates on the server (six builds, 30 items, as of Nov 3), which is fewer than the README's nine because four early builds ran locally and were never uploaded. Update the 2:11 line if a build has been added or removed.
- Keep the default zoom; the evidence lists are the point and must be legible. Cursor visible, no cursor effects.
- The composer edit on the home page launches nothing; launches happen only from a source's build form.
- Pause a second after each necessity click; the panel re-renders per depth.
- Trim dead time in the edit rather than talking faster. If the cut runs over 3:00, drop the 1:25 walkthrough scroll to one screen rather than cutting the verifier section.
- Export at 1080p, upload to YouTube as unlisted, and test the link in a logged-out browser before submitting.

## Opening animation

`docs/video/intro.html` draws the opening as a pure function of time (SVG, the console's tokens and fonts); `docs/video/render.cjs` seeks it frame by frame and encodes `intro.mp4` (1920x1080, 30 fps, 34.3 s). It is a generic rendering of how an item is written and reviewed (writer, committee, revision loop); if the board's workflow differs, edit the station labels in `intro.js`.

Beats, by the start of each voice-over sentence (the default cue, in seconds):

| cue | sentence begins | on screen |
| --- | --- | --- |
| 0.0 | "Writing a high-stakes board exam question" | source article, item writer, a draft card filling in |
| 4.2 | "An item that assesses competency" | hours (clock), committee, revision loop, weeks filling, approved |
| 12.3 | "and a model asked to help" | the old flow dims; a model given one prompt; its key traced to a highlighted sentence in the source |
| 18.2 | "At EdAI Systems we set out" | EdAI Systems, assessment items for credentialing exams |
| 23.3 | "The goal: an algorithmic process" | the path glyph builds, beyond simple recall, an artifact and a check per step |
| 32.5 | "This is cogpath." | cogpath wordmark, compact glyph, cogpath.org |

Re-time it to the recorded voice-over: note the second at which each of the six sentences starts and where the last one ends, then

```
npm install --prefix web
node docs/video/render.cjs --cues=0,4.4,12.9,18.6,23.8,33.0,34.2
```

(seven numbers: six starts and the end; the clip runs 0.6 s past the last). `--dur=` overrides the length, `--out=` the file, `--stills=3,10,17` writes PNGs of single moments to `docs/video/stills/` for checking. Cut to the home page footage on the last frame.
