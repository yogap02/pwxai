"""Builds the "Playwright x AI" QA-workshop deck.

    python deck/build-deck.py

Writes deck/Playwright-AI-QA-Workshop.pptx (16:9, 10 slides, speaker notes).
Facts in it are taken from this repo: the 9 stage files, the scenario/verdict
model, the two report statuses, the healer's refusals, the two domains, and the
last run's summary.md.

Style rule, applied throughout: short lines and a highlighted lead on every
POINT, not on the heading. Fewer words buy a larger body size, which is the
point of the layout.
"""

from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

OUT = "deck/Playwright-AI-QA-Workshop.pptx"

# ── palette ────────────────────────────────────────────────────────────────
# One hue, two tones. ACCENT is the brand cyan and is used only for things that
# carry no text: bars, rules, arrows, card edges. ACCENT_D is the same hue
# darkened until it clears 4.5:1 on both white and SOFT, because #43B7DC as
# body text measures 2.3:1 — legible as a stripe, not as a sentence.
ACCENT = RGBColor(0x43, 0xB7, 0xDC)    # #43B7DC — fills and rules, never text
ACCENT_D = RGBColor(0x1C, 0x78, 0x96)  # same hue, 5.0:1 on white, 4.6:1 on SOFT
DARK = RGBColor(0x17, 0x1B, 0x23)
INK = RGBColor(0x21, 0x26, 0x30)
MUTED = RGBColor(0x62, 0x6B, 0x7A)
FAINT = RGBColor(0x9A, 0xA2, 0xAE)
SOFT = RGBColor(0xF3, 0xF5, 0xF8)
LINE = RGBColor(0xDD, 0xE2, 0xE8)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
AMBER = RGBColor(0xB4, 0x6A, 0x00)
AMBER_BG = RGBColor(0xFF, 0xF6, 0xE5)
# Indigo, not blue: the old #2C7FB8 sat only dE 17 from the cyan accent, so
# "phase 2" and "phase 1" read as the same colour. This is dE 38 away.
BLUE = RGBColor(0x3A, 0x53, 0x9E)
PURPLE = RGBColor(0x7A, 0x54, 0xB8)    # 5.5:1
ORANGE = RGBColor(0xA4, 0x57, 0x16)    # darkened from #C0691E, which was 4.0:1
CODEBG = RGBColor(0x1E, 0x23, 0x2C)
CODEFG = RGBColor(0xE7, 0xEA, 0xF0)
CODECM = RGBColor(0x8C, 0x98, 0xA8)

FONT = "Segoe UI"

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


def hang(p, lvl=0, glyph_w=0.34):
    """Hanging indent so wrapped lines align under the text, plus no bullet."""
    pPr = p._p.get_or_add_pPr()
    pPr.set("marL", str(int(Inches(glyph_w + 0.28 * lvl))))
    pPr.set("indent", str(int(-Inches(glyph_w))))
    pPr.append(pPr.makeelement(qn("a:buNone"), {}))


