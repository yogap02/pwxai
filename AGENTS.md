# AGENTS.md

Product-neutral boilerplate implementing an 8-stage AI test pipeline on Playwright 1.63
(issue + diff → coverage gaps → plain-English scenarios → specs → page objects → run →
locator heals → PR). Copied per product, never published as a package.

Source-of-truth docs to read before changing behaviour:
- `pipeline-pattern.md` — the design decisions this code enforces. The "why" for every invariant.
- `PLAN.md` — multi-session build plan + status. Authoritative for intent, but its detailed
  directory listing is partly aspirational (e.g. there is no `src/delivery/issue-tracker.ts`).
- `README.md` — layout, the 8-stage failure table, and the adoption checklist.

## Commands

```bash
npm ci
cp .env.example .env            # Windows: copy .env.example .env — then fill it in
npx playwright install chromium # needed for local npm test / stage-3 builder
npm run typecheck               # tsc --noEmit, strict — the only static gate
npm run self-checks             # plain-assertion invariants (71 today), no browser, seconds
npm test                        # playwright; needs a live BASE_URL
npm run test:list               # enumerate specs without running
npm run pipeline -- --pr 123    # full 8 stages against PR #123
npm run stage:<n>               # re-run ONE stage against the last manifest (1-8)
npm run stage -- <n|name>       # e.g. `-- 3 --domain landing-page`; `stage` alone prints usage
gh workflow run test-pipeline -f from_scenarios=true   # start a run by hand, no PR needed
```

- `npm run stage:<n>` is the debug handle: it reuses `artifacts/run/manifest.json` instead of
  paying for all 8 stages. Stages 1/2 start a manifest; 3–8 consume it and refuse to guess when
  it is missing. `--dry-run` marks stages 6/8 skipped.

- The workflow also has a **manual trigger** (`workflow_dispatch`): inputs `pr`, `from_scenarios`,
  `dry_run`, `test_grep`, `base_branch`. A manual run has no PR context, so `--pr` is optional and
  the run step errors rather than proceeding against an empty change set if neither `pr` nor
  `from_scenarios` is given; `SOURCE_BRANCH` falls back to `main`.
- The workflow declares `permissions: contents: write, pull-requests: write` on purpose. A new
  repository defaults `GITHUB_TOKEN` to read-only, so without it stage 8 fails to push its branch or
  open the PR — at the *last* step, of a run that had otherwise looked successful.
- CI runs `npm run typecheck && npm run self-checks` immediately before `npm run pipeline`.
- Add new invariant checks to `src/cli/self-checks.ts` using its `check()` helper — it is not a
  test framework, just assertions. Rule: add one when the failure would be *silent* (green report).
- There is no ESLint/Prettier config. `typecheck` + `self-checks` are the gates.
- `npm run pipeline` throws at startup if `MODEL_API_KEY` is empty (`ModelClient` constructor calls
  `requireModelKey()`), even with `--dry-run`.
- Reasoning models (the current `MODEL_NAME` is one) spend the pipeline's small `max_tokens`
  budgets on `reasoning` and return `content: null`, which throws `Model returned empty content`
  and makes the classifier silently treat every scenario as covered. Set
  `MODEL_REASONING_EFFORT=none` (or `minimal`) for these structured-JSON calls.

## Toolchain rules that are easy to get wrong

- ESM + `"module": "NodeNext"`: relative imports **must end in `.js`** even though the sources are
  `.ts` (e.g. `import { env } from '../core/util/env.js'`).
- `verbatimModuleSyntax` + `isolatedModules`: use `import type` for type-only imports.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are on — index access yields
  `T | undefined`; do not add `?`-optional props that may be explicitly `undefined`.
- Node >= 20 required.
- `runStageProcess` spawns through a shell on Windows (so PATH finds `.cmd` shims like `npx`). A
  shell re-parses the arguments, so any runtime-built argument containing `|` becomes a pipe:
  a Playwright grep like `@core|@smoke|Some title` kills the run with exit 255. Pass
  `shell: false` and spawn `process.execPath` with an args array instead. It does not need a
  metacharacter to bite: a shell splits on **spaces**, so stage 8's commit message —
  `test(pipeline): generated tests + healed locators` — arrived as four unknown pathspecs and the
  commit failed, on a run whose gates had just passed, and the PR `--title`/`--body` would have gone
  the same way one step later. `git` and `gh` are executables, so `src/delivery/github.ts` hands them
  `shell: false` (`NO_SHELL`). Dropping the shell means a missing executable surfaces as a spawn
  `error` rather than a non-zero exit, so `runStageProcess` resolves that as a failed process — as an
  unhandled `error` event it took the whole pipeline down instead of failing the stage that asked for
  it.
