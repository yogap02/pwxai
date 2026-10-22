import { expect, type Locator, type Page } from '@playwright/test';
import { attemptCopyHeal, attemptHeal, healingFor } from '../../runtime/heal-locator.js';
import { applyViewport, measureHorizontalOverflow, measureLayoutSpill } from '../../runtime/viewport.js';
import { VIEWPORT_PROFILES, type ViewportProfile } from '../../core/scenario/viewport.js';
import { dbg } from '../../core/util/debug.js';

/**
 * The category pills the gallery offers, in the order the UI shows them.
 *
 * `all` is the unfiltered list and is the same as no `?category` parameter at all.
 */
const CATEGORY_PILLS = ['all', 'macro', 'products', 'diecast', 'jewelry'] as const;

/**
 * Repo-relative path of THIS file. Heal records name the file they belong to, so
 * stage 7 knows which source to rewrite. Hand-maintained: a page object cannot
 * know its own path at runtime, and a wrong path is worse than a heal that is
 * skipped and reported.
 */
const SOURCE = 'src/page-objects/gallery/index.ts';

/**
 * The locale this file's copy is written for. The app serves `/en` and `/id` with
 * the same structure and different words (`/en` h1 "The Gallery." vs `/id` h1
 * "Galeri Karya."), so a copy heal is only valid while the run is in this locale
 * — otherwise matching English copy against an Indonesian page would rewrite
 * this file to Indonesian and break `/en`. Structure is shared across locales,
 * so only copy healing needs to know this.
 */
const LOCALE = '/en';

/**
 * The grid's empty state. Probed live: filtering to a category with no proofs
 * renders this line INSIDE `[data-testid="portfolio-grid"]`, where the cards
 * would be.
 *
 * SENTENCE CASE, deliberately, and the reason is a trap worth naming: the page
 * DISPLAYS "NO MICROSCOPIC PROOFS FOUND." because the element carries
 * `text-transform: uppercase`. The DOM text is "No microscopic proofs found."
 * — `innerText` (what a probe reading the page sees) returns the TRANSFORMED
 * text, while `toContainText` reads untransformed `textContent`. Written in caps
 * to match what the eye sees, this assertion fails with a diff that looks like a
 * product bug and is not one. Assert the DOM, not the paint.
 */
const EMPTY_STATE = 'No microscopic proofs found.';

/**
 * GalleryPage — the public portfolio gallery at /en/portfolio.
 *
 * TWO RULES OF PLAY (AGENTS.md §"Test authoring rules"):
 *   1. Assertions live HERE, not in the spec. Spec files call intent-revealing
 *      `expect*()` methods and never touch Playwright's `expect` themselves.
 *   2. Every assertion carries a message — `expect(locator, 'message')`. A failing
 *      assertion must say what it was checking, not just dump two locator strings.
 *
 * WHAT MAKES THIS DOMAIN DIFFERENT FROM THE LANDING PAGE, and it is the reason
 * `expectFilteredTo` exists at all: filtering is a NAVIGATION, not a state change.
 * The pills and the search box both push a new URL (`?category=`, `?q=`) and the
 * server renders the filtered list, so a filter assertion has to survive the
 * navigation rather than assume the DOM mutated in place. The search box is the
 * sharp edge: it does NOT filter as you type — typing changes nothing until the
 * form is submitted — so `search()` submits, and a test that only fills the box
 * would assert the unfiltered list and pass for the wrong reason.
 *
 * TWO KNOWN PRODUCT DEFECTS are deliberately NOT asserted here, because a test
 * would either go red for something this domain cannot fix or freeze the bug as
 * correct. Both are recorded in instruction.md:
 *   - the `diecast` pill returns zero proofs while a proof labelled `hobby` is
 *     titled "Diecast";
 *   - the lightbox has no `role="dialog"`, its card is not focusable, and Escape
 *     does not close it.
 * `config/scope-rules.md` carries the same boundary for stage 1.
 *
 * Locators that need no healing are GETTERS, not class fields, deliberately:
 * tsconfig targets ES2022, so `useDefineForClassFields` is on and field
 * initializers run before the constructor body, where `this.page` is undefined.
 */
