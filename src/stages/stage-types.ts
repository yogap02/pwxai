/**
 * Shared stage types. The spine is one indirection (pipeline-pattern.md §2):
 * stage 1 emits {domain, title} pairs; a single extractor turns those into a
 * domain list; stages 3 and 4 iterate that list. No feature name appears in
 * the orchestrator — domain identity comes from the scenario filenames plus
 * the resolved map.
 */

import type { ScenarioBlock } from '../core/scenario/parser.js';

export interface Scope {
  riskAreas: string[];
  /** New scenarios stage 1 wrote, keyed by domain (lowercase). */
  newScenarios: Map<string, { title: string; tags: string[]; expected: string; notes: string }[]>;
}

/** Extract the ordered domain list from a scope. The single indirection. */
export function domainsOfScope(scope: Scope | null): string[] {
  if (!scope) return [];
  return [...scope.newScenarios.keys()];
}

export interface DigestOutcome {
  domain: string;
  /** Titles generated in this run. */
  generatedTitles: string[];
  /** Marked-unbuildable blocks: stage 4's work order. */
  unbuildable: Array<{ scenario: ScenarioBlock; missingCapabilities: string[] }>;
}
