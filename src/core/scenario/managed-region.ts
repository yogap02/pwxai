/**
 * Managed-region reader/writer.
 *
 * Generated code goes between `// @digest:managed:start` and
 * `// @digest:managed:end` (pipeline-pattern.md §3, "Managed regions").
 * Everything outside is handwritten and never touched. This is what makes
 * agent-written code reviewable: a reviewer knows exactly which lines had no
 * author, and the same file can hold both handwritten and generated tests.
 *
 * The write path is synchronous and has NO `await` inside it (concurrency
 * invariant #2). Block order is pinned to scenario order, never arrival order.
 */

export const MANAGED_START = '// @digest:managed:start';
export const MANAGED_END = '// @digest:managed:end';

/**
 * A generated block inside a managed region. The marker comment carries the
 * scenario id and content hash so regeneration is keyed on inputs changing,
 * not on a verdict.
 */
export interface ManagedBlock {
  /** Scenario id (hash of normalised title). */
  scenarioId: string;
  /** Content hash from the scenario parser; if this hasn't moved, the block is held. */
  scenarioContentHash: string;
  /** The generated TypeScript lines for this block (a single test() call). */
  code: string;
}

function blockStartMarker(scenarioId: string, contentHash: string): string {
  return `// @digest:block:${scenarioId}:${contentHash}`;
}
const BLOCK_END = '// @digest:end-block';

/** Serialise a managed region from ordered blocks. */
export function renderManagedRegion(blocks: readonly ManagedBlock[]): string {
  const lines: string[] = [MANAGED_START, ''];
  for (const block of blocks) {
    lines.push(blockStartMarker(block.scenarioId, block.scenarioContentHash));
    // `trim`, not `trimEnd`: the reader trims blank lines from both ends of a
    // block, so a leading blank line the generator emitted would survive the
    // first write and vanish on read-back — one extra diff on the first hold
    // after generation, which is exactly the silent churn the fixpoint exists to
    // prevent. A block's own first-line indentation is the region's base indent,
    // applied below and stripped on read, so dropping it here loses nothing.
    lines.push(block.code.trim());
    lines.push(BLOCK_END);
    lines.push('');
  }
  lines.push(MANAGED_END);
  return lines.join('\n');
}

/** Replace the managed region of a file, or append one if none exists. */
export function upsertManagedRegion(
  fileContent: string,
  region: string,
): string {
  const startIdx = fileContent.indexOf(MANAGED_START);
  const endIdx = fileContent.indexOf(MANAGED_END);

  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    // No valid region — append one after the existing (handwritten) content.
    const base = fileContent.trimEnd();
    return `${base}\n\n${region}\n`;
  }

  const before = fileContent.slice(0, startIdx).trimEnd();
  const after = fileContent.slice(endIdx + MANAGED_END.length).trim();
  // Nothing follows the region → one newline. Anything follows (the scaffold's
  // closing `});`) → a blank line, then it. Both branches end the file with exactly
  // one newline, and both must be what the NEXT run re-emits: this function's own
  // output is its input a moment later (a held block is rewritten every run), so a
  // shape it would not reproduce churns the diff once, silently.
  return after.length === 0
    ? `${before}\n\n${region}\n`
    : `${before}\n\n${region}\n\n${after}\n`;
}

/**
 * The first version of a spec file for a domain: a closed `test.describe()` holding
 * an empty (well, fresh) managed region.
 *
 * Composed HERE, beside the writer, because the two must agree byte-for-byte. The
 * file this produces is read back and rewritten by `upsertManagedRegion` on the very
 * next run; when the scaffold ended `region\n});` and the writer re-emitted
 * `region\n\n});`, the first hold after generation churned one blank line — a silent
 * diff that no report mentions. The self-check asserts this output is a fixpoint of
 * the writer, so the two can never drift apart again.
 */
