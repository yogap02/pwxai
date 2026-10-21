/**
 * Generator: scenario → test() block. Runs through the bounded pool because
 * it is pure network wait; results are re-pinned to scenario order before any
 * write (concurrency invariant #1).
 */

import { z } from 'zod';
import type { ScenarioBlock } from '../core/scenario/parser.js';
import { tagOption } from '../core/scenario/test-tags.js';
import type { ModelClient } from './model-client.js';
import { extractJson } from './model-client.js';
import { createPool, mapOrdered } from '../core/util/pool.js';
import { env } from '../core/util/env.js';
import { dbg } from '../core/util/debug.js';
import { VIEWPORT_MEMBER, type ViewportProfile } from '../core/scenario/viewport.js';

const GenerationSchema = z.object({
  /** The test() body — full `test('title', ...)` call. */
  code: z.string(),
  /** Clauses of Expected: this block claims to cover. Checked by the backstop. */
  coveredClauses: z.array(z.string()).default([]),
});
export type Generation = z.infer<typeof GenerationSchema>;

export interface GenerateItem {
  scenario: ScenarioBlock;
  /** Existing test titles in this domain, for de-duplication context. */
  existingTitles: readonly string[];
  /** Members available on the page objects (from capability index). */
  availableMembers: readonly string[];
  /** The page-object class the spec imports, e.g. `LandingPage`. */
  pomClass: string;
  /** The device profile the scenario is written for, or null (the run's default). */
  viewportProfile: ViewportProfile | null;
}

export class Generator {
  constructor(
    private readonly model: ModelClient,
    private readonly domainContext = '',
  ) {}

  async generateAll(items: readonly GenerateItem[]): Promise<Map<string, Generation>> {
    const pool = createPool(env.MODEL_CONCURRENCY);
    dbg('generate', 'batch', { scenarios: items.length, concurrency: env.MODEL_CONCURRENCY });
    const ordered = await mapOrdered(pool, items, async (item) => {
      const startedAt = Date.now();
      dbg('generate', 'start', {
        scenario: item.scenario.id,
        title: item.scenario.title,
        availableMembers: item.availableMembers.length,
        viewport: item.viewportProfile ?? '(default)',
      });

      const prompt = [
        `Write a Playwright test block for this scenario.`,
        ``,
        `Scenario title: ${item.scenario.title}`,
        `Expected: ${item.scenario.expected}`,
        `Notes: ${item.scenario.notes}`,
        `Tags: ${item.scenario.tags.join(' ')}`,
        `Required tag option: ${tagOption(item.scenario.tags)}`,
        ``,
        `Domain context (how this feature area actually works — authoritative; prefer it over generic assumptions):`,
        this.domainContext.trim().length > 0 ? this.domainContext : '(none provided)',
        ``,
        `Existing tests in this domain (do not duplicate):`,
        ...item.existingTitles.map((t) => `  - ${t}`),
        ``,
        `Page-object members you may call (verified to exist — use ONLY these):`,
        ...item.availableMembers.map((m) => `  - ${m}`),
        ``,
        `The page-object class is ${item.pomClass}. Instantiate it as new ${item.pomClass}(page); it is already imported at the top of the spec.`,
        ``,
        `Viewport: ${
          item.viewportProfile === null || item.viewportProfile === 'desktop'
            ? `the run's default viewport — do not change it`
            : `${item.viewportProfile}. Call await pageObject.${VIEWPORT_MEMBER}('${item.viewportProfile}') BEFORE the first navigation, and assert only what that viewport shows (a desktop-only member asserts elements that are hidden there).`
        }`,
        ``,
        `Output JSON: {"code": string, "coveredClauses": string[]}`,
        ``,
        `Rules:`,
        `- code must be a complete test('<title>', ${tagOption(item.scenario.tags)}, async ({ page }) => { ... }) call, TypeScript, Playwright 1.63 API.`,
        `- The tag option must be present and must be exactly ${tagOption(item.scenario.tags)} — the pipeline runs with --grep on those tags.`,
        `- Only use members from the list above.`,
        `- Pass each member the arguments its signature declares — a member listed with parameters cannot be called with none (expectHeroCtaTargets(href: string) needs a href).`,
        `- When Expected names a quantity ("at least three project cards", "six package cards"), assert that quantity with the matching count member from the list (e.g. expectCollectionCountAtLeast(3)). A presence check alone does NOT verify it.`,
        `- Assertions belong to the page objects: call the listed 'expect*()' members.`,
        `- Do NOT call expect() and do NOT assert on raw locators inside the block — the spec never imports expect.`,
        `- Emit ONLY the test(...) call: no import/export and no other top-level statement.`,
        `- Do NOT write import statements. The spec file already imports the healing fixture ('test') and the page-object class at the top; an import inside a test.describe() body is a syntax error. Use the class as it is already imported (e.g. new LandingPage(page)).`,
        `- Never call the Playwright \`page\` API in the block (no page.setViewportSize, no page.locator, no page.goto): every navigation, viewport change and assertion goes through the page object.`,
        `- The block should navigate through a page-object method, then call the expect*() members that verify the scenario.`,
        `- coveredClauses: the behaviours from Expected that this test actually asserts.`,
        `- If you cannot express the scenario with the available members, still output your best block; the classifier has already gated buildability.`,
      ].join('\n');

      const raw = await this.model.chat(
        [
          { role: 'system', content: 'You are a precise Playwright test generator. Respond only with JSON.' },
          { role: 'user', content: prompt },
        ],
        { maxTokens: 2_000, temperature: 0.2 },
      );
      const generation = GenerationSchema.parse(extractJson(raw));
      dbg('generate', 'done', {
        scenario: item.scenario.id,
        codeChars: generation.code.length,
        coveredClauses: generation.coveredClauses.length,
        ms: Date.now() - startedAt,
      });
      return generation;
    });

    // Re-pin to scenario order: mapOrdered already preserves input order.
    const out = new Map<string, Generation>();
    items.forEach((item, i) => {
      out.set(item.scenario.id, ordered[i]!);
    });
    return out;
  }
}
