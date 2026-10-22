/**
 * Self-checks: cheap checks gate expensive spend
 * (pipeline-pattern.md §3, "Cheap checks gate expensive spend").
 *
 * Plain assertions, no browser, seconds to run, executed in CI immediately
 * before the pipeline, in the same command. Selection criterion: write a
 * self-check when the failure would NOT announce itself.
 *
 * Coverage here mirrors the failure modes the pattern doc names:
 *   - path handling across operating systems (never persist absolute)
 *   - cache hit/miss conditions (managed-region hold)
 *   - concurrency invariants (pinned order)
 *   - fail-open behaviour (planner widens, never narrows)
 *   - prompt placeholders still being substituted
 */

import process from 'node:process';
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rehydrate, toRepoRelative, isRepoRelativePosix, assertRepoRelativePosix, joinRepo } from '../core/util/paths.js';
import { parseBlock, parseScenarioFile, hash } from '../core/scenario/parser.js';
import { renderManagedRegion, readManagedRegion, upsertManagedRegion, scaffoldManagedSpec, mergeManagedRegion, stripBlockImports, blockViolations, MANAGED_START, MANAGED_END, type ManagedBlock } from '../core/scenario/managed-region.js';
import { blockCompileErrors, blockSpans, parseTscErrors } from '../core/scenario/compile-guard.js';
import { capabilityGate } from '../ai/classifier.js';
import { repairTruncatedJson, extractJson } from '../ai/model-client.js';
import { substitute } from '../ai/prompts/load.js';
import { planTier } from '../planning/planner.js';
import { loadTiers, parseTiers, TIER_NAMES } from '../planning/tiers.js';
import { newManifest, domainKeyOf, recordScenario, runDateTag, type RunManifest } from '../core/scenario/manifest.js';
import { renderDigestSummary, renderRunSummary } from '../core/orchestration/run-summary.js';
import { buildReport } from '../core/orchestration/run-report.js';
import { collectExistingTitles, digestPath } from '../stages/02-testcase-digest.js';
import { applyScenarioTags, dateTagIn } from '../core/scenario/test-tags.js';
import { applyHeals } from '../runtime/heal-writer.js';
import { repairable } from '../stages/07-heal-apply.js';
import { buildPrBody } from '../delivery/pr-body.js';
import { HealManifest, healNote, refusalNote, healReportLines, type HealRecord } from '../runtime/heal-manifest.js';
import { closestCopy, fallbackCandidates, localeOf, similarity } from '../runtime/heal-locator.js';
import { freshObservationLines, OBSERVATION_HEADING } from '../agent/cdp-builder-stub.js';
import { StageRunner, runStageProcess, type StageSpec } from '../core/orchestration/stage-runner.js';
import { loadDomainMap, instructionFileFor } from '../core/scenario/domain-map.js';
import { mapOrdered } from '../core/util/pool.js';
import { createPool } from '../core/util/pool.js';
import { parseBooleanFlag } from '../core/util/env.js';
import { clampBlock, ellipsize, renderValue } from '../core/util/debug.js';
import { buildLookup, extractPomSurface, type PomSurface } from '../ai/capability-index.js';
import { viewportProfileIn, viewportCapabilityGap, VIEWPORT_MEMBER } from '../core/scenario/viewport.js';
import { findLayoutSpill, type LayoutBox } from '../runtime/viewport.js';
import { redact } from '../core/util/redaction.js';
import { env } from '../core/util/env.js';
import {
  buildReportMessage,
  runStatus,
  sendReportMessage,
  telegramConfig,
  worstLevel,
} from '../delivery/telegram.js';

let passed = 0;
let failed = 0;
const pending: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function check(name: string, fn: () => void | Promise<void>): void {
  pending.push({ name, fn });
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

/** Assert that `fn` throws — used for fail-closed config parsing. */
function assertThrows(fn: () => unknown, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

/**
 * True when a Map hides anywhere in the value. `JSON.stringify` turns a Map into
 * `{}` without error, so a Map in a persisted object is a silent loss of data.
 */
function containsMap(value: unknown): boolean {
  if (value instanceof Map) return true;
  if (Array.isArray(value)) return value.some(containsMap);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsMap);
  }
  return false;
}

// --- Cross-OS path handling -------------------------------------------------

check('rehydrate produces absolute OS path from repo-relative POSIX', () => {
  const abs = rehydrate('scenarios/demo.txt');
  assert(abs.includes('scenarios') && !abs.includes('\\') || process.platform === 'win32', `unexpected separator: ${abs}`);
});

check('toRepoRelative round-trips through rehydrate', () => {
  const abs = rehydrate('tests/demo/demo.spec.ts');
  const rel = toRepoRelative(abs);
  assert(rel === 'tests/demo/demo.spec.ts', `round-trip mismatch: ${rel}`);
  assert(isRepoRelativePosix(rel), `not POSIX repo-relative: ${rel}`);
});

check('toRepoRelative throws on a path outside the repo', () => {
  let threw = false;
  try {
    toRepoRelative(process.platform === 'win32' ? 'C:\\Windows' : '/etc');
  } catch {
    threw = true;
  }
  assert(threw, 'guard did not throw on outside-repo path');
});

check('assertRepoRelativePosix throws on absolute path', () => {
  let threw = false;
  try {
    assertRepoRelativePosix('D:\\abs\\win', 'test');
  } catch {
    threw = true;
  }
  assert(threw, 'guard accepted a Windows absolute path');
});

check('joinRepo always emits forward slashes', () => {
  const joined = joinRepo('src', 'page-objects', 'demo');
  assert(!joined.includes('\\'), `backslash in joined path: ${joined}`);
});

// --- Scenario parser ---------------------------------------------------------

check('parser reads TEST/Tags/Expected/Notes and separates on ---', () => {
  const text = [
    `TEST: Visiting the homepage shows the page title`,
    `Tags: @smoke @demo`,
    `Expected: The page loads and displays a title`,
    `Notes: seed`,
    ``,
    `---`,
    ``,
    `TEST: Root URL responds with HTTP 200`,
    `Tags: @smoke`,
    `Expected: Base URL loads`,
    `Notes: seed`,
  ].join('\n');
  const blocks = parseScenarioFile(text);
  assert(blocks.length === 2, `expected 2 blocks, got ${blocks.length}`);
  assert(blocks[0]!.tags.includes('@smoke'), 'tags not parsed');
  assert(blocks[1]!.title === 'Root URL responds with HTTP 200', 'second block title wrong');
});

check('scenario id is stable across body edits (regeneration keyed on inputs)', () => {
  const a = parseBlock(`TEST: Same title\nTags: x\nExpected: one thing`);
  const b = parseBlock(`TEST: same title.\nTags: y\nExpected: a different thing entirely`);
  if (a === null || b === null) throw new Error('blocks did not parse');
  assert(a.id === b.id, `id should be title-hash stable: ${a.id} vs ${b.id}`);
  assert(a.contentHash !== b.contentHash, 'content hash should differ when body changed');
});

check('domainKeyOf lowercases and strips .txt', () => {
  assert(domainKeyOf('scenarios/CheckOut.txt') === 'checkout', 'mixed-case filename must lowercase');
  assert(domainKeyOf('scenarios/cart.txt') === 'cart', 'plain filename mismatch');
});

// --- Managed regions ---------------------------------------------------------

check('managed region round-trips through render/read', () => {
  const blocks = [
    { scenarioId: hash('t1'), scenarioContentHash: hash('c1'), code: `test('one', () => {});` },
    { scenarioId: hash('t2'), scenarioContentHash: hash('c2'), code: `test('two', () => {});` },
  ];
  const region = renderManagedRegion(blocks);
  assert(region.includes(MANAGED_START) && region.includes(MANAGED_END), 'markers missing');
  const read = readManagedRegion(region);
  assert(read.length === 2, `expected 2 blocks back, got ${read.length}`);
  assert(read[0]!.code === `test('one', () => {});`, `code not round-tripped: ${read[0]!.code}`);
});

check('upsert replaces an existing region without touching handwritten code above', () => {
  const file = [
    `import { test } from '@playwright/test';`,
    `// handwritten, never touched`,
    ``,
    MANAGED_START,
    `old`,
    MANAGED_END,
    `// handwritten below`,
  ].join('\n');
  const next = upsertManagedRegion(file, renderManagedRegion([]));
  assert(next.includes('// handwritten, never touched'), 'handwritten above was touched');
  assert(next.includes('// handwritten below'), 'handwritten below was touched');
  assert(!next.includes('old'), 'old managed content survived a replace');
});

check('mergeManagedRegion holds a block whose scenario inputs are unchanged', () => {
  const existing = [
    { scenarioId: 's1', scenarioContentHash: 'h1', code: 'test("held", () => {});' },
  ];
  const incoming = new Map([['s1', { code: 'test("RESHOULD NOT APPEAR", () => {});', scenarioContentHash: 'h1' }]]);
  const merged = mergeManagedRegion(existing, incoming, ['s1']);
  assert(merged.length === 1, `expected 1 merged block, got ${merged.length}`);
  assert(merged[0]!.code.includes('held'), 'unchanged-input block was regenerated — drift!');
});

check('readManagedRegion parses a region indented inside a describe block', () => {
  // Stage 2 writes the region indented inside test.describe. If the reader only
  // accepts markers at column 0, every block the pipeline wrote is unreadable on
  // the next run and gets silently regenerated — a green report, wrong behaviour.
  const blocks = [
    { scenarioId: hash('t1'), scenarioContentHash: hash('c1'), code: `test('one', () => {});` },
  ];
  const indented = renderManagedRegion(blocks).replace(/^/, '  ').replace(/\n/g, '\n  ');
  const file = ['test.describe("d", () => {', indented, '});'].join('\n');
  const read = readManagedRegion(file);
  assert(read.length === 1, `expected 1 block from indented region, got ${read.length}`);
  assert(read[0]!.scenarioId === hash('t1'), 'scenario id not read back from indented region');
});

check('mergeManagedRegion drops a block absent from incoming', () => {
  // Pins the contract stage 2 must honour: held blocks have to be carried into
  // `incoming`, or they are deleted rather than held.
  const existing = [
    { scenarioId: 's1', scenarioContentHash: 'h1', code: 'held' },
    { scenarioId: 's2', scenarioContentHash: 'h2', code: 'also held' },
  ];
  const merged = mergeManagedRegion(existing, new Map(), ['s1', 's2']);
  assert(merged.length === 0, `expected 0 blocks when incoming is empty, got ${merged.length}`);
});

check('mergeManagedRegion regenerates when content hash moved', () => {
  const existing = [
    { scenarioId: 's1', scenarioContentHash: 'h1', code: 'old code' },
  ];
  const incoming = new Map([['s1', { code: 'new code', scenarioContentHash: 'h2' }]]);
  const merged = mergeManagedRegion(existing, incoming, ['s1']);
  assert(merged[0]!.code === 'new code', 'changed-input block was not regenerated');
});

