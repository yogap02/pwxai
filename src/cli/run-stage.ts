/**
 * Single-stage runner. Run ONE stage in isolation, reusing the manifest a
 * previous run left in `artifacts/run/manifest.json`.
 *
 * Why: the whole loop costs model calls, a browser run and a git push. When one
 * stage misbehaves you want to re-run THAT stage, not pay for the other seven.
 * This is the debug handle; `npm run pipeline` is still the real run.
 *
 *   npm run stage:2
 *   npm run stage:3 -- --domain landing-page
 *   npm run stage:1 -- --pr 123
 *   npm run stage:6 -- --grep @core
 *   npm run stage:8 -- --dry-run
 *
 * Stages 1 and 2 START a manifest (a fresh run). Stages 3-8 CONSUME the one on
 * disk and refuse to guess when it is missing. Stages 6 and 8 change the world
 * (browser suite, git commit/push) — pass --dry-run to mark them skipped.
 */

import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { StageRunner } from '../core/orchestration/stage-runner.js';
import {
  newManifest,
  loadManifest,
  manifestExists,
  saveManifest,
  type RunManifest,
} from '../core/scenario/manifest.js';
import { buildReport, saveReport } from '../core/orchestration/run-report.js';
import { renderRunSummary, saveSummary, summaryPath } from '../core/orchestration/run-summary.js';
import { healStoryForSummary } from '../runtime/heal-manifest.js';
import { dbg } from '../core/util/debug.js';
import { env } from '../core/util/env.js';
import { ModelClient } from '../ai/model-client.js';
import { GitHubCodeHost } from '../delivery/github.js';
import { CdpBuilderStub } from '../agent/cdp-builder-stub.js';
import { createGapAnalysisStage } from '../stages/01-gap-analysis.js';
import { createTestcaseDigestStage } from '../stages/02-testcase-digest.js';
import { createPomBuilderStage } from '../stages/03-pom-builder.js';
import { createDigestRetryStage } from '../stages/04-testcase-digest-retry.js';
import { createTestPlanStage } from '../stages/05-test-plan.js';
import { createPlaywrightTestStage } from '../stages/06-playwright-test.js';
import { createHealApplyStage } from '../stages/07-heal-apply.js';
import { createGitStage } from '../stages/08-git.js';
import type { DigestOutcome } from '../stages/stage-types.js';

/** Canonical stage names, index 0 = stage 1. Mirrors run-pipeline's wiring. */
const STAGE_NAMES = [
  'gap-analysis',
  'testcase-digest',
  'pom-builder',
  'testcase-digest-retry',
  'test-plan',
  'playwright-test',
  'heal-apply',
  'git',
] as const;

interface CliOptions {
  stage: number;
  domain: string | undefined;
  pr: number | undefined;
  grep: string | undefined;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const out: CliOptions = {
    stage: 0,
    domain: undefined,
    pr: undefined,
    grep: undefined,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--domain' && argv[i + 1]) out.domain = argv[++i];
    else if (a === '--pr' && argv[i + 1]) out.pr = Number(argv[++i]);
    else if (a === '--grep' && argv[i + 1]) out.grep = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a !== undefined && !a.startsWith('--') && out.stage === 0) {
      out.stage = resolveStage(a) ?? 0;
    }
  }
  return out;
}

/** Accept `3` or `pom-builder`. Returns 1-8, or null when unknown. */
function resolveStage(arg: string): number | null {
  const n = Number(arg);
  if (Number.isInteger(n) && n >= 1 && n <= STAGE_NAMES.length) return n;
  const i = STAGE_NAMES.indexOf(arg.trim().toLowerCase() as (typeof STAGE_NAMES)[number]);
  return i === -1 ? null : i + 1;
}

