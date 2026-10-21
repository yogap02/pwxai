/**
 * Heal writer. Stage 7 folds recorded heals into locator files. Non-fatal:
 * a heal that did not apply is still active at runtime next run
 * (pipeline-pattern.md §2).
 *
 * Patches are applied by exact-match string replacement on the file the heal
 * is recorded against. If a record no longer matches, it is kept in the
 * report as "did not apply" and left for review.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rehydrate } from '../core/util/paths.js';
import type { HealRecord } from './heal-manifest.js';

export interface HealApplyOutcome {
  applied: Array<{ record: HealRecord; file: string }>;
  skipped: Array<{ record: HealRecord; reason: string }>;
}

export async function applyHeals(records: readonly HealRecord[]): Promise<HealApplyOutcome> {
  const applied: HealApplyOutcome['applied'] = [];
  const skipped: HealApplyOutcome['skipped'] = [];

  const byFile = new Map<string, HealRecord[]>();
  for (const r of records) {
    const list = byFile.get(r.file) ?? [];
    list.push(r);
    byFile.set(r.file, list);
  }

  for (const [file, fileRecords] of byFile) {
    const abs = rehydrate(file);
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      for (const r of fileRecords) skipped.push({ record: r, reason: 'file not found' });
      continue;
    }

    let modified = false;
    for (const r of fileRecords) {
      if (!content.includes(r.brokenLocator)) {
        skipped.push({ record: r, reason: 'broken locator not present in file' });
        continue;
      }
      // Avoid double-apply: the healed locator may already be there.
      if (content.includes(r.healedLocator)) {
        skipped.push({ record: r, reason: 'healed locator already present' });
        continue;
      }
      content = content.replaceAll(r.brokenLocator, r.healedLocator);
      modified = true;
      applied.push({ record: r, file });
    }

    if (modified) {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }
  }

  return { applied, skipped };
}