export class GalleryPage {
  constructor(private readonly page: Page) {}

  // --- Navigation -----------------------------------------------------------

  /** Navigate to the gallery and confirm it rendered. */
  async goto(): Promise<void> {
    dbg('pom:gallery', 'goto', { path: '/en/portfolio' });
    await this.page.goto('/en/portfolio');
    dbg('pom:gallery', 'goto:done', { url: this.page.url() });
    await this.expectLoaded();
  }

  /**
   * Apply a device profile before asserting. Call it BEFORE `goto()` so the page
   * loads at that width.
   */
  async useViewport(profile: ViewportProfile): Promise<void> {
    dbg('pom:gallery', 'useViewport', { profile, size: VIEWPORT_PROFILES[profile] });
    await applyViewport(this.page, profile);
  }

  /**
   * Click a category pill and wait for the filtered page to render.
   *
   * It waits for the URL, not for a timeout: the pill is a navigation, so the
   * next assertion must not race the server render. `all` navigates to the bare
   * path, which is the same list as `?category=all` — the app omits the parameter
   * for the default.
   */
  async filterByCategory(category: string): Promise<void> {
    dbg('pom:gallery', 'filterByCategory', { category });
    await this.expectCategoryPill(category);
    await this.categoryPill(category).click();
    const expected = category === 'all' ? /\/en\/portfolio(\?|$)/ : new RegExp(`category=${category}`);
    await expect(this.page, `Category pill "${category}" should navigate to its filtered URL`).toHaveURL(
      expected,
    );
    await this.expectGridSettled();
  }

  /**
   * Type a term into the search box and SUBMIT it.
   *
   * Submitting is the whole method. The box does not filter as you type — probed
   * live, filling it leaves every card in place — so a fill without a submit is a
   * test that asserts the unfiltered list and passes for the wrong reason. An
   * empty term is a legitimate submit: it returns to the unfiltered list.
   */
  async search(term: string): Promise<void> {
    dbg('pom:gallery', 'search', { term });
    const box = await this.searchInput();
    await box.fill(term);
    await box.press('Enter');
    const expected = term.length === 0 ? /\/en\/portfolio(\?|$)/ : new RegExp(`q=${term}`);
    await expect(this.page, `Submitting the search "${term}" should navigate to its filtered URL`).toHaveURL(
      expected,
    );
    await this.expectGridSettled();
  }

  /** Open the lightbox for the nth card (0-based) and confirm it is showing. */
  async openLightbox(index: number): Promise<void> {
    dbg('pom:gallery', 'openLightbox', { index });
    await (await this.cards().nth(index)).click();
    await expect(this.lightbox, `Clicking card ${index} should open its lightbox`).toBeVisible();
  }

  // --- Assertions -----------------------------------------------------------
  // Every method below asserts, so the spec never imports `expect`.

  /** The gallery has rendered (the h1 is the signal that the route painted). */
  async expectLoaded(): Promise<void> {
    dbg('pom:gallery', 'expectLoaded');
    await expect(this.heading, 'Gallery page should show its "The Gallery." heading').toBeVisible();
  }

  /** The page heading reads "The Gallery." — the route's own title, not the site's. */
  async expectHeading(): Promise<void> {
    dbg('pom:gallery', 'expectHeading');
    await expect(this.heading, 'Gallery heading should read "The Gallery."').toHaveText(
      'The Gallery.',
    );
  }

  /** The intro line under the heading is present. */
  async expectIntro(): Promise<void> {
    dbg('pom:gallery', 'expectIntro');
    await expect(
      await this.intro(),
      'Gallery should describe itself as an index of technical macro proofs',
    ).toContainText('technical macro proofs');
  }

  /** Every category pill is offered. */
  async expectCategoryPills(): Promise<void> {
    dbg('pom:gallery', 'expectCategoryPills', { pills: CATEGORY_PILLS.length });
    for (const pill of CATEGORY_PILLS) {
      await this.expectCategoryPill(pill);
    }
  }

