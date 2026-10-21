/**
 * Pipeline orchestrator. The eight-stage loop, sequenced, then the report channel.
 *
 * Fail-open rules (pipeline-pattern.md §2, §3):
 *   - Stage 1 or 2 failure: comment on source PR (if available) and exit 1.
 *   - Stage 3/4 per-domain failure: recorded, run continues.
 *   - Stage 5: any degradation widens to full suite with named reason.
 *   - Stage 6: failures recorded as-is, never reverted.
 *   - Stage 7: non-fatal; commit proceeds without applied heals.
 *   - Stage 8: skipped when nothing shippable changed.
 *   - Stage 9: the report channel. Non-fatal — but a report that did not arrive fails
 *     the stage, so it is named rather than mistaken for a quiet success.
 *
 * The single indirection: stage 1 emits {domain, title}; a single extractor
 * turns those into a domain list; stages 3 and 4 iterate it. No feature name
 * is hard-coded here.
 */

import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { StageRunner } from '../core/orchestration/stage-runner.js';
import { newManifest, saveManifest } from '../core/scenario/manifest.js';
import { buildReport, saveReport } from '../core/orchestration/run-report.js';
import { renderRunSummary, saveSummary, summaryPath } from '../core/orchestration/run-summary.js';
import { healStoryForSummary } from '../runtime/heal-manifest.js';
import { ModelClient } from '../ai/model-client.js';
import { GitHubCodeHost } from '../delivery/github.js';
import { CdpBuilderStub } from '../agent/cdp-builder-stub.js';
import { env } from '../core/util/env.js';
import { dbg } from '../core/util/debug.js';
import { createGapAnalysisStage } from '../stages/01-gap-analysis.js';
import { createTestcaseDigestStage } from '../stages/02-testcase-digest.js';
import { createPomBuilderStage } from '../stages/03-pom-builder.js';
import { createDigestRetryStage } from '../stages/04-testcase-digest-retry.js';
import { createTestPlanStage } from '../stages/05-test-plan.js';
import { createPlaywrightTestStage } from '../stages/06-playwright-test.js';
import { createHealApplyStage } from '../stages/07-heal-apply.js';
import { createGitStage } from '../stages/08-git.js';
import { createNotifyStage } from '../stages/09-notify.js';

interface CliOptions {
  pr: number | undefined;
  dryRun: boolean;
  /** Skip stage 1 and start from the scenarios already on disk (stage 2 still runs). */
  bootstrapFromScenarios: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const out: CliOptions = { pr: undefined, dryRun: false, bootstrapFromScenarios: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr' && argv[i + 1]) out.pr = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--from-scenarios') out.bootstrapFromScenarios = true;
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const runId = randomUUID().slice(0, 8);
  const manifest = newManifest(runId);
  const runner = new StageRunner(manifest);

  const model = new ModelClient();
  const codeHost = new GitHubCodeHost();
  const builder = new CdpBuilderStub();

  dbg('pipeline', 'start', {
    run: runId,
    pr: opts.pr ?? null,
    dryRun: opts.dryRun,
    fromScenarios: opts.bootstrapFromScenarios,
    baseUrl: env.BASE_URL,
    model: env.MODEL_NAME,
    concurrency: env.MODEL_CONCURRENCY,
  });

  // -- Stage 1: gap-analysis (FATAL) ---
  if (!opts.bootstrapFromScenarios) {
    if (opts.pr === undefined) {
      console.error('Provide --pr <number> or use --from-scenarios.');
      process.exit(2);
    }
    const stage1 = createGapAnalysisStage(model, codeHost, opts.pr);
    const r1 = await runner.run(stage1);
    if (!r1.ok) {
      await tryComment(codeHost, opts.pr, `Pipeline gap-analysis failed.\n\n${r1.output}`);
      await finalise(manifest);
      process.exit(1);
    }
  } else {
    runner.markSkipped('gap-analysis', 'bootstrap-from-scenarios mode');
  }

  // -- Stage 2: testcase-digest (FATAL) ---
  const stage2 = createTestcaseDigestStage(model);
  const r2 = await runner.run(stage2);
  if (!r2.ok) {
    await tryComment(codeHost, opts.pr ?? null, `Pipeline testcase-digest failed.\n\n${r2.output}`);
    await finalise(manifest);
    process.exit(1);
  }
  const digestOutcomes = manifest.domains.map((d) => ({
    domain: d.domain,
    generatedTitles: [] as string[],
    unbuildable: d.unbuildable,
  }));

  // -- Stages 3 + 4: per-domain, non-fatal. The single indirection:
  // stage 1's {domain, title} (persisted on the manifest) → a domain list
  // iterated here.
  const domains = [
    ...new Set([
      ...manifest.newScenarios.map((s) => s.domain),
      ...digestOutcomes.map((o) => o.domain),
    ]),
  ];

  for (const domain of domains) {
    const digest = digestOutcomes.find((o) => o.domain === domain);
    if (!digest) continue;
    const r3 = await runner.run(createPomBuilderStage(domain, builder, digest));
    if (r3.ok) {
      const r4 = await runner.run(createDigestRetryStage(domain, model, digest));
      void r4;
    }
  }

  // -- Stage 5: test-plan. The planner agent proposes a scope; the planner
  // enforces the floor and fails open (fail-open). ---
  const r5 = await runner.run(createTestPlanStage(model));
  const grep = pickGrep(manifest);
  void r5;

  // -- Stage 6: playwright-test (recorded, non-fatal) ---
  if (opts.dryRun) {
    runner.markSkipped('playwright-test', '--dry-run');
  } else {
    const r6 = await runner.run(createPlaywrightTestStage(grep));
    void r6;
  }

  // -- Stage 7: heal-apply (non-fatal) ---
  const r7 = await runner.run(createHealApplyStage());
  void r7;

  // -- Stage 8: git (skipped when nothing changed or on --dry-run) ---
  if (opts.dryRun) {
    runner.markSkipped('git', '--dry-run');
  } else {
    const r8 = await runner.run(createGitStage(codeHost));
    void r8;
  }

  // -- Stage 9: notify (the report channel; skipped on --dry-run, which tested nothing) ---
  if (opts.dryRun) {
    runner.markSkipped('notify', '--dry-run');
  } else {
    const r9 = await runner.run(createNotifyStage());
    void r9;
  }

  await finalise(manifest);
  const reportFailed = manifest.stages.some(
    (s) => s.status === 'failed' && (s.name === 'gap-analysis' || s.name === 'testcase-digest'),
  );
  process.exit(reportFailed ? 1 : 0);
}

function pickGrep(manifest: ReturnType<typeof newManifest>): string {
  for (const d of manifest.domains) {
    if (d.grep !== null) return d.grep;
  }
  return '';
}

async function tryComment(
  codeHost: GitHubCodeHost,
  prNumber: number | null,
  body: string,
): Promise<void> {
  if (prNumber === null) return;
  try {
    await codeHost.commentOnPr(prNumber, body);
  } catch {
    /* comment is best-effort; the run report carries the truth */
  }
}

async function finalise(manifest: ReturnType<typeof newManifest>): Promise<void> {
  await saveManifest(manifest);
  const report = buildReport(manifest, new Date());
  await saveReport(report);
  // The readable answer. Printed AND saved, because the console is where the
  // question "what just happened?" is actually asked, and the file is where it
  // gets answered again a day later.
  const summary = renderRunSummary(manifest, report, await healStoryForSummary());
  await saveSummary(summary);
  console.log(`\n${summary}`);
  console.log(`Artifacts: ${summaryPath()} · artifacts/run/run-report.json · artifacts/run/manifest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
