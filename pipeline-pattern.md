# An AI test pipeline, as a reusable pattern

This document introduces the pipeline that lives in this repository as a **pattern other products
can adopt**, not as a library to install. It describes what the pipeline does, the decisions that
make it safe to let an agent write test code unattended, what a product has to supply, and — the
part usually left out — what cannot be copied at all.

It deliberately does not walk through any stage's implementation. The code is the maintained copy
of that and cannot go stale; this file carries the decisions and the adoption contract.

---

## 1. What this is

A change ships. The pipeline reads the issue and the diff, works out which areas of the app the
change puts at risk, checks that risk against the coverage that already exists, writes the missing
scenarios in plain English, turns them into runnable specs, builds whatever page objects those
specs need by driving the live app in a browser, runs the suite, folds in any locator repairs that
happened at runtime, and opens a pull request.

A human reviews that pull request. Nothing merges itself.

**What it needs:** an issue tracker and a code host with APIs, a running instance of the app, a
model API key, and a container that can run a browser.

**What it produces:** a branch carrying new scenarios, generated specs, new page-object methods and
healed locators, plus a PR body summarising what was added and how the run went.

**The boundary, stated honestly:** it automates the *writing* of tests. It does not automate the
*knowing* of the application. Everything below about what does not transfer is that boundary in
detail, and it is the single most important thing to understand before adopting this.

---

## 2. The loop

Eight stages. Names match the stage records written into the run report.

| # | Stage | Input | Output | On failure |
|---|---|---|---|---|
| 1 | `gap-analysis` | Issue + diff from the code host | Scope, plus new scenarios appended to `scenarios/<domain>.txt` | **Fatal.** Comments on the source PR, exits 1 |
| 2 | `testcase-digest` | All scenario files + existing specs | Generated `test()` blocks inside managed regions | **Fatal.** Same |
| 3 | `pom-builder:<domain>` | Domain map entry + prompt template | New locators, methods, instruction file, sidecar | Per-domain; recorded, run continues |
| 4 | `testcase-digest-retry:<domain>` | Blocks left unbuildable by stage 2 | Re-generated blocks now that capability exists | Per-domain; recorded, run continues |
| 5 | `test-plan` | Stage 1 risk areas + stage 2 digest verdicts | A scope and a `--grep` | **Fails open** to the full suite |
| 6 | `playwright-test` | The chosen grep | Run results, recorded verbatim | Recorded, never reverted; run continues |
| 7 | `heal-apply` | Runtime heal manifest | Locator files patched — only the repairs a passing test backed | Non-fatal; commit proceeds without it |
| 8 | `git` | Everything above | Branch, commit, push, PR | Skipped when nothing shippable changed |

**The spine is one indirection.** Stage 1 emits `{domain, title}` pairs into its report. A single
extractor turns those into a domain list, and stages 3 and 4 iterate that list. No feature name
appears anywhere in the orchestrator — domain identity comes from the filenames in `scenarios/`
plus a resolved map. That is the whole reason the orchestration is portable, and it is worth
copying before anything else here.

Stages 1 and 2 are fatal because they are the ones that decide *what to cover*. Everything after
them degrades: a page object that failed to build leaves a marked block, a test that failed stays
failed in the report, a heal that did not apply is still active at runtime next run.

---

## 3. Why it works — the decisions that transfer

This is the section to read if you take nothing else. Each one names the failure it prevents.

### Scenarios are plain text, and they are the source of truth

A scenario is a `TEST:` / `Tags:` / `Expected:` / `Notes:` block in a `.txt` file. Its id is a hash
of the normalised title; the body is content-hashed separately.

Two properties fall out. A non-engineer can write, read and review one. And **regeneration is keyed
on inputs changing, not on a verdict** — if the scenario text has not moved and a block was already
generated from it, the block is held as-is. Without that, any scenario the classifier keeps reading
as "new" goes back through the model every run and its body drifts each time with nothing intending
it, which is how a reviewed passing test gets silently replaced by a failing one in a run that
added no scenarios at all.

The cost is accepted deliberately: a block that is wrong while its scenario text is unchanged stays
wrong. Stale-but-reviewed beats fresh-and-unreviewed. A block that survived a green run is
evidence; a re-roll is a coin flip, and the pipeline commits either result.

