"""Builds the "Playwright x AI" QA-workshop deck.

    python deck/build-deck.py

Writes deck/Playwright-AI-QA-Workshop.pptx (16:9, 10 slides, speaker notes).
Facts in it are taken from this repo: the 8 stage files, the scenario/verdict
model, the healer's refusals, and the last run's summary.md.
"""

from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

OUT = "deck/Playwright-AI-QA-Workshop.pptx"

# ── palette ────────────────────────────────────────────────────────────────
GREEN = RGBColor(0x2E, 0xAD, 0x33)   # Playwright green
GREEN_D = RGBColor(0x1E, 0x7A, 0x22)
DARK = RGBColor(0x17, 0x1B, 0x23)
INK = RGBColor(0x21, 0x26, 0x30)
MUTED = RGBColor(0x62, 0x6B, 0x7A)
FAINT = RGBColor(0x9A, 0xA2, 0xAE)
SOFT = RGBColor(0xF3, 0xF5, 0xF8)
LINE = RGBColor(0xDD, 0xE2, 0xE8)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
AMBER = RGBColor(0xB4, 0x6A, 0x00)
AMBER_BG = RGBColor(0xFF, 0xF6, 0xE5)
CODEBG = RGBColor(0x1E, 0x23, 0x2C)
CODEFG = RGBColor(0xE7, 0xEA, 0xF0)
CODECM = RGBColor(0x8C, 0x98, 0xA8)

FONT = "Segoe UI"
MONO = "Consolas"

M = 0.62                 # slide margin
W = 13.333               # slide width
H = 7.5                  # slide height
CW = W - 2 * M           # content width

prs = Presentation()
prs.slide_width = Inches(W)
prs.slide_height = Inches(H)
BLANK = prs.slide_layouts[6]


# ── helpers ────────────────────────────────────────────────────────────────
def slide(notes=""):
    s = prs.slides.add_slide(BLANK)
    if notes:
        s.notes_slide.notes_text_frame.text = notes
    return s


def rect(s, x, y, w, h, fill=None, line=None, radius=None,
         shape=MSO_SHAPE.ROUNDED_RECTANGLE, lw=1.0):
    sh = s.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    if radius is not None and shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        sh.adjustments[0] = radius
    if fill is None:
        sh.fill.background()
    else:
        sh.fill.solid()
        sh.fill.fore_color.rgb = fill
    if line is None:
        sh.line.fill.background()
    else:
        sh.line.color.rgb = line
        sh.line.width = Pt(lw)
    sh.shadow.inherit = False
    sh.text_frame.word_wrap = True
    return sh


def box(s, x, y, w, h, anchor=MSO_ANCHOR.TOP):
    tb = s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    return tf


def hang(p, lvl, glyph_w=0.30):
    """Hanging indent so wrapped lines align under the text, plus no bullet."""
    pPr = p._p.get_or_add_pPr()
    pPr.set("marL", str(int(Inches(glyph_w + 0.28 * lvl))))
    pPr.set("indent", str(int(-Inches(glyph_w))))
    pPr.append(pPr.makeelement(qn("a:buNone"), {}))


def para(tf, spans, size=15, color=INK, first=False, before=0, after=7,
         align=PP_ALIGN.LEFT, line=None):
    """spans: str, or [(text, bold, color|None), ...]"""
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.alignment = align
    p.space_before = Pt(before)
    p.space_after = Pt(after)
    if isinstance(spans, str):
        spans = [(spans, False, None)]
    for text, bold, c in spans:
        r = p.add_run()
        r.text = text
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.name = FONT
        r.font.color.rgb = c or color
    if line:
        p.line_spacing = line
    return p


