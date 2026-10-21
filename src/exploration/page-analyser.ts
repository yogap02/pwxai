/**
 * Page analyser: turn a live page into a compact structural description —
 * candidate locators with their resolve counts. The interactive refinement
 * loop belongs to the builder agent; this is the one-shot half.
 */

import type { Page } from 'playwright-core';

export interface LocatorCandidate {
  /** The suggested selector string. */
  selector: string;
  /** Playwright-recommended when true (role/label/text over CSS). */
  recommended: boolean;
  /** How many elements it matches — a locator is only usable when 1. */
  matches: number;
  /** Preview of the element's accessible name or text. */
  preview: string;
}

export interface PageAnalysis {
  url: string;
  title: string;
  candidates: LocatorCandidate[];
}

export async function analysePage(page: Page): Promise<PageAnalysis> {
  const url = page.url();
  const title = await page.title().catch(() => '');

  interface RawEl {
    tag: string;
    role: string | null;
    name: string | null;
    testid: string | null;
    id: string | null;
    text: string;
  }
  const raw = await page.evaluate<RawEl[]>(() => {
    const els = Array.from(document.querySelectorAll(
      'a, button, input, select, textarea, [role], [data-testid], h1, h2, h3',
    ));
    return els.slice(0, 200).map((el) => {
      const attrs = (name: string) => el.getAttribute(name);
      const text = (el.textContent ?? '').trim().slice(0, 60);
      return {
        tag: el.tagName.toLowerCase(),
        role: attrs('role'),
        name: attrs('aria-label') ?? attrs('name') ?? attrs('placeholder'),
        testid: attrs('data-testid'),
        id: el.id || null,
        text,
      };
    });
  });

  const candidates: LocatorCandidate[] = [];
  for (const el of raw) {
    if (el.testid) {
      candidates.push({ selector: `[data-testid="${el.testid}"]`, recommended: true, matches: -1, preview: el.text });
    } else if (el.role && el.name) {
      candidates.push({ selector: `getByRole(${JSON.stringify(el.role)}, { name: ${JSON.stringify(el.name)} })`, recommended: true, matches: -1, preview: el.text });
    } else if (el.tag === 'a' && el.text) {
      candidates.push({ selector: `getByRole('link', { name: ${JSON.stringify(el.text)} })`, recommended: true, matches: -1, preview: el.text });
    } else if (el.tag === 'button' && el.text) {
      candidates.push({ selector: `getByRole('button', { name: ${JSON.stringify(el.text)} })`, recommended: true, matches: -1, preview: el.text });
    } else if (el.id) {
      candidates.push({ selector: `#${el.id}`, recommended: false, matches: -1, preview: el.text });
    }
  }

  // Verify unique resolution for the top candidates.
  const verified: LocatorCandidate[] = [];
  for (const c of candidates.slice(0, 30)) {
    const count = await countMatches(page, c.selector);
    verified.push({ ...c, matches: count });
  }

  return { url, title, candidates: verified };
}

async function countMatches(page: Page, selector: string): Promise<number> {
  try {
    if (selector.startsWith('getByRole')) {
      // Evaluate the role selector manually — avoid eval of generated code.
      const m = /getByRole\(([^,]+),\s*\{\s*name:\s*"((?:[^"\\]|\\.)*)"\s*\}\)/.exec(selector);
      if (!m) return -1;
      const role = m[1]!.trim().replace(/^['"]|['"]$/g, '');
      const name = JSON.parse(`"${m[2]!.replace(/"/g, '\\"')}"`) as string;
      return await page.getByRole(role as never, { name }).count();
    }
    return await page.locator(selector).count();
  } catch {
    return -1;
  }
}
