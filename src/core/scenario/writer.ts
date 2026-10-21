/**
 * Scenario file writer. Append-only from the pipeline's perspective — the
 * human-edit half is opening the file in an editor.
 */

import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rehydrate, toRepoRelative } from '../util/paths.js';
import { parseBlock, parseScenarioFile } from './parser.js';

export interface WriteOutcome {
  files: string[];
  totalAppended: number;
}

/** Render one scenario block in canonical form. */
export function renderBlock(input: {
  title: string; tags: readonly string[]; expected: string; notes: string;
}): string {
  return [
    `TEST: ${input.title}`,
    `Tags: ${input.tags.join(' ')}`,
    `Expected: ${input.expected}`,
    `Notes: ${input.notes}`,
  ].join('\n');
}

/**
 * Append new scenarios to their domain files. De-duplicates against existing
 * titles via the parser's id (hash of normalised title).
 */
export async function appendScenarios(
  byDomain: ReadonlyMap<string, { title: string; tags: string[]; expected: string; notes: string }[]>,
): Promise<WriteOutcome> {
  const files: string[] = [];
  let totalAppended = 0;

  for (const [domain, scenarios] of byDomain) {
    const rel = `scenarios/${domain}.txt`;
    const abs = rehydrate(rel);
    let existing = '';
    try {
      existing = await readFile(abs, 'utf8');
    } catch {
      /* new file */
    }
    const existingIds = new Set(parseScenarioFile(existing).map((b) => b.id));

    const toAdd = scenarios.filter((s) => {
      // Hash the title through the parser's own normalisation so a re-run of
      // stage 1 against unchanged scenarios does not duplicate blocks.
      const probe = parseBlock(`TEST: ${s.title}\nTags: ${s.tags.join(' ')}\nExpected: ${s.expected}`);
      return probe !== null && !existingIds.has(probe.id);
    });

    if (toAdd.length === 0) continue;

    await mkdir(dirname(abs), { recursive: true });
    const body = toAdd.map(renderBlock).join('\n\n---\n\n');
    const prefix = existing.trimEnd().length === 0 ? '' : '\n\n---\n\n';
    await appendFile(abs, `${prefix}${body}\n`, 'utf8');
    files.push(toRepoRelative(abs));
    totalAppended += toAdd.length;
  }

  return { files, totalAppended };
}
