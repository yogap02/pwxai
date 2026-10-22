import { test } from '../../src/runtime/self-heal-fixture.js';
import { GalleryPage } from '../../src/page-objects/gallery/index.js';

test.describe("gallery", () => {
  // Handwritten tests live above the managed region.

  // @digest:managed:start

  // @digest:block:2fde08c6d787f5b1:5b413af13d6aedab
  test('The gallery page loads with its heading', { tag: ['@smoke', '@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);

    await gallery.goto();
    await gallery.expectLoaded();
    await gallery.expectHeading();
    await gallery.expectIntro();
  });
  // @digest:end-block

  // @digest:block:5b8bae917c5e69b8:49c0ac1ce3094d79
  test('The gallery offers every category filter', { tag: ['@smoke', '@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);
    await gallery.goto();
    await gallery.expectCategoryPills();
  });
  // @digest:end-block

  // @digest:block:9bc43c46ae2ec602:e59ccb31f7a44330
  test('A category filter narrows the gallery to its proofs', { tag: ['@smoke', '@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);
    await gallery.goto();
    await gallery.expectLoaded();
    await gallery.expectCardCount(3);

    await gallery.filterByCategory('macro');
    await gallery.expectLoaded();
    await gallery.expectCardCount(2);
    await gallery.expectCardsAreComplete();
  });
  // @digest:end-block

  // @digest:block:2dbe3df63b2c4478:d9d137f0d7ebbaff
  test('A category with no proofs shows the empty state', { tag: ['@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);
    await gallery.goto();
    await gallery.expectLoaded();
    await gallery.filterByCategory('products');
    await gallery.expectEmptyState();
    await gallery.expectCardCount(0);
  });
  // @digest:end-block

  // @digest:block:8553b28b14e7030b:1066ab615dd80b39
  test('The search box filters the gallery on submit', { tag: ['@smoke', '@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);
    await gallery.goto();
    await gallery.expectHeading();
    await gallery.expectCardCount(3);
    await gallery.search('keycap');
    await gallery.expectCardCount(2);
  });
  // @digest:end-block

  // @digest:block:2fb83b2787a4036e:d5f48ccedaa8955c
  test('A search with no matches shows the empty state', { tag: ['@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);
    await gallery.goto();
    await gallery.expectLoaded();
    await gallery.search('zzznotfound');
    await gallery.expectCardCount(0);
    await gallery.expectEmptyState();
  });
  // @digest:end-block

  // @digest:block:96a6538a0e1dbc84:298108563ec2c5cb
  test('A category filter and a search compose', { tag: ['@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);
    await gallery.goto();
    await gallery.expectLoaded();

    // Baseline: each filter alone yields 2 proofs.
    await gallery.filterByCategory('macro');
    await gallery.expectCardCount(2);

    // Compose: category=macro together with q=keycap in one URL.
    await gallery.search('keycap');
    await gallery.expectLoaded();
    await gallery.expectCardCount(2);
    await gallery.expectCardsAreComplete();
  });
  // @digest:end-block

  // @digest:block:9aed09f0477c3425:6eeed046a9cf1d93
  test('Every gallery card carries its title, category and camera line', { tag: ['@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);
    await gallery.goto();
    await gallery.expectLoaded();
    await gallery.expectCardsAreComplete();
  });
  // @digest:end-block

  // @digest:block:d65577628bbe7c05:d11ebab106075874
  test('The gallery proof images actually load', { tag: ['@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);
    await gallery.goto();
    await gallery.expectImagesLoaded();
  });
  // @digest:end-block

  // @digest:block:d952328db781084b:88a073a7bb8966c6
  test('The gallery lightbox opens the proof that was clicked and closes again', { tag: ['@smoke', '@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);

    await gallery.goto();
    await gallery.expectLoaded();

    await gallery.openLightbox(0);
    await gallery.expectLightboxShows('Keycaps Artisan');

    await gallery.expectLightboxCloses();
  });
  // @digest:end-block

  // @digest:block:39d47fefcc809138:b4539b57356f260c
  test('The gallery links back to the landing page', { tag: ['@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);
    await gallery.goto();
    await gallery.expectBackLink();
  });
  // @digest:end-block

  // @digest:block:fb017993598bc663:7ec04ea9579b06c9
  test('The gallery layout fits a mobile viewport', { tag: ['@smoke', '@core', '@20261022'] }, async ({ page }) => {
    const gallery = new GalleryPage(page);
    await gallery.useViewport('mobile');
    await gallery.goto();
    await gallery.expectLoaded();
    await gallery.expectNoHorizontalOverflow();
  });
  // @digest:end-block

  // @digest:managed:end

});
