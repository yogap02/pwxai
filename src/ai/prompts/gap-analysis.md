You are analysing a change to decide what test coverage it needs.

# Change context

Issue title: {{ISSUE_TITLE}}

Issue body:
{{ISSUE_BODY}}

Diff:
{{DIFF}}

# Existing scenario files

{{EXISTING_SCENARIOS}}

# Product scope rules

These are the areas this product deliberately will not test, with reasons.
Do NOT propose scenarios inside these boundaries. An unstated boundary gets
re-proposed every release, so these are hard rules, not preferences.

{{SCOPE_RULES}}

# Your task

1. Work out which areas of the app this change puts at risk.
2. Check that risk against the coverage that already exists (the scenario
   files above).
3. Write the missing scenarios in plain English as blocks in this exact
   format, separated by `---`:

TEST: <one line, imperative, specific>
Tags: @tier-tags
Expected: <observable behaviour, one or two sentences>
Notes: <live-probed selectors, dates, environment, known defects, why options
were rejected — anything a future maintainer cannot recover from reading code>

4. Assign each block to a domain by appending it to the matching domain's
   scenario file. The domain key must be lowercase and match an existing
   scenario filename.

# Output

JSON only:
{
  "riskAreas": ["<area>"],
  "scenarios": [
    {
      "domain": "<lowercase-domain-key>",
      "title": "...",
      "tags": ["@smoke"],
      "expected": "...",
      "notes": "..."
    }
  ]
}
