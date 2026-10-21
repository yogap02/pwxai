/**
 * Exploration journal: a running record of what the crawler and page
 * analyser observed. Appended-only. Negative results are recorded as
 * first-class entries — absence is indistinguishable from not-yet-built, so
 * a cut entry gets the work redone and the absence filed as a defect
 * (pipeline-pattern.md §7).
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rehydrate } from '../core/util/paths.js';

export type JournalEntry =
  | { kind: 'visit'; url: string; title: string; at: string }
  | { kind: 'negative'; url: string; what: string; at: string }
  | { kind: 'probe'; url: string; selector: string; resolved: number; at: string }
  | { kind: 'rejected-option'; url: string; option: string; why: string; at: string };

const JOURNAL_PATH = 'artifacts/exploration/journal.md';

export async function appendEntry(entry: JournalEntry): Promise<void> {
  const abs = rehydrate(JOURNAL_PATH);
  await mkdir(dirname(abs), { recursive: true });
  const line = formatEntry(entry);
  await appendFile(abs, line + '\n', 'utf8');
}

function formatEntry(entry: JournalEntry): string {
  const ts = entry.at;
  switch (entry.kind) {
    case 'visit':
      return `- [${ts}] visit ${entry.url} — "${entry.title}"`;
    case 'negative':
      return `- [${ts}] negative ${entry.url} — ${entry.what} (ABSENCE RECORDED — do not re-probe)`;
    case 'probe':
      return `- [${ts}] probe ${entry.url} \`${entry.selector}\` → ${entry.resolved} match(es)`;
    case 'rejected-option':
      return `- [${ts}] rejected ${entry.url} — option \`${entry.option}\` because ${entry.why}`;
  }
}
