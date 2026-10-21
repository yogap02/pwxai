/**
 * CDP builder stub. Product-neutral stand-in for the real agent CLI
 * (recommended default for this boilerplate): drives the live app with
 * playwright-core over CDP, snapshots the entry page, and appends what it
 * observed to the domain instruction file.
 *
 * It does NOT generate real page-object code — that is the LLM agent's job
 * once you wire one. What it does do is exercise the full plumbing (task in,
 * write-scope-guarded files out, summary returned) so the stage runner and
 * instruction-file path are real from day one.
 *
 * What it writes is deliberately narrow: an instruction file is append-only
 * DOMAIN CONTEXT that later feeds test-case generation, so a run may add a FACT
 * and nothing else. Everything else the run observed goes in the summary, which
 * is persisted per run — see `freshObservationLines` for why that split is
 * load-bearing rather than tidy.
 */

import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';
import { env } from '../core/util/env.js';
import { rehydrate } from '../core/util/paths.js';
import { dbg } from '../core/util/debug.js';
import type { BuilderAgent, BuilderResult, BuilderTask } from './builder-agent.js';

/** Heading the stub's facts go under. Stable — never stamped with a run. */
export const OBSERVATION_HEADING = '## What the stub builder observed';

/**
 * Lines to append for `facts`, given what the file already says: the heading plus only
 * the facts it does not already carry. Empty when it carries them all.
 *
 * An instruction file is append-only domain context, not a run diary, and this stub
 * used to treat it as one: a `## <ISO timestamp> — stub builder run` heading, the page
 * title, and the first 200 characters of the page's body text, on every invocation.
 * Three runs left three near-identical sections in the landing-page file and every
 * later run added a fourth — unbounded growth on disk, and in the prompt that reads
 * this file to generate test cases. A timestamp guarantees the "is this new?" test
 * always answers yes, so nothing was ever recognised as already known.
 *
 * A page snapshot is not a fact about the domain either: the entry page and its title
 * are, once each. The rest — the page was reachable, what it looked like, what the
 * builder was asked for — is per-run observation, and belongs in the summary.
 */
export function freshObservationLines(known: string, facts: readonly string[]): string[] {
  const fresh = facts.filter((fact) => fact.length > 0 && !known.includes(fact));
  if (fresh.length === 0) return [];
  return [OBSERVATION_HEADING, ...fresh];
}

export class CdpBuilderStub implements BuilderAgent {
  async build(task: BuilderTask): Promise<BuilderResult> {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const entry = task.entryPaths[0] ?? '/';
      const url = entry.startsWith('http') ? entry : new URL(entry, env.BASE_URL).toString();
      dbg('builder-stub', 'open', { domain: task.domain, url, missingCapabilities: task.missingCapabilities });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const title = await page.title();
      const bodyText = (await page.locator('body').innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .slice(0, 200);

      const facts: string[] = [
        `- Entry page: ${url}`,
        `- Page title: ${title}`,
        ...(task.missingCapabilities.length
          ? [`- Builder work order: ${task.missingCapabilities.join(', ')}`]
          : []),
      ];

      const instructionAbs = rehydrate(task.instructionFile);
      const known = await readFile(instructionAbs, 'utf8').catch(() => '');
      const instructionAdditions = freshObservationLines(known, facts);
      if (instructionAdditions.length > 0) {
        await mkdir(dirname(instructionAbs), { recursive: true });
        // Append-only: instruction files must not be condensed (pipeline-pattern.md §7).
        await appendFile(instructionAbs, `\n${instructionAdditions.join('\n')}\n`, 'utf8');
      }

      // The run's own observation. Persisted per run in the stage record — which is
      // where "it was reachable and looked like this" belongs, not in a file that only
      // grows and is read back as domain truth.
      dbg('builder-stub', 'observed', {
        domain: task.domain,
        url,
        title,
        bodyChars: bodyText.length,
        newFacts: instructionAdditions.length === 0 ? 0 : instructionAdditions.length - 1,
      });
      const summary = [
        `Navigated to ${url}; title="${title}".`,
        `Body starts: ${bodyText || '(empty)'}`,
        'Stub agent — no page-object code generated.',
        `Work order: ${task.missingCapabilities.join(', ') || '(none)'}.`,
        `Instruction file: appended ${
          instructionAdditions.length === 0
            ? 'nothing (already recorded)'
            : `${instructionAdditions.length - 1} new fact(s)`
        }.`,
      ].join(' ');

      return { added: [], summary, instructionAdditions };
    } finally {
      await browser.close().catch(() => {});
    }
  }
}