def bullets(tf, items, size=15, color=INK, glyph="\u25aa", after=8, first=False):
    """items: (lvl, lead, rest) — lead is bold, rest plain.

    first=True only when this frame has no paragraph yet; otherwise the first
    bullet is appended to whatever paragraph is already there (which silently
    merges it into a heading).
    """
    for i, (lvl, lead, rest) in enumerate(items):
        p = tf.paragraphs[0] if (i == 0 and first) else tf.add_paragraph()
        p.space_before = Pt(0)
        p.space_after = Pt(after)
        hang(p, lvl)
        g = p.add_run()
        g.text = (glyph if lvl == 0 else "\u2013") + "   "
        g.font.size = Pt(size)
        g.font.bold = True
        g.font.name = FONT
        g.font.color.rgb = GREEN if lvl == 0 else FAINT
        if lead:
            r = p.add_run()
            r.text = lead
            r.font.size = Pt(size)
            r.font.bold = True
            r.font.name = FONT
            r.font.color.rgb = INK
        if rest:
            r = p.add_run()
            r.text = rest
            r.font.size = Pt(size)
            r.font.name = FONT
            r.font.color.rgb = color


def title(s, text, kicker=None, sub=None):
    tf = box(s, M, 0.42, CW, 0.72)
    para(tf, text, size=29, color=DARK, first=True, after=0)
    y = 1.16
    if kicker:
        para(tf, kicker, size=12.5, color=GREEN_D, after=0)
    rect(s, M, y, 1.15, 0.055, fill=GREEN, radius=0.5)
    if sub:
        tfs = box(s, M, y + 0.16, CW, 0.32)
        para(tfs, sub, size=14, color=MUTED, first=True, after=0)


def footer(s, n):
    tf = box(s, M, H - 0.52, CW, 0.3)
    para(tf, [("Playwright \u00d7 AI  \u00b7  QA workshop", False, FAINT),
              ("        " + str(n) + "/10", False, FAINT)],
         size=10.5, first=True, after=0)


def callout(s, y, spans, h=0.62, bg=SOFT, edge=GREEN, size=13.5):
    rect(s, M, y, CW, h, fill=bg, radius=0.10)
    rect(s, M, y, 0.075, h, fill=edge, shape=MSO_SHAPE.RECTANGLE)
    tf = box(s, M + 0.28, y + 0.055, CW - 0.5, h - 0.11, anchor=MSO_ANCHOR.MIDDLE)
    para(tf, spans, size=size, first=True, after=0, line=1.15)


def code(s, x, y, w, h, lines, size=11.5):
    rect(s, x, y, w, h, fill=CODEBG, radius=0.055)
    tf = box(s, x + 0.22, y + 0.18, w - 0.44, h - 0.36, anchor=MSO_ANCHOR.MIDDLE)
    for i, (text, cm) in enumerate(lines):
        para(tf, text, size=size, color=CODECM if cm else CODEFG,
             first=(i == 0), after=3.5, line=1.0)


def plain_table(s, x, y, w, h, rows, widths, header_size=11.5, body_size=11.5,
                row_h=0.66):
    gf = s.shapes.add_table(len(rows), len(widths), Inches(x), Inches(y),
                            Inches(w), Inches(h))
    t = gf.table
    t.first_row = False
    t.horz_banding = False
    tblPr = t._tbl.find(qn("a:tblPr"))
    for el in tblPr.findall(qn("a:tableStyleId")):
        tblPr.remove(el)
    sid = tblPr.makeelement(qn("a:tableStyleId"), {})
    sid.text = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"   # No Style, No Grid
    tblPr.append(sid)
    for i, wd in enumerate(widths):
        t.columns[i].width = Inches(wd)
    for r, row in enumerate(rows):
        t.rows[r].height = Inches(row_h if r else 0.42)
        for c, val in enumerate(row):
            cell = t.cell(r, c)
            cell.margin_left = Inches(0.13)
            cell.margin_right = Inches(0.10)
            cell.margin_top = Inches(0.05)
            cell.margin_bottom = Inches(0.05)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.fill.solid()
            cell.fill.fore_color.rgb = DARK if r == 0 else (
                WHITE if r % 2 else SOFT)
            tf = cell.text_frame
            tf.word_wrap = True
            para(tf, val, size=header_size if r == 0 else body_size,
                 color=WHITE if r == 0 else INK,
                 first=True, after=0, line=1.05,
                 align=PP_ALIGN.LEFT)
            if r == 0:
                for p in tf.paragraphs:
                    for run in p.runs:
                        run.font.bold = True
    return t


