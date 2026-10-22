/**
 * Durable run manifest. Threads through stages so downstream stages know what
 * upstream stages decided. Persisted to `artifacts/run/manifest.json`.
 *
 * Every path in here is repo-relative POSIX (see `paths.ts`). Rehydrate at
 * load; never persist an absolute path.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { joinRepo, rehydrate, toRepoRelative } from '../util/paths.js';
import type { ScenarioBlock } from './parser.js';

export type DigestVerdict = 'generated' | 'held' | 'covered' | 'unbuildable';

export interface ManifestScenario {
  domain: string;
  /** Scenario id (hash of the normalised title). */
  id: string;
  contentHash: string;
  title: string;
  tags: string[];
  /** Stage 2's decision for this scenario. Absent until the digest has run. */
  verdict?: DigestVerdict;
  /** Plain-language why — the one line a reader needs to read the verdict. */
  reason?: string;
  /**
   * The date this scenario's block was created, `YYYYMMDD` (UTC), as the
   * creation-date tag the block carries. Set when the block is generated;
   * preserved from the block on a hold, so a test that was not rewritten keeps
   * the date it was made instead of churning to today's date every run.
   */
  createdDate?: string;
}

/** A scenario stage 1 appended for this change: which domain, and what. */
export interface NewScenarioRow {
  domain: string;
  title: string;
  tags: string[];
}

export interface DomainOutcome {
  domain: string;
  /** Stage 1 decision. */
  scope: { newScenarios: number; touchedAreas: string[] } | null;
  /**
   * Stage 2 work orders: blocks the page objects could not express. Persisted so
   * stage 3 has something to build for, and stage 4 has something to retry — a
   * work order that only lives in memory is a work order nobody picks up.
   *
   * Per-scenario verdicts are NOT here: they live on `RunManifest.scenarios`,
   * next to the title they belong to, so the manifest reads without a join.
   */
  unbuildable: Array<{ scenario: ScenarioBlock; missingCapabilities: string[] }>;
  /** Stage 3/4 builder per-domain outcome. */
  builder: 'succeeded' | 'failed' | 'skipped' | null;
  /** Stage 5: tier chosen. */
  tier: string | null;
  /** Stage 5: grep chosen. */
  grep: string | null;
  /** Stage 6: playwright summary. */
  playwright: { passed: number; failed: number; flaky: number; durationMs: number } | null;
  /** Stage 7: heal-apply outcome. */
  healApply: 'succeeded' | 'failed' | 'skipped' | null;
}

export interface RunManifest {
  runId: string;
  startedAt: string;
  branch: string | null;
  sourcePR: number | null;
  /**
   * Stage 1's risk analysis — the areas this change puts at risk. Persisted as
   * structured data, not left in the stage's prose output, because the planner
   * agent reads it: a risk area that only exists as a rendered line cannot be
   * reasoned over.
   */
  riskAreas: string[];
  /** The scenarios stage 1 appended for this change (for the planner agent). */
  newScenarios: NewScenarioRow[];
  scenarios: ManifestScenario[];
  domains: DomainOutcome[];
  /**
   * A grep a human supplied (`TEST_GREP`). When set it was the whole filter for
   * this run: the planner agent was skipped and the floor not applied. Persisted
   * so `summary.md` can say the run was overridden rather than *planned* — a report
   * that cannot tell those apart misattributes the decision to the agent.
   */
  grepOverride: string | null;
  /**
   * Stage 5's decision, kept as data: which tier was planned, WHY the agent chose it, and
   * whether an agent chose it at all.
   *
   * `tier` alone cannot be reported honestly. The same word `smoke` means "the agent read this
   * change and judged the critical paths sufficient" or "a fallback widened it here", and a
   * report that prints one without the other attributes a decision to the agent that it never
   * made. The reason is the agent's own sentence, so the reader sees the judgement rather than
   * just its label.
   */
  plan: {
    tier: string;
    reason: string;
    source: 'planner' | 'human' | 'fail-open';
  } | null;
  /**
   * Stage 8's outcome: the PR it opened for review, or the fact that there was nothing to
   * ship. Persisted because the report channel links to it — a PR reference parsed back out
   * of a stage's prose output breaks the moment that wording changes.
   */
  delivery: { prUrl: string | null; shipped: boolean } | null;
  /** Ordered stage records for the run report. */
  stages: StageRecord[];
}

export interface StageRecord {
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Free-form output, redacted. */
  output?: string | undefined;
  /** Named fallback reasons when a stage degraded. */
  degradation?: string[] | undefined;
}

export function newManifest(runId: string): RunManifest {
  return {
    runId,
    startedAt: new Date().toISOString(),
    branch: null,
    sourcePR: null,
    riskAreas: [],
    newScenarios: [],
    scenarios: [],
    domains: [],
    grepOverride: null,
    plan: null,
    delivery: null,
    stages: [],
  };
}

/**
 * The run's creation-date tag: `@YYYYMMDD`, from the run's start time in UTC.
 *
 * Machinery writes it onto each block stage 2 generates, so it is stable within a
 * run and across a `npm run stage:N` re-run (which re-reads the same manifest).
 * A held block is not re-stamped — it keeps the date it was made — so nothing
 * churns the diff once a day. UTC on purpose: a local-time tag would flip at a
 * different instant for every operator, and this is a machine-facing label.
 */
