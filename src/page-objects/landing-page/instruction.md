# landing-page — builder instruction file

Read by the builder before it works; written by the builder after. **Do not
condense.** A line cut here does not merely lose context — it regrows as wrong
code on the next run (pipeline-pattern.md §7).

Domain key: `landing-page` · class: `LandingPage` · POM: `src/page-objects/landing-page/index.ts`
Entry: `BASE_URL` + `/en` · auth: none.

## Rules of play (AGENTS.md §"Test authoring rules")

- Assertions live in this domain's page object, NOT in
  `tests/landing-page/landing-page.spec.ts`. The spec navigates and calls
  `expect*()` methods only — it does not import `expect`.
- Every assertion carries a message: `expect(locator, 'what this checks')`.
- When a scenario cannot be asserted by the current POM, ADD an `expect*()`
  method here. Never push `expect()` down into the spec to get a scenario green.

## Probe log

### 2026-10-19 — first authoring pass (agent-driven, headless Chromium)

Environment: live production `https://foto.gappp.my.id/en`, Chromium via the
Playwright MCP. App is a Next.js server-action app; document title is set
client-side after hydration.

Page shape (top to bottom):
- `nav` (banner): logo link "fotogaper." → `/en`; links Portfolio → `/en/portfolio`,
  Pricing → `/en#pricing`, Contact → `/en#contact`; locale links ID → `/id`, EN → `/en`.
- Hero: `h1` "The Truth in Every Detail"; tagline "Macro and Product Photographer";
  CTA link "Explore My Work" → `/en/portfolio`.
- `[REAL_PROOF]` section: `h2` "Seeing what others miss."; a drag before/after
  comparison ("Standard View" / "Macro Detail"); `h3` "See for Yourself".
- `section#portfolio` — `h3` "Explore Niches"; filter buttons `all` (default),
  `macro`, `products`, `diecast`, `jewelry`; project cards (`h4`): "Keycaps Artisan",
  "Keycaps Artisan", "Diecast"; link "See All Microscopic Proofs" → `/en/portfolio`.
- "Explore the Details" section: `h3` "Take a Closer Look"; a "Hold to explore" interaction.
- `section#pricing` — `h2` "Fair Rates, No Surprises"; six package cards (`h3`):
  Starter Basic (Rp 249.000, sale from Rp 349.000, Ref PKG-001), Starter Creative
  (Rp 399.000, PKG-002), Pro Basic (Rp 649.000, PKG-003), Pro Creative (Rp 999.000,
  PKG-004), Non-Profit & SME ("Contact Us", PKG-005), Enterprise ("Contact Us",
  PKG-006). Each card has a "Let's Talk" link → `https://wa.me/6285228523000?text=...`
  with the package name prefilled.
- `section#contact` — `h2` "Wanna make something cool?"; a form; "Send Message" button.
  A "Fast Response" and "Global Delivery" pair of blurbs.
- Footer: "Privacy Policy" link → `/en/privacy`; "© 2026 fotogaper. All rights reserved."

## Silent-failure traps (each produces a passing test if missed)

- **Form fields have NO associated label.** The captions "YOUR NAME", "EMAIL",
  "PHONE / WHATSAPP (OPTIONAL)", "TELL ME ABOUT YOUR PROJECT" are sibling `<div>`s,
  not `<label for>` or `aria-label`. `element.labels` is empty on every field.
  `getByLabel(...)` and `getByRole('textbox', { name: ... })` therefore resolve to
  **nothing** — and a locator that resolves to nothing can still look plausible in a
  diff. Address fields by attribute: `input[name="name"]`, `input[name="email"]`,
  `input[name="phone"]`, `select[name="projectType"]`, `textarea[name="message"]`.
  Rejected option: reading the caption text is a real accessibility finding, but
  fixing it is the app's job, not the test's; record it, do not work around it with
  brittle `xpath=../..` traversal.
- **Two project cards share the title "Keycaps Artisan."** Any locator keyed on that
  heading text is ambiguous. `projectCards` counts headings by level instead.