The hash is therefore also the **only lever** for changing an existing test: nothing else moves it. That
is why the scenario file is product-owned — a hand edit to the spec is overwritten on the next digest,
and appending to the instruction file changes only what a *future* generation is told, leaving a held
block exactly as it was.

### Managed regions

Generated code goes between `// @digest:managed:start` and `// @digest:managed:end`. Everything
outside is handwritten and never touched.

This is what makes agent-written code reviewable at all: a reviewer knows exactly which lines had
no author. It also lets the same file hold both, so hand-written tests do not need a separate home.

A region is written *inside* a `test.describe(...)` callback, so an `import` inside it is not a
style question: an import declaration is only legal at the top level of a module, and one in the
region is a syntax error that takes the whole file down — every handwritten test in it, not just
the generated block. The generator is handed the spec's conventions and will happily re-emit the
spec's own imports as part of "the block", so the rule is enforced on the output, not by asking:
the write path strips import declarations on the way into the region (`stripBlockImports`, in
`managed-region.ts`), names each one as a degradation, and leaves clean code byte-identical so the
hold-as-is path stays a fixpoint. It runs on held blocks too, which is what lets a spec already
committed broken repair itself on the next digest rather than being held broken forever.

The region also has to survive its own *first* write. A domain's first spec is composed whole (it
needs a closed `test.describe()`); every later write replaces just the region. Two writers means two
chances to disagree, and a one-byte disagreement — a blank line before the closing `});` — is enough
to rewrite the file on the next run, silently. So the scaffold and the writer live side by side and a
self-check asserts the scaffold's output is a fixpoint of the writer. The same reasoning applies
inside a block: the reader trims blank lines from both ends of one, so the writer must too, or a blank
line the generator emitted survives exactly one extra run. A diff that appears once and then settles
is the hardest kind to notice and the easiest to prevent.

A block also has to stop vouching for itself. A block is held while its scenario's text is unchanged,
so an edited scenario has no valid block — and the hash is what says so. The digest decides the path
before any model call: no block → ask the classifier (a handwritten test may already cover it); a
block whose hash has MOVED → re-digest; equal → hold. Previously every moved hash went to the
classifier, and the stale block carries the scenario's own title, so the answer was always "already
covered": the edit never reached the spec, and because the stale block was carried forward with its
old hash, the same scenario was re-decided on every later run, forever, with a green report each time.
AGENTS.md meanwhile promised that a tag edit regenerates the block, which was false. Re-digestion
settles, because the rewritten block carries the new hash and is held next run. The general shape is
worth keeping — the hash is the artifact's own claim about which input it was built from, so let the
hash choose the path, and never let a stale artifact have a vote.

### The spec never touches `page`; a device profile is a capability

The spec's whole job is navigation and calls onto the page object. It does not resize the viewport, it
does not locate elements, it does not even import `expect` — so a raw `page.*` call in a block is
outside the capability index, cannot heal, and cannot be reviewed as a capability. That boundary is
checked, not requested.

It matters most for the one thing a spec is genuinely tempted to do itself: set a viewport. A scenario
about a narrow screen is a real, recurring category, and the pipeline should understand it without
knowing a product's pages, so the vocabulary is machinery: the profiles (`mobile`, `tablet`,
`desktop`), the profile sizes, and "which profile is this scenario about?" read from the scenario's
own words. The page object owns the *capability* — `useViewport(profile)` — and delegates the pixel
sizes to the runtime, so a page object names a profile, never a dimension.

The interesting half is what to do when the capability is missing, because both obvious answers are
silent failures. Omit the viewport change and the test re-runs the desktop assertions at a phone width
and passes without testing anything. Make the change and the desktop assertions fail on a layout the
product intentionally collapses — which reads as a product bug. The digest therefore treats "can this
page object express this profile?" as a capability question and emits a stage-4 work order, exactly
like any other missing method. The generator is then told the profile, told to apply it through the
page object, and told to assert what *that* viewport shows.

What it means to assert at a narrow width is itself partly general: `measureHorizontalOverflow` is
shared, because "the layout does not scroll sideways" is the concrete, product-neutral meaning of "no
visual problem" on a phone. The product-specific parts — that a collapsed nav is *hidden* rather than
absent, that a collection count differs per width — belong to the page object and to its instruction
file, earned by driving the live app.

