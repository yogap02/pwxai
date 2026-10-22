/**
 * Stage 2: testcase-digest. Reads all scenario files and the existing specs,
 * classifies each scenario (covered / novel / blocked), generates test()
 * blocks for the novel ones, and rewrites the managed region of each spec
 * file. Blocks the POMs can't express are emitted as marked-unbuildable work
 * orders for stage 4.
 *
 * FATAL on failure (pipeline-pattern.md §2).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import type { StageSpec, StageContext } from '../core/orchestration/stage-runner.js';
import { runStageProcess } from '../core/orchestration/stage-runner.js';
import { parseScenarioFile, type ScenarioBlock } from '../core/scenario/parser.js';
import {
  listScenarioFiles,
  domainKeyOf,
  recordScenario,
  runDateTag,
  type DigestVerdict,
  type DomainOutcome,
} from '../core/scenario/manifest.js';
import { renderDigestSummary } from '../core/orchestration/run-summary.js';
import { readManagedRegion, upsertManagedRegion, renderManagedRegion, mergeManagedRegion, stripBlockImports, blockViolations, scaffoldManagedSpec } from '../core/scenario/managed-region.js';
import { loadDomainMap, resolveDomain, backfillDomainEntry, readDomainContext, instructionFileFor, type DomainEntry } from '../core/scenario/domain-map.js';
import { applyScenarioTags, dateTagIn } from '../core/scenario/test-tags.js';
import { blockCompileErrors, parseTscErrors } from '../core/scenario/compile-guard.js';
import { viewportProfileIn, viewportCapabilityGap, type ViewportProfile } from '../core/scenario/viewport.js';
import { rehydrate } from '../core/util/paths.js';
import { dbg } from '../core/util/debug.js';
import { extractPomSurface, buildLookup } from '../ai/capability-index.js';
import { Classifier, type Classification } from '../ai/classifier.js';
import { Generator } from '../ai/generator.js';
import { backstopCheck } from '../ai/coverage-backstop.js';
import type { ModelClient } from '../ai/model-client.js';
import type { DigestOutcome } from './stage-types.js';

export interface Stage2Result {
  outcomes: DigestOutcome[];
  /** Titles generated in this run — the planner's floor. */
  generatedTitles: string[];
}

export function createTestcaseDigestStage(model: ModelClient): StageSpec {
  return {
    name: 'testcase-digest',
    fatal: true,
    run: async (ctx: StageContext) => {
      const result = await runDigest(model, ctx, 'testcase-digest');
      // Per-domain rollup for later stages. Scenario-level verdicts are NOT
      // stored here: `runDigest` recorded each one on `manifest.scenarios`, next
      // to its title, so the manifest reads without joining a hash-keyed map.
      for (const o of result.outcomes) {
        const outcome: DomainOutcome = {
          domain: o.domain,
          scope: null,
          unbuildable: o.unbuildable,
          builder: null,
          tier: null,
          grep: null,
          playwright: null,
          healApply: null,
        };
        const existing = ctx.manifest.domains.find((d) => d.domain === o.domain);
        if (existing) Object.assign(existing, outcome);
        else ctx.manifest.domains.push(outcome);
      }
      if (result.outcomes.length === 0) {
        return 'No scenario files found — nothing to digest.';
      }
      // One line per scenario, in scenario order, so "where did my testcase go?"
      // has an answer right in the stage output. Counts alone hid the case that
      // matters most: a scenario the classifier judged *already covered* — it
      // produces no block, and used to produce no line either.
      return result.outcomes.map((o) => renderDigestSummary(ctx.manifest, o.domain)).join('\n\n');
    },
  };
}

