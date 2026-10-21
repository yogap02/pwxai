/**
 * Prompt loader: markdown templates with {{PLACEHOLDER}} substitution.
 *
 * Prompts are markdown when mostly static and inline when mostly computed
 * (pipeline-pattern.md §5). Substitution is strict: a template that
 * references a placeholder the caller did not provide throws, because
 * silently emitting the raw `{{NAME}}` marker would produce a model call
 * that fails in ways that look like a model error, not a template bug.
 */

import { readFile } from 'node:fs/promises';
import { rehydrate } from '../../core/util/paths.js';

export type Placeholders = Record<string, string>;

export async function loadPrompt(name: string, values: Placeholders): Promise<string> {
  const path = rehydrate(`src/ai/prompts/${name}.md`);
  const template = await readFile(path, 'utf8');
  return substitute(template, values);
}

export function substitute(template: string, values: Placeholders): string {
  // Detect all placeholders in the template.
  const placeholders = new Set<string>();
  for (const m of template.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) {
    placeholders.add(m[1]!);
  }
  // Throw on missing — strictness is the point.
  for (const name of placeholders) {
    if (!(name in values)) {
      throw new Error(
        `Prompt template references {{${name}}} but the caller did not provide it`,
      );
    }
  }
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name: string) => values[name]!);
}