# ══════════════════════════════════════════════════════════════════════════
# 1 — title
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "Welcome + agenda, 2 minutes. Set the expectation that shapes the whole "
    "session: everything here is built around the question 'would this failure "
    "be visible?'. The AI is the part that is easy; the gates are the part that "
    "was hard. We will not cover how to write Playwright tests - we assume the "
    "room already can."))
rect(s, 0, 0, W, H, fill=DARK, shape=MSO_SHAPE.RECTANGLE)
rect(s, 0, 0, W, 0.14, fill=GREEN, shape=MSO_SHAPE.RECTANGLE)

tf = box(s, M + 0.2, 2.05, CW - 1.2, 1.5)
para(tf, [("Playwright", True, WHITE), ("  \u00d7  ", False, GREEN),
          ("AI", True, WHITE)], size=54, first=True, after=6)
para(tf, "How an AI test pipeline writes tests you can still trust",
     size=21, color=RGBColor(0xC7, 0xCE, 0xD8), after=0)

rect(s, M + 0.2, 3.95, 1.5, 0.06, fill=GREEN, radius=0.5, shape=MSO_SHAPE.RECTANGLE)

tf = box(s, M + 0.2, 4.28, CW - 1.6, 1.4)
para(tf, [("QA workshop", True, RGBColor(0xE7, 0xEA, 0xF0)),
          ("  \u00b7  an introduction to the mechanism  \u00b7  2 hours", False,
           RGBColor(0x9A, 0xA2, 0xAE))], size=14.5, first=True, after=12)
para(tf, "8 stages \u00b7 issue in, reviewed PR out \u00b7 AI proposes, code enforces",
     size=14.5, color=RGBColor(0x9A, 0xA2, 0xAE), after=0)

tf = box(s, M + 0.2, H - 0.75, CW - 1.2, 0.3)
para(tf, "The pipeline described here is the boilerplate in this repository \u2014 "
         "a pattern, not a library.", size=11, color=RGBColor(0x6B, 0x72, 0x80),
     first=True, after=0)

# ══════════════════════════════════════════════════════════════════════════
# 2 — why
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "Ask the room for their own version of each of these four - 30 seconds "
    "each, this is the slide that buys the rest of the session. The last line is "
    "the thesis of the whole deck: AI writing a test is not the bottleneck, "
    "trusting it is. Everything you will see after this is machinery for that."))
title(s, "Start with the pain you already have",
      kicker="WHY THIS EXISTS")
tf = box(s, M, 1.95, CW, 3.2)
bullets(tf, [
    (0, "Tests drift. ",
     "The app moves, the locator does not. Maintenance eats the sprint, and it is the "
     "least interesting work on the board."),
    (0, "Coverage is invisible. ",
     "Which of these 40 tests still tests something? Which one has quietly stopped "
     "asserting anything at all?"),
    (0, "Writing a test is slow; writing a good one is slower. ",
     "The judgement that makes a test worth having does not scale with headcount."),
    (0, "AI can write tests today. ",
     "That was never the hard part \u2014 trusting the result is."),
], size=16, first=True)
callout(s, 5.45, [
    ("AI proposes. ", True, GREEN_D),
    ("Code enforces. ", True, INK),
    ("That single sentence is the design of everything that follows.", False, MUTED)])
footer(s, 2)

# ══════════════════════════════════════════════════════════════════════════
# 3 — the pipeline
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "Walk left to right, 20 seconds per card. Two things to land: the artefacts "
    "passed between phases are files on disk (a scenario file, a page object, a "
    "manifest), not chat history - which is what makes one stage re-runnable on "
    "its own. And a human reviews the PR; nothing merges itself. This is the same "
    "diagram as WORKFLOW.md, where it is Mermaid source with the three decision "
    "flows (the block hash, the healer, the planner)."))
title(s, "Eight stages: an issue in, a reviewed PR out",
      kicker="THE MECHANISM")
tf = box(s, M, 1.55, CW, 0.3)
para(tf, [("Input: ", True, MUTED), ("a GitHub issue + PR diff", False, INK),
          ("        \u2192        ", False, FAINT),
          ("Output: ", True, MUTED), ("tests, healed locators, a PR", False, INK),
          ("   \u2014 a human reviews it", False, MUTED)],
     size=13.5, first=True, after=0)