export async function runDigest(
  model: ModelClient,
  ctx: StageContext,
  stageName: string,
): Promise<Stage2Result> {
  const scenarioFiles = await listScenarioFiles();
  const map = await loadDomainMap();

  const outcomes: DigestOutcome[] = [];
  const allGeneratedTitles: string[] = [];

  for (const file of scenarioFiles) {
    const key = domainKeyOf(file);
    const resolved = resolveDomain(map, key);
    dbg('digest', 'domain', { domain: key, file, mapped: resolved !== null });
    let entry: DomainEntry;
    if (resolved) {
      entry = resolved.entry;
    } else {
      // First run for this domain: backfill structural half. Manual edits
      // elsewhere are authoritative — we never overwrite a hand-set field.
      const defaults: DomainEntry = {
        description: `Auto-backfilled for domain ${key} on first run. Replace with hand-authored entry.`,
        entryPaths: ['/'],
        needsAuth: false,
        entryDiscoverySteps: [],
        specDir: `tests/${key}`,
        pomDir: `src/page-objects/${key}`,
        className: classNameOf(key),
        confidence: 0,
      };
      await backfillDomainEntry(key, defaults);
      entry = defaults;
      ctx.recordDegradation(stageName, `backfilled domain-map entry for ${key}`);
    }

    const surfaces = [await extractPomSurface(`${entry.pomDir}/index.ts`)];
    const lookup = buildLookup(surfaces);

    // Domain context: how this feature area actually works, earned by driving the
    // live app. Fed to generation so blocks are written against real behaviour,
    // not guesses. Absent on a first run is normal — named, not fatal.
    const domainContext = await readDomainContext(entry);
    if (domainContext.trim().length === 0) {
      ctx.recordDegradation(stageName, `no domain context at ${instructionFileFor(entry)} for ${key}`);
    }

    const classifier = new Classifier(model, lookup, domainContext);

    const text = await readFile(rehydrate(file), 'utf8');
    const blocks = parseScenarioFile(text);

    // Collect block outcomes in SCENARIO ORDER — never arrival order.
    const unbuildable: DigestOutcome['unbuildable'] = [];
    const generatedTitles: string[] = [];

    // This run's creation-date tag, `@YYYYMMDD`. Stamped on every block this run
    // GENERATES; a held block keeps the date it was made (read back off the block),
    // so nothing is re-stamped to "today" on a run that changed nothing.
    const runTag = runDateTag(ctx.manifest);
    const dateTagById = new Map<string, string>();

    /** Record the verdict on the manifest, beside the title it belongs to. */
    const record = (
      scenario: ScenarioBlock,
      verdict: DigestVerdict,
      reason: string,
      createdDate?: string,
    ): void => {
      recordScenario(ctx.manifest, {
        domain: key,
        id: scenario.id,
        contentHash: scenario.contentHash,
        title: scenario.title,
        tags: scenario.tags,
        verdict,
        reason,
        ...(createdDate !== undefined ? { createdDate } : {}),
      });
      // One line per scenario decided, with the reason. This is the "where did my
      // testcase go?" answer, live, before the summary is rendered.
      dbg('digest', 'verdict', {
        domain: key,
        scenario: scenario.id,
        verdict,
        title: scenario.title,
        reason,
      });
    };

    const specAbs = rehydrate(`${entry.specDir}/${key}.spec.ts`);
    let specContent = '';
    try {
      specContent = await readFile(specAbs, 'utf8');
    } catch {
      /* new spec file — will be scaffolded below */
    }

    const existingBlocks = readManagedRegion(specContent);
    const existingTitlesInFile = collectExistingTitles(specContent);
    dbg('digest', 'spec', {
      domain: key,
      spec: `${entry.specDir}/${key}.spec.ts`,
      scenarios: blocks.length,
      heldBlocks: existingBlocks.length,
      existingTitles: existingTitlesInFile.length,
      pomMembers: lookup.all().length,
    });
    const byId = new Map<string, { code: string; coveredClauses: string[] }>();
    // scenario id → the block that must be in the region after this run.
    // mergeManagedRegion drops any id it does not see here, so a held block that
    // is not carried forward is DELETED. Carrying them forward is what makes
    // "regeneration keyed on inputs changing" true rather than aspirational.
    const allBlocks = new Map<string, { code: string; scenarioContentHash: string }>();

    const generator = new Generator(model, domainContext);

    const toGenerate: Array<{ scenario: ScenarioBlock; existingTitles: readonly string[]; availableMembers: readonly string[]; pomClass: string; viewportProfile: ViewportProfile | null }> = [];

    for (const scenario of blocks) {
      const existingBlock = existingBlocks.find((b) => b.scenarioId === scenario.id);
      // The hash decides, before anything is asked of a model: unchanged → hold, moved →
      // redigest, no block at all → ask whether something else already covers it.
      const path = digestPath(existingBlock, scenario.contentHash);
      if (path === 'hold' && existingBlock) {
        // Keep the block's own creation date. A held block was not rewritten, so
        // its date tag must not move — re-stamping it here is the daily churn.
        const existingDate = dateTagIn(existingBlock.code) ?? undefined;
        if (existingDate !== undefined) dateTagById.set(scenario.id, existingDate);
        record(scenario, 'held', 'scenario text unchanged — existing block kept verbatim', existingDate);
        allBlocks.set(scenario.id, {
          code: existingBlock.code,
          scenarioContentHash: existingBlock.scenarioContentHash,
        });
        continue;
      }
      // A viewport-dependent scenario needs the page object to be able to set the
      // profile. This is a mechanical capability gate (pipeline-pattern.md §3:
      // gates are matchers, not prompt rules) — the digest's general knowledge
      // about mobile layout. A page object that cannot do it cannot express the
      // scenario, so it becomes a stage-4 work order rather than a block that
      // asserts the desktop layout at a phone width.
      const profile = viewportProfileIn(`${scenario.title}\n${scenario.expected}\n${scenario.notes}`);
      const viewportGap = viewportCapabilityGap((m) => lookup.has(m), profile);
      if (viewportGap) {
        record(scenario, 'unbuildable', `missing page-object capability: ${viewportGap}`);
        unbuildable.push({ scenario, missingCapabilities: [viewportGap] });
        dbg('digest', 'viewport-gap', { domain: key, scenario: scenario.id, profile, missing: viewportGap });
        continue;
      }

      // A moved hash has already told us the scenario changed, so the only question left
      // is whether a model can express it. Only a scenario with NO block is offered to the
      // classifier — a stale block is the scenario's own artifact, and asking let it vouch
      // for itself (see `digestPath`).
      const verdict =
        path === 'redigest'
          ? { kind: 'generated' as const, reason: 'scenario text moved — stale block re-digested' }
          : await safeClassify(classifier, scenario, existingTitlesInFile);
      if (verdict.kind === 'covered') {
        // Covered → leave any existing block in place. The verdict is recorded
        // as `covered`, NOT `held`: two different reasons must not collapse into
        // one word, or the report cannot say which one happened. Reached only for a
        // scenario with no block at all, so there is nothing to carry forward: a stale
        // block resurrected here would be kept with its OLD hash and re-decided forever.
        record(scenario, 'covered', verdict.reason);
        continue;
      }
      if (verdict.kind === 'blocked') {
        record(scenario, 'unbuildable', `missing page-object capability: ${verdict.missingCapabilities.join(', ')}`);
        unbuildable.push({ scenario, missingCapabilities: verdict.missingCapabilities });
        continue;
      }
      record(scenario, 'generated', verdict.reason, runTag);
      dateTagById.set(scenario.id, runTag);
      toGenerate.push({
        scenario,
        existingTitles: existingTitlesInFile,
        // The catalog, not bare names: the generator writes the CALL, so it needs
        // the parameters. A name-only list made `expectHeroCtaTargets` look like a
        // zero-argument assertion and the block omitted the required href.
        availableMembers: lookup.catalog(),
        pomClass: entry.className,
        viewportProfile: profile,
      });
    }

    if (toGenerate.length > 0) {
      const generation = await generator.generateAll(toGenerate);
      for (const [id, gen] of generation) {
        byId.set(id, gen);
      }
      const backstop = backstopCheck(generation, new Map(toGenerate.map((t) => [t.scenario.id, t.scenario])));
      if (backstop.flags.length > 0) {
        ctx.recordDegradation(stageName, `backstop: ${backstop.flags.length} flag(s) in ${key}`);
      }
      for (const s of toGenerate) {
        const gen = byId.get(s.scenario.id);
        // A block that reached past the page object is not written AT ALL. It would not
        // compile against the POM's surface (TS2339/TS2554, the failures AGENTS.md records
        // from a bare-name catalog), and — because one broken block breaks the file — it
        // would take every handwritten test in the same spec down with it. The scenario
        // goes back to being a builder work order, which is where a capability gap belongs,
        // and that is what puts it under "Needs attention" instead of into a green PR.
        const violations = gen === undefined ? [] : blockViolations(gen.code);
        if (violations.length === 0) {
          generatedTitles.push(s.scenario.title);
          continue;
        }
        byId.delete(s.scenario.id);
        record(s.scenario, 'unbuildable', `generated block reached past the page object: ${violations.join('; ')}`);
        unbuildable.push({ scenario: s.scenario, missingCapabilities: violations });
        ctx.recordDegradation(
          stageName,
          `${key}: refused the generated block for "${s.scenario.title}" — ${violations.join('; ')}; it is a page-object work order, not a test`,
        );
        dbg('digest', 'refused-block', { domain: key, scenario: s.scenario.id, violations });
      }
    }

    // Emit generated + unbuildable blocks. Held blocks were added above.
    const scenariosById = new Map(blocks.map((b) => [b.id, b]));
    for (const [id, gen] of byId) {
      const scenario = scenariosById.get(id);
      if (!scenario) continue;
      allBlocks.set(id, { code: gen.code, scenarioContentHash: scenario.contentHash });
    }
    for (const u of unbuildable) {
      allBlocks.set(u.scenario.id, {
        code: workOrderBlock(u.scenario, u.missingCapabilities),
        scenarioContentHash: u.scenario.contentHash,
      });
    }

    /**
     * Compose the spec file from the blocks currently in `allBlocks`. A closure, because the
     * compiler step below can refuse a block and then asks for the file a second time — and the
     * second composition must go through THIS writer, not a hand-spliced edit, or the region it
     * produces stops being a fixpoint of the reader.
     */
    const composeSpec = (): { text: string; blocks: number } => {
      const merged = mergeManagedRegion(
        existingBlocks,
        allBlocks,
        blocks.map((b) => b.id),
      );

      // Tags are DERIVED from the scenario file, so refresh them on every block —
      // including held ones. A block generated before tags were written (or before
      // the scenario's tag list changed) would otherwise keep a tag the scenario no
      // longer has, and `--grep @core` would then run a test the scenario files
      // under `@regression`. The refresh is idempotent, so a block that already
      // carries the right tag is untouched.
      //
      // The strip runs here, on the way into the region, so it covers a held block
      // too: a block already written with an import gets repaired on the next run
      // rather than held broken forever. An import inside the region is a syntax
      // error that takes the whole spec file down (AGENTS.md §"Managed regions"),
      // so this is a degradation worth naming, not a silent edit.
      const tagged = merged.map((block) => {
        const stripped = stripBlockImports(block.code);
        if (stripped.removed > 0) {
          ctx.recordDegradation(
            stageName,
            `${block.scenarioId}: removed ${stripped.removed} import statement(s) from the block — imports belong at the top of the spec, not inside the managed region`,
          );
          dbg('digest', 'stripped-imports', {
            domain: key,
            scenario: block.scenarioId,
            removed: stripped.removed,
          });
        }
        // The scenario's own tags, plus the block's creation-date tag, written by
        // machinery. The date tag is what stage 5's planner matches on to guarantee
        // that everything generated this run is inside the scope — so it must be
        // applied here, by code, and never left to the model or the scenario file.
        const scenarioTags = scenariosById.get(block.scenarioId)?.tags ?? [];
        const dateTag = dateTagById.get(block.scenarioId);
        return {
          ...block,
          code: applyScenarioTags(
            stripped.code,
            dateTag === undefined ? scenarioTags : [...scenarioTags, dateTag],
          ),
        };
      });

      const nextRegion = renderManagedRegion(tagged);
      // Indent the region into the describe body — but never indent a blank line,
      // or the writer leaves trailing whitespace and the diff churns every run.
      const indentedRegion = nextRegion
        .split('\n')
        .map((line) => (line.trim() === '' ? '' : `  ${line}`))
        .join('\n');
      // A brand-new spec needs a CLOSED describe block: `upsertManagedRegion` only
      // appends or replaces the region, so composing a file with no closing `});`
      // would be a syntax error on the very first run of a domain.
      //
      // The scaffold must also import the page-object class: deleting a spec and
      // regenerating it produced a file whose every block said `new LandingPage(page)`
      // while nothing imported `LandingPage`, so the whole spec was TS2552. The class
      // and its directory are in the domain map, so the import is derived, not
      // hardcoded — and it is emitted only when a block actually names it, so a domain
      // whose scenarios are all unbuildable does not get a dead import to a page
      // object that does not exist yet.
      const pomImportSpecifier = relativeImport(entry.specDir, `${entry.pomDir}/index.js`);
      const fixtureImportSpecifier = relativeImport(entry.specDir, 'src/runtime/self-heal-fixture.js');
      const usesPomClass = new RegExp(`\\b${escapeRegExp(entry.className)}\\b`).test(indentedRegion);
      const text =
        specContent.trim().length === 0
          ? scaffoldManagedSpec({
              domain: key,
              // No `expect` import: assertions live in the page objects
              // (AGENTS.md §"Test authoring rules").
              //
              // The healing fixture, not `@playwright/test`: it attaches the run's
              // heal collector to the page, which is what lets a page object survive
              // a locator the app has drifted away from (runtime/heal-locator.ts).
              imports: [
                `import { test } from '${fixtureImportSpecifier}';`,
                ...(usesPomClass
                  ? [`import { ${entry.className} } from '${pomImportSpecifier}';`]
                  : []),
              ],
              region: indentedRegion,
            })
          : upsertManagedRegion(specContent, indentedRegion);
      // The upsert path never writes outside the region (handwritten territory), so
      // it cannot add a missing import. Say so instead of letting stage 6 fail with
      // an unhelpful "LandingPage is not defined" compile error.
      if (specContent.trim().length > 0 && usesPomClass && !importsName(specContent, entry.className)) {
        ctx.recordDegradation(
          stageName,
          `${key}: existing spec does not import ${entry.className}, but a generated block instantiates it — the handwritten import at the top of ${entry.specDir}/${key}.spec.ts must add it`,
        );
        dbg('digest', 'missing-pom-import', { domain: key, className: entry.className });
      }
      return { text, blocks: tagged.length };
    };

    const specRel = `${entry.specDir}/${key}.spec.ts`;
    await mkdir(dirname(specAbs), { recursive: true });
    let composed = composeSpec();
    await writeFile(specAbs, composed.text, 'utf8');

    // The compiler is the last gate over a generated block, and the only one that can see a block
    // calling the page object WRONG, rather than naming something that does not exist. It can only
    // run over the written file, so this is an interval between two writes rather than a condition
    // inside the composition. Its value is not the error, it is the ATTRIBUTION: every block of a
    // domain lives in one spec file and TypeScript reports against the file, so one bad block used
    // to cost every other block its delivery — seventeen correct blocks refused along with four
    // wrong ones, on a real PR. Refuse the blamed block, keep the rest.
    //
    // One pass settles: removing a block can only remove diagnostics, because `noUnusedLocals` is
    // off and an import orphaned by the removal is therefore not an error.
    const tsc = await runStageProcess('npm', ['run', 'typecheck'], { timeoutMs: 10 * 60_000 });
    const verdict = blockCompileErrors(composed.text, specRel, tsc.output);
    if (!tsc.ok && parseTscErrors(tsc.output).length === 0) {
      ctx.recordDegradation(
        stageName,
        `${key}: could not verify the generated spec — \`npm run typecheck\` failed without parseable diagnostics`,
      );
    }
    for (const detail of verdict.unattributed) {
      ctx.recordDegradation(
        stageName,
        `${specRel} has a compile error no generated block owns (the handwritten part, or the scaffold): ${detail}`,
      );
    }
    for (const [id, messages] of verdict.byBlock) {
      const scenario = scenariosById.get(id);
      if (scenario === undefined || !allBlocks.has(id)) continue;
      // Captured BEFORE the work order replaces it: this is the code that failed to compile, and
      // it is the only evidence of what the model actually wrote.
      const refusedCode = allBlocks.get(id)?.code ?? '';
      // Replaced, not deleted: the scenario keeps its place in the file as a work order, which is
      // what puts it under "Needs attention" carrying the compiler's own words.
      allBlocks.set(id, {
        code: workOrderBlock(scenario, messages),
        scenarioContentHash: scenario.contentHash,
      });
      record(scenario, 'unbuildable', `does not compile: ${messages.join('; ')}`);
      unbuildable.push({ scenario, missingCapabilities: messages });
      // It has no test, so it must not sit in the planner's floor of "what this run wrote".
      const at = generatedTitles.indexOf(scenario.title);
      if (at !== -1) generatedTitles.splice(at, 1);
      ctx.recordDegradation(
        stageName,
        `${key}: refused the generated block for "${scenario.title}" — it does not compile (${messages.join('; ')}); the scenario is a page-object work order, not a test`,
      );
      // The refused code goes in the record, not just the diagnostics. "TS1005: ';' expected" with
      // no source is unactionable: whoever picks up the work order has to re-run the model to see
      // what it wrote, and a re-run answers differently. The code is the evidence.
      dbg('digest', 'refused-block-uncompilable', {
        domain: key,
        scenario: id,
        messages,
        refusedCode,
      });
    }
    if (verdict.byBlock.size > 0) {
      composed = composeSpec();
      await writeFile(specAbs, composed.text, 'utf8');
    }
    dbg('digest', 'wrote', {
      domain: key,
      spec: specRel,
      blocks: composed.blocks,
      chars: composed.text.length,
      refusedUncompilable: verdict.byBlock.size,
    });

    outcomes.push({
      domain: key,
      generatedTitles,
      unbuildable,
    });
    allGeneratedTitles.push(...generatedTitles);
  }

  return { outcomes, generatedTitles: allGeneratedTitles };
}

