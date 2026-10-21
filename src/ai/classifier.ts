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
    let classification: Classification;
    if (verdict.alreadyCovered) {
      // Gate 1 — coverage.
      classification = { kind: 'covered', reason: verdict.reason };
    } else {
      // Gate 2 — capability. Enforced in code against the real POM surface,
      // not trusted from the model's own claim of pomCanExpress.
      const missing = verdict.membersUsed.filter((m) => !this.capabilities.has(m));
      classification =
        missing.length > 0
          ? {
              kind: 'blocked',
              reason: `POM cannot express: ${missing.join(', ')}`,
              missingCapabilities: missing,
            }
          : { kind: 'novel', reason: verdict.reason, membersUsed: verdict.membersUsed };
    }

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