cards = [
    ("PHASE 1", "Decide what to cover", GREEN,
     ["1  gap-analysis", "2  testcase-digest"],
     "read the diff \u2192 risk areas \u2192 scenarios"),
    ("PHASE 2", "Build the vocabulary", RGBColor(0x2C, 0x7F, 0xB8),
     ["3  pom-builder", "4  digest-retry"],
     "drive the live app, write page objects"),
    ("PHASE 3", "Run it", RGBColor(0x7A, 0x54, 0xB8),
     ["5  test-plan", "6  playwright-test"],
     "an agent picks a scope, then run by tag"),
    ("PHASE 4", "Repair & ship", RGBColor(0xC0, 0x69, 0x1E),
     ["7  heal-apply", "8  git"],
     "fold in verified locator repairs, open a PR"),
]
cw, gap = 2.72, 0.35
y0, ch = 2.1, 2.35
for i, (tag, name, col, stages, sub) in enumerate(cards):
    x = M + i * (cw + gap)
    rect(s, x, y0, cw, ch, fill=WHITE, line=LINE, radius=0.07)
    rect(s, x, y0, cw, 0.075, fill=col, radius=0.4, shape=MSO_SHAPE.RECTANGLE)
    tf = box(s, x + 0.24, y0 + 0.3, cw - 0.48, ch - 0.5)
    para(tf, tag, size=10, color=col, first=True, after=3)
    para(tf, name, size=15.5, color=DARK, after=9)
    for st in stages:
        para(tf, st, size=11.5, color=INK, after=2.5)
    para(tf, sub, size=10.5, color=MUTED, before=7, after=0, line=1.1)
    if i < 3:
        a = rect(s, x + cw + 0.045, y0 + ch / 2 - 0.13, 0.26, 0.26, fill=GREEN,
                 shape=MSO_SHAPE.RIGHT_ARROW)

callout(s, 4.75, [("Re-runnable one at a time. ", True, INK),
                  ("npm run stage:2", False, GREEN_D),
                  (" re-runs a single stage against the manifest the last run "
                   "left on disk \u2014 that is the debug handle, and how you "
                   "learn the system.", False, MUTED)], h=0.72)
callout(s, 5.62, [("Fatal vs recorded. ", True, INK),
                  ("Stages 1\u20132 are fatal (they decide what to cover). "
                   "3\u20137 record their failure and the run continues, so you "
                   "get the whole picture in one pass.", False, MUTED)], h=0.72,
        bg=WHITE, edge=FAINT)
footer(s, 3)

# ══════════════════════════════════════════════════════════════════════════
# 4 — scenarios
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "The key idea: the scenario file is the source of truth and the only lever. "
    "A generated block's hash is taken from its scenario's text, so changing a "
    "test means changing the scenario and re-running stage 2. Hand-editing the "
    "spec is overwritten on the next digest - that is a feature, it is what "
    "makes the generated half reviewable. If someone asks 'so who wrote this "
    "line?' the answer is: outside the managed region, a human."))
title(s, "Scenarios in plain English, tests out",
      kicker="STAGE 1\u20132  \u00b7  WHAT TO COVER")
code(s, M, 1.85, 5.5, 3.55, [
    ("# scenarios/landing-page.txt", True),
    ("", False),
    ("TEST: The pricing section lists all", False),
    ("      six packages", False),
    ("Tags: @core @smoke", False),
    ("Expected: Six package cards, each", False),
    ("          with a price.", False),
    ("Notes: Prices come from the CMS,", False),
    ("       not hardcoded.", False),
    ("", False),
    ("---", True),
    ("", False),
    ("TEST: <next scenario>\u2026", True),
], size=11.5)

x2 = M + 5.9
tf = box(s, x2, 1.9, CW - 5.9, 3.5)
bullets(tf, [
    (0, "A non-engineer can write and review one. ",
     "The scenario is the source of truth, not the generated code."),
    (0, "Each one becomes a real Playwright test, ",
     "tagged for scoped runs."),
    (0, "Generated code lives only inside a managed region. ",
     "Between @digest:managed:start and :end. Everything outside it is "
     "handwritten and never touched \u2014 so a reviewer knows exactly which "
     "lines had no author."),
], size=13.5, after=9)

