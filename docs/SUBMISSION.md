# cogpath: exam questions compiled from an article, one cognitive step at a time

**Tagline.** Instead of asking a model to write a hard question, make it execute the reasoning the question is supposed to require, one typed step at a time, then prove the question needs every step, then let a person certify it.

**Live app.** https://edai-prep-25580.web.app (reads are public; uploading, reviewing, approving and building need an allowlisted Google account). Code: https://github.com/drjcf/cogpath.

## Problem

Generated multiple-choice items read well and test recall. A model asked for an item that "requires analysis, evaluation and synthesis" produces a vignette whose key is a sentence the source already states. Boards cannot use such items, and nobody can tell them apart from good ones by reading.

## What cogpath does

A question is designed as a path in a small grammar, composed in the app or by a planner:

```
recall(4) > analyze(causal) > evaluate(safety, feasibility) > synthesize(operative protocol)
```

The model executes the path over an approved digest of a source article and leaves one strictly typed artifact per step: recalled facts with verbatim spans, relations with evidence and the misreading each invites, strategies scored against the stated criteria with a decisive factor, and a plan adapted to a case the source does not cover. The item is assembled from the artifacts: the key is the terminal artifact; each distractor is what a learner who failed at one step would choose, tagged with that step. A verifier then tries to break the item, and a reviewer certifies or rejects it with the evidence beside it.

**Ingest once, build many.** A PDF is read into claims (type, verbatim span, section, attribution, page), audited by a second reader, and reviewed claim by claim beside the highlighted passage. Builds run only on approved digests. The reviewer of record is a human, under a verified identity.

**The composer.** Four step editors with the registry's parameters, five presets, the grammar text beside the glyph, and several paths per build assigned to items in turn and held exactly. Or the planner designs a path per item. Both modes are the same grammar and the record says which was used.

**Verification.** Six checks per item, each shown as a question with its evidence:

- Are the quoted facts really in the article?
- Could the key be found in the article's claims alone? (a picker given every claim must fail)
- Could the key be found in the article's recommendations alone?
- Is the key reachable only with the full path? (a picker given the artifacts of steps 1..k, forced to quote them, must succeed only at k = n; its citations are re-checked locally)
- Does an expert answering from the article, bound by the scenario and shown no options, land on the key?
- Does corrupting any one step make the key unreachable? (corrupt step k, re-run the later steps without the source)

Every build also produces a single-shot control item on the same focus from the same digest and runs the checks that apply to any item on both arms.

**Transparency.** For every item the console shows how the answer was made: the path vertical, each step opened to its artifact in words, from the recalled facts with their spans to the case and what it changes, to the alternatives a learner who skipped a step would reach. Every build states its calls, tokens, cached share and minutes.

**Item review and bank.** Certify or reject each item with a reason; certified items across builds form the bank, exported as JSON with provenance (article, path, the step each wrong option fails at, the verifier's findings, the decision).

## How Muse Spark is used

- Constrained decoding against strict JSON schemas for every artifact, the item, the digest, the planner and every verifier pick: across the first four builds, 83 step attempts and no schema or parse problem; the three retries were semantic (a local check fed its problems back)
- Reasoning effort set per step: low for recall, medium for analyze, high for evaluate, synthesize and assembly, low for the pickers and audits
- Native PDF input for raw-mode runs; local extraction for grounding
- Prompt caching with a per-source cache key and 24-hour retention: a third to nearly half of generation input tokens cached per build

## Architecture

Firebase Hosting serves the React console; `/api/**` rewrites to a Cloud Run service (Express). Each ingest or build is a Cloud Run Job execution launched by the API; the worker writes progress and a slim event log to Firestore, so the console follows a build live. Firestore (a named database) holds sources, digests, decisions, approvals, build summaries, item decisions, jobs and the allowlist; Cloud Storage holds PDFs, extracted text, full build records and run traces. Firebase Auth verifies the reviewer; the model key lives in Secret Manager. The same code runs locally on the filesystem with no auth, which is how the tests run.

## Results

Eight builds, five sources (a mortality survey, a narrative review, a cohort study, a theoretical-physics preprint, the Patent Act), 40 path items and 25 single-shot controls:

| | path items | medical articles only | single-shot controls |
|---|---|---|---|
| key not stated by the source | 33/40 | 29/30 | 7/25 |
| key needs the full path | 28/40 | 24/30 | n/a |
| all six checks | 11/40 | 11/30 | n/a |

The physics preprint behaved like the medical articles (4 of 5 keys not stated, 3 of 5 needing the full path). The statute did not: every key failed digestRecall, because a statute's claims are rules and applying a rule to a scenario is, to that check, recall. The verifier reported it rather than passing it.

A build of five items with controls costs about 150k input tokens (a third to a half cached) and 150k output tokens, 25 to 30 minutes, generation plus verification. On the review article, the first composed-path build showed the evidence-appraisal path producing two items that need the full path and the mechanism-to-management path one in three: path shape interacts with article type, which the composer makes measurable.

## What it does not do

The verifier judges structure, not medicine. Several clean keys are clinically weak, and one article's "seven weeks to normalize vitamin D" claim produced a "postpone the operation" key in three separate builds; the item review exists for that. Cover-the-options is harder for an adapted item than for a generic one, so the arms are not symmetric on that check. The digest is a model-generated intermediate; its review step exists because an error in it reaches every item. The framework is built for sources that report findings; on a source that states rules (a statute) the keys are rule applications and digestRecall fails them. Paths are linear; DAG paths (two recalls feeding one analysis) with branch-ablation necessity are the next step.

## Repository

`README.md` documents the grammar, the checks, the console, the CLI and the deployment. `npm test` covers the pipeline in mock mode, the GCP store on a Firestore emulator, and the API end to end with a worker process; Playwright smokes drive the console. Builds and digests are JSON records; the consoles read them.
