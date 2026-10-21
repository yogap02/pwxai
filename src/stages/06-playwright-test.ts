/**
 * Stage 6: playwright-test. Runs the chosen grep. Results are recorded
 * verbatim — never reverted, never re-marked, never filtered on failure
 * (pipeline-pattern.md §3, "Test results are recorded as-is"). The pass/fail
 * breakdown goes into the PR body as review guidance.
 */

import type { StageSpec } from '../core/orchestration/stage-runner.js';
import { runStageProcess } from '../core/orchestration/stage-runner.js';
import { REPO_ROOT, rehydrate } from '../core/util/paths.js';
import { dbg } from '../core/util/debug.js';
import { readFile, rm } from 'node:fs/promises';
import process from 'node:process';

const JSON_REPORT = 'artifacts/run-report/test-results.json';
const HEAL_RECORDS = 'artifacts/run/heals.json';

export function createPlaywrightTestStage(grep: string): StageSpec {
  return {
    name: 'playwright-test',
    fatal: false,
    timeoutMs: 30 * 60_000,
    run: async (ctx) => {
      // No `--reporter` override: playwright.config.ts already configures the
      // `list` reporter (readable output) AND the `json` reporter with
      // `outputFile: artifacts/run-report/test-results.json`. Overriding the
      // reporter here silently redirected the JSON to stdout, so this stage
      // always fell back to reading a previous run's file.
      const args = ['test'];
      if (grep) {
        // Narrowed run. The reduction is chosen, named in the report, and
        // printed on the PR — never silent.
        args.push('--grep', grep);
      }
      dbg('playwright-test', 'run', {
        grep: grep || '(full suite)',
        args,
        cwd: REPO_ROOT,
        healRunId: ctx.manifest.runId,
      });

      const reportFile = rehydrate(JSON_REPORT);
      // Delete the previous run's report FIRST. Reading a stale file is how a
      // crashed playwright run reports the last run's "11 passed" — a false
      // green in the one artifact a reviewer trusts.
      await rm(reportFile, { force: true });
      // Same boundary for the heal records. A run normally replaces them (the file
      // names its run), but a run that dies before any worker reaches teardown — a
      // compile error, a grep matching nothing — would leave the previous run's
      // repairs to be read as this run's, and applied to the source as if a test
      // had just verified them.
      await rm(rehydrate(HEAL_RECORDS), { force: true });

      // Spawn the local Playwright CLI through node rather than through `npx`.
      // `npx` is a `.cmd` shim, which forces `shell: true`, and the shell
      // re-parses the grep — `|` becomes a pipe and the run dies (exit 255).
      // Node + an args array passes every argument verbatim.
      //
      // `HEAL_RUN_ID` names this run for the healing fixture. Playwright restarts
      // the worker after a failing test, so the test process that writes
      // `heals.json` is not one process: without a run name, the second worker's
      // teardown erased the first worker's repairs. This stage owns the run
      // boundary, so it says which run it is.
      const res = await runStageProcess(
        process.execPath,
        [rehydrate('node_modules/playwright/cli.js'), ...args],
        {
          timeoutMs: 30 * 60_000,
          cwd: REPO_ROOT,
          shell: false,
          env: { HEAL_RUN_ID: ctx.manifest.runId },
        },
      );

      let stats: { passed: number; failed: number; flaky: number } | null = null;
      try {
        const json = JSON.parse(await readFile(reportFile, 'utf8')) as {
          stats: { expected: number; unexpected: number; flaky: number; skipped: number };
        };
        stats = {
          passed: json.stats?.expected ?? 0,
          failed: json.stats?.unexpected ?? 0,
          flaky: json.stats?.flaky ?? 0,
        };
      } catch {
        /* no fresh report — totals unknown, and 0 would be a lie */
      }

      if (stats) {
        for (const d of ctx.manifest.domains) {
          d.playwright = { ...stats, durationMs: 0 };
        }
      } else {
        ctx.recordDegradation('playwright-test', 'no JSON report written — pass/fail unknown');
      }

      if (!res.ok) {
        ctx.recordDegradation('playwright-test', `playwright exited ${res.exitCode}`);
      }
      dbg('playwright-test', 'done', {
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        stats: stats ?? 'unknown',
      });
      return [
        `Exit code: ${res.exitCode}`,
        stats
          ? `Passed: ${stats.passed}, Failed: ${stats.failed}, Flaky: ${stats.flaky}`
          : 'Passed: unknown (no JSON report was written)',
        grep ? `Grep: ${grep}` : `Grep: (full suite)`,
        ``,
        res.output.slice(-2_000), // tail — full output is in the report
      ].join('\n');
    },
  };
}
