/**
 * The body of the PR stage 8 opens — the durable record of a run.
 *
 * `artifacts/` is gitignored, so the run summary and the run report never reach the pull
 * request they describe: for a reviewer this text is the whole story. It therefore carries
 * both halves of what a person needs to review generated tests — the test result, and the
 * scope the run actually covered. A narrowed run that stays silent reads as "everything
 * passed", which is the silent smaller-green this pipeline exists to prevent, and nothing
 * merges itself, so this body *is* the review gate.
 *
 * The scope lines come from `run-summary`'s own computation, never a second copy of the
 * tier→tag rules: a PR body that quietly disagrees with the summary is worse than a short
 * one. This module is pure — a manifest in, markdown out — so `self-checks` can hold it to
 * that.
 */

import type { RunManifest } from '../core/scenario/manifest.js';
import { scopeCoverageLines, verdictCounts } from '../core/orchestration/run-summary.js';

export function buildPrBody(manifest: RunManifest): string {
  return [
    `## Pipeline run \`${manifest.runId}\``,
    '',
    sourceLine(manifest),
    '',
    '### Scope this run covered',
    ...scopeSection(manifest),
    '',
    '### What this run added',
    ...addedSection(manifest),
    '',
    '### Test result',
    ...resultSection(manifest),
    '',
    '### Review guidance',
    '- Generated code lives between `@digest:managed:start` and `@digest:managed:end`. Everything outside it is handwritten and untouched by the pipeline.',
    '- A failing test is a signal, not a flake to retry: nothing is reverted, filtered or auto-fixed on failure.',
    '- **Nothing merges itself.** This PR is the review gate; it is never merged automatically.',
  ].join('\n');
}

function sourceLine(manifest: RunManifest): string {
  const pr = manifest.sourcePR === null ? 'PR unknown' : `PR #${manifest.sourcePR}`;
  const branch = manifest.branch === null ? '' : ` (\`${manifest.branch}\`)`;
  return `Source: ${pr}${branch}`;
}

function scopeSection(manifest: RunManifest): string[] {
  const lines = scopeCoverageLines(manifest);
  if (lines.length > 0) return lines;
  return ['- No domain recorded a scope for this run — stage 5 did not reach a tier decision.'];
}

function addedSection(manifest: RunManifest): string[] {
  const out: string[] = [];

  if (manifest.newScenarios.length > 0) {
    out.push(`- Stage 1 appended **${manifest.newScenarios.length} scenario(s)** for this change:`);
    for (const s of manifest.newScenarios) out.push(`  - \`${s.domain}\` — ${s.title}`);
  } else {
    out.push('- Stage 1 appended no scenario for this change.');
  }

  const tally = verdictCounts(manifest);
  out.push(`- Digest over ${manifest.scenarios.length} scenario(s): ${tally || 'no verdict recorded'}`);

  const workOrders = manifest.domains.flatMap((d) =>
    d.unbuildable.map((u) => ({
      domain: d.domain,
      title: u.scenario.title,
      missing: u.missingCapabilities,
    })),
  );
  if (workOrders.length > 0) {
    // Named, never silently dropped: these are the scenarios the POM cannot express yet, so
    // the reader can see what the run could NOT cover as well as what it did.
    out.push(
      `- **${workOrders.length} work order(s)** — the page objects cannot express these yet, so no test was written:`,
    );
    for (const w of workOrders) {
      // A reason can repeat: the stage-2 retry re-records the same violation per pass.
      const reasons = [...new Set(w.missing)];
      const why = reasons.length > 0 ? ` — reason: ${reasons.map((c) => `\`${c}\``).join(', ')}` : '';
      out.push(`  - \`${w.domain}\` — ${w.title}${why}`);
    }
  }

  if (manifest.riskAreas.length > 0) {
    out.push('- Risk areas stage 1 named:');
    for (const area of manifest.riskAreas) out.push(`  - ${area}`);
  }

  return out;
}

function resultSection(manifest: RunManifest): string[] {
  const out: string[] = [];
  const totals = { passed: 0, failed: 0, flaky: 0 };

  for (const d of manifest.domains) {
    if (d.playwright === null) continue;
    totals.passed += d.playwright.passed;
    totals.failed += d.playwright.failed;
    totals.flaky += d.playwright.flaky;
    const tier = d.tier === null ? '' : ` — tier \`${d.tier}\``;
    out.push(
      `- \`${d.domain}\`${tier}: **${d.playwright.passed} passed · ${d.playwright.failed} failed · ${d.playwright.flaky} flaky**`,
    );
  }

  if (out.length === 0) {
    return [
      '- No browser run was recorded — stage 6 was skipped, or the run did not reach it. This PR is therefore unreviewed by tests.',
    ];
  }

  out.push(`- **Total: ${totals.passed} passed · ${totals.failed} failed · ${totals.flaky} flaky**`);
  if (totals.failed > 0) {
    out.push(
      '- The failing case(s), and the traces behind them, are in this workflow run\'s `pipeline-run` artifact (`artifacts/run-report/`).',
    );
  }
  return out;
}
