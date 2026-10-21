/**
 * The human-readable answer to "what just happened?".
 *
 * Three artifacts come out of a run, and they are not interchangeable:
 *   - `manifest.json`  — the machine record that threads stages together
 *   - `run-report.json`— the redacted audit trail (stage outputs, verbatim)
 *   - `summary.md`     — THIS. What a person reads.
 *
 * Both renderers read `RunManifest.scenarios`, where every row carries its own
 * verdict and reason next to its title. Nothing here joins a hash-keyed map
 * against anything, because that join is what made the old output unreadable:
 * "11 scenarios: held 10, covered 1" tells you nothing about YOUR testcase.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rehydrate } from '../util/paths.js';
import {
  scenariosForDomain,
  type DigestVerdict,
  type ManifestScenario,
  type RunManifest,
} from '../scenario/manifest.js';
import type { RunReport } from './run-report.js';

const SUMMARY_PATH = 'artifacts/run/summary.md';

/**
 * What the summary needs to know about a run's locator repairs. Structurally this is
 * `HealReport` (`src/runtime/heal-manifest.ts`), restated minimally here so the
 * renderer does not reach into the runtime layer.
 */
export interface HealStory {
  heals: ReadonlyArray<{
    file: string;
    brokenLocator: string;
    healedLocator: string;
    observed: string;
    tests: readonly string[];
    outcome: string;
  }>;
  refusals: ReadonlyArray<{
    brokenLocator: string;
    reason: string;
    detail: string;
    tests: readonly string[];
    outcome: string;
  }>;
}

/** Verdict → the words a person reads. */
const VERDICT_LABEL: Record<DigestVerdict, string> = {
  generated: 'generated',
  held: 'kept',
  covered: 'skipped (already covered)',
  unbuildable: 'blocked',
};

/** The short word used in the per-scenario list, where width matters. */
const SHORT_LABEL: Record<DigestVerdict, string> = {
  generated: 'generated',
  held: 'kept',
  covered: 'covered',
  unbuildable: 'blocked',
};

/** One line that explains the verdict words. Printed once, above the list. */
const LEGEND =
  '(kept = the existing test block was reused · covered = no test written, an existing test already covers it · blocked = the page object cannot express it yet)';

const VERDICT_ORDER: readonly DigestVerdict[] = ['generated', 'held', 'covered', 'unbuildable'];

function tallyVerdicts(
  manifest: RunManifest,
  domain?: string,
): Record<DigestVerdict, number> {
  const rows = domain ? scenariosForDomain(manifest, domain) : manifest.scenarios;
  const tally: Record<DigestVerdict, number> = {
    generated: 0,
    held: 0,
    covered: 0,
    unbuildable: 0,
  };
  for (const r of rows) if (r.verdict) tally[r.verdict]++;
  return tally;
}

/** "10 kept · 1 skipped (already covered) · 0 generated · 0 blocked" */
export function verdictCounts(manifest: RunManifest, domain?: string): string {
  const t = tallyVerdicts(manifest, domain);
  return VERDICT_ORDER.filter((v) => t[v] > 0)
    .map((v) => `${t[v]} ${VERDICT_LABEL[v]}`)
    .join(' · ');
}

/** One domain, one line per scenario, in scenario order. Stage 2's output. */
export function renderDigestSummary(manifest: RunManifest, domain: string): string {
  const rows = scenariosForDomain(manifest, domain);
  const headline = `${domain} — ${rows.length} scenario(s): ${verdictCounts(manifest, domain) || 'none'}`;
  if (rows.length === 0) return headline;
  const lines = [headline, LEGEND, ''];
  for (const [i, row] of rows.entries()) {
    const label = SHORT_LABEL[row.verdict ?? 'held'];
    lines.push(`  ${String(i + 1).padStart(2)}. ${label.padEnd(10)} ${row.title}`);
    if (warrantsReason(row)) {
      lines.push(`      ${' '.repeat(10)} ↳ ${truncate(row.reason!, 200)}`);
    }
  }
  return lines.join('\n');
}