tf = box(s, x2, 5.05, CW - 5.9, 0.5)
para(tf, "Four verdicts per scenario", size=12, color=DARK, first=True, after=6)
para(tf, [("generated", True, GREEN_D), ("  \u00b7  ", False, FAINT),
          ("held", True, INK), ("  \u00b7  ", False, FAINT),
          ("covered", True, INK), ("  \u00b7  ", False, FAINT),
          ("unbuildable", True, AMBER)], size=12.5, after=0)

callout(s, 5.72, [("Editing the scenario is the only way to change a generated test. ",
                   True, INK),
                  ("A block's hash is its scenario's text \u2014 hash moved, "
                   "re-digest; hash equal, kept verbatim. Hand-editing the spec "
                   "is overwritten, on purpose.", False, MUTED)], h=0.78)
footer(s, 4)

# ══════════════════════════════════════════════════════════════════════════
# 5 — page objects
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "This is the rule that surprises people. No expect() in a spec, ever - it is "
    "checked by a self-check that fails the build. The reason is not style: the "
    "page object is the capability index, and the classifier asks 'can the page "
    "objects express this scenario?'. An assertion hand-rolled in a spec is "
    "invisible to that question, so the scenario looks satisfied while the "
    "capability is still missing. Assertions in the POM turn a missing "
    "capability into a visible build order."))
title(s, "Assertions live in the page object, never in the spec",
      kicker="STAGE 3\u20134  \u00b7  BUILD THE VOCABULARY")
code(s, M, 1.85, 6.6, 2.15, [
    ("test('The pricing section lists all six packages',", False),
    ("     { tag: ['@core', '@smoke'] },", False),
    ("     async ({ landingPage }) => {", False),
    ("  await landingPage.goto();", False),
    ("  await landingPage.expectPricingListsAllPackages();", False),
    ("});", False),
], size=11.5)
tf = box(s, M, 4.18, 6.6, 2.1)
bullets(tf, [
    (0, "A spec navigates and calls intent-naming methods. ",
     "That is its whole job. No page.locator, no setViewportSize, no expect."),
    (0, "Every assertion carries a message, ",
     "so a failure reads as intent \u2014 not as two locator strings."),
], size=13, after=9, first=True)

x2 = M + 7.0
tf = box(s, x2, 1.9, CW - 7.0, 4.4)
para(tf, "Why it is load-bearing", size=15, color=DARK, first=True, after=10)
bullets(tf, [
    (0, "The page object is the capability index. ",
     "A scenario the POM cannot express is classified unbuildable, skips "
     "generation, and becomes a stage-4 work order instead of a test."),
    (0, "That is the second gate. ",
     "'Is it already covered?' is not enough \u2014 if the POM cannot express "
     "the novel part, generation would drop exactly the behaviour that made "
     "the scenario worth writing, and leave a duplicate that still passes."),
    (0, "Stage 3 drives the live app ",
     "and appends what it learns to that domain's instruction.md."),
], size=12.5, after=9)
footer(s, 5)

# ══════════════════════════════════════════════════════════════════════════
# 6 — what gets run
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "The dangerous failure mode here is not red, it is a smaller green run. "
    "Four separate defences: tags written by the machinery from the scenario "
    "file (never trusted to the model), a planner agent that only proposes a "
    "scope while the code turns it into the filter, selection by tag rather than "
    "by title, and the planner failing open with an enforced floor. And one "
    "deliberate exception, worth flagging: a human can override the whole thing "
    "with TEST_GREP, which skips the agent and steps around the floor — because "
    "the human is the merge gate — but the report then says the run was "
    "overridden and names anything it left out. If you take one habit away: when "
    "a run is green, ask what it did not run."))
title(s, "What actually gets run today",
      kicker="STAGE 5\u20136  \u00b7  RUN IT")