That general half has since been shown to be **half** a check. The document's scroll width is blind to
a child wider than its column, and the live app demonstrated it: the Turnstile widget is a fixed 300px
inside a 276px form column, overflowing the form by 24px while `scrollWidth` stayed equal to
`clientWidth`. The mobile test passed, and the defect was reported by a person instead. So the shared
fact is now stated as a measurement over elements — every in-flow element against the container it is
laid out in — with decoration exempt (an `absolute`/`fixed` element is placed against a box rather
than laid out in the flow, and a glow that deliberately overhangs its parent is the design) and a
clipping or scrolling container exempt with its children (that is a carousel, not a defect). The
decision is a pure function over a geometry report, so the part that is easy to get wrong — the
comparison itself; the first version had its two sides swapped and flagged every correctly sized
element — is unit-checked with synthetic boxes rather than left to a live probe.

The same app shows the limit of this, which is worth stating plainly: **a check can only measure what
rendered.** Cloudflare injects no Turnstile frame in an automated browser, in any `data-size` —
`window.turnstile` exists, the hidden response field is populated, `querySelectorAll('iframe')` is
empty — so the widget that spills is not in the DOM to be measured, and no amount of scanning finds
it. What is left is the *contract*: the slot declares a size, the widget renders at that size, so the
slot must be at least that wide. That assertion is product work, and the third-party constant belongs
in the page object — machinery measures what is on the page; it does not know any vendor's pixel
sizes, and a widget that renders only for a human is a case where "measure the page" has no answer.

### Assertions are page-object methods, and every one says what it checked

A spec navigates and calls intent-revealing assertion methods on the page object; it never
imports the test runner's `expect`. Two things fall out of that. The assertion surface becomes
part of the capability index, so "can the page objects express the novel part?" now includes
*verifying* it — a scenario whose behaviour no assertion method can check is `blocked` and
becomes a build order, instead of a hand-rolled `expect` slipped into a spec to make it pass.
And every assertion carries a message, so a red run states the claim that broke rather than
dumping two locator strings for the reviewer to reverse-engineer. Both rules are cheap to check
over the output, and are checked: one self-check forbids `expect(` in specs, another requires a
message on every `expect(` in a page object.

The same distinction shows up in how the surface is *described* to a model, and it is not a detail.
The generator writes the call, so it needs the member's parameters — handed bare names it read
`expectHeroCtaTargets(href: string)` as a zero-argument assertion, omitted the argument, and the spec
failed to compile. The classifier writes a *name* and has that name matched against the surface, so
handing it a signature makes every claim look like a missing capability. One surface, two views: a
signature catalog for the caller, bare names for the gate. And a parameter list is captured only when
it is unambiguously one, because a wrong hint is worse than none — the model will satisfy it exactly.

### One map is the only place product vocabulary lives

A single JSON map takes a domain key to its spec directory, page-object directory, class name,
entry paths, whether it needs authentication, and — hand-authored, never model-filled — the ordered
steps for reaching the real page when the entry path is only a listing or a sign-in wall.

Every path downstream is derived from that map. Nothing else knows what a domain is called.

Two rules keep it honest. **Manual edits are authoritative** and are preserved across re-resolution;
the model may only backfill structure. And **paths are persisted repo-relative and rehydrated at
load**, never stored absolute — see the cross-OS rule below.

### Classification asks two questions, and both must pass

The obvious question is "does anything already cover this?". The one usually left implicit is "and
can the page objects express the part that makes it novel?".