/** The whole run: what happened, per domain, what needs attention, the stages. */
export function renderRunSummary(
  manifest: RunManifest,
  report: RunReport,
  heals?: HealStory,
): string {
  const lines: string[] = [];
  const seconds = (report.durationMs / 1000).toFixed(1);
  const when = manifest.startedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z');

  lines.push(`# Run ${manifest.runId} — ${report.outcome} · ${seconds}s`);
  lines.push('');
  lines.push(`Started ${when}${manifest.sourcePR !== null ? ` · PR #${manifest.sourcePR}` : ''}`);
  lines.push('');

  // --- What happened -------------------------------------------------------
  lines.push('## What happened');
  lines.push('');
  if (manifest.scenarios.length === 0) {
    lines.push('No scenarios were digested.');
  } else {
    lines.push(`${manifest.scenarios.length} scenario(s): ${verdictCounts(manifest)}`);
    lines.push('');
    lines.push(narrative(manifest));
  }
  lines.push('');

  // --- Per domain ----------------------------------------------------------
  for (const d of manifest.domains) {
    const rows = scenariosForDomain(manifest, d.domain);
    lines.push(`## ${d.domain}`);
    lines.push('');
    if (rows.length === 0) {
      lines.push('No scenarios recorded for this domain.');
    } else {
      for (const row of rows) lines.push(...scenarioLines(row));
    }
    const facts = domainFacts(manifest, d);
    if (facts.length > 0) {
      lines.push('');
      lines.push(facts.join(' · '));
    }
    const narrowing = narrowingNote(manifest, d);
    if (narrowing !== null) {
      lines.push('');
      lines.push(narrowing);
    }
    lines.push('');
  }

  // --- Needs attention -----------------------------------------------------
  const attention = attentionLines(manifest);
  lines.push('## Needs attention');
  lines.push('');
  if (attention.length === 0) {
    lines.push('Nothing — every scenario either has a test or is covered by one.');
  } else {
    for (const a of attention) lines.push(`- ${a}`);
  }
  lines.push('');

  // --- Locator heals -------------------------------------------------------
  // A repair is an intervention worth seeing: the test would have failed on the
  // locator the app drifted from, and passed on the one the healer found. A plain
  // "11 passed" hides that — and it hides it worst when the repair did NOT work,
  // because then the run is red *because of* the healer, not the app.
  if (heals !== undefined && (heals.heals.length > 0 || heals.refusals.length > 0)) {
    lines.push('## Locator heals');
    lines.push('');
    lines.push(
      'A locator the app drifted from is repaired at runtime, and folded into the source afterwards only when a test passed on the repair. The assertion that used it is what says whether the repair was any good.',
    );
    lines.push('');
    for (const h of heals.heals) {
      lines.push(`- \`${h.brokenLocator}\` → \`${h.healedLocator}\` in \`${h.file}\` — ${healOutcome(h)}`);
    }
    for (const r of heals.refusals) {
      lines.push(
        `- refused to heal \`${r.brokenLocator}\` (${r.reason}) — ${r.detail}; ${refusalFate(r)}`,
      );
    }
    lines.push('');
  }

  // --- Stages --------------------------------------------------------------
  lines.push('## Stages');
  lines.push('');
  for (const s of manifest.stages) {
    const time = s.durationMs === undefined ? '' : ` · ${(s.durationMs / 1000).toFixed(1)}s`;
    lines.push(`- \`${s.name}\` — **${s.status}**${time}`);
    for (const reason of s.degradation ?? []) lines.push(`  - ⚠ ${reason}`);
  }
  lines.push('');

  return lines.join('\n');
}

export async function saveSummary(markdown: string): Promise<void> {
  const path = rehydrate(SUMMARY_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, 'utf8');
}

export function summaryPath(): string {
  return SUMMARY_PATH;
}

// --- internals ---------------------------------------------------------------

function scenarioLines(row: ManifestScenario): string[] {
  const out = [`- **${row.title}** — ${VERDICT_LABEL[row.verdict ?? 'held']}`];
  if (warrantsReason(row)) out.push(`  - ${truncate(row.reason!, 240)}`);
  return out;
}

/**
 * Does this verdict need its reason printed? Only when the verdict is
 * *surprising* and the reason is the answer to "why?". `held` and `generated`
 * are self-explanatory — printing "scenario text unchanged" ten times buries the
 * one line that matters (a scenario that produced no test).
 */
function warrantsReason(row: ManifestScenario): boolean {
  return (
    typeof row.reason === 'string' &&
    row.reason.length > 0 &&
    (row.verdict === 'covered' || row.verdict === 'unbuildable')
  );
}

/** The one-paragraph plain-English reading of the verdict counts. */
function narrative(manifest: RunManifest): string {
  const t = tallyVerdicts(manifest);
  const parts: string[] = [];
  if (t.generated > 0) parts.push(`${t.generated} new test(s) were written.`);
  if (t.held > 0) parts.push(`${t.held} scenario(s) matched their existing test block and were left alone.`);
  if (t.covered > 0) {
    parts.push(
      `${t.covered} scenario(s) produced NO test because the classifier judged them already covered by an existing test — see the reason under each one below.`,
    );
  }
  if (t.unbuildable > 0) {
    parts.push(
      `${t.unbuildable} scenario(s) are blocked: the page objects cannot express them yet, so they were written as work orders.`,
    );
  }
  if (t.generated === 0 && t.unbuildable === 0 && manifest.scenarios.length > 0) {
    parts.push('Nothing was generated this run.');
  }
  return parts.join(' ');
}

/**
 * The narrowing, spelled out — read from the grep that actually ran, not from a
 * restatement of the scope rules.
 *
 * A filter that omits tests silently is the failure this whole report exists to
 * prevent: "9 passed" reads as "everything passed" unless the report also says what
 * did not run. The one thing the note must not do is disagree with the filter, so it
 * describes the grep itself — the artifact stage 6 was handed — rather than a second
 * copy of the tier→tag mapping that can drift from it.
 */
function narrowingNote(
  manifest: RunManifest,
  d: RunManifest['domains'][number],
): string | null {
  // A human's TEST_GREP won outright: it was the whole filter, the agent was never
  // consulted and the floor was not applied. It still gets a note — "absolute in
  // effect" was never meant to mean "silent" — and the note names the one thing that
  // is genuinely dangerous here: a test THIS RUN WROTE that the override left out.
  if (manifest.grepOverride !== null) return overrideNote(manifest, d, manifest.grepOverride);
  if (d.tier === null || d.tier === 'regression') return null;
  const grep = d.grep ?? '';
  if (grep === '') return null;
  let re: RegExp;
  try {
    re = new RegExp(grep, 'i');
  } catch {
    // A malformed grep is not this renderer's to report — the stage record has it.
    return null;
  }
  const inScope = (s: ManifestScenario): boolean =>
    re.test(s.title) || s.tags.some((t) => re.test(t));
  const excluded = scenariosForDomain(manifest, d.domain).filter((s) => !inScope(s));
  const excludedTags = [...new Set(excluded.flatMap((s) => s.tags))];
  return [
    `**Narrowed run** — scope \`${d.tier}\` runs tests matching \`${grep}\`.`,
    excluded.length === 0
      ? 'No scenario falls outside it.'
      : `${excluded.length} scenario(s) tagged ${excludedTags.join(', ') || '(none)'} are NOT run.`,
    'Tests carrying no tier tag are not run either — except the ones generated in this run, which always run.',
  ].join(' ');
}

/**
 * The note for a run whose filter a human supplied. It must not read like a planned
 * scope: a reader six months later who sees `grep: @smoke` would otherwise assume the
 * agent chose it, and would not know the floor was off.
 */
function overrideNote(
  manifest: RunManifest,
  d: RunManifest['domains'][number],
  grep: string,
): string {
  const rows = scenariosForDomain(manifest, d.domain);
  let excluded: ManifestScenario[] = [];
  if (grep !== '') {
    try {
      const re = new RegExp(grep, 'i');
      excluded = rows.filter((s) => !(re.test(s.title) || s.tags.some((t) => re.test(t))));
    } catch {
      // A grep Playwright will reject anyway; report the override, not the detail.
      excluded = [];
    }
  }
  const excludedTags = [...new Set(excluded.flatMap((s) => s.tags))];
  // The floor is off on an override, so this is reachable — and it is the outcome the
  // floor exists to prevent, which is exactly why an operator gets told.
  const writtenAndSkipped = excluded.filter((s) => s.verdict === 'generated');
  return [
    `**Human override** — \`TEST_GREP\` supplied the filter ${grep === '' ? '`(none — the full suite)`' : `\`${grep}\``}; the planner agent was not consulted and the floor was not applied.`,
    excluded.length === 0
      ? 'No scenario falls outside it.'
      : `${excluded.length} scenario(s) tagged ${excludedTags.join(', ') || '(none)'} are NOT run.`,
    writtenAndSkipped.length === 0
      ? ''
      : `**${writtenAndSkipped.length} test(s) written by THIS run are excluded by the override: ${writtenAndSkipped
          .map((s) => `"${s.title}"`)
          .join(', ')}.**`,
  ]
    .filter((l) => l.length > 0)
    .join(' ');
}

/**
 * The scope a run covered, and what its filter left out — for a report that is not this
 * summary: the PR body stage 8 opens. It reuses `domainFacts` and `narrowingNote` rather
 * than restating the tier→tag rules, because a PR body that quietly disagrees with the
 * summary is the same silent smaller-green in a different medium. `artifacts/` is
 * gitignored, so for a reviewer the PR body is the only place this can be read.
 */
export function scopeCoverageLines(manifest: RunManifest): string[] {
  const out: string[] = [];
  for (const d of manifest.domains) {
    const facts = domainFacts(manifest, d).filter((f) => /^(scope|tier|grep):/.test(f));
    if (facts.length > 0) out.push(`- \`${d.domain}\` — ${facts.join(' · ')}`);
    const note = narrowingNote(manifest, d);
    if (note !== null) out.push(`- ${note}`);
  }
  return out;
}

