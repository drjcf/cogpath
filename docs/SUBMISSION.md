# cogpath: compile assessment items from a cognitive path

**Tagline.** Instead of asking a model to write a hard question, make it execute the reasoning the question is supposed to require, one typed step at a time, then prove the question needs every step.

## Problem

Generated multiple-choice items read well and test recall. A model asked for an item that "requires analysis, evaluation and synthesis" produces a vignette whose key is a sentence the source already states. Boards and medical schools cannot use such items, and nobody can tell them apart from good ones by reading.

## What cogpath does

A question is designed as a path in a small DSL:

```
recall(4) > analyze(causal) > evaluate(safety, feasibility) > synthesize(operative protocol)
```

The model executes the path over an approved digest of a source article, producing one strictly typed artifact per step: recalled facts with verbatim spans, relations with evidence, scored strategies with a decisive factor, and an adapted plan for a case feature the source does not cover. The item is assembled from the artifacts: the key is the terminal artifact; each distractor is what a learner who failed at one specific step would choose, tagged with that step. Then a verifier tries to break the item.

**Ingest once, build many.** A PDF is digested into claims (type, verbatim span, section, attribution, page), audited by a second pass, and reviewed claim by claim in a console that highlights each span in the PDF. Builds run only on approved digests. The reviewer of record is a human.

**Verification.** Six checks per item, all reported with their evidence:

- grounding: every quoted span is in the source text
- digestRecall and sourceRecall: a picker given only the source's claims (or only its recommendations) must not be able to determine the key; if it can, the item is recall of the source
- pathNecessity: a picker given the artifacts of steps 1..k must determine the key only at k = n; every pick must cite quoted evidence that the verifier re-checks locally
- coverTheOptions: a free answer from the source, bound by the scenario's constraints, must map onto the key
- distractorMapping: corrupt step k, re-run the later steps without the source, and the key must become unreachable

Every build also produces a single-shot control item on the same focus from the same digest, and runs the checks that apply to any item on both arms.

## How Muse Spark is used

- Constrained decoding against strict JSON schemas for every artifact, the item, the digest, the planner and every verifier pick: across the four builds, 83 step attempts and no schema or parse problem; the three retries were semantic (a local check fed its problems back)
- Reasoning effort set per step: low for recall, medium for analyze, high for evaluate, synthesize and assembly, low for the pickers and audits
- Native PDF input for raw-mode runs; local extraction for grounding
- Prompt caching with a per-source cache key and 24-hour retention: a third to nearly half of generation input tokens cached per build

## Results

Four builds, three articles (a mortality survey, a narrative review, a cohort study), 20 path items and 20 single-shot controls:

| | path items | single-shot controls |
|---|---|---|
| key not stated by the source (digestRecall) | 19/20 | 6/20 |
| key needs the full path (necessity k4) | 17/20 | n/a |
| all six checks | 8/20 | n/a |

A build of five items with controls costs about 150k input tokens (a third cached) and 150k output tokens, 25 minutes, generation plus verification.

## What it does not do

The verifier judges structure, not medicine. Two of the 20 clean keys are clinically weak; the console shows the evidence and a reviewer decides. Cover-the-options is harder for an adapted item than for a generic one, so the arms are not symmetric on that check. The digest is a model-generated intermediate; its review step exists because an error in it reaches every item.

## Repository

`README.md` documents the DSL, the checks, the consoles and the CLI. `node --test` covers the pipeline in mock mode. Builds and digests are JSON records; the consoles read them.