Which of those is asked at all is settled earlier, by the block's hash: unchanged → hold, moved →
re-digest, and only a scenario with **no block** is offered to the classifier (§Managed regions —
asking it about a stale block gets the stale block's own title back as the answer).

Asking only the first is structurally unsafe. A scenario is novel *because* of some behaviour B, so
a generation that silently drops B leaves only already-covered behaviour — every time. The result
is a passing test that duplicates an existing one, which no post-hoc duplicate detector can
distinguish from legitimate overlap.

So a scenario the page objects cannot express is classified `blocked`, skips generation, and emits
a marked-unbuildable block tagged with what is missing. That block is not a dropped requirement —
it is the next stage's work order, and stage 4 regenerates it once the capability exists.

That verdict is deliberately **not cached**, because it is a claim about the page objects, which is
exactly what the next stage changes.

### Gates are matchers, not prompt rules

The model must *name* the members it would use, and those names are checked against the real
surface extracted from the page-object file. A claimed name that does not exist is the missing
capability, and the name it reached for is the spec of what to build.

The reason this is a rule and not a preference: the prompt had forbidden the exact substitution
that shipped anyway. **A prompt that forbids something is not enforcement.** If a constraint
matters, express it as a check over the output.

Known limit, and worth stating in your own version too: this catches an *invented* capability, not
a *substituted* one. Existence is checkable; sufficiency is not.

### Enforcement asymmetry, decided by the cost of a false positive

The same rule can block at one stage and only report at another. That is a policy, not an
inconsistency, and the decision procedure is always the same:

- **Blocking is correct when a false positive is visible and cheap to undo** — a wrongly-rejected
  proposal lands in a report a human reads, and nothing is lost.
- **Report-only is correct when a false positive silently deletes coverage** — refusing to
  regenerate an existing block freezes coverage behind a green report, which is the worst outcome
  available.
- A rule that matches **API calls** can be enforced; a rule that matches **English prose** should
  report until the log shows it firing only on real cases.

### Fail open, always

Every degraded input widens the run rather than narrowing it. No scope, an unreadable report, an
unrecognised tier, low confidence, a filter that selects nothing — all of them fall back to the
full suite, each with a distinct named reason so the fallback is visible rather than silent.

The mirror-image rule: a malformed configuration value **throws** instead of falling back to a
default. Falling back is the silent-no-op shape — the run goes green against the wrong target while
the operator believes otherwise.

There is exactly one exception, and it is not a degradation. A human's explicit instruction —
`TEST_GREP` — is *absolute*: it is the filter, the agent is not consulted (asking a model to choose a
scope you are about to discard buys a call and leaves a reason nothing acted on), and the floor steps
aside, because someone who typed `@smoke` does not want surprise extras. The human is the merge gate,
the same way a hand-edited `domain-map.json` entry stays authoritative over the model's backfill. What
absolute does not license is *silence*: the override is recorded as an override rather than as a
planned scope, and when it excludes a test that this run wrote — the exact outcome the floor exists to
prevent — the report says so in bold. Fail open is a rule about **degraded input**; a deliberate
instruction is not degraded input.

The operator's channel matters as much as the instruction: it is a run-time input, never a repository
variable. A standing `TEST_GREP` would make the override permanent and silent — every run pinned to one
person's filter, nobody having asked for it that day — which is the same failure as a default that hides
a missing value. Cheap checks gate expensive spend (§3), so this one is enforced by a self-check rather
than by memory.

When a run *is* narrowed, the reduction is chosen, named in the report, and printed on the PR and
the notification. And the floor is **enforced in code and re-verified**: the narrow filter always
includes everything generated in that run, and the planner re-checks that the filter still selects
something and widens to everything if it does not. A run that skips the tests it was triggered to
write is the one outcome that makes the whole pipeline pointless.

**The agent proposes; code decides.** Stage 5 may ask a model which scope a change deserves — smoke,
sanity or regression — from the risk analysis and the digest verdicts. What it may not do is choose
the filter: the answer is a *name* and a reason, and the mapping to a `--grep`, the floor and every
fallback live in code. That separation is the safety property. A model is a perfectly reasonable
thing to ask "how much should we run?", and a completely unreasonable thing to allow to *narrow* a run
unilaterally: a scope that answers "smoke" on a change that broke everything is the smaller-green-run
failure wearing a costume. Asking a model is allowed to cost time (it widens) and never allowed to
save it (it must not narrow past the floor).

The floor is a safety net, not the mechanism. The mechanism is the **tag**: stage 2 writes the
scenario's `Tags:` onto the generated `test(...)` call, so `--grep @smoke|@core` selects by tag. A
filter that relied on titles alone would drop a test the moment a generated title disagreed with the
scenario title, and it would drop it as a *smaller green run* — the failure mode this whole document
keeps coming back to. So the tag is written by the machinery (`core/scenario/test-tags.ts`) and never
trusted to the model; the title alternation stays on top of it.

The floor itself is the **creation-date tag**: stage 2 stamps `@YYYYMMDD`, the run's start date, on
each block it generates, and every non-regression filter includes it, so the tests this run wrote run
whatever else it decided. Written once, at generation, and read back off the block when the block is
held — a tag re-stamped with "today" on every run would rewrite every generated block once a day,
churn no reviewer reads and every diff carries.

### Healing is a mechanical narrowing, never a guess

A locator that stops resolving is normally a stale source line, not a broken app. The runtime healer
catches it mid-run: the page carries a heal collector, a page object resolves a healable locator
through it, and a locator that resolves to nothing is retried. If a candidate resolves uniquely, the
test proceeds on the healed locator and a record lands in `artifacts/run/heals.json`, carrying what
the broken locator did, which test used the repair, and what that test did with it. Stage 7 folds the
records a passing test backed into the source afterwards — never mid-run, because the builder adds and
the healer repairs, and two writers must never touch the same lines.

Two things go stale, and each has its healer: a CSS selector the app renamed is narrowed, and copy
the app re-worded is matched to the nearest on-page copy. Four decisions make this safe rather than
magical:

- **No model.** A CSS candidate comes from the selector that broke (drop a trailing qualifier,
  re-express `data-test` as `data-testid`); a copy candidate is the uniquely nearest on-page text,
  and only above a high similarity floor — two near-identical candidates are a coin toss and neither
  is taken. A model asked for a replacement locator answers confidently and sometimes wrongly, and a
  wrong locator does not fail: it asserts against the wrong element and passes. An honest failure is
  worth more than that.
- **A heal is expressible as source text.** Folding is exact string replacement, which is also why a
  locator must be *identified by something substitutable* to heal at all. A CSS heal rewrites the
  selector; a copy heal rewrites the `'<copy>'` literal — quoted, because a naked fragment like
  `Contact` also occurs inside assertion messages, and rewriting those would corrupt them. A
  `getByRole(..., { level })` or a regex carries neither a copy nor a string, and needs no heal.
- **The outcome of the test that used a repair is what settles it, so only a verified repair is
  folded in.** "This locator still addresses the same element" is a claim the healer cannot check;
  the assertion that used it is the only evidence for it, which is why the fixture stamps every
  record with the test that used it and how that test ended (`test-passed` / `test-failed` /
  `unknown`, worst wins, `unknown` yielding to what a later use knows). A record whose test failed is
  evidence *against* the repair, and applying it would bake a locator we have evidence against into
  the source, with the failing test gone by the next run — a wrong locator committed, silently. So
  stage 7 filters to `test-passed` and names each repair it declined. The correlation is deliberately
  modest: a test can fail for reasons of its own, so `test-failed` means "nothing passed on this
  locator". That is enough to withhold the patch, and the runtime keeps healing meanwhile. And the
  outcome is **announced where a person looks, not only recorded**: the fixture annotates the test
  (`heal` / `heal-refused`, which the HTML report renders) and the worker prints a `[self-heal]` block
  at teardown. A record nobody reads is the same silence the outcome was added to break — a healed pass
  and a healthy pass both say "1 passed".
- **A run is not one process.** Playwright restarts the worker after a failing test, so one run has
  several heal collectors and writes `heals.json` several times. A save therefore merges with a file
  from the *same* run and replaces one from another run, which is why the file names its run
  (`HEAL_RUN_ID`, or the parent process for a bare `npm test`). Overwriting let the second teardown
  erase the first one's records — a run with a single failure losing exactly the heals it most needed
  to report, and saying nothing.
- **A skip is reported, not swallowed.** A record whose broken locator is no longer in the file is
  named as a degradation and the domain's `healApply` is recorded as `failed`. Marking it
  `succeeded` because the stage did not throw is precisely the silent-green this pipeline exists to
  avoid — and it hides the one case where the source was *not* repaired.
- **The healer is allowed to refuse, and a refusal is a record.** Healing repairs a stale source
  line. It must not repair "the feature is gone", a timing failure, or an assertion that failed for a
  non-locator reason — each of those would convert a real regression into a green lie. So a refused
  attempt is recorded with its reason (`no-candidate`, `ambiguous`, `not-unique`, `locale-mismatch`)
  and the observation behind it: the element count, the nearest copy and its similarity, the two
  locales. It also carries the test that hit it and whether that test went red, because a refusal the
  test sailed past (an element that rendered a moment later) is a different story from a refusal next
  to a failing test. Stage 7 prints them, and `summary.md` renders them under `## Locator heals`
  beside the repairs, so neither reaches only the console. Refusing is also the measurement — it is
  how we learn which class of failure to build for next, rather than adding heuristics on a hunch. A
  strict-mode violation is healed *only* by a narrowing that resolves to exactly one element;
  `.first()` would assert against whichever match came first in the DOM and call it a result.

Copy is the one part of this that is not locale-independent, and a bilingual product turns that into
a correctness guard rather than a nicety. This site serves `/en` and `/id` from the same structure
with different words, so a copy heal in the wrong locale would rewrite the page object's copy *into
the other language* and break the locale it was written for: the Indonesian `"Portofolio"` is 0.90
similar to the English `'Portfolio'`, comfortably above the floor. `byCopy` therefore declares its
locale and refuses when the run's locale differs, or when it cannot be determined. Structure is
shared across locales, so only copy healing carries this guard.

The fixture is opt-in per spec on purpose: a spec that imports plain `@playwright/test` heals
nothing, so healing is additive rather than load-bearing. Since that failure mode is invisible — the
run is green and just silently unhealed — `npm run self-checks` asserts the import in every spec.

### The PR is the review gate

No path merges anything. Three supporting rules:

- **Agent writes are additive-only.** The builder may add locators and methods; repairing broken
  ones belongs to the healer. Two writers never touch the same lines, and diffs stay reviewable.
- **A write-scope guard classifies what the agent touched** and reverts anything outside the
  directories it was allowed to write.
- **Persist the agent's summary, never its transcript.** A transcript carries page content from the
  environment under test.

### Test results are recorded as-is

No test is reverted, re-marked, or filtered on failure. The run result *is* the signal, and the
pass/fail breakdown goes into the PR body as review guidance.

An auto-revert-on-failure filter existed and was removed: a full-suite run already surfaces flake as
a visible failure, while auto-reverting removes exactly the signal the reviewer needs.

### The record must be readable

A run emits three artifacts, and they are not interchangeable. `run-report.json` is the redacted
audit trail — every stage's verbatim output. `manifest.json` is the machine record that threads the
stages. `summary.md` is what a person reads, and it is printed to the console as well.

This is a design rule, not cosmetics. The first version reported *counts* — "11 scenarios: 10 held,
1 already covered". That sentence cannot answer the only question an operator actually has, "where
did my testcase go?", because it names no scenario. A scenario the classifier judged *already
covered* produced no block and no line, so it looked exactly like the digest had never seen it.

So each scenario carries its own row — title, verdict, and the one-line reason — beside the thing it
is about, and the manifest stores it that way too. A reader should never have to join a hash-keyed
map against a file to find out what happened to their testcase.

### Cheap checks gate expensive spend

A suite of small self-checks — plain assertions, no browser, seconds to run — executes in CI
immediately before the pipeline, in the same command. They cover the things whose failure mode is
*silence*: path handling across operating systems, cache hit/miss conditions, concurrency
invariants, fail-open behaviour, prompt placeholders still being substituted.

Each one exists because the bug it catches produces a green report rather than an error. That is the
selection criterion worth copying: **write a self-check when the failure would not announce itself.**

### Never persist an absolute path

Local development and CI run on different operating systems. A path bug of this class does not
throw — it resolves to a plausible dead path, the caller's existence check returns false, and the
work is silently skipped.

So: store repo-relative POSIX paths in every committed artifact and resolve at load; never hand-strip
a prefix or hardcode a separator; and when a guard would disarm itself on empty input, throw instead.

---

## 4. Anatomy

What the framework is made of, by role. Everything listed here is product-neutral machinery unless
the note says otherwise.

| Layer | Pieces | What a new product changes |
|---|---|---|
| Orchestration | Stage runner with timeout and signal handling, output reassembly, run report, redaction | Nothing |
| Scenario | Block parser, durable manifest, managed-region reader/writer, domain map resolver | Nothing — it reads your files |
| AI | Model client with JSON extraction, truncation repair and budget-scaled deadlines; bounded concurrency pool; classifier; generator; coverage backstop; capability index | Prompt *content* only |
| Agent | Browser-MCP builder, write-scope guard, stream logger, soft time budget | Prompt template content |
| Runtime | Self-healing locator fixture, heal manifest, heal writer, viewport application and layout-spill measurement | Nothing |
| Planning | Tier vocabulary, planner, tag proposal and refresh tooling | Tier assignments |
| Delivery | Issue-tracker and code-host client, notification card, browser image, CI wiring | Vendor-dependent; see limits |
| Exploration | BFS crawler, page analyser, journal, locator writer | Nothing |

Two notes worth carrying over.

**The exploratory crawler is generic code, and its narrow role is a design choice.** Building page
objects is a plan-act-observe loop: navigate, snapshot, interact to reveal hidden state, propose a
locator, verify it resolves uniquely, refine. A crawler over one-shot analysis calls cannot do the
interactive half — it describes a page it visited but cannot try something and look again. That is
why the agent stage exists and why the crawler is kept for breadth (scheduled whole-app re-mapping)
rather than for targeted work. Do not mistake its narrow role for product coupling.

**Concurrency is per-phase and deliberately not per-domain.** Generation and classification both run
through one bounded pool because both are pure network wait. Domains are *not* parallelised, because
the manifest is threaded through them one at a time and concurrent domains would drop each other's
writes. Three invariants hold the write path together: block order is pinned rather than arrival
order, the write path has no `await` inside it, and a failure awaits in-flight work before
rethrowing.

---

## 5. What a product supplies

| Surface | Form | Authored by |
|---|---|---|
| Scenario files | One `.txt` per feature area, blocks separated by `---` | Humans, plus stage 1 appends |
| Domain map: entry paths, auth flag, entry-discovery steps | JSON, hand-edited | Humans, never the model |
| Domain map: directories, class names, confidence | JSON | Resolved on first run |
| Builder prompt template | Markdown with `{{PLACEHOLDER}}` substitution | Humans |
| Browser/MCP config | JSON | Copy as-is |
| Fixtures | Typed modules of test data | Humans |
| Per-domain instruction file | Markdown, append-only | Written by the builder; read by the builder and fed to test-case generation |
| Environment | ~50 variables | Humans |

**Where prompt text lives.** A fact that code derives or enforces belongs in a TypeScript fragment
injected through a placeholder — so one source feeds every agent that needs it, and rules expressed
as data can be unit-tested. Static prose an operator edits wholesale belongs in the markdown
template. Prompts themselves are markdown when mostly static and inline when mostly computed per
run.

**The environment trap, worth calling out because it fails silently.** A variable must be registered
in three places: the CI pipeline definition, the container environment, and the example env file.
Tests run *inside* the container, so a value set only in the CI step shell never reaches them, and
the run quietly falls back to the default target.

---

## 6. Adopting it

Ordered, with the cost named.

1. **Copy the skeleton, strip the feature-specific parts.** Delete the feature-specific assertion
   utilities and their fixture assets, the feature-specific fixtures, and any feature-tag
   vocabulary. Hours.
2. **Name the domains.** One scenario file per feature area. **Filename casing is load-bearing** —
   the map is keyed lowercase, so a mixed-case filename resolves as unmapped and silently creates a
   second, empty entry. Hours.
3. **Hand-author the navigation half of the map** — entry paths, auth flags, and the discovery steps
   for anything behind a listing or a sign-in wall. Let the first run resolve the structural half.
   Days, and this is real investigation work, not configuration.
4. **Rewrite the product section of the generation prompt and the auth prompt block.** Same shape,
   different content: your flow's step order, your account-creation path, your field naming, your
   known-defect callouts. Days.
5. **Replace the scope-rule content** with what your product deliberately will not test, and why.
   Hours. Skipping this is a mistake — an unstated boundary gets re-proposed every release.
6. **Author fixtures.** Days.
7. **Wire the environment** across the three registration points. Hours.
8. **Run the builder per domain against a live instance, and review every diff.** Weeks. **This is
   where the time actually goes**, and no amount of configuration shortens it.

---

## 7. What does not transfer

The machinery is portable. The knowledge is not, and the knowledge is the bulk of what makes the
pipeline work.

Three artifacts hold it, and all three are earned by driving the live application rather than
written from a specification:

- **Scenario notes.** Each block's `Notes:` carries live-probed selectors, the date and environment
  it was verified against, which values are configuration rather than fixed copy, and which
  behaviours are known defects rather than test bugs. In a mature suite this runs to well over a
  hundred kilobytes of prose.
- **Entry-discovery steps.** Reaching a page is rarely one URL. A single authenticated area can
  need a dozen paragraph-length steps recording which form on the sign-in page actually
  authenticates, which routes answer 200 while redirecting elsewhere, and which actions would lock
  future runs out.
- **Per-domain instruction files.** The builder both reads and writes these, which has a
  consequence: **they must not be condensed.** A line cut from one does not merely lose context — it
  regrows as wrong code on the next run, written by an autonomous agent with no reviewer between it
  and the diff. Cut a note saying an input is read-only and the next builder writes a fill that
  commits nothing, and the test goes green.
  Append-only is a rule about **facts**, not a licence to keep a run diary: the builder adds a fact
  the file does not already carry, once, and the run's own observation (the page was reachable, what
  it looked like) goes in the stage summary. A `## <timestamp> — builder run` section per invocation
  is the failure this guards against — every run looks new, so three runs leave three near-identical
  sections and the file grows without bound, on disk and in the prompt stage 2/3 read back. The date
  stamps that must never be trimmed (*below*) are stamps on a **probe**: they say how fresh a verified
  fact is, which is a property of the fact. A stamp on a **run** is a property of the run, and goes in
  the run's summary.

