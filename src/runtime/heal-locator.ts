/**
 * Runtime locator healing.
 *
 * A locator that stops resolving is usually a broken *source line*, not a broken
 * app: the app changed and the selector did not. Healing means: resolve the
 * locator, and when it resolves to nothing, try a mechanical candidate. If exactly
 * one candidate resolves, record the heal and use it. Stage 7 folds the record into
 * the source afterwards — never mid-run, because two writers never touch the same
 * lines (the builder adds, the healer repairs).
 *
 * Two things go stale, and each has a healer:
 *   - a CSS selector the app renamed  → narrow the selector that broke;
 *   - copy the app re-worded          → the nearest on-page copy.
 *
 * There is deliberately NO MODEL in this path. A guessed locator that is wrong does
 * not fail — it asserts against the wrong element and passes. An honest failure is
 * worth more than a confident guess.
 *
 * AND THE HEALER IS ALLOWED TO REFUSE. That is the other half of the job: an element
 * that is genuinely gone, a test that is wrong about *timing*, a copy that is
 * correct for another locale, two candidates that are a coin toss — healing any of
 * those would turn a real red into a green lie. Every refusal is recorded with its
 * reason, so the decision is reviewable and the diagnostic tells us which class of
 * failure to build for next.
 *
 * The manifest is carried by the Page (`attachHealing`) rather than passed to
 * every page object and every generated block. One line of wiring in the fixture
 * beats a new constructor argument in every POM the pipeline will ever write.
 */

import type { Locator, Page } from '@playwright/test';
import type { HealManifest, HealRecord } from './heal-manifest.js';
import { dbg } from '../core/util/debug.js';

/** How many trailing qualifiers to strip before giving up on narrowing. */
const MAX_NARROWINGS = 3;

/**
 * How close the copy must be to an on-page string before it is a heal. High on
 * purpose: a heal that lands on the wrong element does not fail, it asserts
 * against the wrong thing and passes.
 */
const COPY_SIMILARITY_FLOOR = 0.85;

/** Two near-identical candidates are a coin toss, not a heal. */
const COPY_AMBIGUITY_MARGIN = 0.05;

// --- CSS selectors -----------------------------------------------------------

export interface HealCandidate {
  selector: string;
  strategy: HealRecord['strategy'];
}

/**
 * Deterministic narrower candidates for a broken selector, best first.
 *
 * Pure: no browser, no I/O. Self-checked in `src/cli/self-checks.ts`, which is
 * the only reason this is separable from `attemptHeal` at all.
 */
