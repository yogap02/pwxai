/**
 * Stage 8: git. Branch, commit, push, PR — but only when there is something
 * shippable. Skipped when nothing changed (pipeline-pattern.md §2).
 *
 * Nothing merges itself. The PR is the review gate.
 */

import type { StageContext, StageSpec } from '../core/orchestration/stage-runner.js';
import { runStageProcess } from '../core/orchestration/stage-runner.js';
import type { CodeHost } from '../delivery/code-host.js';
import { buildPrBody } from '../delivery/pr-body.js';
import { env } from '../core/util/env.js';

export function createGitStage(codeHost: CodeHost): StageSpec {
  return {
    name: 'git',
    fatal: false,
    run: async (ctx) => {
      // Check for shippable changes.
      const status = await runStageProcess('git', ['status', '--porcelain'], { timeoutMs: 30_000 });
      if (!status.ok) throw new Error(`git status failed: ${status.output}`);
      // `stdout`, not `output`: git writes warnings (line endings, dubious ownership) to
      // stderr, and a merged read would mistake a warning for a working tree that has
      // something to ship — then push an empty branch and open a PR for it.
      if (status.stdout.trim() === '') {
        // Recorded, not inferred: the report channel must be able to tell "we looked and
        // there was nothing" from "this run never reached the delivery step".
        ctx.manifest.delivery = { prUrl: null, shipped: false };
        return 'Nothing shippable changed; skipping branch/commit/push/PR.';
      }

      const baseBranch = deliveryBaseBranch(ctx);
      const branchName = `tcgen/${ctx.manifest.runId}`;

      // The repo's own gates, run on the OUTPUT for once. CI runs `typecheck && self-checks`
      // immediately BEFORE `npm run pipeline`, so nothing the pipeline generates has ever
      // been checked by them: a spec that does not compile, or a block that reached past the
      // page object, was committed, pushed and opened as a PR — taking every handwritten test
      // in its file down with it. Shipping is the last place that can refuse, so it does.
      const refusal = await shipGate();
      if (refusal !== null) {
        // A failed stage is what puts this in front of a person: the summary renders failed
        // stages under "Needs attention". Returning a string instead would report a
        // *succeeded* git stage and a green run that shipped nothing and said nothing.
        ctx.recordDegradation('git', refusal.split('\n')[0]!);
        throw new Error(refusal);
      }

      await codeHost.createBranch(branchName, baseBranch);
      await codeHost.commitAll(`test(pipeline): generated tests + healed locators\n\nRun: ${ctx.manifest.runId}`);
      await codeHost.push(branchName);
      const ref = await codeHost.openPr({
        title: `test(pipeline): generated tests for run ${ctx.manifest.runId}`,
        body: buildPrBody(ctx.manifest),
        headBranch: branchName,
        baseBranch,
      });
      ctx.manifest.delivery = { prUrl: ref.url, shipped: true };
      return `Opened PR: ${ref.url}`;
    },
  };
}

/**
 * Run the repo's static gates over the working tree — `npm run typecheck` and `npm run
 * self-checks`, the two gates AGENTS.md names. Returns a reason to refuse, or null when
 * the generated output is shippable. The full detail goes in the thrown message, which
 * lands in `artifacts/run/run-report.json`; the summary gets the first line.
 */
async function shipGate(): Promise<string | null> {
  for (const script of ['typecheck', 'self-checks'] as const) {
    const res = await runStageProcess('npm', ['run', script], { timeoutMs: 10 * 60_000 });
    if (res.ok) continue;
    const detail = res.output
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-10)
      .join('\n');
    return `\`npm run ${script}\` fails on this working tree — the generated code is not shippable:\n${detail}`;
  }
  return null;
}

/**
 * The branch the delivery branch is based on.
 *
 * `manifest.branch` is the SOURCE PR's branch — the change under test. When that change
 * lives in another repo (the product repo dispatching this pipeline after its deploy), the
 * ref does not exist here, so `git fetch origin <it>` would fail with a git error naming a
 * branch the deliverer never had. `SOURCE_BRANCH` is the deliberate way to say it, and the
 * source branch is only a sensible default when the two repos are the same one.
 */
function deliveryBaseBranch(ctx: StageContext): string {
  if (env.SOURCE_BRANCH !== undefined) return env.SOURCE_BRANCH;
  const foreign =
    env.SOURCE_REPO_SLUG !== undefined && env.SOURCE_REPO_SLUG !== env.WORK_REPO_SLUG;
  if (foreign) return 'main';
  return ctx.manifest.branch ?? 'main';
}
