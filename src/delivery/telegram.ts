/**
 * The report channel: a run tells a chat what it found.
 *
 * Reporting is the last thing a pipeline may do silently, so this module is exact about
 * three things:
 *
 * 1. **The bot token appears nowhere but the request.** A send is
 *    `https://api.telegram.org/bot<TOKEN>/sendMessage`, so the URL carries the secret: it is
 *    never logged, never put in a thrown message, and never written into the run report. The
 *    patterns in `core/util/redaction.ts` cover it as a backstop — the primary defence is
 *    that no string this module returns ever contains it.
 * 2. **The message is plain about scope.** It carries the same scope lines the summary and
 *    the PR body use (`scopeCoverageLines`), because `6 passed` reads as "everything passed"
 *    unless the message also says the run was narrowed, and what it left out.
 * 3. **HTML, never Markdown.** Telegram's MarkdownV2 requires every `-`, `.`, `(`, `)` and
 *    `!` escaped, and scenario titles are full of them — one missed escape is a 400 that
 *    loses the entire report. HTML needs `&`, `<`, `>` escaped and nothing else, so the
 *    message is composed in the summary's markdown and converted once, escaping first.
 */

import type { RunManifest } from '../core/scenario/manifest.js';
import { scopeCoverageLines, verdictCounts } from '../core/orchestration/run-summary.js';
import { redact } from '../core/util/redaction.js';
import { env } from '../core/util/env.js';

/** Telegram rejects a longer message outright, so the markdown is cut well before the limit. */
const MARKDOWN_BUDGET = 3400;
const TELEGRAM_LIMIT = 4096;

export interface TelegramConfig {
  token: string;
  chatId: string;
}

/** The channel, or null when it is not configured — a legitimate setup, not a degradation. */
export function telegramConfig(): TelegramConfig | null {
  const token = env.TELEGRAM_API_KEY;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (token === undefined || chatId === undefined) return null;
  return { token, chatId };
}

export type StatusLevel = 'failed' | 'attention' | 'none' | 'ok';

export interface StatusLine {
  level: StatusLevel;
  /** Short, because it is the headline whenever it is the worst of the two. */
  label: string;
}

export interface RunStatus {
  /** The process: did the run do its job? */
  pipeline: StatusLine;
  /** The product: what the browser run found. */
  testing: StatusLine;
}

const RANK: Record<StatusLevel, number> = { failed: 3, attention: 2, none: 2, ok: 0 };

/** Worst of the two, for the rare caller that needs one answer. A tie goes to the pipeline. */
export function worstLevel(a: StatusLevel, b: StatusLevel): StatusLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

export function statusEmoji(level: StatusLevel): string {
  if (level === 'failed') return '❌';
  return level === 'ok' ? '✅' : '⚠️';
}

/**
 * The **process**: did the pipeline do its job?
 *
 * A failed test is deliberately NOT this. There are two statuses because a failed test leaves
 * every stage `succeeded` — the suite went red and nothing in the run went wrong — and folding
 * them into one verdict is how a red suite gets read as a broken pipeline, and a broken
 * pipeline as a red suite. Both misreadings cost a person the same thing: they go and fix the
 * wrong one.
 */
export function pipelineStatus(manifest: RunManifest): StatusLine {
  const failedStage = manifest.stages.find((s) => s.status === 'failed');
  if (failedStage) return { level: 'failed', label: `stage \`${failedStage.name}\` failed` };

  const notes: string[] = [];
  const blocked = manifest.domains.reduce((n, d) => n + d.unbuildable.length, 0);
  if (blocked > 0) notes.push(`${blocked} scenario(s) blocked`);
  const degraded = manifest.stages.filter((s) => (s.degradation ?? []).length > 0);
  if (degraded.length > 0) notes.push(`degraded: ${degraded.map((s) => s.name).join(', ')}`);

  return notes.length === 0
    ? { level: 'ok', label: 'Nothing needs attention' }
    : { level: 'attention', label: notes.join(' · ') };
}

/**
 * The **product**: what the browser run found.
 *
 * A run that recorded no result at all is `none`, not a pass: nothing was verified, and a green
 * tick for "we did not look" is the lie the colour must not tell.
 */
export function testingStatus(manifest: RunManifest): StatusLine {
  const totals = playwrightTotals(manifest);
  if (totals === null) return { level: 'none', label: 'no test run was recorded' };
  if (totals.failed > 0) {
    return {
      level: 'failed',
      label: `${totals.failed} test${totals.failed === 1 ? '' : 's'} failed`,
    };
  }
  if (totals.flaky > 0) return { level: 'attention', label: `${totals.flaky} test(s) flaky` };
  return { level: 'ok', label: `${totals.passed} passed · 0 failed` };
}

