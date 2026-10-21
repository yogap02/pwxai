# The workflow, as diagrams

The pipeline has one end-to-end flow and three decisions that are worth
understanding on their own. The diagrams below are [Mermaid](https://mermaid.js.org)
source, so they render in GitHub, in VS Code, and in any Markdown viewer with
Mermaid support.

`deck/build-deck.py` renders the workshop deck, whose stage slide shows the same
flow; `deck/diagrams/d*.png` are these diagrams rendered to PNG for slides and
handouts, generated straight from this file:

```bash
node artifacts/render-mermaid.mjs      # needs: npx playwright install chromium
```

## Exporting to Excalidraw

`deck/diagrams/excalidraw/*.mmd` is each diagram on its own, ready to paste into
Excalidraw (*menu → Mermaid to Excalidraw*). Regenerate them from this file:

```bash
node artifacts/export-mermaid.mjs
```

Three things about that import — **checked against Excalidraw's own importer**
(`@excalidraw/mermaid-to-excalidraw`) rather than assumed:

| Mermaid | What Excalidraw does with it |
|---|---|
| `<br/>` | **not handled at all.** It lands in the label text as a literal `<br>`, and has to be cleaned up by hand. The export replaces it with a real newline, which the importer does keep — that is the one transformation the export makes. |
| `classDef` / `class` | honoured: `stroke` and `fill` become the element's stroke and background colour, so the diagram arrives already colour-coded. |
| `subgraph` | imports, but as a plain rectangle carrying the group's label — Excalidraw groups are not elements, so the phase label arrives as text you can move rather than a group you can drag. |

`subgraph` and `classDef` are kept in the export for exactly those reasons; only the
line breaks are rewritten. The check itself is `artifacts/excalidraw-import-check.html`
(serve the repo root and open it with `?src=<file>`) — it reports per diagram the
parse result, the element types, every label text, and any surviving `<br>`.

---

## 1. End to end: an issue in, a reviewed PR out

```mermaid
flowchart LR
    IN(["GitHub issue<br/>+ PR diff"])

    subgraph P1["① decide what to cover"]
        S1["1 · gap-analysis"]
        S2["2 · testcase-digest"]
        S1 --> S2
    end

    subgraph P2["② build the vocabulary"]
        S3["3 · pom-builder"]
        S4["4 · digest-retry"]
        S3 --> S4
    end

    subgraph P3["③ run it"]
        S5["5 · test-plan"]
        S6["6 · playwright-test"]
        S5 --> S6
    end

    subgraph P4["④ repair and ship"]
        S7["7 · heal-apply"]
        S8["8 · git"]
        S7 --> S8
    end

    IN --> S1
    S2 --> S3
    S4 --> S5
    S6 --> S7
    S8 --> OUT(["PR — a human reviews it,<br/>nothing merges itself"])

    classDef stage fill:#F3F5F8,stroke:#DDE2E8,color:#212630
    classDef io fill:#171B23,stroke:#171B23,color:#FFFFFF
    class S1,S2,S3,S4,S5,S6,S7,S8 stage
    class IN,OUT io
```

**How to read it.** What passes between phases is *files on disk*, not conversation
history: a scenario file (`scenarios/<domain>.txt`), a page object
(`src/page-objects/<domain>/index.ts`), and the run manifest
(`artifacts/run/manifest.json`). That is what makes a single stage re-runnable in a
new process — `npm run stage:2` reads the manifest and refuses to guess if it is
missing.

**Fatal vs recorded.** Stages 1–2 are fatal, because they decide *what to cover* —
running the rest on a wrong plan wastes the run. Stages 3–7 record a failure and the
run continues, so one pass gives you the whole picture. Stage 8 is skipped when there
is nothing shippable.

---

## 2. Stage 2: the block hash decides first

This is the decision that makes the scenario file the source of truth. It is
read **before any model call**.

```mermaid
flowchart TD
    SC["scenario block<br/>scenarios/&lt;domain&gt;.txt"] --> H{"does a block exist,<br/>and does its content<br/>hash equal the scenario's?"}
    H -- "equal" --> HOLD["held<br/>kept verbatim — no model call"]
    H -- "moved" --> RED["re-digest<br/>the scenario changed,<br/>so the block is rewritten"]
    H -- "no block" --> CLS{"classifier<br/>already covered?<br/>can the POM express it?"}
    CLS -- "covered by an<br/>existing test" --> COV["covered<br/>no test is written"]
    CLS -- "the POM cannot<br/>express the novel part" --> UNB["unbuildable<br/>stage-4 work order, test.fixme"]
    CLS -- "novel, and<br/>expressible" --> GEN["generated"]
    RED --> GEN
    GEN --> WRITE["written inside<br/>// @digest:managed:start … end"]

    classDef gate fill:#FFF6E5,stroke:#B46A00,color:#212630
    classDef ok fill:#E8F5E9,stroke:#2EAD33,color:#1E7A22
    class H,CLS gate
    class HOLD,COV,UNB,GEN,WRITE ok
```

Why the hash comes first: a stale block carries the scenario's own *title*, so if the
coverage question were asked with that block in the evidence list, the block would
vouch for itself — the edit would never reach the spec, and the same scenario would be
re-decided on every later run, forever, under a green report.

---

## 3. Stage 7: heal, or refuse and say why

A refusal is not a bug. Healing exists to repair a stale *source line*; repairing "the
feature is gone" or "the test is wrong" turns a real regression into a green lie.

```mermaid
flowchart TD
    F["locator did not resolve,<br/>or matched 2+ elements"] --> Q{"identified by a CSS<br/>string or by copy?"}
    Q -- "CSS string" --> N{"does a narrowing resolve<br/>to exactly ONE element?"}
    N -- "no" --> R1["refuse · not-unique<br/>never .first()"]
    N -- "yes" --> CAND["candidate repair"]
    Q -- "copy text" --> CP{"uniquely nearest, and above<br/>the similarity floor?"}
    CP -- "no, or a near tie" --> R2["refuse · no-candidate / ambiguous"]
    CP -- "yes" --> LC{"the run is in the<br/>locale the copy was written for?"}
    LC -- "no" --> R3["refuse · locale-mismatch<br/>/id Portofolio is 0.90 like /en Portfolio"]
    LC -- "yes" --> CAND
    CAND --> T{"did the test that<br/>used the repair pass?"}
    T -- "test-passed" --> W["stage 7 writes the repair<br/>into the source"]
    T -- "test-failed / unknown" --> D["declined and named<br/>the runtime keeps healing"]

    classDef gate fill:#FFF6E5,stroke:#B46A00,color:#212630
    classDef bad fill:#FDECEA,stroke:#C0392B,color:#7B241C
    classDef good fill:#E8F5E9,stroke:#2EAD33,color:#1E7A22
    class Q,N,CP,LC,T gate
    class R1,R2,R3,D bad
    class CAND,W good
```

There is no model in this path, deliberately: a locator that is guessed wrong does not
fail — it asserts against the wrong element and passes, which is worse than the honest
failure it replaced.

---

## 4. The planner: what actually runs

```mermaid
flowchart LR
    M["manifest:<br/>risk areas + digest verdicts"] --> AG{"planner agent:<br/>smoke, sanity<br/>or regression?"}
    AG --> PL{"did every input<br/>degrade cleanly?"}
    PL -- "yes" --> TIER["scope selection<br/>tags from tiers.json"]
    PL -- "no — anything unclear" --> OPEN["fail open to the full suite,<br/>with a named reason"]
    OPEN --> TIER
    AG -- "errored or garbage" --> OPEN
    TIER --> FLOOR["enforced floor:<br/>every test generated this run<br/>(@YYYYMMDD)"]
    FLOOR --> RUN["playwright run<br/>--grep @smoke|@core"]
    RUN --> RES["results recorded as-is,<br/>never reverted or filtered"]
    RES --> SUM["summary.md:<br/>every scenario's verdict + reason"]

    classDef gate fill:#FFF6E5,stroke:#B46A00,color:#212630
    classDef warn fill:#FDECEA,stroke:#C0392B,color:#7B241C
    class AG gate
    class PL gate
    class OPEN warn
```

The failure to watch for is not a red run — it is a *smaller green run*, where
everything that ran passed and the test that would have failed never ran at all. Hence
selection by **tag** rather than by title, hence the floor — and hence the agent's
answer being a name that code turns into a filter, rather than a filter itself.

### When a human decides instead

`TEST_GREP` — set in `.env` or exported for one run — makes the filter an operator's own
and **skips the agent entirely**. It is the one thing the floor steps aside for, because
someone who typed `@smoke` does not want surprise extras:

```bash
TEST_GREP=@smoke npm run pipeline -- --pr 123
```

Absolute in effect, never silent: the report says the run was *overridden* rather than
planned, names what the filter left out, and shouts when it excludes a test this run
wrote. `TEST_GREP` is never a standing value in the CI definition — that would pin every
run, silently — but it is a `workflow_dispatch` input, because a field a person fills in
per run is the same instruction as a command they typed:

```bash
gh workflow run test-pipeline -f pr=123 -f test_grep=@smoke
```

A manual run has no PR context, so stage 1 needs either `-f pr=<number>` or
`-f from_scenarios=true`; given neither, the run stops rather than proceeding against an
empty change set.

A CI run can also tell the two apart. An override that arrived from somewhere other than a
run-time input is named as a *leftover* rather than accepted as a decision — the same silent
smaller-green, one layer up.

---

## The files that carry state

| Artifact | What it is |
|---|---|
| `scenarios/<domain>.txt` | the source of truth; a block's hash is its scenario's text |
| `artifacts/run/manifest.json` | threads the stages together; `scenarios[]` is one row per scenario with its verdict and reason |
| `artifacts/run/summary.md` | "what just happened", also printed to the console |
| `artifacts/run/run-report.json` | the redacted audit trail: every stage's verbatim output |
| `artifacts/run/heals.json` | this run's repairs and refusals, each with the test that used it and whether that test passed |
| `tests/<domain>/*.spec.ts` | generated blocks inside managed regions, handwritten tests outside them |

## One stage at a time

```bash
npm run pipeline -- --pr 123     # all 8 stages
npm run stage:2                  # re-run ONE stage against the last manifest
npm run stage:3 -- --domain landing-page
npm run stage:6 -- --grep @core  # a tiered playwright run
npm run self-checks              # the invariants, in seconds, no browser
```

See `README.md` for the commands and `pipeline-pattern.md` for why each gate is where
it is.