What is never safe to trim anywhere, because none of it is recoverable by reading code: **negative
results** (absence is indistinguishable from not-yet-built, so a cut gets the work redone and the
absence filed as a defect); **silent-failure traps**, where the failure mode is a passing test;
**date and environment stamps** on a probe, which on a configurable platform *are* the confidence
level; **why an option was rejected**, the only thing stopping it being re-proposed; and **the cost
a decision accepted**, since a tradeoff with its cost deleted reads as free and gets removed by
someone tidying up.

Plan for the earned knowledge to dominate your effort, and treat the first few months of a new
adoption as knowledge acquisition with tooling attached, not as a configuration exercise.

---

## 8. Limits and open questions

**Vendor coupling.** The issue-tracker and code-host client targets one vendor pair (Jira Cloud plus
Bitbucket Cloud) and the notification layer targets one chat vendor. Both are cleanly isolated — a
different stack rewrites one file each and changes nothing else. Everything upstream of them is
vendor-neutral.

**No package extraction, deliberately.** There is one consumer. Publishing this as a shared package
would be an abstraction with a single implementation, and would freeze interfaces that are still
moving. Adopt it by copying the tree and deleting what you do not need; revisit extraction when a
second product has actually run it end to end and the two have diverged in ways worth reconciling.

**Two delivery paths coexist** — a container-exec path driven by CI, and an HTTP-triggered path that
runs the suite on managed compute and emails the report. They share only the image registry. A new
adoption should pick one; carrying both is history, not design.

