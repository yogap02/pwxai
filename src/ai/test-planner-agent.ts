/**
 * Test planner agent. Chooses the SCOPE of this run — smoke, sanity or
 * regression — from what stages 1 and 2 already worked out.
 *
 * It PROPOSES and nothing more: the answer is a name, never a filter. The floor
 * ("everything generated this run always runs"), the fail-open, and the mapping
 * from name to `--grep` all live in `planning/planner.ts` and `planning/tiers.ts`,
 * in code — so a model that answers badly widens the run instead of handing a
 * reviewer a smaller green one.
 *
 * Like the classifier and the generator, a bad answer THROWS; stage 5 catches it
 * and fails open. Nothing is trusted from the model except the scope name and its
 * stated reason; both are recorded.
 */

import { z } from 'zod';
import { TIER_NAMES, type Tier, type Tiers } from '../planning/tiers.js';
import type { RunManifest } from '../core/scenario/manifest.js';
import type { ModelClient } from './model-client.js';
import { extractJson } from './model-client.js';
import { loadPrompt } from './prompts/load.js';
import { dbg } from '../core/util/debug.js';

const PlanSchema = z.object({
  scope: z.enum(TIER_NAMES),
  reason: z.string(),
});
export type Plan = { scope: Tier; reason: string };

export class TestPlannerAgent {
  constructor(private readonly model: ModelClient) {}

  async plan(manifest: RunManifest, tiers: Tiers): Promise<Plan> {
    const startedAt = Date.now();
    const prompt = await loadPrompt('test-plan', {
      RISK_AREAS: riskAreaLines(manifest),
      NEW_SCENARIOS: newScenarioLines(manifest),
      DIGEST: digestLines(manifest),
      UNBUILDABLE: unbuildableLines(manifest),
      SCOPES: scopeLines(tiers),
    });

    const raw = await this.model.chat(
      [
        {
          role: 'system',
          content: 'You are a precise test-scope planner. Respond only with JSON.',
        },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 500, temperature: 0 },
    );

    const plan = PlanSchema.parse(extractJson(raw));
    dbg('test-plan', 'agent', {
      scope: plan.scope,
      reason: plan.reason,
      riskAreas: manifest.riskAreas.length,
      scenarios: manifest.scenarios.length,
      ms: Date.now() - startedAt,
    });
    return plan;
  }
}

/** Stage 1's risk analysis, or the fact that it named none. */
function riskAreaLines(manifest: RunManifest): string {
  if (manifest.riskAreas.length === 0) return '(stage 1 named no risk areas — treat the change as unclear)';
  return manifest.riskAreas.map((a) => `  - ${a}`).join('\n');
}

/** The scenarios stage 1 appended for this change. */
function newScenarioLines(manifest: RunManifest): string {
  if (manifest.newScenarios.length === 0) return '(none written for this change)';
  return manifest.newScenarios
    .map((s) => `  - [${s.domain}] ${s.title}${tagSuffix(s.tags)}`)
    .join('\n');
}

/** Stage 2's verdict per scenario, with the reason where there is one. */
function digestLines(manifest: RunManifest): string {
  if (manifest.scenarios.length === 0) return '(no scenarios were digested)';
  return manifest.scenarios
    .map((s) => {
      const reason = s.verdict === 'covered' || s.verdict === 'unbuildable' ? ` — ${s.reason ?? ''}` : '';
      return `  - [${s.domain}] ${s.title}${tagSuffix(s.tags)} → ${s.verdict ?? 'undecided'}${reason}`;
    })
    .join('\n');
}

/** Blocked scenarios: the page objects cannot express them, so no test ran. */
function unbuildableLines(manifest: RunManifest): string {
  const rows = manifest.domains.flatMap((d) =>
    d.unbuildable.map((u) => `  - [${d.domain}] ${u.scenario.title} (missing: ${u.missingCapabilities.join(', ')})`),
  );
  return rows.length === 0 ? '(none blocked)' : rows.join('\n');
}

/** The vocabulary, straight from `config/tiers.json` — the one source of truth. */
function scopeLines(tiers: Tiers): string {
  return TIER_NAMES.map((name) => {
    const entry = tiers[name];
    const selects = entry.tags.length === 0 ? 'every test, no filter' : `tests tagged ${entry.tags.join(', ')}`;
    return `- \`${name}\` — ${entry.description} (selects ${selects})`;
  }).join('\n');
}

function tagSuffix(tags: readonly string[]): string {
  return tags.length === 0 ? '' : ` ${tags.join(' ')}`;
}
