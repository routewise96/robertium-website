// Domain slug → human-readable label.
//
// Used everywhere the public site renders a raw therapeutic-area slug
// (e.g. dropdown filters, browse tiles, modal grid, case-study tags).
//
// Rules:
// - Underscore is treated as a word boundary.
// - Words on the UPPERCASE_ACRONYMS list render in full caps (e.g. ALS).
// - Pure-digit tokens stay as-is so "type_2_diabetes" → "Type 2 diabetes".
// - Other words get their first letter capitalised.

const UPPERCASE_ACRONYMS: ReadonlySet<string> = new Set([
  'als',
  'mdd',
  'gbm',
  'cte',
  'ftd',
  'ibd',
  'ra',
]);

export function formatDomainName(slug: string | null | undefined): string {
  if (!slug) return '';
  const words = slug.split('_');
  return words
    .map((word, idx) => {
      const lower = word.toLowerCase();
      // Whitelisted acronyms render in full caps regardless of position
      // (so "als" → "ALS", "multiple_sclerosis" stays "Multiple sclerosis").
      if (UPPERCASE_ACRONYMS.has(lower)) return lower.toUpperCase();
      // Pure-digit tokens stay as-is (e.g. "type_2_diabetes" → "Type 2 diabetes").
      if (/^\d+$/.test(word)) return word;
      // Sentence case: only the first word gets its initial capitalised,
      // subsequent words stay lowercase ("Multiple sclerosis", not "Multiple Sclerosis").
      if (idx === 0) return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      return word.toLowerCase();
    })
    .join(' ');
}