  /** A single category pill is visible. */
  async expectCategoryPill(category: string): Promise<void> {
    await expect(
      this.categoryPill(category),
      `Category pill "${category}" should be available`,
    ).toBeVisible();
  }

  /**
   * The grid lists exactly `count` proofs.
   *
   * Exact, not "at least": a filter's whole claim is the number it selects, and
   * `at least 1` is satisfied by an unfiltered list. This is the assertion a
   * filter test needs, and the reason the landing page's `expectCollectionCountAtLeast`
   * is not reused here.
   */
  async expectCardCount(count: number): Promise<void> {
    const cards = this.cards();
    dbg('pom:gallery', 'expectCardCount', { expected: count, actual: await cards.count() });
    await expect(
      cards,
      `Gallery grid should list exactly ${count} proof(s) at this filter`,
    ).toHaveCount(count);
  }

  /** The grid shows the empty state, and no cards. */
  async expectEmptyState(): Promise<void> {
    dbg('pom:gallery', 'expectEmptyState');
    await expect(
      await this.grid(),
      'A filter with no matches should say so inside the grid',
    ).toContainText(EMPTY_STATE);
    await this.expectCardCount(0);
  }

  /**
   * Every visible proof card carries a title, a category label and a camera line.
   *
   * One card's worth of structure asserted across all of them: the card is the
   * unit the gallery is made of, so a card that renders without its caption is a
   * blank tile, which is what this catches.
   */
  async expectCardsAreComplete(): Promise<void> {
    const cards = this.cards();
    const total = await cards.count();
    dbg('pom:gallery', 'expectCardsAreComplete', { cards: total });
    expect(total, 'Gallery should list at least one proof to inspect').toBeGreaterThan(0);
    for (let i = 0; i < total; i++) {
      const card = cards.nth(i);
      await expect(
        card.locator('h4'),
        `Proof ${i} should show its title`,
      ).toBeVisible();
      await expect(
        card.locator('img'),
        `Proof ${i} should show its image`,
      ).toBeVisible();
      const caption = ((await card.innerText()) ?? '').trim();
      expect(
        caption.split('\n').filter((l) => l.trim().length > 0).length,
        `Proof ${i} should carry its category, title and camera line, got: ${JSON.stringify(caption)}`,
      ).toBeGreaterThanOrEqual(3);
    }
  }

  /**
   * The images actually loaded.
   *
   * `naturalWidth > 0` is the only honest check: an `<img>` that failed to fetch
   * is still visible, still has a bounding box, and still passes `toBeVisible` —
   * it just renders as the alt text. The proofs come from Google's CDN, so a
   * broken src is a realistic failure that a visibility check cannot see.
   *
   * POLLED, not read once. The cards carry `loading="lazy"`, so an image below the
   * fold has not been requested yet when this runs — a single read reports
   * `complete=false, naturalWidth=0` for a perfectly good proof and fails a full
   * suite run while passing when the file is run alone (measured: green alone,
   * red in the full run, same page). Polling waits for the fetch to finish and
   * still fails honestly when it never does.
   */
  async expectImagesLoaded(): Promise<void> {
    const images = this.cards().locator('img');
    const total = await images.count();
    dbg('pom:gallery', 'expectImagesLoaded', { images: total });
    expect(total, 'Gallery should render at least one proof image').toBeGreaterThan(0);
    for (let i = 0; i < total; i++) {
      const image = images.nth(i);
      // Scroll it into view first: a lazy image that is never on screen is never
      // fetched, and polling would time out on a proof that is fine.
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(
          async () =>
            image.evaluate((el) => {
              const img = el as HTMLImageElement;
              return { complete: img.complete, naturalWidth: img.naturalWidth, alt: img.alt };
            }),
          { message: `Proof image ${i} should finish loading`, timeout: 15_000 },
        )
        .toMatchObject({ complete: true });
      const state = await image.evaluate((el) => {
        const img = el as HTMLImageElement;
        return { complete: img.complete, naturalWidth: img.naturalWidth, alt: img.alt };
      });
      expect(
        state.complete && state.naturalWidth > 0,
        `Proof image ${i} ("${state.alt}") should have loaded, got complete=${state.complete} naturalWidth=${state.naturalWidth}`,
      ).toBe(true);
    }
  }

