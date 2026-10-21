# tcgen — an AI test-pipeline boilerplate

A reusable **pattern**, not a library. Reads an issue + diff, works out which
areas of the app the change puts at risk, checks that risk against existing
coverage, writes missing scenarios in plain English, turns them into specs,
builds page objects by driving the live app, runs the suite, folds in
locator repairs, and opens a PR. A human reviews the PR; nothing merges itself.

This boilerplate implements the pattern from `pipeline-pattern.md` on latest
Playwright (1.63). See `PLAN.md` for the implementation plan and `pipeline-pattern.md`
for the design decisions this code enforces. `WORKFLOW.md` has the pipeline as
Mermaid diagrams — the workflow, and the three decisions worth knowing on their own.

## Quick start

```bash
npm ci
cp .env.example .env            # fill in BASE_URL, MODEL_API_KEY, WORK_REPO_SLUG, ...
npx playwright install chromium
npm run self-checks             # cheap invariants, no browser
npm test                        # playwright run against BASE_URL
npm run pipeline -- --pr 123    # run all 9 stages against PR #123
npm run stage:2                 # re-run ONE stage against the last manifest
npm run stage:3 -- --domain landing-page
```

## Re-running a single stage

`npm run stage:<n>` (or `npm run stage -- <n|name> [options]`) runs one stage
against the manifest the previous run left in `artifacts/run/manifest.json`.
Stages 1 and 2 *start* a manifest; stages 3–9 *consume* it and refuse to guess
when it is missing.

```bash
npm run stage:2                              # hold unchanged blocks, regenerate moved ones
npm run stage:3 -- --domain landing-page     # build missing POM capabilities
npm run stage:5                              # planner agent: scope + --grep
npm run stage:6 -- --grep @core              # playwright run
npm run stage:1 -- --pr 123                  # needs --pr (reads the issue + diff)
npm run stage:8 -- --dry-run                 # mark git skipped instead of committing
npm run stage:9                              # re-send the report to the chat
```

| Option | Meaning |
|---|---|
| `--domain <key>` | required for stages 3/4 when the manifest holds more than one domain |
| `--pr <number>` | required for stage 1 |
| `--grep <expr>` | override the planner's grep for stage 6 |
| `--dry-run` | mark stages 6, 8 and 9 skipped instead of running them |

## Running it

A run answers a **deployment**, not a pull request: the product CICD triggers it after its own
deploy and hands over the testing context — the PR whose change is under test, and the repo that PR
lives in.

```bash
gh workflow run test-pipeline -f pr=123 -f source_repo=owner/product
gh workflow run test-pipeline -f pr=123 -f source_repo=owner/product -f test_grep=@smoke
gh workflow run test-pipeline -f from_scenarios=true           # digest what is already there, no PR
gh run watch                                                   # follow the run you just started
```

| Input | Meaning |
|---|---|
| `pr` | The testing context: the PR whose change is under test, read from `source_repo`. |
| `source_repo` | `owner/name` that PR lives in. Empty = this repo. |
| `from_scenarios` | Skip stage 1 and digest the scenario files as they are — no PR needed. |
| `dry_run` | Skip stage 6 (browser), stage 8 (git push/PR) and stage 9 (report). |
| `test_grep` | The operator override above, typed per run. Empty = let the planner decide. |
| `base_branch` | Branch for stage 8 to base the delivery branch on. Empty = `main`. |

A run must be told *something* — a PR number, or `from_scenarios`. Given neither, it stops with an
error rather than proceeding against an empty change set.

Without `source_repo` the run is about a PR in the **work** repo itself (where the tests are
delivered). With it, the change under test lives elsewhere: stage 1 reads that PR and reports back to
it, while the branch, commit, push and PR stay here.

Locally the same context comes through the environment:

```bash
SOURCE_REPO_SLUG=owner/product WORK_REPO_SLUG=owner/tests npm run pipeline -- --pr 123
```

## Reading the output

Three artifacts come out of a run, and they answer different questions:

| Artifact | Answers |
|---|---|
| `artifacts/run/summary.md` | **"What just happened?"** Also printed to the console at the end of the run. One line per scenario with its verdict *and the reason for it*, then the per-domain facts, what needs attention, and the stage timeline. |
| `artifacts/run/manifest.json` | The machine record that threads the stages together. `scenarios[]` is one row per scenario — domain, id, content hash, title, tags, verdict, reason — so it reads on its own. |
| `artifacts/run/run-report.json` | The redacted audit trail: every stage's verbatim output. |

