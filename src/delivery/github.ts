/**
 * GitHub code host, implemented over the `gh` CLI. Isolated to this file —
 * a different host rewrites this and changes nothing else.
 */

import { runStageProcess } from '../core/orchestration/stage-runner.js';
import { env } from '../core/util/env.js';
import type {
  CodeHost,
  PrCreateInput,
  PrRef,
  SourceIssue,
} from './code-host.js';

const GH_TIMEOUT = 60_000;

/**
 * `git` and `gh` are handed arguments this code BUILT at run time — a commit message with spaces,
 * a PR title, a PR body with newlines — and a shell re-parses those into separate argv entries.
 * `runStageProcess` defaults to `shell: true` on Windows so that PATH finds `.cmd` shims, which
 * turned `-m "test(pipeline): generated tests + healed locators"` into four unknown pathspecs and
 * failed the commit outright; `--body` and `--title` would have gone the same way a step later.
 * Both are real executables here, so nothing needs a shell to find them.
 */
const NO_SHELL = { shell: false } as const;

export class GitHubCodeHost implements CodeHost {
  async fetchSource(prNumber: number): Promise<SourceIssue> {
    // Deliberately NOT the delivery slug: the change under test can live in another repo.
    // A product repo dispatches this pipeline after its deploy, so stage 1 reads the PR
    // over there while stage 8 opens a PR here (see `env.SOURCE_REPO_SLUG`).
    const repo = sourceRepoSlug();
    const [issue, diff] = await Promise.all([
      this.ghJson(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'number,title,body,headRefName']),
      this.gh(['pr', 'diff', String(prNumber), '--repo', repo]),
    ]);
    const parsed = issue.json as {
      number: number; title: string; body: string; headRefName: string;
    };
    return {
      number: parsed.number,
      title: parsed.title,
      body: parsed.body ?? '',
      diff,
      branch: parsed.headRefName,
    };
  }

  async createBranch(name: string, fromBranch: string): Promise<void> {
    await this.git(['fetch', 'origin', fromBranch]);
    // Create the delivery branch AT HEAD, never by checking the tree out to `origin/<base>`.
    //
    // `git checkout -B <name> origin/<base>` looks right and is destructive whenever HEAD is not
    // already the base — which is every LOCAL run, because a developer runs the pipeline from the
    // branch they are working on. Measured in a throwaway worktree: HEAD was three commits ahead
    // of origin/main, the checkout moved the tree back to origin/main, and every file those
    // commits added (the whole gallery domain) vanished from the working directory. Nothing was
    // lost from git, but the run then committed an empty tree — and with a dirty file it aborted
    // outright, which is how this surfaced: "local changes would be overwritten by checkout".
    //
    // In CI HEAD *is* origin/<base>, so this is the same commit either way and the change is
    // invisible there. Locally it means the generated tests sit on top of the work actually in
    // the tree, which is what the person running it meant.
    await this.git(['checkout', '-B', name]);
    // Say so when the base was not HEAD. The PR then carries the branch's own commits too, and a
    // reviewer looking at a diff larger than "the tests this run wrote" deserves to know why
    // rather than guess.
    const head = await this.gitCapture(['rev-parse', 'HEAD']);
    const base = await this.gitCapture(['rev-parse', `origin/${fromBranch}`]);
    if (head !== base) {
      this.baseDivergence = `${name} was branched from the working tree's HEAD (${head.slice(0, 7)}), not origin/${fromBranch} (${base.slice(0, 7)}) — the PR diff includes this branch's own commits`;
    }
  }

  /**
   * Set when the delivery branch was not based on `origin/<base>` (see `createBranch`). Stage 8
   * records it as a degradation: the run still ships, but the PR is not the one-commit diff a
   * reviewer expects, and that has to be stated rather than discovered in the diff.
   */
  baseDivergence: string | null = null;

  async commitAll(message: string): Promise<void> {
    await this.git(['add', '-A']);
    await this.git(['commit', '-m', message]);
  }

  async push(branch: string): Promise<void> {
    await this.git(['push', 'origin', branch]);
  }

  async openPr(input: PrCreateInput): Promise<PrRef> {
    const repo = requireWorkRepoSlug();
    const res = await runStageProcess(
      'gh',
      [
        'pr', 'create',
        '--repo', repo,
        '--title', input.title,
        '--body', input.body,
        '--head', input.headBranch,
        '--base', input.baseBranch,
      ],
      { timeoutMs: GH_TIMEOUT, env: ghEnv(), ...NO_SHELL },
    );
    // No `--json` here: `gh pr create` prints the PR URL on success and does not take that flag —
    // it belongs to `pr view`/`pr list`. Asking for it made this step die with "unknown flag:
    // --json" before gh had even looked at the repository, so no run had ever opened a PR.
    // The URL IS the parsed result, so it comes from stdout.
    const url = /https:\/\/\S+\/pull\/\d+/.exec(res.stdout)?.[0];
    if (url === undefined) {
      throw new Error(
        `gh pr create: no PR URL in stdout (exit ok=${res.ok}): ${res.output.slice(0, 500)}`,
      );
    }
    return { number: Number(url.split('/').pop()), url };
  }

  async commentOnPr(prNumber: number, body: string): Promise<void> {
    // The SOURCE PR: a run reports back to the change it analysed, so this resolves the repo
    // that PR lives in. Resolving the work repo here would comment on an unrelated PR number —
    // or fail — whenever the product CICD triggers a run about its own change.
    const repo = sourceRepoSlug();
    await this.gh(['pr', 'comment', String(prNumber), '--repo', repo, '--body', body]);
  }

  private async gh(args: readonly string[]): Promise<string> {
    const res = await runStageProcess('gh', args, { timeoutMs: GH_TIMEOUT, env: ghEnv(), ...NO_SHELL });
    if (!res.ok) throw new Error(`gh ${args.join(' ')} failed: ${res.output.slice(0, 500)}`);
    // Data, not diagnostics. `output` merges stderr, and gh writes warnings — and, when
    // its debug switch is on, an HTTP trace — there. Merged, that trace lands inside the
    // diff this returns and inside the JSON `ghJson` parses.
    return res.stdout;
  }

  private async ghJson(args: readonly string[]): Promise<{ json: unknown; text: string }> {
    const text = await this.gh(args);
    try {
      return { json: JSON.parse(text), text };
    } catch {
      throw new Error(`gh ${args.join(' ')}: expected JSON output, got: ${text.slice(0, 500)}`);
    }
  }

  private async git(args: readonly string[]): Promise<void> {
    const res = await runStageProcess('git', args, { timeoutMs: GH_TIMEOUT, ...NO_SHELL });
    if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.output.slice(0, 500)}`);
  }

  /** `git`, returning trimmed stdout — for a command whose ANSWER is the point. */
  private async gitCapture(args: readonly string[]): Promise<string> {
    const res = await runStageProcess('git', args, { timeoutMs: GH_TIMEOUT, ...NO_SHELL });
    if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.output.slice(0, 500)}`);
    return res.stdout.trim();
  }
}

