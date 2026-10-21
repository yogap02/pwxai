import { expect, type Locator, type Page } from '@playwright/test';
import { attemptCopyHeal, attemptHeal, healingFor } from '../../runtime/heal-locator.js';
import { applyViewport, measureHorizontalOverflow, measureLayoutSpill } from '../../runtime/viewport.js';
import { VIEWPORT_PROFILES, type ViewportProfile } from '../../core/scenario/viewport.js';
import { dbg } from '../../core/util/debug.js';

/** The niche filter labels, in the order the UI shows them. */
const NICHE_FILTERS = ['all', 'macro', 'products', 'diecast', 'jewelry'] as const;

/**
 * Repo-relative path of THIS file. Heal records name the file they belong to, so
 * stage 7 knows which source to rewrite. Hand-maintained: a page object cannot
 * know its own path at runtime, and a wrong path is worse than a heal that is
 * skipped and reported.
 */
const SOURCE = 'src/page-objects/landing-page/index.ts';

/**
 * The locale this file's copy is written for. The app serves `/en` and `/id` with
 * the same structure and different words, so a copy heal is only valid while the
 * run is in this locale — otherwise matching English copy against an Indonesian
 * page would rewrite this file to Indonesian and break `/en`. Structure is shared
 * across locales, so only copy healing needs to know this.
 */
const LOCALE = '/en';

/**
 * The width Cloudflare's Turnstile widget renders at, by the `data-size` the slot
 * declares: `normal` (the default) and `compact` are FIXED — a non-responsive widget
 * does not shrink to fit its column — while `flexible` is 100% of its container and so
 * fits by construction. Cloudflare docs → "Widget configurations" → "Widget sizes".
 *
 * This constant lives here, not in `src/runtime/`, because it is this PRODUCT's
 * third-party contract. General machinery measures what is on the page, and Turnstile's
 * widget is not on the page under automation at all — see `expectTurnstileFitsForm`.
 */
const TURNSTILE_WIDGET_WIDTH: Record<string, number | null> = {
  normal: 300,
  compact: 150,
  flexible: null,
};

/**
 * LandingPage — the public marketing page at /en.
 *
 * TWO RULES OF PLAY (AGENTS.md §"Test authoring rules"):
 *   1. Assertions live HERE, not in the spec. Spec files call intent-revealing
 *      `expect*()` methods and never touch Playwright's `expect` themselves.
 *   2. Every assertion carries a message — `expect(locator, 'message')`. A failing
 *      assertion must say what it was checking, not just dump two locator strings.
 *
 * TWO WAYS A LOCATOR HEALS, and a locator that can do neither stays a plain getter:
 *
 *   `this.loc(selector)`     — a raw CSS string, healed by narrowing when the app
 *                              renames a class or id (`section#contact`).
 *   `this.byCopy(text, …)`   — an element identified by COPY: its text, or its
 *                              accessible name. Healed by finding the nearest
 *                              on-page copy when the app re-words it, or when this
 *                              file carries a typo in it.
 *
 * Plain getters are the ones with neither: `getByRole('heading', { level: 1 })`
 * carries no copy to drift and no string to narrow, and `getByText(/regex/)` has
 * no literal to correct. See heal-locator.ts and instruction.md. Both healers are
 * inert unless the spec imported the healing fixture.
 *
 * DEBUGGING: with `DEBUG` on, every navigation, assertion and locator resolution
 * narrates itself (see core/util/debug.ts) — the spec is the thin layer a run is
 * followed through, so the correlation (`goto` → `byCopy`/`loc` → `expect*`) is
 * emitted here rather than from the spec.
 *
 * Locators that need no healing are GETTERS, not class fields, deliberately.
 * tsconfig targets ES2022, so `useDefineForClassFields` is on and field
 * initializers run before the constructor body: a field like
 *   readonly headline = this.page.getByRole('heading', { level: 1 });
 * would read `this.page` as undefined. Getters also let the capability index
 * (src/ai/capability-index.ts) pick them up by name. Locators that resolve
 * through a healer are async methods, because resolution is a browser round-trip.
 *
 * Form fields are addressed by their `name` attribute: the visible captions are
 * not associated `<label>`s, so getByLabel/getByRole(textbox,{name}) resolve to
 * nothing here. See instruction.md in this folder.
 */