def para(tf, spans, size=17, color=INK, first=False, before=0, after=8,
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


def point(tf, hl, rest="", size=17, color=INK, accent=ACCENT_D, first=False,
          after=10, glyph="\u25aa", glyph_color=None):
    """One bullet: the LEAD is the highlight, the rest is the gloss.

    Highlighting the point rather than the heading is the whole style rule: a
    reader's eye should land on the claim, and the sentence under it is optional
    detail they can skip.
    """
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.space_before = Pt(0)
    p.space_after = Pt(after)
    hang(p)
    g = p.add_run()
    g.text = glyph + "   "
    g.font.size = Pt(size)
    g.font.bold = True
    g.font.name = FONT
    g.font.color.rgb = glyph_color or accent
    r = p.add_run()
    r.text = hl
    r.font.size = Pt(size)
    r.font.bold = True
    r.font.name = FONT
    r.font.color.rgb = accent
    if rest:
        r = p.add_run()
        r.text = " " + rest
        r.font.size = Pt(size)
        r.font.name = FONT
        r.font.color.rgb = color
    return p


def title(s, text, kicker=None, sub=None):
    """Heading, deliberately quiet: dark, no colour block, no green word."""
    tf = box(s, M, 0.40, CW, 0.72)
    para(tf, text, size=27, color=DARK, first=True, after=0)
    if kicker:
        para(tf, kicker, size=11.5, color=FAINT, after=0)
    rect(s, M, 1.14, 0.85, 0.045, fill=ACCENT, radius=0.5)
    if sub:
        tfs = box(s, M, 1.30, CW, 0.30)
        para(tfs, sub, size=15, color=MUTED, first=True, after=0)


def footer(s, n):
    tf = box(s, M, H - 0.48, CW, 0.28)
    para(tf, [("Playwright \u00d7 AI  \u00b7  QA workshop", False, FAINT),
              ("        " + str(n) + "/10", False, FAINT)],
         size=10.5, first=True, after=0)


def callout(s, y, spans, h=0.66, bg=SOFT, edge=ACCENT, size=15):
    rect(s, M, y, CW, h, fill=bg, radius=0.10)
    rect(s, M, y, 0.07, h, fill=edge, shape=MSO_SHAPE.RECTANGLE)
    tf = box(s, M + 0.26, y + 0.05, CW - 0.46, h - 0.10, anchor=MSO_ANCHOR.MIDDLE)
    para(tf, spans, size=size, first=True, after=0, line=1.12)


def code(s, x, y, w, h, lines, size=12.5):
    rect(s, x, y, w, h, fill=CODEBG, radius=0.055)
    tf = box(s, x + 0.22, y + 0.16, w - 0.44, h - 0.32, anchor=MSO_ANCHOR.MIDDLE)
    for i, (text, cm) in enumerate(lines):
        para(tf, text, size=size, color=CODECM if cm else CODEFG,
             first=(i == 0), after=4, line=1.0)


def plain_table(s, x, y, w, h, rows, widths, header_size=12.5, body_size=12.5,
                row_h=0.68):
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
        t.rows[r].height = Inches(row_h if r else 0.44)
        for c, val in enumerate(row):
            cell = t.cell(r, c)
            cell.margin_left = Inches(0.14)
            cell.margin_right = Inches(0.10)
            cell.margin_top = Inches(0.04)
            cell.margin_bottom = Inches(0.04)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.fill.solid()
            cell.fill.fore_color.rgb = DARK if r == 0 else (
                WHITE if r % 2 else SOFT)
            tf = cell.text_frame
            tf.word_wrap = True
            para(tf, val, size=header_size if r == 0 else body_size,
                 color=WHITE if r == 0 else INK,
                 first=True, after=0, line=1.04,
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
rect(s, 0, 0, W, 0.14, fill=ACCENT, shape=MSO_SHAPE.RECTANGLE)

tf = box(s, M + 0.2, 2.05, CW - 1.2, 1.5)
para(tf, [("Playwright", True, WHITE), ("  \u00d7  ", False, ACCENT),
          ("AI", True, WHITE)], size=54, first=True, after=6)
para(tf, "How an AI test pipeline writes tests you can still trust",
     size=22, color=RGBColor(0xC7, 0xCE, 0xD8), after=0)

rect(s, M + 0.2, 3.95, 1.5, 0.06, fill=ACCENT, radius=0.5, shape=MSO_SHAPE.RECTANGLE)

tf = box(s, M + 0.2, 4.32, CW - 1.6, 1.4)
para(tf, [("QA workshop", True, RGBColor(0xE7, 0xEA, 0xF0)),
          ("  \u00b7  an introduction to the mechanism  \u00b7  2 hours", False,
           RGBColor(0x9A, 0xA2, 0xAE))], size=15, first=True, after=12)
para(tf, "9 stages \u00b7 a deployment in, a reviewed PR out \u00b7 AI proposes, code enforces",
     size=15, color=RGBColor(0x9A, 0xA2, 0xAE), after=0)

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
    "trusting it is. Everything after this is machinery for that."))
title(s, "Start with the pain you already have", kicker="WHY THIS EXISTS")
tf = box(s, M, 1.80, CW, 3.6)
point(tf, "Tests drift.", "The app moves, the locator doesn't.", size=23, first=True, after=26)
point(tf, "Coverage is invisible.", "Which of these 40 tests still asserts anything?",
      size=23, after=26)
point(tf, "Good tests are slow.", "The judgement doesn't scale with headcount.",
      size=23, after=26)
point(tf, "AI writes tests already.", "Trusting them is the hard part.", size=23,
      after=4)
callout(s, 5.45, [
    ("AI proposes. ", True, ACCENT_D),
    ("Code enforces. ", True, INK),
    ("Everything after this slide is machinery for that.", False, MUTED)],
    h=0.80, size=18)
