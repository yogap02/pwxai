/**
 * Scenario parser.
 *
 * A scenario is the source of truth (pipeline-pattern.md §3, first decision):
 * a plain-text block in a `.txt` file with `TEST:`, `Tags:`, `Expected:` and
 * `Notes:` fields, separated by `---`. Its ID is a hash of the *normalised
 * title only* — so regeneration is keyed on inputs changing, not on a verdict.
 * The body is content-hashed separately so a block stays held when the prose
 * hasn't moved.
 *
 * This module is pure: no I/O, no Playwright, no model calls. It is consumed
 * by stage 2 (digest) and by self-checks.
 */

import { createHash } from 'node:crypto';

export interface ScenarioBlock {
  /** Hash of normalised title; stable identity across edits to body. */
  id: string;
  /** Hash of the full normalised block content; detects prose drift. */
  contentHash: string;
  title: string;
  tags: string[];
  expected: string;
  notes: string;
  /** Original raw text, preserved verbatim. */
  raw: string;
}

/** Block separator line. Exactly three dashes on its own line. */
const SEPARATOR = /^---\s*$/m;

/** Parse a scenario file into blocks. Empty segments are ignored. */
export function parseScenarioFile(text: string): ScenarioBlock[] {
  return text
    .split(SEPARATOR)
    .map((segment) => parseBlock(segment))
    .filter((block): block is ScenarioBlock => block !== null);
}

/** Parse one segment into a block, or null when the segment is blank. */
export function parseBlock(segment: string): ScenarioBlock | null {
  const trimmed = segment.trim();
  if (trimmed === '') return null;

  const title = extractField(trimmed, 'TEST');
  const tagsRaw = extractField(trimmed, 'Tags');
  const expected = extractField(trimmed, 'Expected') ?? '';
  const notes = extractField(trimmed, 'Notes') ?? '';

  if (title === null) {
    // A block without TEST: is not a scenario — treat as a comment segment and skip.
    return null;
  }

  const tags = tagsRaw
    ? tagsRaw.split(/[\s,]+/).filter((t) => t.length > 0)
    : [];

  const normalised = normalise(title);
  return {
    id: hash(normalised),
    contentHash: hash(normalise(trimmed)),
    title,
    tags,
    raw: trimmed,
    expected,
    notes,
  };
}

/**
 * Extract a field value: `FIELD:` at line start, capturing until the next
 * field keyword at line start or end of block. Multi-line values are joined
 * with newlines verbatim.
 */
export function extractField(block: string, field: string): string | null {
  const fields = ['TEST', 'Tags', 'Expected', 'Notes'];
  const others = fields.filter((f) => f !== field);
  const stopPattern = others.map((f) => `^${f}:`).join('|');
  const re = new RegExp(
    `^${field}:\\s*([\\s\\S]*?)(?=${stopPattern}|$)`,
    'm',
  );
  const match = block.match(re);
  if (!match) return null;
  const value = match[1];
  return value !== undefined ? value.trim() : null;
}

/** Normalise for stable hashing: lowercase, collapse whitespace, strip trailing punctuation. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
}

/** SHA-256 of the input, truncated to 16 hex chars — enough to identify a block within one file. */
export function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
