/**
 * Debug logging, gated by `DEBUG` (see `env.ts`).
 *
 * Why it exists: a pipeline run is a dozen model calls, a browser run and a set
 * of file writes. When something looks wrong the question is always "which step,
 * with which inputs, decided that?" — and answering it by reading the code is
 * slow, while `summary.md` only shows the end state. This prints the path WHILE
 * the run happens: the scenario being classified, the model call in flight, the
 * locator being resolved.
 *
 * Off by default, and one boolean read per call when off. Turning it on changes
 * nothing about what the run *does* — it is observation, not a mode. Nothing
 * here throws: a debug line must never be able to take a run down.
 *
 * Two rules keep it useful rather than noisy:
 *   1. Every line carries the VALUES that went into the decision (`domain`,
 *      `scenario`, `model`, `verdict`, counts, milliseconds). A line that says
 *      only "classifying scenario" is noise, not provenance.
 *   2. Long input cannot drown the run. A prompt, a diff, a completion is clamped
 *      to a budget and the elision says how much was cut — and a cut never lands
 *      in the middle of a surrogate pair (an emoji, a rare glyph), so the output
 *      stays valid text.
 *
 * The AI calls get a boxed rendering (`debugAiRequest` / `debugAiResponse`)
 * because they are the hardest thing to follow: the whole interaction — model,
 * budgets, every message, the completion, the token usage, the duration — is
 * printed as one block.
 */

import { env } from './env.js';
import { redact } from './redaction.js';

/** Greppable marker on every line, so debug output can be filtered out of a run. */
const PREFIX = '[debug]';
const TREE_TOP = '┌─';
const TREE_MID = '│';
const TREE_BOTTOM = '└─';

/** Cap for one value interpolated into a field list. */
export const FIELD_MAX = 120;
/** Cap for a whole multi-line body (a prompt, a completion, a page snapshot). */
export const BODY_MAX = 1_200;

/** Is debug output on for this process? Reads the parsed `DEBUG` toggle. */
export function isDebug(): boolean {
  return env.DEBUG;
}

/**
 * One line: `[debug] <scope> <message> key=value key=value`.
 *
 * `fields` is where the correlated values go. Prefer a specific scope
 * (`classify`, `digest`, `heal`, `pom:landing-page`) over a generic one, so a
 * run can be read by grepping a single concern.
 */
export function dbg(scope: string, message: string, fields?: Record<string, unknown>): void {
  if (!env.DEBUG) return;
  const tail = fields === undefined ? '' : ` ${renderFields(fields)}`;
  emit(`${PREFIX} ${scope} ${message}${tail}`);
}

/** A titled multi-line block — a prompt, a response, a snapshot, a work order. */
export function dbgBlock(scope: string, title: string, body: string, max = BODY_MAX): void {
  if (!env.DEBUG) return;
  const clamped = clampBlock(body, max);
  const size = clamped.truncated
    ? `${body.length} chars, showing ${clamped.text.length}`
    : `${body.length} chars`;
  emit(`${PREFIX} ${TREE_TOP} ${scope} ${title} (${size})`);
  emitBody(splitBody(clamped.text), clamped.truncated ? body.length - clamped.text.length : 0);
  emit(`${PREFIX} ${TREE_BOTTOM}`);
}

// --- The AI interaction, rendered as one readable block -----------------------

