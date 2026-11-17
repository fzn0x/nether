// The day a daily note stands for, read back from its path by the vault's
// daily notes settings: its folder and the moment.js format of its name, as
// `YYYY-MM-DD` or `YYYY/MM/YYYY-MM-DD`. Plugins are told it beside the note
// they draw for, as the calendar is (ADR 0090).
import { formatDate } from "@nether/core";
import { createContext } from "react";
import { type PeriodicSettings, cleanFolder } from "./templates.ts";

const tokenPattern =
  /\[([^\]]*)\]|YYYY|YY|Q|MMMM|MMM|MM|M|Do|DDDD|DDD|DD|D|dddd|ddd|dd|d|E|e|GGGG|GG|WW|W|gggg|gg|ww|w|HH|H|hh|h|mm|m|ss|s|SSS|A|a|X|x|ZZ|Z/g;

type Part = "year" | "shortYear" | "month" | "monthName" | "day" | undefined;

/** What each token reads as, and which part of the date it gives, if any. */
function tokenRead(token: string): { readonly pattern: string; readonly part: Part } {
  switch (token) {
    case "YYYY":
      return { pattern: "(\\d{4})", part: "year" };
    case "YY":
      return { pattern: "(\\d{2})", part: "shortYear" };
    case "MM":
      return { pattern: "(\\d{2})", part: "month" };
    case "M":
      return { pattern: "(\\d{1,2})", part: "month" };
    case "MMMM":
    case "MMM":
      return { pattern: "([^/]+?)", part: "monthName" };
    case "DD":
      return { pattern: "(\\d{2})", part: "day" };
    case "D":
      return { pattern: "(\\d{1,2})", part: "day" };
    case "Do":
      return { pattern: "(\\d{1,2})(?:st|nd|rd|th)", part: "day" };
    default:
      // A weekday's name, a week or a time: checked by writing the date again.
      return { pattern: "[^/]+?", part: undefined };
  }
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** The day a name written by `format` is for, as `2026-11-17`; none when it is not one. */
export function dayOfName(name: string, format: string): string | undefined {
  const parts: Part[] = [];
  let pattern = "";
  let last = 0;
  for (const match of format.matchAll(tokenPattern)) {
    pattern += escaped(format.slice(last, match.index));
    if (match[1] !== undefined) {
      pattern += escaped(match[1]);
    } else {
      const read = tokenRead(match[0]);
      pattern += read.pattern;
      if (read.part !== undefined) parts.push(read.part);
    }
    last = match.index + match[0].length;
  }
  pattern += escaped(format.slice(last));
  const found = new RegExp(`^${pattern}$`, "i").exec(name);
  if (found === null) return undefined;
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  parts.forEach((part, at) => {
    const text = found[at + 1] ?? "";
    if (part === "year") year = Number(text);
    else if (part === "shortYear") year = 2000 + Number(text);
    else if (part === "month") month = Number(text);
    else if (part === "day") day = Number(text);
    else if (part === "monthName") {
      const index = Array.from({ length: 12 }, (_unused, each) => each).find((each) =>
        ["MMMM", "MMM"].some(
          (token) =>
            formatDate(new Date(2000, each, 1), token).toLowerCase() === text.toLowerCase(),
        ),
      );
      if (index !== undefined) month = index + 1;
    }
  });
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const date = new Date(year, month - 1, day);
  // Written again, it must be the name, so a weekday or week in it agrees.
  if (formatDate(date, format).toLowerCase() !== name.toLowerCase()) return undefined;
  return formatDate(date, "YYYY-MM-DD");
}

/** The day a note is for, when it is a daily note by the vault's settings; none otherwise. */
export function dayOfNote(path: string, settings: PeriodicSettings): string | undefined {
  if (!path.toLowerCase().endsWith(".md")) return undefined;
  const folder = cleanFolder(settings.folder);
  const inFolder =
    folder === ""
      ? path
      : path.toLowerCase().startsWith(`${folder.toLowerCase()}/`)
        ? path.slice(folder.length + 1)
        : undefined;
  if (inFolder === undefined) return undefined;
  return dayOfName(inFolder.slice(0, -".md".length), settings.format);
}

/** The day a note's path is for, as the vault open reads its daily notes; none outside a vault. */
export const NoteDayContext = createContext<(path: string) => string | undefined>(() => undefined);