  /** The search box and its submit control are present. */
  async expectSearchForm(): Promise<void> {
    dbg('pom:gallery', 'expectSearchForm');
    await expect(await this.searchInput(), 'Gallery should offer a search box').toBeVisible();
    await expect(
      await this.searchSubmit(),
      'Gallery should offer a search submit control',
    ).toBeVisible();
  }

  /**
   * The lightbox shows a proof, and closes again.
   *
   * Close is the close BUTTON, not Escape: probed live, Escape does not close this
   * overlay. The assertion checks the button path the app actually implements —
   * asserting Escape would go red for a defect this domain cannot fix, and
   * `config/scope-rules.md` records the keyboard gap instead.
   */
  async expectLightboxCloses(): Promise<void> {
    dbg('pom:gallery', 'expectLightboxCloses');
    await expect(this.lightbox, 'The lightbox should be open before it is closed').toBeVisible();
    await (await this.lightboxClose()).click();
    await expect(this.lightbox, 'The close button should dismiss the lightbox').toBeHidden();
  }

  /** The lightbox is showing the same proof that was clicked. */
  async expectLightboxShows(title: string): Promise<void> {
    dbg('pom:gallery', 'expectLightboxShows', { title });
    await expect(
      this.lightbox,
      `The lightbox should show the proof that was clicked ("${title}")`,
    ).toContainText(title);
  }

  /** The back link returns to the landing page. */
  async expectBackLink(): Promise<void> {
    dbg('pom:gallery', 'expectBackLink', { href: '/en' });
    await expect(
      await this.backLink(),
      'Gallery should link back to the landing page',
    ).toHaveAttribute('href', '/en');
  }

  /** The page fits: no sideways scroll, and no element spilling its container. */
  async expectNoHorizontalOverflow(): Promise<void> {
    const doc = await measureHorizontalOverflow(this.page);
    const spills = await measureLayoutSpill(this.page);
    dbg('pom:gallery', 'expectNoHorizontalOverflow', { ...doc, spills: spills.slice(0, 3) });
    expect(
      doc.overflow,
      `The gallery must not scroll sideways at this width (scrollWidth ${doc.scrollWidth} vs clientWidth ${doc.clientWidth})`,
    ).toBeLessThanOrEqual(1);
    expect(
      spills.length,
      `Every in-flow element must fit the container it is laid out in; overflowing: ${spills
        .slice(0, 5)
        .map((s) => `${s.path} past ${s.boundary} by ${s.overBy}px`)
        .join(', ')}`,
    ).toBe(0);
  }

  /**
   * Wait until the grid has settled after a navigation.
   *
   * The filtered list is server-rendered, so the old cards are gone before the new
   * ones arrive. There is a brief moment where the grid is EMPTY and the empty
   * state has not rendered either, and an assertion that lands there reads a
   * filtered-out page as a broken one. Waiting for "cards OR the empty state" is
   * the honest settle condition: it accepts both real outcomes and neither of the
   * transient ones.
   *
   * Private, and it stays private: it is a WAIT, not an assertion, and it belongs
   * inside the methods that navigate (`filterByCategory`, `search`) rather than in
   * a spec. A spec that called it would be waiting for a state it never asserts.
   */
  private async expectGridSettled(): Promise<void> {
    // `expect.poll` on a plain value, not `expect(async () => …).toPass()`: the latter is
    // Playwright's polling form, but the repo's self-check reads a bare `expect(async () =>`
    // as an assertion with no message — and it is right to, because every other `expect` here
    // carries one. Polling a boolean keeps the message on the assertion that actually fails.
    //
    // Case-insensitive on purpose. `innerText` returns PAINTED text — this grid's empty state is
    // `text-transform: uppercase`, so innerText says "NO MICROSCOPIC PROOFS FOUND." while
    // `toContainText` reads the untransformed "No microscopic proofs found.". Comparing one
    // against the other exactly is how this wait silently never settled: it timed out on a page
    // that was already correct. The settle check cares that the empty state ARRIVED, not how it
    // was capitalised, so it normalises.
    const wanted = EMPTY_STATE.toLowerCase();
    await expect
      .poll(
        async () => {
          const cards = await this.cards().count();
          const empty = ((await (await this.grid()).innerText()) ?? '').toLowerCase().includes(wanted);
          return cards > 0 || empty;
        },
        {
          message: 'the grid should have settled into cards or its empty state',
          timeout: 10_000,
        },
      )
      .toBe(true);
  }