export function fallbackCandidates(selector: string): HealCandidate[] {
  const out: HealCandidate[] = [];
  const trimmed = selector.trim();

  // `text("x")` is not a Playwright-JS selector — the intent is the text engine.
  const text = /^text\((["'])(.+)\1\)$/.exec(trimmed);
  if (text?.[2]) {
    out.push({ selector: `text=${JSON.stringify(text[2])}`, strategy: 'text-fallback' });
  }

  // A test-id attribute re-expressed through the engine that owns it.
  const attr = /\[(data-test|data-testid)=(["']).+?\2\]/.exec(trimmed);
  if (attr) {
    const value = /\[(?:data-test|data-testid)=(["'])(.+?)\1\]/.exec(trimmed)?.[2];
    if (value) {
      out.push({
        selector: `[data-testid=${JSON.stringify(value)}]`,
        strategy: 'attribute',
      });
    }
  }

  // Narrowing: drop trailing qualifiers from the right until something resolves.
  // `h1.legacy-hero` → `h1`; `div.a.b` → `div.a` → `div`.
  let current = trimmed;
  for (let i = 0; i < MAX_NARROWINGS; i++) {
    const next = dropLastQualifier(current);
    if (next === null || next === current) break;
    out.push({ selector: next, strategy: 'css-narrowing' });
    current = next;
  }

  // Deduplicate while keeping order, and never offer the selector that just failed.
  const seen = new Set<string>([trimmed]);
  return out.filter((c) => (seen.has(c.selector) ? false : seen.add(c.selector)));
}

/**
 * Try to heal a locator that failed to resolve. Returns the resolved Locator, or
 * null when nothing did — and records why in the manifest, because "the healer saw
 * this break and refused" is exactly what a reviewer of a red run needs to know.
 *
 * A strict-mode violation (the selector now matches two elements) is healed the
 * same way: only by a narrowing that resolves to exactly ONE element. Never by
 * `.first()` — quietly picking one of two matches asserts against whichever came
 * first in the DOM, which is a guess wearing a result.
 *
 * The fast path matters: a healthy selector is returned WITHOUT recording anything.
 * Recording a heal would rewrite a working source line and churn the diff forever.
 */
export async function attemptHeal(
  page: Page,
  manifest: HealManifest,
  sourceFile: string,
  selector: string,
): Promise<Locator | null> {
  const directCount = await countOf(page.locator(selector));
  if (directCount === 1) return page.locator(selector);

  dbg('heal', 'attempt', { file: sourceFile, selector, observed: describeCount(directCount) });
  const candidates = fallbackCandidates(selector);
  for (const candidate of candidates) {
    const locator = page.locator(candidate.selector);
    if ((await countOf(locator)) === 1) {
      manifest.add({
        file: sourceFile,
        brokenLocator: selector,
        healedLocator: candidate.selector,
        strategy: candidate.strategy,
        observed: describeCount(directCount),
      });
      dbg('heal', 'applied', {
        selector,
        healed: candidate.selector,
        strategy: candidate.strategy,
        observed: describeCount(directCount),
      });
      return locator;
    }
  }

  const reason = candidates.length === 0 ? 'no-candidate' : 'not-unique';
  const detail =
    candidates.length === 0
      ? `${describeCount(directCount)}; no narrower selector to try`
      : `${describeCount(directCount)}; ${candidates.length} narrowing candidate(s), none resolved to exactly one`;
  manifest.refuse({
    file: sourceFile,
    brokenLocator: selector,
    reason,
    detail,
  });
  dbg('heal', 'refused', { file: sourceFile, selector, reason, detail });
  return null;
}

// --- Copy: text and accessible names ----------------------------------------

export interface CopyCandidate {
  text: string;
  score: number;
}

export type CopyMatch =
  | { kind: 'match'; best: CopyCandidate }
  /** Nothing on the page is close enough; `nearest` is what came closest. */
  | { kind: 'none'; nearest: CopyCandidate | null }
  /** Two candidates are indistinguishable at this floor. */
  | { kind: 'ambiguous'; best: CopyCandidate; runnerUp: CopyCandidate };

export interface CopyHealTarget {
  /**
   * The copy as a human reads it, e.g. `Macro and Product Photographer`. The POM
   * writes it as a single-quoted literal, so `'<text>'` is the exact fragment
   * stage 7 substitutes in the source — quoted, because a naked fragment like
   * `Contact` also occurs inside assertion messages, and replacing it there would
   * corrupt them.
   */
  text: string;
  /** Build the locator from a copy string: `(t) => page.getByText(t, …)`. */
  build: (copy: string) => Locator;
  /**
   * Path prefix of the locale this copy is written for, e.g. `/en`. Copy is the one
   * thing that is NOT locale-independent: this app serves `/en` and `/id`, and a
   * heal that matched English copy to an Indonesian page would rewrite the POM's
   * copy to Indonesian and break `/en` on the next run. Structure (`section#id`) is
   * shared across locales, so only copy healing carries this guard.
   */
  locale: string;
}

/**
 * Heal a locator identified by COPY rather than by a CSS string — `getByText`, or
 * `getByRole(role, { name })`. These are insensitive to CSS churn and acutely
 * sensitive to copy churn: the app re-words a tagline, or the generated locator
 * carries a typo, and the locator resolves to nothing.
 *
 * The heal is the nearest on-page copy. Deterministic and deliberately timid: it
 * fires only for a single, clearly-nearest candidate that then resolves uniquely,
 * and never across locales.
 */
export async function attemptCopyHeal(
  page: Page,
  manifest: HealManifest,
  sourceFile: string,
  target: CopyHealTarget,
): Promise<Locator | null> {
  const directCount = await countOf(target.build(target.text));
  if (directCount === 1) return target.build(target.text);

  const runLocale = localeOf(page.url());
  dbg('heal', 'attempt', {
    file: sourceFile,
    copy: target.text,
    locale: target.locale,
    runLocale: runLocale ?? '(unknown)',
    observed: describeCount(directCount),
  });
  if (runLocale !== target.locale) {
    // Refuse when we cannot confirm the locale, too: healing the wrong language out
    // of the source is worse than a red test that a human reads.
    const detail = `copy is written for ${target.locale}; this run is in ${runLocale ?? 'an unknown locale'}`;
    manifest.refuse({
      file: sourceFile,
      brokenLocator: `'${target.text}'`,
      reason: 'locale-mismatch',
      detail,
    });
    dbg('heal', 'refused', {
      file: sourceFile,
      copy: target.text,
      reason: 'locale-mismatch',
      detail,
    });
    return null;
  }

  const match = closestCopy(target.text, await leafTexts(page));
  if (match.kind === 'none') {
    const detail =
      match.nearest === null
        ? `${describeCount(directCount)}; the page exposes no copy to compare against`
        : `${describeCount(directCount)}; nearest copy ${quote(match.nearest)} is below the ${COPY_SIMILARITY_FLOOR} floor`;
    manifest.refuse({
      file: sourceFile,
      brokenLocator: `'${target.text}'`,
      reason: 'no-candidate',
      detail,
    });
    dbg('heal', 'refused', { file: sourceFile, copy: target.text, reason: 'no-candidate', detail });
    return null;
  }
  if (match.kind === 'ambiguous') {
    const detail = `${describeCount(directCount)}; ${quote(match.best)} and ${quote(match.runnerUp)} are a coin toss`;
    manifest.refuse({
      file: sourceFile,
      brokenLocator: `'${target.text}'`,
      reason: 'ambiguous',
      detail,
    });
    dbg('heal', 'refused', { file: sourceFile, copy: target.text, reason: 'ambiguous', detail });
    return null;
  }

  const healed = target.build(match.best.text);
  const healedCount = await countOf(healed);
  if (healedCount !== 1) {
    const detail = `${describeCount(directCount)}; nearest copy ${quote(match.best)} still ${describeCount(healedCount)}`;
    manifest.refuse({
      file: sourceFile,
      brokenLocator: `'${target.text}'`,
      reason: 'not-unique',
      detail,
    });
    dbg('heal', 'refused', { file: sourceFile, copy: target.text, reason: 'not-unique', detail });
    return null;
  }

  manifest.add({
    file: sourceFile,
    brokenLocator: `'${target.text}'`,
    healedLocator: `'${match.best.text}'`,
    strategy: 'text-fallback',
    observed: `${describeCount(directCount)}; nearest copy ${quote(match.best)}`,
  });
  dbg('heal', 'applied', {
    copy: target.text,
    healed: match.best.text,
    strategy: 'text-fallback',
    score: Number(match.best.score.toFixed(2)),
    observed: describeCount(directCount),
  });
  return healed;
}

/**
 * The heal policy for copy: the uniquely-nearest candidate, above the floor.
 * Pure, so the policy is self-checked rather than trusted.
 */
export function closestCopy(target: string, candidates: readonly string[]): CopyMatch {
  const ranked = rankCopies(target, candidates);
  const best = ranked[0];
  if (best === undefined || best.score < COPY_SIMILARITY_FLOOR) {
    return { kind: 'none', nearest: best ?? null };
  }
  const runnerUp = ranked[1];
  if (
    runnerUp !== undefined &&
    runnerUp.score >= COPY_SIMILARITY_FLOOR &&
    runnerUp.score > best.score - COPY_AMBIGUITY_MARGIN
  ) {
    return { kind: 'ambiguous', best, runnerUp };
  }
  return { kind: 'match', best };
}

/** Candidates ranked by similarity to the target, best first; the target excluded. */
export function rankCopies(target: string, candidates: readonly string[]): CopyCandidate[] {
  const seen = new Set<string>();
  const ranked: CopyCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate === target || seen.has(candidate)) continue;
    seen.add(candidate);
    ranked.push({ text: candidate, score: similarity(target, candidate) });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

/** Similarity in `[0, 1]`: 1 is identical, measured against the longer string. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/**
 * The locale a URL is serving, as a path prefix (`/en`), or null when the URL says
 * nothing useful (not http, or unparseable). Pure and self-checked.
 */
export function localeOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const first = parsed.pathname.split('/').find((segment) => segment.length > 0);
  return first === undefined ? '/' : `/${first}`;
}

// --- The page carries its heal collector --------------------------------------

const HEALING_BY_PAGE = new WeakMap<Page, HealManifest>();

/** Attach a run's heal collector to its page. Called by the fixture. */
export function attachHealing(page: Page, manifest: HealManifest): void {
  HEALING_BY_PAGE.set(page, manifest);
}

/**
 * The heal collector for a page, when the spec ran through the healing fixture.
 * Undefined for a plain `@playwright/test` spec — page objects then resolve
 * normally, which is why healing is additive rather than load-bearing.
 */
export function healingFor(page: Page): HealManifest | undefined {
  return HEALING_BY_PAGE.get(page);
}

// --- internals ---------------------------------------------------------------

/** Drop the last compound qualifier, or null when there is nothing left to drop. */
function dropLastQualifier(selector: string): string | null {
  const match = /^(.*?)([.#][\w-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?)$/.exec(selector);
  const head = match?.[1];
  if (head === undefined || head.length === 0) return null;
  // Never strip down to a dangling combinator (`div > `).
  if (/[\s>+~]$/.test(head)) return null;
  return head;
}

/** How many elements a locator matches, or -1 when it cannot answer at all. */
async function countOf(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return -1;
  }
}

/**
 * What was observed, in words a reviewer can act on. A strict-mode violation and a
 * missing element are different failures and must not read the same.
 */
function describeCount(count: number): string {
  if (count < 0) return 'did not resolve';
  if (count === 0) return 'resolved to 0 elements';
  if (count === 1) return 'resolved to 1 element';
  return `resolved to ${count} elements (strict mode)`;
}

function quote(candidate: CopyCandidate): string {
  return `"${candidate.text}" (${candidate.score.toFixed(2)})`;
}

/** Text of the page's leaf elements — the atomic strings a locator can address. */
async function leafTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.length > 0) out.add(text);
    }
    return [...out];
  });
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i, ...Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] ?? 0;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        substitution + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
