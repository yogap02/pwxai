import { test } from '../../src/runtime/self-heal-fixture.js';
import { LandingPage } from '../../src/page-objects/landing-page/index.js';

test.describe("landing-page", () => {
  // Handwritten tests live above the managed region.

  // @digest:managed:start

  // @digest:block:0a2449eb255e0476:5788605f04171a35
  test('The landing page loads with the site title', { tag: ['@smoke', '@core'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);

    await landingPage.goto();
    await landingPage.expectSiteTitle();
  });
  // @digest:end-block

  // @digest:block:672e34ad0dc018a8:4072ccdbdf3d150f
  test('The hero shows the headline and tagline', { tag: ['@smoke', '@core'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.goto();
    await landingPage.expectHero();
  });
  // @digest:end-block

  // @digest:block:d1fbe67a18805519:d7a9fd37eb6a640a
  test('The hero call to action leads to the portfolio', { tag: ['@core'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.goto();
    await landingPage.expectHero();
    await landingPage.expectHeroCtaTargets('/en/portfolio');
  });
  // @digest:end-block

  // @digest:block:2bc598b991d836a7:e9533cd75320921f
  test('The primary navigation links to Portfolio, Pricing and Contact', { tag: ['@smoke', '@core'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.goto();
    await landingPage.expectLoaded();
    await landingPage.expectPrimaryNav();
  });
  // @digest:end-block

  // @digest:block:57f9e22997b9cce6:3b57375f4782e448
  test('The language switcher offers Indonesian and English', { tag: ['@core'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.goto();
    await landingPage.expectLanguageSwitcher();
  });
  // @digest:end-block

  // @digest:block:a3f6a91e0f194bbb:fbe5ce39964e68b8
  test('The niches section lists the default collection with filters', { tag: ['@smoke', '@core'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.goto();
    await landingPage.expectNichesSection();
    await landingPage.expectNicheFilter('all');
    await landingPage.expectNicheFilter('macro');
    await landingPage.expectNicheFilter('products');
    await landingPage.expectNicheFilter('diecast');
    await landingPage.expectNicheFilter('jewelry');
    await landingPage.expectCollectionCountAtLeast(3);
  });
  // @digest:end-block

  // @digest:block:bda0f0118589325d:4cde0629c63b67fe
  test('The pricing section lists all six packages', { tag: ['@core'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.goto();
    await landingPage.expectPricingPackages();
  });
  // @digest:end-block

  // @digest:block:6e3a5b1ef706c4e3:c9f52f08cedb9b0a
  test('Each package offers a WhatsApp enquiry link', { tag: ['@regression'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.goto();
    await landingPage.expectPricingPackages();
    await landingPage.expectPackageEnquiryLinks();
  });
  // @digest:end-block

  // @digest:block:f90beb7ce4c425d6:7483a045bacc2f01
  test('The contact form exposes its five fields and submit button', { tag: ['@smoke', '@core'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.useViewport('mobile');
    await landingPage.goto();
    await landingPage.expectContactForm();
  });
  // @digest:end-block

  // @digest:block:8eed2a77bd2742fb:6b75dfa64841cf57
  test('The footer links to the privacy policy', { tag: ['@smoke'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.goto();
    await landingPage.expectFooterLegal();
  });
  // @digest:end-block

  // @digest:block:22a9fd0fbf950c10:ba0c373c9e043f3b
  test('Navbar should contain localization button', { tag: ['@core'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.goto();
    await landingPage.expectLoaded();
    await landingPage.expectLanguageSwitcher();
  });
  // @digest:end-block

  // @digest:block:b05014bb0819ef1c:1b98330ce525d043
  test('Mobile responsive layout should be landing without any visual error', { tag: ['@core'] }, async ({ page }) => {
    const landingPage = new LandingPage(page);
    await landingPage.useViewport('mobile');
    await landingPage.goto();
    await landingPage.expectLoaded();
    await landingPage.expectMobileNav();
    await landingPage.expectNoHorizontalOverflow();
    await landingPage.expectTurnstileFitsForm();
    await landingPage.expectHero();
    await landingPage.expectNichesSection();
    await landingPage.expectPricingPackages();
    await landingPage.expectContactForm();
    await landingPage.expectFooterLegal();
  });
  // @digest:end-block

  // @digest:managed:end

});
