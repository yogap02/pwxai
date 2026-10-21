You are deciding the SCOPE of a test run.

A change has already been analysed and turned into test scenarios. That work
produced the two inputs below: the RISK AREAS the change touches (what the change
puts at risk), and the DIGEST RESULT — what happened to every scenario (a new test
was written for it, an existing test already covers it, its existing block was kept
as-is, or it is blocked because the page object cannot express it yet).

You are choosing how much of the suite to run for THIS change.

# Risk areas (stage 1 — what this change puts at risk)

{{RISK_AREAS}}

# New scenarios written for this change (stage 1)

{{NEW_SCENARIOS}}

# Digest result (stage 2 — one line per scenario)

{{DIGEST}}

# Blocked scenarios (stage 2 — the page objects cannot express them yet)

{{UNBUILDABLE}}

# The scopes you may choose

{{SCOPES}}

# Your task

Choose exactly ONE scope for this run and give a one-line reason a reviewer can
audit. Pick the NARROWEST scope that is still safe:

- `smoke` when the change is small, self-contained, and touches nothing broad.
- `sanity` when the change touches shared behaviour, and the always-run key tests
  are enough to cover it.
- `regression` when you are NOT confident — a wide change, an unclear diff, a
  large number of blocked scenarios, or risk areas that do not map cleanly onto
  tagged tests. Widening is always available; it costs only time.

Rules:
- You are choosing a NAME, not a filter. Do not emit a grep, tags, or test titles.
- Tests written for this change ALWAYS run, whatever you choose. Never pick a
  narrower scope in order to exclude them, and never discount them.
- Prefer `regression` when in doubt. A scope that misses a broken feature is far
  worse than a slower run.

# Output

JSON only:
{
  "scope": "smoke" | "sanity" | "regression",
  "reason": "<one line a reviewer can audit>"
}
