/**
 * Heal manifest: the three things a run says about locators —
 *
 *   - the REPAIRS it found (broken locator → the locator that resolved);
 *   - whether each repair held (the outcome of the test that used it);
 *   - the heal attempts it REFUSED, why, and whether the test that hit the refusal
 *     went red on it.
 *
 * All three are one story, and the outcome is the part that stops a heal being
 * silent. A repair is a claim ("this locator still addresses the same element"),
 * and the only thing that can settle that claim is the assertion that used it: a
 * test that PASSED on the repaired locator is evidence for it, and a test that
 * FAILED on it is evidence against — the repair did not fix the problem, or fixed
 * the wrong element. Recording the claim without the outcome made a healed pass
 * indistinguishable from a healthy one, which is exactly the silent green this
 * repo is built to avoid.
 *
 * A refusal is not a failure of the healer — refusing is the job: an element that
 * is genuinely gone, a copy written for another locale, two candidates that are a
 * coin toss. Recording why keeps that decision visible, and says which class of
 * locator failure to build for next instead of guessing at heuristics. Its outcome
 * is what separates a refusal that explains a red test from a refusal the test
 * sailed past (a locator that simply rendered late).
 *
 * The fixture stamps test titles and outcomes (`beginTest` / `endTest`); the healer
 * itself never sees a test, which keeps it plain data. Written by the healing
 * fixture at worker teardown, read by stage 7 and by the run summary.
 *
 * Persisted repo-relative POSIX only.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { rehydrate, assertRepoRelativePosix } from '../core/util/paths.js';

export type HealStrategy = 'text-fallback' | 'role-fallback' | 'css-narrowing' | 'attribute';

/**
 * What the TEST that touched this record did — the only thing that settles what the
 * record means. The name is the raw fact; the interpretation is left to the prose,
 * because the same fact reads differently for a repair and a refusal:
 *
 *   test-passed — for a repair: the assertion backed it. For a refusal: the test got
 *                 past the locator anyway (it resolved late, or was never asserted).
 *   test-failed — the test did not pass. For a repair, that is evidence against it.
 *   unknown     — no finished test touched it, so the record is nothing but a claim.
 *
 * The worst outcome across uses wins, because one failing use is enough.
 */
export type TestOutcome = 'test-passed' | 'test-failed' | 'unknown';

export interface HealRecord {
  /** File the broken locator lives in, repo-relative POSIX. */
  file: string;
  /** The locator string that failed to resolve. */
  brokenLocator: string;
  /** The locator string the healer found instead. */
  healedLocator: string;
  /** How the heal was discovered. */
  strategy: HealStrategy;
  /** What the broken locator DID when the healer saw it — the failure half. */
  observed: string;
  /** Titles of the tests that used this repair, first use first. */
  tests: string[];
  /** Worst outcome across those tests. */
  outcome: TestOutcome;
  /** When the heal happened. */
  at: string;
}

export type HealRefusalReason =
  /** Nothing on offer was close enough — no narrower selector, no nearby copy. */
  | 'no-candidate'
  /** Two candidates are indistinguishable; picking either is a coin toss. */
  | 'ambiguous'
  /** A candidate was found but it does not resolve to exactly one element. */
  | 'not-unique'
  /** The copy is written for another locale; healing it would corrupt that locale. */
  | 'locale-mismatch';

export interface HealRefusal {
  /** File the broken locator lives in, repo-relative POSIX. */
  file: string;
  /** The locator string that failed to resolve. */
  brokenLocator: string;
  reason: HealRefusalReason;
  /** What was actually observed — the element count, the candidates, the locales. */
  detail: string;
  /**
   * Titles of the tests that hit this refusal. A refusal is reported either way, and
   * which test hit it is what turns "something was refused" into "this test was red
   * here" or "this test sailed past it".
   */
  tests: string[];
  /** Worst outcome across those tests. */
  outcome: TestOutcome;
  at: string;
}

export interface HealReport {
  /**
   * Which run this file describes. One run is NOT one process: Playwright restarts
   * the worker after a failing test, and each worker builds its own collector — so
   * a save has to MERGE when the file belongs to the same run and REPLACE it
   * otherwise. See `RUN_MARKER`.
   */
  run: string;
  heals: HealRecord[];
  refusals: HealRefusal[];
}