export class LandingPage {
  constructor(private readonly page: Page) {}

  // --- Navigation -----------------------------------------------------------

  /** Navigate to the landing page and confirm it rendered. */
  async goto(): Promise<void> {
    dbg('pom:landing-page', 'goto', { path: '/en' });
    await this.page.goto('/en');
    dbg('pom:landing-page', 'goto:done', { url: this.page.url() });
    await this.expectLoaded();
  }

  /** Click one of the niche filter buttons (all | macro | products | diecast | jewelry). */
  async openNiche(niche: string): Promise<void> {
    dbg('pom:landing-page', 'openNiche', { niche });
    await this.expectNicheFilter(niche);
    await this.nicheFilter(niche).click();
  }

  /**
   * Apply a device profile before asserting. The capability a viewport-dependent
   * scenario needs: the scenario decides the profile, this owns the mechanism, and
   * a spec therefore never calls `page.setViewportSize` itself. Call it BEFORE
   * `goto()` so the page loads at that width.
   */
  async useViewport(profile: ViewportProfile): Promise<void> {
    dbg('pom:landing-page', 'useViewport', { profile, size: VIEWPORT_PROFILES[profile] });
    await applyViewport(this.page, profile);
  }

  // --- Assertions -----------------------------------------------------------
  // Every method below asserts, so the spec never imports `expect`. Every
  // `expect(...)` call passes a message as its second argument.

  /** The hero has rendered (the signal that the SPA has painted). */
  async expectLoaded(): Promise<void> {
    dbg('pom:landing-page', 'expectLoaded');
    await expect(this.headline, 'Landing page hero headline should be visible').toBeVisible();
  }

  /** The document title names the site. */
  async expectSiteTitle(): Promise<void> {
    dbg('pom:landing-page', 'expectSiteTitle');
    await expect(
      this.page,
      'Landing page should have the fotogaper site title',
    ).toHaveTitle('fotogaper | Specialized Product & Macro Photography');
  }

  /** Headline and tagline together make up the hero copy. */
  async expectHero(): Promise<void> {
    dbg('pom:landing-page', 'expectHero');
    await expect(
      this.headline,
      'Hero headline should read "The Truth in Every Detail"',
    ).toHaveText('The Truth in Every Detail');
    await expect(await this.tagline(), 'Hero tagline should name the specialism').toBeVisible();
  }

  /** The hero call to action points at the given destination. */
  async expectHeroCtaTargets(href: string): Promise<void> {
    dbg('pom:landing-page', 'expectHeroCtaTargets', { href });
    await expect(
      await this.exploreWorkLink(),
      `Hero call to action should link to ${href}`,
    ).toHaveAttribute('href', href);
  }

  /** The primary navigation exposes Portfolio, Pricing and Contact. */
  async expectPrimaryNav(): Promise<void> {
    dbg('pom:landing-page', 'expectPrimaryNav', { links: ['/en/portfolio', '/en#pricing', '/en#contact'] });
    await expect(await this.navPortfolio(), 'Navigation should link to the portfolio').toHaveAttribute(
      'href',
      '/en/portfolio',
    );
    await expect(
      await this.navPricing(),
      'Navigation should link to the pricing section',
    ).toHaveAttribute('href', '/en#pricing');
    await expect(
      await this.navContact(),
      'Navigation should link to the contact section',
    ).toHaveAttribute('href', '/en#contact');
  }

