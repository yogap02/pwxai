/**
 * Environment loading. The trap this module exists to prevent
 * (pipeline-pattern.md §5, "The environment trap"):
 *
 *   A variable must be registered in three places: the CI pipeline definition,
 *   the container environment, and the example env file. Tests run *inside* the
 *   container, so a value set only in the CI step shell never reaches them, and
 *   the run quietly falls back to the default target.
 *
 * So: defaults are read from `.env` and can be overridden by CI. When a value is
 * missing AND malformed-when-empty would let work silently go to the wrong
 * target, we throw. The one deliberate fallback is BASE_URL for local dev, and
 * it is logged loudly.
 */

import dotenv from 'dotenv';
import process from 'node:process';

dotenv.config({ quiet: true });

const LOCAL_BASE_URL_DEFAULT = 'http://localhost:3000';

/**
 * Reasoning-effort values accepted by the chat-completions API. A reasoning
 * model with the pipeline's small token budgets spends every token thinking and
 * returns null content, so operators can turn it off with
 * MODEL_REASONING_EFFORT=none. A malformed value throws rather than defaulting.
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

function parseReasoningEffort(): ReasoningEffort | undefined {
  const raw = optionalEnv('MODEL_REASONING_EFFORT');
  if (raw === undefined) return undefined;
  if (!(REASONING_EFFORTS as readonly string[]).includes(raw)) {
    throw new Error(
      `MODEL_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(', ')}, got: ${raw}`,
    );
  }
  return raw as ReasoningEffort;
}

/** The values that read as "on" / "off" for a boolean flag like DEBUG. */
export const BOOLEAN_TRUE = ['1', 'true', 'yes', 'on'] as const;
export const BOOLEAN_FALSE = ['0', 'false', 'no', 'off'] as const;

/**
 * Parse a boolean flag. Unset is off. A value outside the accepted set THROWS
 * rather than defaulting, the same rule as MODEL_REASONING_EFFORT: a flag that
 * silently reads as off is a flag someone will swear they turned on.
 */
export function parseBooleanFlag(name: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if ((BOOLEAN_TRUE as readonly string[]).includes(value)) return true;
  if ((BOOLEAN_FALSE as readonly string[]).includes(value)) return false;
  throw new Error(
    `${name} must be one of ${[...BOOLEAN_TRUE, ...BOOLEAN_FALSE].join(', ')}, got: ${raw}`,
  );
}

export interface Env {
  /** URL of the app under test. Defaults to localhost dev when unset, with a warning. */
  BASE_URL: string;
  /** Anthropic-compatible model API key (OpenAI-compatible chat completions shape). */
  MODEL_API_KEY: string;
  /** Base URL for the model gateway. */
  MODEL_BASE_URL: string;
  /** Model name used by the AI stages. */
  MODEL_NAME: string;
  /** Concurrency for model calls. */
  MODEL_CONCURRENCY: number;
  /** Reasoning effort override for reasoning models. Unset = gateway default. */
  MODEL_REASONING_EFFORT: ReasoningEffort | undefined;
  /**
   * Debug logging toggle (1/true/yes/on turns it on). When on, the pipeline and
   * the page objects narrate what they are doing, with the values behind each
   * decision — see `core/util/debug.ts`. Observation only: it changes nothing
   * about what a run does.
   */
  DEBUG: boolean;
  /** GH token used by the delivery layer for PR comments. */
  GH_TOKEN: string | undefined;
  /** Set when running in CI. */
  CI: string | undefined;
  /**
   * A grep an operator supplies to run the pipeline with a filter of their own
   * choosing — e.g. driving the whole pipeline end to end when only stages 1–2
   * changed, and there is no reason to pay for the full suite. ABSOLUTE when set:
   * it is the filter, the planner agent is skipped, and the floor is not applied
   * (see `planning/planner.ts`).
   *
   * Never a standing value in the CI definition, unlike every other variable
   * here: it is an operator override, and a value there would pin every run to it.
   * It is a `workflow_dispatch` input instead, so an operator can still supply one
   * for a single run without a shell. Same class of exception as `HEAL_RUN_ID` — that
   * one is per-run plumbing, this one is a human's instruction — and
   * `npm run self-checks` enforces that every assignment of it comes from an input.
   */
  TEST_GREP: string | undefined;
  /** Repo slug (owner/name) for delivery. */
  REPO_SLUG: string | undefined;
  /** Source branch for the pipeline. */
  SOURCE_BRANCH: string | undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Register it in the CI definition, the container env, and .env.example.`,
    );
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

export const env: Env = {
  BASE_URL: process.env.BASE_URL ?? LOCAL_BASE_URL_DEFAULT,
  MODEL_API_KEY: process.env.MODEL_API_KEY ?? '',
  MODEL_BASE_URL: process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1',
  MODEL_NAME: process.env.MODEL_NAME ?? 'gpt-4.1-mini',
  MODEL_CONCURRENCY: Number(process.env.MODEL_CONCURRENCY ?? '4'),
  MODEL_REASONING_EFFORT: parseReasoningEffort(),
  DEBUG: parseBooleanFlag('DEBUG', optionalEnv('DEBUG')),
  GH_TOKEN: optionalEnv('GH_TOKEN'),
  CI: optionalEnv('CI'),
  TEST_GREP: optionalEnv('TEST_GREP'),
  REPO_SLUG: optionalEnv('REPO_SLUG'),
  SOURCE_BRANCH: optionalEnv('SOURCE_BRANCH'),
};

export function requireModelKey(): string {
  return requireEnv('MODEL_API_KEY');
}

if (!process.env.BASE_URL) {
  // eslint-disable-next-line no-console -- deliberate loud fallback
  console.warn(
    `[env] BASE_URL not set; defaulting to ${LOCAL_BASE_URL_DEFAULT}. ` +
      'Set it in the CI definition, container env, and .env.example.',
  );
}
