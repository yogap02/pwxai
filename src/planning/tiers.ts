/**
 * Tier vocabulary, read from `config/tiers.json`.
 *
 * One source of truth. Before this module the mapping lived in three places and
 * agreed in none of them: `planner.ts` hard-coded the tag patterns,
 * `run-summary.ts` restated them for the "what did NOT run" note, and
 * `config/tiers.json` described them to nobody — no code read the file, so an
 * operator could edit it and change nothing, silently. That is the shape this
 * repo refuses everywhere else: a malformed config value THROWS rather than
 * defaulting, and a config file nothing reads is a config file that lies.
 *
 * These three names are the planner agent's whole vocabulary:
 *   smoke      — the critical paths only.
 *   sanity     — smoke plus every core test (the always-run set).
 *   regression — the whole suite, no filter. Also the fail-open fallback.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { rehydrate } from '../core/util/paths.js';

export const TIER_NAMES = ['smoke', 'sanity', 'regression'] as const;
export type Tier = (typeof TIER_NAMES)[number];

const TierEntrySchema = z.object({
  description: z.string(),
  /** Playwright tags this scope selects. EMPTY means no filter: run everything. */
  tags: z.array(z.string()),
});

const TiersSchema = z.object({
  smoke: TierEntrySchema,
  sanity: TierEntrySchema,
  regression: TierEntrySchema,
});
export type Tiers = z.infer<typeof TiersSchema>;

const TIERS_PATH = 'config/tiers.json';

/** Read and validate the tier vocabulary. THROWS on anything malformed. */
export async function loadTiers(): Promise<Tiers> {
  return parseTiers(await readFile(rehydrate(TIERS_PATH), 'utf8'));
}

/**
 * Pure, so the shipped vocabulary can be validated in self-checks without a
 * filesystem write. A malformed value throws with the offending field named —
 * never a silent default, which would read as "a scope chose fewer tests".
 */
export function parseTiers(text: string): Tiers {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${TIERS_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = TiersSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
      .join('; ');
    throw new Error(`${TIERS_PATH} is malformed: ${issues}`);
  }
  // `regression` is the unfiltered scope by definition. Giving it a tag list would
  // silently exclude untagged tests from the run the summary calls "everything".
  if (parsed.data.regression.tags.length > 0) {
    throw new Error(
      `${TIERS_PATH}: regression must select everything (an empty tag list), got ${parsed.data.regression.tags.join(', ')}`,
    );
  }
  return parsed.data;
}
