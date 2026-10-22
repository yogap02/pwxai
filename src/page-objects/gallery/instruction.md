# Gallery (`/en/portfolio`) — what this surface actually does

Probed live 2026-10-22 at 1280x900 and 390x844 against
`https://foto.gappp.my.id/en/portfolio`. Every fact below was measured, not
assumed. This file is the domain's memory: the builder agent reads it, and a
scenario that contradicts it is wrong.

## Structure

```
header[data-testid=site-header]      nav: fotogaper. → /en, Portfolio → /en/portfolio,
                                           Pricing → /en#pricing, Contact → /en#contact,
                                           ID → /id/portfolio, EN → /en/portfolio
a[data-testid=portfolio-back-link]   "← BACK TO LABORATORY" → /en
section#portfolio                    h1 "The Gallery."
                                     intro: "A comprehensive index of technical macro
                                     proofs across various specialized niches."
  [COLLECTIONS] label
  h3 "Explore Niches"
  form[data-testid=portfolio-search-form]
    input[data-testid=portfolio-search-input]
    button[data-testid=portfolio-search-submit]
  div[data-testid=category-pills]
    button[data-testid=category-pill-all|macro|products|diecast|jewelry]
  div[data-testid=portfolio-grid]
    div[data-testid=portfolio-card-1..3]
      p  category label   ("macro", "macro", "hobby")
      h4 title            ("Keycaps Artisan", "Keycaps Artisan", "Diecast")
      p  camera line      ("Sigma 70mm f2.8 Macro • 1:1 • 4 shots")
      img (next/image, fills the card)
  section (no testid)                h2 "Ready to expose the invisible?"
    a[data-testid=portfolio-cta]     "Start a Project" → /en#contact
footer[data-testid=site-footer]      a[data-testid=footer-privacy-link] "Privacy Policy"
div[data-testid=consent-banner]      Decline / Accept + a second "Privacy Policy" link
```

Three proofs at the time of probing. Two share the title "Keycaps Artisan" and
differ only by the shot count in their camera line — a title-only assertion
cannot tell them apart, and a test that counts titles will see a duplicate.

## Filtering is navigation, not state

Both filters push a URL and the server renders the result. Nothing filters in
place, and there is no client-side list to assert against.

| Action | URL | Cards |
|---|---|---|
| (none) | `/en/portfolio` | 3 |
| pill `all` | `/en/portfolio` | 3 |
| pill `macro` | `/en/portfolio?category=macro` | 2 |
| pill `products` | `/en/portfolio?category=products` | 0 |
| pill `diecast` | `/en/portfolio?category=diecast` | 0 |
| pill `jewelry` | `/en/portfolio?category=jewelry` | 0 |
| search `keycap` | `/en/portfolio?q=keycap` | 2 |
| search `diecast` | `/en/portfolio?q=diecast` | 1 |
| search `macro` | `/en/portfolio?q=macro` | 3 |
| search `zzz` | `/en/portfolio?q=zzz` | 0 |
| `?q=keycap&category=macro` | both | 2 (they compose) |

`?category=all` and no parameter are the same list: the app omits the parameter
for the default. An empty result renders **"No microscopic proofs found."**
inside `portfolio-grid` — it DISPLAYS in caps because the element carries
`text-transform: uppercase`, but the DOM text is sentence case, and that is what
an assertion must match. `innerText` returns the transformed text and
`toContainText` does not, so an assertion written from a screenshot fails.

**The search box does not filter as you type.** Filling it leaves every card in
place; only submitting (Enter, or the submit button) navigates. Probed
explicitly: after `fill('diecast')` the grid still had 3 cards, and after Enter
it had 1. This is the sharpest trap on this surface — a test that fills and
asserts passes while asserting nothing.

## The lightbox

Clicking a card opens an overlay: a bare `div.fixed.inset-0` at `z-index: 100`,
containing a close button (`data-testid="portfolio-lightbox-close"`, no
accessible name) and the proof at `h-[70vh] md:h-[80vh]`.

- It closes on the **close button** and on a **backdrop click**.
- **Escape does NOT close it.**
- It has **no `role="dialog"`**, and the card that opens it is a plain `div`
  with `cursor: pointer`, no `role` and no `tabindex` — so it cannot be reached
  or opened from the keyboard at all.

The last two points are real accessibility defects. `config/scope-rules.md`
records why this domain does not assert them.

## Two product defects found while probing

Recorded here rather than frozen as tests, because a test would either go red for
something this domain cannot fix, or assert the bug as correct.

### 1. The `diecast` pill cannot find the diecast proof

Under `all`, the third card is titled **"Diecast"** and its category label reads
**`hobby`**. The filter offers `diecast`, and `?category=diecast` returns zero
cards. So the gallery shows a diecast proof, and the diecast filter says there
are none.

The cause is a vocabulary mismatch: the proof's category is `hobby` while the
pill set offers `macro | products | diecast | jewelry`. Either the proof's
category or the pill list is wrong; this pipeline cannot tell which, and it is
the app's call.

### 2. The lightbox is mouse-only

See above: no dialog role, unfocusable card, no Escape. A keyboard user cannot
open or dismiss it.

### Minor: the page title repeats the site name

`<title>` is `Portfolio | fotogaper | fotogaper`. The landing page's is
`fotogaper | Specialized Product & Macro Photography`, so the doubling is this
route's own template bug, not the site-wide one. Not asserted — see
`config/scope-rules.md`.

## Locale

`/id/portfolio` mirrors the structure: h1 "Galeri Karya.", title
"Portofolio | fotogaper | fotogaper". Copy healing is bound to `/en` (see
`LOCALE` in `index.ts`) so an Indonesian run cannot rewrite this file's English
strings.

## Consent banner

`div[data-testid=consent-banner]` sits at `fixed inset-x-4 bottom-4 z-[60]` with
Decline/Accept. It is the other `fixed inset-0`-adjacent overlay on the page and
it can be visible at the same time as the lightbox — which is why the lightbox
locator takes `.last()`.

## What is worth testing here, and what is not

Worth it: the page renders; all five pills are offered; a pill filters to the
exact expected count; a pill with no matches shows the empty state; search
filters on submit; search and category compose; cards carry a title, a category
and a camera line; images actually loaded (`naturalWidth > 0`, not just
visible); the lightbox opens on the right proof and closes on its button; the
back link; no horizontal overflow at a mobile width.

Not worth it: anything about the three defects above, the exact copy of the
intro line, the CDN URLs, or the number of proofs — that is content, and it
changes when the photographer uploads a photo.

## What the stub builder observed
- Entry page: https://foto.gappp.my.id/en/portfolio
- Page title: Portfolio | fotogaper | fotogaper