export function runStatus(manifest: RunManifest): RunStatus {
  return { pipeline: pipelineStatus(manifest), testing: testingStatus(manifest) };
}

/**
 * The scope this run actually had, or null when it ran everything.
 *
 * This exists because of the one reading a report must not invite: "6 passed" from a smoke
 * run is true, and what a reader takes from it is that the suite is green — while the test
 * that everyone knows is red sits outside the scope, untested. `regression` is the whole
 * suite and is not a narrowing; a tier mix is named rather than guessed.
 */
function narrowScope(manifest: RunManifest): string | null {
  // The operator's own filter, named literally: `@core` says more to a reader than "override".
  if (manifest.grepOverride !== null) return manifest.grepOverride;
  const tiers = [
    ...new Set(
      manifest.domains.map((d) => d.tier).filter((t): t is string => t !== null),
    ),
  ];
  if (tiers.length === 0) return null;
  if (tiers.length > 1) return 'tiered';
  return tiers[0] === 'regression' ? null : tiers[0]!;
}

export interface ReportOptions {
  /** The repo the change under test lives in, for the source line. */
  sourceRepo?: string | undefined;
}

export function buildReportMessage(manifest: RunManifest, opts: ReportOptions = {}): string {
  const markdown = reportMarkdown(manifest, opts);
  const html = markdownToHtml(markdown);
  return html.length <= TELEGRAM_LIMIT ? html : fitTelegram(markdown);
}

/**
 * Cut a report that is too long to send, and say so.
 *
 * The notice is appended **after** the cut, never before it: appended first, the cut
 * itself would remove the one line that explains why the message ends mid-sentence.
 * The budget has to be on the *converted* text, too — `<code>` is longer than the
 * backtick pair it replaced, so a markdown character budget alone is not a guarantee.
 */
function fitTelegram(markdown: string): string {
  const notice = "\n\n(truncated — the full summary is in the run's artifact)";
  const room = TELEGRAM_LIMIT - notice.length;
  let budget = MARKDOWN_BUDGET;
  let html = markdownToHtml(markdown.slice(0, budget));
  while (html.length > room && budget > 400) {
    budget = Math.floor(budget * 0.8);
    html = markdownToHtml(markdown.slice(0, budget));
  }
  return `${html}${notice}`;
}

function reportMarkdown(manifest: RunManifest, opts: ReportOptions): string {
  const status = runStatus(manifest);
  const scope = narrowScope(manifest);
  const out: string[] = [
    `**Pipeline run \`${manifest.runId}\`**${scope === null ? '' : ` · \`${scope}\` scope only`}`,
    '',
    // Two labelled statuses rather than one verdict, and Testing first: that is what a reader
    // acts on, and a preview leading with "Nothing needs attention" while a test failed is the
    // exact misreading the labels exist to prevent.
    `**Testing Status:** ${statusEmoji(status.testing.level)} ${status.testing.label}`,
    `**Pipeline Status:** ${statusEmoji(status.pipeline.level)} ${status.pipeline.label}`,
    '',
  ];
  if (scope !== null) {
    out.push(
      `**Not a verdict on the whole suite** — this is the \`${scope}\` scope; tests outside it were not run.`,
      '',
    );
  }

  const repo = opts.sourceRepo === undefined ? '' : `\`${opts.sourceRepo}\` `;
  out.push(
    manifest.sourcePR === null
      ? `**Source:** ${repo}${manifest.branch === null ? 'no PR context' : `branch \`${manifest.branch}\``}`
      : `**Source:** ${repo}PR #${manifest.sourcePR}`,
    '',
  );

  out.push('**Scope**', ...humanScope(manifest), '');

  out.push('**Result**', ...resultLines(manifest), '');

  out.push('**Coverage**', ...coverageLines(manifest), '');

  const needsAttention = manifest.stages
    .filter((s) => s.status === 'failed')
    .map((s) => `- stage \`${s.name}\` **failed**`);
  if (needsAttention.length > 0) out.push('**Needs attention**', ...needsAttention, '');

  if (manifest.delivery?.prUrl != null) {
    out.push(
      `**Delivered:** [PR opened](${manifest.delivery.prUrl}) — for review; nothing merges itself.`,
    );
  } else if (manifest.delivery !== null && manifest.delivery !== undefined) {
    out.push('**Delivered:** nothing — the run generated nothing to ship.');
  }

  return out.join('\n').trimEnd();
}

