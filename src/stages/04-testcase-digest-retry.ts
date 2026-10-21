/**
 * Stage 4: testcase-digest-retry:<domain>. Re-generate blocks left unbuildable
 * by stage 2, now that stage 3 has built the missing capability. Per-domain,
 * recorded, non-fatal.
 */

import type { StageSpec } from '../core/orchestration/stage-runner.js';
import type { ModelClient } from '../ai/model-client.js';
import type { DigestOutcome } from './stage-types.js';
import { runDigest } from './02-testcase-digest.js';

export function createDigestRetryStage(_domain: string, _model: ModelClient, _prior: DigestOutcome): StageSpec {
  return {
    name: `testcase-digest-retry:${_domain}`,
    fatal: false,
    run: async (ctx) => {
      // Re-run the digest for JUST this domain. The full digest re-write is
      // safe here because the managed region is keyed on scenario id + content
      // hash: unchanged scenarios hold their existing blocks; only the
      // previously-unbuildable ones regenerate.
      const result = await runDigest(_model, ctx, `testcase-digest-retry:${_domain}`);
      const relevant = result.outcomes.find((o) => o.domain === _domain);
      if (!relevant) return `Domain ${_domain} produced no digest outcome on retry.`;
      const remaining = relevant.unbuildable.length;
      const converted = _prior.unbuildable.length - remaining;
      return [
        `Domain: ${_domain}`,
        `Blocks converted from unbuildable: ${converted}`,
        `Still unbuildable: ${remaining}`,
      ].join('\n');
    },
  };
}
