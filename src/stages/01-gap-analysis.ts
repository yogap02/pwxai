/**
 * Stage 1: gap-analysis. Reads the issue + diff, works out which areas of the
 * app the change puts at risk, checks that risk against existing coverage,
 * writes the missing scenarios in plain English, and appends them to
 * scenarios/<domain>.txt.
 *
 * FATAL on failure: comments on the source PR and exits 1
 * (pipeline-pattern.md §2). Stages 1 and 2 are fatal because they are the
 * ones that decide *what to cover*.
 */

import { z } from 'zod';
import type { StageContext, StageSpec } from '../core/orchestration/stage-runner.js';
import { ModelClient } from '../ai/model-client.js';
import { extractJson } from '../ai/model-client.js';
import { loadPrompt } from '../ai/prompts/load.js';
import type { CodeHost } from '../delivery/code-host.js';
import { appendScenarios } from '../core/scenario/writer.js';
import { dbg } from '../core/util/debug.js';
import type { Scope } from './stage-types.js';

const ResponseSchema = z.object({
  riskAreas: z.array(z.string()).default([]),
  scenarios: z.array(
    z.object({
      domain: z.string(),
      title: z.string(),
      tags: z.array(z.string()).default([]),
      expected: z.string(),
      notes: z.string().default(''),
    }),
  ).default([]),
});

export function createGapAnalysisStage(
  model: ModelClient,
  codeHost: CodeHost,
  prNumber: number,
): StageSpec {
  return {
    name: 'gap-analysis',
    fatal: true,
    run: async (ctx: StageContext) => {
      const issue = await codeHost.fetchSource(prNumber);
      ctx.manifest.sourcePR = issue.number;
      ctx.manifest.branch = issue.branch;

      dbg('gap-analysis', 'issue', {
        requestedPr: prNumber,
        number: issue.number,
        title: issue.title,
        branch: issue.branch,
        diffChars: issue.diff.length,
        diffSentToModel: Math.min(issue.diff.length, 100_000),
      });

      const { existingScenariosText, scopeRules } = await gatherContext();

      const prompt = await loadPrompt('gap-analysis', {
        ISSUE_TITLE: issue.title,
        ISSUE_BODY: issue.body,
        DIFF: issue.diff.slice(0, 100_000),
        EXISTING_SCENARIOS: existingScenariosText,
        SCOPE_RULES: scopeRules,
      });

      const raw = await model.chat(
        [
          { role: 'system', content: 'You are a test coverage analyst. Respond only with JSON.' },
          { role: 'user', content: prompt },
        ],
        { maxTokens: 4_000, temperature: 0.2 },
      );

      const parsed = ResponseSchema.parse(extractJson(raw));
      dbg('gap-analysis', 'response', {
        riskAreas: parsed.riskAreas,
        scenarios: parsed.scenarios.length,
        domains: [...new Set(parsed.scenarios.map((s) => s.domain.toLowerCase()))],
      });

      // Append new scenarios to their domain files. The domain key must be
      // lowercase and match an existing scenario filename (casing is load-bearing).
      const newScenarios = new Map<string, { title: string; tags: string[]; expected: string; notes: string }[]>();
      for (const s of parsed.scenarios) {
        const domain = s.domain.toLowerCase();
        const list = newScenarios.get(domain) ?? [];
        list.push({ title: s.title, tags: s.tags, expected: s.expected, notes: s.notes });
        newScenarios.set(domain, list);
      }
      const written = await appendScenarios(newScenarios);
      dbg('gap-analysis', 'appended', { total: written.totalAppended, files: written.files });

      // Persist the risk analysis as STRUCTURED data on the manifest, not only as
      // the prose this stage returns. Stage 5's planner agent reasons over the risk
      // areas; a risk area that survives only as a rendered line cannot be fed to it.
      ctx.manifest.riskAreas = parsed.riskAreas;
      ctx.manifest.newScenarios = parsed.scenarios.map((s) => ({
        domain: s.domain.toLowerCase(),
        title: s.title,
        tags: s.tags,
      }));
      dbg('gap-analysis', 'scope-recorded', {
        riskAreas: ctx.manifest.riskAreas.length,
        newScenarios: ctx.manifest.newScenarios.length,
      });

      // The manifest is NOT updated with scenarios here. Stage 1 writes scenarios
      // into the scenario files; stage 2 re-parses those files and records each
      // scenario with a real id, content hash and verdict. Pushing from here
      // produced rows with `id: ''` that nothing ever completed.
      return [
        `Risk areas: ${parsed.riskAreas.join(', ') || '(none identified)'}`,
        `New scenarios appended: ${written.totalAppended} across ${written.files.length} domain file(s)`,
        ...written.files.map((f) => `  + ${f}`),
      ].join('\n');
    },
  };
}

async function gatherContext(): Promise<{ existingScenariosText: string; scopeRules: string }> {
  const { readFile } = await import('node:fs/promises');
  const { listScenarioFiles } = await import('../core/scenario/manifest.js');
  const { rehydrate } = await import('../core/util/paths.js');

  const files = await listScenarioFiles();
  const parts: string[] = [];
  for (const f of files) {
    const text = await readFile(rehydrate(f), 'utf8');
    parts.push(`--- ${f} ---\n${text}`);
  }
  let scopeRules = '';
  try {
    scopeRules = await readFile(rehydrate('config/scope-rules.md'), 'utf8');
  } catch {
    scopeRules = '(No scope rules file found. Create config/scope-rules.md with what this product deliberately will not test, and why.)';
  }
  return { existingScenariosText: parts.join('\n\n'), scopeRules };
}
