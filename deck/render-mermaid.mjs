/**
 * Renders every ```mermaid block in WORKFLOW.md to deck/diagrams/d<N>.png.
 *
 *     node deck/render-mermaid.mjs
 *
 * Serves the repo root (the page reads ../WORKFLOW.md, so the image and the doc
 * cannot drift), renders in chromium, and screenshots each diagram's SVG — at
 * deviceScaleFactor 2, cropped to the diagram rather than the container.
 *
 * Needs chromium: npx playwright install chromium
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = process.cwd();
const OUT = join(ROOT, 'deck', 'diagrams');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};

// ── a static server for the repo, so relative fetches work ────────────────
const server = createServer(async (req, res) => {
  try {
    const file = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 2600, height: 1600 },
    deviceScaleFactor: 2,
  });
  await page.goto(`http://127.0.0.1:${port}/deck/mermaid-render.html?w=2400`);

  try {
    await page.waitForFunction('window.__done === true', null, { timeout: 90_000 });
  } catch {
    throw new Error('diagrams never finished rendering — is the CDN reachable?');
  }
  const err = await page.evaluate('window.__error || null');
  if (err) throw new Error(String(err));

  const svgs = page.locator('.diagram svg');
  const n = await svgs.count();
  if (!n) throw new Error('no diagrams found in WORKFLOW.md');
  for (let i = 0; i < n; i++) {
    const path = join(OUT, `d${i + 1}.png`);
    await svgs.nth(i).screenshot({ path });
    console.log(`  d${i + 1}.png  <- diagram ${i + 1} of ${n}`);
  }
  console.log(`rendered ${n} diagram(s) from WORKFLOW.md into deck/diagrams/`);
} finally {
  await browser.close();
  server.close();
}
