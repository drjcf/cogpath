# cogpath

Compile assessment items from a **cognitive path**. Instead of asking a model to "write a hard question", cogpath makes the model *execute* the reasoning a learner must perform (recall > analyze > evaluate > synthesize) over a source, one typed artifact per step, then assembles a single-best-answer item whose key is the terminal artifact and whose distractors are **failures at specific steps**. It then verifies that the full path is actually necessary to reach the key.

Built on the Meta Model API (Muse Spark 1.3): structured output with constrained decoding, per-step reasoning effort, native PDF input, automatic prefix caching. Live at https://edai-prep-25580.web.app; the write-up is `docs/SUBMISSION.md`.

## Quick start

```bash
cd cogpath
npm install
cp .env.example .env            # add MODEL_API_KEY
node cli.js ops                 # list cognitive operations and their params
node cli.js run samples/retrobulbar-hematoma.md "recall(3) > analyze(causal) > evaluate(efficacy, safety) > synthesize(management plan)"
node cli.js run article.pdf "recall > analyze(contrast) > evaluate(benefit, risk, cost) > synthesize(recommendation)" --deep
node cli.js run article.pdf "…" --deep --inline-text   # send the extracted text instead of the uploaded file (no page images, ~4x cheaper input)
node cli.js probe-cache article.pdf [--inline-text]     # three cheap calls that show whether prefix caching engages for this source type
```

A PDF is uploaded once to the Files API (the `file_id` is reused across every call and cached by content hash in `runs/.files.json`; delete that file to force a re-upload) and its text is also extracted locally for grounding checks. File input is tokenized with page images, so a 6,500-word article costs about 38k input tokens per call; `--inline-text` sends the extracted text only.

No key yet: `MOCK_META=1 node cli.js run …` runs the whole pipeline and verifier on deterministic placeholder artifacts (marked `[MOCK]`).

Tests: `npm test`.

## The path DSL

```
recall(3) > analyze(contrast, relations=2) > evaluate(efficacy, safety) > synthesize(management plan)
```

| op | Bloom | params | produces |
|---|---|---|---|
| `recall(n)` | 1 | `concepts` | n distinct facts, each with a verbatim `sourceSpan` |
| `analyze(kind)` | 4 | `kind` = contrast · causal · mechanism · comparison, `relations` | relations between concepts, each with its `commonMisreading` |
| `evaluate(c1, c2, …)` | 5 | `criteria` (priority order), `options` | scored options, `best`, `runnerUp`, `decisiveFactor`, `whyRunnerUpFails` |
| `synthesize(form)` | 6 | `form` | a `caseConstraint` (one concrete case feature under which the generic best strategy fails, grounded in ids), the plan adapted to it, and one `incompleteAlternative` per step (its own = the generic plan that ignores the constraint) |

Each op declares what it `requires` (analyze needs recall, evaluate needs analyze, synthesize needs evaluate); the parser rejects paths that violate this. Ops can repeat (`analyze(causal) > analyze(contrast)` gives ids `analyze`, `analyze2`). JSON form: `[{ op, params }, …]`.

`assemble` always runs last. Distractor policy **one-per-step**: one distractor tagged `failsAt=<step>` per path step, padded with extra terminal-step distractors so every item has at least 4 options. Letters are assigned by a seeded shuffle (`--seed`).

The stem is a vignette, not a literature summary: one specific case as a learner would meet it, embedding the synthesize step's case constraint as a concrete finding (copied into `constraintSpan`, checked verbatim against the stem). It states none of the recalled facts or figures; the assembler rejects a stem that restates a recall concept or carries its numbers (`4-fold`, `12,172`, `39%`). The learner must bring the facts, see the constraint, and adapt the principles; a learner who only knows the generic recommendation lands on the synthesize-tagged distractor. Options must be homogeneous (same form, at most 3 clauses, lengths within 25%); a key that is the longest by more than 20% is rejected as a length cue.

