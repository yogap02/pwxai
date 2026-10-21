/**
 * Viewport and layout measurement: the general, product-neutral facts a page object
 * needs to say "this renders correctly at this width".
 *
 * Two things live here, and they are deliberately of the same kind — a fact that is
 * true of every product, so each page object does not re-guess it:
 *
 *   - the device profiles and how to apply one (`useViewport` delegates here), and
 *   - how to tell that a layout is broken at a given width.
 *
 * The layout half is split in two ON PURPOSE: `collectLayoutBoxes` reads geometry and
 * computed style out of the live page, and `findLayoutSpill` decides from that report
 * with no browser at all. The decision is where the bugs are — the first version of
 * this scan compared a child against its parent in the wrong direction and reported
 * every correctly-sized element — so the part that can be wrong is a pure function a
 * self-check can drive with synthetic boxes.
 */

import type { Page } from '@playwright/test';
import { VIEWPORT_PROFILES, type ViewportProfile } from '../core/scenario/viewport.js';

export async function applyViewport(page: Page, profile: ViewportProfile): Promise<void> {
  const size = VIEWPORT_PROFILES[profile];
  await page.setViewportSize({ width: size.width, height: size.height });
}

export interface OverflowMeasurement {
  scrollWidth: number;
  clientWidth: number;
  /** Pixels of content beyond the viewport; 0 when the layout fits. */
  overflow: number;
}

/**
 * How far the DOCUMENT overflows its own width. This catches a page that scrolls
 * sideways, and it is cheap — but it is not sufficient, and believing it was is how a
 * visibly broken layout got a passing test. A child wider than its container does not
 * necessarily widen the document: the Turnstile widget is a fixed 300px inside a 262px
 * form column at 390x844 and overflows the form by 38px while `scrollWidth` stays equal
 * to `clientWidth`. See `findLayoutSpill` for the check that sees that.
 */
export async function measureHorizontalOverflow(page: Page): Promise<OverflowMeasurement> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const scrollWidth = Math.max(root.scrollWidth, document.body.scrollWidth);
    const clientWidth = root.clientWidth;
    return { scrollWidth, clientWidth, overflow: Math.max(0, scrollWidth - clientWidth) };
  });
}

/** The geometry of one in-flow element and of the box it is laid out in. */
export interface LayoutBox {
  /** Human-usable descriptor: `div#contact.cf-turnstile`. */
  path: string;
  left: number;
  right: number;
  width: number;
  height: number;
  /** CSS `position`. */
  position: string;
  /** The parent's box, or null when the parent is `<body>`/`<html>` (or unusable). */
  parent: {
    path: string;
    left: number;
    right: number;
    /** Padding box inset by padding + border — what a child is expected to fit in. */
    contentLeft: number;
    contentRight: number;
    position: string;
    overflowX: string;
  } | null;
}

export interface LayoutReport {
  /** `window.innerWidth` — the width the user actually sees. */
  viewportWidth: number;
  boxes: readonly LayoutBox[];
}

export interface LayoutSpill {
  path: string;
  /** Pixels past the boundary. */
  overBy: number;
  /** What it spilled out of — a container's descriptor, or `the viewport`. */
  boundary: string;
}

/**
 * Which elements stick out of the box they are laid out in, worst first.
 *
 * The rules, each of which is a way to be wrong:
 *
 *  - **A child must fit its parent's content box.** That is the check the document
 *    scroll width cannot do.
 *  - **Decoration may bleed.** An `absolute`/`fixed` element is placed against a box
 *    rather than laid out in the flow, so a glow that overhangs its parent is the
 *    design; anything inside such an element is exempt with it.
 *  - **A clipping container may hold wider content.** `overflow-x` other than `visible`
 *    means the container is *meant* to crop or scroll — that is what a carousel is — so
 *    it is not a spill. (It also means a clipped-off widget is NOT caught here; that is
 *    a different complaint, and this check does not pretend to make it.)
 *  - **The viewport is a boundary too**, for elements whose parent is the body.
 *  - `tolerance` absorbs sub-pixel layout and border rounding, so a table cell that is
 *    0.5px wide of its parent is not a red run.
 */
export function findLayoutSpill(report: LayoutReport, tolerance = 1): LayoutSpill[] {
  const spills: LayoutSpill[] = [];
  for (const box of report.boxes) {
    if (box.width <= 0 || box.height <= 0) continue;
    if (box.position === 'absolute' || box.position === 'fixed') continue;
    const parent = box.parent;
    if (parent && (parent.position === 'absolute' || parent.position === 'fixed')) continue;
    // A clipping or scrolling container may hold wider content: that IS a carousel, and
    // the cropping is the design. The element is cropped by an ancestor, so it spills
    // neither the container nor the viewport — the container itself, if it is too wide,
    // is checked on its own line.
    if (parent && parent.overflowX !== 'visible') continue;

    const overViewport = Math.max(box.right - report.viewportWidth, -box.left);
    const overParent = parent
      ? Math.max(box.right - parent.contentRight, parent.contentLeft - box.left)
      : 0;
    const overBy = Math.max(overViewport, overParent);
    if (overBy <= tolerance) continue;

    spills.push({
      path: box.path,
      overBy: Math.round(overBy),
      boundary: parent && overParent >= overViewport ? parent.path : 'the viewport',
    });
  }
  return spills.sort((a, b) => b.overBy - a.overBy);
}

/** Read the geometry of every in-flow element out of the live page. */
export async function collectLayoutBoxes(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const descriptor = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className.trim() !== ''
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };
    const boxes: LayoutBox[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.display === 'contents' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const p = el.parentElement;
      let parent: LayoutBox['parent'] = null;
      if (p && p !== document.body && p !== document.documentElement) {
        const pcs = getComputedStyle(p);
        const pb = p.getBoundingClientRect();
        if (pcs.display !== 'contents' && pb.width > 0) {
          const padL = parseFloat(pcs.paddingLeft) || 0;
          const padR = parseFloat(pcs.paddingRight) || 0;
          const borderL = parseFloat(pcs.borderLeftWidth) || 0;
          const borderR = parseFloat(pcs.borderRightWidth) || 0;
          parent = {
            path: descriptor(p),
            left: pb.left,
            right: pb.right,
            contentLeft: pb.left + padL + borderL,
            contentRight: pb.right - padR - borderR,
            position: pcs.position,
            overflowX: pcs.overflowX,
          };
        }
      }
      boxes.push({
        path: descriptor(el),
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
        position: cs.position,
        parent,
      });
    }
    return { viewportWidth: window.innerWidth, boxes };
  });
}

/** Elements that stick out of their container or the viewport, worst first. */
export async function measureLayoutSpill(page: Page): Promise<LayoutSpill[]> {
  return findLayoutSpill(await collectLayoutBoxes(page));
}
