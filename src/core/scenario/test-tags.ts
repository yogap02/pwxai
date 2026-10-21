/**
 * Playwright tags, derived from the scenario file.
 *
 * A scenario declares its tags (`Tags: @smoke @core`), and stage 5's filter runs
 * with `--grep @smoke|@core`. That filter only works if the tag actually reaches the
 * test call. It does not get there by itself:
 *
 *   - Asking the model for it is a silent omission the moment the model forgets,
 *     and the failure looks like a *smaller green run*, not an error.
 *   - Matching on the title instead works by accident, and only while the generated
 *     title is character-identical to the scenario title. When they disagree, the
 *     test drops out of the run with nothing printed.
 *
 * So the tag option is written by this module: derived from the scenario, applied
 * to the generated code, and idempotent so it can be refreshed on every run.
 *
 * The same module owns the creation-date tag (`@YYYYMMDD`) the pipeline stamps on a
 * freshly generated block. It is not a scenario's to declare — it comes from the run
 * date — and it is read back off a held block (`dateTagIn`) so a test keeps the date
 * it was made instead of being re-stamped with "today" on every run.
 */

/** Scenario tags normalised to Playwright form (`@name`), deduplicated, order kept. */
export function normaliseTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length === 0) continue;
    const withAt = tag.startsWith('@') ? tag : `@${tag}`;
    if (!out.includes(withAt)) out.push(withAt);
  }
  return out;
}

/**
 * The creation-date tag a block carries: `@YYYYMMDD`. Machinery writes it once,
 * when the block is generated (see `runDateTag` in `manifest.ts`). Reading it back
 * off a held block is what keeps the tag frozen — re-stamping "today" on every run
 * would rewrite every generated block's tag option once a day, a diff that churns
 * silently while nothing about the test changed.
 */
const DATE_TAG = /@\d{8}(?!\d)/;

/** The `@YYYYMMDD` creation-date tag in `code`, or null when the block has none. */
export function dateTagIn(code: string): string | null {
  const m = DATE_TAG.exec(code);
  return m === null ? null : m[0];
}

/** The Playwright tag option for a scenario. */
export function tagOption(tags: readonly string[]): string {
  return `{ tag: [${normaliseTags(tags).map((t) => `'${t}'`).join(', ')}] }`;
}

/**
 * Matches the head of a test call, up to and including the comma after the
 * title: `test('some title',` — also `test.fixme(`, `test.skip(`, `it(`. The
 * title is matched as a real string literal (escape-aware) so an apostrophe in
 * a title does not end it early.
 */
const TEST_CALL_HEAD =
  /^([ \t]*(?:test|it)(?:\.\w+)?\(\s*)(['"`])((?:\\.|(?!\2)[^\\])*)\2\s*,/m;

/**
 * Put the scenario's tags on a generated test call.
 *
 * - `test('t', async ({ page }) => {…})`             → inserts the option
 * - `test('t', { tag: ['@stale'] }, async (…) => {…})` → replaces the stale tag
 * - anything it cannot parse is returned UNCHANGED: a mangled test is worse than
 *   an untagged one, and the planner's title alternation still covers that case.
 *
 * Idempotent: applying it twice yields the same code.
 */
export function applyScenarioTags(code: string, tags: readonly string[]): string {
  const wanted = normaliseTags(tags);
  if (wanted.length === 0) return code;

  const head = TEST_CALL_HEAD.exec(code);
  if (head === null) return code;

  const title = head[3]!;
  const quote = head[2]!;
  const prefix = code.slice(0, head.index) + head[1]!;
  const rest = code.slice(head.index + head[0].length);
  const rebuiltHead = `${prefix}${quote}${title}${quote}, `;

  // Already an options object? Put/replace the tag inside it, keeping the rest.
  const restTrimmed = rest.replace(/^\s*/, '');
  if (restTrimmed.startsWith('{')) {
    const end = matchingBrace(restTrimmed, 0);
    if (end === -1) return code; // unbalanced — do not touch it
    const body = restTrimmed.slice(1, end);
    return rebuiltHead + withTagProperty(body, wanted) + restTrimmed.slice(end + 1);
  }

  // No options yet — insert one before the test body.
  return `${rebuiltHead}${tagOption(wanted)},${rest}`;
}

/** An options object literal carrying exactly the wanted tag, plus any other keys. */
function withTagProperty(body: string, wanted: readonly string[]): string {
  const withoutTag = body.replace(
    /(^|,)\s*tag\s*:\s*(?:\{[^{}]*\}|\[[^[\]]*\]|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*/g,
    '$1',
  );
  const rest = withoutTag.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '');
  const tag = `tag: [${wanted.map((t) => `'${t}'`).join(', ')}]`;
  return `{ ${rest.length > 0 ? `${tag}, ${rest}` : tag} }`;
}

/**
 * The index of the `}` matching the `{` at `start`, or -1. String-literal aware,
 * so braces inside a title or a selector do not confuse the count.
 */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === `'` || ch === `"` || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
