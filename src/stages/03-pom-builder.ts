/**
 * Stage 3: pom-builder:<domain>. Runs per domain — one invocation per entry
 * in the scope's domain list (the "single indirection" spine). Per-domain
 * failure is RECORDED, not fatal; the run continues.
 */

import { readFile } from 'node:fs/promises';
import type { StageSpec } from '../core/orchestration/stage-runner.js';
import { rehydrate } from '../core/util/paths.js';
import { loadDomainMap, resolveDomain, instructionFileFor } from '../core/scenario/domain-map.js';
import type { BuilderAgent, BuilderTask } from '../agent/builder-agent.js';
import { WriteScopeGuard } from '../agent/write-scope-guard.js';
import { dbg } from '../core/util/debug.js';
import type { DigestOutcome } from './stage-types.js';

export function createPomBuilderStage(
  domain: string,
  builder: BuilderAgent,
  digest: DigestOutcome,
): StageSpec {
  return {
    name: `pom-builder:${domain}`,
    fatal: false,
    run: async (ctx) => {
      const map = await loadDomainMap();
      const resolved = resolveDomain(map, domain);
      if (!resolved) {
        ctx.recordDegradation(`pom-builder:${domain}`, `no domain-map entry for ${domain}`);
        return `Domain ${domain} not in map; skipped.`;
      }
      const entry = resolved.entry;
      // Inside pomDir on purpose — see instructionFileFor().
      const instructionFile = instructionFileFor(entry);

      const missingCapabilities = digest.unbuildable.flatMap((u) => u.missingCapabilities);
      const task: BuilderTask = {
        domain,
        className: entry.className,
        entryPaths: entry.entryPaths,
        needsAuth: entry.needsAuth,
        entryDiscoverySteps: entry.entryDiscoverySteps,
        missingCapabilities,
        allowedWriteDir: entry.pomDir,
        instructionFile,
      };

      const guard = new WriteScopeGuard({
        allowedDirs: [entry.pomDir],
        // The instruction file is inside pomDir, so no separate allow-list entry.
        allowedFiles: [],
      });
      dbg('pom-builder', 'task', {
        domain,
        className: entry.className,
        entryPaths: entry.entryPaths,
        missingCapabilities,
        allowedWriteDir: entry.pomDir,
      });
      const pomIndexPath = `${entry.pomDir}/index.ts`;
      await guard.snapshot(pomIndexPath);
      await guard.snapshot(instructionFile);

      const result = await builder.build(task);

      // Post-build verification — in-scope and additive-only.
      const violations = [
        ...(await guard.verify(pomIndexPath)),
        ...(await guard.verify(instructionFile)),
      ];
      for (const v of violations) {
        await guard.revert(v.file);
        ctx.recordDegradation(
          `pom-builder:${domain}`,
          `reverted ${v.file}: ${v.reason}`,
        );
      }

      // Persist the agent's summary, never its transcript. Read back the
      // instruction file to confirm the builder's additions landed.
      let instructionsSize = 0;
      try {
        instructionsSize = (await readFile(rehydrate(instructionFile), 'utf8')).length;
      } catch {
        /* first build — file may not exist yet */
      }

      dbg('pom-builder', 'done', {
        domain,
        membersAdded: result.added.flatMap((a) => a.members).length,
        instructionChars: instructionsSize,
        violations: violations.length,
      });

      return [
        `Domain: ${domain}`,
        `Members added: ${result.added.flatMap((a) => a.members).length}`,
        `Instruction file: ${instructionFile} (${instructionsSize} bytes after build)`,
        `Guard violations reverted: ${violations.length}`,
        `Summary: ${result.summary}`,
      ].join('\n');
    },
  };
}
