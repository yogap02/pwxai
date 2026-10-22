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

## gallery

- **No assertion that the `diecast` pill finds the diecast proof.** Probed live
  2026-10-22: under ALL the third card is titled "Diecast" and its category label
  reads `hobby`, while `?category=diecast` returns zero cards and renders the
  empty state. The two are inconsistent, and it is a real
  product bug — the proof's category is `hobby` while the filter offers
  `diecast`. Asserting either half as correct would freeze the defect; asserting
  the *consistency* would go red for a reason this domain cannot fix. It is
  recorded in `src/page-objects/gallery/instruction.md` instead. Assert the
  filter mechanism on a category that does work (`macro` → 2 cards).
- **No assertion on the lightbox's keyboard behaviour.** Probed: the overlay has
  no `role="dialog"`, the card is not focusable (`tabindex` absent, `DIV`, no
  role), and Escape does not close it — only the backdrop or the close button.
  That is an accessibility defect, recorded in instruction.md, not a test to
  freeze. The lightbox is asserted as a mouse flow: open on click, close on the
  close button.
- No assertion that the search box filters as you type. It does not: filtering
  happens on submit, and the URL is the source of truth (`?q=`). A test that
  types without submitting asserts the unfiltered list and passes for the wrong
  reason.
- No pixel/visual regression on the cards or the lightbox image. The proofs are
  hosted on Google's CDN and are content, not layout.
- No assertion that the gallery `<title>` is well-formed. It currently renders
  "Portfolio | fotogaper | fotogaper" (the site name is appended twice). The
  doubled suffix is a real defect, recorded in instruction.md; asserting the
  correct form goes red, asserting the current form freezes the bug.