export interface AiUsage {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface AiRequestDebug {
  model: string;
  maxTokens: number;
  temperature: number;
  /** The reasoning effort in effect, or null when the gateway default applies. */
  reasoningEffort: string | null;
  deadlineMs: number;
  messages: ReadonlyArray<{ role: string; content: string }>;
}

export interface AiResponseDebug {
  model: string;
  content: string;
  finishReason: string | null;
  durationMs: number;
  usage?: AiUsage | undefined;
}

/**
 * The request half: which model, with which budgets, and every message. Each
 * message is clamped on its own, so one huge prompt cannot hide the others.
 */
export function debugAiRequest(call: AiRequestDebug): void {
  if (!env.DEBUG) return;
  const chars = call.messages.reduce((n, m) => n + m.content.length, 0);
  emit(`${PREFIX} ${TREE_TOP} ai.request ${call.model}`);
  emit(
    `${PREFIX} ${TREE_MID}   model=${call.model} max_tokens=${call.maxTokens} temperature=${call.temperature} ` +
      `reasoning=${call.reasoningEffort ?? '(gateway default)'} deadline=${call.deadlineMs}ms`,
  );
  emit(`${PREFIX} ${TREE_MID}   messages=${call.messages.length} chars=${chars}`);
  call.messages.forEach((message, i) => {
    emit(
      `${PREFIX} ${TREE_MID}   ── ${message.role} [${i + 1}/${call.messages.length}] ${message.content.length} chars ──`,
    );
    const clamped = clampBlock(message.content, BODY_MAX);
    emitBody(splitBody(clamped.text), clamped.truncated ? message.content.length - clamped.text.length : 0);
  });
  emit(`${PREFIX} ${TREE_BOTTOM}`);
}

/** The response half: what came back, how long it took, what it cost. */
export function debugAiResponse(res: AiResponseDebug): void {
  if (!env.DEBUG) return;
  emit(`${PREFIX} ${TREE_TOP} ai.response ${res.model}`);
  emit(
    `${PREFIX} ${TREE_MID}   finish=${res.finishReason ?? 'unknown'} duration=${res.durationMs}ms ` +
      `chars=${res.content.length}${usageText(res.usage)}`,
  );
  const clamped = clampBlock(res.content, BODY_MAX);
  emitBody(splitBody(clamped.text), clamped.truncated ? res.content.length - clamped.text.length : 0);
  emit(`${PREFIX} ${TREE_BOTTOM}`);
}

/** A call that threw, including the empty-content case models return when thinking. */
export function debugAiError(detail: { model: string; durationMs: number; error: unknown }): void {
  if (!env.DEBUG) return;
  const message = detail.error instanceof Error ? detail.error.message : String(detail.error);
  emit(
    `${PREFIX} ai.error model=${detail.model} duration=${detail.durationMs}ms error=${JSON.stringify(message)}`,
  );
}

// --- Formatting helpers (pure, and self-checked) ------------------------------

/**
 * `ellipsize` flattens whitespace to one line and cuts to `max`, appending how
 * much was removed. Used for any value that must stay on one line.
 */
export function ellipsize(text: string, max = FIELD_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const head = safeSlice(flat, max);
  return `${head}… (+${flat.length - head.length} chars)`;
}

/**
 * `clampBlock` cuts a multi-line body to `max` characters, keeping newlines.
 * The caller is told whether a cut happened so it can say so.
 */
export function clampBlock(text: string, max = BODY_MAX): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: safeSlice(text, max), truncated: true };
}

/** One compact, single-line rendering of an arbitrary field value. */
export function renderValue(value: unknown, max = FIELD_MAX): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(ellipsize(value, max));
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => renderValue(item, max)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return typeof json === 'string' ? ellipsize(json, max) : '[unserialisable]';
    } catch {
      return '[unserialisable]';
    }
  }
  return String(value);
}

/** `key=value key=value`, the tail of a debug line. */
export function renderFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(' ');
}

// --- internals ----------------------------------------------------------------

function emit(line: string): void {
  // Redact on the way out: a prompt or a page snapshot can carry a token or a
  // secret that happened to be in the environment under test.
  // eslint-disable-next-line no-console -- debug output is the point
  console.log(redact(line));
}

/** Indent a body's lines under the tree, and say how much was cut if any. */
function emitBody(lines: readonly string[], cutChars: number): void {
  for (const line of lines) emit(`${PREFIX} ${TREE_MID}   ${line}`);
  if (cutChars > 0) emit(`${PREFIX} ${TREE_MID}   … (+${cutChars} chars cut)`);
}

function splitBody(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** Slice that never splits a surrogate pair (an emoji or a rare glyph). */
function safeSlice(text: string, max: number): string {
  let cut = Math.max(0, Math.min(max, text.length));
  if (cut > 0) {
    const last = text.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  }
  return text.slice(0, cut);
}

function usageText(usage: AiUsage | undefined): string {
  if (usage === undefined) return '';
  const parts: string[] = [];
  if (usage.promptTokens !== undefined) parts.push(`prompt_tokens=${usage.promptTokens}`);
  if (usage.completionTokens !== undefined) parts.push(`completion_tokens=${usage.completionTokens}`);
  if (usage.totalTokens !== undefined) parts.push(`total_tokens=${usage.totalTokens}`);
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}