  /**
   * What the navigation does at a mobile width: the desktop links are HIDDEN, not
   * removed, and there is no menu to open. Live-probed at 390x844 (instruction.md
   * §"Mobile viewport"): `getByRole('link', { name: 'Portfolio' })` resolves to 0
   * elements because a hidden element is absent from the accessibility tree.
   *
   * Deliberately plain locators, not the `byCopy(...)` ones: a locator that
   * resolves to 0 elements starts a HEAL, and the healer would then look for the
   * nearest copy on a page where the nav is intentionally hidden — a coin toss
   * that could rewrite this file. A deliberately hidden element is not a drift.
   */
  async expectMobileNav(): Promise<void> {
    dbg('pom:landing-page', 'expectMobileNav');
    await expect(
      this.nav.getByRole('link', { name: 'Portfolio', exact: true }),
      'The desktop navigation must be hidden at a mobile width (there is no mobile menu)',
    ).toBeHidden();
    await expect(
      this.nav.getByRole('link', { name: 'EN', exact: true }),
      'The locale switcher stays available at a mobile width',
    ).toBeVisible();
  }

  /** The language switcher offers Indonesian and English. */
  async expectLanguageSwitcher(): Promise<void> {
    dbg('pom:landing-page', 'expectLanguageSwitcher', { locales: ['/id', '/en'] });
    await expect(
      await this.languageIdLink(),
      'Language switcher should offer Indonesian (/id)',
    ).toHaveAttribute('href', '/id');
    await expect(
      await this.languageEnLink(),
      'Language switcher should offer English (/en)',
    ).toHaveAttribute('href', '/en');
  }

  /** A single niche filter button is visible. */
  async expectNicheFilter(niche: string): Promise<void> {
    dbg('pom:landing-page', 'expectNicheFilter', { niche });
    await expect(this.nicheFilter(niche), `Niche filter "${niche}" should be available`).toBeVisible();
  }

  /** The niches section shows its heading, all filters, and at least one collection. */
  async expectNichesSection(): Promise<void> {
    dbg('pom:landing-page', 'expectNichesSection', { filters: NICHE_FILTERS.length });
    await expect(await this.nichesHeading(), 'Niches section should show its heading').toBeVisible();
    for (const niche of NICHE_FILTERS) {
      await this.expectNicheFilter(niche);
    }
    const cardCount = await (await this.projectCards()).count();
    dbg('pom:landing-page', 'expectNichesSection:cards', { cards: cardCount });
    expect(
      cardCount,
      'Niches section should list at least one collection',
    ).toBeGreaterThanOrEqual(1);
  }

  /**
   * The niches section shows at least `count` collections at the CURRENT viewport.
   *
   * The visible count is a viewport fact, not a section fact: three `h4` cards exist
   * in the DOM at every width, but only two are exposed to the accessibility tree at
   * 390x844 (one is hidden there), and `getByRole` counts what is exposed. So the
   * desktop scenario asserts its three explicitly, instead of a section-presence
   * check carrying a desktop-only number that fails on a phone.
   */
  async expectCollectionCountAtLeast(count: number): Promise<void> {
    const cardCount = await (await this.projectCards()).count();
    dbg('pom:landing-page', 'expectCollectionCountAtLeast', { expected: count, cards: cardCount });
    expect(
      cardCount,
      `Niches section should list at least ${count} collection(s) at this viewport`,
    ).toBeGreaterThanOrEqual(count);
  }

  /**
   * The layout fits: the document does not scroll sideways, AND no in-flow element
   * sticks out of the container it is laid out in.
   *
   * The second half is the one that matters, and it is not the same check. A widget
   * wider than its column spills WITHOUT the document scrolling — the Turnstile widget
   * is a fixed 300px inside a 262px form column at 390x844, overflowing the form by
   * 38px while `documentElement.scrollWidth` stays equal to `clientWidth`. A
   * scroll-width check alone therefore passes a visibly broken layout; this one names
   * the element that hangs out and by how much.
   */
  async expectNoHorizontalOverflow(): Promise<void> {
    const doc = await measureHorizontalOverflow(this.page);
    const spills = await measureLayoutSpill(this.page);
    dbg('pom:landing-page', 'expectNoHorizontalOverflow', { ...doc, spills: spills.slice(0, 3) });
    expect(
      doc.overflow,
      `The document must not scroll sideways at this width (scrollWidth ${doc.scrollWidth} vs clientWidth ${doc.clientWidth})`,
    ).toBeLessThanOrEqual(1);
    expect(
      spills.length,
      `Every in-flow element must fit the container it is laid out in; overflowing: ${spills
        .slice(0, 5)
        .map((s) => `${s.path} past ${s.boundary} by ${s.overBy}px`)
        .join(', ')}`,
    ).toBe(0);
  }

