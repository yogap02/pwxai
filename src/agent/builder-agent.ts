/**
 * Builder agent interface. The real pipeline invokes a CLI agent (Browser-MCP
 * style); this boilerplate keeps the interface so an SDK or CLI integration
 * is a drop-in later (pipeline-pattern.md §8, "The agent stage is a CLI
 * invocation, not an SDK integration").
 *
 * The agent loop is plan-act-observe: navigate, snapshot, interact to reveal
 * hidden state, propose a locator, verify it resolves uniquely, refine. A
 * crawler over one-shot analysis cannot do the interactive half — that is
 * why this stage exists (§4).
 */

export interface BuilderTask {
  domain: string;
  className: string;
  entryPaths: readonly string[];
  needsAuth: boolean;
  /** Hand-authored navigation steps, authoritative. */
  entryDiscoverySteps: readonly string[];
  /** Members the classifier found missing — this stage's work order. */
  missingCapabilities: readonly string[];
  /** Repo-relative POSIX directory the agent may write. */
  allowedWriteDir: string;
  /** Repo-relative POSIX instruction file path. */
  instructionFile: string;
}

export interface BuilderResult {
  /** Locators/methods added — repo-relative POSIX file → added member names. */
  added: Array<{ file: string; members: string[] }>;
  /** The agent's summary. Persisted; the transcript never is. */
  summary: string;
  /** Instruction-file lines appended. */
  instructionAdditions: string[];
}

export interface BuilderAgent {
  build(task: BuilderTask): Promise<BuilderResult>;
}
