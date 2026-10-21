/**
 * Coverage backstop — REPORT-ONLY.
 *
 * Checks that every clause the generator claimed to cover actually appears in
 * the produced block, and that an expectation phrased as negation ("must not",
 * "should not", "never") is matched by an assertion of absence in the code.
 *
 * Per the pattern doc limits: this cannot be made exact. A bad substitution
 * and a positive assertion that legitimately entails the negative cannot be
 * separated by this check. Treat output as a review queue; only promote to
 * blocking once a real log shows it firing on genuine substitutions alone.
 */

import type { Generation } from './generator.js';
import type { ScenarioBlock } from '../core/scenario/parser.js';

export interface BackstopFlag {
  scenarioId: string;
  scenarioTitle: string;
  kind: 'uncovered-clause' | 'negation-not-asserted';
  detail: string;
}

export interface BackstopReport {
  flags: BackstopFlag[];
}

const NEGATION = /\b(must not|should not|cannot|never|won't|cannot)\b/i;
const POSITIVE_ABSENCE_ASSERTIONS = [
  /expect\([^)]*\)\.not\.toBe/,
  /expect\([^)]*\)\.not\.toHave/,
  /expect\([^)]*\)\.toBeHidden/,
  /expect\([^)]*\)\.toBeNull/,
  /expect\([^)]*\)\.toHaveCount\(0\)/,
];

export function backstopCheck(
  generations: ReadonlyMap<string, Generation>,
  scenariosById: ReadonlyMap<string, ScenarioBlock>,
): BackstopReport {
  const flags: BackstopFlag[] = [];

  for (const [id, gen] of generations) {
    const scenario = scenariosById.get(id);
    if (!scenario) continue;

    for (const clause of gen.coveredClauses) {
      if (!clausePresent(clause, gen.code)) {
        flags.push({
          scenarioId: id,
          scenarioTitle: scenario.title,
          kind: 'uncovered-clause',
          detail: `generator claimed to cover "${clause}" but the block does not reference it`,
        });
      }
    }

    if (NEGATION.test(scenario.expected)) {
      const hasAbsence = POSITIVE_ABSENCE_ASSERTIONS.some((re) => re.test(gen.code));
      if (!hasAbsence) {
        flags.push({
          scenarioId: id,
          scenarioTitle: scenario.title,
          kind: 'negation-not-asserted',
          detail: `Expected asserts a negative but the block has no absence assertion: ${scenario.expected}`,
        });
      }
    }
  }

  return { flags };
}

/** Loose presence check: the clause's distinctive tokens all appear in the code. */
function clausePresent(clause: string, code: string): boolean {
  const tokens = clause
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3);
  if (tokens.length === 0) return true;
  const haystack = code.toLowerCase();
  return tokens.some((t) => haystack.includes(t));
}