/** What one test touched, handed back by `endTest` so the fixture can announce it. */
export interface TouchedRecords {
  heals: HealRecord[];
  refusals: HealRefusal[];
}

const HEAL_PATH = 'artifacts/run/heals.json';

/**
 * Identifies the run this collector belongs to.
 *
 * Saving as a plain overwrite let the SECOND worker's teardown erase the first
 * worker's repairs: a run with one failing test lost exactly the heals it most
 * needed to report, and said nothing. So a save merges with what is on disk when
 * that belongs to the same run.
 *
 * The stage that runs Playwright names the run (`HEAL_RUN_ID`, from the manifest's
 * run id) because it owns the run boundary. A bare `npm test` has no such owner, so
 * it falls back to the parent process — the test runner that spawns every worker of
 * one invocation, and therefore shared by all of them.
 */
const RUN_MARKER = process.env['HEAL_RUN_ID'] ?? `ppid:${process.ppid}`;

export class HealManifest {
  readonly records: HealRecord[] = [];
  readonly refusals: HealRefusal[] = [];

  /** The test currently running, and which records it has touched. */
  private current: { title: string; heals: number[]; refusals: number[] } | null = null;

  /** Called by the fixture before each test, so records can name their user. */
  beginTest(title: string): void {
    this.current = { title, heals: [], refusals: [] };
  }

  /**
   * Called by the fixture after each test. This is where a record stops being a
   * claim: if the test that used a repaired locator passed, the repair was good
   * enough for that assertion; if it failed, the repair is disproven and must not be
   * reported as a successful heal. Refusals are stamped too, because "a locator was
   * refused" is only alarming next to whether the test that hit it went red. An
   * absent status leaves the outcome `unknown` rather than blaming the locator for
   * something we did not observe.
   *
   * Returns what THIS test touched, so the fixture can say so where a person is
   * looking — an annotation in the report, not only a line in `heals.json`.
   */
  endTest(status: string | undefined): TouchedRecords {
    const current = this.current;
    this.current = null;
    if (current === null) return { heals: [], refusals: [] };
    const stamp = (record: { tests: string[]; outcome: TestOutcome }): void => {
      if (!record.tests.includes(current.title)) record.tests.push(current.title);
      if (status === undefined) return;
      record.outcome = combineOutcome(
        record.outcome,
        status === 'passed' ? 'test-passed' : 'test-failed',
      );
    };
    const heals: HealRecord[] = [];
    for (const index of current.heals) {
      const record = this.records[index];
      if (record === undefined) continue;
      stamp(record);
      heals.push(record);
    }
    const refusals: HealRefusal[] = [];
    for (const index of current.refusals) {
      const record = this.refusals[index];
      if (record === undefined) continue;
      stamp(record);
      refusals.push(record);
    }
    return { heals, refusals };
  }

  add(record: Omit<HealRecord, 'at' | 'tests' | 'outcome'>): void {
    const index = this.records.findIndex((r) => sameHeal(r, record));
    if (index === -1) {
      // One manifest is one run, and a run heals a given broken locator once in any
      // meaningful sense: a page object may resolve the same locator many times (the
      // contact section is resolved once per form field, six times over). Without
      // this, stage 7 applies the first record and "skips" the five identical ones,
      // reporting a failure for a run that actually healed.
      this.records.push({
        ...record,
        tests: [],
        outcome: 'unknown',
        at: new Date().toISOString(),
      });
      this.current?.heals.push(this.records.length - 1);
      return;
    }
    // The same repair, recorded once for stage 7 to apply — but every USE of it is
    // tracked, because the same locator can be resolved in several tests and each
    // one is separate evidence about whether the repair holds.
    this.current?.heals.push(index);
  }

  /** Record a heal attempt that was refused, and why. Deduped like `add`. */
  refuse(refusal: Omit<HealRefusal, 'at' | 'tests' | 'outcome'>): void {
    const index = this.refusals.findIndex((r) => sameRefusal(r, refusal));
    if (index >= 0) {
      this.current?.refusals.push(index);
      return;
    }
    this.refusals.push({ ...refusal, tests: [], outcome: 'unknown', at: new Date().toISOString() });
    this.current?.refusals.push(this.refusals.length - 1);
  }

