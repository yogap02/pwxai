/**
 * Stage 7: heal-apply. Fold runtime heal records into locator files.
 * Non-fatal: a heal that did not apply is still active at runtime next run.
 * Commit proceeds regardless (pipeline-pattern.md §2).
 *
 * The stage reports the repair AND whether it held. A repair is a claim about an
 * element; the assertion that used it is the evidence. So the outcome decides
 * whether the source is touched at all:
 *
 *   verified    — the test passed on the repaired locator. Folded into the source.
 *   otherwise   — not backed by a passing test. NOT written to the source, and named
 *                 as a degradation.
 *
 * Declining matters more than it looks. Applying a repair whose test failed writes a
 * locator we have evidence against into the source, and the NEXT run is green on it —
 * a wrong locator, committed, with the failing test gone. That is precisely the
 * silent green this pipeline exists to prevent, and it is the one harm the outcome
 * field can stop. The runtime keeps healing meanwhile, so an unapplied repair costs
 * nothing while it is reviewed.
 */

import type { StageSpec } from '../core/orchestration/stage-runner.js';
import type { DomainOutcome } from '../core/scenario/manifest.js';
import {
  HealManifest,
  type HealRecord,
  type HealRefusal,
  type HealRefusalReason,
} from '../runtime/heal-manifest.js';
import { applyHeals } from '../runtime/heal-writer.js';
import { dbg } from '../core/util/debug.js';

/** Cap so a wildly broken run costs the report a paragraph, not fifty lines. */
const MAX_REPORTED = 10;

/**
 * The repairs this stage may write into the source: only those a passing test backed.
 * Pure, because it is the one rule here that can corrupt a file if it is wrong.
 */
export function repairable(records: readonly HealRecord[]): HealRecord[] {
  return records.filter((r) => r.outcome === 'test-passed');
}

export function createHealApplyStage(): StageSpec {
  return {
    name: 'heal-apply',
    fatal: false,
    run: async (ctx) => {
      const report = await HealManifest.loadReport();

      const applying = repairable(report.heals);
      const declined = report.heals.filter((r) => r.outcome !== 'test-passed');
      dbg('heal-apply', 'records', {
        run: report.run,
        heals: report.heals.length,
        verified: applying.length,
        declined: declined.length,
        refusals: report.refusals.length,
      });
      for (const record of declined) {
        ctx.recordDegradation('heal-apply', `NOT applied — ${declinedWhy(record)}`);
      }

      const refusalLines = summariseRefusals(report.refusals);
      if (report.heals.length === 0) {
        // Say so in the manifest, not just in the console. `null` here read as
        // "the stage did not run", which is exactly how a stage that has NEVER
        // produced a heal looked indistinguishable from one that works.
        for (const d of ctx.manifest.domains) d.healApply = 'skipped';
        return ['No heals recorded this run.', ...refusalLines].join('\n');
      }

      const outcome = await applyHeals(applying);
      for (const s of outcome.skipped) {
        ctx.recordDegradation('heal-apply', `did not apply in ${s.record.file}: ${s.reason}`);
      }
      // Recorded as-is. This used to be `skipped.length > 0 ? 'succeeded' :
      // 'succeeded'` — both branches identical, so a run where EVERY heal failed
      // to apply still reported success. A heal that did not apply leaves the
      // broken locator in the source; that is a failure of this stage, and the
      // stage is non-fatal, so saying so costs nothing.
      const status: NonNullable<DomainOutcome['healApply']> =
        outcome.applied.length === 0 ? 'failed' : 'succeeded';
      for (const d of ctx.manifest.domains) {
        d.healApply = status;
      }
      dbg('heal-apply', 'applied', {
        status,
        applied: outcome.applied.length,
        skipped: outcome.skipped.length,
      });
      return [
        `Heals recorded: ${report.heals.length} (${applying.length} verified, ${declined.length} not)`,
        `Applied: ${outcome.applied.length}`,
        `Skipped: ${outcome.skipped.length}`,
        ...report.heals.slice(0, MAX_REPORTED).map((r) => `  - ${describeHeal(r)}`),
        ...outcome.skipped.slice(0, 5).map((s) => `  - not applied: ${s.record.file}: ${s.reason}`),
        ...refusalLines,
      ].join('\n');    },
  };
}

/** One repair, with the failure that prompted it and what the assertion did next. */
export function describeHeal(record: HealRecord): string {
  return `${record.brokenLocator} → ${record.healedLocator} in ${record.file} — ${record.observed}; ${outcomeSentence(record)}`;
}

/** What the test that used the repair did — the part that settles the claim. */
export function outcomeSentence(record: HealRecord): string {
  if (record.outcome === 'test-passed') {
    return `verified: ${whoWhat(record.tests, 'used')} passed on the repaired locator`;
  }
  if (record.outcome === 'test-failed') {
    return `NOT verified: ${whoWhat(record.tests, 'used')} FAILED`;
  }
  return 'unverified: no finished test used the repair';
}

/** Why a repair was withheld from the source. */
function declinedWhy(record: HealRecord): string {
  const repair = `${record.brokenLocator} → ${record.healedLocator} in ${record.file}`;
  if (record.outcome === 'test-failed') {
    return `${repair} — ${whoWhat(record.tests, 'used')} FAILED, so the source was left alone (the failure may be elsewhere in the test; either way nothing passed on this locator)`;
  }
  return `${repair} — no finished test used the repair, so the source was left alone`;
}

/** One refusal, with why, and whether the test that hit it went red. */
function describeRefusal(refusal: HealRefusal): string {
  return `${refusal.brokenLocator} — ${refusal.reason}: ${refusal.detail}; ${refusalFate(refusal)}`;
}

function refusalFate(refusal: HealRefusal): string {
  if (refusal.outcome === 'test-failed') {
    return `${whoWhat(refusal.tests, 'hit')} FAILED — this is where it broke`;
  }
  if (refusal.outcome === 'test-passed') {
    return `${whoWhat(refusal.tests, 'hit')} passed anyway`;
  }
  return 'no finished test hit it';
}

/** `test "X"`, or `test "X" (of 2 that used it)`. */
function whoWhat(tests: readonly string[], verb: string): string {
  const first = tests[0];
  if (first === undefined) return `the test that ${verb} it`;
  return tests.length === 1 ? `test "${first}"` : `test "${first}" (of ${tests.length} that ${verb} it)`;
}

/** One line per reason, then the first few in full. */
function summariseRefusals(refusals: readonly HealRefusal[]): string[] {
  if (refusals.length === 0) return [];
  const byReason = new Map<HealRefusalReason, number>();
  for (const r of refusals) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  const counts = [...byReason].map(([reason, n]) => `${reason}: ${n}`).join(', ');
  return [
    `Heal attempts refused: ${refusals.length} (${counts})`,
    ...refusals.slice(0, MAX_REPORTED).map((r) => `  - ${describeRefusal(r)}`),
  ];
}
