/**
 * Stage 5: test-plan. The planner agent chooses the run's scope — smoke, sanity
 * or regression — from what stages 1 and 2 already worked out (risk areas, and
 * the digest verdict per scenario). `planTier` turns that choice into a --grep
 * and enforces the floor and the fail-open (pipeline-pattern.md §2):
 *
 *   - the agent PROPOSES; code decides, so a bad answer cannot narrow the run;
 *   - everything generated this run always runs (the creation-date tag);
 *   - an agent failure, or a filter that selects nothing, widens to the full
 *     suite with a named reason — the run gets slower, never smaller and quieter.
 *
 * A malformed `config/tiers.json` THROWS (fail-closed), and because this stage is
 * non-fatal the run then continues with no grep — the full suite — which is the
 * safe direction for a scope vocabulary nobody can read.
 *
 * An operator's `TEST_GREP` replaces all of that: the agent is not called at all,
 * the vocabulary is not even read (a broken tiers.json must not disable a human's
 * explicit instruction), and the floor steps aside. `planTier` records it as an
 * override, and the summary announces what it left out — see `run-summary.ts`.
 */

import type { StageSpec } from '../core/orchestration/stage-runner.js';
import { planTier, type PlannerOutcome } from '../planning/planner.js';
import { loadTiers, type Tier, type Tiers } from '../planning/tiers.js';
import { TestPlannerAgent } from '../ai/test-planner-agent.js';
import type { ModelClient } from '../ai/model-client.js';
import { runDateTag } from '../core/scenario/manifest.js';
import { env } from '../core/util/env.js';
import { dbg } from '../core/util/debug.js';

export function createTestPlanStage(model: ModelClient): StageSpec {
  return {
    name: 'test-plan',
    fatal: false,
    run: async (ctx) => {
      // An operator's TEST_GREP is absolute: it IS the filter. The agent is skipped
      // entirely — asking a model to pick a scope and then discarding the answer
      // costs a call and leaves a reason in the report that nothing acted on.
      const override = env.TEST_GREP ?? null;
      if (override !== null && env.CI !== undefined) {
        // The one case worth shouting about: an override on a CI run is almost
        // always a leftover value rather than a decision someone made just now.
        ctx.recordDegradation(
          'test-plan',
          `TEST_GREP="${override}" is overriding the plan while CI is set — an override in CI is almost certainly a leftover, not a decision`,
        );
      }

      let tiers: Tiers | null = null;
      let proposed: Tier | null = null;
      let proposalReason = '';
      let proposalFailure: string | null = null;

      if (override === null) {
        // Malformed tiers.json throws (fail-closed) and, because this stage is
        // non-fatal, the run continues with no grep — the full suite, which is the
        // safe direction for a scope vocabulary nobody can read. Skipped entirely on
        // an override, which needs no vocabulary.
        tiers = await loadTiers();

        // The agent proposes. Anything it does badly is caught here and becomes a named
        // fail-open rather than a thrown stage: a scope that cannot be chosen is not a
        // reason to skip the suite.
        try {
          const plan = await new TestPlannerAgent(model).plan(ctx.manifest, tiers);
          proposed = plan.scope;
          proposalReason = plan.reason;
        } catch (err) {
          proposalFailure = err instanceof Error ? err.message : String(err);
          dbg('test-plan', 'agent-failed', { error: proposalFailure });
        }
      } else {
        dbg('test-plan', 'override', { grep: override, ci: env.CI !== undefined });
      }

      // Titles generated this run — the enforced floor, re-derived from the manifest
      // so a re-run of this stage alone always sees the same set.
      const generatedTitles = ctx.manifest.scenarios
        .filter((s) => s.verdict === 'generated')
        .map((s) => s.title);

      const outcome: PlannerOutcome =
        override !== null
          ? planTier(
              { manifest: ctx.manifest, proposed: null, override, generatedTitles, generatedDateTag: null },
              UNUSED_TIERS,
              ctx,
            )
          : planTier(
              {
                manifest: ctx.manifest,
                proposed,
                proposalFailure,
                override: null,
                generatedTitles,
                generatedDateTag: generatedTitles.length > 0 ? runDateTag(ctx.manifest) : null,
              },
              // Unreachable — the branch above loads it — and a loud failure beats
              // handing `planTier` an empty vocabulary, which would silently plan the
              // widest possible run and look like an ordinary fail-open.
              tiers ?? unreachableTiers(),
              ctx,
            );

      // Record on the manifest so stage 6 reads it, and so the summary can say
      // whether the run was planned or overridden.
      ctx.manifest.grepOverride = override;
      for (const d of ctx.manifest.domains) {
        d.tier = outcome.tier;
        d.grep = outcome.grep;
      }

      const lines = [
        outcome.source === 'human'
          ? `Scope: human override (planner agent skipped)`
          : `Scope: ${outcome.tier}${outcome.source === 'planner' ? ' (chosen by the planner agent)' : ' (widened by a fallback)'}`,
        outcome.source === 'human' ? `Why: TEST_GREP was supplied — the floor is not applied` : '',
        proposalReason.length > 0 ? `Why: ${proposalReason}` : '',
        outcome.grep ? `Grep: ${outcome.grep}` : `Grep: (full suite)`,
      ].filter((l) => l.length > 0);
      if (outcome.degradation.length > 0) {
        lines.push(`Degradations (each a named fail-open):`);
        for (const r of outcome.degradation) lines.push(`  - ${r}`);
      }
      return lines.join('\n');
    },
  };
}

/**
 * A stand-in vocabulary for the override path, which never reads a tag list — the
 * override IS the grep. Passed so `planTier` keeps one signature; `regression`'s
 * empty tag list is the shape of the only branch that path can reach.
 */
const UNUSED_TIERS: Tiers = {
  smoke: { description: '', tags: [] },
  sanity: { description: '', tags: [] },
  regression: { description: '', tags: [] },
};

/** Never returns: named so the unreachable branch fails as an error, not as a default. */
function unreachableTiers(): never {
  throw new Error('test-plan: the tier vocabulary was not loaded on the planned path');
}