Four verdicts per scenario:

| Verdict | Means |
|---|---|
| `generated` | A new test block was written this run — either the scenario's first one, or a **re-digest** because the scenario's text (and therefore its hash) moved. |
| `held` | The existing block matched its scenario unchanged, so it was kept verbatim. |
| `covered` | **No test was written** — the classifier judged an existing test already covers this. The reason names that test. Reachable only for a scenario with **no block at all**: a stale block never gets this far, it re-digests, or an edited scenario could be marked covered by the very block that still asserts its old text. |
| `unbuildable` | The page objects cannot express it yet, so it became a stage-4 work order (`test.fixme`). |

## Reporting the result

Stage 9 (`notify`) posts the run to a Telegram chat, so the result reaches people who are not
watching the Actions tab. It is off unless both variables are set:

```bash
TELEGRAM_API_KEY=<bot token from @BotFather>
TELEGRAM_CHAT_ID=<the chat to post to>
```

Send the bot a message, then ask Telegram which chat that was:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_API_KEY/getUpdates"
```

On GitHub, `TELEGRAM_API_KEY` goes in **secrets** and `TELEGRAM_CHAT_ID` in **variables** (a chat id
is not a credential; a bot token is).

The message carries what the summary carries, because a chat is read out of context: the source PR,
the tier and the grep that actually ran **and what that filter left out**, the per-domain pass/fail,
what this run wrote or could not cover, and the PR when stage 8 opened one. There is no separate
configuration for what it says — a report that could disagree with the summary would be the same
smaller green in another medium.

It opens with **two labelled statuses**, because a failed test and a broken pipeline are different
problems and one verdict for both sends someone to fix the wrong one:

```
Pipeline run 36bed620 · @core scope only

Testing Status: ❌ 1 test failed
Pipeline Status: ✅ Nothing needs attention

