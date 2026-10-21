/**
 * Capability index: the real surface of a page-object file, extracted from
 * source. Gates are matchers, not prompt rules (pipeline-pattern.md §3):
 * the model must NAME the members it would use, and those names are checked
 * against this surface. A claimed name that doesn't exist is the missing
 * capability, and the name it reached for is the spec of what to build.
 *
 * Known limit, stated deliberately: this catches an INVENTED capability, not a
 * SUBSTITUTED one. Existence is checkable; sufficiency is not.
 */

import { readFile } from 'node:fs/promises';
import { rehydrate } from '../core/util/paths.js';

export interface PomSurface {
  /** File path, repo-relative POSIX. */
  file: string;
  /** Method names: everything matched as `name(...)` on a class. */
  methods: Set<string>;
  /** Property/getter names: `get name()` or `name = ...`. */
  properties: Set<string>;
  /** Locators defined as fields — `readonly name = page.locator(...)` etc. */
  locators: Set<string>;
  /**
   * Method name → its parameter list as written (`href: string`), when the whole
   * signature sits on one line. Prompt context only: a method the generator is
   * told about by NAME ALONE cannot be called correctly — `expectHeroCtaTargets`
   * reads like a zero-argument assertion, so the block omits the required `href`
   * and the spec does not compile. A wrapped signature yields no entry, never a
   * wrong one.
   */
  params: Map<string, string>;
}

/**
 * Extract a page object's member surface from TypeScript source. Heuristic but
 * conservative: only lines that look like members of the class body are
 * scanned. Used for existence gating — false "missing" is visible in a report
 * (cheap to undo); false "present" would silently let a bad block through, so
 * we prefer over-matching names to under-matching.
 */
export async function extractPomSurface(pomFileRepoRelative: string): Promise<PomSurface> {
  const abs = rehydrate(pomFileRepoRelative);
  let source: string;
  try {
    source = await readFile(abs, 'utf8');
  } catch {
    return {
      file: pomFileRepoRelative,
      methods: new Set(),
      properties: new Set(),
      locators: new Set(),
      params: new Map(),
    };
  }

  const methods = new Set<string>();
  const properties = new Set<string>();
  const locators = new Set<string>();
  const params = new Map<string, string>();

  // Method declarations: `async name(` / `name(` at member position.
  for (const m of source.matchAll(/^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)) {
    const name = m[1]!;
    if (RESERVED.has(name)) continue;
    methods.add(name);
    // The parameter list, when the signature does not wrap. Bounded to this line
    // so a wrapped signature yields no hint rather than a wrong one.
    const rest = source.slice(m.index + m[0].length);
    const close = rest.indexOf(')');
    const newline = rest.indexOf('\n');
    if (close !== -1 && (newline === -1 || close < newline)) {
      const text = rest.slice(0, close).replace(/\s+/g, ' ').trim();
      if (looksLikeParams(text)) params.set(name, text);
    }
  }
  // Properties / getters: `name = ...` or `get name()`.
  for (const m of source.matchAll(/^\s*(?:public\s+|private\s+|protected\s+)?(?:readonly\s+)?(?:get\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*.*(?:locator|getBy)/gm)) {
    const name = m[1]!;
    properties.add(name);
    locators.add(name);
  }
  for (const m of source.matchAll(/^\s*(?:public\s+|private\s+|protected\s+)?get\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)) {
    properties.add(m[1]!);
  }

  return { file: pomFileRepoRelative, methods, properties, locators, params };
}

const RESERVED = new Set([
  'constructor', 'if', 'for', 'while', 'switch', 'catch', 'return', 'function',
  'describe', 'it', 'test', 'expect', 'import', 'export', 'class', 'const',
  'let', 'var', 'new', 'this', 'super', 'typeof', 'await', 'async', 'static',
  // `dbg(...)` is a call inside a method body that happens to start a line. Listed
  // as a member it is a capability nobody has, and its parameters are the call's
  // own arguments — noise the model could be handed as if it were a contract.
  'dbg',
]);

/**
 * A parameter list, or nothing. Deliberately strict, because a WRONG hint is
 * worse than none: the naive capture also fires on a call expression matched as a
 * "method" (`dbg('x', { … })`) and stops at the first inner `)` of a
 * callback-typed parameter (`build: (copy: string) => Locator`), each of which
 * would hand the model a contract that is not one.
 */
function looksLikeParams(text: string): boolean {
  if (text.length === 0) return false;
  if (/[()'"`]/.test(text)) return false;
  return text
    .split(',')
    .every((p) => /^[A-Za-z_$][\w$]*\??\s*:\s*\S/.test(p.trim()));
}

/** Flatten a set of surfaces into one lookup for gating. */
export interface CapabilityLookup {
  has(member: string): boolean;
  /** Bare member names — what the name-gate checks and the classifier matches. */
  all(): string[];
  /**
   * `name(params)` for the generator, so a call it writes can supply the required
   * arguments. Kept separate from `all()`: the classifier answers with member
   * NAMES and those are matched against the surface, so handing it a signature
   * would make every claimed capability look like a missing one.
   */
  catalog(): string[];
}

export function buildLookup(surfaces: readonly PomSurface[]): CapabilityLookup {
  const all = new Set<string>();
  const params = new Map<string, string>();
  for (const s of surfaces) {
    for (const m of s.methods) all.add(m);
    for (const p of s.properties) all.add(p);
    for (const l of s.locators) all.add(l);
    for (const [name, text] of s.params) params.set(name, text);
  }
  return {
    has: (member) => all.has(member),
    all: () => [...all].sort(),
    catalog: () =>
      [...all]
        .sort()
        .map((name) => (params.has(name) ? `${name}(${params.get(name)})` : name)),
  };
}
