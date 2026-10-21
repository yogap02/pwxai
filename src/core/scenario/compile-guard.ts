/**
 * Attributing a compiler error to the generated block that caused it.
 *
 * The capability index checks that a member the model NAMED exists. It cannot check that the
 * member is CALLED correctly — sufficiency is not checkable from a name list, as that module says
 * of itself. The compiler can, and this matters more than it looks: every block of a domain lives
 * in one spec file, so a single block calling `goto(path)` on a zero-argument method is four
 * `tsc` errors, and TypeScript reports them against the FILE. One bad block used to cost every
 * other block in that file its delivery — which, on a real PR, is how seventeen correct blocks
 * were refused along with four wrong ones.
 *
 * The decision is pure: a file's text plus `tsc`'s output. Self-checks therefore drive it with
 * synthetic input instead of a compiler, which is what makes the mapping itself checkable
 * (an off-by-one in the span is the obvious way to get this wrong, and it is silent: the wrong
 * block would be refused, or the right one kept).
 */

/** A managed block's line span in a spec file. 1-based, inclusive. */
export interface BlockSpan {
  scenarioId: string;
  from: number;
  to: number;
}

/** The span each managed block occupies, in file order. `[]` when the file has no region. */
export function blockSpans(fileContent: string): BlockSpan[] {
  const startRe = /\/\/ @digest:block:([0-9a-f]{16}):[0-9a-f]{16}[^\n]*/g;
  const endRe = /\/\/ @digest:end-block/g;
  const spans: BlockSpan[] = [];
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(fileContent)) !== null) {
    const from = lineAt(fileContent, m.index);
    // The first end-marker AFTER this start — the same rule `readManagedRegion` uses to cut a
    // block out, so the span and the block the writer holds are the same thing.
    endRe.lastIndex = m.index + m[0].length;
    const end = endRe.exec(fileContent);
    spans.push({ scenarioId: m[1]!, from, to: end === null ? from : lineAt(fileContent, end.index) });
  }
  return spans;
}

/** 1-based line number of a character offset. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export interface TscError {
  /** Repo-relative POSIX path, as `tsc` printed it (Windows backslashes normalised). */
  file: string;
  line: number;
  /** `TS2554: Expected 0 arguments, but got 1.` */
  message: string;
}

/**
 * Every `error TSxxxx` in `tsc --noEmit` output, with the line it points at. The one-line
 * continuation `tsc` prints under some errors is ignored: the first line already says what is
 * wrong, and the continuation is usually about the same expression.
 */
export function parseTscErrors(output: string): TscError[] {
  const out: TscError[] = [];
  for (const raw of output.split('\n')) {
    const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(raw.trimEnd());
    if (!m) continue;
    out.push({
      file: m[1]!.replace(/\\/g, '/'),
      line: Number(m[2]),
      message: `${m[3]}: ${m[4]}`,
    });
  }
  return out;
}

export interface CompileVerdict {
  /** Scenario id → why the compiler rejected that block. */
  byBlock: Map<string, string[]>;
  /** Errors in this file that no managed block owns — the handwritten part, or the scaffold. */
  unattributed: string[];
}

/**
 * Which generated blocks the compiler blames, and for what. Only errors in `fileRepoRelative`
 * are considered: an error in another file is not this domain's to refuse.
 */
export function blockCompileErrors(
  fileContent: string,
  fileRepoRelative: string,
  tscOutput: string,
): CompileVerdict {
  const spans = blockSpans(fileContent);
  const byBlock = new Map<string, string[]>();
  const unattributed: string[] = [];
  const wanted = fileRepoRelative.replace(/\\/g, '/');

  for (const error of parseTscErrors(tscOutput)) {
    if (error.file !== wanted) continue;
    const span = spans.find((s) => error.line >= s.from && error.line <= s.to);
    if (!span) {
      unattributed.push(`${error.line}: ${error.message}`);
      continue;
    }
    const list = byBlock.get(span.scenarioId) ?? [];
    list.push(error.message);
    byBlock.set(span.scenarioId, list);
  }

  return { byBlock, unattributed };
}