export function scaffoldManagedSpec(options: {
  /** Domain key, as it appears in the domain map and the scenario filename. */
  domain: string;
  /** Top-level imports, each a complete `import …;` line. */
  imports: readonly string[];
  /** The managed region, already indented for the describe body. */
  region: string;
}): string {
  const header = [
    ...options.imports,
    '',
    `test.describe(${JSON.stringify(options.domain)}, () => {`,
    '  // Handwritten tests live above the managed region.',
  ].join('\n');
  return `${header}\n\n${options.region}\n\n});\n`;
}

/**
 * Read the blocks currently inside a managed region. Returns [] when the file
 * has no region. Blocks in unknown order are returned in file order; callers
 * re-pin against scenario order before rewriting.
 */
export function readManagedRegion(fileContent: string): ManagedBlock[] {
  const startIdx = fileContent.indexOf(MANAGED_START);
  const endIdx = fileContent.indexOf(MANAGED_END);
  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return [];

  const region = fileContent.slice(startIdx + MANAGED_START.length, endIdx);
  const blocks: ManagedBlock[] = [];
  // Tolerate leading indentation: stage 2 writes the region inside a
  // test.describe, so markers are indented on disk. Anchoring at column 0 here
  // would fail to read back every block the pipeline itself wrote, silently
  // regenerating (or deleting) them on the next run.
  //
  // The marker's own indentation is the region's base, and it is stripped from
  // every code line. Without that, the code is read back pre-indented, render
  // emits it verbatim, and the writer indents the region again — each run adds
  // another two spaces, so a block that is "held as-is" still churns the diff.
  const blockStartRe = /^([ \t]*)\/\/ @digest:block:([0-9a-f]{16}):([0-9a-f]{16})\s*$/gm;

  let match: RegExpExecArray | null;
  const starts: Array<{ id: string; hash: string; indent: string; codeFrom: number }> = [];
  while ((match = blockStartRe.exec(region)) !== null) {
    starts.push({
      id: match[2]!,
      hash: match[3]!,
      indent: match[1]!,
      codeFrom: match.index + match[0].length,
    });
  }

  for (const s of starts) {
    const endIdxBlock = region.indexOf(BLOCK_END, s.codeFrom);
    const codeSlice =
      endIdxBlock === -1
        ? region.slice(s.codeFrom)
        : region.slice(s.codeFrom, endIdxBlock);
    blocks.push({
      scenarioId: s.id,
      scenarioContentHash: s.hash,
      code: stripRegionIndent(codeSlice, s.indent),
    });
  }
  return blocks;
}

/** Remove the region's base indentation, and blank lines, from a block's code. */
function stripRegionIndent(text: string, indent: string): string {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines
    .map((line) => {
      if (line.trim() === '') return '';
      if (indent !== '' && line.startsWith(indent)) return line.slice(indent.length);
      return line.replace(/^[ \t]+/, '');
    })
    .join('\n');
}

/**
 * Merge rewrite strategy. Existing blocks whose scenario id AND content hash
 * are unchanged are held as-is (pipeline-pattern.md §3: "regeneration is keyed
 * on inputs changing, not on a verdict"). New or changed scenarios get the
 * provided code; missing or stale entries are dropped from the region.
 *
 * `orderedScenarioIds` pins the write order — caller passes scenario order,
 * NOT arrival order from the async pool.
 */
/**
 * A managed block is written INSIDE a `test.describe(...)` callback, and an
 * import declaration is only legal at the top level of a module. An `import`
 * inside the region is therefore a syntax error that takes the WHOLE spec file
 * down — every handwritten test in it, not just the generated block. It gets
 * there because the generator is handed the spec's conventions and re-emits the
 * spec's own imports as part of "the block". The generator is told not to; this
 * is what makes that true rather than hoped for, and it repairs a block already
 * written broken without hand-editing the spec.
 *
 * Removal is line-based: a declaration starts at a line whose first token is
 * `import` and, when that line has not yet reached its module specifier, runs on
 * to the line that has one (so a multi-line `import {` … `} from '…';` goes too)
 * — never past a statement that is clearly real code. A dynamic
 * `await import('…')` does not begin a line with `import`, so it is untouched.
 * Clean code is returned byte-identical, because the held-block path is a
 * fixpoint and re-indenting an unchanged block would churn the diff every run.
 */