- **The contact form is behind Cloudflare Turnstile** (`input[name="cf-turnstile-response"]`).
  A real submit is unverifiable and may be rate-limited. Scope rule: fill and assert
  the form, never submit it. A test that clicks "Send Message" and passes is almost
  certainly passing on the Turnstile failure, not on a submission.
- **Pricing "Let's Talk" links leave the app** (`wa.me`). Assert the `href`, never
  click through — clicking leaves the AUT and the test then asserts on WhatsApp.
- **`Pricing`/`Contact` are in-page anchors** (`#pricing`, `#contact`), not routes.
  Asserting `page.url()` ends in `/pricing` would be wrong.
- **Document title arrives after hydration.** `await page.goto()` resolves on
  `load`; the exact title may not be set yet. `goto()` waits for the hero heading
  first, which is the reliable signal.
- **A first-visit consent banner appears only in a FRESH browser context.**
  Google-Analytics cookie consent, with a SECOND link named "Privacy Policy"
  (`data-testid="consent-privacy-link"`; the footer's is `footer-privacy-link`).
  Both point at `/en/privacy`, so `getByRole('link', { name: 'Privacy Policy' })`
  is a strict-mode violation of two elements. It does NOT show in a warmed
  profile (consent already stored), so a manual probe misses it — only a fresh
  Playwright context reproduces it. Scope footer locators to `footer`. If a later
  test is intercepted by the banner, add a `dismissConsent()` capability rather
  than a regex hack.

## Negative results (absence is not "not built yet")

- No `aria-label`/`role`-based names on any form control (see above) — probed, not assumed.
- No separate `/en/pricing` or `/en/contact` routes; both are sections on `/en`.
- There is no mobile hamburger/menu button on the desktop probe; responsive nav was
  not verified. Do not assert a mobile menu until it is probed at a mobile viewport.
- Console reported 6 errors / 6 warnings on load (third-party/extension noise).
  None blocked rendering; treat console cleanliness as unverified, not clean.

## Open / next

- The before/after comparison slider (`[REAL_PROOF]`) and the "Hold to explore"
  interaction are not yet modelled — they need a pointer-drag/hold probe before a
  locator or method is added. This is the next capability to build if a scenario
  targets them.
- Locale `/id` was not probed; the switcher claims ID and EN.

## Self-healing locators — how this domain resolves them
- A spec must import the healing fixture (`src/runtime/self-heal-fixture.js`), not
  `@playwright/test`; that is what attaches this run's heal collector to the page.
- Locators addressed by a raw CSS string resolve through `LandingPage.loc()`.
  A `getByRole(..., { name })` chain stays a plain getter: it has no string to
  narrow, and is already insensitive to CSS churn.
- The healer fires only when a selector resolves to nothing, and records a heal
  only when a narrower candidate resolves uniquely. No model is involved — a
  guessed locator that is wrong asserts against the wrong element and passes.
- The app exposes test hooks: `[data-testid="contact-section"]`, `contact-name`,
  `contact-phone`, `site-footer`. These survive a class or id rename, so they are
  the better fallback for the section/footer locators.
- Verified against the live site: `[data-test="contact-section"]` healed to
  `[data-testid="contact-section"]`, the contact-form test passed on the healed
  selector, stage 7 rewrote the source line, and the following run was clean
  (`artifacts/run/heals.json` = `[]`).

### Correction: copy-identified locators heal too
The earlier bullet ("a `getByRole(..., { name })` chain stays a plain getter") is
superseded. A role locator is insensitive to CSS churn but acutely sensitive to
copy churn, and copy drift is the common case on this site.
- A locator identified by COPY — an element's text or its accessible name — goes
  through `LandingPage.byCopy(text, build)`. `text` must be a single-quoted
  literal, because the heal record substitutes `'<text>'`: a naked fragment like
  `Contact` also occurs inside assertion messages, and rewriting those corrupts
  them. A regex name (`/Let.s Talk/i`) has no literal to correct.
- The heal is the uniquely nearest on-page copy, above a high similarity floor.
  Two near-identical candidates are a coin toss and neither is taken.
- Verified against the live site: `byCopy('Marco and Product Photographer', …)`
  (one transposed pair in the tagline) healed to
  `byCopy('Macro and Product Photographer', …)` — similarity 0.933 against 0.451
  for the runner-up. The hero test passed on the healed copy, stage 7 rewrote the
  literal, and the next run was clean.
- What still cannot heal, and should stay a plain getter: `getByRole('heading',
  { level: 1 })` (no copy, no string) and regex-based names/locators.

## What the stub builder observed

- Entry page: https://foto.gappp.my.id/en
- Page title: fotogaper | Specialized Product & Macro Photography

The placeholder builder (`src/agent/cdp-builder-stub.ts`) appends a fact only when this
file does not already carry it, so the two bullets above are all it will ever add here.
Until 2026-10-19 it stamped a `## <timestamp> — stub builder run` section per
invocation — heading, entry, title, and the first 200 characters of the page's body text
— so three runs left three near-identical sections and every later run added a fourth.
Those three held nothing the probe log does not: two captured the hero text, one
captured `CAPTURING…` plus the analytics-consent copy ("We use analytics cookies
(Google Analytics) …") in place of the hero — the same first-visit banner as trap #7.
The body preview is a per-run observation about a progressively-loading page, so it now
lives in the stage summary, where it is persisted per run and read as a run record
rather than as domain truth.

## Locale: the copy in this page object is English only
- This site is bilingual. `/en` and `/id` serve the SAME structure with different
  words — verified live: the `/id` nav reads "Portofolio, Biaya, Kontak" where `/en`
  reads "Portfolio, Pricing, Contact", and the `/id` h1 is "Kebenaran dalam Setiap
  Detail". The `LandingPage` copy above is written for `/en` and declares that with
  `const LOCALE = '/en'`.
- A copy heal in the wrong locale would rewrite this file's English words into
  Indonesian and break `/en`: "Portofolio" is 0.90 similar to `'Portfolio'`, above
  the healer's floor. So `byCopy(...)` refuses to heal when the run is not in `/en`
  (or when the URL says nothing useful), records a `locale-mismatch` refusal with
  both locales, and the test fails — loudly, and correctly.
- Consequence for test-case generation: a scenario that exercises `/id` needs its
  OWN expected copy and must not reuse an `/en`-copy assertion from this page
  object. The healer will not bridge two languages, and it must not.
- Structure is shared across locales (same sections, same ids), so the CSS locators
  (`this.loc(...)`) carry no locale guard — only copy does.
- Also verified when refusing: copy with nothing near it records `no-candidate` and
  names the nearest on-page copy with its score (a gibberish tagline gave
  "The Truth in Every Detail" at 0.16, well below the floor), so the diagnostic
  distinguishes "the floor is too high" from "the element is gone".

## Mobile viewport — now probed (live, 390x844, 2026-10-21)

Supersedes the earlier "responsive nav was not verified" line: it has now been
probed at a mobile width, and the answer is that this page has NO mobile menu.

- At 390x844 the desktop nav links (`/en/portfolio`, `/en#pricing`, `/en#contact`)
  are still IN THE DOM but are not visible, and are absent from the accessibility
  tree: `getByRole('link', { name: 'Portfolio' })` resolves to 0 elements.
  They are hidden, not removed — so "hidden" is the assertable fact, not "absent".
- There is NO hamburger/menu control at this width. The only buttons on the page
  are the five niche filters and "Send Message". Do NOT expect a menu to open.
- The locale switcher (ID / EN) stays VISIBLE at 390x844, as do the hero, niches,
  pricing, contact form and footer sections.
- Consequence for test-case generation: do NOT call `expectPrimaryNav()` at a
  non-desktop viewport — it asserts those links are visible and they are not. Call
  `expectMobileNav()` (asserts hidden) and then the section assertions, which hold
  at both widths.
- Apply the viewport through the page object: `await landingPage.useViewport('mobile')`
  BEFORE `goto()`. A spec must not call `page.setViewportSize` itself — the viewport
  is a capability of the page object (`src/runtime/viewport.ts` owns the sizes).
- `expectMobileNav()` uses PLAIN locators on purpose: a `byCopy(...)` locator that
  resolves to 0 elements starts a heal, and the nearest-copy search on a page whose
  nav is deliberately hidden is a coin toss that could rewrite this file.

### What differs at 390x844 (counts, live-probed 2026-10-21)

The section SET is identical at both widths; the visible COUNTS are not.

- Collections in `section#portfolio`: three `h4` cards exist in the DOM at both
  widths, but only TWO are exposed to the accessibility tree at 390x844 (one is
  hidden), and `getByRole('heading', { level: 4 })` counts only what is exposed.
  So: `expectNichesSection()` is the viewport-agnostic presence check (heading,
  all five filters, at least one collection); the desktop scenario asserts its
  "at least three" explicitly with `expectCollectionCountAtLeast(3)`. Do not put a
  desktop number inside the presence check.
- Pricing (six packages, PKG-001..006), the WhatsApp enquiry links, the contact
  form fields, the footer privacy link and the hero all hold at 390x844 unchanged.
- Horizontal overflow: scrollWidth === clientWidth at 390x844, i.e. the layout
  fits. `expectNoHorizontalOverflow()` is the check for that, and it is the
  concrete meaning of "no visual problem" at a narrow width — use it in a
  mobile-layout scenario in place of re-running every desktop assertion.
- Consequence for a mobile-layout scenario: `useViewport('mobile')` before
  `goto()`, `expectMobileNav()`, `expectNoHorizontalOverflow()`, then the section
  assertions that hold at both widths. Do NOT call `expectPrimaryNav()`.

## The Turnstile slot does not fit the widget it declares (live-probed 2026-10-21)

A defect the mobile test passed straight through, and the machinery change that now
catches it. Two separate lessons — keep both.

- **The check was blind, not the layout.** `expectNoHorizontalOverflow()` used to mean
  "`documentElement.scrollWidth === clientWidth`", and that is true here for a reason
  that HIDES the defect: a child wider than its column does not necessarily widen the
  document. The check now ALSO measures in-flow elements against the container they are
  laid out in (`measureLayoutSpill` in `src/runtime/viewport.ts`) and names the offender.
  A decorative absolutely-positioned glow is exempt (that is its design), and a clipping
  or scrolling container is exempt with its children (that is a carousel). The live page
  today reports 0 spills (425 boxes at 390x844), so the new half does not cry wolf on
  this layout.
- **The Turnstile widget is not in the DOM under automation, in ANY size.** In a fresh
  Playwright context at 390x844: `window.turnstile` is an object, the hidden
  `input[name="cf-turnstile-response"]` is populated, `challenges.cloudflare.com/
  turnstile/v0/api.js` is loaded — and `document.querySelectorAll('iframe')` is EMPTY.
  Explicitly calling `turnstile.render(host, { size: 'normal' })`, `'flexible'`, or
  `'compact'` into a 276px host injects no frame either. The visible widget exists only
  in a real browser. So no measurement of the page can catch this: do NOT wait for, or
  locate, the widget frame.
- **What is knowable without rendering is the contract.** The slot `.cf-turnstile`
  (`[data-testid="contact-turnstile"]`) is 276px wide at 390x844 — the width of the form,
  which is the contact section minus its very large mobile padding. It declares
  `data-sitekey` with NO `data-size`, i.e. Cloudflare's default `normal`, which is a FIXED
  300x65 (docs: `compact` 150x140; `flexible` 100% of container). A fixed 300px widget in
  a 276px column overflows the form by 24px while `scrollWidth` stays equal to
  `clientWidth` — which is exactly why "the widget spills out of the inquiry form" is
  real and the old check was green.
- **Consequence for test-case generation: the mobile-layout scenario MUST also call
  `expectTurnstileFitsForm()`.** It reads the declared `data-size`, maps it to the fixed
  widget width, and asserts the slot is at least that wide — the one form of this check
  that does not depend on Cloudflare rendering a frame. It is EXPECTED TO FAIL on the
  current app (slot 276px, declared widget 300px). Report it; the fix is the app's —
  widen the form at narrow widths, or declare `data-size="flexible"`. The test does not
  shrink the slot to make it green.
- `flexible` is documented as 100% of the container but with a 300px minimum, so it is
  NOT verified here as a fix for a 276px column. Do not claim that it is; re-probe once
  the app changes, because a rendered frame is the only way to measure it.