## Verification

| check | what it does | calls |
|---|---|---|
| grounding | every `sourceSpan` / `evidenceSpan` is found in the source text (verbatim or ≥ 50% of 4-word windows) | 0 |
| coverTheOptions | free answer from stem + lead-in only, then mapped to the closest option; must map to the key | 2 |
| sourceRecall (digest mode) | the picker sees only the digest's `recommendation` claims and the item; the key must NOT be fully entailed by them, otherwise the item is recall of the source's conclusions whatever path built it | 1 |
| digestRecall (digest mode) | the picker sees every claim of the digest and the item; the key must NOT be fully entailed by the source's claims alone. This is the check both arms share: a single-shot item has no step artifacts for necessity, but it can be asked the same question, is the key something the source states | 1 |
| pathNecessity | with notes from steps 1..k only (no source, outside knowledge forbidden, `UNDETERMINED` allowed), the key must become determinable only at k = n | n+1 |
| distractorMapping (`--deep`) | corrupt artifact k the way a learner who fails at step k would, re-run the downstream steps, pick an option; expect the distractor tagged `failsAt=k` | ≈ n + n(n-1)/2 + n |

`pathNecessity.determinedAt < n` means the later steps are decorative: the item is answerable without them. That number, across many items, is the headline metric for the framework: single-shot items vs path-compiled items.

The necessity check is a proxy. A model told to use only the notes may still leak background knowledge; the `UNDETERMINED` option and the no-source setup reduce that, and the mapping check cross-validates it. Say so when presenting results.

## Ingest once, build many

Several items from one article should not each re-read the article. `ingest` processes a source once into a **digest** of claims, stored under `runs/sources/<sha12>/` (`source.json`, `text.txt`, `digest.json`):

```bash
node cli.js ingest articles/fat.pdf [--claims auto|N] [--inline-text]   # one call; claims typed background|method|result|interpretation|limitation|recommendation
node cli.js sources                                                   # what is ingested
node cli.js digest articles/fat.pdf                                   # the digest exactly as the steps see it
node cli.js digest articles/fat.pdf --review                          # review view: each claim with its page number and the source passage, span marked »…«
node cli.js audit articles/fat.pdf [--apply]                          # independent re-audit of a stored digest
node cli.js audit articles/fat.pdf --restore cl10,cl36                # put audit-removed claims back (they are kept in source.json)
node cli.js claim-add articles/fat.pdf --type result --attribution this_work --section results --statement "…" --span "…"   # add a claim by hand; span must be verbatim
node cli.js approve articles/fat.pdf --drop a3,a8 --note "…"          # reviewer gate: run refuses a draft digest (override: --allow-draft)
node cli.js unapprove articles/fat.pdf                                # back to draft
node cli.js run articles/fat.pdf "<path>" --deep                      # auto: uses the digest when one exists for these bytes
node cli.js run articles/fat.pdf "<path>" --source raw|both|digest    # force a mode; raw = the article itself, both = article + digest
node cli.js run f658c79b0283 "<path>"                                 # an ingested sha works wherever a source file does (the stored text stands in for the file)
```

The claim budget defaults to about one claim per 150 words of source, between 12 and 80 (`--claims N` overrides it; the model may return fewer when the content is thin). Every claim carries a verbatim span that is checked locally against the extracted text at ingest time; claims whose span cannot be found are dropped (the model is asked once to repair them). Three further checks guard the part a verbatim span cannot: every figure in a statement must appear in the source near its span (no computed, rounded, or remembered numbers); every claim is attributed (`this_work` | `cited_work` | `general_knowledge`), because a figure the introduction cites from an earlier study is not a result of this work; and an independent audit pass (`--no-audit` to skip, `audit <source|sha> [--apply]` to rerun) gives a separate low-effort reader only each claim and the original passage around its span and asks whether statement, type, and attribution are faithful. A label disagreement (type, attribution) is corrected in place and recorded on the claim as `auditFix`; a content problem (number, direction, population, overclaim, unsupported) removes the claim, which is kept in `source.json` and restorable with `audit --restore`. A separate recommendations pass lists every prescriptive statement in the source and merges the ones the main pass missed, because recommendations are the claim type that `sourceRecall` and the synthesize step depend on and the one a budget-limited pass drops first. None of this proves the digest complete or correct; `node cli.js digest <source>` prints it for the reader who can, and `digest.json` can be edited by hand.