/** The summary's own scope lines, or a plain statement that no scope was decided. */
function humanScope(manifest: RunManifest): string[] {
  const lines = scopeCoverageLines(manifest);
  if (lines.length === 0) return ['- no scope recorded (stage 5 did not reach a decision)'];
  return lines;
}

function resultLines(manifest: RunManifest): string[] {
  const out: string[] = [];
  for (const d of manifest.domains) {
    if (d.playwright === null) continue;
    const tier = d.tier === null ? '' : ` — tier \`${d.tier}\``;
    out.push(
      `- \`${d.domain}\`${tier}: **${d.playwright.passed} passed · ${d.playwright.failed} failed · ${d.playwright.flaky} flaky**`,
    );
  }
  const totals = playwrightTotals(manifest);
  if (totals === null) {
    return ['- nothing was run — stage 6 was skipped, or the run did not reach it'];
  }
  out.push(`- **Total: ${totals.passed} passed · ${totals.failed} failed · ${totals.flaky} flaky**`);
  if (totals.failed > 0) {
    out.push('- a failing test is a signal, not a flake to retry. Nothing is reverted for it.');
  }
  return out;
}

function coverageLines(manifest: RunManifest): string[] {
  const written = manifest.newScenarios.length;
  const out = [
    written === 0
      ? '- no scenario was written for this change'
      : `- ${written} scenario(s) written for this change`,
    `- digest: ${verdictCounts(manifest) || 'no verdict recorded'} (${manifest.scenarios.length} scenario(s))`,
  ];
  const blocked = manifest.domains.flatMap((d) => d.unbuildable);
  if (blocked.length === 0) return out;
  out.push(`- **${blocked.length} blocked** — the page objects cannot express these yet:`);
  for (const w of blocked.slice(0, 5)) {
    out.push(`  - ${w.scenario.title}`);
  }
  if (blocked.length > 5) out.push(`  - …and ${blocked.length - 5} more`);
  return out;
}

function playwrightTotals(
  manifest: RunManifest,
): { passed: number; failed: number; flaky: number } | null {
  let seen = false;
  const totals = { passed: 0, failed: 0, flaky: 0 };
  for (const d of manifest.domains) {
    if (d.playwright === null) continue;
    seen = true;
    totals.passed += d.playwright.passed;
    totals.failed += d.playwright.failed;
    totals.flaky += d.playwright.flaky;
  }
  return seen ? totals : null;
}

/**
 * The summary's markdown, as Telegram's HTML: escape first, then the three constructs this
 * report uses (code, bold, a link). Escaping first is what makes a scenario title containing
 * `&` or `<` harmless — an unescaped one is a rejected message, or worse, a broken tag — and
 * it is also what makes a URL safe inside an `href`, since `&` in a query string must be
 * `&amp;` there too.
 */
export function markdownToHtml(markdown: string): string {
  return markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export interface SendOutcome {
  ok: boolean;
  /** Human-readable, and guaranteed free of the token. */
  reason: string;
}

export interface SendOptions {
  /** Injected by `self-checks`; a real run uses global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Send the report. Never throws: the caller decides what a failed report means, and a run
 * whose tests passed must not be undone by the channel being down. The reason it returns is
 * safe to persist — see the note at the top of this file.
 */
export async function sendReportMessage(
  text: string,
  opts: SendOptions = {},
): Promise<SendOutcome> {
  const config = telegramConfig();
  if (config === null) {
    return {
      ok: false,
      reason: 'no report channel configured (TELEGRAM_API_KEY / TELEGRAM_CHAT_ID unset)',
    };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('deadline')), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    const body = redact(await res.text());
    if (!res.ok) {
      return { ok: false, reason: `Telegram rejected the message: HTTP ${res.status} ${describe(body)}` };
    }
    return { ok: true, reason: `HTTP ${res.status}` };
  } catch (err) {
    // The name, never the message: a fetch rejection's message (or its cause) can carry the
    // request URL, and that URL contains the bot token.
    const name = err instanceof Error ? err.name : 'unknown';
    return { ok: false, reason: `could not reach Telegram (${name})` };
  } finally {
    clearTimeout(timer);
  }
}

function describe(body: string): string {
  try {
    const parsed = JSON.parse(body) as { description?: unknown };
    if (typeof parsed.description === 'string') return parsed.description;
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return body.slice(0, 200).replace(/\s+/g, ' ');
}