  /** The pricing section lists all six packages with their reference codes. */
  async expectPricingPackages(): Promise<void> {
    dbg('pom:landing-page', 'expectPricingPackages', { packages: 6 });
    await expect(await this.pricingHeading(), 'Pricing section should show its heading').toBeVisible();
    await expect(await this.packageCards(), 'Pricing section should list six packages').toHaveCount(6);
    const pricing = await this.pricingSection();
    for (let i = 1; i <= 6; i++) {
      await expect(
        pricing.getByText(`Ref: PKG-00${i}`),
        `Package PKG-00${i} should show its reference code`,
      ).toBeVisible();
    }
  }

  /** Every package card offers a WhatsApp enquiry link. */
  async expectPackageEnquiryLinks(): Promise<void> {
    dbg('pom:landing-page', 'expectPackageEnquiryLinks', { expectedLinks: 6, scheme: 'wa.me' });
    const links = await this.letsTalkLinks();
    await expect(links, 'Every package should offer a WhatsApp enquiry link').toHaveCount(6);
    const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
    expect(
      hrefs.every((h) => h.startsWith('https://wa.me/')),
      'Every package enquiry link should target wa.me',
    ).toBe(true);
  }

  /** The enquiry form exposes all five fields and its submit button. */
  async expectContactForm(): Promise<void> {
    dbg('pom:landing-page', 'expectContactForm', {
      fields: ['name', 'email', 'phone', 'projectType', 'message'],
    });
    await expect(await this.contactHeading(), 'Contact section should show its heading').toBeVisible();
    await expect(await this.nameInput(), 'Contact form should have a name field').toBeVisible();
    await expect(await this.emailInput(), 'Contact form should have an email field').toBeVisible();
    await expect(await this.phoneInput(), 'Contact form should have an optional phone field').toBeVisible();
    await expect(
      await this.projectTypeSelect(),
      'Contact form should have a project-type select',
    ).toBeVisible();
    await expect(await this.messageInput(), 'Contact form should have a message field').toBeVisible();
    await expect(
      await this.sendMessageButton(),
      'Contact form should have a Send Message button',
    ).toBeVisible();
  }

  /**
   * The Turnstile slot is wide enough for the widget it declares.
   *
   * This cannot be the generic layout scan, and that is the whole point of the method.
   * Cloudflare injects NO widget frame in an automated browser: measured live in a fresh
   * Playwright context at 390x844, `window.turnstile` exists, the hidden
   * `cf-turnstile-response` field is populated — and `document.querySelectorAll('iframe')`
   * is EMPTY. Explicitly calling `turnstile.render(host, { size: 'normal' | 'flexible' |
   * 'compact' })` into a 276px host injects no frame either. The widget is a visible
   * 300x65 box in a real browser only, so a scan of the DOM cannot see it, whatever size
   * is configured, and a test that waits for it measures nothing. (The document does not
   * scroll either way: `scrollWidth` stays equal to `clientWidth`.)
   *
   * What IS knowable without rendering is the contract. The slot is 276px wide at 390x844
   * — the width of the form, which is the width of the contact section minus its very
   * large mobile padding — while `normal`, the declared default, is a fixed 300px. The
   * widget therefore overflows the form by 24px in a real browser: exactly the spill the
   * mobile test used to pass straight through.
   */
  async expectTurnstileFitsForm(): Promise<void> {
    const slot = await this.turnstileSlot();
    const declaredSize = (await slot.getAttribute('data-size')) ?? 'normal';
    const known = Object.prototype.hasOwnProperty.call(TURNSTILE_WIDGET_WIDTH, declaredSize);
    const requiredWidth = known ? (TURNSTILE_WIDGET_WIDTH[declaredSize] ?? null) : null;
    const box = await slot.boundingBox();
    dbg('pom:landing-page', 'expectTurnstileFitsForm', {
      declaredSize,
      requiredWidth,
      slotWidth: box ? Math.round(box.width) : null,
    });
    expect(
      known,
      `Turnstile slot declares data-size="${declaredSize}"; expected one of normal, compact, flexible`,
    ).toBe(true);
    // The expects above and here throw on failure; the guards after them only narrow types.
    expect(box, 'Contact form should reserve a Turnstile slot to measure').not.toBeNull();
    if (!known || box === null || requiredWidth === null) return;
    expect(
      Math.round(box.width),
      `Turnstile slot should fit the widget it declares: data-size="${declaredSize}" renders ${requiredWidth}px wide, so a narrower slot spills out of the form`,
    ).toBeGreaterThanOrEqual(requiredWidth);
  }

