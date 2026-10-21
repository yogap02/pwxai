# What this product deliberately will NOT test, and why.

Stage 1 reads this file. An unstated boundary gets re-proposed every release,
so an empty file is the only wrong answer. Examples below — replace with real
product rules.

## landing-page

- The enquiry form is never **submitted** — it sits behind Cloudflare Turnstile,
  so a real submission is unverifiable and rate-limitable. Fill and assert only.
- No assertion that the Turnstile **widget itself** is visible, clickable or
  sized on screen. Cloudflare does not inject the widget frame in an automated
  browser, in any `data-size` (probed live: `window.turnstile` exists and the
  response field is populated, but `querySelectorAll('iframe')` is empty), so
  there is nothing to locate or measure and such a test would pass while
  asserting nothing. The assertable form is the contract — the slot must be wide
  enough for the widget size it declares (`expectTurnstileFitsForm`).
- No click-through of external `wa.me` (WhatsApp) links — clicking leaves the
  app under test, so the rest of the test would assert on WhatsApp.
- No pixel/visual regression on the before/after comparison slider or the
  "Hold to explore" interaction — drag position is interaction state, not content.
- No accessibility assertions about the form's missing `<label>` associations.
  The gap is a real finding and lives in `src/page-objects/landing-page/instruction.md`; fixing
  it is the app's job, and asserting on it would freeze a defect as a test.
- `/en/portfolio` and `/en/privacy` are separate surfaces and are out of scope
  for this domain (the portfolio is its own domain when it is added).
