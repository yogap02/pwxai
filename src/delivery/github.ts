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
    const repo = requireRepoSlug();
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
    await this.git(['checkout', '-B', name, `origin/${fromBranch}`]);
  }

  async commitAll(message: string): Promise<void> {
    await this.git(['add', '-A']);
    await this.git(['commit', '-m', message]);
  }

  async push(branch: string): Promise<void> {
    await this.git(['push', 'origin', branch]);
  }

  async openPr(input: PrCreateInput): Promise<PrRef> {
    const repo = requireRepoSlug();
    const res = await runStageProcess(
      'gh',
      [
        'pr', 'create',
        '--repo', repo,
        '--title', input.title,
        '--body', input.body,
        '--head', input.headBranch,
        '--base', input.baseBranch,
        '--json', 'url,number',
      ],
      { timeoutMs: GH_TIMEOUT, env: ghEnv(), ...NO_SHELL },
    );
    if (res.ok) {
      try {
        const j = JSON.parse(res.stdout) as { url: string; number: number };
        return { number: j.number, url: j.url };
      } catch {
        // fall through to stdout parsing
      }
    }
    // Parse the URL from whatever gh printed (plain success or error text).
    const url = /https:\/\/\S+\/pull\/\d+/.exec(res.stdout)?.[0];
    if (!url) throw new Error(`gh pr create: could not parse PR URL from output: ${res.output.slice(0, 500)}`);
    return { number: Number(url.split('/').pop()), url };
  }

  async commentOnPr(prNumber: number, body: string): Promise<void> {
    const repo = requireRepoSlug();
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

function requireRepoSlug(): string {
  const slug = env.REPO_SLUG;
  if (!slug) {
    throw new Error(
      'REPO_SLUG is not set (owner/name). Register it in the CI definition, container env, and .env.example.',
    );
  }
  return slug;
}
