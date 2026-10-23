/**
 * Exports the mermaid diagrams in WORKFLOW.md to individual .mmd files that
 * paste cleanly into Excalidraw (menu -> Mermaid to Excalidraw).
 *
 *     node deck/export-mermaid.mjs
 *
 * One source, one derivative: WORKFLOW.md stays the diagram source (it renders
 * on GitHub), and these files are generated from it so they cannot drift.
 *
 * The one real transformation: '<br/>' -> a real newline character. Excalidraw's
 * importer (@excalidraw/mermaid-to-excalidraw) has no <br> handling at all, so a
 * literal '<br>' lands in the label text and has to be cleaned by hand. A real
 * newline inside a quoted label survives as a multi-line label — verified
 * against the importer, not assumed (see deck/excalidraw-import-check.html).
 * Everything else is passed through: subgraphs import (as plain rectangles,
 * since Excalidraw groups are not elements) and classDef colours import.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'WORKFLOW.md';
const OUT = join('deck', 'diagrams', 'excalidraw');

// Named explicitly, and the count is asserted below: a new diagram in
// WORKFLOW.md must not silently land in a misnamed file.
const NAMES = [
  '01-pipeline',
  '02-stage-2-digest',
  '03-stage-7-heal',
  '04-planner',
  '05-report-channel',
];

const md = await readFile(SRC, 'utf8');
const blocks = [...md.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1]);

if (blocks.length !== NAMES.length) {
  throw new Error(
    `${SRC} has ${blocks.length} mermaid diagram(s) but this script names ${NAMES.length}. ` +
      `Add a name to NAMES for each new diagram.`,
  );
}

await mkdir(OUT, { recursive: true });
for (const [i, block] of blocks.entries()) {
  const body = block
    .replace(/<br\s*\/?>/gi, '\n')   // the importer keeps '<br>' literally
    .replace(/[ \t]+$/gm, '')        // trailing spaces look like noise in an editor
    .trim();

  const text = [
    `%% ${NAMES[i]} — exported from ${SRC}`,
    `%% paste into Excalidraw:  menu → Mermaid to Excalidraw`,
    '',
    body,
    '',
  ].join('\n');

  const path = join(OUT, `${NAMES[i]}.mmd`);
  await writeFile(path, text, 'utf8');
  console.log(`  ${path}  (${body.split('\n').length} lines)`);
}
console.log(`exported ${blocks.length} diagram(s) from ${SRC} into ${OUT}/`);
