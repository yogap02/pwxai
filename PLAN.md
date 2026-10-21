# Plan: Recreate the AI test-pipeline framework as a Playwright 1.63 boilerplate

> **Status (2026-09-29): S1–S6 COMPLETE in one session.** All modules implemented, not just
> scaffolded. Verified: `npx tsc --noEmit` clean · `npm run self-checks` 19/19 ·
> `npx playwright test` 2/2 against a live URL · `npm run pipeline -- --dry-run --from-scenarios`
> runs all 9 stages and writes `artifacts/run/run-report.json`.
> Remaining for later sessions: wire a real agent CLI into `src/agent/` (replacing
> `cdp-builder-stub.ts`), fill product-owned content (`scenarios/*.txt`, domain map entry
> steps, scope rules), and optionally run stage 8 against a real repo. Prompt templates in
> `src/ai/prompts/` are product-neutral seeds — rewrite the product sections per §6 of
> `pipeline-pattern.md`.
>
> **Correction (2026-10-19).** That "COMPLETE" was not true of S5's self-heal criterion, which was
> declared met on a run that never exercised the healer. Nothing imported the fixture, nothing
> called `attemptHeal`, and stage 7 only ever ran its empty path while reporting success. It is now
> wired and demonstrated end to end (see S5 below and README §"Self-healing locators").
>
> **Addition (2026-10-19): a heal is only as good as the test that used it.** A heal record said what
> the healer *found* and nothing about whether it *worked*, so a test that passed only because a
> locator was repointed was indistinguishable from a healthy one. Records now carry the failure that
> prompted them, the test(s) that used them, and the worst outcome across those uses
> (`test-passed`/`test-failed`/`unknown`), and **stage 7 folds in only a verified repair** — a repair
> whose test failed is evidence against it, and applying it would commit a wrong locator with the
> failing test gone. Declined repairs and refusals (with the test that hit them and whether it went
> red) are rendered under `## Locator heals` in `summary.md`. Both halves are demonstrated live: a
> passing repair is folded in, and `'Pricin' → 'Pricing'` — a typo repointed at the neighbouring link,
> uniquely, so the repair resolved and the assertion failed — is recorded `test-failed` and declined.
> Two bugs fell out of the same work: `heals.json` was overwritten by each worker, so **a run with a
> failure lost its heals silently** (Playwright restarts the worker; saves now merge within a run and
> replace across runs), and a self-check read the ambient `heals.json` instead of creating its own
> state.
>
> **Addition (2026-10-19): the healer refuses, and says why.** Two guards landed with the
> demonstration: copy healing is **locale-bound** (`byCopy` declares its locale; `/id`'s
> `"Portofolio"` is 0.90 similar to the English `'Portfolio'`, so an unguarded run would rewrite the
> copy and break `/en`), and every refused attempt is recorded with a reason
> (`no-candidate`/`ambiguous`/`not-unique`/`locale-mismatch`) plus the observation behind it, then
> surfaced under `## Locator heals` in `summary.md`, annotated with the test that hit it. Both
> refusals are demonstrated live. The deliberate
> non-goal is written down: the healer repairs a stale source line, never "the feature is gone" or
> "the test is wrong" (README §"The healer is allowed to refuse").
>
> **Addition (2026-10-19): the outcome is announced, not only recorded.** `heals.json` is an artifact
> nobody opens mid-run, and the console said "1 passed" for a healed test exactly as for a healthy one:
> the healer's two `count()` calls were visible in the trace and the heal still was not. The fixture now
> annotates each test it healed (`heal` / `heal-refused`, rendered by the HTML report under
> *Annotations*) and the worker prints a `[self-heal]` block at teardown — a clean run prints and
> annotates nothing. Both wiring points are self-checked; the note builders live in `heal-manifest.ts`,
> because the fixture cannot be imported outside Playwright's test runner (it hooks `test.beforeEach`
> at module scope).
>
> **Addition (2026-10-21): the mobile-layout knowledge, and a defect it was blind to.** A viewport was
> made general digest knowledge — the profiles (`mobile`/`tablet`/`desktop`) and "which profile is this
> scenario about?" read from the scenario's own words, a `useViewport(profile)` capability on the page
> object, and a stage-4 work order when the page object cannot express the profile, because both
> obvious alternatives fail silently (skip the resize and the test re-runs the desktop assertions at a
> phone width and passes; resize without adapting the assertions and the desktop ones fail on a
> collapsed nav, which reads as a product bug). That knowledge then had to be corrected: "the layout
> fits" was stated as one check, the document's scroll width, and it is **blind** to a child wider than
> its column. Live: the Cloudflare Turnstile widget is a fixed 300px in a 276px form column at 390x844,
> spilling 24px out of the form while `scrollWidth` stayed equal to `clientWidth` — the mobile test
> passed and a person reported the defect. The shared fact is now a measurement over elements
> (`measureLayoutSpill`), exempting decoration (an `absolute`/`fixed` element is placed against a box,
> not laid out in the flow) and clipping/scrolling containers (a carousel), with the decision a **pure
> function** driven by synthetic boxes in self-checks — the first version had its two sides swapped and
> flagged every correctly sized element. Its limit is now written down too: a check can only measure
> what rendered, and Cloudflare injects **no** Turnstile frame in an automated browser in any
> `data-size`, so the widget is not in the DOM to be measured and the assertable form is the contract
> (the slot must be at least as wide as the widget it declares). That assertion is product work and
> lives in the page object, with the vendor constant — machinery measures what rendered and knows no
> vendor's pixels. It fails as it should: slot 276px against a declared 300px widget.
>
> **Addition (2026-10-21): the block hash decides, and a stale block no longer vouches for itself.**
> Editing a scenario did nothing: a block is held while its scenario's hash matches, so a moved hash
> fell through to the classifier — with the stale block's own title in the evidence list, because the
> block carries the scenario's title. The answer was therefore always `covered`, the edit never reached
> the spec, and because the stale block was carried forward with its *old* hash the same scenario was
> re-decided on every later run, forever, under a green report, while AGENTS.md promised a tag edit
> regenerates the block. `digestPath` now reads the hash before any model call — no block → `classify`,
> moved hash → `redigest`, equal → `hold` — and re-digestion settles, because the rewritten block
> carries the new hash. Found by trying to land the Turnstile assertion the sanctioned way (change the
> scenario, not the spec) and watching stage 2 report "already covered".
>
> **Addition (2026-10-21): two silent compile failures, and a debug switch.** A delete-the-spec-and-
> regenerate run produced a spec that did not compile, twice over, and neither failure was the import
> strip everyone suspected. The scaffold emitted the healing fixture but not the page-object class its
> blocks instantiate (TS2552 for the whole file), and the generator was handed *bare member names*
> where it needed *signatures* — so it read `expectHeroCtaTargets(href: string)` as a zero-argument
> assertion and omitted the `href` (TS2554). Both are now fixed in code rather than by prompt: the
> scaffold derives the import from the domain map, and `CapabilityLookup.catalog()` feeds the generator
> while `all()` still feeds the classifier, which answers with names matched against the surface and
> would read a signature as a missing capability. `DEBUG=true` narrates a run as it happens (a run
> change, not a mode change): correlated values in the page objects and pipeline scripts, AI calls as
> request/response truncated with an ellipsis, and nothing in the specs — a spec that logs is outside
> the capability index, cannot heal, and cannot be reviewed as a capability.