check('a generated block never carries an import into the managed region', async () => {
  // The generator was handed the spec's conventions and re-emitted the spec's own
  // imports as part of "the block". An import inside the region — which lives in a
  // test.describe() body — is a syntax error that takes the WHOLE spec file down,
  // handwritten tests included. The generator is told not to emit one; this is the
  // code that makes it true.
  const withImports = [
    `import { test } from '../../src/runtime/self-heal-fixture.js';`,
    `import { LandingPage } from '../../src/page-objects/landing-page/index.js';`,
    ``,
    `test('T', { tag: ['@core'] }, async ({ page }) => {`,
    `  const landing = new LandingPage(page);`,
    `  await landing.goto();`,
    `});`,
  ].join('\n');
  const stripped = stripBlockImports(withImports);
  assert(stripped.removed === 2, `both declarations must be counted, got ${stripped.removed}`);
  assert(!/^\s*import\b/m.test(stripped.code), `no import may survive:\n${stripped.code}`);
  assert(stripped.code.startsWith(`test('T'`), 'the leading blank line must be trimmed');
  assert(stripped.code.endsWith('});'), 'the test body must survive intact');

  // A wrapped declaration is one import, and it must not swallow the test body.
  const wrapped = [
    `import {`,
    `  test,`,
    `} from '@playwright/test';`,
    `test('W', async ({ page }) => {});`,
  ].join('\n');
  const wrappedOut = stripBlockImports(wrapped);
  assert(wrappedOut.removed === 1, `a wrapped import is one declaration, got ${wrappedOut.removed}`);
  assert(wrappedOut.code === `test('W', async ({ page }) => {});`, `wrapped import mishandled:\n${wrappedOut.code}`);

  // An unterminated declaration must not eat the test that follows it.
  const broken = `import {\ntest('B', async ({ page }) => {});`;
  assert(
    stripBlockImports(broken).code.includes(`test('B'`),
    'an unterminated import must not swallow the test',
  );

  // A dynamic import is not a declaration and must be left alone.
  const dynamic = `test('D', async () => {\n  const m = await import('x');\n});`;
  assert(stripBlockImports(dynamic).removed === 0, 'a dynamic import is not a top-level declaration');
  assert(stripBlockImports(dynamic).code === dynamic, 'a block with no import is byte-identical');

  // The strip must be WIRED into the region write, or the next generated block
  // reintroduces exactly the file-breaking import this guard exists to stop.
  const src = stripComments(await readFile(rehydrate('src/stages/02-testcase-digest.ts'), 'utf8'));
  assert(
    /stripBlockImports\(/.test(src),
    'stage 2 must strip imports on the way into the managed region',
  );
});

check('no managed region on disk carries an import', async () => {
  // The failure this catches was real: a generated block held the spec's imports
  // inside test.describe() and tsc refused the whole file (TS1232). The strip
  // repairs it on the next digest, so this is also where that repair is visible.
  const specs = await listRepoFiles('tests', (f) => f.endsWith('.spec.ts'));
  assert(specs.length > 0, 'there must be at least one spec to check');
  const offenders: string[] = [];
  for (const file of specs) {
    const blocks = readManagedRegion(await readFile(rehydrate(file), 'utf8'));
    if (blocks.some((b) => stripBlockImports(b.code).removed > 0)) offenders.push(file);
  }
  assert(
    offenders.length === 0,
    `an import inside the managed region is a syntax error for the whole file: ${offenders.join(', ')}`,
  );
});

check('a spec imports the page-object class its generated blocks instantiate', async () => {
  // The second half of the same regenerate bug, and the one the import strip made
  // MORE visible: deleting a spec and regenerating scaffolded a fresh file that
  // imported only the healing fixture, so every block's `new LandingPage(page)`
  // was an undefined name — TS2552 for the whole file. A block may only use what
  // the spec imports, and the class name and its directory live in the domain map,
  // so this is checkable rather than a convention.
  const map = await loadDomainMap();
  assert(map.size > 0, 'there must be at least one mapped domain to check');
  const offenders: string[] = [];
  for (const [key, entry] of map) {
    const spec = `${entry.specDir}/${key}.spec.ts`;
    const src = await readFile(rehydrate(spec), 'utf8').catch(() => null);
    if (src === null) continue; // no spec written yet — nothing to check
    const regionCode = readManagedRegion(src)
      .map((b) => b.code)
      .join('\n');
    if (!new RegExp(`new\\s+${entry.className}\\s*\\(`).test(regionCode)) continue;
    if (!new RegExp(`import\\b[^;]*\\b${entry.className}\\b[^;]*from\\s*['"]`).test(src)) {
      offenders.push(`${spec} (instantiates ${entry.className} but never imports it)`);
    }
  }
  assert(
    offenders.length === 0,
    `a generated block instantiates a class the spec never imports: ${offenders.join(', ')}`,
  );
});

check('the generator is given member signatures, so a call can supply its arguments', async () => {
  // The capability list was names only, so `expectHeroCtaTargets(href: string)`
  // read like a zero-argument assertion; a generated block called it with none and
  // the whole spec failed to compile (TS2554). A name alone is not a callable
  // contract. The classifier keeps bare names on purpose — it answers with names,
  // which are matched against the surface, so a signature there would gate every
  // claim as missing.
  const surface: PomSurface = {
    file: 'src/page-objects/x/index.ts',
    methods: new Set(['goto', 'expectHeroCtaTargets']),
    properties: new Set(),
    locators: new Set(),
    params: new Map([['expectHeroCtaTargets', 'href: string']]),
  };
  const lookup = buildLookup([surface]);
  assert(lookup.has('expectHeroCtaTargets'), 'the name-gate must still match the method');
  assert(
    lookup.all().join(',') === 'expectHeroCtaTargets,goto',
    `all() must stay bare names: ${lookup.all().join(',')}`,
  );
  assert(
    lookup.catalog().includes('expectHeroCtaTargets(href: string)'),
    `the catalog must carry the parameter list: ${lookup.catalog().join(', ')}`,
  );
  assert(lookup.catalog().includes('goto'), 'a member with no parameters stays bare');

  // Over every real page object: a hint is either a clean parameter list or is
  // absent. `dbg(...)` is a call inside a method body that starts a line, and
  // `byCopy(text, build: (copy) => Locator)` stops at the first inner `)`. Both
  // used to reach the model as a contract that is not one — a wrong hint is worse
  // than no hint, because the model will satisfy it exactly.
  const poms = await listRepoFiles('src/page-objects', (f) => f.endsWith('.ts'));
  const junk: string[] = [];
  for (const pom of poms) {
    for (const member of buildLookup([await extractPomSurface(pom)]).catalog()) {
      const open = member.indexOf('(');
      if (open === -1) continue;
      if (!/^\([^()'"]*\)$/.test(member.slice(open))) junk.push(`${pom}: ${member}`);
      if (member.startsWith('dbg(')) junk.push(`${pom}: dbg is a call, not a capability`);
    }
  }
  assert(junk.length === 0, `a member hint must not carry junk: ${junk.join(' | ')}`);

  // And stage 2 must hand the catalog to the generator, or the signatures never
  // reach the prompt that writes the call.
  const src = stripComments(await readFile(rehydrate('src/stages/02-testcase-digest.ts'), 'utf8'));
  assert(
    /availableMembers:\s*lookup\.catalog\(\)/.test(src),
    'stage 2 must give the generator the signature catalog, not bare names',
  );
});

// --- Viewport / device profiles: general digest knowledge --------------------

check('the digest knows a device profile from a scenario’s own words', () => {
  // This is the general knowledge about "mobile layout": the machinery names the
  // profiles, and reads one out of the scenario prose, so no product has to teach
  // the digest what a mobile scenario is.
  assert(viewportProfileIn('Mobile responsive layout should be landing') === 'mobile', 'a mobile title is mobile');
  assert(viewportProfileIn('The page renders on a tablet') === 'tablet', 'a tablet scenario is tablet');
  assert(viewportProfileIn('Desktop sidebar is wide') === 'desktop', 'a desktop scenario is desktop');
  assert(
    viewportProfileIn('Responsive layout has no horizontal scroll') === 'mobile',
    'an unqualified "responsive" scenario is the narrow case — the width that breaks',
  );
  assert(
    viewportProfileIn('The hero shows the headline and tagline') === null,
    'a scenario that says nothing about a viewport has no profile',
  );
  // A device word beats the generic word, whichever order they appear in.
  assert(
    viewportProfileIn('Responsive rules for the tablet breakpoint') === 'tablet',
    'an explicit device wins over the generic word',
  );
});

check('a viewport scenario without the capability becomes a work order, not a green lie', async () => {
  // Two failure modes hide behind the missing capability: assert the desktop layout
  // at a phone width (passes, tests nothing — the block used to skip the viewport
  // change entirely) or set the width and let the desktop assertions fail on a
  // collapsed nav (looks like a product bug). Neither is acceptable silently, so
  // the gap is named for stage 4.
  const noCapability = (): boolean => false;
  const withCapability = (m: string): boolean => m === VIEWPORT_MEMBER;

  assert(
    viewportCapabilityGap(noCapability, 'mobile') === `${VIEWPORT_MEMBER}(profile: ViewportProfile)`,
    'a mobile scenario on a POM that cannot set a viewport is a named work order',
  );
  assert(viewportCapabilityGap(withCapability, 'mobile') === null, 'the capability satisfies the gap');
  assert(
    viewportCapabilityGap(noCapability, 'desktop') === null,
    'desktop is the run default — needing no viewport change is not a gap',
  );
  assert(viewportCapabilityGap(noCapability, null) === null, 'no profile, no requirement');

  // And the digest must apply that gate, or the knowledge never fires.
  const src = stripComments(await readFile(rehydrate('src/stages/02-testcase-digest.ts'), 'utf8'));
  assert(/viewportCapabilityGap\(/.test(src), 'stage 2 must gate on the viewport capability');
  assert(/viewportProfileIn\(/.test(src), 'stage 2 must read the profile from the scenario');
});

check('a scenario the page object cannot express is blocked, even when no member is named', async () => {
  // Gate 2 is enforced in code against the real surface, not trusted from the model's own
  // `pomCanExpress` — but it only ever inspected the members the model LISTED, and the honest
  // answer for behaviour that lives outside the page (a CI workflow, a deploy script, a docs
  // invariant) is `pomCanExpress: false` with nothing to list: there is no member to invent.
  // `missing` then came back empty by construction, the scenario read as `novel`, and stage 2
  // generated a block that could not touch the thing the scenario was about — held as a passing
  // test on every run after it. Eight of them landed on the first product-triggered run, for a
  // deploy-config change, under `Needs attention — Nothing`.
  const has = (member: string): boolean => ['goto', 'expectSiteTitle'].includes(member);
  const base = { alreadyCovered: false, reason: 'looks novel' };

  assert(
    capabilityGate({ ...base, pomCanExpress: true, membersUsed: ['goto', 'expectSiteTitle'] }, has).kind === 'novel',
    'a yes that names members it has is novel, and generates',
  );
  assert(
    capabilityGate({ ...base, pomCanExpress: true, membersUsed: ['expectCiRan'] }, has).kind === 'blocked',
    'a named member the page object does not have blocks, naming it',
  );

  const inexpressible = capabilityGate({ ...base, pomCanExpress: false, membersUsed: [] }, has);
  assert(
    inexpressible.kind === 'blocked',
    'a "cannot express it" with nothing named still blocks — nothing to name IS the answer for a CI-only scenario',
  );
  assert(
    inexpressible.kind === 'blocked' && inexpressible.missingCapabilities.length > 0,
    'and the work order must name what to add, or stage 4 is told to add nothing',
  );
  assert(
    capabilityGate({ ...base, pomCanExpress: true, membersUsed: [] }, has).kind === 'blocked',
    'a novel verdict naming no member cannot become a block that asserts anything',
  );
  assert(
    capabilityGate({ ...base, alreadyCovered: true, pomCanExpress: false, membersUsed: [] }, has).kind === 'covered',
    'coverage is gate 1 and still short-circuits',
  );

  // And the classifier must route through it, or the gate is knowledge nothing applies.
  const gateSrc = stripComments(await readFile(rehydrate('src/ai/classifier.ts'), 'utf8'));
  assert(/capabilityGate\(/.test(gateSrc), 'the classifier must decide through capabilityGate');
  assert(
    /empty membersUsed/.test(gateSrc),
    'and the prompt must ask for the missing assertion by name, so the work order can name it',
  );
});

check('a spec never calls the Playwright page API directly', async () => {
  // The blocks used `await page.setViewportSize(...)` — the one place the spec
  // escaped the page object, which is what made the mobile test fail on a
  // collapsed nav. Everything goes through the POM: a raw `page` call is outside
  // the capability index, cannot heal, and cannot be reviewed as a capability.
  const specs = await listRepoFiles('tests', (f) => f.endsWith('.spec.ts'));
  assert(specs.length > 0, 'there must be at least one spec to check');
  const offenders: string[] = [];
  for (const file of specs) {
    const region = readManagedRegion(await readFile(rehydrate(file), 'utf8'))
      .map((b) => b.code)
      .join('\n');
    if (/\bpage\s*\./.test(region)) offenders.push(file);
  }
  assert(
    offenders.length === 0,
    `a generated block reached past the page object: ${offenders.join(', ')}`,
  );
});

// --- Layout: the general "does this render correctly at this width" check -----

check('layout spill is judged in the right direction, and decoration is exempt', async () => {
  // The first version of the live scan compared a child against its parent's content
  // box BACKWARDS (`parentRight - childRight`), so every correctly sized element
  // "overflowed" by the width of the slack around it — 1px dividers reported 326px of
  // spill. The decision is a pure function precisely so that mistake is catchable
  // without a browser.
  const parent = (over: Partial<{ overflowX: string; position: string }> = {}) => ({
    path: 'form.space-y-8',
    left: 57,
    right: 318,
    contentLeft: 57,
    contentRight: 318,
    position: over.position ?? 'static',
    overflowX: over.overflowX ?? 'visible',
  });
  const report = (
    boxes: Array<Partial<LayoutBox> & { path: string }>,
  ) => ({
    viewportWidth: 390,
    boxes: boxes.map((b) => ({
      left: 57,
      right: 318,
      width: 261,
      height: 40,
      position: 'static',
      parent: parent(),
      ...b,
    })),
  });

  // The real defect: a fixed 300px widget in a 262px column. Both end up at left 57,
  // so the child's right edge is 357 against a content right of 318 — 39 over — and the
  // document does not scroll, which is why the document-scroll check missed it.
  const turnstile = findLayoutSpill(
    report([
      { path: 'div.cf-turnstile', right: 357, width: 300 },
      { path: 'input.w-full', right: 318, width: 261 },
    ]),
  );
  assert(turnstile.length === 1, `exactly the wide child must be flagged: ${JSON.stringify(turnstile)}`);
  assert(turnstile[0]!.path === 'div.cf-turnstile', 'the wide child is the offender');
  assert(turnstile[0]!.overBy === 39, `39px over its column, got ${turnstile[0]!.overBy}`);
  assert(turnstile[0]!.boundary === 'form.space-y-8', 'the boundary is named, not just "overflow"');

  // A child narrower than its parent is NOT a spill — the inverted bug.
  assert(
    findLayoutSpill(report([{ path: 'div.w-px.h-12', right: 60, width: 1 }])).length === 0,
    'an element narrower than its parent must not be reported',
  );

  // Decoration may bleed: an absolutely positioned glow, and anything inside one.
  assert(
    findLayoutSpill(report([{ path: 'div.glow', right: 414, width: 128, position: 'absolute' }])).length === 0,
    'an absolutely positioned element is placed against a box, not laid out in the flow',
  );
  assert(
    findLayoutSpill(
      report([{ path: 'div.inner', right: 414, width: 128, parent: parent({ position: 'absolute' }) }]),
    ).length === 0,
    'a descendant of an absolutely positioned element is exempt with it',
  );

  // A container that clips or scrolls is allowed to hold wider content — a carousel.
  assert(
    findLayoutSpill(
      report([{ path: 'div.slide', right: 700, width: 700, parent: parent({ overflowX: 'auto' }) }]),
    ).length === 0,
    'a scrolling container must not be reported',
  );

  // The viewport is a boundary for a top-level element, and a 0.5px rounding is not.
  assert(
    findLayoutSpill({ viewportWidth: 390, boxes: [{ path: 'section', left: 0, right: 405, width: 405, height: 100, position: 'static', parent: null }] })[0]
      ?.boundary === 'the viewport',
    'a child of the body is bounded by the viewport',
  );
  assert(
    findLayoutSpill(report([{ path: 'span', right: 318.5, width: 261.5 }])).length === 0,
    'sub-pixel rounding is absorbed by the tolerance',
  );

  // And the page object must use it, or the check never runs.
  const pomSource = await readFile(rehydrate('src/page-objects/landing-page/index.ts'), 'utf8');
  assert(/measureLayoutSpill\(/.test(pomSource), 'the layout assertion must use the container-aware scan');
});

check('the block hash decides: a moved hash re-digests, it never asks the classifier', async () => {
  // The scenario's own generated block carries the scenario's title, and the classifier
  // was asked whether an existing test covered the scenario with that title in the list —
  // so a STALE block vouched for itself. The edit never reached the spec, and because the
  // block was carried forward with its OLD hash, the same scenario was re-decided on every
  // later run, forever, under a green report. AGENTS.md promises a tag edit regenerates
  // the block; the hash is what makes that true.
  const current = { scenarioContentHash: 'h1' };
  assert(digestPath(current, 'h1') === 'hold', 'an unchanged scenario is held');
  assert(
    digestPath({ scenarioContentHash: 'h0' }, 'h1') === 'redigest',
    'a moved hash must re-digest — this is the whole rule',
  );
  assert(
    digestPath(undefined, 'h1') === 'classify',
    'a scenario with NO block is the only one that may be judged already covered',
  );
  // All three paths are reachable, so no scenario can fall through unhandled.
  assert(
    new Set([digestPath(current, 'h1'), digestPath(current, 'h9'), digestPath(undefined, 'h1')]).size === 3,
    'all three paths must be reachable',
  );

  // And stage 2 must USE it, with the stale path bypassing the classifier rather than
  // filtering the evidence around it.
  const src = stripComments(await readFile(rehydrate('src/stages/02-testcase-digest.ts'), 'utf8'));
  assert(/digestPath\(/.test(src), 'stage 2 must decide the path from the block hash');
  assert(
    /path === 'redigest'/.test(src),
    'a moved hash must re-digest, not be offered to the classifier',
  );
});

// --- Concurrency invariants --------------------------------------------------

check('mapOrdered preserves input order, not arrival order', async () => {
  const pool = createPool(8);
  const inputs = [50, 10, 30, 20, 40];
  const results = await mapOrdered(pool, inputs, (ms) =>
    sleep(ms).then(() => ms * 2),
  );
  assert(results.join(',') === '100,20,60,40,80', `arrival order leaked: ${results.join(',')}`);
});

check('createPool throws on non-positive concurrency', () => {
  let threw = false;
  try {
    createPool(0);
  } catch {
    threw = true;
  }
  assert(threw, 'pool accepted zero concurrency');
});

// --- Scope planning: the agent proposes, the code decides --------------------

check('the planner never narrows below the floor, whatever the agent says', async () => {
  // The whole point of separating the agent from the filter: a change that broke
  // everything can still be answered "smoke". The floor must put this run's
  // generated tests back into the grep regardless of what the agent chose.
  const tiers = await loadTiers();
  const manifest = newManifest('x');
  manifest.scenarios.push(
    { domain: 'demo', id: 'a', contentHash: 'h', title: 'A new test', tags: ['@regression'], verdict: 'generated' },
    { domain: 'demo', id: 'b', contentHash: 'h', title: 'An old test', tags: ['@regression'], verdict: 'held' },
  );
  const outcome = planTier(
    { manifest, proposed: 'smoke', override: null, generatedTitles: ['A new test'], generatedDateTag: '@20261021' },
    tiers,
  );
  assert(outcome.tier === 'smoke', `the agent's scope must stand when nothing widened it, got ${outcome.tier}`);
  assert(outcome.source === 'planner', 'a scope that survived must be credited to the agent');
  assert(outcome.grep.includes('@20261021'), `the creation-date tag must be in the floor: ${outcome.grep}`);
  assert(outcome.grep.includes('A new test'), `the generated title must be in the floor: ${outcome.grep}`);
  assert(
    !outcome.grep.includes('An old test'),
    'a held @regression test must NOT be pulled in by the floor — that would make every scope regression',
  );
});

check('an agent that produces nothing widens to the full suite, and names why', async () => {
  const tiers = await loadTiers();
  const outcome = planTier(
    {
      manifest: newManifest('x'),
      proposed: null,
      proposalFailure: 'empty content',
      override: null,
      generatedTitles: [],
      generatedDateTag: null,
    },
    tiers,
  );
  assert(outcome.tier === 'regression', 'a failed agent must widen to the full suite');
  assert(outcome.grep === '', 'the full suite means no grep');
  assert(outcome.source === 'fail-open', 'the scope must not be credited to the agent');
  assert(
    outcome.degradation.some((d) => d.includes('empty content') && d.includes('widened to the full suite')),
    `the widening must be named with its cause, got: ${outcome.degradation.join(' | ')}`,
  );
});

check('a regression scope selects everything, so untagged tests still run', async () => {
  const tiers = await loadTiers();
  const outcome = planTier(
    {
      manifest: newManifest('x'),
      proposed: 'regression',
      override: null,
      generatedTitles: [],
      generatedDateTag: null,
    },
    tiers,
  );
  assert(outcome.tier === 'regression', 'regression is regression');
  assert(
    outcome.grep === '',
    'regression must be an empty grep — a tag list there would silently drop every untagged test',
  );
  assert(outcome.source === 'planner', "nothing widened it, so it is the agent's scope");
});

check('a builder failure widens one step, not all the way to the suite', async () => {
  const tiers = await loadTiers();
  const manifest = newManifest('x');
  // A scenario that the scope's own filter matches — otherwise the empty-matching
  // guard fires first and takes it straight to the full suite (also correct, but
  // it would hide the one-step rule this check is about).
  manifest.scenarios.push({
    domain: 'demo',
    id: 'a',
    contentHash: 'h',
    title: 'A smoke test',
    tags: ['@smoke'],
    verdict: 'held',
  });
  manifest.domains.push({
    domain: 'demo',
    scope: null,
    unbuildable: [],
    builder: 'failed',
    tier: null,
    grep: null,
    playwright: null,
    healApply: null,
  });
  const outcome = planTier(
    { manifest, proposed: 'smoke', override: null, generatedTitles: [], generatedDateTag: null },
    tiers,
  );
  assert(outcome.tier === 'sanity', `smoke must widen one step to sanity, got ${outcome.tier}`);
  assert(
    outcome.degradation.some((d) => d.includes('widened smoke → sanity')),
    'the step must be named',
  );
});

check('a scope whose filter matches nothing widens to the full suite', async () => {
  const tiers = await loadTiers();
  // No scenario on the manifest carries a scope tag, and the only generated title
  // is not on the manifest either: the guard must widen rather than hand back a
  // filter that selects nothing.
  const outcome = planTier(
    {
      manifest: newManifest('x'),
      proposed: 'sanity',
      override: null,
      generatedTitles: ['Brand new generated title'],
      generatedDateTag: null,
    },
    tiers,
  );
  assert(outcome.grep === '', `an empty-matching filter must widen to no filter, got: ${outcome.grep}`);
  assert(outcome.tier === 'regression', 'widening lands on the regression scope');
  assert(outcome.degradation.some((d) => d.includes('widened to full suite')), 'widening was not named');
});

check('a human TEST_GREP overrides the planner outright — no floor, no agent', async () => {
  // An operator's grep is an instruction, not a hint: it IS the filter. The floor is
  // deliberately NOT applied (someone who typed @smoke does not want surprise extras),
  // and stage 5 never calls the model at all, so there is no discarded answer to explain.
  const tiers = await loadTiers();
  const manifest = newManifest('x');
  manifest.scenarios.push({
    domain: 'demo',
    id: 'a',
    contentHash: 'h',
    title: 'A new test',
    tags: ['@regression'],
    verdict: 'generated',
  });
  const outcome = planTier(
    {
      manifest,
      proposed: null,
      override: '@smoke',
      generatedTitles: ['A new test'],
      generatedDateTag: '@20261021',
    },
    tiers,
  );
  assert(outcome.grep === '@smoke', `the override must be the grep verbatim, got ${outcome.grep}`);
  assert(
    outcome.tier === null,
    'an override is not a planned scope — recording it as one misattributes the decision to the agent',
  );
  assert(outcome.source === 'human', 'the run report must be able to say a human chose this filter');
  assert(!outcome.grep.includes('A new test'), 'the floor must NOT be applied to an override');
  assert(!outcome.grep.includes('@20261021'), 'the creation-date floor must NOT be applied either');
});

check('an override that drops a test this run wrote says so, loudly', () => {
  // The floor exists so a run cannot skip the tests it was triggered to write. An
  // operator may override that — but absolute must not mean silent, or the report hands
  // a reviewer a green run built from tests that never ran.
  const manifest = newManifest('x');
  manifest.grepOverride = '@smoke';
  recordScenario(manifest, {
    domain: 'demo',
    id: 'a',
    contentHash: 'h',
    title: 'A brand new test',
    tags: ['@regression'],
    verdict: 'generated',
    reason: 'written this run',
    createdDate: '20261021',
  });
  manifest.domains.push({
    domain: 'demo',
    scope: null,
    unbuildable: [],
    builder: null,
    tier: null,
    grep: '@smoke',
    playwright: null,
    healApply: null,
  });
  const summary = renderRunSummary(manifest, buildReport(manifest, new Date()));
  assert(summary.includes('Human override'), 'the summary must say the run was overridden, not planned');
  assert(summary.includes('planner agent was not consulted'), 'the reader must know the agent never ran');
  assert(
    summary.includes('written by THIS run are excluded'),
    `an override that drops a generated test must shout about it, got:\n${summary}`,
  );
  assert(
    summary.includes('scope: **human override**'),
    'the domain facts must not misattribute an override to a tier',
  );
});

check('a malformed tiers.json THROWS rather than silently defaulting', () => {
  // A scope vocabulary that a bad value can only make "slightly wrong" is one
  // nobody notices is wrong — the run just selects fewer tests. Malformed config
  // throws here, the same rule as everywhere else in the repo.
  assertThrows(() => parseTiers('{ not json'), 'broken JSON must throw');
  assertThrows(() => parseTiers('{}'), 'a missing scope must throw');
  assertThrows(() => parseTiers('{"smoke":{"description":"x","tags":[]}}'), 'a missing sibling scope must throw');
  assertThrows(
    () =>
      parseTiers(
        JSON.stringify({
          smoke: { description: 'x', tags: ['@smoke'] },
          sanity: { description: 'x', tags: ['@smoke', '@core'] },
          // A tag list on regression would silently exclude every untagged test
          // from the run the summary calls "everything".
          regression: { description: 'x', tags: ['@regression'] },
        }),
      ),
    'regression with a tag list must throw',
  );
});

check('the shipped tier vocabulary is readable and regression selects everything', async () => {
  const tiers = await loadTiers();
  assert(tiers.regression.tags.length === 0, 'regression must select everything');
  for (const name of TIER_NAMES) {
    assert(tiers[name].description.length > 0, `${name} must carry a description the agent can read`);
  }
});

// --- The creation-date tag --------------------------------------------------

check('the creation-date tag is stable: a held block keeps the date it was made', () => {
  // Re-stamping "today" on every run would rewrite every generated block's tag
  // option once a day — churn nobody reads in a diff. The date is written once,
  // at generation, and read back off the block on a hold.
  const generated = applyScenarioTags(`test('A title', async ({ page }) => {});`, [
    '@regression',
    '@20261021',
  ]);
  assert(
    generated.includes(`tag: ['@regression', '@20261021']`),
    `the date tag must be written onto the block, got:\n${generated}`,
  );
  assert(dateTagIn(generated) === '@20261021', 'the date must be readable back off the block');

  // The hold path re-applies the scenario tags plus the date it read back. That
  // round trip must be a fixpoint, or the block is rewritten on every run.
  const held = applyScenarioTags(generated, ['@regression', dateTagIn(generated) ?? '']);
  assert(held === generated, `a held block must come back byte-identical, got:\n${held}`);
  assert(dateTagIn(`test('t', async () => {});`) === null, 'a block with no date tag reads as none');
});

check('stage 2 stamps the creation-date tag on generated blocks, and preserves it on a hold', async () => {
  // The floor depends on this: if the stamp silently stops being applied, the planner
  // falls back to matching generated TITLES, which works right up until a generated
  // title disagrees with the spec's — and then the test the run was triggered to write
  // drops out of the run as a smaller green one. A real digest needs a model, so this
  // reads the wiring instead of running it.
  const digest = await readFile(rehydrate('src/stages/02-testcase-digest.ts'), 'utf8');
  assert(/runDateTag\(ctx\.manifest\)/.test(digest), 'the digest must take the tag from the run, not from "now"');
  assert(/dateTagIn\(/.test(digest), 'a held block must keep the date it was made');
  assert(
    /dateTagById\.get\(block\.scenarioId\)/.test(digest),
    'the per-block date must reach the tag application, or nothing is stamped',
  );
  assert(
    /\[\.\.\.scenarioTags, dateTag\]/.test(digest),
    'the date tag must be applied alongside the scenario tags',
  );
});

check('the run date tag is the run start date, and does not move on a re-run', () => {
  const m = newManifest('check');
  m.startedAt = '2026-10-21T23:50:00.000Z';
  assert(runDateTag(m) === '@20261021', `expected @20261021, got ${runDateTag(m)}`);
  // A single-stage re-run re-reads the same manifest, so the tag cannot drift to
  // "now" and mutate the blocks the previous run wrote.
  assert(runDateTag({ ...m }) === runDateTag(m), 'the tag must be a function of the manifest, not of "now"');
});

// --- JSON extraction / truncation repair -------------------------------------

check('extractJson handles fenced output', () => {
  const out = extractJson<{ a: number }>('```json\n{"a": 1}\n```');
  assert(out.a === 1, 'fenced JSON not extracted');
});

check('repairTruncatedJson closes unbalanced braces', () => {
  const repaired = repairTruncatedJson('{"a": {"b": [1, 2');
  assert(JSON.parse(repaired).a.b.length === 2, `repair produced invalid JSON: ${repaired}`);
});

// --- Prompt placeholder substitution ------------------------------------------

check('substitute fills every placeholder and throws when one is missing', () => {
  const out = substitute('Hello {{NAME}}, {{OTHER}}', { NAME: 'a', OTHER: 'b' });
  assert(!out.includes('{{'), `placeholder left unsubstituted: ${out}`);
  let threw = false;
  try {
    substitute('{{MISSING}}', { OTHER: 'x' });
  } catch {
    threw = true;
  }
  assert(threw, 'missing placeholder did not throw');
});

// --- Test-authoring rules: assertions live in the POM, each with a message ----
// (AGENTS.md §"Test authoring rules". Enforced over the output, not by prose:
// a prompt that forbids something is not enforcement.)

check('no spec file calls expect() — assertions live in the page objects', async () => {
  const specs = await listRepoFiles('tests', (f) => f.endsWith('.spec.ts'));
  const offenders: string[] = [];
  for (const file of specs) {
    const src = stripComments(await readFile(rehydrate(file), 'utf8'));
    if (/\bexpect\s*\(/.test(src)) offenders.push(file);
  }
  assert(
    offenders.length === 0,
    `assertions belong in the POM, but expect() was found in: ${offenders.join(', ')}`,
  );
});

check('a block that reaches past the page object is refused, never written', async () => {
  // The write-path half of the two checks above. It is deliberately not a strip: deleting
  // the offending lines would leave a test that passes and asserts nothing, which is the
  // silent green this repo exists to prevent. Refusal is a pure decision, so it is driven
  // here with synthetic code — and a real run proved the need: a PR-triggered digest wrote
  // 11 blocks, of which several called `page.request.get` and `expect()` directly, produced
  // 9 TypeScript errors and took 12 handwritten tests down with them. The run called itself
  // a success.
  assert(
    blockViolations('await page.request.get("/instagram", { maxRedirects: 0 });').length === 1,
    'a raw page call must be refused',
  );
  assert(
    blockViolations("expect(href, 'the cta points at the portfolio').toBe('/portfolio');").length === 1,
    'a raw expect() must be refused',
  );
  assert(
    blockViolations(
      '// expect(title).toBeTruthy() — the POM asserts this\nconst landingPage = new LandingPage(page);\nawait landingPage.expectLoaded();',
    ).length === 0,
    'a block that uses the POM, and only MENTIONS expect() in a comment, is clean',
  );

  // And the digest must apply it, or the guard never fires.
  const digest = stripComments(await readFile(rehydrate('src/stages/02-testcase-digest.ts'), 'utf8'));
  assert(/blockViolations\(gen\.code\)/.test(digest), 'stage 2 must refuse such a block before writing it');
  assert(/verdict|record\(/.test(digest), 'the refusal must be recorded as a verdict, not swallowed');
});

check('generated output is gated before it ships, not only before it is generated', async () => {
  // CI runs `typecheck && self-checks` immediately BEFORE `npm run pipeline`, so the code
  // the pipeline writes has never been through them. The failure is not subtle once you see
  // it — an uncompilable spec was committed, pushed and opened as a PR under a green run —
  // but nothing said so, which is what makes it this repo's kind of bug.
  const src = stripComments(await readFile(rehydrate('src/stages/08-git.ts'), 'utf8'));
  for (const script of ['typecheck', 'self-checks']) {
    assert(src.includes(`'${script}'`), `the ship gate must run \`npm run ${script}\` over the output`);
  }
  const gated = src.indexOf('await shipGate()');
  const shipped = src.indexOf('await codeHost.createBranch(');
  assert(gated >= 0 && shipped >= 0 && gated < shipped, 'the gate must refuse BEFORE a branch is created');
});

check('a compiler error is attributed to the block that owns the line', async () => {
  // The compiler is the only gate that can see a block calling the page object WRONG rather than
  // naming something absent — sufficiency is not checkable from a list of member names. Its value
  // is the ATTRIBUTION, not the error: TypeScript reports against the FILE, every block of a
  // domain lives in one file, and so a single bad block used to cost every other block its
  // delivery (seventeen correct blocks refused along with four wrong ones, on a real PR). The span
  // arithmetic is the part that can be silently wrong — refuse the neighbour, or keep the offender
  // — so it is driven here with synthetic text instead of the compiler it wraps.
  const file = [
    "import { test } from '../../src/runtime/self-heal-fixture.js';",
    '',
    'test.describe("demo", () => {',
    '  // @digest:managed:start',
    '',
    '  // @digest:block:aaaaaaaaaaaaaaaa:1111111111111111',
    "  test('one', async () => {",
    '    const a = 1;',
    '  });',
    '  // @digest:end-block',
    '',
    '  // @digest:block:bbbbbbbbbbbbbbbb:2222222222222222',
    "  test('two', async () => {",
    "    await demoPage.goto('/x');",
    '  });',
    '  // @digest:end-block',
    '',
    '  // @digest:managed:end',
    '});',
  ].join('\n');

  assert(
    JSON.stringify(blockSpans(file)) ===
      JSON.stringify([
        { scenarioId: 'aaaaaaaaaaaaaaaa', from: 6, to: 10 },
        { scenarioId: 'bbbbbbbbbbbbbbbb', from: 12, to: 16 },
      ]),
    'a span must run from the block marker through its end-marker, inclusive',
  );

  const tsc = [
    '> tcgen@0.1.0 typecheck',
    '> tsc --noEmit',
    'tests/demo/demo.spec.ts(14,5): error TS2554: Expected 0 arguments, but got 1.',
    '  Type undefined is not assignable.', // the continuation line tsc prints: not a diagnostic
    'tests/demo/demo.spec.ts(16,4): error TS2554: Expected 0 arguments, but got 1.',
    'tests/demo/demo.spec.ts(11,1): error TS1005: a blank line between blocks owns no block',
    'tests/demo/demo.spec.ts(1,1): error TS6133: the import belongs to nobody',
    'tests/other/other.spec.ts(3,3): error TS1005: another file is not this domain to refuse',
  ].join('\n');

  const verdict = blockCompileErrors(file, 'tests/demo/demo.spec.ts', tsc);
  assert(
    [...verdict.byBlock.keys()].join(',') === 'bbbbbbbbbbbbbbbb',
    `only the offending block is blamed, got: ${[...verdict.byBlock.keys()].join(',')}`,
  );
  assert(
    (verdict.byBlock.get('bbbbbbbbbbbbbbbb') ?? []).length === 2,
    'the end-marker line belongs to the block ending there, and the banner is not a diagnostic',
  );
  assert(
    verdict.unattributed.length === 2,
    `lines no block owns are named rather than dropped — got ${verdict.unattributed.length}`,
  );
  assert(
    parseTscErrors('tests\\other\\other.spec.ts(3,3): error TS1005: x')[0]?.file === 'tests/other/other.spec.ts',
    'a Windows path is normalised, or the guard finds nothing on the platform this is developed on',
  );

  // And stage 2 must apply it, or the attribution never fires.
  const digest = stripComments(await readFile(rehydrate('src/stages/02-testcase-digest.ts'), 'utf8'));
  assert(/blockCompileErrors\(composed\.text/.test(digest), 'stage 2 must attribute compile errors to blocks');
  assert(
    /verdict\.byBlock\.size > 0/.test(digest) && /composeSpec\(\)/.test(digest),
    'a blamed block must trigger a recomposition, not just a report',
  );
});

check('every expect() in a page object passes an assertion message', async () => {
  const poms = await listRepoFiles('src/page-objects', (f) => f.endsWith('.ts'));
  const offenders: string[] = [];
  for (const file of poms) {
    const src = stripComments(await readFile(rehydrate(file), 'utf8'));
    for (const args of expectCallArgs(src)) {
      const second = secondTopLevelArg(args);
      if (second === null || !/^['"`]/.test(second)) {
        offenders.push(`${file}: expect(${args.trim().slice(0, 50)}…)`);
      }
    }
  }
  assert(
    offenders.length === 0,
    `every assertion needs a message — missing on: ${offenders.join(' | ')}`,
  );
});

check('the stage that runs Playwright names the run, and starts from no records', async () => {
  // Both of these fail SILENTLY when dropped, which is the rule for adding a check
  // here. Without the run name, Playwright's post-failure worker restart lets the
  // second worker's teardown erase the first one's records — a run with a failure
  // losing the heals it most needs to report. Without the delete, a run that dies
  // before any worker reaches teardown leaves the previous run's repairs to be read
  // as this run's and applied as if a test had just verified them.
  const src = stripComments(await readFile(rehydrate('src/stages/06-playwright-test.ts'), 'utf8'));
  assert(src.includes('HEAL_RUN_ID'), 'the stage must name the run for the healing fixture');
  assert(
    src.includes('HEAL_RECORDS') && src.includes('rm('),
    "the stage must delete the previous run's heal records",
  );
});

check('specs import the healing fixture, not @playwright/test', async () => {
  // A spec that imports plain `@playwright/test` compiles, passes, and heals
  // nothing: the page carries no heal collector, so every POM locator silently
  // degrades to a raw `page.locator`. Same shape as the "no expect() in specs"
  // rule above — a convention with an invisible failure mode, checked mechanically.
  const specs = await listRepoFiles('tests', (f) => f.endsWith('.spec.ts'));
  assert(specs.length > 0, 'there must be at least one spec to check');
  const offenders: string[] = [];
  for (const file of specs) {
    const src = stripComments(await readFile(rehydrate(file), 'utf8'));
    if (!src.includes('self-heal-fixture.js')) offenders.push(file);
  }
  assert(
    offenders.length === 0,
    `these specs cannot heal a locator — missing the healing-fixture import: ${offenders.join(', ')}`,
  );
});

check('the healer narrows a drifted selector, and never offers the one that failed', () => {
  // The healer is deliberately model-free: a guessed locator that is wrong does
  // not fail, it asserts against the wrong element and passes. Every candidate is
  // a mechanical narrowing of the selector that broke.
  const narrow = (selector: string): string[] =>
    fallbackCandidates(selector).map((c) => c.selector);
  const show = (selector: string): string => narrow(selector).join('|') || '(none)';

  assert(show('h1.legacy-hero') === 'h1', `a stale class must narrow to its element, got: ${show('h1.legacy-hero')}`);
  assert(
    show('div.a.b') === 'div.a|div',
    `qualifiers must drop one at a time, got: ${show('div.a.b')}`,
  );
  assert(
    show('input[name="phone"][type="tel"]') === 'input[name="phone"]|input',
    `a dropped attribute must fall back to the named field, got: ${show('input[name="phone"][type="tel"]')}`,
  );
  assert(
    show('text("Explore Niches")') === 'text="Explore Niches"',
    `a text() dialect must fall back to the text engine, got: ${show('text("Explore Niches")')}`,
  );
  assert(
    show('[data-test="consent-privacy-link"]') === '[data-testid="consent-privacy-link"]',
    `a renamed test-id attribute must be re-expressed, got: ${show('[data-test="consent-privacy-link"]')}`,
  );

  // A selector that already failed must never come back as its own fallback: that
  // would record a heal that heals nothing, and rewrite the source for no reason.
  for (const selector of ['h1.legacy-hero', 'div.a.b', '[data-testid="x"]', 'section#pricing']) {
    assert(
      !narrow(selector).includes(selector),
      `the failed selector must not be its own fallback: ${selector}`,
    );
  }
  assert(narrow('#id-removed').length === 0, 'a lone qualifier has nothing left to narrow to');
});

check('a run records a given heal once, however many times it is re-healed', () => {
  // A page object resolves the same locator once per use — the contact section is
  // resolved once per form field. Recording six identical heals makes stage 7
  // apply one and "skip" five, i.e. report failure for a run that healed.
  const manifest = new HealManifest();
  const heal = {
    file: 'src/page-objects/landing-page/index.ts',
    brokenLocator: '[data-test="contact-section"]',
    healedLocator: '[data-testid="contact-section"]',
    strategy: 'attribute' as const,
    observed: 'resolved to 0 elements',
  };
  for (let i = 0; i < 6; i++) manifest.add(heal);
  assert(manifest.records.length === 1, `six reheals must record one heal, got ${manifest.records.length}`);

  // A different break in the same file is a different heal, not a duplicate.
  manifest.add({ ...heal, brokenLocator: '[data-test="site-footer"]' });
  assert(manifest.records.length === 2, 'a second broken locator must still be recorded');
});

check('the copy healer picks the nearest on-page text, and refuses a coin toss', () => {
  // The typo that started this: a locator for the hero tagline with one transposed
  // pair. The heal is the nearest on-page copy. Deterministic and deliberately
  // timid, because a wrong locator asserts against the wrong element and passes.
  const nearest = closestCopy('Marco and Product Photographer', [
    'Macro and Product Photographer',
    'fotogaper | Specialized Product & Macro Photography',
  ]);
  assert(
    nearest.kind === 'match' && nearest.best.text === 'Macro and Product Photographer',
    `the clearly-nearest copy must win, got ${nearest.kind}`,
  );
  assert(
    closestCopy('Marco and Product Photographer', ['Take a Closer Look', 'Simple product arrangements'])
      .kind === 'none',
    'a page that says nothing close is not a heal',
  );
  assert(
    closestCopy('Fair Rates, No Surprises', ['Fair Rates, No Surprise', 'Fair Rate, No Surprises']).kind ===
      'ambiguous',
    'two near-identical copies are a coin toss, not a heal — and the refusal must say so',
  );
  const onlyItself = closestCopy('Explore Niches', ['Explore Niches']);
  assert(
    onlyItself.kind === 'none' && onlyItself.nearest === null,
    'the target is not its own candidate',
  );
  assert(similarity('abc', 'abc') === 1, 'identical strings are perfectly similar');
});

check('the healing runtime knows which locale it is looking at', () => {
  // Copy is the one thing that is not locale-independent. This app serves /en and
  // /id with the same structure and different words, so a copy heal that ran on
  // /id would rewrite the POM's English copy to Indonesian and break /en.
  assert(localeOf('https://foto.gappp.my.id/en') === '/en', '/en is the en locale');
  assert(localeOf('https://foto.gappp.my.id/en/portfolio') === '/en', 'a nested path is the same locale');
  assert(localeOf('https://foto.gappp.my.id/id') === '/id', '/id is the id locale');
  assert(localeOf('https://foto.gappp.my.id/') === '/', 'a bare host has no locale prefix');
  assert(localeOf('about:blank') === null, 'a page that has not navigated says nothing useful');
  assert(localeOf('not a url') === null, 'an unparseable URL is not a locale');
});

check('a refused heal is recorded with its reason, and deduped like a heal', () => {
  // Refusing is half the healer's job: an element that is genuinely gone, copy
  // written for another locale, two candidates that are a coin toss. The refusal is
  // what explains a red test the machinery chose not to paper over.
  const manifest = new HealManifest();
  const refusal = {
    file: 'src/page-objects/landing-page/index.ts',
    brokenLocator: "'Macro and Product Photographer'",
    reason: 'locale-mismatch' as const,
    detail: 'copy is written for /en; this run is in /id',
  };
  for (let i = 0; i < 6; i++) manifest.refuse(refusal);
  assert(
    manifest.refusals.length === 1,
    `six identical refusals must record one, got ${manifest.refusals.length}`,
  );
  assert(manifest.refusals[0]?.reason === 'locale-mismatch', 'the reason must survive');
  // A different reason for the same locator is a different diagnostic.
  manifest.refuse({ ...refusal, reason: 'no-candidate', detail: 'resolved to 0 elements; nothing close' });
  assert(manifest.refusals.length === 2, 'a different reason is a different diagnostic');
});

check('heals.json holds both heals and refusals, and reads them back', async () => {
  await withScratchHeals(async () => {
    const manifest = new HealManifest();
    manifest.add({
      file: 'src/page-objects/landing-page/index.ts',
      brokenLocator: "'Marco and Product Photographer'",
      healedLocator: "'Macro and Product Photographer'",
      strategy: 'text-fallback',
      observed: 'resolved to 0 elements; nearest copy "Macro and Product Photographer" (0.93)',
    });
    manifest.refuse({
      file: 'src/page-objects/landing-page/index.ts',
      brokenLocator: "'Fair Rates, No Surprises'",
      reason: 'ambiguous',
      detail: 'two candidates are a coin toss',
    });
    await manifest.save();

    const raw = await readFile(rehydrate('artifacts/run/heals.json'), 'utf8');
    const parsed = JSON.parse(raw) as { heals?: unknown[]; refusals?: unknown[] };
    assert(Array.isArray(parsed.heals) && parsed.heals.length === 1, 'the heal must persist');
    assert(Array.isArray(parsed.refusals) && parsed.refusals.length === 1, 'the refusal must persist');

    const report = await HealManifest.loadReport();
    assert(report.heals.length === 1, 'loadReport reads the heals');
    assert(report.refusals.length === 1, 'loadReport reads the refusals');
    assert((await HealManifest.load()).length === 1, 'load() is the heals alone');
  });
});

check('re-running one stage replaces its record instead of appending', async () => {
  // `npm run stage:7` re-runs a single stage from the manifest on disk, in a new
  // process, so the same stage name is recorded again. Pushing the record appended:
  // the summary grew seven identical `heal-apply` lines, and the older ones kept
  // their degradations and their `failed` status — so a re-run that FIXED a stage
  // still reported it as failed, forever.
  const manifest = newManifest('run-upsert');
  const runner = new StageRunner(manifest);
  const spec: StageSpec = {
    name: 'heal-apply',
    run: async (ctx) => {
      ctx.recordDegradation('heal-apply', 'first attempt degraded');
      return 'first';
    },
  };
  await runner.run(spec);
  assert(manifest.stages.length === 1, 'one stage run records one entry');

  // A second run in a new process, with a clean runner, as a re-run actually is.
  const rerun = new StageRunner(manifest);
  // Seed a duplicate the way the old append-only code left one on disk.
  manifest.stages.push({ name: 'heal-apply', status: 'failed' });
  await rerun.run(spec);

  assert(manifest.stages.length === 1, `a re-run must not append, got ${manifest.stages.length}`);
  const record = manifest.stages[0];
  assert(record?.status === 'succeeded', 'the re-run status must replace the old failure');
  assert(
    (record?.degradation ?? []).length === 1,
    'the re-run must keep its own degradations, not inherit stale ones',
  );
});

check('managed region write→read is a fixpoint (a held block must not drift)', () => {
  // stage 2 renders the region and indents it into a test.describe body. If the
  // read does not strip that indentation again, the next run indents the region
  // a second time — every run adds two spaces to every held block. Silent: the
  // tests stay green, only the diff churns.
  const blocks: ManagedBlock[] = [
    {
      scenarioId: 'a'.repeat(16),
      scenarioContentHash: 'b'.repeat(16),
      code: "test('x', async ({ page }) => {\n  const p = new P(page);\n  await p.goto();\n});",
    },
  ];
  const indent = (s: string): string => s.replace(/^/, '  ').replace(/\n/g, '\n  ');
  const file = `import { test } from '@playwright/test';\ntest.describe('x', () => {\n${indent(renderManagedRegion(blocks))}\n});\n`;

  const read = readManagedRegion(file);
  assert(read.length === 1, 'the block must read back');
  assert(
    read[0]!.code === blocks[0]!.code,
    `held block code changed on read:\n${JSON.stringify(read[0]!.code)}`,
  );

  const rewrite = `import { test } from '@playwright/test';\ntest.describe('x', () => {\n${indent(renderManagedRegion(read))}\n});\n`;
  assert(rewrite === file, 'a second write must reproduce the file byte-for-byte');

  // A block whose code begins with a blank line — the generator's output often
  // does — must survive the same round trip. Trimming only the END on write let
  // the blank line through on the first pass and dropped it on read-back, so the
  // first hold after generation produced one extra diff.
  const leadBlank: ManagedBlock[] = [
    {
      scenarioId: 'c'.repeat(16),
      scenarioContentHash: 'd'.repeat(16),
      code: "\n\ntest('y', async ({ page }) => {});",
    },
  ];
  const leadFile = `test.describe('y', () => {\n${indent(renderManagedRegion(leadBlank))}\n});\n`;
  const leadRead = readManagedRegion(leadFile);
  assert(
    leadRead[0]!.code === "test('y', async ({ page }) => {});",
    `a leading blank line must be trimmed on write, got: ${JSON.stringify(leadRead[0]!.code)}`,
  );
  const leadRewrite = `test.describe('y', () => {\n${indent(renderManagedRegion(leadRead))}\n});\n`;
  assert(leadRewrite === leadFile, 'a block with a leading blank line must not churn on the second run');

  // The FIRST write of a domain goes through the scaffold, and every later write
  // through upsertManagedRegion. If the two disagree by so much as a blank line
  // before the closing brace, the first hold after generation rewrites the file —
  // a diff nobody is told about. The check is the invariant itself: the writer must
  // reproduce the scaffold byte-for-byte.
  const fresh = renderManagedRegion([
    {
      scenarioId: 'e'.repeat(16),
      scenarioContentHash: 'f'.repeat(16),
      code: "test('x', async ({ page }) => {});",
    },
  ]);
  const scaffold = scaffoldManagedSpec({
    domain: 'demo',
    imports: [`import { test } from '../../src/runtime/self-heal-fixture.js';`],
    region: indent(fresh),
  });
  assert(
    upsertManagedRegion(scaffold, indent(fresh)) === scaffold,
    'the writer must reproduce the scaffold byte-for-byte, or the first hold run churns',
  );
  assert(
    readManagedRegion(scaffold)[0]?.code === "test('x', async ({ page }) => {});",
    'the scaffolded block must read back unchanged',
  );

  // The other writer branch: a spec with handwritten content and no region yet.
  const handwritten = `import { test } from '@playwright/test';\n\ntest('handwritten', async ({ page }) => {});\n`;
  const appended = upsertManagedRegion(handwritten, indent(fresh));
  assert(
    upsertManagedRegion(appended, indent(fresh)) === appended,
    'appending a region must be a fixpoint too, or the second run churns it',
  );
});

check('manifest round-trips through JSON with verdicts, reasons and work orders intact', () => {
  // JSON.stringify(new Map(...)) is '{}'. A Map left in the manifest is dropped
  // with NO error, and every downstream stage then reads an empty digest — a
  // silent green. The manifest now carries ONE plain scenario list instead, and
  // `containsMap` proves nothing in it needs converting. This is also what makes
  // a per-stage re-run (`npm run stage:3`) work.
  const m = newManifest('check');
  m.domains.push({
    domain: 'demo',
    scope: null,
    unbuildable: [
      {
        scenario: {
          id: 'a',
          contentHash: 'h',
          title: 't',
          tags: [],
          expected: 'e',
          notes: '',
          raw: '',
        },
        missingCapabilities: ['expectThing'],
      },
    ],
    builder: null,
    tier: null,
    grep: null,
    playwright: null,
    healApply: null,
  });
  recordScenario(m, {
    domain: 'demo',
    id: 'a',
    contentHash: 'h',
    title: 'A covered test',
    tags: ['@core'],
    verdict: 'covered',
    reason: 'covered by "B"',
  });
  recordScenario(m, {
    domain: 'demo',
    id: 'b',
    contentHash: 'h2',
    title: 'A held test',
    tags: [],
    verdict: 'held',
    reason: 'unchanged',
  });

  assert(
    !containsMap(m),
    'a Map is in the manifest — JSON.stringify writes {} for it with no error',
  );

  const round = JSON.parse(JSON.stringify(m)) as RunManifest;
  const covered = round.scenarios.find((s) => s.id === 'a');
  assert(covered?.verdict === 'covered', 'the verdict must survive the round-trip');
  assert(covered?.title === 'A covered test', 'the title must sit next to its verdict');
  assert(covered?.reason === 'covered by "B"', 'the reason must survive — it is the point');
  assert(
    round.domains[0]!.unbuildable.length === 1 &&
      round.domains[0]!.unbuildable[0]!.missingCapabilities[0] === 'expectThing',
    'stage-2 work orders must survive the round-trip',
  );
});

check('the digest summary names every scenario, including the ones that produced no test', () => {
  // The complaint that started this: a scenario the classifier judged "already
  // covered" produced no block AND no line, so it looked like the digest never
  // saw it. Counts alone cannot answer "where did my testcase go?" — the summary
  // has to name each scenario, spell out the verdict, and give the reason.
  const m = newManifest('check');
  recordScenario(m, {
    domain: 'demo',
    id: 'a',
    contentHash: 'h',
    title: 'A covered test',
    tags: [],
    verdict: 'covered',
    reason: 'an existing test already checks this: "B"',
  });
  recordScenario(m, {
    domain: 'demo',
    id: 'b',
    contentHash: 'h2',
    title: 'A generated test',
    tags: [],
    verdict: 'generated',
    reason: 'new',
  });

  const digest = renderDigestSummary(m, 'demo');
  const coveredLine = digest.split('\n').find((line) => line.includes('A covered test'));
  assert(coveredLine !== undefined, 'the covered scenario must be named in the summary');
  assert(coveredLine!.includes('covered'), 'the covered scenario must show its verdict');
  assert(digest.includes('A generated test'), 'the generated scenario must be named too');
  assert(digest.includes('an existing test already checks this'), 'the reason must be shown');
  assert(
    digest.includes('no test written'),
    'the legend must spell out what "covered" means, or the word is still opaque',
  );
});

check('scenario tags reach the test call, so --grep filters by tag not by title', () => {
  // Tags are declared in the scenario file and used by the planner's --grep. If
  // they never reach the test call, a run narrows by TITLE instead — and drops a
  // test silently the moment a generated title disagrees with the scenario title.
  const tagged = applyScenarioTags(
    `test('A title', async ({ page }) => {\n  const p = new P(page);\n});`,
    ['@smoke', '@core'],
  );
  assert(
    tagged.startsWith(`test('A title', { tag: ['@smoke', '@core'] }, async`),
    `the tag option must be inserted after the title, got:\n${tagged}`,
  );
  assert(tagged.includes('const p = new P(page);'), 'the body must survive the transform');

  // Idempotent: the refresh runs on every block on every run.
  assert(applyScenarioTags(tagged, ['@smoke', '@core']) === tagged, 're-applying is a no-op');

  // A tag the scenario no longer has must be REPLACED, not merged — otherwise a
  // test the scenario files under @regression keeps running inside a @core run.
  const retagged = applyScenarioTags(tagged, ['@regression']);
  assert(
    retagged.startsWith(`test('A title', { tag: ['@regression'] }, async`),
    `a stale tag must be replaced, got:\n${retagged}`,
  );

  // Other option keys are preserved.
  const annotated = applyScenarioTags(
    `test('T', { annotation: { type: 'x' }, tag: ['@old'] }, async ({ page }) => {});`,
    ['@core'],
  );
  assert(
    annotated.includes('annotation: { type: \'x\' }') &&
      annotated.includes(`tag: ['@core']`) &&
      !annotated.includes('@old'),
    `other options survive and the tag is replaced, got:\n${annotated}`,
  );

  // `test.fixme` work orders carry tags too, or a blocked scenario cannot be
  // selected by a tiered run at all.
  const fixme = applyScenarioTags(`test.fixme('B', async ({ page }) => {});`, ['@core']);
  assert(
    fixme.startsWith(`test.fixme('B', { tag: ['@core'] }, async`),
    `test.fixme must be tagged, got:\n${fixme}`,
  );

  // An ESCAPED quote in the title must not end the string literal early.
  const escaped = applyScenarioTags(`test('It\\'s fine', async ({ page }) => {});`, ['@core']);
  assert(
    escaped.startsWith(`test('It\\'s fine', { tag: ['@core'] }, async`),
    `an escaped quote in the title must survive, got:\n${escaped}`,
  );

  // A double-quoted title is fine too.
  const dquoted = applyScenarioTags(`test("A title", async ({ page }) => {});`, ['@smoke']);
  assert(
    dquoted.startsWith(`test("A title", { tag: ['@smoke'] }, async`),
    `the original quoting must be preserved, got:\n${dquoted}`,
  );

  // A multi-line block (work-order comment above the call) is still found.
  const workOrder = applyScenarioTags(
    `// @unbuildable:expectThing\n// WORK ORDER for stage 4\ntest.fixme('C', async ({ page }) => {});`,
    ['@core'],
  );
  assert(
    workOrder.includes(`test.fixme('C', { tag: ['@core'] }, async`) &&
      workOrder.includes('// WORK ORDER for stage 4'),
    `a work-order block must be tagged in place, got:\n${workOrder}`,
  );

  // Unparseable input is left alone: a mangled test is worse than an untagged one.
  const foreign = 'const x = 1;';
  assert(applyScenarioTags(foreign, ['@core']) === foreign, 'unknown shapes must be untouched');

  const untagged = `test('D', async ({ page }) => {});`;
  assert(applyScenarioTags(untagged, []) === untagged, 'no tags in, no tag option out');
});

check('heal-apply folds a recorded heal into the locator file, and names its skips', async () => {
  // The healer was unreachable for the whole life of this repo: no spec imported
  // the fixture, nothing called attemptHeal, and stage 7 therefore only ever ran
  // its empty path while reporting success. This drives the writer directly, so
  // the folding is proven rather than assumed.
  const dir = 'artifacts/run/heal-check';
  const file = `${dir}/scratch-pom.ts`;
  const abs = rehydrate(file);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(
    abs,
    `export const sel = {\n  heading: page.locator('h1.legacy-hero'),\n};\n`,
    'utf8',
  );

  const heal: HealRecord = {
    file,
    brokenLocator: `page.locator('h1.legacy-hero')`,
    healedLocator: `page.locator('h1')`,
    strategy: 'css-narrowing',
    observed: 'resolved to 0 elements',
    tests: ['demo › a healed locator'],
    outcome: 'test-passed',
    at: '2026-01-01T00:00:00.000Z',
  };

  const outcome = await applyHeals([heal]);
  assert(outcome.applied.length === 1, 'the heal must apply');
  assert(outcome.skipped.length === 0, 'nothing should be skipped');
  const patched = await readFile(abs, 'utf8');
  assert(patched.includes(`page.locator('h1')`), 'the file must carry the healed locator');
  assert(!patched.includes('legacy-hero'), 'the broken locator must be gone');

  // Re-applying is a no-op that says why, rather than rewriting the file.
  const again = await applyHeals([heal]);
  assert(again.applied.length === 0, 'a second apply must not rewrite the file');
  assert(
    again.skipped[0]?.reason === 'broken locator not present in file',
    `a re-apply must be skipped with a reason, got: ${again.skipped[0]?.reason}`,
  );

  // A record whose file is gone is skipped with a named reason, never silently.
  const missing = await applyHeals([{ ...heal, file: `${dir}/nope.ts` }]);
  assert(
    missing.skipped[0]?.reason === 'file not found',
    `a missing file must be named, got: ${missing.skipped[0]?.reason}`,
  );

  await rm(dir, { recursive: true, force: true });
});

check('only a repair a passing test backed may be written into the source', async () => {
  // The one rule here that can corrupt a file. Writing a repair whose test FAILED
  // puts a locator we have evidence against into the source, and the next run is
  // green on it — the failing test gone, the wrong locator committed, nothing said.
  const dir = 'artifacts/run/heal-check';
  const file = `${dir}/repairable.ts`;
  const abs = rehydrate(file);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `export const sel = {\n  a: page.locator('h1.legacy-hero'),\n};\n`, 'utf8');

  const record: HealRecord = {
    file,
    brokenLocator: `page.locator('h1.legacy-hero')`,
    healedLocator: `page.locator('h1')`,
    strategy: 'css-narrowing',
    observed: 'resolved to 0 elements',
    tests: ['demo › a healed locator'],
    outcome: 'test-passed',
    at: '2026-01-01T00:00:00.000Z',
  };
  const disproven: HealRecord = { ...record, healedLocator: `page.locator('h2')`, outcome: 'test-failed' };
  const unproven: HealRecord = { ...record, healedLocator: `page.locator('h3')`, outcome: 'unknown' };

  const allowed = repairable([record, disproven, unproven]);
  assert(allowed.length === 1, `only the verified repair may be applied, got ${allowed.length}`);
  assert(allowed[0]?.healedLocator === record.healedLocator, 'and it must be the verified one');

  const outcome = await applyHeals(allowed);
  assert(outcome.applied.length === 1, 'the verified repair applies');
  const patched = await readFile(abs, 'utf8');
  assert(patched.includes(`page.locator('h1')`), 'the verified locator must be written');
  assert(
    !patched.includes(`page.locator('h2')`) && !patched.includes(`page.locator('h3')`),
    'a disproven or unproven locator must NOT be written',
  );

  await rm(dir, { recursive: true, force: true });
});

check('a repair is only verified by the test that used it', () => {
  // A heal record without its outcome is a claim nobody checked: a test that passed
  // ON a repaired locator looked exactly like a healthy pass, so we could be green
  // on a repair that addressed the wrong element.
  const manifest = new HealManifest();
  const heal = {
    file: 'src/page-objects/landing-page/index.ts',
    brokenLocator: "'Marco and Product Photographer'",
    healedLocator: "'Macro and Product Photographer'",
    strategy: 'text-fallback' as const,
    observed: 'resolved to 0 elements',
  };

  manifest.beginTest('landing-page › The hero shows the headline and tagline');
  manifest.add(heal);
  manifest.endTest('passed');
  assert(manifest.records[0]?.outcome === 'test-passed', 'a passing test verifies the repair');
  assert(
    manifest.records[0]?.tests[0] === 'landing-page › The hero shows the headline and tagline',
    'the repair must name the test that used it',
  );
  assert(manifest.records[0]?.observed === 'resolved to 0 elements', 'the failure that prompted it is kept');

  // The same repair used by a second test that fails: one failing use disproves it.
  manifest.beginTest('landing-page › Some other test');
  manifest.add(heal);
  manifest.endTest('failed');
  assert(manifest.records.length === 1, 'the same repair is still one record');
  assert(manifest.records[0]?.outcome === 'test-failed', 'a failing use must outweigh a passing one');
  assert(manifest.records[0]?.tests.length === 2, 'every use of the repair is recorded');

  // A repair no finished test used proves nothing.
  const orphan = new HealManifest();
  orphan.beginTest('landing-page › Interrupted');
  orphan.add(heal);
  assert(orphan.records[0]?.outcome === 'unknown', 'an unfinished test proves nothing');

  // `unknown` means "nobody said", so it must yield to a later passing use rather
  // than stick: one interrupted test cannot blacken a repair the next one backed.
  const laterUse = new HealManifest();
  laterUse.beginTest('landing-page › First');
  laterUse.add(heal);
  laterUse.endTest(undefined);
  laterUse.beginTest('landing-page › Second');
  laterUse.add(heal);
  laterUse.endTest('passed');
  assert(
    laterUse.records[0]?.outcome === 'test-passed',
    'a later passing use must upgrade `unknown`, not be blocked by it',
  );
  assert((laterUse.records[0]?.tests.length ?? 0) === 2, 'both uses are recorded, finished or not');

  // A refusal is annotated the same way, because "a locator was refused" is only
  // alarming next to whether the test that hit it went red — the late-render refusal
  // (the element appeared a moment later) is otherwise indistinguishable from a real
  // breakage.
  const refuser = new HealManifest();
  const refusal = {
    file: heal.file,
    brokenLocator: "'Explore Niches'",
    reason: 'no-candidate' as const,
    detail: 'resolved to 0 elements; nearest copy "Explore My Work" (0.53) is below the 0.85 floor',
  };
  refuser.beginTest('landing-page › The niches section lists the default collection with filters');
  refuser.refuse(refusal);
  refuser.refuse(refusal);
  assert(refuser.refusals.length === 1, 'a refusal repeated within a test stays one record');
  refuser.endTest('passed');
  assert(refuser.refusals[0]?.outcome === 'test-passed', 'a refusal the test got past must say so');
  assert(refuser.refusals[0]?.tests.length === 1, 'a refusal must name the test that hit it');
});

check('the builder records a fact once, not a diary of runs', async () => {
  // An instruction file is append-only DOMAIN CONTEXT and stage 2/3 read it back to
  // generate test cases, so a builder may add facts and nothing else. The stub used to
  // stamp a timestamped section with the page's body text on every invocation: three
  // runs left three near-identical sections in the landing-page file and each later run
  // added another — unbounded growth, on disk and in the prompt. A timestamp also makes
  // "is this new?" always answer yes, so nothing was ever recognised as known.
  const facts = ['- Entry page: https://example.test/en', '- Page title: Example'];
  const first = freshObservationLines('', facts);
  assert(
    first.length === facts.length + 1 && first[0] === OBSERVATION_HEADING,
    `the first run must record the facts under a heading, got: ${JSON.stringify(first)}`,
  );

  const file = `# dom — instruction file\n\n${first.join('\n')}\n`;
  assert(
    freshObservationLines(file, facts).length === 0,
    'a run that learns nothing new must append nothing at all',
  );
  const withWorkOrder = ['- Entry page: https://example.test/en', '- Builder work order: expectHero()'];
  assert(
    freshObservationLines(file, withWorkOrder).join('\n') ===
      `${OBSERVATION_HEADING}\n- Builder work order: expectHero()`,
    'only the new fact may be appended, under the heading',
  );
  assert(freshObservationLines('', []).length === 0, 'no facts, nothing appended');

  // And the stub itself must use it: a per-run timestamp reintroduces the diary whether
  // or not the dedupe exists beside it.
  const src = stripComments(await readFile(rehydrate('src/agent/cdp-builder-stub.ts'), 'utf8'));
  assert(
    src.includes('freshObservationLines(known, facts)'),
    'the stub must dedupe its facts against what the file already says',
  );
  assert(!src.includes('new Date()'), 'the stub must not stamp a section per run');
});

check('the healing fixture says what it healed, where a person actually looks', async () => {
  // The outcome above only matters if it is READ. A repaired test is otherwise
  // indistinguishable from a healthy one: the console says "1 passed" and the report
  // shows an unremarkable green test, so the healer's work would live solely in a JSON
  // artifact nobody opens. Two things make it visible — an annotation on the test (the
  // HTML report and the trace viewer show it) and a line in the console at worker
  // teardown — and both are dropped silently if the wiring goes, which is the rule for
  // adding a check here.
  const src = stripComments(await readFile(rehydrate('src/runtime/self-heal-fixture.ts'), 'utf8'));
  assert(
    src.includes("annotations.push({ type: 'heal'"),
    'a repaired test must carry a heal annotation, or the report shows nothing',
  );
  assert(
    src.includes("annotations.push({ type: 'heal-refused'"),
    'a refusal must be visible on the test too, not only in heals.json',
  );
  assert(
    src.includes('healReportLines(manifest.records, manifest.refusals)'),
    'the worker must print what it healed, not only write it to heals.json',
  );

  // What those two read from: `endTest` hands back exactly what THIS test touched, so
  // one test can never be annotated with another test's heal.
  const manifest = new HealManifest();
  const heal = {
    file: 'src/page-objects/landing-page/index.ts',
    brokenLocator: "'Marco and Product Photographer'",
    healedLocator: "'Macro and Product Photographer'",
    strategy: 'text-fallback' as const,
    observed: 'resolved to 0 elements',
  };
  manifest.beginTest('landing-page › The hero shows the headline and tagline');
  manifest.add(heal);
  const touched = manifest.endTest('passed');
  assert(touched.heals.length === 1, 'the test that used the repair must get it back to announce');
  assert(touched.refusals.length === 0, 'a test that refused nothing announces no refusal');

  manifest.beginTest('landing-page › A test that healed nothing');
  const quiet = manifest.endTest('passed');
  assert(
    quiet.heals.length === 0 && quiet.refusals.length === 0,
    'a healthy test must be handed nothing, so a green run annotates nothing',
  );

  // The lines themselves. A repair names what broke, what it became, and whether the
  // assertion backed it — `test-passed` is the whole point.
  const record: HealRecord = { ...heal, tests: [], outcome: 'test-passed', at: '2026-10-19T00:00:00.000Z' };
  assert(
    healNote(record) ===
      "'Marco and Product Photographer' → 'Macro and Product Photographer' (the test passed on it)",
    `a verified repair must read as one, got: ${healNote(record)}`,
  );
  assert(
    healNote({ ...record, outcome: 'test-failed' }).includes('FAILED'),
    'a repair the test went red on must not read like a verified one',
  );
  assert(
    refusalNote({
      file: heal.file,
      brokenLocator: "'Explore Niches'",
      reason: 'no-candidate',
      detail: 'nearest copy "Explore My Work" (0.53) is below the 0.85 floor',
      tests: [],
      outcome: 'unknown',
      at: '2026-10-19T00:00:00.000Z',
    }).includes('no-candidate'),
    'a refusal must carry its reason',
  );
  assert(healReportLines([], []).length === 0, 'a clean run must print nothing at all');
  assert(
    (healReportLines(touched.heals, touched.refusals)[0] ?? '').includes('1 locator repaired'),
    'the printed block must say how much was healed',
  );
});

check('the summary shows the repair, the failure behind it, and whether it held', () => {
  const m = newManifest('check-heals');
  const report = buildReport(m, new Date());
  const heal = {
    file: 'src/page-objects/landing-page/index.ts',
    brokenLocator: "'Marco and Product Photographer'",
    healedLocator: "'Macro and Product Photographer'",
    observed: 'resolved to 0 elements; nearest copy "Macro and Product Photographer" (0.93)',
    tests: ['landing-page › The hero shows the headline and tagline'],
    outcome: 'test-passed',
  };
  const refusal = {
    brokenLocator: "'Fair Rates, No Surprises'",
    reason: 'ambiguous',
    detail: 'two candidates are a coin toss',
    tests: ['landing-page › The pricing section lists all six packages'],
    outcome: 'test-failed',
  };

  const markdown = renderRunSummary(m, report, { heals: [heal], refusals: [refusal] });
  assert(markdown.includes('## Locator heals'), 'the report needs a place for the healer');
  assert(markdown.includes('resolved to 0 elements'), 'the failure that prompted the repair must be shown');
  assert(markdown.includes('**verified**'), 'the outcome must be shown, not just the repair');
  assert(
    markdown.includes('The hero shows the headline and tagline'),
    'the repair must name the test it happened in',
  );
  assert(markdown.includes('ambiguous'), 'a refusal must be shown with its reason');
  assert(
    markdown.includes('this is where it broke'),
    'a refusal the test went red on must say so — the refusal is the explanation',
  );

  // A refusal the test got past is NOT the same story, and must not read as one.
  const moot = renderRunSummary(m, report, {
    heals: [],
    refusals: [{ ...refusal, outcome: 'test-passed' }],
  });
  assert(moot.includes('passed anyway'), 'a refusal the test sailed past must say so');

  // A repair the assertion did NOT back must not read as a success.
  const failed = renderRunSummary(m, report, { heals: [{ ...heal, outcome: 'test-failed' }], refusals: [] });
  assert(failed.includes('not verified'), 'a repair whose test failed must say so');

  // Nothing healed, nothing refused: no section, rather than an empty one.
  assert(!renderRunSummary(m, report, { heals: [], refusals: [] }).includes('## Locator heals'), 'a clean run says nothing about heals');
  assert(!renderRunSummary(m, report).includes('## Locator heals'), 'the healer section is optional');
});

check('a save merges within one run and replaces another run', async () => {
  // One run is NOT one process: Playwright restarts the worker after a failing test,
  // and each worker builds its own collector. Saving as an overwrite let the second
  // worker's teardown erase the first worker's repairs, so a run with a single
  // failing test lost exactly the heals it most needed to report — silently.
  await withScratchHeals(async () => {
    const path = rehydrate('artifacts/run/heals.json');
    const heal = {
      file: 'src/page-objects/landing-page/index.ts',
      brokenLocator: "'Macroz and Product Photographer'",
      healedLocator: "'Macro and Product Photographer'",
      strategy: 'text-fallback' as const,
      observed: 'resolved to 0 elements',
    };

    // Worker 1 records a repair and saves.
    const worker1 = new HealManifest();
    worker1.beginTest('demo › one');
    worker1.add(heal);
    worker1.endTest('passed');
    await worker1.save();

    // Worker 2 — the restart after a failing test — records a different repair.
    const worker2 = new HealManifest();
    worker2.beginTest('demo › two');
    worker2.add({
      ...heal,
      brokenLocator: "'Priicng'",
      healedLocator: "'Pricing'",
      observed: 'resolved to 0 elements; nearest copy "Pricing" (0.86)',
    });
    worker2.endTest('failed');
    await worker2.save();

    const merged = await HealManifest.loadReport();
    assert(merged.heals.length === 2, `both workers' repairs must survive, got ${merged.heals.length}`);
    assert(
      merged.heals.some((r) => r.outcome === 'test-passed'),
      "the first worker's repair must keep its outcome",
    );
    assert(
      merged.heals.some((r) => r.outcome === 'test-failed'),
      "the second worker's repair must keep its outcome",
    );

    // An empty worker — the common restart — must not erase what the run recorded.
    await new HealManifest().save();
    assert((await HealManifest.loadReport()).heals.length === 2, 'an empty save must not erase the run');

    // The same repair in both workers is ONE repair, and the worse outcome wins.
    const shared = new HealManifest();
    shared.beginTest('demo › three');
    shared.add(heal);
    shared.endTest('failed');
    await shared.save();
    const remerged = await HealManifest.loadReport();
    const same = remerged.heals.filter((r) => r.brokenLocator === heal.brokenLocator);
    assert(same.length === 1, `the same repair is one record across workers, got ${same.length}`);
    assert(same[0]?.outcome === 'test-failed', 'a failing use outweighs an earlier passing one');
    assert((same[0]?.tests.length ?? 0) === 2, 'both uses must be recorded');

    // A file from ANOTHER run is replaced, not merged: a stale repair read as this
    // run's would have stage 7 applying a heal that never happened here.
    await writeFile(
      path,
      JSON.stringify({
        run: 'some other run',
        heals: [
          {
            file: 'src/x.ts',
            brokenLocator: 'a',
            healedLocator: 'b',
            strategy: 'attribute',
            observed: '',
            tests: [],
            outcome: 'test-passed',
            at: 'x',
          },
        ],
        refusals: [],
      }),
      'utf8',
    );
    await new HealManifest().save();
    assert((await HealManifest.loadReport()).heals.length === 0, 'a previous run must not merge in');
  });
});

check('a missing heal manifest is empty; a malformed one is not swallowed', async () => {
  // `HealManifest.load()` used to catch everything, so a heal record carrying an
  // absolute path — the invariant this repo is strictest about — read as "no
  // heals this run" on the one file the healer is judged by.
  await withScratchHeals(async () => {
    // Each state is created here, not assumed: heals.json is a real artifact that a
    // previous run may well have populated, and a check that reads the ambient file
    // fails for a reason that has nothing to do with the code under test.
    await rm(rehydrate('artifacts/run/heals.json'), { force: true });
    const absent = await HealManifest.loadReport();
    assert(
      absent.heals.length === 0 && absent.refusals.length === 0,
      'a missing manifest is an empty report',
    );

    await writeFile(
      rehydrate('artifacts/run/heals.json'),
      JSON.stringify([
        { file: 'C:/absolute/path.ts', brokenLocator: 'a', healedLocator: 'b', strategy: 'attribute', at: 'x' },
      ]),
      'utf8',
    );
    let threw = false;
    try {
      await HealManifest.load();
    } catch {
      threw = true;
    }
    assert(threw, 'an absolute path in a heal record must throw, not read as "no heals"');
  });
});

check('a narrowed run says what it does NOT run', () => {
  // "9 passed" reads as "everything passed". A tier is a filter, and a filter
  // that drops tests without saying so is the failure this report exists to
  // prevent — so the summary must name the tier and what falls outside it.
  const m = newManifest('check');
  recordScenario(m, {
    domain: 'demo',
    id: 'a',
    contentHash: 'h',
    title: 'A core test',
    tags: ['@core'],
    verdict: 'held',
    reason: 'unchanged',
  });
  recordScenario(m, {
    domain: 'demo',
    id: 'b',
    contentHash: 'h2',
    title: 'A regression test',
    tags: ['@regression'],
    verdict: 'held',
    reason: 'unchanged',
  });
  m.domains.push({
    domain: 'demo',
    scope: null,
    unbuildable: [],
    builder: null,
    tier: 'sanity',
    grep: '@smoke|@core',
    playwright: null,
    healApply: null,
  });

  const summary = renderRunSummary(m, buildReport(m, new Date()));
  assert(summary.includes('Narrowed run'), 'the summary must admit the run was narrowed');
  assert(
    summary.includes('1 scenario(s) tagged @regression are NOT run'),
    'the summary must name exactly which scenarios are left out',
  );
  assert(
    summary.includes('generated in this run, which always run'),
    'the note must say the floor overrides the filter, or a reader believes the new tests were skipped',
  );
});

check('existing-title extraction ignores the describe block name', () => {
  // `test.describe('landing-page', ...)` is not a test title. Handing it to the
  // classifier as an existing scenario lets a scenario be judged "already
  // covered" by a describe block that asserts nothing — a silent drop.
  const spec = [
    `import { test } from '@playwright/test';`,
    `test.describe('landing-page', () => {`,
    `  test('A real test', async () => {});`,
    `  test.fixme('A work-order test', async () => {});`,
    `  test.skip('A skipped test', async () => {});`,
    `});`,
    ``,
  ].join('\n');
  const titles = collectExistingTitles(spec);
  assert(titles.includes('A real test'), 'a real test title must be collected');
  assert(titles.includes('A work-order test'), 'test.fixme titles must be collected');
  assert(titles.includes('A skipped test'), 'test.skip titles must be collected');
  assert(
    !titles.includes('landing-page'),
    `the describe name leaked into existing titles: ${titles.join(', ')}`,
  );
});

check('each domain’s instruction.md lives inside its pomDir', async () => {
  // The domain context travels with the page object, and the builder's
  // write-scope guard (allowedDirs = pomDir) already covers it. Move it outside
  // pomDir and the POM and its context silently drift apart.
  const map = await loadDomainMap();
  const offenders: string[] = [];
  for (const [key, entry] of map) {
    const file = instructionFileFor(entry);
    if (!file.startsWith(`${entry.pomDir}/`)) offenders.push(`${key}: ${file}`);
  }
  assert(
    offenders.length === 0,
    `instruction.md must sit inside pomDir, but: ${offenders.join(', ')}`,
  );
});

// -----------------------------------------------------------------------------

// --- Debug logging ------------------------------------------------------------
// The rule for a check is "the failure would be SILENT". Debug going missing is
// exactly that: the run still passes and there is simply nothing to read when it
// misbehaves. A leaked secret in a clipped value is the other silent one — the
// console looks fine while the log carries a key.

check('debug truncation keeps long input readable, and says what it cut', () => {
  const long = 'x'.repeat(500);
  const flat = ellipsize(long, 100);
  assert(flat.startsWith('x'.repeat(100)), 'the head of the value must be kept');
  assert(flat.endsWith('… (+400 chars)'), `the cut must be quantified, got: ${flat.slice(-24)}`);
  assert(ellipsize('short', 100) === 'short', 'a value under the cap is untouched');
  assert(ellipsize('a\nb\tc', 100) === 'a b c', 'whitespace collapses to one line');

  const block = clampBlock(`line1\nline2\n${long}`, 20);
  assert(block.truncated, 'an over-long body must report the cut');
  assert(block.text.length <= 20, 'a body must not exceed its cap');
  assert(!clampBlock('fits', 20).truncated, 'a body under the cap is not truncated');

  // A cut must not split a surrogate pair (an emoji), or the output is not text.
  assert(
    ellipsize('😀'.repeat(10), 3).replace(/….*$/, '') === '😀',
    'a surrogate pair must never be cut in half',
  );
});

check('debug renders values legibly, and a secret never reaches the log', () => {
  assert(renderValue('a\nb') === '"a b"', 'a multi-line value collapses to one line');
  assert(renderValue(['@core', '@smoke']) === '["@core", "@smoke"]', 'an array is a compact list');
  assert(renderValue(42) === '42' && renderValue(true) === 'true', 'scalars render bare');
  assert(renderValue({ a: 1 }).includes('"a":1'), 'an object renders as JSON');
  assert(renderValue(undefined) === 'undefined', 'undefined is named, not left blank');

  // The logger redacts the whole line, so a token inside a field cannot leak.
  const leaked = redact(`[debug] x token=${renderValue('sk-abcdefghijklmnopqrstuvwxyz')}`);
  assert(
    !leaked.includes('sk-abcdefghijklmnopqrstuvwxyz'),
    'a secret must be redacted before a debug line is printed',
  );
});

check('DEBUG is a parsed toggle, and a malformed value throws', () => {
  // A flag that silently reads as off is a flag someone will swear they turned on.
  assert(parseBooleanFlag('DEBUG', 'true') === true, 'true is on');
  assert(parseBooleanFlag('DEBUG', '1') === true, '1 is on');
  assert(parseBooleanFlag('DEBUG', 'OFF') === false, 'off is off, case-insensitively');
  assert(parseBooleanFlag('DEBUG', undefined) === false, 'unset is off');
  let threw = false;
  try {
    parseBooleanFlag('DEBUG', 'maybe');
  } catch {
    threw = true;
  }
  assert(threw, 'a malformed DEBUG must throw, not silently read as off');
});

check('TEST_GREP is an operator override, never a standing CI default', async () => {
  // An override belongs to a person, for one run. It may therefore appear as a
  // workflow_dispatch input — that is someone typing it when they press Run — but never
  // sourced from a repository variable or a literal, which would pin EVERY run to one
  // filter and the pipeline would quietly stop planning. The same class of exception as
  // HEAL_RUN_ID: per-run, not configuration.
  const example = await readFile(rehydrate('.env.example'), 'utf8');
  const workflow = await readFile(rehydrate('.github/workflows/pipeline.yml'), 'utf8');
  assert(example.includes('TEST_GREP'), '.env.example must document the override');
  // What is forbidden is a STANDING SOURCE, and only an assignment has one. Two shapes
  // assign it, and only these:
  //     NAME: <value>        YAML block style — how step env is set here
  //     NAME=<value> cmd     shell prefix assignment
  // A bare `${TEST_GREP:-}` or `$TEST_GREP` in a log line assigns nothing and is allowed,
  // so matching every mention would fail the workflow's own progress echo.
  //
  // TEST_GREP_SOURCE is checked with it because hardcoding it to 'input' would silently
  // switch off stage 5's leftover detection: every stray override would then read as a
  // deliberate one, which is a green report for a run nobody meant to narrow.
  const assignmentsOf = (name: string, line: string): string | null => {
    const yaml = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`).exec(line);
    if (yaml) return yaml[1] ?? '';
    const shell = new RegExp(`(?:^|[\\s;(])${name}=(\\S.*)$`).exec(line);
    if (shell) {
      const value = shell[1] ?? '';
      if (new RegExp(`^\\$\\{?${name}\\b`).test(value)) return null; // a self-reference is not a source
      return value;
    }
    return null;
  };
  for (const name of ['TEST_GREP', 'TEST_GREP_SOURCE']) {
    for (const line of workflow.split('\n')) {
      const value = assignmentsOf(name, line);
      if (value === null) continue;
      assert(
        /\$\{\{\s*inputs\./.test(value),
        `${name} may only be assigned from a run-time input, never a vars./secret/literal value: ${line.trim()}`,
      );
    }
  }
  // And the manual door has to exist, or a human has no way in without a PR.
  assert(/workflow_dispatch:/.test(workflow), 'the workflow must be startable by hand');
});

check('a child is not handed our DEBUG, which it may read as its own switch', async () => {
  // `DEBUG` is a generic name and gh honours it as its trace switch (an alias for
  // GH_DEBUG). Leaking it appended an HTTP trace to stderr, which merged into the diff
  // stage 1 hands the model: nothing failed, the model just read noise. Silent, therefore
  // checked. This is the general shape of the hazard for any third-party CLI we spawn.
  const src = await readFile(rehydrate('src/delivery/github.ts'), 'utf8');
  const start = src.indexOf('function ghEnv(');
  assert(start >= 0, 'ghEnv() must remain the single place a gh child environment is built');
  const next = src.indexOf('\nfunction ', start + 1);
  const fn = src.slice(start, next === -1 ? undefined : next);
  assert(/DEBUG:\s*''/.test(fn), "ghEnv() must clear DEBUG — gh reads it as GH_DEBUG and traces HTTP");
  assert(/GH_DEBUG:\s*''/.test(fn), 'ghEnv() must clear GH_DEBUG too, which is the same switch');
});

check('the PR step asks gh only for flags gh has', async () => {
  // `gh pr create` prints the PR URL and has no `--json` — that flag belongs to `pr view`. Asking
  // for it made every stage-8 PR step die with "unknown flag: --json" before gh had looked at the
  // repository at all, so the pipeline had never opened a pull request in any environment.
  const host = stripComments(await readFile(rehydrate('src/delivery/github.ts'), 'utf8'));
  const from = host.indexOf("'pr', 'create'");
  const to = host.indexOf("'pr', 'comment'");
  assert(from >= 0 && to > from, 'openPr must call `gh pr create`, before commentOnPr');
  const create = host.slice(from, to);
  assert(!/'--json'/.test(create), 'gh pr create takes no --json — the URL is the parsed result');
  assert(/res\.stdout/.test(create), 'and that result is read from stdout, where the data is');
});

check('a runtime-built delivery argument is never handed to a shell', async () => {
  // The commit message and the PR body are built at run time, spaces and newlines included, and a
  // shell re-parses those into separate argv entries. Stage 8's commit died with four unknown
  // pathspecs — "generated", "+", "healed", "locators" — on a run that had otherwise succeeded,
  // and `--title`/`--body` would have gone the same way one step later. `git` and `gh` are real
  // executables, so no shell is needed to find either.
  const host = stripComments(await readFile(rehydrate('src/delivery/github.ts'), 'utf8'));
  assert(/const NO_SHELL = \{ shell: false \}/.test(host), 'NO_SHELL must actually be no-shell');
  const calls = host.split('runStageProcess(').slice(1);
  assert(calls.length >= 3, `git and gh must go through runStageProcess — found ${calls.length} call(s)`);
  for (const call of calls) {
    const opts = call.slice(0, 400);
    assert(
      opts.includes('NO_SHELL') || opts.includes('shell: false'),
      'every git/gh invocation must disable the shell, or a runtime-built argument is re-split',
    );
  }

  // And a spawn FAILURE must come back as a failed process rather than an unhandled `error` event:
  // before this, a machine with no `gh` on PATH took the whole run down instead of failing the one
  // stage that asked for it — which is also what makes `shell: false` safe to demand above.
  const missing = await runStageProcess('tcgen-no-such-executable-xyz', ['--version'], {
    timeoutMs: 20_000,
    shell: false,
  });
  assert(
    !missing.ok && /failed to run/.test(missing.output),
    `a spawn failure must resolve as a failed process: ok=${missing.ok} ${missing.output.slice(0, 120)}`,
  );
});

check('a parsed result comes from stdout, never the merged stream', async () => {
  // `output` merges stderr for a human reading a failure; stderr is diagnostics, and
  // tools write warnings there as a matter of course. Parsing it as data turns chatter
  // into a parse error, or — worse, and silently — into noise inside a payload like the
  // diff. So a result is read from `stdout`, and the merge stays for error messages only.
  const runner = await readFile(rehydrate('src/core/orchestration/stage-runner.ts'), 'utf8');
  assert(
    /stdout:\s*redact\(stdout\)/.test(runner),
    'runStageProcess must expose stdout separately from the merged output',
  );
  const gh = await readFile(rehydrate('src/delivery/github.ts'), 'utf8');
  assert(!/JSON\.parse\(res\.output\)/.test(gh), 'never parse JSON from the merged stdout+stderr');
  assert(/return res\.stdout/.test(gh), 'the code host must return stdout as its data');
  const git = await readFile(rehydrate('src/stages/08-git.ts'), 'utf8');
  assert(
    !/status\.output\.trim\(\) === ''/.test(git),
    'the shippable check must read stdout: a git warning on stderr would look like a change to push',
  );
});

check('debug is registered where a run can read it, and is actually emitted', async () => {
  // A variable must exist in the CI definition, the container env and .env.example
  // (pipeline-pattern.md §5). Missing from the CI definition, debug is silently off
  // exactly where it is hardest to turn back on.
  const example = await readFile(rehydrate('.env.example'), 'utf8');
  const workflow = await readFile(rehydrate('.github/workflows/pipeline.yml'), 'utf8');
  assert(example.includes('DEBUG'), '.env.example must document DEBUG');
  assert(workflow.includes('DEBUG'), 'the CI definition must register DEBUG');

  // And the two paths a run is followed through must emit: the AI call and the
  // page objects. A POM that never calls the logger is progress nobody can see.
  const model = stripComments(await readFile(rehydrate('src/ai/model-client.ts'), 'utf8'));
  assert(model.includes('debugAiRequest('), 'the AI request must be debuggable');
  assert(model.includes('debugAiResponse('), 'the AI response must be debuggable');

  const poms = await listRepoFiles('src/page-objects', (f) => f.endsWith('.ts'));
  for (const pom of poms) {
    const src = stripComments(await readFile(rehydrate(pom), 'utf8'));
    assert(
      src.includes('core/util/debug.js'),
      `${pom} must narrate itself through the debug logger`,
    );
  }
});

// -----------------------------------------------------------------------------

check('a source repo can differ from the work repo that delivers', async () => {
  // The product CICD triggers this pipeline after its own deploy and passes the testing
  // context, so the PR stage 1 reads lives in the SOURCE repo while the branch, push and PR
  // happen in the WORK repo. One slug cannot serve both: reading the change with the work
  // slug looks for PR #N in the wrong repository — failing, or worse, reading a number that
  // happens to exist in both and testing the wrong change under a green report.
  const github = stripComments(await readFile(rehydrate('src/delivery/github.ts'), 'utf8'));
  const fetchSource = github.slice(github.indexOf('fetchSource('), github.indexOf('createBranch('));
  const openPr = github.slice(github.indexOf('openPr('), github.indexOf('private async gh('));
  const commentOnPr = github.slice(github.indexOf('commentOnPr('), github.indexOf('private async gh('));
  // Everything that addresses the CHANGE UNDER TEST resolves the source repo…
  assert(fetchSource.includes('sourceRepoSlug()'), 'fetchSource must read the SOURCE repo slug');
  assert(
    commentOnPr.includes('sourceRepoSlug()'),
    'a run reports back to the SOURCE PR it analysed, so commentOnPr must resolve the source repo',
  );
  assert(
    !commentOnPr.includes('requireWorkRepoSlug()'),
    'a comment on the source PR must not be addressed to the work repo — that PR number means another change there',
  );
  // …and exactly one method resolves the WORK repo, because exactly one method writes to it.
  assert(openPr.includes('requireWorkRepoSlug()'), 'openPr must open the PR in the WORK repo');
  assert(
    !fetchSource.includes('requireWorkRepoSlug()'),
    'fetchSource must not read the change under test from the WORK repo',
  );
  assert(
    github.includes('env.SOURCE_REPO_SLUG ?? requireWorkRepoSlug()'),
    'the source repo must default to the work repo — the single-repo case needs no config',
  );

  // Both are registered where a run can read them: CI definition, container env, .env.example.
  const example = await readFile(rehydrate('.env.example'), 'utf8');
  const workflow = await readFile(rehydrate('.github/workflows/pipeline.yml'), 'utf8');
  const envSource = await readFile(rehydrate('src/core/util/env.ts'), 'utf8');
  for (const name of ['WORK_REPO_SLUG', 'SOURCE_REPO_SLUG'] as const) {
    assert(example.includes(name), `.env.example must document ${name}`);
    assert(workflow.includes(name), `the CI definition must register ${name}`);
    assert(
      envSource.includes(`optionalEnv('${name}')`),
      `env.ts must read ${name} through optionalEnv`,
    );
  }
});

check('the pipeline never runs on a pull request of its own work repo', async () => {
  // Stage 8 OPENS a PR in the work repo. That is why this workflow must not be triggerable
  // by one: a `pull_request` trigger here would run the pipeline against the generated tests
  // it just opened for review, generate more from that diff, and open a further PR — a loop
  // fed by every delivery, each round under a green report. The run happens on a DEPLOYMENT,
  // triggered by the product CICD with its testing context.
  const workflow = await readFile(rehydrate('.github/workflows/pipeline.yml'), 'utf8');
  const onBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert(
    !onBlock.includes('pull_request'),
    'the workflow must not trigger on pull_request: stage 8 opens a PR in this repo, so that is a loop',
  );
  assert(onBlock.includes('workflow_dispatch'), 'the pipeline must be startable by dispatch');
  assert(
    workflow.includes('inputs.pr') && workflow.includes('inputs.source_repo'),
    'the testing context (pr + source_repo) must arrive as dispatch inputs',
  );
});

check('the delivery branch is never based on a branch from another repo', async () => {
  // `manifest.branch` is the SOURCE PR's branch. When the change under test lives in another
  // repo that ref does not exist here, so basing the delivery branch on it fails inside git
  // with an error about a branch this repo never had — after the tests have already run.
  const git = stripComments(await readFile(rehydrate('src/stages/08-git.ts'), 'utf8'));
  assert(
    /baseBranch\s*=\s*deliveryBaseBranch\(/.test(git),
    'stage 8 must decide its base branch deliberately (baseBranch = deliveryBaseBranch(ctx))',
  );
  assert(
    !/baseBranch\s*=\s*env\.SOURCE_BRANCH \?\? ctx\.manifest\.branch/.test(git),
    'the source PR branch must not become the delivery base when the source repo is another repo',
  );
});

check('the PR body carries the run scope and what it could not cover, not just pass/fail', () => {
  // The PR body is the durable record: `artifacts/` is gitignored, so the summary and the run
  // report never reach the PR they describe. A reviewer who sees only "6 passed" cannot tell
  // a whole-suite run from a narrowed one, and cannot see a scenario that was left blocked.
  const m = sampleManifest('check-pr-body');

  const body = buildPrBody(m);
  assert(body.includes('tier: **smoke**'), 'the PR body must state the tier the run used');
  assert(body.includes('@smoke|@20261021'), 'the PR body must state the grep that actually ran');
  assert(
    body.includes('NOT run'),
    'a narrowed run must say what its filter left out — a silent narrowing reads as "all passed"',
  );
  assert(
    body.includes('The hero CTA targets the portfolio'),
    'the coverage this run added must be listed, not just counted',
  );
  assert(
    body.includes('expectHeroHeadline()'),
    'a blocked scenario must name what the page object is missing',
  );
  assert(body.includes('6 passed · 1 failed'), 'the test result must be in the body');
  assert(body.includes('Nothing merges itself'), 'the body must state that it is not auto-merged');
  assert(
    body.includes('pipeline-run') && body.includes('artifact'),
    'a failing run must point at the uploaded run record, or "1 failed" is unactionable',
  );
});

check('the report channel carries the result and the scope, so a narrowed run cannot read as "all passed"', () => {
  // A chat message is read on a phone, out of context: "6 passed" alone is indistinguishable
  // from the whole suite passing. It carries the same scope lines the PR body does, for the
  // same reason — a smaller green reported in a different medium is still a smaller green.
  const msg = buildReportMessage(sampleManifest('36bed620'), { sourceRepo: 'yogap02/fotogaper' });
  assert(msg.includes('36bed620'), 'the run id must be in the report');
  assert(msg.includes('fotogaper') && msg.includes('PR #7'), 'the source of the change must be named');
  assert(msg.includes('6 passed · 1 failed'), 'the test result must be in the report');
  assert(msg.includes('tier: <b>smoke</b>'), 'the tier the run used must be stated');
  assert(msg.includes('@smoke|@20261021'), 'the grep that actually ran must be stated');
  assert(
    msg.includes('NOT run'),
    'a narrowed run must say what its filter left out — otherwise the report reads as "all passed"',
  );
  assert(
    msg.includes('The pricing section lists all six packages'),
    'a blocked scenario must be named, not only counted',
  );
  assert(
    msg.includes('expectHeroHeadline()'),
    'and it must name what the page object is missing — "blocked" without what to add is a dead end, and the PR body already says it',
  );
  assert(
    msg.includes('<b>Testing Status:</b> ❌ 1 test failed'),
    'the product status must be stated, labelled, and red when a test failed',
  );
  assert(
    msg.includes('<b>Pipeline Status:</b> ⚠️ 1 scenario(s) blocked'),
    'the process status must be labelled too, and it must name the process problem — the blocked scenario — rather than the failed test',
  );
  assert(
    msg.includes('<code>smoke</code> scope'),
    'a narrowed run must name its scope in the headline, where the tick is',
  );
  assert(
    msg.includes('Not a verdict on the whole suite'),
    'a tick on a narrowed run must be qualified next to itself — a scope line further down is what a reader believes after they have already believed the tick',
  );
  assert(!msg.includes('**'), 'the report is sent as HTML; raw markdown renders as literal asterisks');
  assert(msg.includes('<b>') && msg.includes('<code>'), 'the report must actually use the markup');

  // The other half of the same rule: a run of everything must not cry narrowing.
  const whole = sampleManifest('check-whole-suite');
  whole.domains[0]!.tier = 'regression';
  const wholeMsg = buildReportMessage(whole, {});
  assert(
    !wholeMsg.includes('Not a verdict') && !wholeMsg.includes('scope only'),
    'a run of the whole suite is a verdict on the suite, and must not say otherwise',
  );

  // A scenario title is arbitrary text, so it must not be able to close a tag or open one.
  const risky = sampleManifest('check-escape');
  risky.domains[0]!.unbuildable[0]!.scenario.title = 'The pricing <b>section</b> & all six packages';
  const escaped = buildReportMessage(risky, {});
  assert(
    escaped.includes('&lt;b&gt;') && escaped.includes('&amp;'),
    'a title must be escaped, so it renders as text',
  );
  assert(
    !escaped.includes('<b>section</b>'),
    'a title must not be able to inject markup into the report',
  );

  // Telegram rejects an over-long message wholesale, which would lose the whole report.
  // Every field here is unbounded in principle — a domain list, a title, a reason — so the
  // message is cut with a notice rather than sent as something Telegram will refuse.
  const many = newManifest('check-truncate');
  many.domains = Array.from({ length: 80 }, (_, i) => ({
    domain: `domain-${i}`,
    scope: null,
    unbuildable: [],
    builder: 'succeeded',
    tier: 'regression',
    grep: '@regression',
    playwright: { passed: 12, failed: 0, flaky: 0, durationMs: 1000 },
    healApply: 'skipped',
  }));
  const big = buildReportMessage(many, {});
  assert(big.length <= 4096, `the report must fit one Telegram message, got ${big.length}`);
  assert(big.includes('truncated'), 'a report that was cut must say it was cut');

  // The verdict is the one thing the two readers must agree on, and a run that recorded no
  // browser result is `attention`: a green tick for "nothing was verified" is the lie the
  // delivery colour must not tell.
  // The two statuses are independent, and that is the whole point of labelling them: a failed
  // test must never be reported as a broken pipeline, and a broken pipeline must never be
  // reported as a red suite. Both conflations send someone to fix the wrong thing.
  const quiet = newManifest('check-status-none');
  assert(runStatus(quiet).testing.level === 'none', 'no test run recorded is not a pass');
  assert(runStatus(quiet).pipeline.level === 'ok', 'and the process did nothing wrong');

  const red = sampleManifest('check-status-red');
  // Clear the blocked scenario: it is what colours the PROCESS status, and this case is about
  // a run whose stages all went fine while the product did not.
  red.domains[0]!.unbuildable = [];
  assert(runStatus(red).testing.level === 'failed', 'a failed test is the product status');
  assert(
    runStatus(red).pipeline.level === 'ok',
    'and NOT the process one: a failing test leaves every stage succeeded',
  );
  assert(runStatus(red).testing.label.includes('1 test failed'), 'the status must say why, in numbers');

  const broken = sampleManifest('check-status-broken');
  broken.stages.push({ name: 'git', status: 'failed' });
  assert(runStatus(broken).pipeline.level === 'failed', 'a failed stage is the process status');
  assert(
    runStatus(broken).testing.level === 'failed',
    'the two are read independently — fixing one verdict must not lose the other',
  );
  assert(
    worstLevel('ok', 'failed') === 'failed' && worstLevel('attention', 'failed') === 'failed',
    'the worst of the two is what an overall colour must use',
  );
});

check('a failing test is a result, not a process degradation', async () => {
  // This is the one place the two statuses get conflated, and it is worth a check because the
  // symptom is silent and plausible: stage 6 recorded EVERY nonzero exit as a degradation, and
  // a failing test is the ordinary reason Playwright exits 1 — so a red suite turned the
  // PROCESS status yellow too, and "Pipeline Status: degraded: playwright-test" pointed a reader
  // at the pipeline for a problem in the product.
  const src = stripComments(
    await readFile(rehydrate('src/stages/06-playwright-test.ts'), 'utf8'),
  );
  assert(
    /!res\.ok\s*&&\s*stats !== null\s*&&\s*stats\.failed === 0/.test(src),
    'the exit code may only be a degradation when the recorded failures do not explain it',
  );
  assert(
    /no JSON report written — pass\/fail unknown/.test(src),
    'and an unreadable report still is one: an unknown result is a process problem, not a test result',
  );
});

check('a report that did not arrive is named, and the token never leaves the request', async () => {
  const saved = { key: env.TELEGRAM_API_KEY, chat: env.TELEGRAM_CHAT_ID };
  const token = '8810820000:AAFfake-token-for-checks-only-000000';
  try {
    // Unset is a legitimate setup, not a defect — but it must be SAID, because a report
    // nobody receives looks exactly like one nobody sent.
    env.TELEGRAM_API_KEY = undefined;
    env.TELEGRAM_CHAT_ID = undefined;
    assert(telegramConfig() === null, 'both halves are required to configure the channel');
    let calls = 0;
    const unconfigured = await sendReportMessage('x', {
      fetchImpl: async () => {
        calls++;
        return new Response('{}', { status: 200 });
      },
    });
    assert(calls === 0, 'a run with no channel must not call out at all');
    assert(
      !unconfigured.ok && unconfigured.reason.includes('TELEGRAM_API_KEY'),
      'an unconfigured channel must be named, not reported as sent',
    );

    env.TELEGRAM_API_KEY = token;
    env.TELEGRAM_CHAT_ID = '-1001234567890';
    let seenUrl = '';
    let seenBody = '';
    const rejected = await sendReportMessage('<b>hi</b>', {
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenBody = String(init?.body);
        return new Response(JSON.stringify({ description: 'Bad Request: chat not found' }), {
          status: 400,
        });
      },
    });
    assert(seenUrl.endsWith('/sendMessage'), 'the send must go to sendMessage');
    assert(seenUrl.includes('8810820000:AA'), 'the bot API path carries the token');
    assert(
      seenBody.includes('"chat_id":"-1001234567890"') && seenBody.includes('"parse_mode":"HTML"'),
      'the body must name the chat and ask for HTML',
    );
    assert(
      !rejected.ok && rejected.reason.includes('chat not found'),
      'a rejected send must be a named failure — Telegram says why, and that reason is repeatable',
    );
    assert(!rejected.reason.includes('8810820000:AA'), 'the failure must never carry the token');

    const unreachable = await sendReportMessage('x', {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    assert(!unreachable.ok, 'an unreachable channel must not read as delivered');
    assert(
      !unreachable.reason.includes('8810820000:AA') && !unreachable.reason.includes('api.telegram.org'),
      'a transport failure must not echo the request URL: that URL is the secret',
    );
    assert(unreachable.reason.includes('TypeError'), 'the failure must say what kind it was');

    // The backstop, for a token that reaches a log line by some other path.
    assert(!redact(`boom ${seenUrl}`).includes(token), 'redaction must mask a Telegram send URL');
    assert(!redact(`token ${token}`).includes(token), 'redaction must mask a bare bot token');
  } finally {
    env.TELEGRAM_API_KEY = saved.key;
    env.TELEGRAM_CHAT_ID = saved.chat;
  }
});

check('the report channel is wired where a run can reach it, and cannot pass for a quiet success', async () => {
  const notify = await readFile(rehydrate('src/stages/09-notify.ts'), 'utf8');
  const pipeline = await readFile(rehydrate('src/cli/run-pipeline.ts'), 'utf8');
  const stageCli = await readFile(rehydrate('src/cli/run-stage.ts'), 'utf8');
  const envSrc = await readFile(rehydrate('src/core/util/env.ts'), 'utf8');
  const example = await readFile(rehydrate('.env.example'), 'utf8');
  const workflow = await readFile(rehydrate('.github/workflows/pipeline.yml'), 'utf8');

  // The tests are the evidence and a chat message is not, so this must not fail the run...
  assert(/name:\s*'notify'/.test(notify) && /fatal:\s*false/.test(notify), 'notify must be non-fatal');
  // ...but a report that never arrived must fail the stage that was supposed to send it:
  // a green notify stage for an unsent report is the silent-success shape this repo exists
  // to prevent. Returning a string would do exactly that.
  assert(
    /recordDegradation\('notify'/.test(notify) && /throw new Error/.test(notify),
    'a failed send must fail the notify stage, so it appears under "Needs attention"',
  );
  assert(
    /const config = telegramConfig\(\)/.test(notify) && /config === null/.test(notify),
    'the unset case must be handled explicitly rather than as an error',
  );

  // After delivery, because the message carries the PR stage 8 opened.
  const gitAt = pipeline.indexOf('createGitStage(codeHost)');
  const notifyAt = pipeline.indexOf('createNotifyStage()');
  assert(gitAt !== -1 && notifyAt > gitAt, 'notify must run after git, and carry what git shipped');
  assert(
    /markSkipped\('notify', '--dry-run'\)/.test(pipeline),
    'a dry run tested nothing, so it must not report a result it never produced',
  );
  // Re-runnable on its own: `npm run stage:9` re-sends the report from the manifest on disk,
  // which is the whole point of failing the stage rather than swallowing the send.
  assert(
    /'notify',/.test(stageCli) && /case 9:/.test(stageCli),
    'stage 9 must be reachable by name and by number',
  );

  // THREE registration points (pipeline-pattern.md §5).
  for (const name of ['TELEGRAM_API_KEY', 'TELEGRAM_CHAT_ID']) {
    assert(envSrc.includes(name), `env.ts must declare ${name}`);
    assert(example.includes(name), `.env.example must document ${name}`);
    assert(workflow.includes(name), `the CI definition must register ${name}`);
  }
  assert(
    /TELEGRAM_API_KEY: \$\{\{ secrets\./.test(workflow),
    'the token is a secret: from `secrets`, never `vars`, which are readable',
  );
});

// -----------------------------------------------------------------------------

/**
 * One run, two readers. The PR body and the chat report must say the same things about the
 * same run — a narrowed scope, a blocked scenario, a failure — so both are held to this
 * fixture rather than to two that can drift apart.
 */
function sampleManifest(runId: string): RunManifest {
  const m = newManifest(runId);
  m.sourcePR = 7;
  m.branch = 'feat/hero';
  m.riskAreas = ['Hero copy in src/app/[locale]/page.tsx'];
  m.newScenarios = [
    { domain: 'landing-page', title: 'The hero CTA targets the portfolio', tags: ['@smoke'] },
  ];
  recordScenario(m, {
    domain: 'landing-page',
    id: 'aaa',
    contentHash: 'h1',
    title: 'The hero CTA targets the portfolio',
    tags: ['@smoke'],
    verdict: 'generated',
    reason: 'wrote a new managed block',
  });
  recordScenario(m, {
    domain: 'landing-page',
    id: 'bbb',
    contentHash: 'h2',
    title: 'The pricing section lists all six packages',
    tags: ['@regression'],
    verdict: 'unbuildable',
    reason: 'the page object cannot express it yet',
  });
  m.domains = [
    {
      domain: 'landing-page',
      scope: { newScenarios: 1, touchedAreas: ['hero'] },
      unbuildable: [
        {
          scenario: {
            id: 'bbb',
            contentHash: 'h2',
            title: 'The pricing section lists all six packages',
            tags: ['@regression'],
            expected: '',
            notes: '',
            raw: '',
          },
          missingCapabilities: ['expectHeroHeadline()'],
        },
      ],
      builder: 'succeeded',
      tier: 'smoke',
      grep: '@smoke|@20261021',
      playwright: { passed: 6, failed: 1, flaky: 0, durationMs: 1234 },
      healApply: 'skipped',
    },
  ];
  return m;
}

/**
 * Run `body` against a scratch `artifacts/run/heals.json`, restoring whatever was
 * there before. A self-check must not quietly delete the heals a previous run
 * recorded — a check with that side effect loses real work.
 */
async function withScratchHeals<T>(body: () => Promise<T>): Promise<T> {
  const path = rehydrate('artifacts/run/heals.json');
  const original = await readFile(path, 'utf8').catch(() => null);
  await mkdir(dirname(path), { recursive: true });
  try {
    return await body();
  } finally {
    if (original === null) await rm(path, { force: true });
    else await writeFile(path, original, 'utf8');
  }
}

async function listRepoFiles(relDir: string, pred: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(rehydrate(rel), { withFileTypes: true });
    } catch {
      return; // directory not present (fresh adopt) — nothing to check
    }
    for (const e of entries) {
      const child = joinRepo(rel, e.name);
      if (e.isDirectory()) await walk(child);
      else if (pred(e.name)) out.push(child);
    }
  };
  await walk(relDir);
  return out.sort();
}

/** Remove block and full-line comments so examples in prose don't trip the checks. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** The raw argument text of every `expect(...)` call (balanced-paren aware). */
function expectCallArgs(source: string): string[] {
  const out: string[] = [];
  const re = /\bexpect\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    const end = matchParen(source, open);
    if (end === -1) continue;
    out.push(source.slice(open + 1, end));
    re.lastIndex = end;
  }
  return out;
}

/** Index of the `)` matching the `(` at `open`, string-aware; -1 if unbalanced. */
function matchParen(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** The text of the second top-level (comma-separated) argument, or null. */
function secondTopLevelArg(args: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(i + 1).trim();
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  // Sequential, deliberately. These checks touch the filesystem — a scratch page
  // object, a restored heals.json — and running them concurrently let two of them
  // interleave over the same path: one wrote an artifact the other was reading, and
  // the failures looked like bugs in the code under test. Nothing here is slow
  // enough for parallelism to be worth that.
  for (const { name, fn } of pending) {
    try {
      await fn();
      passed++;
    } catch (err: unknown) {
      failed++;
      console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