/**
 * The block written in place of a scenario the page object cannot express, or whose generated
 * block does not compile. It stays in the file — a work order a reviewer can read, carrying the
 * compiler's or the capability index's own words — and `test.fixme` keeps it out of the run.
 */
function workOrderBlock(scenario: ScenarioBlock, missingCapabilities: readonly string[]): string {
  return `// @unbuildable:${missingCapabilities.join(',')}\n// WORK ORDER for stage 4: page-object capability missing.\ntest.fixme(${JSON.stringify(scenario.title)}, async ({ page }) => {\n  // Expected: ${scenario.expected.replace(/\n/g, ' ')}\n});`;
}

async function safeClassify(
  classifier: Classifier,
  scenario: ScenarioBlock,
  existingTitles: readonly string[],
): Promise<Classification> {
  try {
    return await classifier.classify(scenario, existingTitles);
  } catch (err) {
    // Classification failure is SAFE-FAIL: hold the block as-is rather than
    // risk dropping it. Recorded as held; the next run re-tries.
    return { kind: 'covered', reason: `classification error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function collectExistingTitles(specContent: string): string[] {
  const out: string[] = [];
  // Only real tests: `test(...)`, `test.fixme(...)`, `test.skip(...)`. The
  // `test.describe('landing-page', ...)` name is NOT a test title — offering it
  // to the classifier as an "existing scenario" is how a scenario gets judged
  // covered by a describe block that asserts nothing.
  for (const m of specContent.matchAll(/test(?:\.fixme|\.skip)?\(\s*(['"`])(.*?)\1/g)) {
    if (m[2]) out.push(m[2]);
  }
  return out;
}