footer(s, 2)

# ══════════════════════════════════════════════════════════════════════════
# 3 — the pipeline
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "Walk left to right, 20 seconds per card. Three things to land. (1) What "
    "passes between phases is files on disk - a scenario file, a page object, a "
    "manifest - not chat history, which is what makes one stage re-runnable on "
    "its own. (2) Stage 9 is a real stage: the run reports itself to a chat, "
    "because the person who needs to know is usually not watching the Actions "
    "tab. (3) A human reviews the PR; nothing merges itself. Same diagram as "
    "WORKFLOW.md, where it is Mermaid source with the four decision flows."))
title(s, "Nine stages: a deployment in, a reviewed PR out",
      kicker="THE MECHANISM")
tf = box(s, M, 1.40, CW, 0.52)
para(tf, [("Input: ", True, MUTED), ("a deployed change + its PR diff", False, INK),
          ("      \u2192      ", False, FAINT),
          ("Output: ", True, MUTED), ("tests, a PR, a report", False, INK),
          ("   \u2014 a human reviews the PR", False, MUTED)],
     size=13.5, first=True, after=0)

cards = [
    ("PHASE 1", "Decide what to cover", ACCENT, ACCENT_D,
     ["1  gap-analysis", "2  testcase-digest"],
     "diff \u2192 risk areas \u2192 scenarios"),
    ("PHASE 2", "Build the vocabulary", BLUE, BLUE,
     ["3  pom-builder", "4  digest-retry"],
     "drive the live app, write page objects"),
    ("PHASE 3", "Run it", PURPLE, PURPLE,
     ["5  test-plan", "6  playwright-test"],
     "an agent picks a scope, then run by tag"),
    ("PHASE 4", "Repair, ship, report", ORANGE, ORANGE,
     ["7  heal-apply", "8  git", "9  notify"],
     "fold in verified repairs, open a PR, tell the chat"),
]
cw, gap = 2.72, 0.35
y0, ch = 1.95, 2.45
for i, (tag, name, bar, col, stages, sub) in enumerate(cards):
    x = M + i * (cw + gap)
    rect(s, x, y0, cw, ch, fill=WHITE, line=LINE, radius=0.07)
    rect(s, x, y0, cw, 0.075, fill=bar, radius=0.4, shape=MSO_SHAPE.RECTANGLE)
    tf = box(s, x + 0.22, y0 + 0.28, cw - 0.44, ch - 0.46)
    para(tf, tag, size=10, color=col, first=True, after=3)
    para(tf, name, size=15.5, color=DARK, after=10)
    for st in stages:
        para(tf, st, size=12, color=INK, after=3)
    para(tf, sub, size=10.5, color=MUTED, before=8, after=0, line=1.1)
    if i < 3:
        rect(s, x + cw + 0.045, y0 + ch / 2 - 0.13, 0.26, 0.26, fill=ACCENT,
             shape=MSO_SHAPE.RIGHT_ARROW)

callout(s, 4.62, [("Fatal vs recorded. ", True, INK),
                  ("1\u20132 decide what to cover, so they stop the run. "
                   "3\u20139 record the failure and carry on.", False, MUTED)], h=0.68)
callout(s, 5.44, [("A run that dies still reports. ", True, INK),
                  ("The abort sends its own message: what did not happen, and the tail "
                   "of the stage output.", False, MUTED)], h=0.68,
        bg=WHITE, edge=FAINT)
callout(s, 6.26, [("One stage at a time. ", True, ACCENT_D),
                  ("npm run stage:2", False, INK),
                  (" re-runs a stage against the manifest the last run left on disk.",
                   False, MUTED)], h=0.68)
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
    "line?' the answer is: outside the managed region, a human. The four "
    "verdicts are the words the run summary uses, so the slide and the report "
    "agree."))
title(s, "Scenarios in plain English, tests out",
      kicker="STAGE 1\u20132  \u00b7  WHAT TO COVER")
code(s, M, 1.72, 5.6, 3.35, [
    ("# scenarios/gallery.txt", True),
    ("", False),
    ("TEST: A category filter narrows", False),
    ("      the gallery to its proofs", False),
    ("Tags: @smoke @core", False),
    ("Expected: Clicking the macro pill", False),
    ("          lists exactly 2 proofs", False),
    ("Notes: Filtering is a navigation.", False),
    ("---", True),
    ("TEST: <next scenario>\u2026", True),
], size=12.5)

