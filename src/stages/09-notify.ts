/**
 * Stage 9: notify. The report channel — a run tells a chat what it found, with the scope
 * that run actually had.
 *
 * A chat message is not evidence, so a failed send is **non-fatal**: the tests and their
 * results stand whatever the channel does. But a report that never arrived must not look
 * like one that did, so a rejected or unreachable send *fails this stage* — which is what
 * puts it under "Needs attention" — rather than returning a friendly string. The other
 * outcome, no bot configured at all, is a legitimate setup: it is reported as the stage's
 * output, not as a defect.
 *
 * It runs after stage 8 because the message carries what stage 8 delivered: the PR that is
 * now open for review.
 */

import type { StageSpec } from '../core/orchestration/stage-runner.js';
import { env } from '../core/util/env.js';
import {
  buildReportMessage,
  runStatus,
  sendReportMessage,
  telegramConfig,
} from '../delivery/telegram.js';

export function createNotifyStage(): StageSpec {
  return {
    name: 'notify',
    timeoutMs: 30_000,
    fatal: false,
    run: async (ctx) => {
      const config = telegramConfig();
      if (config === null) {
        return 'No report channel configured (TELEGRAM_API_KEY / TELEGRAM_CHAT_ID unset); nothing was sent.';
      }
      const status = runStatus(ctx.manifest);
      const message = buildReportMessage(ctx.manifest, {
        sourceRepo: env.SOURCE_REPO_SLUG ?? env.WORK_REPO_SLUG,
      });
      const outcome = await sendReportMessage(message);
      if (!outcome.ok) {
        // Named twice on purpose: the degradation renders in the summary, the thrown
        // message lands in the run report. Neither contains the token.
        ctx.recordDegradation('notify', outcome.reason);
        throw new Error(`report channel failed: ${outcome.reason}`);
      }
      // Both statuses, because the stage output is read during a debug and "failed" alone
      // cannot say whether the run broke or the product did.
      return `Reported run ${ctx.manifest.runId} to chat ${config.chatId} (testing: ${status.testing.level} · pipeline: ${status.pipeline.level}).`;
    },
  };
}
