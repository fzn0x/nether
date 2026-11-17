// How well what was typed matches a title, an alias or a path, as the
// quick switcher, the link menu and the palette rank them. Kept apart from
// the note's links, which reach the editor's views, so the search the perf
// bench runs in Node.js can use it.

/**
 * How well `text` matches what was typed, case aside: whole, at its start,
 * at a word's start, anywhere, or as letters in order; 0 for not at all.
 */
export function matchScore(query: string, text: string): number {
  return lowerMatchScore(query.trim().toLowerCase(), text.toLowerCase());
}

/** Where a word starts: after a space, a slash, an underscore or a dash. */
const wordBreak = /[\s/_-]/;

/** As `matchScore`, for what was typed trimmed and lower case, and text lower case, as a search over every note keeps them. */
export function lowerMatchScore(typed: string, target: string): number {
  if (typed === "") return 1;
  let at = target.indexOf(typed);
  if (at !== -1) {
    if (at === 0) return target.length === typed.length ? 100 : 80;
    for (; at !== -1; at = target.indexOf(typed, at + 1)) {
      if (wordBreak.test(target.charAt(at - 1))) return 60;
    }
    return 40;
  }
  at = 0;
  for (const char of typed) {
    at = target.indexOf(char, at);
    if (at === -1) return 0;
    at += 1;
  }
  return 20;
}
