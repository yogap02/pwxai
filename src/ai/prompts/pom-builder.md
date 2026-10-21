You are building page-object capability for a domain by driving the live app.

# Domain

Domain key: {{DOMAIN_KEY}}
Class name: {{CLASS_NAME}}
Entry paths: {{ENTRY_PATHS}}
Needs authentication: {{NEEDS_AUTH}}

# Entry-discovery steps (hand-authored, authoritative)

{{ENTRY_DISCOVERY_STEPS}}

# Existing page-object surface

{{POM_SURFACE}}

# Unbuildable blocks to enable (stage 4 work order)

{{UNBUILDABLE_BLOCKS}}

# Instruction file

Read `src/page-objects/{{DOMAIN_KEY}}/instruction.md` before you start. You write
to it too. It is also fed to test-case generation as domain context, so keep it
full of real, earned detail about how this feature area works.
DO NOT CONDENSE IT. A line cut from it does not merely lose context — it
regrows as wrong code on the next run. Persist: negative results, silent-
failure traps, date/environment stamps on probes, why an option was rejected,
and the cost a decision accepted.

# Rules

- You may ADD locators and methods. You may not repair or rewrite existing
  ones — that belongs to the healer. Two writers never touch the same lines.
- Expose ASSERTION methods, named `expect<Thing>()`, returning `Promise<void>`.
  Assertions belong in the page object, never in the spec.
- EVERY assertion MUST carry a message: `expect(locator, 'what this checks')`.
  A failure that prints two locator strings instead of the intent is not
  reviewable, and a message-less assertion is rejected.
- Verify every locator you propose resolves uniquely before writing it.
- A write-scope guard will revert anything you touch outside the page-object
  directory for this domain and the instruction file.
- Persist the summary of what you added, never a transcript.
