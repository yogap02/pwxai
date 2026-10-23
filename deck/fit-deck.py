"""Does the deck's text actually fit? Measured, not estimated.

    python deck/fit-deck.py

PowerPoint grows a textbox silently, so an overflow only shows up when someone
opens the file — usually in front of an audience. This wraps every paragraph
run-by-run at its own font size and weight, inside the frame's width minus its
hanging indent, and reports any frame whose text needs more height than the
shape has.

Needs `pillow` (`pip install pillow`) and the Segoe UI font the deck is built
with; without the font it falls back to a built-in metric, which is a rougher
but still useful answer.
"""
import sys
from pathlib import Path

from PIL import ImageFont
from pptx import Presentation
from pptx.util import Emu

PATH = "deck/Playwright-AI-QA-Workshop.pptx"

# The deck is built in Segoe UI. Any of these gets the real metrics; on a machine
# with none of them the fallback below still catches gross overflow.
FONT_CANDIDATES = {
    False: [
        r"C:\Windows\Fonts\segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ],
    True: [
        r"C:\Windows\Fonts\segoeuib.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ],
}

_fonts: dict = {}


def _load(bold):
    for path in FONT_CANDIDATES[bold]:
        if Path(path).exists():
            return path
    return None


_font_files = {False: _load(False), True: _load(True)}


def font(size_pt, bold):
    key = (round(size_pt, 1), bold)
    if key in _fonts:
        return _fonts[key]
    px = max(int(round(size_pt * 96 / 72)), 1)
    path = _font_files[bold] or _font_files[False]
    _fonts[key] = (ImageFont.truetype(path, px) if path
                   else ImageFont.load_default(px))
    return _fonts[key]


def text_width(text, size_pt, bold):
    return font(size_pt, bold).getlength(text)


def emu_in(v):
    return Emu(v).inches if v is not None else 0.0


def para_height(p, avail_in):
    """(lines, height_in) for one paragraph, wrapping run by run."""
    avail_px = avail_in * 96.0
    pPr = p._p.find(
        "{http://schemas.openxmlformats.org/drawingml/2006/main}pPr")
    marL = int(pPr.get("marL", 0)) / 914400 * 96 if pPr is not None else 0.0
    indent = int(pPr.get("indent", 0)) / 914400 * 96 if pPr is not None else 0.0
    first_avail = avail_px - (marL + indent)
    body_avail = avail_px - marL

    # A run can wrap mid-sentence, so split on spaces and keep the separator.
    words = []
    for r in p.runs:
        size = r.font.size.pt if r.font.size else 12.0
        bold = bool(r.font.bold)
        for chunk in r.text.split(" "):
            words.append((chunk, size, bold))

    lines, cur, avail = 1, 0.0, first_avail
    size_max = max((w[1] for w in words), default=12.0)
    for word, size, bold in words:
        w = text_width(word, size, bold)
        space = text_width(" ", size, bold) if cur > 0 else 0.0
        if cur > 0 and cur + space + w > avail:
            lines += 1
            cur, avail = w, body_avail
        else:
            cur += space + w

    height = lines * size_max * 1.22 / 72.0
    height += (p.space_before.pt if p.space_before else 0) / 72.0
    height += (p.space_after.pt if p.space_after else 0) / 72.0
    return lines, height


def main():
    prs = Presentation(PATH)
    problems = []
    for i, s in enumerate(prs.slides, 1):
        for sh in s.shapes:
            if sh.has_table:
                t = sh.table
                for ri, row in enumerate(t.rows):
                    need = 0.0
                    for ci, cell in enumerate(row.cells):
                        w = emu_in(t.columns[ci].width) - 0.24
                        need = max(need, sum(
                            para_height(p, w)[1]
                            for p in cell.text_frame.paragraphs) + 0.10)
                    got = emu_in(row.height)
                    if need > got + 0.02:
                        problems.append(
                            f"slide {i}: table row {ri} needs {need:.2f}in, "
                            f"set {got:.2f}in")
                continue
            if not sh.has_text_frame or not sh.text_frame.text.strip():
                continue
            tf = sh.text_frame
            w = (emu_in(sh.width) - emu_in(tf.margin_left)
                 - emu_in(tf.margin_right))
            need = sum(para_height(p, w)[1] for p in tf.paragraphs)
            got = emu_in(sh.height)
            if got and need > got + 0.06:
                first = tf.paragraphs[0].text[:46]
                problems.append(
                    f"slide {i}: needs {need:.2f}in, box {got:.2f}in -> {first!r}")
            if emu_in(sh.left) + emu_in(sh.width) > emu_in(prs.slide_width) + 0.01:
                problems.append(f"slide {i}: shape runs past the right edge")
            if emu_in(sh.top) + need > emu_in(prs.slide_height) + 0.01:
                problems.append(f"slide {i}: text runs past the bottom edge -> "
                                f"{tf.paragraphs[0].text[:40]!r}")
    if problems:
        print(f"{len(problems)} fit problem(s):")
        for p in problems:
            print("  -", p)
        return 1
    print("every text frame fits, measured with real font metrics")
    return 0


if __name__ == "__main__":
    sys.exit(main())