/**
 * Which path a scenario takes through the digest, decided by the block's own hash:
 *
 *   - **no block** → `classify`. A handwritten test, or a block belonging to another
 *     scenario, may already cover it, so the coverage question is worth asking.
 *   - **block, hash moved** → `redigest`. The scenario text changed, so the test case it
 *     records is STALE and no longer expresses it. The scenario file is the source of
 *     truth, and its hash is the signal — so a moved hash re-digests, and the coverage
 *     question is deliberately NOT asked.
 *   - **block, hash equal** → `hold`.
 *
 * The middle case is the one that was wrong. A stale block carries the scenario's own
 * TITLE, and the classifier was asked "does an existing test cover this?" with that title
 * in the list, so the answer was always yes — the block vouched for itself. The edit never
 * reached the spec, and because the stale block was carried forward *with its old hash*,
 * the same scenario was re-decided on every later run, forever, under a green report.
 * Re-digestion settles: the rewritten block carries the new hash and is held next run.
 */
export function digestPath(
  existingBlock: { scenarioContentHash: string } | undefined,
  scenarioContentHash: string,
): 'hold' | 'redigest' | 'classify' {
  if (existingBlock === undefined) return 'classify';
  return existingBlock.scenarioContentHash === scenarioContentHash ? 'hold' : 'redigest';
}

function classNameOf(key: string): string {
  return key
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('') + 'Page';
}

/**
 * A relative ESM specifier from one repo-relative POSIX directory to another file.
 * Derived from the domain map rather than hardcoded `../../`, so moving a domain's
 * specDir keeps its imports working.
 */
function relativeImport(fromDir: string, target: string): string {
  const rel = posix.relative(fromDir, target);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** True when the source has a named import (or import specifier) for `name`. */
function importsName(source: string, name: string): boolean {
  return new RegExp(
    `import\\b[^;]*\\b${escapeRegExp(name)}\\b[^;]*from\\s*['"]`,
  ).test(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