x2 = M + 6.05
tf = box(s, x2, 1.78, CW - 6.05, 3.3)
point(tf, "Plain English.", "Anyone can write and review one.", size=19, first=True,
      after=18)
point(tf, "Tags come from the file.", "Never from the model.", size=19, after=18)
point(tf, "Generated code sits in a managed region.",
      "Outside it, a human wrote the line.", size=19, after=4)

tf = box(s, x2, 4.62, CW - 6.05, 0.9)
para(tf, "Four verdicts, per scenario", size=13.5, color=MUTED, first=True, after=8)
para(tf, [("generated", True, ACCENT_D), ("  \u00b7  ", False, FAINT),
          ("kept", True, INK), ("  \u00b7  ", False, FAINT),
          ("covered", True, INK), ("  \u00b7  ", False, FAINT),
          ("blocked", True, AMBER)], size=16, after=0)

callout(s, 5.72, [("Change the scenario, not the spec. ", True, INK),
                  ("Hash moved \u2192 re-digest. Hash equal \u2192 held verbatim.", False, MUTED)],
        h=0.80, size=17)
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
    "capability into a visible build order. Two later fixes belong here: a "
    "blocked scenario must NAME what to add (an empty list was a dead end), and "
    "private members are not capabilities - advertising one made the model call "
    "something a spec legally cannot call."))
title(s, "Assertions live in the page object",
      kicker="STAGE 3\u20134  \u00b7  BUILD THE VOCABULARY")
code(s, M, 1.72, 6.7, 2.60, [
    ("test('A category filter narrows the gallery',", False),
    ("     { tag: ['@core', '@smoke'] },", False),
    ("     async ({ page }) => {", False),
    ("  const gallery = new GalleryPage(page);", False),
    ("  await gallery.goto();", False),
    ("  await gallery.filterByCategory('macro');", False),
    ("  await gallery.expectCardCount(2);", False),
    ("});", False),
], size=13.5)
tf = box(s, M, 4.62, 6.7, 2.1)
point(tf, "A spec navigates and calls intent methods.",
      "No expect, no page.locator, no setViewportSize.", size=18, first=True, after=18)
point(tf, "Every assertion carries a message.",
      "A failure reads as intent, not as two locator strings.", size=18, after=4)

x2 = M + 7.1
tf = box(s, x2, 1.78, CW - 7.1, 4.9)
para(tf, "Why it is load-bearing", size=14.5, color=MUTED, first=True, after=14)
point(tf, "The page object is the capability index.",
      "Cannot express it \u2192 blocked, and no test is written.", size=17, accent=BLUE,
      after=20)
point(tf, "Blocked names what to add.",
      "A stage-4 work order, not a dead end.", size=17, accent=BLUE, after=20)
point(tf, "Only public members count.",
      "A private helper is not a capability.", size=17, accent=BLUE, after=20)
point(tf, "Stage 3 drives the live app",
      "and appends what it learned to instruction.md.", size=17, accent=BLUE, after=4)
footer(s, 5)

# ══════════════════════════════════════════════════════════════════════════
# 6 — what gets run
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "The dangerous failure mode here is not red, it is a smaller green run. "
    "Four defences: tags written by the machinery from the scenario file, a "
    "planner agent that only proposes a scope while the code turns it into the "
    "filter, selection by tag rather than by title, and the planner failing open "
    "with an enforced floor. And one deliberate exception: a human can override "
    "the whole thing with TEST_GREP, which skips the agent and steps around the "
    "floor - because the human is the merge gate - but the report then says the "
    "run was overridden and names anything it left out. If you take one habit "
    "away: when a run is green, ask what it did not run."))
title(s, "What actually gets run today",
      kicker="STAGE 5\u20136  \u00b7  RUN IT")
tf = box(s, M, 1.70, CW, 3.7)
point(tf, "Tags come from the scenario.",
      "A model that forgot one would hand you a smaller green run.", size=19, first=True,
      after=14)
point(tf, "The agent proposes; the code decides.",
      "smoke \u00b7 sanity \u00b7 regression \u2014 a name, never a grep.", size=19, after=14)
point(tf, "Tag filter, not title filter.",
      "A rewritten title cannot drop a test.", size=19, after=14)
