/**
 * Run report. Persisted verbatim (pipeline-pattern.md §2: stage records are
 * written into the run report). The report is the audit trail: it shows the
 * scope stage 1 chose, what stage 2 generated, which POMs stage 3 touched,
 * which tier stage 5 picked, how the playwright run went, what heal-apply did,
 * and what stage 8 shipped.
 *
 * Every entry is redacted (see redaction.ts) before write.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rehydrate } from '../util/paths.js';
import { redactObject } from '../util/redaction.js';
import type { RunManifest, StageRecord } from '../scenario/manifest.js';

export interface RunReport {
  runId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: 'success' | 'partial' | 'failed';
  stages: StageRecord[];
  /** Free-form sections each stage may add (redacted). */
  sections: Record<string, unknown>;
}

const REPORT_PATH = 'artifacts/run/run-report.json';

export function buildReport(manifest: RunManifest, endedAt: Date): RunReport {
  const start = new Date(manifest.startedAt).getTime();
  const durationMs = endedAt.getTime() - start;

  const hasFatalFailure = manifest.stages.some(
    (s) =>
      s.status === 'failed' &&
      (s.name === 'gap-analysis' || s.name === 'testcase-digest'),
  );
  const hasAnyFailure = manifest.stages.some((s) => s.status === 'failed');

  return {
    runId: manifest.runId,
    startedAt: manifest.startedAt,
    endedAt: endedAt.toISOString(),
    durationMs,
    outcome: hasFatalFailure ? 'failed' : hasAnyFailure ? 'partial' : 'success',
    stages: manifest.stages,
    sections: {},
  };
}

export async function saveReport(report: RunReport): Promise<void> {
  const path = rehydrate(REPORT_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(redactObject(report), null, 2), 'utf8');
}