Each claim is located on a page of the PDF at ingest (`page`, from per-page text in `pages.json`), so a reviewer sees the claim, the page, and the passage with the quoted span marked; the web UI will render the page itself with the span highlighted from the same data.

**Review gate.** A fresh digest is `draft`. `run` refuses to build items on a draft (or on an approved digest that was edited afterwards, status `modified`) unless `--allow-draft` is passed. `approve` records who approved, when, a note, the claims dropped at review, and a hash of the exact digest content; any later edit demotes the digest to `modified` until it is approved again. Every run trace records the review status of the digest it used (`source.digestReview`). The web UI will call the same `approveIngest` / `unapproveIngest`; the gate does not depend on it. In digest mode the steps see only the digest (a few thousand tokens instead of 12k inline or ~38k as a file), recall concepts must cite the claim ids they rest on, and premises-only recall may not use `recommendation` claims. Grounding is still checked against the raw text, never against the digest, so the provenance chain is item option → recall concept → claim → verbatim span → sentence in the PDF.

The digest is a model-generated intermediate: an error in it reaches every item built on it, and its framing shapes them. Keep `--source both` or `raw` for the comparison runs that decide whether digest-mode items verify as well as raw-mode items on the same path.

## Build: N items from one article, with a single-shot control

```bash
node cli.js build articles/fat.pdf --items 5 --deep --baseline [--path "recall(3) > analyze(causal) > evaluate(efficacy, safety) > synthesize(management plan)"] [--seed 7]
```