> **Addition (2026-10-21): stage 5 is a decision, not a one-liner.** The test-plan
> stage chose a scope from a single fact — "did a builder fail" — and the docstring
> claimed "scope + tag counts" while reading neither. It now asks a planner agent
> (`src/ai/test-planner-agent.ts`, prompt in `src/ai/prompts/test-plan.md`) which of
> three scopes the run deserves, from what stages 1 and 2 already produced: the risk
> areas the change touches and the digest verdict for every scenario. Neither input
> existed as data before — stage 1's risk areas were a rendered line and nothing more
> (`collectNewScenariosFromStage1` returned an empty Map), so they are now persisted
> on the manifest with the appended scenarios, because a risk area that survives only
> as prose cannot be reasoned over.
>
> The agent **proposes; code decides**. It returns a name and a reason, never a
> `--grep`; `planner.ts` maps the name to a filter, enforces the floor and fails open.
> Without that split a model answering "smoke" on a change that broke everything hands
> a reviewer a smaller green run.
>
> `config/tiers.json` finally does something. The scope vocabulary had three copies
> that agreed in none of them: `planner.ts` hard-coded the tag patterns,
> `run-summary.ts` restated them for the "what did NOT run" note, and the JSON was read
> by nothing at all — an operator could edit it and change nothing, silently. It is now
> the single source, read by the planner and handed to the agent, validated in code
> (malformed → throws; a tag list on `regression` → throws, because that would drop
> every untagged test from the run the summary calls "everything").
>
> The floor changed shape. It was a title alternation, which quietly required a
> generated title to be character-identical to the scenario title; it is now the
> **creation-date tag**. Stage 2 stamps `@YYYYMMDD` (the run's start date, UTC) on each
> block it generates, and the planner puts that tag in every non-regression grep. The
> date is written once and read back off the block on a hold, so a test keeps the date
> it was made — re-stamping "today" every run would rewrite every generated block's tag
> option once a day, churn nobody reads in a diff. The generated titles stay as a
> second net. Tiers were also renamed to the vocabulary the plan actually uses
> (`smoke` / `sanity` / `regression`, replacing `core` / `extended` / `full`), and the
> summary's narrowing note is now read from the grep that ran rather than a restatement
> of the rules — so the note cannot disagree with the filter.
>
> **Addition (2026-10-21, second pass): `TEST_GREP` is the human's override, and it
> skips the agent.** The variable existed and nothing read it. It is now the operator's
> absolute filter: set it and stage 5 does not call the model at all and the floor is
> not applied — the use case being an end-to-end run of the pipeline when only stages
> 1–2 changed and the full suite is a waste. Two things keep it honest. It is recorded
> as `grepOverride` on the manifest rather than as a tier, because a `grep: @smoke` in a
> report read six months later would otherwise be misattributed to the agent; and the
> summary shouts when the override excludes a test **this run wrote** — the one outcome
> the floor exists to prevent, now reachable by an operator and therefore announced. It
> is never a standing value in the CI definition (that would pin every run, silently) but
> is a `workflow_dispatch` input, and a self-check enforces that any assignment of it comes
> from `${{ inputs.* }}`.
>
> **Addition (2026-10-21, third pass): the workflow is startable by hand.** `workflow_dispatch`
> takes `pr` / `from_scenarios` / `dry_run` / `test_grep` / `base_branch`. A manual run has no PR
> context, so three things follow: `--pr` becomes optional and the run step errors rather than
> proceeding against an empty change set; `SOURCE_BRANCH` falls back to `main` (stage 8 already
> treats it as optional); and `permissions:` is now declared explicitly, because a new repository
> defaults `GITHUB_TOKEN` to read-only — stage 8 would otherwise fail to push its branch or open
> the PR, at the last step of a run that had looked like it worked.
>
> **Addition (2026-10-21, fourth pass): pointed at a real PR, and the two things that stopped it.**
> The first end-to-end PR run (against a real open PR, with `WORK_REPO_SLUG` pointed at that repository)
> never reached past stage 1: `gh pr view --json` returned perfectly valid JSON and `JSON.parse`
> choked on it anyway. `gh` was tracing its own HTTP requests onto **stderr**, and `ghJson` parsed
> `stdout + stderr` merged — and the switch that turned the tracing on was this pipeline's own
> `DEBUG`, which `gh` honours as its debug flag (an alias for `GH_DEBUG`) and which
> `runStageProcess` hands to every child. So `DEBUG=true`, shipped in `.env` and in the CI
> definition, killed every PR-triggered run at its first model-free step, while three green CI runs
> had hidden it completely: those used `--from-scenarios`, which skips stage 1. The same leak put
> 297 characters of `* Request took 537ms` inside the diff handed to the model.
> `runStageProcess` now returns `stdout` and the merged `output` as separate things (a caller that
> PARSES a result reads `stdout`), `ghEnv()` clears `DEBUG`/`GH_DEBUG`, and stage 8's "anything to
> ship?" reads `stdout` too — a git line-ending warning on stderr would otherwise look like a change
> and push an empty branch.
>
> Then stage 1 worked, and the run reported a **success** on output that was not shippable. Eleven
> blocks were generated for the PR's short-link feature; several called `page.request.get` and
> `expect()` directly, so the spec did not compile — nine TypeScript errors, taking twelve
> handwritten tests in that file down with it — and `npm run self-checks` went from 71 passing to 2
> failing. Seven more blocks asserted nothing at all, which the report-only backstop flagged exactly.
> The summary nonetheless read "23 kept · Nothing was generated this run · Needs attention: Nothing",
> because the digest-retry re-digests and overwrote the verdicts the first pass had recorded: a run
> that wrote eleven blocks reported writing none. Two guards make the failure loud instead of green:
> stage 2 **refuses** a block that reaches past the page object (`blockViolations`) and turns its
> scenario into an `unbuildable` work order rather than writing a test that cannot compile; and stage
> 8 runs `typecheck && self-checks` over the **output** — CI runs them only *before* the pipeline —
> failing the stage rather than shipping. Refused, never stripped: deleting the offending lines would
> leave a test that passes and asserts nothing.
>
> One broken block still sank a whole spec file, so the compiler is now consulted per block: stage 2
> runs `npm run typecheck` over the file it just wrote, attributes each diagnostic to the managed
> block that owns the line (`src/core/scenario/compile-guard.ts`), refuses that block and recomposes
> with a work order in its place. On this PR that is the difference between delivering nothing and
> delivering 19 tests plus 6 work orders — among them a block the compiler rejected with
> `TS2554: Expected 0 arguments, but got 1.` for calling `goto(path)` on a zero-argument method,
> which no list of member names could have caught.
>
> Verifying that end to end then found that stage 8 had **never delivered anything at all**, behind
> three walls in a row. Its commit message went through a shell, which split `test(pipeline):
> generated tests + healed locators` into argv entries, so git refused four unknown pathspecs; then
> `openPr` asked `gh pr create` for `--json`, which that subcommand does not have (it belongs to `pr
> view`), so gh died with `unknown flag` before it had looked at the repository; and the PR title and
> body would have been re-split by the same shell one step later. The code host now hands `git` and
> `gh` `shell: false` (both are executables; only `.cmd` shims need the shell), reads the PR URL from
> stdout, and `runStageProcess` resolves a spawn failure instead of letting an unhandled `error`
> event kill the run. The same class hid two earlier bugs: a code path CI's `--from-scenarios` runs
> never reached.
>
> Still untouched, and the one thing left: the run's own report. The retry overwriting the digest's
> verdicts still makes "nothing was generated" reachable for a run that generated.

## Context

`D:\a_playground\tcgen` currently contains only `pipeline-pattern.md`. It describes an
agent-driven test pipeline (9 stages) that reads an issue + diff, finds coverage gaps, writes
plain-English scenarios, generates specs, builds page objects by driving the live app, runs the
suite, applies locator heals, and opens a PR — with a human as the merge gate. The goal is a
**from-scratch, product-neutral boilerplate** implementing that pattern on latest Playwright.

The pattern doc is explicit: the portable part is the *machinery* (scenario parsing, managed
regions, domain map, stage runner, planner, self-heal runtime, fail-open rules); the
*earned knowledge* (scenario notes, entry-discovery steps, per-domain instruction files) does not
transfer and stays as product-owned content. So the boilerplate implements the machinery for real
and leaves product vocabulary as clearly-marked product-owned files.

## Decisions (confirmed with user)

- **Model client:** official `openai` SDK (works with OpenAI + compatible gateways), wrapped in a
  thin `ModelClient` with JSON extraction, truncation repair, budget-scaled deadline, bounded pool.
- **Delivery:** GitHub via the `gh` CLI, isolated behind `CodeHost` / `IssueTracker` interfaces so
  a different vendor is a one-file rewrite. Issue/diff input for stage 1 comes from a PR.
- **Scope:** full skeleton, **core is real** — scenario parser/manifest, managed-region
  read/write, domain-map resolver, stage runner with timeout + signal handling + run report +
  redaction, planner (tiers → grep) with fail-open + enforced floor, self-heal fixture/writer,
  bounded concurrency pool. Stage 1/2/3 model prompts and the builder agent are working but
  product-neutral stubs.
- **Builder agent:** `BuilderAgent` interface + a local CDP-based stub (snapshot page → append a
  *fact* to the domain instruction file, once, deduped against what the file already says: no
  per-run timestamped section — the per-run observation goes in the stage summary); the real agent
  CLI wiring is a later, isolated swap.

## Stack

- Node 20+, TypeScript (strict), ESM.
- `@playwright/test` **1.63.0** (latest) + `playwright-core` (for CDP stub).
- `openai` (AI layer), `zod` (schema/JSON validation), `p-limit` (bounded pool), `dotenv` (env).
- No runtime vendored deps beyond the above; keep it lean.

## Directory layout

```
tcgen/
  PLAN.md                                # this plan, persisted as source of truth for multi-session work
  package.json, tsconfig.json, playwright.config.ts, .env.example, .gitignore, README.md
  .github/workflows/pipeline.yml          # CI wiring (thin)
  config/
    domain-map.json                       # product-owned; hand-authored, never model-filled
    tiers.json                            # scope vocabulary: smoke/sanity/regression
  src/
    core/
      scenario/parser.ts                  # TEST:/Tags:/Expected:/Notes: blocks, id+content hash
      scenario/manifest.ts                # durable manifest, rehydrated repo-relative paths
      scenario/managed-region.ts          # @digest:managed:start/end read/write
      scenario/domain-map.ts              # resolver; manual edits authoritative; posix rehydrate
      orchestration/stage-runner.ts       # timeout, signals, output reassembly, redaction
      orchestration/run-report.ts         # stage records, persisted report
      util/paths.ts                       # repo-relative POSIX only; never absolute
      util/env.ts                         # 3-point env registration helper (throws on missing)
      util/pool.ts                        # bounded concurrency (p-limit)
    ai/
      model-client.ts                     # openai SDK wrap; JSON extract; truncation repair
      prompts/                            # markdown templates w/ {{PLACEHOLDER}}
      classifier.ts                       # covered | novel | blocked (capability gate)
      generator.ts                        # scenario -> test() block
      test-planner-agent.ts               # smoke | sanity | regression (stage 5's proposal)
      capability-index.ts                 # real POM member surface for gating
      coverage-backstop.ts                # report-only; clause/negation check
    agent/
      builder-agent.ts                    # interface
      cdp-builder-stub.ts                 # snapshot -> instruction file (stub)
      write-scope-guard.ts                # additive-only; revert out-of-scope writes
    runtime/
      self-heal-fixture.ts                # playwright fixture; attaches the heal collector to page
      heal-locator.ts                      # deterministic narrowing; the only healing logic
      heal-manifest.ts                    # heal records + outcomes + refusals (deduped; merged per run)
      heal-writer.ts                      # fold heals into locator files (exact string replacement)
    planning/
      tiers.ts, planner.ts                # scope vocabulary + agent-backed planner; fail-open; enforced floor
    stages/
      01-gap-analysis.ts
      02-testcase-digest.ts
      03-pom-builder.ts
      04-testcase-digest-retry.ts
      05-test-plan.ts
      06-playwright-test.ts
      07-heal-apply.ts
      08-git.ts
    delivery/
      code-host.ts                        # CodeHost interface
      issue-tracker.ts                    # IssueTracker interface
      github.ts                           # gh CLI impl (PR read, branch, push, PR open, comment)
    exploration/
      crawler.ts                          # BFS crawler (breadth only, not targeted build)
      page-analyser.ts, journal.ts, locator-writer.ts
    cli/
      run-pipeline.ts                     # orchestrator entry
      self-checks.ts                      # cheap invariants gate (no browser)
  scenarios/<domain>.txt                  # one .txt per feature area (product-owned)
  tests/                                  # generated + handwritten specs live together
  src/page-objects/<domain>/              # generated POMs
  src/page-objects/<domain>/instruction.md  # builder-owned per-domain domain context
```

## Key invariants (from the doc, enforced in code)

- **Managed regions only** for generated code; handwritten outside is never touched.
- **Domain identity** comes from `scenarios/` filenames + `domain-map.json`; the orchestrator has
  no feature names hard-coded (the single indirection that makes it portable).
- **Fail open, always:** planner/report/filter degradation widens to the full suite with a named
  reason; a malformed config value *throws* instead of silently defaulting.
- **Enforced floor:** the narrowed grep always includes everything generated this run — the
  creation-date tag stage 2 stamps on each generated block, with the generated titles as a second
  net; the planner re-checks that the filter selects something and widens to everything if not.
- **Additive-only agent writes** + **write-scope guard** that reverts out-of-scope changes.
- **Never persist absolute paths** — repo-relative POSIX everywhere, rehydrated at load.
- **Cheap self-checks** run in CI immediately before the pipeline, in the same command.
- **Two classification gates:** "already covered?" AND "can the POMs express the novel part?" —
  the second gates on real POM member names, not prompt prose.

## Build order — split across sessions

Context is limited, so implementation is split into sessions that each end in a verifiable
state. **Step 0 (first session, first action): write this plan into the repo as
`D:\a_playground\tcgen\PLAN.md`.** That file is the single source of truth across sessions — every
new session starts by reading it (plus `pipeline-pattern.md`) and continues from the session
checklist, updating it as milestones complete.

| Session | Builds | Ends verifiable by |
|---|---|---|
| S1 | PLAN.md in repo, package.json, tsconfig, playwright.config.ts, .env.example, .gitignore, README, `core/util` (paths, env, pool), directory tree with `.gitkeep` | `npx tsc --noEmit` clean |
| S2 | `core/scenario` (parser → manifest → managed-region → domain-map), `config/domain-map.json` + `scenarios/` seed | parser/manifest unit checks in self-checks |
| S3 | `core/orchestration` (run-report → stage-runner), stages 01–08 as wired skeletons | dry-run of a mock stage sequence writes a report |
| S4 | `ai/` model-client + prompts + capability-index + classifier + generator + backstop; stages 1–2 real | self-checks + a mocked-model dry run |
| S5 | `runtime/` self-heal fixture + manifest + writer; `planning/` tiers + planner; stage 5–7 real | `npm test` with a sample spec + heal fixture — **the heal fixture half was not met until 2026-10-19** (nothing imported it). Now: break a string-addressed locator, watch the test pass on a narrowed selector, `heals.json` records one heal, `stage:7` rewrites the source, next run clean. The record also carries the outcome of the test that used it, and only a repair with a passing test behind it is folded in — a repair whose test failed is declined and named (2026-10-19). |
| S6 | `agent/` interface + cdp stub + write-scope guard; `delivery/` github impl; `exploration/` crawler | `npm run pipeline -- --dry-run` full loop |
| S7 | `cli/self-checks.ts` complete, CI workflow, final README, `npm run pipeline` against a live target if available | full verification list below |

Session granularity is a guide, not a contract — merge or split as context allows, but always end
a session by updating the session checklist in `PLAN.md`.

## Detailed build order (within sessions)

1. package.json / tsconfig / playwright.config / .env.example / .gitignore / README.
2. `core/util` (paths, env, pool), then `core/scenario` (parser → manifest → managed-region →
   domain-map), then `core/orchestration` (run-report → stage-runner).
3. `ai/` model-client + prompts + capability-index + classifier + generator + backstop.
4. `runtime/` self-heal fixture + manifest + writer.
5. `planning/` tiers + planner.
6. `agent/` interface + cdp stub + write-scope guard.
7. `delivery/` interfaces + github impl.
8. `exploration/` crawler + analyser + journal + locator-writer.
9. `stages/` 01–08 wired through the runner.
10. `cli/` run-pipeline + self-checks; `config/` + `scenarios/` seeds; CI workflow.

## Verification

- `npm ci && npx tsc --noEmit` — strict compile clean.
- `npm run self-checks` — the cheap invariant suite passes (no browser).
- `npm test` — playwright runs the sample spec (a trivial generated region + one handwritten test).
- `npm run pipeline -- --dry-run` — orchestrator executes all 9 stages against a stub issue/diff
  and writes a run report without pushing.

## Out of scope (per the doc)

- Publishing as a package (single consumer; copy-the-tree adoption).
- Jira/Bitbucket/Teams (isolated; GitHub via gh CLI is the one wired vendor).
- The earned-knowledge content (scenario notes, entry-discovery steps, instruction files) — left
  as product-owned files the boilerplate seeds but does not fill.
