/**
 * Planner: the agent's chosen scope → a playwright grep. The agent PROPOSES;
 * this decides.
 *
 * Stage 5 asks a planner agent which scope the run deserves — smoke, sanity or
 * regression — from what stages 1 and 2 already worked out. That answer is an
 * INPUT here, never the output: the agent never emits a grep, and it can never
 * narrow the run past the floor. The separation is the point — a model that
 * answers "smoke" on a change that broke everything must not be able to hand a
 * smaller green run to a reviewer.
 *
 * Every degraded input widens the run rather than narrowing it
 * (pipeline-pattern.md §3, "Fail open, always"): no usable answer from the agent,
 * a builder failure, a filter that selects nothing — all fall back, each with a
 * distinct named reason.
 *
 * ...with ONE deliberate exception, because a human is not a degraded input: a
 * `TEST_GREP` supplied by an operator is absolute. It is the filter, the floor is
 * not applied, and stage 5 does not consult the agent at all. It is an instruction,
 * not a hint — and absolute in effect is not the same as silent, so the run summary
 * reports the override and names any test this run wrote that the override excludes.
 *
 * The mirror-image rule: a malformed configuration value THROWS instead of
 * falling back to a default. That lives in `tiers.ts`, which is where the scope
 * vocabulary now comes from.
 *
 * The floor is enforced in code (§3): every test generated in this run always
 * runs. The mechanism is the creation-date tag stage 2 stamps on each freshly
 * generated block (`@YYYYMMDD`), so the floor no longer depends on a generated
 * title being character-identical to a scenario title — which is what the old
 * title-alternation silently required. The generated titles are kept as an
 * alternation on top, as a second net.
 */

import type { RunManifest } from '../core/scenario/manifest.js';
import type { StageContext } from '../core/orchestration/stage-runner.js';
import { TIER_NAMES, type Tier, type Tiers } from './tiers.js';

export type ScopeSource = 'planner' | 'human' | 'fail-open';

export interface PlannerInput {
  manifest: RunManifest;
  /** The scope the planner agent proposed, or null when it produced nothing usable. */
  proposed: Tier | null;
  /** Why the agent failed, when it did — folded into the named widening. */
  proposalFailure?: string | null;
  /**
   * A human-supplied grep (`TEST_GREP`). ABSOLUTE when set: it is the filter, the
   * floor is not applied, and the agent is never consulted. An instruction, not a
   * hint — the human is the merge gate, the same way a hand-edited domain-map entry
   * is authoritative. An unplanned-for test being excluded is not a silent loss as
   * long as the report says so, and it does (see `run-summary.ts`).
   */
  override: string | null;
  /** Titles of tests generated in this run — the floor requires they all run. */
  generatedTitles: readonly string[];
  /** This run's creation-date tag (`@YYYYMMDD`), or null when nothing was generated. */
  generatedDateTag: string | null;
}

export interface PlannerOutcome {
  /** The planned scope, or null when a human supplied the grep outright. */
  tier: Tier | null;
  /** Playwright grep string. Empty means the full suite. Never null. */
  grep: string;
  /** Named reason when any fallback fired. Empty when the plan is clean. */
  degradation: string[];
  /** Where the grep came from. A run report that cannot say this misattributes it. */
  source: ScopeSource;
}

export function planTier(input: PlannerInput, tiers: Tiers, ctx?: StageContext): PlannerOutcome {
  // A human's grep wins outright. Stage 5 already skipped the agent for this path,
  // so nothing is asked of a model and nothing was discarded — the point of the
  // override is to run an end-to-end pass without paying for a full suite.
  if (input.override !== null) {
    return { tier: null, grep: input.override, degradation: [], source: 'human' };
  }

  const degradation: string[] = [];
  let source: ScopeSource = input.proposed !== null ? 'planner' : 'fail-open';
  let tier: Tier = input.proposed ?? 'regression';

  if (input.proposed === null) {
    const why = input.proposalFailure ? ` (${input.proposalFailure})` : '';
    degradation.push(`planner agent produced no usable scope${why} — widened to the full suite`);
  }

  // A builder failure means a page object was mid-flight, so that domain's
  // scenarios may be unsatisfiable. Widen ONE step rather than jumping straight
  // to the whole suite: the failure is local, and the note still names the step.
  const builderFailures = input.manifest.domains.filter((d) => d.builder === 'failed').length;
  if (builderFailures > 0) {
    const widened = widen(tier);
    if (widened !== tier) {
      degradation.push(
        `builder failures in ${builderFailures} domain(s); widened ${tier} → ${widened}`,
      );
      tier = widened;
      source = 'fail-open';
    }
  }

  // Floor. The date tag is the mechanism (stage 2 stamps it on each generated
  // block); the generated titles are an alternation on top, because a tag that
  // failed to reach the test must not drop the test the run was triggered to write.
  const tags = tiers[tier].tags;
  const floor = [
    ...(input.generatedDateTag !== null ? [input.generatedDateTag] : []),
    ...input.generatedTitles,
  ];
  let grep =
    tags.length === 0
      ? ''
      : [...tags, ...floor]
          .map((p) => escapeForGrep(p))
          .filter((p) => p.length > 0)
          .join('|');

  // Re-verify: an empty grep selects everything (the full suite) — that is the
  // regression scope, and fine. A non-empty grep that matches nothing is a named
  // degradation that widens to full.
  if (grep !== '' && !wouldMatchAnything(grep, input.manifest)) {
    degradation.push('narrow filter selected nothing — widened to full suite');
    grep = '';
    tier = 'regression';
    source = 'fail-open';
  }

  if (ctx) {
    for (const reason of degradation) ctx.recordDegradation('test-plan', reason);
  }
  return { tier, grep, degradation, source };
}

/** One step wider: smoke → sanity → regression. Regression is already everything. */
function widen(tier: Tier): Tier {
  const at = TIER_NAMES.indexOf(tier);
  const next = TIER_NAMES[Math.min(at + 1, TIER_NAMES.length - 1)];
  return next ?? 'regression';
}

function escapeForGrep(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Would this grep match anything? The caller cannot know without listing tests,
 * so this is a conservative check against the manifest's scenario titles and tags.
 */
function wouldMatchAnything(grep: string, manifest: RunManifest): boolean {
  try {
    const re = new RegExp(grep, 'i');
    return manifest.scenarios.some((s) => re.test(s.title) || s.tags.some((t) => re.test(t)));
  } catch {
    // Malformed regex — don't crash; report and let the caller widen.
    return false;
  }
}
