/**
 * Classifier. Two questions, both must pass (pipeline-pattern.md §3):
 *
 *   Q1: does anything already cover this scenario?
 *   Q2: can the page objects express the part that makes it novel?
 *
 * Asking only Q1 is structurally unsafe: a scenario is novel because of some
 * behaviour B; a generation that silently drops B leaves only already-covered
 * behaviour — a passing duplicate test, indistinguishable from legitimate
 * overlap. So a scenario the POMs cannot express is classified `blocked`,
 * skips generation, and emits a marked-unbuildable block tagged with what is
 * missing. That block is stage 4's work order.
 *
 * The capability verdict is deliberately NOT cached — it is a claim about the
 * page objects, which is exactly what the next stage changes.
 */

import { z } from 'zod';
import type { ScenarioBlock } from '../core/scenario/parser.js';
import type { CapabilityLookup } from './capability-index.js';
import type { ModelClient } from './model-client.js';
import { extractJson } from './model-client.js';
import { dbg } from '../core/util/debug.js';

const VerdictSchema = z.object({
  /** Q1: does existing coverage already cover this scenario's behaviour? */
  alreadyCovered: z.boolean(),
  /** Q2: can the page objects express the novel part? FALSE => blocked. */
  pomCanExpress: z.boolean(),
  /** Member names the model would use. Checked against the real surface. */
  membersUsed: z.array(z.string()).default([]),
  /** One-line justification, recorded in the report. */
  reason: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export type Classification =
  | { kind: 'covered'; reason: string }
  | { kind: 'novel'; reason: string; membersUsed: string[] }
  | { kind: 'blocked'; reason: string; missingCapabilities: string[] };

/**
 * What to say when the classifier reports that the page object cannot express a scenario and
 * names nothing to add. There is no member to invent, so the work order has to be phrased as the
 * gap — it is the only way stage 4 is told what to build.
 */
const UNEXPRESSIBLE = 'an expect*() capability for this scenario — no listed member can express it';

/**
 * Which gate a scenario passes, read back in code from the model's raw answer rather than trusted.
 *
 * Gate 1 is coverage. Gate 2 is capability, checked against the REAL page-object surface, and it
 * has two ways to fail — the second one is silent:
 *
 *   - the model names a member the page object does not have → blocked, naming it;
 *   - the model answers `pomCanExpress: false` with NO members named. That is the honest answer
 *     for behaviour which lives outside the page — a CI workflow, a deploy script, a docs
 *     invariant — because there is no member to invent. `missing` is then empty *by construction*,
 *     and reading only that list called such a scenario `novel`: stage 2 generated a block that
 *     could not touch the thing the scenario was about, and every later run held it as a passing
 *     test. Eight of them arrived on the first product-triggered run, for a deploy-config change,
 *     under `Needs attention — Nothing`.
 *
 * A `novel` verdict that names no member is refused for the same reason — a block that calls no
 * member asserts nothing — so gate 2 blocks unless the model both says yes and names what it would
 * use. Pure, and driven by synthetic answers in self-checks: the easy thing to get wrong here is
 * the emptiness of a list.
 */
export function capabilityGate(
  verdict: Pick<Verdict, 'alreadyCovered' | 'pomCanExpress' | 'membersUsed' | 'reason'>,
  has: (member: string) => boolean,
): Classification {
  if (verdict.alreadyCovered) {
    // Gate 1 — coverage. Nothing to generate, and nothing to add to the page object either.
    return { kind: 'covered', reason: verdict.reason };
  }

  const missing = verdict.membersUsed.filter((m) => !has(m));
  if (missing.length > 0) {
    return {
      kind: 'blocked',
      reason: `POM cannot express: ${missing.join(', ')}`,
      missingCapabilities: missing,
    };
  }
  if (!verdict.pomCanExpress || verdict.membersUsed.length === 0) {
    return {
      kind: 'blocked',
      reason: `POM cannot express: ${UNEXPRESSIBLE}`,
      missingCapabilities: [UNEXPRESSIBLE],
    };
  }
  return { kind: 'novel', reason: verdict.reason, membersUsed: [...verdict.membersUsed] };
}

export class Classifier {
  constructor(
    private readonly model: ModelClient,
    private readonly capabilities: CapabilityLookup,
    private readonly domainContext = '',
  ) {}

  async classify(scenario: ScenarioBlock, existingTestTitles: readonly string[]): Promise<Classification> {
    const startedAt = Date.now();
    // What goes in: which scenario, and what it is being judged against. The
    // existing titles count is the correlation a "covered" verdict needs.
    dbg('classify', 'start', {
      scenario: scenario.id,
      title: scenario.title,
      tags: scenario.tags,
      existingTitles: existingTestTitles.length,
      pomMembers: this.capabilities.all().length,
    });

    const prompt = [
      `Classify this test scenario for coverage and buildability.`,
      ``,
      `Scenario title: ${scenario.title}`,
      `Expected: ${scenario.expected}`,
      `Tags: ${scenario.tags.join(' ')}`,
      ``,
      `Domain context (how this feature area actually works — authoritative):`,
      this.domainContext.trim().length > 0 ? this.domainContext : '(none provided)',
      ``,
      `Existing test titles in this domain:`,
      ...existingTestTitles.map((t) => `  - ${t}`),
      ``,
      `Page-object members available for this domain (use ONLY these exact names; do not invent):`,
      ...this.capabilities.all().map((m) => `  - ${m}`),
      ``,
      `Answer as JSON:`,
      `{"alreadyCovered": boolean, "pomCanExpress": boolean, "membersUsed": string[], "reason": string}`,
      ``,
      `Rules:`,
      `- alreadyCovered: true only when an existing test covers the same behaviour.`,
      `- pomCanExpress: true only when the page-object methods/locators available can express the scenario's novel part.`,
      `- membersUsed: the exact member names you would call. They will be checked; a name that does not exist marks the scenario blocked with that name as the missing capability.`,
      `- Assertions live in the page objects, not the spec: membersUsed MUST name the 'expect*()' method that would verify the scenario's novel part (plus any navigation/action members). If no listed expect*() member can verify it, name the assertion that is missing.`,
      `- Never answer with an empty membersUsed unless alreadyCovered is true: an empty list is read as "no member can express this" and blocks the scenario instead of generating it. When nothing on the list can express it, set pomCanExpress false AND name in membersUsed the assertion the page object is missing — a name that does not exist yet is read as exactly that capability, which is what the work order needs.`,
    ].join('\n');

    const raw = await this.model.chat(
      [
        { role: 'system', content: 'You are a precise test-coverage classifier. Respond only with JSON.' },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 500, temperature: 0 },
    );

    const verdict = VerdictSchema.parse(extractJson(raw));

    // The gate decision from the model's raw answer, read back in code. One place
    // logs both halves — what the model claimed and what the code enforced — so a
    // "blocked" verdict cannot be mistaken for a model refusal.
    const classification = capabilityGate(verdict, (member) => this.capabilities.has(member));

    dbg('classify', 'verdict', {
      scenario: scenario.id,
      kind: classification.kind,
      alreadyCovered: verdict.alreadyCovered,
      pomCanExpress: verdict.pomCanExpress,
      membersUsed: verdict.membersUsed,
      reason: classification.reason,
      ms: Date.now() - startedAt,
    });
    return classification;
  }
}
