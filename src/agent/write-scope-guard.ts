/**
 * Write-scope guard. Classifies what the agent touched and reverts anything
 * outside the directories it was allowed to write (pipeline-pattern.md §3,
 * "The PR is the review gate").
 *
 * Agent writes are additive-only: the builder may add locators and methods;
 * repairing broken ones belongs to the healer. The guard checks both the
 * path scope and (lightly) that existing lines were not deleted.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { rehydrate } from '../core/util/paths.js';

export interface ScopeRule {
  /** Repo-relative POSIX directories the writer may touch. */
  allowedDirs: readonly string[];
  /** Repo-relative POSIX files the writer may touch. */
  allowedFiles: readonly string[];
}

export interface GuardViolation {
  file: string;
  reason: 'outside-scope' | 'destructive-edit';
}

export function isPathInScope(repoRelPath: string, rule: ScopeRule): boolean {
  if (rule.allowedFiles.includes(repoRelPath)) return true;
  return rule.allowedDirs.some((dir) => repoRelPath === dir || repoRelPath.startsWith(`${dir}/`));
}

/**
 * Snapshot a file's content before the agent runs, then verify after: the
 * after-content must start with the before-content (additive-only) and be in
 * scope. Returns violations; the caller reverts by restoring the snapshot.
 */
export class WriteScopeGuard {
  private snapshots = new Map<string, string>();

  constructor(private readonly rule: ScopeRule) {}

  async snapshot(repoRelPath: string): Promise<void> {
    const abs = rehydrate(repoRelPath);
    try {
      this.snapshots.set(repoRelPath, await readFile(abs, 'utf8'));
    } catch {
      this.snapshots.set(repoRelPath, ''); // new file
    }
  }

  async verify(repoRelPath: string): Promise<GuardViolation[]> {
    if (!isPathInScope(repoRelPath, this.rule)) {
      return [{ file: repoRelPath, reason: 'outside-scope' }];
    }
    const before = this.snapshots.get(repoRelPath);
    if (before === undefined) return [];
    let after: string;
    try {
      after = await readFile(rehydrate(repoRelPath), 'utf8');
    } catch {
      return [{ file: repoRelPath, reason: 'destructive-edit' }]; // file was deleted
    }
    if (!after.startsWith(before)) {
      return [{ file: repoRelPath, reason: 'destructive-edit' }];
    }
    return [];
  }

  async revert(repoRelPath: string): Promise<void> {
    const before = this.snapshots.get(repoRelPath);
    if (before === undefined) return;
    await writeFile(rehydrate(repoRelPath), before, 'utf8');
  }
}