  /** The footer carries the privacy link and the copyright line. */
  async expectFooterLegal(): Promise<void> {
    dbg('pom:landing-page', 'expectFooterLegal', { privacyHref: '/en/privacy' });
    await expect(await this.privacyLink(), 'Footer should link to the privacy policy').toHaveAttribute(
      'href',
      '/en/privacy',
    );
    await expect(this.footerCopyright, 'Footer should show the fotogaper copyright').toBeVisible();
  }

  // --- Locators -------------------------------------------------------------

  /**
   * Resolve a raw CSS locator, healing it when the app has drifted away from it.
   *
   * The healer only records a heal when a narrower selector resolves uniquely, so
   * a healthy page records nothing and the source never churns. With no heal
   * fixture in play (`healingFor` undefined) this is a plain `page.locator`.
   */
  private async loc(selector: string): Promise<Locator> {
    const healing = healingFor(this.page);
    dbg('pom:landing-page', 'loc', { selector, healing: healing !== undefined });
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
   * record substitutes `'<text>'` in this file: a naked fragment like `Contact`
   * also occurs inside assertion messages, and a heal that rewrote those would
   * corrupt them. A heal therefore lands on the copy and nothing else.
   *
   * The copy is also locale-bound (see `LOCALE`): a run in another locale refuses
   * to heal rather than rewriting the words into the wrong language.
   */
  private async byCopy(text: string, build: (copy: string) => Locator): Promise<Locator> {
    const healing = healingFor(this.page);
    dbg('pom:landing-page', 'byCopy', { text, locale: LOCALE, healing: healing !== undefined });
    if (healing) {
      const healed = await attemptCopyHeal(this.page, healing, SOURCE, { text, build, locale: LOCALE });
      if (healed) return healed;
    }
    return build(text);
  }

  /** A niche filter button by its exact label. */
  nicheFilter(niche: string): Locator {
    return this.page.getByRole('button', { name: niche, exact: true });
  }

  get headline(): Locator {
    return this.page.getByRole('heading', { level: 1 });
  }

  /** The hero tagline. */
  async tagline(): Promise<Locator> {
    return this.byCopy('Macro and Product Photographer', (copy) =>
      this.page.getByText(copy, { exact: true }),
    );
  }

  async exploreWorkLink(): Promise<Locator> {
    return this.byCopy('Explore My Work', (copy) => this.page.getByRole('link', { name: copy }));
  }

  get nav(): Locator {
    return this.page.getByRole('banner').getByRole('navigation');
  }

  async navPortfolio(): Promise<Locator> {
    return this.byCopy('Portfolio', (copy) =>
      this.nav.getByRole('link', { name: copy, exact: true }),
    );
  }

  async navPricing(): Promise<Locator> {
    return this.byCopy('Pricing', (copy) => this.nav.getByRole('link', { name: copy, exact: true }));
  }

  async navContact(): Promise<Locator> {
    return this.byCopy('Contact', (copy) => this.nav.getByRole('link', { name: copy, exact: true }));
  }

  async languageIdLink(): Promise<Locator> {
    return this.byCopy('ID', (copy) => this.nav.getByRole('link', { name: copy, exact: true }));
  }

  async languageEnLink(): Promise<Locator> {
    return this.byCopy('EN', (copy) => this.nav.getByRole('link', { name: copy, exact: true }));
  }

  async nichesHeading(): Promise<Locator> {
    return this.byCopy('Explore Niches', (copy) =>
      this.page.getByRole('heading', { name: copy }),
    );
  }

  /** The niche filter buttons, scoped to the portfolio section. */
  async nicheFilters(): Promise<Locator> {
    return (await this.portfolioSection()).getByRole('button');
  }

  /** The portfolio cards, scoped to the niches section. */
  async projectCards(): Promise<Locator> {
    return (await this.portfolioSection()).getByRole('heading', { level: 4 });
  }

  async seeAllProofsLink(): Promise<Locator> {
    return this.byCopy('See All Microscopic Proofs', (copy) =>
      this.page.getByRole('link', { name: copy }),
    );
  }

  private async portfolioSection(): Promise<Locator> {
    return this.loc('section#portfolio');
  }

  /** The pricing section (healed: `section#pricing`). */
  async pricingSection(): Promise<Locator> {
    return this.loc('section#pricing');
  }

  async pricingHeading(): Promise<Locator> {
    return this.byCopy('Fair Rates, No Surprises', (copy) =>
      this.page.getByRole('heading', { name: copy }),
    );
  }

  async packageCards(): Promise<Locator> {
    return (await this.pricingSection()).getByRole('heading', { level: 3 });
  }

  async letsTalkLinks(): Promise<Locator> {
    // Regex: the apostrophe may be straight (') or typographic (’). A regex has no
    // literal for the copy healer to correct, so this one is repaired by hand.
    return (await this.pricingSection()).getByRole('link', { name: /Let.s Talk/i });
  }

  private async contactSection(): Promise<Locator> {
    return this.loc('[data-testid="contact-section"]');
  }

  /**
   * The Turnstile slot inside the contact form. The app marks it with a testid, and it is
   * a raw selector, so it resolves through the healer like the section locators.
   */
  private async turnstileSlot(): Promise<Locator> {
    return this.loc('[data-testid="contact-turnstile"]');
  }

  async contactHeading(): Promise<Locator> {
    return this.byCopy('Wanna make something cool?', (copy) =>
      this.page.getByRole('heading', { name: copy }),
    );
  }

  async nameInput(): Promise<Locator> {
    return (await this.contactSection()).locator('input[name="name"]');
  }

  async emailInput(): Promise<Locator> {
    return (await this.contactSection()).locator('input[name="email"]');
  }

  async phoneInput(): Promise<Locator> {
    return (await this.contactSection()).locator('input[name="phone"]');
  }

  async projectTypeSelect(): Promise<Locator> {
    return (await this.contactSection()).locator('select[name="projectType"]');
  }

  async messageInput(): Promise<Locator> {
    return (await this.contactSection()).locator('textarea[name="message"]');
  }

  async sendMessageButton(): Promise<Locator> {
    const section = await this.contactSection();
    return this.byCopy('Send Message', (copy) => section.getByRole('button', { name: copy }));
  }

  async privacyLink(): Promise<Locator> {
    // The consent banner carries a second, identically-named "Privacy Policy"
    // link (data-testid="consent-privacy-link"). Scope to the footer, or the
    // role query hits a strict-mode violation.
    const footer = await this.loc('footer');
    return this.byCopy('Privacy Policy', (copy) => footer.getByRole('link', { name: copy }));
  }

  get footerCopyright(): Locator {
    return this.page.getByText(/©\s*\d{4}\s*fotogaper/);
  }
}