tf = box(s, M, 1.85, CW, 3.1)
bullets(tf, [
    (0, "Tags come from the scenario file and are written by the machinery \u2014 ",
     "never trusted to the model. A model that forgets a tag would produce a "
     "smaller green run, which is not an error anyone sees."),
    (0, "The agent proposes the scope; the code decides. ",
     "smoke, sanity or regression \u2014 the answer is a name, never a filter. "
     "A model cannot narrow a run past the floor, however confidently it answers."),
    (0, "A scoped run selects by tag, not by title. ",
     "npm run stage:6 -- --grep @smoke|@core. A title filter would drop a test "
     "the moment a generated title disagreed with its scenario title \u2014 "
     "silently, as a smaller green run. A test that tags nothing is invisible to "
     "it, and the run summary says so out loud rather than letting you assume it "
     "ran."),
    (0, "The planner fails open, with an enforced floor. ",
     "Any degraded input widens the run to the full suite with a named reason, "
     "and everything generated this run always runs \u2014 the creation-date tag "
     "stage 2 stamps on it."),
], size=13.5, after=8, first=True)
callout(s, 5.35, [("The failure to watch for is not a red run. ", True, INK),
                  ("It is a smaller green run \u2014 everything that ran passed, "
                   "and the test that would have failed never ran at all.",
                   False, MUTED)], h=0.78, bg=AMBER_BG, edge=AMBER)
footer(s, 6)

# ══════════════════════════════════════════════════════════════════════════
# 7 — healer
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "Two halves and the second one is the point. Healing a stale locator is "
    "mechanical - there is no model in that path, deliberately: a guessed "
    "locator that is wrong does not fail, it asserts against the wrong element "
    "and passes. And the healer refuses loudly, because repairing 'the feature "
    "is gone' turns a real regression into a green lie. Best story in the deck: "
    "the locale guard. /id says 'Portofolio', 0.90 similar to the English "
    "'Portfolio' - without the guard one run against /id would have rewritten "
    "the English copy and broken /en."))
title(s, "When the app moves and the selector doesn't",
      kicker="STAGE 7  \u00b7  REPAIR")
half = (CW - 0.55) / 2
for i, (h, col, items) in enumerate([
    ("How it heals", GREEN, [
        ("this.loc(selector)", " \u2014 a raw CSS string: narrow the selector that broke."),
        ("this.byCopy(text, build)", " \u2014 an element identified by its copy: take the nearest on-page text, only when it is uniquely nearest and above a high similarity floor."),
        ("No model in this path.", " A CSS candidate is a mechanical narrowing; a copy candidate is a distance. Two near-identical candidates are a coin toss, so neither is taken \u2014 a wrong locator that matches the wrong element passes, which is worse than the honest failure it replaced."),
    ]),
    ("When it refuses \u2014 also the job", AMBER, [
        ("The feature is genuinely gone.", " A real failure, for a human."),
        ("A timing or state failure.", " A test bug, not a locator bug."),
        ("The copy belongs to another locale.", " /en \u201cPortfolio\u201d vs /id \u201cPortofolio\u201d is 0.90 similar \u2014 unguarded, one run against /id would rewrite the English copy and break /en."),
        ("Every refusal is recorded with a named reason.", " no-candidate \u00b7 ambiguous \u00b7 not-unique \u00b7 locale-mismatch."),
    ]),
]):
    x = M + i * (half + 0.55)
    rect(s, x, 1.82, half, 3.55, fill=WHITE if i else SOFT, line=LINE, radius=0.07)
    tf = box(s, x + 0.28, 2.0, half - 0.56, 3.2)
    para(tf, h, size=14.5, color=col if i else GREEN_D, first=True, after=10)
    for lead, rest in items:
        p = tf.add_paragraph()
        p.space_after = Pt(8)
        hang(p, 0, 0.26)
        g = p.add_run()
        g.text = ("\u25aa   " if not i else "\u25aa   ")
        g.font.size = Pt(12.5)
        g.font.bold = True
        g.font.name = FONT
        g.font.color.rgb = col if i else GREEN
        r = p.add_run()
        r.text = lead
        r.font.size = Pt(12.5)
        r.font.bold = True
        r.font.name = FONT
        r.font.color.rgb = INK
        r = p.add_run()
        r.text = rest
        r.font.size = Pt(12.5)
        r.font.name = FONT
        r.font.color.rgb = MUTED