point(tf, "Everything generated this run always runs.",
      "Stage 2 stamps @YYYYMMDD, the planner puts it in the grep.", size=19, after=14)
point(tf, "A human's TEST_GREP wins outright.",
      "Agent skipped, floor waived \u2014 and the report says so.", size=19, after=4)
callout(s, 5.52, [("The failure to watch for is not a red run. ", True, AMBER),
                  ("It is a smaller green run: all that ran passed, and the test "
                   "that would have failed never ran.", False, MUTED)],
        h=0.84, bg=AMBER_BG, edge=AMBER, size=17)
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
    ("How it heals", ACCENT_D, [
        ("this.loc(css)", "narrow the selector that broke."),
        ("this.byCopy(text)", "the nearest on-page copy, uniquely."),
        ("No model in the path.", "A wrong guess passes on the wrong element."),
    ]),
    ("When it refuses \u2014 also the job", AMBER, [
        ("The feature is gone.", "A real failure, for a human."),
        ("A timing failure.", "A test bug, not a locator bug."),
        ("The wrong locale.", "/id \u201cPortofolio\u201d is 0.90 like /en \u201cPortfolio\u201d."),
        ("Named reasons.", "no-candidate \u00b7 ambiguous \u00b7 not-unique \u00b7 locale-mismatch."),
    ]),
]):
    x = M + i * (half + 0.55)
    rect(s, x, 1.68, half, 3.40, fill=WHITE if i else SOFT, line=LINE, radius=0.07)
    tf = box(s, x + 0.28, 1.88, half - 0.56, 3.1)
    para(tf, h, size=15.5, color=col, first=True, after=16)
    for lead, rest in items:
        point(tf, lead, rest, size=16, accent=col, after=15)

code(s, M, 5.30, CW, 0.66, [
    ("[self-heal] 1 locator repaired:  'Macroz and Product Photographer' \u2192 "
     "'Macro and Product Photographer'   (the test passed on it)", False),
], size=12)
callout(s, 6.12, [("A heal is only as good as the test that used it. ", True, INK),
                  ("Only a repair whose test passed is written into the source; a "
                   "failed one is declined and named.", False, MUTED)],
        h=0.76, size=16)
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
    ["Test passed, no visual error",
     "A 300px widget in a 276px column spilled 24px; the document never widened.",
     "Measuring elements, not the document"],
    ["\u201cAlready covered\u201d, no change made",
     "A stale block vouched for itself with its own title.",
     "The block hash decides first"],
    ["Locator healed, test passed",
     "The repair pointed at the neighbour, and the assertion then failed.",
     "Only a test-passed repair is written"],
    ["--grep @core passed",
     "An untagged test was never selected at all.",
     "Tags re-applied from the scenario"],
    ["\u201cWaited for the widget, passed\u201d",
     "Turnstile never renders in an automated browser; nothing was measured.",
     "Assert the contract, not the widget"],
    ["The capability looked fine",
     "A private helper was offered as a capability the model could call.",
     "Only public members are advertised"],
]
plain_table(s, M, 1.62, CW, 4.5, rows, [3.30, 5.85, 2.94],
            header_size=12, body_size=11.5, row_h=0.62)
callout(s, 6.34, [("Every gate here is a matcher over the output. ", True, INK),
                  ("A prompt forbidding something is a suggestion; a matcher is enforcement.",
                   False, MUTED)], h=0.62, size=15)
footer(s, 8)

# ══════════════════════════════════════════════════════════════════════════
# 9 — who decides
# ══════════════════════════════════════════════════════════════════════════
s = slide(notes=(
    "The one-slide summary of the division of labour. If the room remembers one "
    "thing from the workshop, make it this table: the left column is where AI "
    "adds value, the right column is why you can trust the left. Nothing in the "
    "right column is a sentence we asked the model to follow - each is code that "
    "runs whether the model cooperates or not. The two-statuses callout is the "
    "same idea in the report: a failed test and a broken pipeline are different "
    "problems, and one verdict for both sends someone to fix the wrong one."))