export function runDateTag(manifest: RunManifest): string {
  const d = new Date(manifest.startedAt);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `@${y}${m}${day}`;
}

const MANIFEST_PATH = 'artifacts/run/manifest.json';

export async function saveManifest(manifest: RunManifest): Promise<void> {
  const path = rehydrate(MANIFEST_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Read the manifest a previous run left behind. Every field is defaulted, so a
 * manifest written by an older run still loads. Note the asymmetry with config:
 * a malformed *config* value throws (fail-closed), but the manifest is a record
 * of what happened and must never fail to load.
 */
export async function loadManifest(): Promise<RunManifest> {
  const raw = JSON.parse(await readFile(rehydrate(MANIFEST_PATH), 'utf8')) as Partial<RunManifest>;
  return {
    runId: raw.runId ?? 'unknown',
    startedAt: raw.startedAt ?? new Date().toISOString(),
    branch: raw.branch ?? null,
    sourcePR: raw.sourcePR ?? null,
    riskAreas: raw.riskAreas ?? [],
    newScenarios: (raw.newScenarios ?? []).map((s) => ({ ...s, tags: s.tags ?? [] })),
    scenarios: (raw.scenarios ?? []).map((s) => ({ ...s, tags: s.tags ?? [] })),
    // Rebuild each domain explicitly: older manifests carried a `digest` Map
    // that cannot survive JSON, and spreading would drag the dead key along.
    domains: (raw.domains ?? []).map((d) => ({
      domain: d.domain,
      scope: d.scope ?? null,
      unbuildable: d.unbuildable ?? [],
      builder: d.builder ?? null,
      tier: d.tier ?? null,
      grep: d.grep ?? null,
      playwright: d.playwright ?? null,
      healApply: d.healApply ?? null,
    })),
    grepOverride: raw.grepOverride ?? null,
    // Validated, not trusted: an unrecognised `source` would make the report claim the agent
    // chose a scope it did not, which is the misattribution this field exists to prevent.
    plan:
      raw.plan !== null &&
      raw.plan !== undefined &&
      typeof raw.plan.tier === 'string' &&
      (raw.plan.source === 'planner' || raw.plan.source === 'human' || raw.plan.source === 'fail-open')
        ? {
            tier: raw.plan.tier,
            reason: typeof raw.plan.reason === 'string' ? raw.plan.reason : '',
            source: raw.plan.source,
          }
        : null,
    delivery: raw.delivery ?? null,
    stages: raw.stages ?? [],
  };
}

/** True when a manifest has been persisted by an earlier run. */
export async function manifestExists(): Promise<boolean> {
  try {
    await readFile(rehydrate(MANIFEST_PATH), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// --- Scenario bookkeeping -----------------------------------------------------
// One list, keyed by domain, each row carrying its own verdict. This is the
// manifest's readable half: a reader can answer "what happened to my testcase?"
// without joining a hash-keyed map against anything.

/** The scenarios the run saw for a domain, in scenario order. */
export function scenariosForDomain(
  manifest: RunManifest,
  domain: string,
): ManifestScenario[] {
  return manifest.scenarios.filter((s) => s.domain === domain);
}

/**
 * Record a scenario and its verdict. Upsert by id, so a scenario stage 1 wrote
 * before the digest ran is completed rather than duplicated.
 */
export function recordScenario(
  manifest: RunManifest,
  scenario: {
    domain: string;
    id: string;
    contentHash: string;
    title: string;
    tags: readonly string[];
    verdict: DigestVerdict;
    reason: string;
    createdDate?: string;
  },
): void {
  const existing = manifest.scenarios.find((s) => s.id === scenario.id);
  const row: ManifestScenario = {
    domain: scenario.domain,
    id: scenario.id,
    contentHash: scenario.contentHash,
    title: scenario.title,
    tags: [...scenario.tags],
    verdict: scenario.verdict,
    reason: scenario.reason,
    // Conditional, not `createdDate: undefined`: `exactOptionalPropertyTypes` is
    // on, and a spread of an explicit undefined is a different type from absent.
    ...(scenario.createdDate !== undefined ? { createdDate: scenario.createdDate } : {}),
  };
  if (existing) Object.assign(existing, row);
  else manifest.scenarios.push(row);
}

/** Manifest path persisted repo-relative; used only for display. */
export function manifestPathForDisplay(): string {
  return joinRepo(MANIFEST_PATH);
}

/**
 * List all domain scenario files. Returns repo-relative POSIX paths.
 * File name (minus .txt) is the domain key — see domain-map.ts. The orchestrator
 * never names features; identity comes from these filenames plus the map.
 */
export async function listScenarioFiles(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const dir = rehydrate('scenarios');
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.txt'))
    .map((e) => toRepoRelative(rehydrate(joinRepo('scenarios', e.name))));
}

/** Extract domain key from a scenario file path: basename minus .txt, lowercased. */
export function domainKeyOf(scenarioFile: string): string {
  const base = scenarioFile.split('/').pop() ?? scenarioFile;
  return base.replace(/\.txt$/i, '').toLowerCase();
}