code(s, M, 5.5, CW, 0.72, [
    ("[self-heal] 1 locator repaired:  'Macroz and Product Photographer' \u2192 "
     "'Macro and Product Photographer'   (the test passed on it)", False),
], size=11.5)
callout(s, 6.4, [("A heal is only as good as the test that used it. ", True, INK),
                 ("Only a repair whose test PASSED is written into the source; "
                  "a repair whose test failed is declined and named. Otherwise a "
                  "failing test disappears and a wrong locator gets committed.",
                  False, MUTED)], h=0.66)
footer(s, 7)

# ══════════════════════════════════════════════════════════════════════════
# 8 — the silent green
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "This is the intellectual core of the session - spend the most time here. "
    "Every row is a real thing that happened in this repository, and every one "
    "of them was green. Ask the room: 'how would you have caught this?' then "
    "point at the third column: a gate in code, not a rule in a prompt. The last "
    "row is the one that cannot be fixed by better assertions - the page itself "
    "does not render, so ask what the contract is instead."))
title(s, "The bug class this is all built against: the silent green",
      kicker="WHY THE GATES EXIST")
rows = [
    ["It looked like this\u2026", "What it actually was", "Caught by"],
    ["Test passed \u2014 no visual error",
     "The check was blind: a 300px widget in a 276px form column spilled 24px, "
     "while the document's scroll width never changed.",
     "Measuring elements, not just the document"],
    ["\u201cAlready covered\u201d, no change made",
     "A stale test vouched for itself: the classifier was asked with the old "
     "block's own title in the evidence list, so an edited scenario never "
     "reached the spec.",
     "The block hash decides first"],
    ["Locator healed, test passed",
     "The repair pointed at the neighbouring element and the assertion then "
     "failed. Folding it in would commit a wrong locator and delete the failure.",
     "Only a test-passed repair is written"],
    ["--grep @core passed",
     "An untagged test was never selected at all.",
     "Tags re-applied from the scenario"],
    ["\u201cWaited for the widget, passed\u201d",
     "Cloudflare never renders the Turnstile frame in an automated browser \u2014 "
     "nothing was measured, and the test could not fail.",
     "Assert the contract, not the widget"],
]
plain_table(s, M, 1.72, CW, 4.6, rows, [3.35, 5.8, 2.94],
            header_size=11.5, body_size=11, row_h=0.83)
callout(s, 6.55, [("So: ", True, INK),
                  ("every gate here is a matcher over the output \u2014 not an "
                   "instruction in a prompt. A prompt forbidding something is a "
                   "suggestion; a matcher is enforcement.", False, MUTED)],
        h=0.6)
footer(s, 8)

# ══════════════════════════════════════════════════════════════════════════
# 9 — who decides
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "The one-slide summary of the division of labour. If the room remembers one "
    "thing from the workshop, make it this table: the left column is where AI "
    "adds value, the right column is why you can trust the left. Note that "
    "nothing in the right column is a sentence we asked the model to follow - "
    "each is code that runs whether the model cooperates or not."))
title(s, "AI proposes. Code enforces.",
      kicker="THE DIVISION OF LABOUR")
half = (CW - 0.55) / 2
for i, (h, col, bg, items) in enumerate([
    ("AI's job", RGBColor(0x2C, 0x7F, 0xB8), SOFT, [
        "Draft scenarios from the issue and the diff (stage 1)",
        "Write the test block from the scenario (stage 2)",
        "Classify coverage and buildability; propose locators and methods (3\u20134)",
        "Read a feature area by driving the real app, and write down what it learned",
    ]),
    ("Code's job \u2014 never the prompt", GREEN_D, WHITE, [
        "The block hash decides hold / re-digest / classify: scenario text is the only lever",
        "Tags are re-applied from the scenario on every run, not remembered",
        "Every claimed capability is matched against the real page-object surface",
        "Generated code stays inside the managed region; agent writes are additive-only",
        "Degraded input fails open with a named reason; a malformed value throws",
    ]),
]):
    x = M + i * (half + 0.55)
    rect(s, x, 1.8, half, 3.5, fill=bg, line=LINE, radius=0.07)
    rect(s, x, 1.8, half, 0.075, fill=col, radius=0.4, shape=MSO_SHAPE.RECTANGLE)
    tf = box(s, x + 0.3, 2.05, half - 0.6, 3.1)
    para(tf, h, size=15, color=col, first=True, after=11)
    for it in items:
        p = tf.add_paragraph()
        p.space_after = Pt(8)
        hang(p, 0, 0.26)
        g = p.add_run()
        g.text = "\u25aa   "
        g.font.size = Pt(12.5)
        g.font.bold = True
        g.font.name = FONT
        g.font.color.rgb = col
        r = p.add_run()
        r.text = it
        r.font.size = Pt(12.5)
        r.font.name = FONT
        r.font.color.rgb = INK

