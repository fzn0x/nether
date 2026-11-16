// Highlight colors, as PDF++ writes them in a link's `&color=` (ADR 0062):
// a name of its palette, whatever its case, or `r,g,b`. Nether offers
// PDF++'s four default names, and writes them in lower case.

/** A color Nether offers: the name it writes, and the color it shows. */
export interface HighlightColor {
  readonly name: string;
  readonly value: string;
}

/** PDF++'s default palette, in its order; the first is the default, which writes no color. */
export const highlightColors: readonly HighlightColor[] = [
  { name: "yellow", value: "#ffd000" },
  { name: "red", value: "#ea5252" },
  { name: "note", value: "#086ddd" },
  { name: "important", value: "#bb61e5" },
];

/** The color a highlight with no color, or one Nether cannot show, is in. */
export const defaultColor = "yellow";

const rgb = /^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/;

/**
 * The CSS color a link's color shows in: PDF++'s default names, three
 * numbers `r,g,b`, or a name `isCssColor` knows; undefined for the default.
 */
export function colorValue(
  color: string | undefined,
  isCssColor: (name: string) => boolean = () => false,
): string | undefined {
  if (color === undefined) return undefined;
  const name = color.trim().toLowerCase();
  const known = highlightColors.find((each) => each.name === name);
  if (known !== undefined) return known.value;
  const numbers = rgb.exec(name);
  if (numbers !== null) {
    const [r, g, b] = numbers.slice(1).map(Number);
    if ([r, g, b].every((part) => part !== undefined && part <= 255)) {
      return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
    }
    return undefined;
  }
  // Only a plain name: nothing a style could read more into.
  return /^[a-z]{3,20}$/.test(name) && isCssColor(name) ? name : undefined;
}

/** The name of one of the colors Nether offers that a link's color is, whatever its case. */
export function offeredColor(color: string | undefined): string | undefined {
  const name = color?.trim().toLowerCase() ?? defaultColor;
  return highlightColors.some((each) => each.name === name) ? name : undefined;
}