export interface BlockImportStrip {
  code: string;
  /** Import declarations removed. Zero means `code` is unchanged. */
  removed: number;
}

const IMPORT_START = /^[ \t]*import\b/;
/** A line that is clearly code, not a continuation of an import declaration. */
const STATEMENT_START = /^[ \t]*(?:test\(|test\.|export\b|const\b|let\b|var\b|function\b|class\b|return\b|await\b|if\b|for\b|while\b)/;
/** A module specifier, or the member list of a wrapped import, has arrived. */
const SPECIFIER = /['"]/;

export function stripBlockImports(code: string): BlockImportStrip {
  const lines = code.split('\n');
  const kept: string[] = [];
  let removed = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!IMPORT_START.test(line)) {
      kept.push(line);
      i++;
      continue;
    }
    removed++;
    const complete = SPECIFIER.test(line);
    i++;
    if (!complete) {
      while (i < lines.length && !SPECIFIER.test(lines[i]!) && !STATEMENT_START.test(lines[i]!)) {
        i++;
      }
      // Take the line that carries the module specifier — unless it is real code,
      // which is what an unterminated declaration runs into.
      if (i < lines.length && SPECIFIER.test(lines[i]!) && !STATEMENT_START.test(lines[i]!)) i++;
    }
  }

  if (removed === 0) return { code, removed };
  return { code: trimBlankLines(kept), removed };
}

/** Drop leading/trailing blank lines left behind by a removed declaration. */
function trimBlankLines(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

/**
 * What a managed block may NOT contain — the write path's second guard, beside
 * `stripBlockImports`.
 *
 * A generated block that calls the Playwright `page` API directly, or calls `expect()`
 * itself, has escaped the page object: it is outside the capability index, it cannot heal,
 * and a reviewer cannot read it as a capability. It gets there because the scenario needs
 * something the page object cannot express *yet* — an HTTP-level assertion, say — and the
 * model reaches past the POM instead of reporting the gap. The outcome AGENTS.md names is
 * the right one: the scenario is `blocked` and becomes a builder work order.
 *
 * Withholding the block is the whole point, and stripping is NOT an option here. Unlike an
 * import inside the region (a syntax error, so removing it only repairs), deleting the
 * `page`/`expect` lines leaves a test that still PASSES and asserts nothing — exactly the
 * silent green this repo exists to prevent. So this reports, and stage 2 refuses the block.
 *
 * `page.` is matched on the raw text, which is what the spec self-check scans. `expect(` is
 * matched with comments stripped, so a block that merely MENTIONS `expect(x)` in a note is
 * not condemned for it — and `expectLoaded(` does not match, because `expect` must be
 * followed by `(`.
 */
export function blockViolations(code: string): string[] {
  const out: string[] = [];
  if (/\bpage\s*\./.test(code)) {
    out.push('calls the Playwright `page` API directly');
  }
  const bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  if (/\bexpect\s*\(/.test(bare)) {
    out.push('calls `expect()` itself rather than a page-object assertion');
  }
  return out;
}

export function mergeManagedRegion(
  existing: readonly ManagedBlock[],
  incoming: ReadonlyMap<string, { code: string; scenarioContentHash: string }>,
  orderedScenarioIds: readonly string[],
): ManagedBlock[] {
  const existingById = new Map(existing.map((b) => [b.scenarioId, b]));
  const out: ManagedBlock[] = [];

  for (const id of orderedScenarioIds) {
    const prior = existingById.get(id);
    const fresh = incoming.get(id);
    if (!fresh) continue; // scenario left unbuildable this run — handled as unbuildable block by stage 2

    if (prior && prior.scenarioContentHash === fresh.scenarioContentHash) {
      out.push(prior); // unchanged input → held as-is
    } else {
      out.push({
        scenarioId: id,
        scenarioContentHash: fresh.scenarioContentHash,
        code: fresh.code,
      });
    }
  }
  return out;
}