  async save(): Promise<void> {
    const path = rehydrate(HEAL_PATH);
    await mkdir(dirname(path), { recursive: true });
    const mine: HealReport = { run: RUN_MARKER, heals: this.records, refusals: this.refusals };
    // Merge with the run's earlier workers, replace anything left by an earlier run.
    // A worker whose collector is empty still writes: "this run recorded nothing" is
    // a fact worth persisting, and it is how a stale file from a previous run stops
    // being read as this run's heals.
    const existing = await readExistingReport(path);
    const report =
      existing !== null && existing.run === RUN_MARKER ? mergeReports(existing, mine) : mine;
    await writeFile(path, JSON.stringify(report, null, 2), 'utf8');
  }

  static async loadReport(): Promise<HealReport> {
    let text: string;
    try {
      text = await readFile(rehydrate(HEAL_PATH), 'utf8');
    } catch (err) {
      // NO manifest is the normal case: nothing healed this run.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { run: '', heals: [], refusals: [] };
      }
      throw err;
    }
    // A manifest that exists but does not parse — or that records an absolute
    // path — is a DEFECT, not an empty run. Catching it here turned the repo's
    // strictest invariant ("never persist an absolute path") into "no heals this
    // run", silently, on the one file the healer is judged by.
    const parsed: unknown = JSON.parse(text);
    // An array is the pre-diagnostics shape of this file. Reading it costs one
    // line and keeps the artifact from becoming a crash on an old checkout.
    const report: HealReport = Array.isArray(parsed)
      ? { run: '', heals: parsed as HealRecord[], refusals: [] }
      : (parsed as HealReport);
    report.run ??= '';
    for (const r of report.heals) {
      assertRepoRelativePosix(r.file, 'heal record .file');
      // A record written before outcomes existed proves nothing, so it reads as
      // unverified rather than as a success. `unknown` is the honest answer, and
      // the report treats it as such.
      r.observed ??= '';
      r.tests ??= [];
      r.outcome = normaliseOutcome(r.outcome);
    }
    for (const r of report.refusals) {
      assertRepoRelativePosix(r.file, 'heal refusal .file');
      // Same reasoning as a heal record: a refusal written before the outcome
      // existed says nothing about the test that hit it.
      r.tests ??= [];
      r.outcome = normaliseOutcome(r.outcome);
    }
    return report;
  }

  /** The heals alone — what stage 7 folds into the source. */
  static async load(): Promise<HealRecord[]> {
    return (await HealManifest.loadReport()).heals;
  }
}

/**
 * Union of two reports from the same run, earliest first. A repair recorded by two
 * workers is one repair, so identity decides uniqueness — and the WORSE outcome
 * wins, because one failing use is enough to disprove it.
 */
export function mergeReports(earlier: HealReport, later: HealReport): HealReport {
  return {
    run: later.run,
    heals: mergeHeals(earlier.heals, later.heals),
    refusals: mergeRefusals(earlier.refusals, later.refusals),
  };
}

function mergeHeals(earlier: readonly HealRecord[], later: readonly HealRecord[]): HealRecord[] {
  const out = earlier.map((r) => ({ ...r }));
  for (const record of later) {
    const index = out.findIndex((r) => sameHeal(r, record));
    if (index === -1) {
      out.push({ ...record });
      continue;
    }
    const existing = out[index];
    if (existing === undefined) continue;
    existing.tests = [...existing.tests, ...record.tests.filter((t) => !existing.tests.includes(t))];
    existing.outcome = combineOutcome(existing.outcome, record.outcome);
  }
  return out;
}

function mergeRefusals(
  earlier: readonly HealRefusal[],
  later: readonly HealRefusal[],
): HealRefusal[] {
  const out = earlier.map((r) => ({ ...r }));
  for (const refusal of later) {
    const index = out.findIndex((r) => sameRefusal(r, refusal));
    if (index === -1) {
      out.push({ ...refusal });
      continue;
    }
    const existing = out[index];
    if (existing === undefined) continue;
    existing.tests = [...existing.tests, ...refusal.tests.filter((t) => !existing.tests.includes(t))];
    existing.outcome = combineOutcome(existing.outcome, refusal.outcome);
  }
  return out;
}

/**
 * Combine two outcomes. `unknown` means "nobody said", so it yields to whatever the
 * other side knows; `test-failed` beats `test-passed`, because one failing use is
 * enough to disprove a repair.
 */