**The agent stage is a CLI invocation, not an SDK integration.** That was the faster path: the CLI
already handles the agent loop, tool dispatch, retries and context management. Migrating to an agent
SDK is the named upgrade path if structured logs, per-turn hooks or tighter budget control are ever
needed, and the wiring is arranged so promoting it changes no caller.

**The coverage backstop is report-only and cannot be made exact.** It checks that every clause the
generator claimed to cover actually appears in the block, and that an expectation phrased as "must
not happen" is matched by an assertion of absence. Measured over a real corpus it cannot separate a
bad substitution from a positive assertion that legitimately entails the negative. Treat its output
as a review queue; promote it to blocking only once the log shows it firing on genuine substitutions
alone.

**A generated check can only measure what the test browser rendered.** The sharpest case is a
third-party widget that chooses not to render for a non-interactive visitor: Cloudflare never injects
its Turnstile frame in an automated browser, in any `data-size`, so the widget that visibly spills out
of the enquiry form is simply not in the DOM. Better layout knowledge does not help — the limit is the
page, not the matcher. What stays assertable is the contract the markup declares: the slot names a
widget size and must be at least that wide. So the answer is a page-object assertion that states the
contract, plus the measured facts in the instruction file — not a cleverer scan. Budget for it: layout
knowledge catches what rendered, and a defect that renders only for a human still arrives by human
report, which is what happened here.
