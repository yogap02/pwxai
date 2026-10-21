/**
 * Locator writer: turn verified locator candidates into page-object members.
 * Additive-only — it appends new members; repairing existing ones belongs to
 * the heal writer (pipeline-pattern.md §3, "Agent writes are additive-only").
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rehydrate } from '../core/util/paths.js';
import type { LocatorCandidate } from './page-analyser.js';

export interface LocatorWriteInput {
  /** Repo-relative POSIX page-object file. */
  file: string;
  className: string;
  /** Candidates with matches === 1 only — the writer refuses ambiguous ones. */
  locators: Array<{ name: string; candidate: LocatorCandidate }>;
}

export async function writeLocators(input: LocatorWriteInput): Promise<{ added: string[] }> {
  const abs = rehydrate(input.file);
  let content: string;
  try {
    content = await readFile(abs, 'utf8');
  } catch {
    content = [
      `import type { Locator, Page } from 'playwright-core';`,
      ``,
      `export class ${input.className} {`,
      `  constructor(readonly page: Page) {}`,
      ``,
    ].join('\n');
  }

  const added: string[] = [];
  let body = content;

  for (const { name, candidate } of input.locators) {
    if (candidate.matches !== 1) continue; // refuse ambiguous locators
    if (body.includes(`  readonly ${name} `) || body.includes(`  readonly ${name}=`)) continue;

    if (candidate.selector.startsWith('getBy')) {
      body += [
        `  readonly ${name} = /* verified ${new Date().toISOString()} */ this.page.${candidate.selector};`,
        ``,
      ].join('\n');
    } else {
      body += [
        `  readonly ${name} = /* verified ${new Date().toISOString()} */ this.page.locator(${JSON.stringify(candidate.selector)});`,
        ``,
      ].join('\n');
    }
    added.push(name);
  }

  if (added.length > 0) {
    if (!content.includes(`export class ${input.className}`) && content === body) {
      body += `}\n`; // new file: close the class
    } else if (!body.trimEnd().endsWith('}')) {
      body = `${body.trimEnd()}\n}\n`;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }

  return { added };
}
