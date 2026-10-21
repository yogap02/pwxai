/**
 * Code host abstraction. Stage 1 reads the issue + diff from the code host;
 * stage 8 creates a branch, commits, pushes, and opens a PR. The PR is the
 * review gate — no path merges anything (pipeline-pattern.md §3).
 *
 * GitHub is the one wired vendor (via the `gh` CLI); a different host is a
 * one-file rewrite of this interface's implementation.
 */

export interface SourceIssue {
  number: number;
  title: string;
  body: string;
  /** Raw diff of the change under review. */
  diff: string;
  /** Branch the change lives on. */
  branch: string;
}

export interface PrCreateInput {
  title: string;
  body: string;
  /** Branch with the pipeline's changes. */
  headBranch: string;
  /** Branch the PR targets. */
  baseBranch: string;
}

export interface PrRef {
  number: number;
  url: string;
}

export interface CodeHost {
  /** Stage 1 input: the issue + diff that triggered this run. */
  fetchSource(prNumber: number): Promise<SourceIssue>;
  /** Stage 8: branch, commit, push, PR. */
  createBranch(name: string, fromBranch: string): Promise<void>;
  commitAll(message: string): Promise<void>;
  push(branch: string): Promise<void>;
  openPr(input: PrCreateInput): Promise<PrRef>;
  /** Stage 1 failure path: comment on the source PR. */
  commentOnPr(prNumber: number, body: string): Promise<void>;
}