One planning call designs the items: for each, a focus (the decision the item turns on), a cognitive path (the planner varies analyze kinds and evaluate criteria unless `--path` pins one), and a reserved set of 3 to 6 claims, disjoint across items and never recommendations only. Each item then runs its path with the recall step held to its reserved claims (any concept citing another item's claim is rejected and retried), is verified, and is saved as its own run. The build record (`runs/builds/<id>.json`) adds the plan, a coverage map (claims used per item, claims no item touched, by type), per-item verification, and totals.

Leak guards keep the decision out of the early artifacts, since path necessity is only meaningful if no step before the last already states the answer: recall statements and their `importance`, and analyze claims and implications, are rejected when they read as an instruction (modal, imperative, or "the surgeon should/cannot"); analyze evidence may not quote a recommendation claim; evaluate options are atomic strategies; the planner's focus is a decision domain, not a scenario (the case is designed by the synthesize step), and reserved claims are premises only. The synthesize step's adapted plan, and then the key as the assembler writes it, are checked in-loop against every claim of the source (one cheap entailment call each) and rejected when the source fully entails them, because such an item tests recall of the source; the key check exists because a synthesis can carry an adaptation that the condensed key then drops. Across a build each item's case constraint must differ from the ones already used, and a stem may show the constraint's feature but not state its consequence or the plan; figures spelled out in words are caught like digits. The necessity picker's quoted evidence must occur verbatim in a note at that depth (the cited note, or another: a quote the picker attributed to the wrong note is re-attributed, not rejected) and must share content with the clause it is cited for (figures count; inflections match; a clause of more than three content words needs two shared). When the quote does not bear on its clause, the note it came from and then all notes at that depth must carry at least half of the clause's content words: a sloppy citation of a note that does cover the clause is accepted, a clause the notes do not carry is a leak. This judgment is local (`verifier.judgePick`), so when its rule changes, stored builds are re-scored in place rather than re-run: `node cli.js rescore all --write` re-judges every stored pick from its recorded evidence (path necessity from the step artifacts, distractor mapping from the stored downstream artifacts, source and digest recall when the digest is still in the store) and records what changed. Recall concepts carry no `importance` field any more: it was a channel for analysis to leak into step 1. The synthesize step's `novelElement` must change what is done; an adaptation that is only counseling, consent, or documentation is rejected, because every item can be adapted by talking. Options are 12 to 25 words and at most 2 clauses, and an odd-one-out cue (a clause shared by the distractors that the key lacks) is rejected.

Cover-the-options asks for a free answer to the stem from the source, then maps it onto the options; it must land on the key. The free answerer is told that every constraint the scenario states is binding and that an acute problem in the scenario comes before anything elective, because a generic free answer maps onto the generic distractor as readily as onto the key. The check is still harder for an adapted item than for a single-shot one, whose key is the generic answer; read the arms' cover rates with that in mind.

`--baseline` builds the control arm: for the same focus and digest, one call is asked for a board-style item that "requires recall, analysis, evaluation, and synthesis," with the same stem and option rules. It gets no path, no artifacts, no step verification. The checks that apply to any item are run on both arms (evidence grounding, cover-the-options, source recall, digest recall, form); path necessity and distractor mapping exist only for path items, because only path items have step artifacts. The headline across many builds: digestRecall pass rate for both arms (is the key something the source states, or something derived from it), plus necessity and key-blocked rates for the path arm, at the cost each arm paid.

## The console (web)

```bash
npm install            # also installs web/ dependencies
npm run build:web      # builds web/dist once (or: npm run web for the Vite dev server on :5177, proxying /api)
npm run serve          # http://localhost:3077  (PORT=… to change; reads COGPATH_DATA like the CLI)
```

Deployed at https://edai-prep-25580.web.app (reads are public; writing needs an allowlisted Google account). The design notes are in `web/DESIGN.md`: color means a step, a verdict, or nothing; the path glyph is the one recurring element.

**Home** (`#/`) is the path composer with the explanation beside it: the four steps as editors (facts to recall; analysis kind and relation count; evaluation criteria in priority order and strategies weighed; what the key is), five presets, the glyph and the grammar text they produce, and the verifier's five questions. The numbers at the foot are summed from every finished build.

**Sources** (`#/sources`) lists every article with its lifecycle (uploaded, queued, ingesting, to review, approved, modified, failed). A signed-in reviewer uploads a PDF, markdown or text file (claim budget auto or fixed, audit on or off), reads it again, opens the review, and launches a build from the form. The build form chooses the item count, deep verification, single-shot controls, a seed, and the path mode: the planner designs a path per item, or the items run paths composed in the form (several paths are assigned to items in turn and held exactly; the planner still chooses each item's focus and reserved claims).

**Review** (`#/review/<sha>`): claims on the left, the article on the right. Clicking a claim (or moving with the keyboard) highlights its verbatim span in the rendered PDF and scrolls it into view; for markdown and text sources the extracted text is shown with the span marked. Keys: `J` certify, `F` reject (with a reason), `E` edit statement, type or attribution (the span is immutable: it is the provenance), `S` or `↓` next, `↑` previous, `Esc` cancel. Each decision is recorded per claim with the reviewer's identity, and **Approve digest** is enabled only when nothing is pending; approval removes rejected claims and binds the approval to the remaining content, exactly as the CLI `approve` does. The span is literal source text re-found at display time against the pdf.js text layer (no stored offsets); a claim whose span never highlights is a data-quality signal, not a viewer bug. Scanned PDFs have no text layer and cannot be highlighted.

**Builds** (`#/builds`) lists every build with its paths, the rates that matter (keys the article does not state, keys that need the full path, all checks, the same for the controls), review counts and cost. A build that is still running shows its status, the planner's output once it exists, and the worker's event log, polled until the record lands.

**A build** (`#/builds/<id>`) opens on the scorecard (path items beside their single-shot controls), the review counts and the export buttons, then one card per item with four views. *Item*: the case, the stem, the lead-in, the lettered options with the key marked and each distractor tagged with the step it fails at, the explanation and distractor rationale, and the review controls (Certify item, Reject item with a reason, Undo), recorded under the signed-in identity. *How the answer was made*: the path vertical, each step opened to its artifact in words: the recalled facts with their spans and claim ids, the relations with their implication and the misreading each invites, the evaluation as a scored table with the decisive factor and why the runner-up loses, the case and what it changes, and the alternatives a learner who skipped a step would reach. *What the verifier found*: the six checks as questions with yes/no verdicts, the picker's quoted evidence for every necessity depth, and the distractor mapping per corrupted step. *Single-shot control*: the control item built on the same focus with its own checks. Claims no item used are listed at the end.

**Items** (`#/items`) is the item bank: certified items across every build (or pending, rejected, all), each with its article, path, options tagged by failing step, verifier findings and decision, and an export as JSON with that provenance. Per-build exports are on the build page.

Locally the server has no authentication and the reviewer name typed into the console is the identity; deployed, the identity is the Google account verified by Firebase Auth and `by` cannot be supplied by the client. `test/e2e/console.smoke.cjs` is an optional Playwright check of the review flow; `test/e2e/builds.smoke.cjs` opens a build and its tabs; `test/e2e/flow.smoke.cjs` drives the whole console in local mode (upload, ingest job, review, approve, launch, live progress, record).

## Deploying to GCP (Firebase Hosting + Cloud Run + Firestore + Cloud Storage)

The same code runs in two shapes. Locally, `COGPATH_STORE=fs` keeps everything under `runs/` and `npm run serve` is the whole app (auth off: a reviewer name is the identity; jobs run as child processes). In the cloud, `COGPATH_STORE=gcp` puts metadata, digests, decisions, build summaries, progress events, jobs and the allowlist in a named Firestore database and the large things (PDFs, extracted text, full build records, run traces) in a Cloud Storage bucket; the API is a Cloud Run service, each ingest or build is a Cloud Run Job execution launched by the API, and the console is served by Firebase Hosting with `/api/**` rewritten to the service. Reads are public; uploading, reviewing, approving and building need Google sign-in and an allowlisted email, and that verified email is the reviewer of record on every decision.

```bash
gcloud auth login && firebase login --no-localhost
PROJECT=edai-prep ./deploy/deploy.sh setup                       # database, bucket, secret (empty), service account, registry
# the model key, typed at a prompt rather than pasted into a command line
read -rsp 'MODEL_API_KEY: ' MODEL_API_KEY; echo; printf '%s' "$MODEL_API_KEY" | gcloud secrets versions add MODEL_API_KEY --project edai-prep --data-file=-
# Firebase: enable the Google sign-in provider (console > Authentication > Sign-in method), register a web app, save its config
firebase apps:create web cogpath --project edai-prep
firebase apps:sdkconfig web --project edai-prep | node deploy/web-config.mjs
PROJECT=edai-prep ALLOWLIST=you@example.com ./deploy/deploy.sh   # image, service, job, hosting (setup is re-checked, idempotent)
```

`deploy/deploy.sh` is idempotent and takes a single step as its argument (`setup`, `image`, `service`, `job`, `hosting`). It creates the Firestore database `cogpath` in `nam5`, the bucket `<project>-cogpath`, a service account with Firestore, Storage, Secret Manager and Cloud Run Job permissions, builds one image with Cloud Build, deploys it as the service `cogpath-api` and the job `cogpath-worker` (three-hour task timeout: a five-item build with controls and deep verification is about 30 minutes), then builds and deploys the console. After the first deploy, add the hosting domain to Authentication > Settings > Authorized domains.

Moving local work into the cloud store, and adding reviewers:

```bash
gcloud auth application-default login
export COGPATH_STORE=gcp GOOGLE_CLOUD_PROJECT=edai-prep COGPATH_FIRESTORE_DB=cogpath COGPATH_BUCKET=edai-prep-cogpath
node cli.js import-runs ./runs          # sources (digests, decisions, approvals, PDFs) and build records
node cli.js allow colleague@example.com # or set ALLOWLIST before deploying; env and collection are both honored
node cli.js sources                     # every CLI command works against the cloud store with these variables set
```

Costs are the model calls; Cloud Run scales to zero, the job runs only while a task runs, and Firestore and Storage usage is small.

## How a call is laid out (prompt caching)

Every request shares the same prefix: framework preamble (`instructions`) then the source (`input_file` by file id, inline text, or the digest), then earlier artifacts, then the step instruction last. Every request carries a `prompt_cache_key` (one per source, so its calls route to the backend holding the prefix) and `prompt_cache_retention: 24h`; without the key the API reported 0 cached tokens on identical back-to-back requests. `probe-cache` measures what actually engages.

PDFs are uploaded once (`purpose: user_data`) and the file id is reused for identical bytes (`runs/.files.json`). Text is also extracted locally (pdf-parse) for the grounding check.

## Adding a cognitive operation

Create `core/ops/<id>.js` exporting `{ id, label, bloom, description, requires, params, effort, schema | schemaFor(ctx), instruction(ctx), verify(artifact, ctx), mock(ctx) }` and register it in `core/ops/index.js`. Schemas are written with `core/schema.js` helpers so they satisfy Meta strict mode (`assertStrict` throws otherwise). `verify()` returns a list of problems; the executor feeds them back to the model for one retry.

Candidates: `apply(scenario)`, `critique`, `predict`, `compare(sourceB)`.

## Output

`runs/<id>.json` holds everything: the normalized path, every step's instruction, artifact, usage (input / cached / output / reasoning tokens), reasoning summary, verification problems and retries, the lettered item, and the verification report. `node cli.js show runs/<id>.json` reprints it.

## Docs

`docs/SUBMISSION.md` is the hackathon write-up; `docs/DEMO.md` is the three-minute demo script against the consoles.

## Layout

```
core/ops/         recall, analyze, evaluate, synthesize, assemble (+ registry)
core/path.js      DSL parser / normalizer
core/schema.js    strict-schema helpers + validator
core/meta.js      Meta Model API client (Responses protocol, files, mock)
core/source.js    pdf / md / txt / inline loading; withDigest() re-bases a source on its digest
core/ingest.js    one-call extraction of a source into a verbatim-grounded digest of claims
core/store.js     runs/sources/<sha12>/ (source.json, text.txt, digest.json)
core/executor.js  runs a path, verifies and retries each step, assembles the item
core/verifier.js  grounding, cover-the-options, source recall, path necessity, distractor mapping
core/entail.js    entailment-with-evidence helpers shared by the verifier and in-loop op checks
core/textmatch.js normalization and fuzzy verbatim-span lookup shared by verifier and ops
core/plan.js      item planner: focus, path, disjoint reserved claims per item
core/build.js     N items from one digest, coverage map, side-by-side summary
core/baseline.js  single-shot control item and its item-level checks
core/rescore.js   re-judge a stored build's picks under the current local rules (no model calls)
core/store.js     the store: one domain layer over store-fs.js (runs/ on disk) and store-gcp.js (Firestore + Cloud Storage)
core/flows.js     ingest and build as functions shared by the CLI and the worker (progress to the store)
core/migrate.js   import a local runs/ directory into the configured store
server/           Express API: identity (Firebase ID tokens or a local name), upload, job launch, review, builds, progress
worker/           one job per process: ingest or build, launched as a Cloud Run Job execution or a local child process
deploy/           deploy.sh (gcloud, idempotent), Dockerfile at the root, firebase.json, firestore.rules
web/              Vite + React: sources (upload, review, launch), review console, builds console with live progress
cli.js
samples/          de-identified teaching summary used by the tests
```

## Results

Four builds on three articles, each 5 path items with a single-shot control on the same focus, `--deep --baseline`, verifier at the 0.5.1 rules (the three earlier builds were re-scored with `rescore`, which re-judges stored picks and makes no new calls). Sources: an ABCS survey of gluteal fat grafting mortality (56 approved claims), a PRS review of perioperative nutrition (47), and a cohort study of new arterial lesions in giant cell arteritis (40).

| build | source | path: necessity k4 | path: digestRecall | path: all checks | single-shot: digestRecall | generation tokens in (cached) / out | min |
|---|---|---|---|---|---|---|---|
| mvrbxja9 | fat grafting survey | 5/5 | 5/5 | 3/5 | 3/5 | 173k (60k) / 179k | 26 |
| mvrcuuf8 | perioperative nutrition review | 3/5 | 5/5 | 1/5 | 0/5 | 151k (68k) / 148k | 22 |
| mvrdng86 | GCA arterial lesions cohort (0.5.0) | 5/5 | 5/5 | 1/5 | 1/5 | 143k (60k) / 157k | 24 |
| mvrvace5 | GCA arterial lesions cohort (0.5.1) | 4/5 | 4/5 | 3/5 | 2/5 | 144k (64k) / 139k | 31 |
| cloud, Oct 28 | GCA arterial lesions cohort, re-read (41 claims), first build on Cloud Run | 4/5 | 5/5 | 2/5 | 1/5 | 148k (67k) / 141k | 28 |
| mvshukq7 | perioperative nutrition review, two composed paths | 3/5 | 5/5 | 1/5 | not exported | | |
| **total** | | **24/30** | **29/30** | **11/30** | **7/25** | | |

digestRecall is the one check both arms take: is the key something the source's claims already state? 29 of 30 path keys are not; 18 of 25 single-shot keys are, even though the single-shot prompt asks for an item that "requires recall, analysis, evaluation, and synthesis". Necessity (the key becomes determinable only with the last step's artifact) holds for 24 of 30 path items; the misses are items whose evaluate step already pinned the answer (a thin synthesis), whose analysis alone did, or whose recall alone did.

The composed-path build (mvshukq7) is the first with paths chosen by the designer rather than the planner: items 1, 3 and 5 ran `recall(5) > analyze(mechanism, relations=3) > evaluate(efficacy, safety) > synthesize`, items 2 and 4 ran the evidence-appraisal preset. On this review article the appraisal path produced two items that need the full path and the mechanism-to-management path one in three; path shape interacts with article type, and the composer is how that gets measured. The all-checks column is the strict conjunction of six checks and is where the remaining item-quality problems show: cover-the-options (a free answer from the source maps onto the key) went 16/20, and distractor mapping (corrupting each step blocks the key) went 9/20 at 4/4. Both are reported per item in the builds console.

What the verifier cannot judge: whether the key is good medicine. Several keys verified clean and are clinically weak (deferring an elective operation for a vitamin D level, which the nutrition article's "seven weeks to normalize" claim has produced in three separate builds; dropping aortic surveillance after one normal baseline study), and one key imported an emergency from outside the source and verified by necessity because the synthesize step stated it; cover caught that one. The item review in the console is the last step, and the exported bank carries each decision with its reason.

Development history on the fat grafting survey, same verifier rules applied retroactively: build 1 necessity 0/5 (analysis step leaked instructions), build 2 2/5, build 3 5/5 after the leak guards, build 4 4/5 with digestRecall added. The verifier drove the design.

## Roadmap

1. DAG paths (two recalls feeding one analysis) with branch-ablation necessity, step-qualified ids and an option budget; `compare(sourceB)`, `apply`, `critique` as new ops the composer picks up from the registry.
2. Streamed reasoning summaries per step for the live trace.
3. Export formats beyond JSON (QTI, CSV) and a per-board item template.
