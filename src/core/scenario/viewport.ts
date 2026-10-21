/**
 * Device profiles — the general knowledge a digest needs about "mobile layout".
 *
 * A scenario that is about a narrower (or wider) viewport is a real, recurring
 * category, and the pipeline should understand it without knowing anything about
 * a given product's pages. So the vocabulary (the profiles), the conventional way
 * a page object applies one, and the decision "can this page object express the
 * scenario at all?" all live here, in the machinery, and are product-neutral.
 *
 * Why a capability and not a prompt nudge: a page object that cannot set a
 * viewport cannot express a mobile scenario, and the two failure modes of
 * pretending otherwise are both silent. Assert the desktop layout at a phone
 * width and the test passes without testing anything (the block used to omit the
 * viewport change entirely); or set the width and the desktop assertions fail on
 * a collapsed nav, which looks like a product bug. The digest turns the missing
 * capability into a stage-4 work order instead.
 *
 * This module is pure: no I/O, no Playwright, no model calls.
 */

/** The device profiles a scenario may be written for. */
export type ViewportProfile = 'mobile' | 'tablet' | 'desktop';

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Profile sizes. `desktop` is the run's own default (Playwright's 1280x720 is a
 * desktop width), so a desktop scenario needs no viewport change; the others do.
 */
export const VIEWPORT_PROFILES: Record<ViewportProfile, ViewportSize> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1440, height: 900 },
};

/**
 * The conventional page-object member that applies a profile, e.g.
 * `async useViewport(profile: ViewportProfile)`. Named here so the digest can
 * require it and the generator can be told the exact call — a page object owns
 * the capability, and a spec never reaches for `page` itself.
 */
export const VIEWPORT_MEMBER = 'useViewport';

/**
 * Which device profile a scenario is written for, read from its own words.
 * Ordered: an explicit device word wins; a scenario about "responsive layout" or
 * "the viewport" without naming a device is about the NARROW case, because that
 * is the width at which layout breaks. Returns null when the scenario says
 * nothing about a viewport, which is the ordinary desktop-ish case.
 */
const PROFILE_WORDS: ReadonlyArray<readonly [RegExp, ViewportProfile]> = [
  [/\b(?:mobile|handset|smartphone|phone)\b/i, 'mobile'],
  [/\b(?:tablet|ipad)\b/i, 'tablet'],
  [/\b(?:desktop|widescreen|large screen)\b/i, 'desktop'],
  [/\b(?:responsive|viewport|narrow)\b/i, 'mobile'],
];

export function viewportProfileIn(text: string): ViewportProfile | null {
  for (const [pattern, profile] of PROFILE_WORDS) {
    if (pattern.test(text)) return profile;
  }
  return null;
}

/**
 * The capability a scenario needs but this page object does not expose, or null
 * when there is nothing missing. Returned as the work order's capability name, so
 * stage 4 is told exactly what to build rather than "mobile does not work".
 */
export function viewportCapabilityGap(
  has: (member: string) => boolean,
  profile: ViewportProfile | null,
): string | null {
  if (profile === null || profile === 'desktop') return null;
  return has(VIEWPORT_MEMBER) ? null : `${VIEWPORT_MEMBER}(profile: ViewportProfile)`;
}