title(s, "AI proposes. Code enforces.", kicker="THE DIVISION OF LABOUR")
half = (CW - 0.55) / 2
for i, (h, col, bg, items) in enumerate([
    ("AI's job", BLUE, SOFT, [
        "Draft scenarios from the issue and the diff (1)",
        "Write the test block from the scenario (2)",
        "Judge coverage and buildability (3\u20134)",
        "Pick a scope \u2014 a CI-only change is a deployment check (5)",
        "Read the app in a browser, record what it learned",
    ]),
    ("Code's job \u2014 never the prompt", ACCENT_D, WHITE, [
        "The block hash decides hold / re-digest / classify",
        "Tags re-applied from the scenario, every run",
        "Claimed capabilities matched against the real surface",
        "Generated code stays inside the managed region",
        "Degraded input fails open, named; malformed throws",
        "A run that dies still sends its report",
    ]),
]):
    x = M + i * (half + 0.55)
    rect(s, x, 1.58, half, 3.48, fill=bg, line=LINE, radius=0.07)
    rect(s, x, 1.58, half, 0.075, fill=col, radius=0.4, shape=MSO_SHAPE.RECTANGLE)
    tf = box(s, x + 0.30, 1.84, half - 0.60, 3.10)
    para(tf, h, size=15, color=col, first=True, after=12)
    for it in items:
        p = tf.add_paragraph()
        p.space_after = Pt(10)
        hang(p, 0, 0.32)
        g = p.add_run()
        g.text = "\u25aa   "
        g.font.size = Pt(14.5)
        g.font.bold = True
        g.font.name = FONT
        g.font.color.rgb = col
        r = p.add_run()
        r.text = it
        r.font.size = Pt(14.5)
        r.font.name = FONT
        r.font.color.rgb = INK

callout(s, 5.22, [("Two statuses, never one. ", True, INK),
                  ("Testing Status is the product \u00b7 Pipeline Status is the process. "
                   "A failed test leaves every stage succeeded.", False, MUTED)],
        h=0.74, size=16)
callout(s, 6.08, [("89 invariants run in seconds, no browser. ", True, ACCENT_D),
                  ("npm run self-checks", False, INK),
                  (" \u2014 added whenever the failure would have been silent.",
                   False, MUTED)], h=0.74, bg=SOFT, edge=ACCENT, size=16)
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
rect(s, M, 1.60, half, 3.32, fill=WHITE, line=LINE, radius=0.07)
tf = box(s, M + 0.30, 1.82, half - 0.60, 2.95)
para(tf, "As of today, in this repo", size=14, color=MUTED, first=True, after=12)
point(tf, "2 domains", "\u00b7 24 scenarios \u00b7 24 tests", size=14, after=8)
point(tf, "89 self-check invariants", "in seconds, no browser", size=14, after=8)
point(tf, "Last run: 24 scenarios, 24 kept", "\u2014 nothing needed regenerating",
      size=14, after=8)
point(tf, "Suite: 23 passed, 1 failed",
      "\u2014 a real defect: a 276px slot under a 300px widget", size=14, after=8)
point(tf, "DEBUG=true", "narrates a run, AI calls as request/response", size=14,
      after=4)

x2 = M + half + 0.55
rect(s, x2, 1.60, half, 3.32, fill=CODEBG, radius=0.07)
tf = box(s, x2 + 0.30, 1.86, half - 0.60, 2.8)
para(tf, "Try it \u2014 the whole loop", size=14, color=WHITE, first=True, after=12)
for line in [
    "npm ci",
    "cp .env.example .env     # BASE_URL, MODEL_API_KEY",
    "npm run self-checks      # cheap gates, no browser",
    "npm test                 # the whole suite",
    "npm run pipeline -- --pr 123",
    "npm run stage:2          # re-run ONE stage",
]:
    para(tf, line, size=12, color=CODEFG, after=5)

callout(s, 5.12, [("Hands-on, next 60 minutes: ", True, ACCENT_D),
                  ("read a scenario \u2192 run stage 2 and watch the test appear \u2192 "
                   "break a locator and watch it heal \u2192 watch it refuse a bad one.",
                   False, MUTED)], h=0.78)
callout(s, 6.02, [("The three files worth reading first: ", True, INK),
                  ("README.md", False, ACCENT_D),
                  (" (how to run it), ", False, MUTED),
                  ("WORKFLOW.md", False, ACCENT_D),
                  (" (the diagrams), ", False, MUTED),
                  ("pipeline-pattern.md", False, ACCENT_D),
                  (" (why each gate is where it is).", False, MUTED)],
        h=0.72, bg=WHITE, edge=FAINT)
footer(s, 10)

prs.save(OUT)
print("wrote", OUT, "-", len(prs.slides._sldIdLst), "slides")
