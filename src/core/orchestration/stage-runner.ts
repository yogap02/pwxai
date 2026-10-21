/**
 * Stage runner: timeout, signal handling, output reassembly, and recording.
 *
 * A stage runs as a child process when given a command (stages 3 and 6 spawn
 * processes; the model stages run in-process). Whatever it produces — stdout,
 * stderr, exit code — is reassembled into a StageRecord and written into the
 * run report verbatim, never filtered on failure (pipeline-pattern.md §3,
 * "Test results are recorded as-is").
 *
 * On timeout: SIGTERM, grace, then SIGKILL. On interruption (SIGINT to the
 * pipeline): forward to child, await in-flight work, then rethrow
 * (concurrency invariant #3).
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import type { RunManifest, StageRecord } from '../scenario/manifest.js';
import { redact } from '../util/redaction.js';
import { dbg } from '../util/debug.js';

export interface StageContext {
  manifest: RunManifest;
  /** Bump when a stage wants to mark a degradation with a named reason. */
  recordDegradation(stage: string, reason: string): void;
}

export type StageFn = (ctx: StageContext) => Promise<string | void>;

export interface StageSpec {
  name: string;
  /** Timeout in ms. Default 5 minutes. */
  timeoutMs?: number;
  run: StageFn;
  /** Per the loop table (pipeline-pattern.md §2): fatal stages exit 1 on failure. */
  fatal?: boolean;
}

export interface StageResult {
  record: StageRecord;
  ok: boolean;
  /** Output text reassembled from the stage's execution. */
  output: string;
}

export class StageRunner {
  private stageRecords = new Map<string, StageRecord>();

  constructor(private readonly manifest: RunManifest) {}

  recordFor(name: string): StageRecord | undefined {
    return this.stageRecords.get(name);
  }

  /**
   * Record a stage's state, REPLACING any previous record for the same name in
   * place. A stage name is unique per run, so an entry is not an append-only log —
   * and `npm run stage:7` re-runs one stage from the manifest on disk, which means
   * the same name is recorded again in a new process. Left as a push, that
   * accumulated: seven identical `heal-apply` lines in the summary, and the stale
   * ones kept their degradations (a `heal-demo` line from a run hours earlier) and
   * their `failed` status, so a re-run that FIXED the stage still reported it as
   * failed for good. Duplicates already on disk are collapsed here.
   */
  private put(record: StageRecord): void {
    const at = this.manifest.stages.findIndex((s) => s.name === record.name);
    if (at === -1) {
      this.manifest.stages.push(record);
    } else {
      this.manifest.stages = this.manifest.stages.filter((s) => s.name !== record.name);
      this.manifest.stages.splice(at, 0, record);
    }
    this.stageRecords.set(record.name, record);
  }

  async run(spec: StageSpec): Promise<StageResult> {
    const record: StageRecord = {
      name: spec.name,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.put(record);

    const timeoutMs = spec.timeoutMs ?? 5 * 60_000;
    // The stage boundary, in the console: every stage's start, end, status and
    // duration. This is the spine a run is read along; the per-stage lines below
    // add the detail inside it.
    dbg('stage', 'start', { name: spec.name, timeoutMs, fatal: spec.fatal ?? false });
    const ctx: StageContext = {
      manifest: this.manifest,
      recordDegradation: (stage, reason) => {
        const r = this.stageRecords.get(stage);
        if (r) {
          r.degradation = [...(r.degradation ?? []), reason];
        }
      },
    };

    let output = '';
    try {
      const result = await withTimeout(
        spec.run(ctx),
        timeoutMs,
        `stage ${spec.name} timed out after ${timeoutMs}ms`,
      );
      output = typeof result === 'string' ? result : '';
      record.status = 'succeeded';
      record.endedAt = new Date().toISOString();
      record.durationMs = elapsed(record);
      const trimmed = redact(output).trim();
      record.output = trimmed === '' ? undefined : trimmed;
      dbg('stage', 'done', {
        name: spec.name,
        status: record.status,
        ms: record.durationMs,
        degradations: record.degradation?.length ?? 0,
      });
    } catch (err) {
      record.status = 'failed';
      record.endedAt = new Date().toISOString();
      record.durationMs = elapsed(record);
      const failedOut = redact(`${output}\n${errText(err)}`).trim();
      record.output = failedOut === '' ? undefined : failedOut;
      dbg('stage', 'done', {
        name: spec.name,
        status: record.status,
        ms: record.durationMs,
        error: errText(err).split('\n')[0] ?? '',
      });
      return { record, ok: false, output: record.output ?? '' };
    }
    return { record, ok: true, output };
  }

  markSkipped(name: string, reason: string): StageResult {
    const record: StageRecord = {
      name,
      status: 'skipped',
      endedAt: new Date().toISOString(),
      output: redact(reason),
    };
    this.put(record);
    dbg('stage', 'skipped', { name, reason });
    return { record, ok: true, output: reason };
  }
}

function elapsed(record: StageRecord): number {
  if (!record.startedAt || !record.endedAt) return 0;
  return new Date(record.endedAt).getTime() - new Date(record.startedAt).getTime();
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolveP(v);
      },
      (e) => {
        clearTimeout(timer);
        rejectP(e);
      },
    );
  });
}

/**
 * Spawn a child stage process with timeout + signal handling + output
 * reassembly. Used by the builder (CLI-shaped) and playwright stages.
 *
 * `shell` defaults to true on Windows so that PATH lookups find `.cmd` shims
 * (`npx`, `gh`). That default is a trap for any argument containing a shell
 * metacharacter: cmd.exe re-parses the whole command line, so a Playwright grep
 * like `@core|@smoke|Some test title` is split into a PIPELINE and the run dies
 * with exit 255. Callers that pass a runtime-constructed argument must set
 * `shell: false` and spawn an executable directly (`process.execPath`).
 */
export async function runStageProcess(
  command: string,
  args: readonly string[],
  opts: { timeoutMs: number; cwd?: string; env?: Record<string, string>; shell?: boolean },
): Promise<{ ok: boolean; output: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolveP) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: opts.shell ?? process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const chunksOut: Buffer[] = [];
    const chunksErr: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunksOut.push(c));
    child.stderr.on('data', (c: Buffer) => chunksErr.push(c));

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled && child.exitCode === null) child.kill('SIGKILL');
      }, 5_000);
    }, opts.timeoutMs);

    const onSignal = (sig: NodeJS.Signals) => {
      if (child.exitCode === null) child.kill(sig);
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    child.on('close', (code) => {
      settled = true;
      clearTimeout(killTimer);
      process.removeListener('SIGINT', () => onSignal('SIGINT'));
      process.removeListener('SIGTERM', () => onSignal('SIGTERM'));
      stdout = Buffer.concat(chunksOut).toString('utf8');
      stderr = Buffer.concat(chunksErr).toString('utf8');
      resolveP({
        ok: code === 0 && !timedOut,
        output: redact(`${stdout}\n${stderr}`).trim(),
        exitCode: code,
        timedOut,
      });
    });
  });
}
