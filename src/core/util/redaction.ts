/**
 * Redaction for anything written into the run report or logged.
 * The report is persisted; transcripts and prompts must not carry secrets,
 * tokens, or page content from the environment under test.
 * (pipeline-pattern.md §4, Orchestration layer: "redaction".)
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[a-zA-Z0-9_-]{8,}/g,                    // OpenAI-style API keys
  /ghp_[a-zA-Z0-9]{20,}/g,                    // GitHub PAT
  /gho_[a-zA-Z0-9]{20,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
  /Authorization:\s*[A-Za-z]+\s+\S+/gi,
  /password["']?\s*[:=]\s*["'][^"']{4,}["']/gi,
  // A Telegram send URL *is* the secret: `.../bot<TOKEN>/sendMessage`. Covered by shape as
  // well, because a token can reach a log line without its URL.
  /https:\/\/api\.telegram\.org\/bot[^\s"'`]+/g,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/** Redact every string value in a JSON-serialisable object (shallow-friendly for stage records). */
export function redactObject<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactObject) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactObject(v);
    }
    return out as T;
  }
  return value;
}