Not a verdict on the whole suite — this is the @core scope; tests outside it were not run.
```

`Testing Status` is the product — what the browser run found. `Pipeline Status` is the process —
whether the run did its job. A failed test leaves every stage `succeeded`, which is why the two never
share a colour. The scope is named in the first line when the run was narrowed, and the line under
it says what a narrowed pass is *not*, so `✅` can never read as "the suite is green".

A message that cannot be sent **fails the stage** — non-fatal, so the run's results still stand and
the run still exits 0 — rather than reporting a success, because a report nobody received must not
look like one that arrived. With neither variable set, the stage says so and sends nothing: that is a
legitimate setup, not a defect. `npm run stage:9` re-sends the last run's report from the manifest on
disk, without re-running anything.

## Debug logging

`DEBUG=true` narrates a run while it happens. Off by default, and it changes nothing
about what a run *does* — it is observation, not a mode.

```bash
DEBUG=true npm run pipeline -- --pr 123        # the whole 9-stage run
DEBUG=true npm run stage:2                     # one stage, against the last manifest
DEBUG=true npx playwright test --grep @smoke   # the page objects, inside a test
npx playwright test --grep @smoke              # quiet again
```

Every line carries the values behind the decision it describes — `domain`, `scenario`,
`model`, `verdict`, counts, milliseconds — so a run can be followed without reading the
code. The AI calls get a boxed rendering of the whole interaction (model, budgets, every
message, the completion, token usage, duration), and long input is clamped with an
ellipsis that says how much was cut:

```
[debug] classify start scenario="0a2449eb255e0476" title="The landing page loads with the site title" tags=["@smoke", "@core"] existingTitles=1 pomMembers=3
[debug] ┌─ ai.request deepseek-v4.1-flash
[debug] │   model=deepseek-v4.1-flash max_tokens=500 temperature=0 reasoning=none deadline=30000ms
[debug] │   messages=2 chars=5861
[debug] │   ── user [2/2] 5794 chars ──
[debug] │   Classify this test scenario for coverage and buildability.
[debug] │   …
[debug] │   … (+4594 chars cut)
[debug] └─
[debug] ┌─ ai.response deepseek-v4.1-flash
[debug] │   finish=stop duration=1653ms chars=337 prompt_tokens=1132 completion_tokens=80 total_tokens=1212
[debug] │   {"alreadyCovered": false, "pomCanExpress": true, "membersUsed": ["goto", "expectSiteTitle"], "reason": "…"}
[debug] └─
[debug] classify verdict scenario="0a2449eb255e0476" kind="novel" membersUsed=["goto", "expectSiteTitle"] ms=1656
```

The page objects narrate the same way (`[debug] pom:landing-page goto path="/en"`,
`byCopy`, `loc`, each `expect*`), so a spec — which is a thin layer by design — can be
followed without adding anything to it.

`DEBUG` is registered at all three points (CI definition, container env, `.env.example`),
and a self-check fails if it goes missing: a toggle that is silently off is one someone
will swear they turned on.

## Tags and scopes

A scenario declares its tags in its own file:

```
TEST: The pricing section lists all six packages
Tags: @core
```

Stage 2 writes those tags onto the generated test, so they are real Playwright tags:

```ts
test('The pricing section lists all six packages', { tag: ['@core'] }, async ({ page }) => {
```

## Who decides what runs

Stage 5 asks a **planner agent** which scope the run deserves, from what stages 1
and 2 already worked out — the risk areas the change touches, and the digest verdict
for every scenario:

- `smoke` — the critical paths only (`@smoke`)
- `sanity` — the always-run key tests (`@smoke`, `@core`)
- `regression` — the whole suite, no filter. Also the fail-open fallback.

The scope vocabulary lives in `config/tiers.json`, read by the planner *and* handed
to the agent, so there is one definition rather than a hard-coded copy per module. A
malformed value there throws rather than defaulting.

The agent **proposes; code decides**. It returns a name and a one-line reason —
never a `--grep` — and `src/planning/planner.ts` turns that into the filter, enforces
the floor, and fails open. So a model that answers "smoke" on a change that broke
everything cannot hand a reviewer a smaller green run:

- **Everything generated this run always runs.** Stage 2 stamps each freshly
  generated block with a creation-date tag, `@YYYYMMDD` (the run's start date, UTC),
  and the planner puts that tag in every non-regression grep. The tag is written
  once, at generation, and read back off the block on a hold — so a test keeps the
  date it was made instead of being re-stamped daily.
- **A builder failure widens one step** (`smoke → sanity → regression`), and an
  agent that errors or returns garbage, or a filter that matches nothing, widens to
  the full suite. Each widening is named in the report.
- The summary always says what did **not** run, read from the grep that actually
  ran rather than a second copy of the rules — so the note cannot disagree with the
  filter.

### When the human decides instead

`TEST_GREP` — set in `.env`, or exported for one run — makes the filter an operator's
own, and **skips the planner agent entirely**. Asking a model to pick a scope and then
discarding the answer would cost a call and leave a reason in the report that nothing
acted on.

```bash
TEST_GREP=@smoke npm run pipeline -- --pr 123
```

It is **absolute**: `TEST_GREP` *is* the filter, and the floor is deliberately not
applied, because someone who typed `@smoke` does not want surprise extras. That is the
one place the enforced floor steps aside — the human is the merge gate, the same way a
hand-edited `domain-map.json` entry stays authoritative. Absolute in effect is not the
same as silent, though: the summary reports the override (rather than reading like a
planned scope), names what it left out, and **shouts** when the override excludes a test
*this run wrote*.

`TEST_GREP` is never a **standing value** in the CI definition — that would pin every run to one
person's filter, silently, and `npm run self-checks` fails unless every assignment of it is sourced
from a run-time input. On the manual trigger it *is* such an input, because a form a person fills in
per run is the same instruction as a command they typed, just delivered differently — and a CI run can
therefore say which it was. An override that arrived from anywhere else is named as a *leftover*
rather than accepted as a decision, which is the one thing about an override worth flagging.

That is what makes a scope a tag filter rather than a title filter:

```bash
npm run stage:6 -- --grep @core          # tag, so a rewritten title cannot drop the test
npm test                                 # no filter — everything, whatever the tags
```

The tag is derived from the scenario every run, never trusted to the model: a model that forgets it
would produce a *smaller green run*, which is not an error anyone sees. A **handwritten** test opts
into a scope by tagging itself — an untagged test is invisible to `--grep @smoke|@core`, and the run
summary says so explicitly ("Tests carrying no tier tag are not run either — except the ones
generated in this run, which always run").

## Self-healing locators

A locator that stops resolving is usually a broken *source line*, not a broken app: the app moved and
the selector did not. The runtime healer catches that while the run is happening.

A spec imports the healing fixture instead of `@playwright/test`:

```ts
import { test } from '../../src/runtime/self-heal-fixture.js';
```

That override attaches the run's heal collector to the `page`. A page object that resolves a locator
through a healer (`heal-locator.ts`) then survives the drift: the test proceeds with a working
locator, and the substitution is recorded in `artifacts/run/heals.json` — together with **whether the
test that used it passed**, which is the only thing that says whether the repair was any good. Stage 7
folds a *verified* record into the source afterwards — never mid-run, because two writers never touch
the same lines.

There are two things that go stale, so there are two healers:

| Healer | For | Heal |
|---|---|---|
| `this.loc(selector)` | a raw CSS string | narrow the selector that broke |
| `this.byCopy(text, build)` | an element identified by **copy** — its text, or its accessible name | the nearest on-page copy |

```
CSS:  this.loc('[data-test="contact-section"]')          →  this.loc('[data-testid="contact-section"]')
copy: byCopy('Marco and Product Photographer', …)        →  byCopy('Macro and Product Photographer', …)
```

A locator that can do neither stays a plain getter: `getByRole('heading', { level: 1 })` carries no
copy to drift and no string to narrow, and `getByText(/regex/)` has no literal to correct.

Two properties matter more than the healing itself:

- **There is no model in this path.** A CSS candidate is a mechanical narrowing of the selector that
  broke (drop a trailing qualifier, re-express `data-test` as `data-testid`). A copy candidate is the
  nearest on-page text, and only when it is uniquely nearest *and* its similarity is above a high
  floor — two near-identical candidates are a coin toss, so neither is taken. A guessed locator that
  is wrong does not fail: it asserts against the wrong element and passes, which is worse than the
  honest failure it replaced.
- **Healing is inert unless you opt in.** A spec that imports plain `@playwright/test` heals nothing,
  and every locator resolves as before. It is additive, not load-bearing. `npm run self-checks`
  fails if a spec in `tests/` forgets the import, because that failure is otherwise invisible.

`byCopy`'s copy must be written as a single-quoted literal, because the heal record substitutes
`'<text>'` in the file. A naked fragment like `Contact` also occurs inside assertion messages, and a
heal that rewrote those would corrupt them — so the record is quoted and lands on the copy only.

### A heal is only as good as the test that used it

A repair is a claim — *"this locator still addresses the same element"* — and the healer cannot settle
it. The assertion can. So a record carries the failure that prompted it (`resolved to 0 elements;
nearest copy "Macro and Product Photographer" (0.97)`), the test that used it, and what that test did:

| Recorded outcome | What it means |
|---|---|
| `test-passed` | the test passed on the repaired locator: the repair is **verified**, and only a verified repair is written into the source |
| `test-failed` | nothing passed on it: **not** written into the source, and named as a degradation |
| `unknown` | no finished test used it (an interrupted run): nothing backs the claim, so it is not written either |

That is the difference between a green run and a green run *because of* the healer — before the
outcome, the two were indistinguishable, and `heals.json` looked the same either way.

So it is said where a person is actually looking, not only in that file. The worker prints a block
when it ever healed anything, and the test itself carries a `heal` annotation (the HTML report shows
it under *Annotations*, on the test's own page):

```
[self-heal] 1 locator repaired:
  - 'Macroz and Product Photographer' → 'Macro and Product Photographer' (the test passed on it)
```

A clean run prints nothing and annotates nothing. Without this, the work lived in a JSON artifact
nobody opens and the console said "1 passed" — which is how a healed pass stayed invisible even while
the trace was showing the healer's two `count()` calls.

The correlation is deliberately modest: a test can fail for a reason of its own, so `test-failed` says
*"nothing passed on this locator"*, not *"this locator is provably wrong"*. That is enough to withhold
the patch. Applying a repair whose test failed bakes a locator we have evidence against into the
source, and the next run is green on it — a wrong locator, committed, failing test gone. The runtime
keeps healing meanwhile, so declining costs nothing while a human looks at it.

`heals.json` also names the run it describes, because **a run is not one process**: Playwright restarts
the worker after a failing test, so one run has several collectors, and the second teardown would
otherwise erase the first one's records — a run with a failure silently losing exactly the heals it
most needed to report. A save therefore merges within a run and replaces a previous run's file.

### The healer is allowed to refuse

Healing exists to repair a stale *source line* when the app moved. The moment it also repairs "the
feature is gone" or "the test is wrong", it converts a real regression into a green lie — so refusing
is the other half of the healer's job, and it refuses loudly.

| Failure | What happens |
|---|---|
| CSS class/id/attribute renamed | **healed** — narrow the selector |
| copy re-worded, or a typo'd locator | **healed** — the nearest on-page copy |
| strict mode: the locator now matches 2+ elements | **healed** only by a narrowing that resolves to exactly one |
| the element is genuinely gone (feature removed) | reported — a real failure for a human |
| a timing/state failure (element appears after a click) | reported — a test bug, not a locator bug |
| copy written for another locale | reported — see below |
| an assertion failing for a non-locator reason (wrong text, hidden, disabled) | reported |

A strict-mode violation is never healed by `.first()`: that asserts against whichever match came
first in the DOM, which is a guess wearing a result.

Every refusal is recorded in `heals.json` with its reason — `no-candidate`, `ambiguous`, `not-unique`,
`locale-mismatch` — and the detail that backs it: how many elements resolved, the nearest copy and its
similarity, the two locales. It also names the test that hit it and whether that test went red, because
those are two different stories: a refusal the test sailed past is usually an element that rendered a
moment later (a tightening, not a blockage), while a refusal next to a failing test is the explanation
for it. The whole story — repairs with their outcomes, then refusals with theirs — lands in
`summary.md` under `## Locator heals`, not only in the console. Refusing is also how we learn which
class to build for next, instead of guessing at heuristics.

**The locale guard is the one this product cannot do without.** The site serves `/en` and `/id` from
the same structure with different words, and a page object's copy is written in one language. `byCopy`
therefore declares its locale (`const LOCALE = '/en'`) and refuses to heal when the run is in another.
The Indonesian home page says *"Portofolio"*, which is **0.90** similar to the English `'Portfolio'` —
so without the guard, one run against `/id` would have rewritten the English copy to Indonesian and
broken `/en`. Structure is shared across locales, so only copy healing carries this guard.

One locator class is refused on purpose rather than for lack of a heuristic: copy *parameterised from
the scenario* (`nicheFilter(niche)`) never appears in the page object, so nothing is substitutable —
and the scenario, not the page object, is the source of truth for what it claims to test.

One limit the healer cannot settle without waiting: it decides a locator is broken from an **eager**
`count()`, so an element that a client-rendered page adds later looks exactly like drift. Playwright
locators are lazy, so the assertion still auto-waits and passes — the cost is a spurious refusal
record, not a wrong heal. Such a refusal is now recognisable: its outcome says the test that hit it
passed anyway. If a product renders its DOM late, teach the healer to settle before deciding, rather
than widening the search.

## The nine stages

| # | Stage | Fails |
|---|---|---|
| 1 | `gap-analysis` | **fatal** — decides *what to cover* |
| 2 | `testcase-digest` | **fatal** — same |
| 3 | `pom-builder:<domain>` | per-domain, recorded, run continues |
| 4 | `testcase-digest-retry:<domain>` | per-domain, recorded |
| 5 | `test-plan` | agent picks a scope; fails open to the full suite |
| 6 | `playwright-test` | recorded as-is, never reverted |
| 7 | `heal-apply` | non-fatal; only a verified repair is folded in |
| 8 | `git` | skipped when nothing shippable; **refuses to ship** output that fails `typecheck`/`self-checks` |
| 9 | `notify` | non-fatal; but a report that did not arrive **fails the stage**, so it cannot pass for a quiet success |

## What you supply

- `scenarios/<domain>.txt` — one per feature area. Plain-English blocks,
  separated by `---`. The filename casing is load-bearing (map is keyed
  lowercase).
- `config/domain-map.json` — hand-author entry paths, auth flags, and
  entry-discovery steps. The first run backfills structural fields only.
- `config/tiers.json` — the scope vocabulary (`smoke` / `sanity` / `regression`) and
  the tags each selects. Read by the planner and handed to the planner agent, so it
  is the single definition of what a scope means.
- `config/scope-rules.md` — what this product deliberately will not test,
  and why. An unstated boundary gets re-proposed every release.
- `src/ai/prompts/*.md` — the prompt templates, in plain markdown with
  `{{PLACEHOLDER}}` substitution.
- `src/page-objects/<domain>/instruction.md` — how that feature area actually
  works, earned by driving the live app. Written and read by the builder, and
  fed to test-case generation as domain context. Do not condense it (see
  `pipeline-pattern.md` §7) — which is not a licence to append a diary: a builder
  adds a fact the file does not already carry, once. Its own per-run observation
  goes in the stage summary.

## What the machinery enforces (not by prompt, by code)

- **Managed regions**: generated code lives between `@digest:managed:start`
  and `@digest:managed:end`; everything outside is handwritten. Reviewers
  know exactly which lines had no author.
- **Two-gate classifier**: a scenario is *generated* only when nothing covers
  it AND the page objects can actually express the novel part — and the block
  hash decides first whether either question is asked at all (unchanged → held,
  moved → re-digested). Gates are
  matchers against the real POM surface, not prompt rules. Where the surface is
  *described* to a model, the generator gets member signatures (it writes the
  call) and the classifier gets bare names (it answers with a name that is
  matched against the surface).
- **A device profile is a capability**: a scenario about a narrow screen is
  recognised from its own words, applied through the page object's
  `useViewport(profile)` — never a raw `page.setViewportSize` in a spec — and a
  page object that cannot do it yields a build order rather than a test that
  quietly asserts the desktop layout at a phone width.
- **"The layout fits" is two checks, not one**: the document's scroll width, and
  every in-flow element against the container it is laid out in. A child wider
  than its column does not widen the document — a 300px widget in a 276px form
  column spilled 24px while `scrollWidth` stayed equal to `clientWidth`, and the
  mobile test passed. Absolutely-positioned decoration and clipping/scrolling
  containers are exempt. The decision is a pure function, unit-checked against
  synthetic boxes.
- **A widget whose frame never renders is asserted as a contract, not measured**:
  Cloudflare injects no Turnstile frame in an automated browser, in any
  `data-size`, so the slot's width is checked against the width the widget
  *declares* — and vendor constants live in the page object, where the product's
  business belongs.
- **A moved block hash re-digests, and the classifier is never asked about a stale block**:
  no block → classify (a handwritten test may cover it), hash moved → re-digest, hash equal
  → hold. The hash is the artifact's claim about which input built it, so it chooses the
  path — a stale block can no longer answer "already covered" with its own title.
- **Fail open, always**: every degraded input widens the run with a named
  reason. A malformed config value throws instead of guessing.
- **Enforced floor**: a narrowed run still includes everything generated this run —
  the creation-date tag the planner puts in the grep, with the generated titles as a
  second net.
- **Additive-only agent writes + write-scope guard**: the builder adds
  locators and methods; the healer repairs. Out-of-scope writes are reverted.
- **Never persist an absolute path**: repo-relative POSIX everywhere,
  rehydrated at load.

## Adopting this boilerplate

1. Copy the tree.
2. Delete `scenarios/demo.txt` and `tests/demo/`. Add one scenario file per
   feature area (lowercase filenames).
3. Hand-author the navigation half of `config/domain-map.json` — entry paths,
   auth flags, and the discovery steps for anything behind a listing or a
   sign-in wall. This is real investigation work, days, not configuration.
4. Rewrite the product sections of `src/ai/prompts/gap-analysis.md`.
5. Replace `config/scope-rules.md` with what you will not test, and why.
6. Wire `.env` and `.github/workflows/pipeline.yml`.
7. Run `npm run pipeline -- --pr <n>` against a live instance. Review every
   diff the builder proposes. **This is where the time goes** — budget weeks,
   not hours, for this step, and treat the first months as knowledge
   acquisition with tooling attached (~`pipeline-pattern.md` §6, §7).

## Layout

```
config/            product-owned JSON + Markdown (hand-authored)
scenarios/         one .txt per feature area (hand-authored + stage 1 appends)
src/core/          scenario parsing, managed regions, domain map, orchestrator
src/ai/            model client, classifier, generator, coverage backstop
src/agent/         builder interface + write-scope guard (+ CDP stub)
src/runtime/       self-heal fixture, heal locator, heal manifest, heal writer, viewport + layout spill
src/planning/      tier vocabulary (tiers.json), planner agent bridge, fail-open planner
src/stages/        01–08, wired to the orchestrator
src/delivery/      CodeHost interface + GitHub (via gh CLI)
src/exploration/   BFS crawler, page analyser, journal, locator writer
src/cli/           run-pipeline, self-checks
src/page-objects/  one folder per domain: POM (index.ts) + instruction.md
tests/<domain>/    generated + handwritten specs side-by-side
```