callout(s, 5.5, [("A prompt forbidding something is a suggestion. ",
                  True, INK),
                 ("The rule has to hold over the output \u2014 so it is a check "
                  "that runs, and a report line that names what it refused.",
                  False, MUTED)], h=0.72)
callout(s, 6.38, [("60 invariants run in seconds, with no browser. ",
                   True, GREEN_D),
                  ("npm run self-checks \u2014 added whenever the failure would "
                   "have been silent. That last clause is the whole rule.",
                   False, MUTED)], h=0.7, bg=SOFT, edge=GREEN)
footer(s, 9)

# ══════════════════════════════════════════════════════════════════════════
# 10 — current state + try it
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "Close with the honest state, including the failing test - it is the best "
    "evidence the thing works, because the failure is a real defect the suite "
    "found and a person had already reported. Then the hands-on plan: read a "
    "scenario, watch stage 2 write the test, break a locator, watch stage 7 heal "
    "it and decline a bad one. That loop is the whole system in 20 minutes."))
title(s, "Where it stands \u2014 and running it yourself",
      kicker="CURRENT STATE  \u00b7  HANDS-ON")
half = (CW - 0.55) / 2
rect(s, M, 1.8, half, 3.4, fill=WHITE, line=LINE, radius=0.07)
tf = box(s, M + 0.3, 2.02, half - 0.6, 3.0)
para(tf, "As of today, in this repo", size=14.5, color=GREEN_D, first=True, after=10)
bullets(tf, [
    (0, "1 domain", " (landing-page) \u00b7 12 scenarios \u00b7 60 self-check invariants."),
    (0, "Last digest: 12 scenarios \u2192 1 generated, 11 kept ", "in 2.6s."),
    (0, "Suite: 11 passed \u00b7 1 failed \u2014 ",
     "and the failure is a defect it found: the Turnstile slot is 276px "
     "against the 300px widget it declares."),
    (0, "DEBUG=true", " narrates a run, AI calls as request/response, long "
     "content truncated with an ellipsis."),
], size=12.5, after=8)

x2 = M + half + 0.55
rect(s, x2, 1.8, half, 3.4, fill=CODEBG, radius=0.07)
tf = box(s, x2 + 0.3, 2.05, half - 0.6, 2.9)
para(tf, "Try it \u2014 the whole loop", size=14, color=WHITE, first=True, after=12)
for line in [
    "npm ci",
    "cp .env.example .env     # BASE_URL, MODEL_API_KEY",
    "npm run self-checks      # cheap gates, no browser",
    "npm test                 # the whole suite",
    "npm run pipeline -- --pr 123",
    "npm run stage:2          # re-run ONE stage",
]:
    para(tf, line, size=11.5, color=CODEFG, after=5)

callout(s, 5.42, [("Hands-on, next 60 minutes: ", True, GREEN_D),
                  ("read a scenario \u2192 run stage 2 and watch the test appear "
                   "\u2192 break a locator and watch the healer repair it \u2192 "
                   "then watch it refuse to repair a bad one.", False, MUTED)],
        h=0.74)
callout(s, 6.28, [("Questions, and the three files worth reading first: ",
                   True, INK),
                  ("README.md", False, GREEN_D),
                  (" (how to run it), ", False, MUTED),
                  ("WORKFLOW.md", False, GREEN_D),
                  (" (the workflow as diagrams) and ", False, MUTED),
                  ("pipeline-pattern.md", False, GREEN_D),
                  (" (why every gate is where it is).", False, MUTED)],
        h=0.68, bg=WHITE, edge=FAINT)
footer(s, 10)

prs.save(OUT)
print("wrote", OUT, "-", len(prs.slides._sldIdLst), "slides")
