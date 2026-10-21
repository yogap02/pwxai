/**
 * Model client: OpenAI-compatible chat completions (official `openai` SDK),
 * with JSON extraction, truncation repair, and budget-scaled deadlines
 * (pipeline-pattern.md §4, AI layer).
 *
 * JSON extraction is repair-tolerant because models don't always emit clean
 * JSON when asked for it: we first look for a fenced code block, then for the
 * outermost `{...}` or `[...]`, and finally attempt a repair on truncation
 * (close unbalanced braces/brackets). Even with repair, a non-parse fails —
 * we never substitute a guess.
 */

import OpenAI from 'openai';
import { env, requireModelKey, type ReasoningEffort } from '../core/util/env.js';
import { debugAiError, debugAiRequest, debugAiResponse } from '../core/util/debug.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallOptions {
  /** Override the default model. */
  model?: string;
  /** Max tokens for completion. Default 4000. */
  maxTokens?: number;
  /** Temperature. Default 0.2 (deterministic-leaning for schema-bound outputs). */
  temperature?: number;
  /** Deadline for the whole call (network + tokens). Scaled by maxTokens. */
  deadlineMs?: number;
  /** Override the reasoning effort for this call (defaults to MODEL_REASONING_EFFORT). */
  reasoningEffort?: ReasoningEffort;
}

export class ModelClient {
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(opts?: { apiKey?: string; baseURL?: string; model?: string }) {
    this.client = new OpenAI({
      apiKey: opts?.apiKey ?? requireModelKey(),
      baseURL: opts?.baseURL ?? env.MODEL_BASE_URL,
    });
    this.defaultModel = opts?.model ?? env.MODEL_NAME;
  }

  async chat(messages: readonly ChatMessage[], options?: CallOptions): Promise<string> {
    const model = options?.model ?? this.defaultModel;
    const maxTokens = options?.maxTokens ?? 4_000;
    const temperature = options?.temperature ?? 0.2;
    const deadlineMs =
      options?.deadlineMs ?? budgetScaledDeadline(maxTokens);
    const reasoningEffort = options?.reasoningEffort ?? env.MODEL_REASONING_EFFORT;

    // Say the whole interaction up front — model, budgets, every message — so the
    // call can be followed without reading the caller. Gated on DEBUG.
    debugAiRequest({
      model,
      maxTokens,
      temperature,
      reasoningEffort: reasoningEffort ?? null,
      deadlineMs,
      messages,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('deadline')), deadlineMs);
    const startedAt = Date.now();
    try {
      const response = await this.client.chat.completions.create(
        {
          model,
          max_tokens: maxTokens,
          temperature,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          // Omitted entirely when unset, so non-reasoning gateways are unaffected.
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        },
        { signal: controller.signal },
      );
      const choice = response.choices[0];
      const content = choice?.message?.content;
      const finishReason = choice?.finish_reason ?? null;
      const durationMs = Date.now() - startedAt;
      if (typeof content !== 'string' || content.trim() === '') {
        // The empty-content case is the interesting failure (a reasoning model
        // that spent the budget thinking), so the reason is named, not just thrown.
        throw new Error(
          `Model returned empty content (finish_reason=${finishReason ?? 'unknown'})`,
        );
      }
      debugAiResponse({
        model,
        content,
        finishReason,
        durationMs,
        usage:
          response.usage === undefined
            ? undefined
            : {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
              },
      });
      return content;
    } catch (err) {
      debugAiError({ model, durationMs: Date.now() - startedAt, error: err });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Scale deadline by maxTokens: larger completions get more time. */
export function budgetScaledDeadline(maxTokens: number): number {
  // Rough: 1s per 100 tokens, floor 30s, ceiling 5 min.
  const ms = Math.max(30_000, Math.min(300_000, maxTokens * 10));
  return ms;
}

/**
 * Extract the first JSON value from a model response. Tries, in order:
 *   1. Fenced ```json ... ``` block
 *   2. Outermost balanced {...} or [...]
 *   3. Truncation repair on the largest plausible span
 */
export function extractJson<T = unknown>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      /* fall through */
    }
  }

  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const start =
    firstBrace === -1 && firstBracket === -1
      ? -1
      : firstBrace === -1
        ? firstBracket
        : firstBracket === -1
          ? firstBrace
          : Math.min(firstBrace, firstBracket);
  if (start === -1) throw new Error('No JSON object or array found in model output');

  const span = largestBalancedSpan(text, start);
  if (span) {
    try {
      return JSON.parse(span) as T;
    } catch {
      const repaired = repairTruncatedJson(span);
      return JSON.parse(repaired) as T;
    }
  }

  // Whole tail as last resort — model may have emitted unbalanced content
  const tail = text.slice(start);
  return JSON.parse(repairTruncatedJson(tail)) as T;
}

/** Return the largest balanced JSON span starting at `startIdx`, or null. */
function largestBalancedSpan(text: string, startIdx: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
    } else if (c === '}' || c === ']') {
      if (stack.length === 0) return null;
      const expected = stack.pop();
      if (c !== expected) return null;
      if (stack.length === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/** Repair JSON that was cut off mid-stream by closing unbalanced delimiters. */
export function repairTruncatedJson(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = text;
  if (inString) out += '"';
  while (stack.length) out += stack.pop();
  return out;
}
