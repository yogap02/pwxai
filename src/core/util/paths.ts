/**
 * Path handling. The single rule this module exists to enforce:
 *
 *   Never persist an absolute path.
 *
 * A path bug of this class does not throw — it resolves to a plausible dead path,
 * the caller's existence check returns false, and the work is silently skipped.
 * (pipeline-pattern.md §3, "Never persist an absolute path".)
 *
 * Committed artifacts store repo-relative POSIX paths. Rehydration resolves them
 * at load, against the current repo root, using path.join — never prefix-stripping
 * or hardcoded separators.
 */

import { isAbsolute, join, normalize, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of this repository, resolved from this module's location. */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');

/**
 * Convert a repo-relative POSIX path to an absolute OS-native path.
 * Rehydrates at load; this is the ONLY sanctioned way to turn a persisted path
 * back into something the filesystem accepts.
 */
export function rehydrate(repoRelativePosix: string): string {
  return join(REPO_ROOT, repoRelativePosix);
}

/**
 * Convert an absolute path under the repo into a repo-relative POSIX path for
 * persistence. Throws when given a path outside the repo or already relative —
 * a guard that would disarm itself on bad input is worse than a crash.
 */
export function toRepoRelative(absolutePath: string): string {
  if (!isAbsolute(absolutePath)) {
    throw new Error(
      `toRepoRelative expects an absolute path, got relative: ${absolutePath}`,
    );
  }
  const norm = normalize(absolutePath);
  const root = REPO_ROOT.endsWith(sep) ? REPO_ROOT : REPO_ROOT + sep;
  if (norm !== REPO_ROOT && !norm.startsWith(root)) {
    throw new Error(
      `toRepoRelative: path escapes repository root: ${absolutePath}`,
    );
  }
  const rel = norm === REPO_ROOT ? '.' : norm.slice(root.length);
  return rel.split(sep).join(posix.sep);
}

/** True when the string is a valid repo-relative POSIX path (no drive, no backslash, not absolute). */
export function isRepoRelativePosix(value: string): boolean {
  if (value.length === 0) return false;
  if (isAbsolute(value)) return false;
  if (value.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  return true;
}

/**
 * Guard for values loaded from persisted artifacts. A malformed path here is
 * data corruption that would otherwise silently skip work downstream — throw,
 * never fall back to a guess.
 */
export function assertRepoRelativePosix(value: string, context: string): void {
  if (!isRepoRelativePosix(value)) {
    throw new Error(
      `${context}: expected repo-relative POSIX path, got: ${JSON.stringify(value)}`,
    );
  }
}

/** Join POSIX segments for building a persisted path (always forward slashes). */
export function joinRepo(...segments: string[]): string {
  return posix.join(...segments);
}
