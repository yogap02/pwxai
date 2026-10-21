/**
 * Self-healing fixture. A spec that imports `test` from here gets a run whose
 * page carries a heal collector: a page object that resolves a locator through
 * `attemptHeal` (heal-locator.ts) can survive a locator that the app has drifted
 * away from, and the heal is recorded for stage 7 to fold into the source.
 *
 * Import it INSTEAD of `@playwright/test`:
 *
 *   import { test } from '../../src/runtime/self-heal-fixture.js';
 *
 * The `page` override is the whole wiring: it attaches the worker's collector to
 * the page (a WeakMap in heal-locator.ts) rather than threading a `healing`
 * argument through every page object and every generated test block. A spec that
 * imports plain `@playwright/test` simply heals nothing — the POM falls back to
 * a plain `page.locator`, which is why healing is additive, not load-bearing.
 *
 * One worker = one collector, saved at worker teardown — and a run is NOT one worker.
 * Playwright restarts the worker after a failing test, so a run with a single failure
 * has two collectors, and the second teardown would erase the first one's records.
 * `HealManifest.save` therefore merges within a run (named by `HEAL_RUN_ID`, or by the
 * parent process for a bare `npm test`) and replaces anything a previous run left.
 * Before that, a run that had a failure lost exactly the heals it most needed to
 * report — silently, which is why it went unnoticed.
 *
 * The two hooks below are why a heal is NOT silent: they tell the collector which
 * test is running (`beginTest`) and how it ended (`endTest`). A repair is a claim
 * about an element, and the assertion that used it is the only thing that can
 * settle that claim — a test that passed on the repaired locator is evidence for
 * it, a test that failed is evidence against. Without the outcome, a healed pass
 * looks exactly like a healthy one.
 *
 * And the outcome is announced where a person can see it, not only in `heals.json`:
 * a repaired test carries a `heal` annotation (shown in the HTML report and the
 * trace viewer), and the worker prints what it healed at teardown. A green test that
 * only passed because a locator was repointed should say so.
 */

import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { HealManifest, healReportLines, healNote, refusalNote } from './heal-manifest.js';
import { attachHealing } from './heal-locator.js';

export const test = base.extend<{ page: Page }, { healing: HealManifest }>({
  healing: [
    async ({}, use) => {
      const manifest = new HealManifest();
      await use(manifest);
      await manifest.save();
      // Say it out loud. A repaired test is otherwise indistinguishable from a healthy
      // one in the only thing a person reads — the console, which says "1 passed" and
      // nothing else — so the healer's work would live solely in a JSON artifact.
      const lines = healReportLines(manifest.records, manifest.refusals);
      if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
    },
    { scope: 'worker' },
  ],
  page: async ({ page, healing }, use) => {
    attachHealing(page, healing);
    await use(page);
  },
});

test.beforeEach(({ healing }, testInfo) => {
  // The describe path and the title. `titlePath` starts with the test file, which
  // is a Windows-or-POSIX path — noise in the report, and platform-dependent in an
  // artifact.
  healing.beginTest(testInfo.titlePath.slice(1).join(' › '));
});

test.afterEach(({ healing }, testInfo) => {
  const touched = healing.endTest(testInfo.status);
  // And put it ON the test, where the HTML report and the trace viewer show it: the
  // console block is one line in a long run, and the report is where a healing gets
  // looked up a day later. Annotations are the runtime-supported way to say it —
  // `testInfo.annotations.push` is documented for exactly this.
  for (const record of touched.heals) {
    testInfo.annotations.push({ type: 'heal', description: healNote(record) });
  }
  for (const refusal of touched.refusals) {
    testInfo.annotations.push({ type: 'heal-refused', description: refusalNote(refusal) });
  }
});

