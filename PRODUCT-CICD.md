# Wiring the product CICD into this pipeline

How a product repository triggers a run here after its own deploy, and what has
to be configured for that run to work. The reference product is
[`yogap02/fotogaper`](https://github.com/yogap02/fotogaper); the contract is the
same for any product.

```text
fotogaper (product)                  pwxai (this repo)
------------------                   -----------------
deploy lands
  |
  +-- dispatch POST ------------>    stage 1 reads the SOURCE PR
      pr + source_repo                  |
                                        +-- agent stages
                                        +-- opens a PR here
                                        +-- comments the result on that PR
```

Nothing is cloned across the boundary: the product sends one `workflow_dispatch`
call and the run happens here. What crosses is the **testing context** —
`pr`, the change under test, and `source_repo`, the repo that PR lives in.

The product side is a `trigger-tests` job that runs only for a deploy that
landed, resolves the merged PR from `GITHUB_SHA`, and dispatches with:

| Input | Value |
|---|---|
| `pr` | the merged PR's number |
| `source_repo` | the product repo, e.g. `yogap02/fotogaper` |

## 1. The one change required here

`GH_TOKEN` is what every `gh` call authenticates with — stage 1 reading the
source PR, stage 8 opening a PR here, stage 1 commenting back. It is wired to
`secrets.GITHUB_TOKEN`, which is **scoped to this repository** and therefore
cannot see a private product repo. That makes `gh pr view --repo <product>`
fail with a 404 the moment the source repo is not this one.

**`.github/workflows/pipeline.yml`, line 70.** Replace:

```yaml
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

with:

```yaml
      # What every `gh` call authenticates with. A PAT rather than the
      # Actions-issued GITHUB_TOKEN, because stage 1 reads the SOURCE PR — and that
      # PR can live in another, private repo, which an Actions token can never
      # reach: it is scoped to the repo this workflow runs in. The default token
      # still does checkout and `git push`; this only feeds `gh`.
      GH_TOKEN: ${{ secrets.GH_PAT }}
```

That is the whole code change. No TypeScript is touched — `ghEnv()` in
`src/delivery/github.ts` only forwards the token to `gh` children, and no
self-check asserts where it came from. The `permissions: contents: write` block
still governs checkout and `git push`, and `gh pr create` now authenticates as
the PAT instead.

Verified: `npm run self-checks` reports **86 passed, 0 failed** with this change
in place, identical to the baseline before it.

## 2. What must exist

Secrets (readable only as a value) and variables (readable, so never a token —
`self-checks.ts` asserts the two are not confused):

| Name | Kind | Value | For |
|---|---|---|---|
| `GH_PAT` | secret | fine-grained PAT spanning both repos, see below | every `gh` call |
| `MODEL_API_KEY` | secret | model provider key | the agents |
| `TELEGRAM_API_KEY` | secret | bot token from @BotFather | stage 9's report |
| `BASE_URL` | variable | `https://foto.gappp.my.id/` | stage 6 targets the product |
| `TELEGRAM_CHAT_ID` | variable | the destination chat | stage 9's report |
| `MODEL_BASE_URL`, `MODEL_NAME`, `MODEL_REASONING_EFFORT`, `DEBUG` | variable | already set | the agents |

`MODEL_API_KEY`, `BASE_URL` and the model variables were already in place. If
`TELEGRAM_API_KEY`/`TELEGRAM_CHAT_ID` are empty, stage 9 sends nothing and says
so — it is never a silent green.

### The PAT's permissions

One fine-grained token spanning both repositories, because two directions are
involved: this repo writes to itself and reads the product.

| Repository | Permissions | Why |
|---|---|---|
| `yogap02/pwxai` | Actions **read+write** | the product's dispatch POST |
| `yogap02/pwxai` | Contents **read+write**, Pull requests **read+write** | stage 8's branch, push and PR |
| `yogap02/fotogaper` | Contents **read**, Pull requests **read+write** | stage 1's `pr view` / `pr diff`, and the comment back |

> `gh pr comment` posts to the *issue-comments* endpoint, which fine-grained
> tokens may gate behind **Issues: write** rather than Pull requests. Reads and
> the dispatch permission were probed directly; the comment-back is the one path
> that cannot be verified without posting a real comment, so if stage 1 reports
> its result and returns a 403, add **Issues: write** on the product repo.

The product stores the same value as its own `PWXAI_PAT` secret. To revoke this
pipeline's access: delete the token under **Settings → Developer settings →
Personal access tokens**, then remove `GH_PAT` here and `PWXAI_PAT` there.

Fine-grained tokens expire — **note the expiry date when you create one** (the one
in place now expires **2026-12-20**) and renew both secrets together, or runs
start failing at stage 1 for a reason the diff will not explain.

## 3. Verify here first, without a product deploy

A manual run proves this side on its own. **Actions → test-pipeline → Run
workflow**:

| Input | Value |
|---|---|
| `pr` | a merged PR in the product repo, e.g. `2` |
| `source_repo` | `yogap02/fotogaper` |
| `dry_run` | `true` — skips stage 6 (browser) and stage 8 (push/PR): the cheapest honest run |
| `from_scenarios` | false |
| `test_grep` | empty |

Stage 1 must get past reading the PR. Once it does, both directions of the
credential work. Note the guard on the run step: with neither `pr` nor
`from_scenarios` the run stops with *"Nothing to run"* — the product always
sends `pr`.

## 4. Order of operations

1. Land the line change above on **`main`** — the product dispatches with
   `--ref main`, so main's copy of this workflow is the one that executes.
2. Confirm `GH_PAT` is set.
3. Then let the product merge: its deploy lands, `trigger-tests` fires with
   `pr=<the merged PR>` and `source_repo=yogap02/fotogaper`.

## 5. When it fails, which failure is which

| Symptom | Cause |
|---|---|
| Dispatch fails with 403 in the product's run | the PAT lacks **Actions: write** on this repo, or expired |
| `gh pr view`/`pr diff` fails with 404 at stage 1 | the PAT cannot see the product repo — check the `fotogaper` half of the permissions |
| Stage 1 reads the PR, but the comment back fails | missing **Pull requests: write** on the product repo — and see the **Issues: write** note above |
| `Nothing to run` | no `pr` was passed and `from_scenarios` was not ticked |
| Stage 9 reports no channel | `TELEGRAM_API_KEY` / `TELEGRAM_CHAT_ID` unset |

A product push with no associated PR never reaches here: the product logs a
notice and dispatches nothing, because there is no change to scope a run to.