function usage(): void {
  console.error(
    [
      'Run a single pipeline stage against the manifest left by a prior run.',
      '',
      'Usage: npm run stage -- <stage> [options]',
      `  <stage>    1-8, or one of: ${STAGE_NAMES.join(', ')}`,
      '  --domain <key>   required for stages 3/4 when the manifest has >1 domain',
      '  --pr <number>    required for stage 1',
      '  --grep <expr>    override the planner grep for stage 6 (beats TEST_GREP)',
      '  --dry-run        mark stages 6/8 skipped instead of running them',
      '',
      'Examples:',
      '  npm run stage:2',
      '  npm run stage -- 3 --domain landing-page',
      '  npm run stage:1 -- --pr 123',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.stage === 0) {
    usage();
    process.exit(2);
  }

  const startsRun = opts.stage <= 2;
  let manifest: RunManifest;
  if (startsRun) {
    // Stages 1/2 DEFINE the manifest; starting from the old one would append a
    // second set of domain outcomes to a stale run.
    manifest = newManifest(randomUUID().slice(0, 8));
  } else if (await manifestExists()) {
    manifest = await loadManifest();
  } else {
    console.error(
      `Stage ${opts.stage} (${STAGE_NAMES[opts.stage - 1]}) needs a manifest from a prior run.`,
    );
    console.error('Run `npm run stage:2` first, or `npm run pipeline`.');
    process.exit(2);
  }

  const model = new ModelClient();
  const codeHost = new GitHubCodeHost();
  const builder = new CdpBuilderStub();

  const domain = opts.domain ?? (opts.stage === 3 || opts.stage === 4 ? singleDomain(manifest) : '');

  const spec = (() => {
    switch (opts.stage) {
      case 1:
        if (opts.pr === undefined) {
          console.error('Stage 1 needs --pr <number> (it reads the issue and diff).');
          process.exit(2);
        }
        return createGapAnalysisStage(model, codeHost, opts.pr);
      case 2:
        return createTestcaseDigestStage(model);
      case 3:
        return createPomBuilderStage(domain, builder, digestFor(manifest, domain));
      case 4:
        return createDigestRetryStage(domain, model, digestFor(manifest, domain));
      case 5:
        return createTestPlanStage(model);
      case 6:
        // Precedence: the typed flag wins, then the operator's TEST_GREP, then whatever
        // the planner recorded. Without the middle term, someone who exported TEST_GREP
        // and then ran this one stage would silently get the planner's grep instead of
        // the filter they asked for.
        return createPlaywrightTestStage(opts.grep ?? env.TEST_GREP ?? pickGrep(manifest));
      case 7:
        return createHealApplyStage();
      default:
        return createGitStage(codeHost);
    }
  })();

  const runner = new StageRunner(manifest);
  const skip = opts.dryRun && (opts.stage === 6 || opts.stage === 8);
  dbg('stage-run', 'start', {
    stage: opts.stage,
    name: spec.name,
    run: manifest.runId,
    domain: domain || '(none)',
    dryRun: opts.dryRun,
    skipped: skip,
  });
  const result = skip
    ? runner.markSkipped(spec.name, '--dry-run')
    : await runner.run(spec);

  await saveManifest(manifest);
  const report = buildReport(manifest, new Date());
  await saveReport(report);
  const summary = renderRunSummary(manifest, report, await healStoryForSummary());
  await saveSummary(summary);

  console.log(`\nStage:  ${spec.name}`);
  console.log(`Status: ${result.record.status}`);
  dbg('stage-run', 'result', { name: spec.name, status: result.record.status, ok: result.ok });
  if (result.record.degradation && result.record.degradation.length > 0) {
    console.log(`Degradations:\n  - ${result.record.degradation.join('\n  - ')}`);
  }
  const body = (result.record.output ?? '').trim();
  if (body.length > 0) console.log(`\n${body}`);
  console.log(`\n${summary}`);
  console.log(`Artifacts: ${summaryPath()} · artifacts/run/manifest.json + run-report.json`);

  process.exit(result.ok ? 0 : 1);
}

/** The manifest's single domain, or a hard error when the choice is ambiguous. */
function singleDomain(manifest: RunManifest): string {
  const domains = manifest.domains.map((d) => d.domain);
  if (domains.length === 1) return domains[0]!;
  console.error(
    domains.length === 0
      ? 'The manifest has no domains — run `npm run stage:2` first.'
      : `Multiple domains in the manifest (${domains.join(', ')}); pass --domain <key>.`,
  );
  process.exit(2);
}

/** Rebuild a stage-3/4 DigestOutcome from what stage 2 persisted. */
function digestFor(manifest: RunManifest, domain: string): DigestOutcome {
  const d = manifest.domains.find((x) => x.domain === domain);
  if (!d) return { domain, generatedTitles: [], unbuildable: [] };
  return {
    domain,
    generatedTitles: generatedTitlesOf(manifest, domain),
    unbuildable: d.unbuildable,
  };
}

/** Titles generated this run — the planner's floor. */
function generatedTitlesOf(manifest: RunManifest, domain?: string): string[] {
  return manifest.scenarios
    .filter((s) => s.verdict === 'generated' && (domain === undefined || s.domain === domain))
    .map((s) => s.title);
}

function pickGrep(manifest: RunManifest): string {
  for (const d of manifest.domains) if (d.grep !== null) return d.grep;
  return '';
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
