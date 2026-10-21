/**
 * BFS crawler. Kept for breadth (scheduled whole-app re-mapping), NOT for
 * targeted page-object work — a crawler over one-shot analysis calls cannot
 * do the plan-act-observe loop that building page objects requires
 * (pipeline-pattern.md §4). Its narrow role is a design choice, not coupling.
 */

import { chromium } from 'playwright-core';
import { env } from '../core/util/env.js';

export interface CrawledPage {
  url: string;
  title: string;
  /** Discovered links, same-origin, normalised. */
  links: string[];
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** Pages we failed to reach, with reason. */
  failures: Array<{ url: string; reason: string }>;
}

export async function crawl(
  startUrl: string,
  opts?: { maxPages?: number; maxDepth?: number },
): Promise<CrawlResult> {
  const maxPages = opts?.maxPages ?? 50;
  const maxDepth = opts?.maxDepth ?? 3;

  const browser = await chromium.launch({ headless: true });
  try {
    const base = new URL(startUrl, env.BASE_URL);
    const origin = base.origin;

    const visited = new Set<string>();
    const pages: CrawledPage[] = [];
    const failures: CrawlResult['failures'] = [];

    interface QueueItem { url: string; depth: number }
    const queue: QueueItem[] = [{ url: base.toString(), depth: 0 }];

    while (queue.length > 0 && pages.length < maxPages) {
      const { url, depth } = queue.shift()!;
      const normalised = normalise(url, origin);
      if (visited.has(normalised)) continue;
      visited.add(normalised);
      if (depth > maxDepth) continue;

      const page = await browser.newPage();
      try {
        await page.goto(normalised, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        const title = await page.title().catch(() => '');
        const links = await page.evaluate<string[]>(() =>
          Array.from(document.querySelectorAll('a[href]')).map(
            (a) => (a as HTMLAnchorElement).href,
          ),
        );
        const sameOrigin = links
          .map((href) => normalise(href, origin))
          .filter((href) => href.startsWith(origin));
        pages.push({ url: normalised, title, links: sameOrigin });
        if (depth < maxDepth) {
          for (const link of sameOrigin) {
            if (!visited.has(link)) queue.push({ url: link, depth: depth + 1 });
          }
        }
      } catch (err) {
        failures.push({ url: normalised, reason: err instanceof Error ? err.message : String(err) });
      } finally {
        await page.close().catch(() => {});
      }
    }
    return { pages, failures };
  } finally {
    await browser.close().catch(() => {});
  }
}

function normalise(url: string, origin: string): string {
  try {
    const u = new URL(url, origin);
    u.hash = '';
    u.search = '';
    return u.toString();
  } catch {
    return url;
  }
}