export function combineOutcome(a: TestOutcome, b: TestOutcome): TestOutcome {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return a === 'test-failed' || b === 'test-failed' ? 'test-failed' : 'test-passed';
}

/**
 * Normalise an outcome on read. `verified` is this field's earlier name: it reads as
 * `test-passed` rather than as `unknown`, so a repair a passing test backed is not
 * silently downgraded to "unproven" because the wording changed. Anything else
 * unrecognised is `unknown` — an outcome we cannot read is not evidence.
 */
export function normaliseOutcome(value: string | undefined): TestOutcome {
  if (value === 'test-passed' || value === 'test-failed' || value === 'unknown') return value;
  return value === 'verified' ? 'test-passed' : 'unknown';
}

/** What makes two records the same repair: the identifiers, not the fate. */
export type HealIdentity = Pick<HealRecord, 'file' | 'brokenLocator' | 'healedLocator' | 'strategy'>;

export function sameHeal(a: HealIdentity, b: HealIdentity): boolean {
  return (
    a.file === b.file &&
    a.brokenLocator === b.brokenLocator &&
    a.healedLocator === b.healedLocator &&
    a.strategy === b.strategy
  );
}

/** What makes two refusals the same refusal: why, and against what. */
type RefusalIdentity = Pick<HealRefusal, 'file' | 'brokenLocator' | 'reason' | 'detail'>;
export function sameRefusal(a: RefusalIdentity, b: RefusalIdentity): boolean {
  return (
    a.file === b.file && a.brokenLocator === b.brokenLocator && a.reason === b.reason && a.detail === b.detail
  );
}

/**
 * The report already on disk, or null when there is none to merge with. A file that
 * does not parse is treated as absent: it can only be a leftover, since a same-run
 * file is written by this code.
 */
async function readExistingReport(path: string): Promise<HealReport | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as HealReport;
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.run !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The heal story for the run summary, or `undefined` when the file cannot be read.
 *
 * It does not throw: stage 7 reads this same file on every run and a malformed one
 * has already been recorded as a failed stage with its reason, so throwing here a
 * second time would only take the summary down with it — and the summary is the
 * artifact that explains what happened. An absent or unreadable file therefore
 * omits the section rather than hiding a problem.
 */
export async function healStoryForSummary(): Promise<HealReport | undefined> {
  try {
    return await HealManifest.loadReport();
  } catch {
    return undefined;
  }
}

// --- Saying it out loud -------------------------------------------------------
//
// The records above are worthless in a JSON artifact nobody opens. A repaired test
// is indistinguishable from a healthy one in the two places a person actually looks:
// the console, which prints "1 passed", and the report, which shows an unremarkable
// green test. So the same facts get narrated — the fixture annotates the test and
// prints a block at worker teardown, both from these three functions. They live here
// rather than in the fixture because the fixture cannot be imported outside
// Playwright's test runner (it calls `test.beforeEach` at module scope), which is
// also what makes them self-checkable.

/**
 * One repair, in the words of someone reading "1 passed": what broke, what it was
 * repointed to, and whether the assertion backed it. `test-passed` is the whole
 * point — that is the difference between a green test and a green test *because of*
 * the healer.
 */
export function healNote(record: HealRecord): string {
  const fate =
    record.outcome === 'test-passed'
      ? 'the test passed on it'
      : record.outcome === 'test-failed'
        ? 'the test FAILED on it'
        : 'no finished test used it';
  return `${record.brokenLocator} → ${record.healedLocator} (${fate})`;
}

/** One refusal: what could not be healed, and why. */
export function refusalNote(refusal: HealRefusal): string {
  return `${refusal.brokenLocator} (${refusal.reason}: ${refusal.detail})`;
}

/** The block a run prints for what the healer did. Nothing at all on a clean run. */
export function healReportLines(
  records: readonly HealRecord[],
  refusals: readonly HealRefusal[],
): string[] {
  const lines: string[] = [];
  if (records.length > 0) {
    lines.push(`[self-heal] ${records.length} locator${records.length === 1 ? '' : 's'} repaired:`);
    for (const record of records) lines.push(`  - ${healNote(record)}`);
  }
  if (refusals.length > 0) {
    lines.push(`[self-heal] ${refusals.length} heal attempt${refusals.length === 1 ? '' : 's'} refused:`);
    for (const refusal of refusals) lines.push(`  - ${refusalNote(refusal)}`);
  }
  return lines;
}