function domainFacts(manifest: RunManifest, d: RunManifest['domains'][number]): string[] {
  const facts: string[] = [];
  if (manifest.grepOverride !== null) facts.push('scope: **human override**');
  else if (d.tier !== null) facts.push(`tier: **${d.tier}**`);
  if (d.grep !== null) facts.push(`grep: ${d.grep === '' ? '`(full suite)`' : `\`${d.grep}\``}`);
  if (d.builder !== null) facts.push(`builder: ${d.builder}`);
  if (d.playwright !== null) {
    facts.push(
      `playwright: ${d.playwright.passed} passed, ${d.playwright.failed} failed, ${d.playwright.flaky} flaky`,
    );
  }
  if (d.healApply !== null) facts.push(`heal-apply: ${d.healApply}`);
  return facts;
}

function attentionLines(manifest: RunManifest): string[] {
  const out: string[] = [];
  for (const s of manifest.stages) {
    if (s.status === 'failed') out.push(`stage \`${s.name}\` **failed** — \`artifacts/run/run-report.json\` has its output`);
  }
  for (const d of manifest.domains) {
    for (const u of d.unbuildable) {
      out.push(
        `**${d.domain}**: "${u.scenario.title}" is blocked — add to the page object: ${u.missingCapabilities.join(', ')}`,
      );
    }
  }
  return out;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** "it saw resolved to 0 elements; verified — test "X" passed on the repaired locator" */
function healOutcome(h: HealStory['heals'][number]): string {
  const observed = `it saw ${h.observed}`;
  if (h.outcome === 'test-passed') {
    return `${observed}; **verified** — ${whoUsedIt(h.tests, 'used')} passed on the repaired locator`;
  }
  if (h.outcome === 'test-failed') {
    return `${observed}; ⚠ **not verified** — ${whoUsedIt(h.tests, 'used')} FAILED on the repaired locator`;
  }
  return `${observed}; **unverified** — no finished test used the repair`;
}

/** Whether the test that hit a refusal went red on it, or sailed past it. */
function refusalFate(r: HealStory['refusals'][number]): string {
  if (r.outcome === 'test-failed') return `⚠ ${whoUsedIt(r.tests, 'hit')} FAILED — this is where it broke`;
  if (r.outcome === 'test-passed') return `${whoUsedIt(r.tests, 'hit')} passed anyway`;
  return 'no finished test hit it';
}

function whoUsedIt(tests: readonly string[], verb: string): string {
  const first = tests[0];
  if (first === undefined) return `the test that ${verb} it`;
  return tests.length === 1
    ? `test "${first}"`
    : `test "${first}" (of ${tests.length} that ${verb} it)`;
}
