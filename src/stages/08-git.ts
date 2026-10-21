/**
 * Stage 8: git. Branch, commit, push, PR — but only when there is something
 * shippable. Skipped when nothing changed (pipeline-pattern.md §2).
 *
 * Nothing merges itself. The PR is the review gate.
 */

import type { StageContext, StageSpec } from '../core/orchestration/stage-runner.js';
import { runStageProcess } from '../core/orchestration/stage-runner.js';
import type { CodeHost } from '../delivery/code-host.js';
import { env } from '../core/util/env.js';

export function createGitStage(codeHost: CodeHost): StageSpec {
  return {
    name: 'git',
    fatal: false,
    run: async (ctx) => {
      // Check for shippable changes.
      const status = await runStageProcess('git', ['status', '--porcelain'], { timeoutMs: 30_000 });
      if (!status.ok) throw new Error(`git status failed: ${status.output}`);
      if (status.output.trim() === '') {
        return 'Nothing shippable changed; skipping branch/commit/push/PR.';
      }

      const baseBranch = env.SOURCE_BRANCH ?? ctx.manifest.branch ?? 'main';
      const branchName = `tcgen/${ctx.manifest.runId}`;
      await codeHost.createBranch(branchName, baseBranch);
      await codeHost.commitAll(`test(pipeline): generated tests + healed locators\n\nRun: ${ctx.manifest.runId}`);
      await codeHost.push(branchName);
      const ref = await codeHost.openPr({
        title: `test(pipeline): generated tests for run ${ctx.manifest.runId}`,
        body: buildPrBody(ctx),
        headBranch: branchName,
        baseBranch,
      });
      return `Opened PR: ${ref.url}`;
    },
  };
}

function buildPrBody(ctx: StageContext): string {
  const domains = ctx.manifest.domains;
  const pw = domains[0]?.playwright ?? null;
  const lines = [
    `## Pipeline run ${ctx.manifest.runId}`,
    ``,
    `Source: PR #${ctx.manifest.sourcePR ?? '?'}`,
    ``,
    `**What this PR adds:**`,
    `- New scenarios in \`scenarios/\` (stage 1)`,
    `- Generated tests inside managed regions (stage 2 + retry)`,
    `- Page-object members added by the builder (stage 3)`,
    `- Locator heals applied (stage 7)`,
    ``,
  ];
  if (pw) {
    lines.push(
      `**Playwright run:**`,
      `- Passed: ${pw.passed}`,
      `- Failed: ${pw.failed}`,
      `- Flaky: ${pw.flaky}`,
      ``,
      `Failures above are **not** auto-reverted. The run result is the signal — see the run report for details.`,
      ``,
    );
  }
  lines.push(`**Review guidance:** generated code is between \`@digest:managed:start/end\`. Everything outside is handwritten.`);
  return lines.join('\n');
}