/**
 * The environment handed to a `gh` child. Our own `DEBUG` is cleared deliberately:
 * `DEBUG` is a very generic name and the GitHub CLI honours it as its debug switch (an
 * alias for `GH_DEBUG`), so a pipeline run with DEBUG on made every gh call trace its
 * HTTP requests onto stderr — noise in the report, and, merged into stdout, noise inside
 * the diff handed to the model. The empty string reads as off (checked against gh 2.102).
 */
function ghEnv(): Record<string, string> {
  const base: Record<string, string> = { DEBUG: '', GH_DEBUG: '' };
  if (!env.GH_TOKEN) return base;
  return { ...base, GH_TOKEN: env.GH_TOKEN, GH_ENTERPRISE_TOKEN: env.GH_TOKEN };
}

/**
 * The SOURCE repo: whose PR stage 1 reads. The product CICD passes it with the testing
 * context when it triggers a run after its own deploy; absent, the run is about this repo.
 */
function sourceRepoSlug(): string {
  return env.SOURCE_REPO_SLUG ?? requireWorkRepoSlug();
}

/** The WORK repo: where the branch, the push and the PR happen. Never the product repo. */
function requireWorkRepoSlug(): string {
  const slug = env.WORK_REPO_SLUG;
  if (!slug) {
    throw new Error(
      'WORK_REPO_SLUG is not set (owner/name) — the repo the generated tests are delivered to. ' +
        'Register it in the CI definition, container env, and .env.example.',
    );
  }
  return slug;
}
