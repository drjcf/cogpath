# Submission package: Meta Global AI Developer Hackathon

Submissions are due Wed Nov 4, 9:00 PM ET (3:00 PM HST) on the Cerebral Valley platform; late entries are not considered. The 3-minute video is the primary judging artifact alongside the code and the live product. Judging: pass/fail gate, then Impact 30%, Meta AI tooling 25%, Demo 25%, Technical depth 20%.

## Pass/fail gate

**Problem statement: Build for Your World.** The builder chairs a specialty board's written exam committee; the problem is item writing for credentialing exams, known firsthand.

**Meta models: Muse Spark 1.3 through the Meta Model API**, in every stage of the pipeline: claim extraction from native PDF input, each path step under a strict JSON schema with reasoning effort set per step, item assembly, and every verifier pick (depth-limited necessity picks, corruption re-runs, the recall and cover checks, the single-shot control). Prompt caching on the shared prefixes. No open-weight models are used, so the open-weight bonus does not apply.

**Not on the anti-project list, and the framing must keep it there.** cogpath is not a chatbot, gives no advice to anyone, and grades no person. It compiles and verifies assessment items for credentialing bodies, and the results include a physics preprint, a statute and a policy article. In the video and the description, say "assessment items for credentialing exams", never "medical AI" or "AI for education".

## New work only

The rules disqualify a demo that shows anything not built during the event (Oct 26 to Nov 4). The public history starts with the 0.6.0 import on Oct 28; judges reading the repo see that first. Add a dated timeline to the README before submitting, in the builder's own words, stating when the grammar, the verifier, the consoles and the cloud deployment were written. Fill in the start date here and move the paragraph to the README once it is right:

> cogpath was started on [date] for this hackathon. The path grammar, the ops, the verifier, the review and builds consoles, the GCP deployment and the composer were written between [date] and Nov 4, 2026. Earlier EdAI Systems work on item generation (a single-shot generator) shares no code with this repository. The build used an AI coding assistant alongside the builder, who designed the grammar and the checks and reviewed every item.

Remove the last sentence if it is not accurate; keep it if it is, since "unclear contribution" is the stated disqualifier and an undisclosed assistant is the easiest way to look unclear.

## Form text

**Title.** cogpath

**Tagline.** Exam items compiled from an executed cognitive path, then proved to need it.

**Short description (about 60 words).** cogpath makes a model execute the reasoning an exam item should require, one typed step at a time (recall, analyze, evaluate, synthesize), over claims a reviewer has certified from a source. It assembles the item from the step artifacts, one distractor per step, then verifies with the same model under controlled information that the key needs every step. Live on Firebase and Cloud Run, on the Meta Model API.

**Long description (about 300 words).** A model asked for an exam question that requires analysis and synthesis writes one whose answer the article already states. Specialty boards write items to a blueprint of cognitive levels, and every generated item that fails that standard costs a reviewer's time or the exam's validity.

cogpath treats the cognitive path as a program: `recall(4) > analyze(causal) > evaluate(efficacy, safety) > synthesize(management plan)`. Each operator has parameters, a strict JSON schema for its artifact and dependencies on earlier steps, and Muse Spark executes it as a separate call on the Meta Model API with effort set per step. Before any item, the source becomes claims as verbatim spans located in the PDF, audited and certified by a person. The item is assembled from the artifacts: the key is the terminal artifact, each distractor is the option a learner who failed at one step would choose, and the stem is written to a case the source does not cover.

The verifier then uses the model against itself. It asks for the answer with the notes of steps 1 to k only, with the source withheld and outside knowledge forbidden, and requires the key to become determinable only at the last step; a judge in code re-checks every quoted piece of evidence against the notes. It corrupts each step the way a learner who fails there would, re-runs the rest, and requires the key to be unreachable. A single-shot control on the same focus takes the checks both arms share.

Across nine builds on six sources (45 items), 37 keys were not stated by the source, 32 needed the full path, 14 passed all six checks; single-shot controls, 7 of 25. A reviewer certifies or rejects each item with a reason, and the bank exports with the path, the checks and the decision.

**Built with.** Meta Model API (Muse Spark 1.3): structured output with strict schemas, per-step reasoning effort, native PDF input, prompt caching. Node 22, React, Vite, Express. Firebase Hosting and Auth, Cloud Run (service and jobs), Firestore, Cloud Storage, Secret Manager.

**Links.** Live: https://cogpath.org. Repo: https://github.com/drjcf/cogpath. Video: [YouTube link]. Demo post on X: [link, for the Most Viral award; optional].

**Team.** John Ferguson, EdAI Systems, Inc. (representative). Track: [startup or indie, as applied].

## Rubric, where each point is made

| criterion | weight | where the video and the repo carry it |
| --- | --- | --- |
| Impact | 30% | the opening claim (0:00), the results and the bank (2:32); README results on six sources |
| Meta AI tooling | 25% | the composer line on structured output, effort per step, native PDF, caching (0:22); the verifier using the model under controlled information (1:50); `core/ops`, `core/verifier.js` |
| Demo | 25% | the live app end to end, one item followed from claims to verdict; nothing staged |
| Technical depth | 20% | the picker discipline re-checked in code, local re-scoring, the cloud shape with jobs and live progress, 30 tests on a Firestore emulator and a worker process |

Bonus worth claiming: Best Agentic Use-Case ($5K, multi-step workflows). The pipeline is planner, four executed steps, assembly, verification with n+1 depth picks and n corruption re-runs, and a control, with a human gate on each end. One sentence in the submission notes can claim it; the video already shows it.

## Demo post on X (optional, for the Most Viral award)

> Ask a model for an exam question that needs analysis and it writes one the article already answers. cogpath makes the model execute the reasoning, one typed step at a time, then proves the question needs every step: 37/45 keys not stated by the source vs 7/25 single-shot. Live: cogpath.org [video]

Submit the post link on the platform; engagement counts through Nov 8.

## Checklist, in order

- [ ] Claim the $150 Meta Model API credits on the credit form (deadline Nov 4, 9 PM ET, same as submission; cannot be done after).
- [ ] Add a `LICENSE` file (the rules say open source; MIT is the usual choice, the license is the builder's call) and `"license"` in `package.json`.
- [ ] Add the dated timeline paragraph above to the README.
- [ ] Decide the pending items on the live app so the Items bank is not empty on camera (recommended: certify GCA Oct 28 items 1, 4, 5; policy items 1, 2).
- [ ] Redeploy so the export carries the control's verdict and the home copy reads "right in the field" (`deploy/deploy.sh image service hosting`).
- [ ] Record the video from `docs/DEMO.md`; export 1080p; upload unlisted; open the link in a logged-out browser.
- [ ] Open https://cogpath.org in a logged-out browser: home, a build, an item's three tabs, the bank.
- [ ] Submit on the platform by Nov 3 (Nov 4 is the deadline, not the plan): title, tagline, descriptions, links, team, track, problem statement.
- [ ] Post on X and add the post link to the submission if going for the viral award.
