/**
 * Domain map resolver.
 *
 * One map is the only place product vocabulary lives (pipeline-pattern.md §3).
 * `config/domain-map.json` takes a domain key to its spec directory, page-
 * object directory, class name, entry paths, auth flag, and hand-authored
 * entry-discovery steps.
 *
 * Two honesty rules:
 *   1. Manual edits are authoritative and preserved across re-resolution;
 *      the resolver may only BACKFILL structure, never overwrite a hand-set
 *      field.
 *   2. Paths are persisted repo-relative POSIX and rehydrated at load —
 *      never stored absolute.
 *
 * Filename casing is load-bearing (§6, adoption step 2): the map is keyed
 * lowercase, so a mixed-case `scenarios/CheckOut.txt` resolves as unmapped
 * and silently creates a second, empty entry. The loader lowercases every
 * key on read.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { rehydrate, assertRepoRelativePosix } from '../util/paths.js';

const DomainEntrySchema = z.object({
  /** What this domain covers, in product language. Hand-authored. */
  description: z.string(),
  /** Entry path(s) into the domain from the app root. Repo-relative or external URL. */
  entryPaths: z.array(z.string()),
  /** Whether reaching the domain requires authentication. */
  needsAuth: z.boolean(),
  /** Hand-authored, never model-filled: ordered steps to reach the real page
   * when the entry path is only a listing or a sign-in wall. */
  entryDiscoverySteps: z.array(z.string()).default([]),
  /** Spec directory for generated tests. Repo-relative POSIX. */
  specDir: z.string(),
  /** Page-object directory. Repo-relative POSIX. */
  pomDir: z.string(),
  /** Top-level page-object class name for this domain. */
  className: z.string(),
  /** How confident the map is in this entry, 0–1. Resolved on first run. */
  confidence: z.number().min(0).max(1).default(0),
});
export type DomainEntry = z.infer<typeof DomainEntrySchema>;

const DomainMapSchema = z.record(z.string(), DomainEntrySchema);
export type DomainMap = Map<string, DomainEntry>;

const MAP_PATH = 'config/domain-map.json';

export async function loadDomainMap(): Promise<DomainMap> {
  const abs = rehydrate(MAP_PATH);
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    // Missing map is a hard failure — silently defaulting to an empty map would
    // make every run unmapped and we'd silently no-op against the wrong scope.
    throw new Error(
      `Domain map not found at ${MAP_PATH}. Create it by hand-authoring entry paths and auth flags.`,
      { cause: err },
    );
  }
  const parsed = DomainMapSchema.parse(JSON.parse(raw));
  const map: DomainMap = new Map();
  for (const [key, entry] of Object.entries(parsed)) {
    const lower = key.toLowerCase();
    assertRepoRelativePosix(entry.specDir, `domain-map[${key}].specDir`);
    assertRepoRelativePosix(entry.pomDir, `domain-map[${key}].pomDir`);
    map.set(lower, entry);
  }
  return map;
}

/**
 * Backfill only: write `entry` under `key` ONLY if not already present.
 * Never overwrites a manual edit. Returns true when a write happened.
 */
export async function backfillDomainEntry(
  keyUs: string,
  entry: DomainEntry,
): Promise<boolean> {
  const key = keyUs.toLowerCase();
  const abs = rehydrate(MAP_PATH);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await readFile(abs, 'utf8')) as Record<string, unknown>;
  } catch {
    // File missing — create from scratch (first run). That is the resolver's job.
  }

  const existingKey = Object.keys(data).find((k) => k.toLowerCase() === key);
  if (existingKey !== undefined) {
    // Manual edit present — authoritative. Do not touch.
    return false;
  }

  data[key] = entry;
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return true;
}

/** Resolve a scenario file to its domain entry, or null when unmapped. */
export function resolveDomain(
  map: DomainMap,
  domainKeyOnDisk: string,
): { key: string; entry: DomainEntry } | null {
  const key = domainKeyOnDisk.toLowerCase();
  const entry = map.get(key);
  return entry ? { key, entry } : null;
}

/**
 * The per-domain instruction file: how this feature area actually works, earned
 * by driving the live app. It lives INSIDE `pomDir` on purpose — it travels with
 * the page object, and the builder's write-scope guard (allowedDirs = pomDir)
 * already covers it, so there is no second path to keep in sync.
 *
 * It is read by the builder (stage 3) AND fed to generation (stage 2) as
 * domain context.
 */
export function instructionFileFor(entry: DomainEntry): string {
  return `${entry.pomDir}/instruction.md`;
}

/**
 * Read a domain's instruction file as context for generation. Absent on a first
 * run is normal, not an error — return '' and let the caller name the gap.
 */
export async function readDomainContext(entry: DomainEntry): Promise<string> {
  try {
    return await readFile(rehydrate(instructionFileFor(entry)), 'utf8');
  } catch {
    return '';
  }
}