- `gh pr create` takes no `--json` — that is `pr view`. It prints the PR URL on success, and that URL
  (read from stdout) is the parsed result. The flag failed the step with `unknown flag: --json`
  before gh had looked at the repository at all, so stage 8 — whose whole job is to open the PR — had
  never opened one in any environment. The delivery path held three of these walls in a row: that
  flag, the commit message a shell re-split, and a missing `gh` on PATH arriving as an unhandled
  `error` instead of a failed stage.
- Stage 6 must not pass `--reporter`: `playwright.config.ts` already configures `list` + `json`
  with the `outputFile` that this stage reads. Overriding the reporter sends the JSON to stdout and
  the stage then finds no report. It also deletes the stale report before running — reading the
  previous run's file is how a crashed run reports the last run's pass count.
- Ad-hoc probing of the live app is a throwaway script under `artifacts/`, run with `npx tsx`. If it
  calls `page.evaluate`, pass the body as a **string**, not a function: tsx/esbuild injects a
  `keepNames` helper into a serialized function expression, and the browser then dies with
  `ReferenceError: __name is not defined` — an error about the test harness, not about the page.
  (`page.evaluate` inside `src/**` is fine: Playwright's own transform is what compiles a spec.)

## Invariants enforced in code (not by prompt — do not "fix" these)

- **Managed regions**: generated code lives only between `// @digest:managed:start` and
  `// @digest:managed:end`. Everything outside is handwritten and never touched. Do not move
  handwritten tests into a region. Writing then reading a region must be a **fixpoint**:
  `readManagedRegion` strips the region's own base indentation, because otherwise the next run
  indents every held block again and the diff churns silently.
- **A managed block never carries an import.** The region is written inside a `test.describe(...)`
  callback, where an import declaration is a syntax error that breaks the *whole* spec file —
  handwritten tests included (it happened: TS1232, from a generated block that re-emitted the spec's
  own imports). The generator is told not to emit one, and `stripBlockImports`
  (`src/core/scenario/managed-region.ts`) makes that true on the write path in stage 2, naming each
  removal as a degradation. It runs on held blocks too, so a spec already committed broken repairs
  itself on the next digest. Clean code comes back byte-identical — the hold-as-is path is a
  fixpoint.
- **A managed block that reaches past the page object is refused, never stripped.** `blockViolations`
  (`src/core/scenario/managed-region.ts`) reports a block that calls the Playwright `page` API
  directly or calls `expect()` itself; stage 2 withholds such a block entirely and turns its scenario
  into an `unbuildable` work order, which is the shape the capability index already names for "the
  POM cannot express this yet". Withholding is the point, and stripping is not an option here:
  unlike an import, removing the offending lines leaves a test that still PASSES and asserts nothing.
  It is the write-path half of the two spec self-checks, and it was earned the hard way. On the first
  real PR the pipeline was pointed at, the digest wrote blocks that called `page.request.get` and
  `expect()` directly, the spec stopped compiling — nine TypeScript errors, taking twelve handwritten
  tests in that file down with it — seven more blocks asserted nothing at all (the report-only
  backstop flagged exactly those), and the run called itself a **success**.
- **The pipeline's gates run over its OUTPUT too, at the ship step.** CI runs
  `typecheck && self-checks` immediately BEFORE `npm run pipeline`, so nothing the pipeline writes
  has ever been through them: that same run's uncompilable spec was committed, pushed and opened as
  a PR under a green report. `shipGate()` (stage 8) runs both scripts over the working tree and
  **fails the stage** when either fails, instead of pushing. Returning a string would report a
  *succeeded* git stage and a run that shipped nothing and said nothing; a failed stage is what puts
  it under "Needs attention". The stage stays `fatal: false`, so the run still completes and its test
  results still stand — the refusal is about the delivery, not the evidence.
- **The PR body is the run's only durable record, so it carries the scope, not just the counts.**
  `artifacts/` is gitignored, so `summary.md` and `run-report.json` never reach the pull request
  they describe: a reviewer sees `buildPrBody`'s text and nothing else. The old body said only
  "Passed: 6 / Failed: 1", which cannot distinguish a whole-suite run from a narrowed one, and
  `1 failed` with no name and no accessible report is unactionable. It now states the tier and the
  grep that actually ran, what that filter left out, the scenarios stage 1 added, the verdicts, the
  blocked scenarios *and what each is missing*, the result, and that the PR is never auto-merged —
  and the workflow uploads `artifacts/` as the `pipeline-run` artifact so a red run's trace is
  reachable. Its scope lines come from `scopeCoverageLines` (`run-summary.ts`), never a second copy
  of the tier→tag rules: a PR body that quietly disagrees with the summary is the same silent
  smaller-green in a different medium.
- **The change under test and the repo that works are two things, and were one.** `WORK_REPO_SLUG` is
  the repo the pipeline *writes* to — branch, `git push`, `gh pr create`. The product CICD triggers
  this pipeline after its own deploy and passes the testing context with it, so the PR stage 1 reads
  lives in the **source** repo while everything the pipeline writes stays in the **work** repo (we do
  not put generated tests into the product repo). One slug could not serve both: reading the change
  with the work slug looked for PR #N in the wrong repository — failing, or worse, reading a number
  that happens to exist in both and testing the wrong change. Hence `SOURCE_REPO_SLUG` (optional —
  absent means `WORK_REPO_SLUG`, the single-repo case), read only by `fetchSource`. The same split bit
  the base branch: `manifest.branch` is the *source* PR's branch, and for a foreign source that ref
  does not exist in the work repo, so `git fetch origin <it>` would fail after the tests had already
  run. `deliveryBaseBranch()` (stage 8) therefore uses `SOURCE_BRANCH` when set and `main` for a
  foreign source, and both halves are self-checked. `REPO_SLUG` was renamed, not aliased: a stale
  container env fails loudly at the last step, which is the failure mode this repo prefers to silence.
- **The pipeline runs on a deployment, never on a pull request of its own work repo.** Stage 8 *opens*
  a PR in the work repo, so a `pull_request` trigger there is a loop: the pipeline would run against
  the generated tests it just opened for review, generate more from that diff, and open a further PR —
  each round completing under a green report. The workflow is therefore `workflow_dispatch`-only, and
  the entry the product CICD calls carries the testing context as inputs (`pr`, `source_repo`); a
  self-check fails if a `pull_request` trigger reappears.
- **A child process's stdout is the data; stderr is diagnostics, and our `DEBUG` is not its
  switch.** `runStageProcess` returns `stdout` and the merged `output` separately, and a caller that
  PARSES a result — JSON, a diff, a porcelain listing — must read `stdout`. Merged, a tool's chatter
  becomes a parse error, or worse, noise silently inside the payload. The concrete case: `gh` honours
  `DEBUG` as its debug switch (an alias for `GH_DEBUG`), and this pipeline hands every child its own
  `DEBUG`, so a run with `DEBUG=true` — which is what `.env` and the CI definition ship — made every
  `gh` call trace its HTTP requests onto stderr. Stage 1 then died on perfectly valid JSON
  ("expected JSON output"), and 297 characters of `* Request took 537ms` landed inside the diff fed
  to the model. Two bugs behind three green CI runs: those runs used `--from-scenarios`, which skips
  stage 1 entirely, so the PR path had never been exercised. `ghEnv()` now clears `DEBUG`/`GH_DEBUG`,
  and stage 8's "anything to ship?" reads `stdout`, or a git line-ending warning on stderr would look
  like a change and push an empty branch.
- **The scaffold and the writer agree byte-for-byte.** A domain's FIRST spec is composed whole by
  `scaffoldManagedSpec` (it needs a closed `test.describe()`); every later write goes through
  `upsertManagedRegion`. The file the scaffold writes is read back and rewritten by the writer on the
  next run, so any disagreement between them churns the diff exactly once — silently. It happened by
  one blank line before the closing `});`, so both now live side by side in
  `src/core/scenario/managed-region.ts` and a self-check asserts the scaffold is a fixpoint of the
  writer (and that the handwritten-with-no-region branch is too). `renderManagedRegion` trims a
  block with `trim()` rather than `trimEnd()`, for the same reason: the reader trims blank lines from
  both ends, so a leading blank line the generator emitted would otherwise survive one extra run.
- **A device profile is general digest knowledge.** `src/core/scenario/viewport.ts` owns the
  vocabulary (`mobile` / `tablet` / `desktop`), reads a profile out of a scenario's own words, and
  answers "can this page object express it?" — a page object that cannot set a viewport is a
  **stage-4 work order**, not a block that asserts the desktop layout at a phone width. Both halves of
  getting that wrong are silent: skip the viewport change and the test passes without testing
  anything; make it and the desktop assertions fail on a collapsed nav, which reads as a product bug.
  The mechanism is a capability, `useViewport(profile)`, with the sizes in `src/runtime/viewport.ts`
  — product-neutral, so a page object names a profile and never a pixel size.
- **"The layout fits" is two checks, and only the second one sees a widget that spills.** The
  document's scroll width is the cheap half — and it is BLIND to a child wider than its column: the
  Turnstile widget is a fixed 300px inside a 276px form column at 390x844, overflowing the form by
  24px while `scrollWidth` stays equal to `clientWidth`. So `expectNoHorizontalOverflow` also
  measures every in-flow element against the container it is laid out in (`measureLayoutSpill`,
  `src/runtime/viewport.ts`). Decoration is exempt — an `absolute`/`fixed` element is placed against
  a box rather than laid out in the flow, and anything inside one is exempt with it — and a clipping
  or scrolling container is exempt with its children, because that is what a carousel is. The
  decision is pure (`findLayoutSpill`) and driven by synthetic boxes in `self-checks`, because the
  easy thing to get wrong is the comparison itself: the first version asked `parentRight - childRight`
  and so reported every correctly sized element as overflowing by the slack around it.
- **A widget whose frame is never rendered cannot be measured, so its third-party constant belongs to
  the product.** Cloudflare injects NO Turnstile frame in an automated browser, in ANY `data-size` —
  `window.turnstile` exists, the hidden response field is populated, and `querySelectorAll('iframe')`
  is empty — so the visible 300x65 widget exists only in a real browser and no scan of the DOM can see
  the spill. The assertable form is the slot-versus-declared-size contract
  (`expectTurnstileFitsForm`), and the widget's fixed widths live in the page object, NOT in
  `src/runtime/`: machinery measures what is on the page, and a third-party constant is this
  product's business.
- **A moved block hash re-digests; the classifier is never asked about a stale block.** `digestPath`
  (stage 2) decides before any model call: no block → `classify` (a handwritten test may already cover
  the scenario); block with a moved hash → `redigest`; equal → `hold`. The middle case was wrong: a
  stale block carries the scenario's own *title*, and the coverage question was asked with that title
  in the list, so the block vouched for itself — the edit never reached the spec, and because it was
  carried forward with its OLD hash the same scenario was re-decided on every later run, forever, under
  a green report, while this file promised a tag edit regenerates the block. Re-digestion settles:
  the rewritten block carries the new hash and is held next run. A scenario file is the source of
  truth, so its hash is the signal.
- **The generator is given member *signatures*; the classifier is given *names*.** `CapabilityLookup`
  has both, on purpose. `catalog()` returns `name(params)` and feeds the generator, which writes the
  CALL — handed bare names, the model read `expectHeroCtaTargets(href: string)` as a zero-argument
  assertion, omitted the `href`, and the whole spec failed to compile (TS2554). `all()` returns bare
  names and feeds the classifier, which answers WITH names that are then matched against the surface;
  a signature there would make every claimed capability look like a missing one. A param list is
  captured only when it is unambiguously one (no nested parens, no quotes), because a *wrong* hint is
  worse than none — the model will satisfy it exactly.
- **The manifest round-trips, and holds no `Map`**: a `Map` handed to `JSON.stringify` becomes `{}`
  with no error, so one left in the manifest silently empties the digest. The manifest therefore
  stores plain arrays/objects only — `scenarios[]` rows carry `verdict` + `reason` — and a
  self-check asserts no `Map` hides anywhere in it. Verdicts and stage-2 work orders are persisted,
  which is what lets a single stage be re-run from disk (`npm run stage:<n>`).
- **Scenarios are the source of truth**: a block is held as-is when its content hash is unchanged,
  and regenerated only when its inputs move. Regeneration is keyed on inputs, not on a verdict —
  `digestPath` reads the hash before any model call, so a moved hash re-digests whether or not a
  verdict would have called the scenario covered.
- **Fail open, always**: degraded input widens the run to the full suite with a named reason
  (`src/planning/planner.ts`). A malformed config value **throws** rather than silently defaulting.
  The one exception is not a degradation: a human's explicit instruction (below) is absolute.
- **Stage 5's agent proposes; code decides.** `src/ai/test-planner-agent.ts` chooses `smoke` /
  `sanity` / `regression` from stages 1 and 2 and returns a **name plus a reason** — never a
  `--grep`. `planner.ts` maps the name to a filter, enforces the floor and owns every fallback, so a
  model that answers `smoke` on a change that broke everything cannot hand a reviewer a smaller green
  run. The vocabulary is `config/tiers.json` alone, read by the planner and handed to the agent —
  it used to have three copies (planner, summary renderer, and a JSON file nothing read), which is
  why an operator could edit it and change nothing. A tag list on `regression` **throws**: it would
  drop every untagged test from the run the summary calls "everything".
- **A scope selects by tag, not by title.** `src/core/scenario/test-tags.ts` writes the scenario's
  tags onto the generated `test(...)` call. A `--grep` that matches titles alone drops a test the
  moment a generated title disagrees with the scenario title — silently, as a *smaller green run*.
- **The floor is the creation-date tag, not a title list.** Stage 2 stamps `@YYYYMMDD` (the run's
  start date, UTC, from `runDateTag`) on every block it generates, and the planner puts that tag in
  every non-regression grep, so everything generated this run always runs. The tag is written once
  and read back off the block on a hold (`dateTagIn`): re-stamping "today" would rewrite every
  generated block's tag option once a day — churn nobody reads in a diff. Generated titles are kept
  as a second net. The summary's "what did NOT run" note is rendered from the grep that ran, not
  from a restatement of the rules, so it cannot disagree with the filter.
- **Never persist an absolute path**: committed artifacts store repo-relative POSIX paths; use
  `src/core/util/paths.ts` (`rehydrate` / `toRepoRelative`), never hand-strip prefixes.
- **Three env registration points**: a variable must exist in the CI definition
  (`.github/workflows/pipeline.yml`), the container environment, and `.env.example`. Tests run
  *inside* the container, so a value set only in a CI step shell silently misses them. That is about
  *configuration*, read through `core/util/env.ts`. Three variables are deliberately not among these:
  `HEAL_RUN_ID` is per-run plumbing that stage 6 passes into the Playwright child process, so it
  cannot be missing where the tests run; `TEST_GREP_SOURCE` is the same class — derived by the
  workflow per run so stage 5 can tell an override a person typed into the manual trigger from a
  stray value narrowing a CI run, and read from `process.env` rather than through `env` for exactly
  that reason; `TEST_GREP` is an **operator override** — a standing value in the CI definition would
  pin every run to one person's filter, silently. It is therefore a `workflow_dispatch` **input**,
  not a job-level `env`, and `npm run self-checks` fails unless each assignment of it (and of
  `TEST_GREP_SOURCE`) is sourced from `${{ inputs.* }}` (a bare `${TEST_GREP:-}` in a log line is a
  reference, not an assignment, and is allowed — the distinction is the point of the check).
  `SOURCE_REPO_SLUG` and `WORK_REPO_SLUG` are ordinary ones of these three points, with the CI end
  supplied as `workflow_dispatch` inputs — that is where the product CICD hands over the testing
  context (which PR, in which repo) when it triggers a run after its deploy. An empty input reads as
  unset, which is the single-repo case.
- **A human's `TEST_GREP` is absolute, and the only thing the floor steps aside for.** It *is* the
  filter: stage 5 skips the planner agent entirely (asking a model for a scope you are about to
  discard costs a call and leaves a reason nothing acted on) and `planTier` returns it verbatim without
  the floor. A person who typed `@smoke` does not want surprise extras, and the human is the merge gate
  the way a hand-edited `domain-map.json` entry stays authoritative. What absolute does NOT mean is
  silent: `grepOverride` is persisted so the summary reports an *override* rather than a planned scope
  (otherwise a `grep: @smoke` read six months later misattributes the decision to the agent), it names
  what the override excluded, and it shouts about any test **this run wrote** that the override drops —
  the one outcome the floor exists to prevent, now reachable and therefore announced. What *is*
  announced about the override itself is a stray one: on a CI run, an override that did not come from
  a run-time input is named as a leftover, because a value nobody typed narrowing the run is the
  silent smaller-green again — whereas one a person typed into the manual trigger is reported as the
  decision it is, not misattributed as a leftover.
- **Additive-only agent writes** + `src/agent/write-scope-guard.ts` reverts out-of-scope or
  destructive edits. The builder adds; the healer repairs. Two writers never touch the same lines.
- **A heal is an exact string substitution, so what it rewrites must be expressible as source text.**
  `src/runtime/heal-locator.ts` heals two ways: narrow the CSS selector that broke, or take the
  nearest on-page copy to the copy that broke (uniquely nearest, above a high similarity floor — two
  near-identical candidates are a coin toss and are *not* taken). A copy record is the `'<text>'`
  literal, quoted, because a naked fragment also occurs inside assertion messages. Only then does
  stage 7 rewrite the file. A record whose broken locator is no longer in the file is *skipped and
  named*, never silently dropped — and because nothing applied, the domain reports
  `healApply: failed`. The stage is non-fatal, so saying so costs nothing. A given heal is recorded
  once however many times it is re-healed: one locator is resolved once per use, and six identical
  records make stage 7 apply one and "skip" five.
- **A heal is verified by the test that used it, and only a verified repair is written to the
  source.** A record carries the failure that prompted it (`observed`), the test(s) that used it, and
  the worst `outcome` across those uses — `test-passed` / `test-failed` / `unknown`, where `unknown`
  ("nobody said") yields to whatever a later use knows, and `test-failed` beats `test-passed`. The
  fixture stamps that (`beginTest` / `endTest`, from `titlePath` and `testInfo.status`); the healer
  stays free of test context. This is not decoration: a repair whose test failed is evidence *against*
  it, and folding it in would bake a wrong locator into the source while the failing test disappears —
  the silent green this repo exists to prevent. So `repairable()` in stage 7 filters to `test-passed`,
  and each declined repair is named as a degradation. It is correlation, not proof — a test can fail
  for reasons of its own, so `test-failed` means "nothing passed on this locator", not "this locator is
  wrong" — and that is enough to withhold the patch, because the runtime keeps healing meanwhile.
  The outcome is then **announced where a person reads it**, never only in `heals.json`: the test
  carries a `heal` / `heal-refused` annotation (the HTML report renders it under *Annotations*), and
  the worker prints a `[self-heal]` block at teardown. A clean run prints and annotates nothing. Drop
  either and a healed pass reads exactly like a healthy one, which is the silent green this repo is
  built to avoid — so both are self-checked.
- **A run is not one process, so a heal save merges within a run and replaces across runs.**
  Playwright restarts the worker after a failing test; each worker builds its own collector, and
  saving as an overwrite let the second teardown erase the first one's records — a run with a single
  failure lost exactly the heals it most needed to report, silently. `heal-manifest.ts` names the run
  (`HEAL_RUN_ID`, which stage 6 sets from the manifest's run id; a bare `npm test` falls back to
  `ppid:<parent>`, the test runner all its workers share): the same name unions by identity with the
  worst outcome winning, a different one replaces. A file that exists but does not parse is a defect,
  and `loadReport()` throws rather than reading as "no heals this run".
- **The healer refuses, with a named reason, and refusal is not a bug.** Healing exists to repair a
  stale source line; repairing "the feature is gone", a timing failure, or an assertion that failed
  for a non-locator reason would turn a real regression into a green lie. So `heal-locator.ts`
  records a refusal (`no-candidate` / `ambiguous` / `not-unique` / `locale-mismatch`) with the
  observation that backs it, and the summary renders it under `## Locator heals` beside the repairs —
  carrying the test that hit it and whether that test went red, because a refusal the test sailed past
  (an element that rendered a moment later) is a different story from a refusal next to a failing
  test. A strict-mode violation is healed *only* by a narrowing that resolves to exactly one element —
  never `.first()`, which asserts against whichever match came first in the DOM. Do not "fix" a
  refusal by widening the search.
- **Copy healing is locale-bound; structure healing is not.** Copy is the one thing that is not
  locale-independent, and this product serves `/en` and `/id` from the same structure with different
  words. `byCopy` declares its locale and refuses to heal in another one: the Indonesian
  `"Portofolio"` is 0.90 similar to the English `'Portfolio'`, so an unguarded run against `/id`
  would rewrite the English copy and break `/en`. A CSS/id heal carries no such guard because the
  structure is shared.
- **A stage record is upserted by name, never appended.** `npm run stage:<n>` re-runs one stage from
  the manifest on disk, in a new process, so the same name is recorded repeatedly. As a `push` that
  accumulated: seven identical `heal-apply` lines in the summary, the stale ones keeping their
  degradations (from a run hours earlier) and their `failed` status, so a re-run that FIXED a stage
  still reported it failed. Duplicates already on disk are collapsed when the name is re-recorded.
- **Self-checks run sequentially, on purpose.** They touch the filesystem — a scratch page object, a
  restored `heals.json` — and running them concurrently let two of them interleave over one path,
  producing failures that looked like bugs in the code under test. A self-check that writes an
  artifact shared with another must also restore it (`withScratchHeals`), or it silently deletes the
  heals a previous run recorded.
- **Test results are recorded as-is** — never reverted or filtered on failure.
- **One bounded pool** (`src/core/util/pool.ts`) for model calls; domains are deliberately **not**
  parallelised because the manifest is threaded through them one at a time.
- **Prompt substitution is strict**: `substitute()` throws when a `{{PLACEHOLDER}}` is unfilled, so
  keep templates in `src/ai/prompts/*.md` and TS-injected fragments in sync.
- **One indirection**: domain identity comes from `scenarios/*.txt` filenames (lowercase) plus
  `config/domain-map.json`. No feature name is hard-coded in the orchestrator.

## Test authoring rules

- **Assertions live in the page object, not the spec.** A spec navigates and calls
  intent-revealing `expect*()` methods on the POM; it never imports or calls Playwright's
  `expect` itself. This is load-bearing, not style: it keeps every assertion inside the
  capability index, so a scenario the POM cannot assert is classified `blocked` and becomes a
  builder work order instead of a hand-rolled `expect` in a spec.
- **Every assertion carries a message.** `expect(locator, 'what this checks')`. A failure that
  prints two locator strings instead of the intent is not reviewable.
- **Name assertion methods `expect<Thing>()`**, return `Promise<void>`, and keep the raw
  locators as getters for the assertion bodies to use — except the locators that can heal, which
  resolve through a healer instead (see below).
- **A healable locator resolves through the POM's own helper, and how it heals depends on how it
  identifies the element.** A raw CSS string goes through `loc()`; an element identified by its text
  or accessible name goes through `byCopy(text, build)`, where `text` is written as a single-quoted
  literal (the heal record substitutes `'<text>'`, so a naked fragment would also rewrite assertion
  messages that contain it). A locator that can do neither — `getByRole('heading', { level: 1 })`,
  `getByText(/regex/)` — stays a plain getter.
- **A spec imports the healing fixture, not `@playwright/test`.** `import { test } from
  '../../src/runtime/self-heal-fixture.js'` attaches the run's heal collector to the page. A plain
  import compiles, passes, and heals nothing — an invisible failure, so `npm run self-checks`
  enforces the import in every `tests/**/*.spec.ts`.
- **A spec never calls the Playwright `page` API.** No `page.setViewportSize`, no `page.locator`, no
  `page.goto` inside a block: navigation, viewport control and assertion are all page-object
  capabilities. This is what `src/page-objects/landing-page/index.ts` exposes `useViewport(profile)`
  for. A raw `page` call is outside the capability index, cannot heal, and cannot be reviewed as a
  capability — and it is how a generated mobile test came to resize the viewport itself and then fail
  on a collapsed nav. `npm run self-checks` scans every managed region for `page.` and fails if it
  finds one.
- **A spec imports the page-object class its generated blocks instantiate.** The scaffold derives the
  import from the domain map (`className` + `pomDir`), not from a hardcoded `../../`, and emits it
  only when a block actually names the class. A spec that instantiates a class nothing imports is
  TS2552 for the WHOLE file — which is exactly what a delete-and-regenerate produced, because the
  scaffold imported only the healing fixture. `npm run self-checks` enforces it.
- **Tags come from the scenario file and are written by the machinery.** `Tags: @smoke @core` in a
  scenario becomes `test('<title>', { tag: ['@smoke', '@core'] }, …)`, applied by
  `src/core/scenario/test-tags.ts` on every run — never trusted to the model. A scope selects tests
  with `--grep @smoke|@core`, so an untagged test is invisible to it. A handwritten test opts into a
  scope by tagging itself; a scenario's tag edit moves its content hash, so the block is regenerated
  with the new tag. The creation-date tag (`@YYYYMMDD`) is added by the same machinery, from the run
  date, and is never a scenario's to declare.
- **Some of what a scenario must assert is not on the page at all.** The concrete case: Cloudflare
  never injects its Turnstile frame in an automated browser, in any `data-size`, so the widget that
  spills out of the inquiry form is invisible to every measurement — a person saw it and the test did
  not. What is assertable is the **contract**: the slot declares a widget size and must be at least
  that wide. The vendor constant belongs in the page object, beside the reason
  (`TURNSTILE_WIDGET_WIDTH` in `src/page-objects/landing-page/index.ts`), because machinery measures
  what rendered and knows no vendor's pixels. A test that waits for a frame that never appears
  measures nothing and passes.
- **These rules are enforced by `npm run self-checks`**: no `expect(` in `tests/**/*.spec.ts`, every
  `expect(` in `src/page-objects/**` passes a message as its second argument, every spec imports
  the healing fixture and its page-object class, every managed region is free of imports and of raw
  `page.` calls, every POM member hint in the generator catalog is a clean parameter list, the layout
  spill decision answers correctly for a widget wider than its column and exempts decoration and
  scrolling containers, and a moved block hash re-digests a scenario instead of consulting the
  classifier.

## Product-owned vs machinery

Machinery (packaging, parser, planner, runtime, delivery) is product-neutral — change it carefully.
These are meant to be filled per product, not "fixed":
- `scenarios/<domain>.txt` — one per feature area; **filename casing is load-bearing** (map is keyed
  lowercase; mixed case silently creates a second empty entry). This file is also the **only lever
  that moves a generated block**: a block's hash is taken from its scenario's text, so changing a test
  means changing the scenario and re-running stage 2 (`digestPath` re-digests on a moved hash). The
  spec is not a lever — outside the managed region nothing is generated, and inside it the next digest
  overwrites the edit.
- `config/domain-map.json` — hand-author `entryPaths`, `needsAuth`, `entryDiscoverySteps`; the model
  may only backfill structural fields, and manual edits stay authoritative.
- `config/scope-rules.md` — what this product deliberately will not test, and why.
- Product sections of `src/ai/prompts/*.md` (they ship as neutral seeds).
- `src/page-objects/<domain>/instruction.md` — append-only domain context: how that feature area
  actually works. Read and written by the builder, and fed to test-case generation (stage 2). **Never condense**
  (see `pipeline-pattern.md` §7); a trimmed line regrows as wrong code on the next run. Note what it is
  *not*: it does not move a block's hash, so appending here changes only what a **future** generation
  is told — a block that is already held stays exactly as it is. Pair the instruction with a scenario
  edit when a change has to land.

## Current state / gotchas

- Stage 3's builder is `src/agent/cdp-builder-stub.ts`: it launches a browser and appends to the
  instruction file but generates **no page-object code**, so POM-dependent generation and the
  stage-4 "unbuildable" retry do not work end to end yet. Wiring a real agent CLI is the planned swap.
  It appends a fact only when the file does not already carry it (`freshObservationLines`): an
  earlier version stamped a timestamped `## <timestamp> — stub builder run` section with the page's
  body text on every run, so the landing-page file had three near-identical sections and added a
  fourth each time. The per-run observation now goes in the stage summary instead.
- `--from-scenarios` skips **only stage 1**. Stage 2 always runs, so the digest still hits the model
  and still records every scenario's verdict.
- `--dry-run` skips only stages 6 (playwright) and 8 (git); stages 2/3 still hit the model and the
  browser, and stage 5 still asks the planner agent, so it is not an offline run.
- `npm test` needs a live app at `BASE_URL` plus installed chromium; the default
  `http://localhost:3000` is logged loudly when unset.
- `scenarios/demo.txt`, `tests/demo/`, and the empty `src/page-objects/` are
  seeds. Delete the demo before adopting (README §"Adopting this boilerplate").
- `artifacts/` is gitignored generated output: the human-readable summary
  `artifacts/run/summary.md` (also printed at the end of a run), the machine
  manifest `artifacts/run/manifest.json`, the redacted stage audit trail
  `artifacts/run/run-report.json`, Playwright's JSON
  `artifacts/run-report/test-results.json`, and the runtime heal story
  `artifacts/run/heals.json` — `{ run, heals[], refusals[] }`, written by the healing fixture at
  worker teardown (merging across the workers of one run), read by stage 7 and rendered into
  `summary.md` under `## Locator heals`.
- Self-healing is **wired and demonstrated**, two ways: narrow a CSS locator the app renamed, or
  typo the copy in a `byCopy(...)` locator. Either way the test passes on the healed locator, one
  record lands in `heals.json`, `npm run stage:7` rewrites the source line, and the next run is
  clean (`heals.json` = no heals). It also **refuses**, and both refusals are demonstrated: a copy
  with nothing near it (`no-candidate`, whose detail names the nearest copy and its similarity —
  0.16 in the landing-page case) and a run in the wrong locale (`locale-mismatch`; the `/id` nav says
  `"Portofolio"`, 0.90 similar to the English `'Portfolio'`, so the guard is load-bearing, not
  theoretical). A refusal leaves the test red, which is the point. And the outcome is demonstrated
  the same way, both ways: a repair a passing test backed lands in the source, while
  `'Pricin' → 'Pricing'` — a typo the healer repointed at the *neighbouring* link, uniquely, so the
  repair resolved and the assertion then failed — is recorded `test-failed`, declined by stage 7, and
  named as a degradation, leaving the source untouched. Four things the healer is
  **not**: there is no model in the path (a narrowing of the broken selector, or the
  uniquely-nearest on-page copy), it only touches locators resolved through the POM's `loc()` /
  `byCopy()` (a `getByRole(..., { level })` or a regex carries neither a copy nor a string), it is
  inert unless the spec imports `self-heal-fixture.js`, and it does not heal a copy whose text comes
  from the scenario (`nicheFilter(niche)`) — that text is not in the page object, and the scenario is
  the source of truth for what it claims to test.
- The manifest's readable half is `scenarios[]`: one row per scenario carrying
  `verdict` + `reason` beside its title. Prefer it over joining anything by
  scenario id. Keep Maps out of the manifest entirely — `JSON.stringify`
  writes `{}` for a Map with no error (enforced by a self-check).