  // --- Locators -------------------------------------------------------------

  /**
   * Resolve a raw CSS locator, healing it when the app has drifted away from it.
   * With no heal fixture in play (`healingFor` undefined) this is a plain
   * `page.locator`.
   */
  private async loc(selector: string): Promise<Locator> {
    const healing = healingFor(this.page);
    dbg('pom:gallery', 'loc', { selector, healing: healing !== undefined });
    if (healing) {
      const healed = await attemptHeal(this.page, healing, SOURCE, selector);
      if (healed) return healed;
    }
    return this.page.locator(selector);
  }

  /**
   * Resolve a locator identified by COPY — an element's text or accessible name.
   *
   * `text` must be written below as a single-quoted literal, because the heal
   * record substitutes `'<text>'` in this file: a heal that matched a naked
   * fragment would also rewrite the same words inside assertion messages.
   */
  private async byCopy(text: string, build: (copy: string) => Locator): Promise<Locator> {
    const healing = healingFor(this.page);
    dbg('pom:gallery', 'byCopy', { text, locale: LOCALE, healing: healing !== undefined });
    if (healing) {
      const healed = await attemptCopyHeal(this.page, healing, SOURCE, { text, build, locale: LOCALE });
      if (healed) return healed;
    }
    return build(text);
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { level: 1 });
  }

  async intro(): Promise<Locator> {
    return this.byCopy('A comprehensive index of technical macro proofs', (copy) =>
      this.page.getByText(copy),
    );
  }

  async backLink(): Promise<Locator> {
    return this.byCopy('Back to Laboratory', (copy) =>
      this.page.getByRole('link', { name: new RegExp(copy, 'i') }),
    );
  }

  /**
   * The gallery section. `section#portfolio` carries the id AND the testid; the
   * id is the stable one (the landing page's niches section uses the same id for
   * the same content, so a rename would be a real structural change).
   */
  private async grid(): Promise<Locator> {
    return this.loc('[data-testid="portfolio-grid"]');
  }

  /** The proof cards, in DOM order. */
  private cards(): Locator {
    return this.page.locator('[data-testid^="portfolio-card-"]');
  }

  /** A category pill by its lowercase label. */
  categoryPill(category: string): Locator {
    return this.page.locator(`[data-testid="category-pill-${category}"]`);
  }

  async searchInput(): Promise<Locator> {
    return this.loc('[data-testid="portfolio-search-input"]');
  }

  async searchSubmit(): Promise<Locator> {
    return this.loc('[data-testid="portfolio-search-submit"]');
  }

  /**
   * The lightbox overlay. There is no testid and no role on it — probed live, it is
   * a bare `div.fixed.inset-0` at z-index 100 — so this is the one locator here
   * with nothing stable to hang on. `.last()` because the consent banner is the
   * other `fixed inset-0` overlay and it can be present at the same time; the
   * lightbox is appended after it.
   */
  get lightbox(): Locator {
    return this.page.locator('div.fixed.inset-0').last();
  }

  async lightboxClose(): Promise<Locator> {
    return this.loc('[data-testid="portfolio-lightbox-close"]');
  }
}
