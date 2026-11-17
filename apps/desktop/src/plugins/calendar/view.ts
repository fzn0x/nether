// What the calendar plugin shows (ADR 0090): a `calendar` code block's
// days as HTML, which the page shows cleaned, and the Events panel beside
// a note, drawn in the plugin's worker. Its words are its own, in English
// for now, as the app's are.
import { type Calendar } from "./feeds.ts";
import {
  type CalendarEvent,
  addDays,
  clock,
  dayBounds,
  eventsOn,
  isDay,
  localDay,
  timeOf,
} from "./events.ts";

export const words = {
  allDay: "All day",
  nothing: "Nothing on this day.",
  noCalendars: "No calendars yet. Add an ICS feed in Settings, Connections.",
  addCalendar: "Add a calendar",
  refresh: "Refresh",
  refreshing: "Reading the calendars\u2026",
  addToNote: "Add to the note",
  added: "Added the day's events to the note.",
  updated: "Updated at {time}",
  failed: "{name} could not be read: {reason}",
  notRead: "{name} has not been read yet.",
  badDay: "day is not a date, as 2026-11-17, or today.",
  badDays: "days is not a number from 1 to 31.",
  badKey: "{key} is not one of day, days and calendars.",
  noSuchCalendar: "No calendar is named {name}.",
} as const;

/** A message with its `{name}`s filled in. */
export function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** What a `calendar` block asks for. */
export interface BlockAsk {
  /** Its first day; none for the note's, or today. */
  readonly day?: string;
  readonly days: number;
  /** The calendars it shows, by name, lowercase; none for every one. */
  readonly calendars: readonly string[];
}

/** Reads a block's `key: value` lines, or says what is wrong with them. */
export function readBlock(source: string, today: string): BlockAsk | { readonly error: string } {
  let day: string | undefined;
  let days = 1;
  let calendars: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf(":");
    const key = (at < 0 ? trimmed : trimmed.slice(0, at)).trim().toLowerCase();
    const value = at < 0 ? "" : trimmed.slice(at + 1).trim();
    if (key === "day") {
      const asked = value.toLowerCase() === "today" ? today : value.replace(/^["']|["']$/g, "");
      if (!isDay(asked)) return { error: words.badDay };
      day = asked;
    } else if (key === "days") {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1 || count > 31) return { error: words.badDays };
      days = count;
    } else if (key === "calendars") {
      calendars = value
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== "");
    } else {
      return { error: fill(words.badKey, { key }) };
    }
  }
  return { ...(day === undefined ? {} : { day }), days, calendars };
}

/** The calendars a block asks for, or the name of one there is none of. */
export function chosen(
  all: readonly Calendar[],
  names: readonly string[],
): { readonly calendars: readonly Calendar[] } | { readonly missing: string } {
  if (names.length === 0) return { calendars: all };
  const missing = names.find(
    (name) => !all.some((each) => each.connection.name.toLowerCase() === name),
  );
  if (missing !== undefined) return { missing };
  return {
    calendars: all.filter((each) => names.includes(each.connection.name.toLowerCase())),
  };
}

/** An event with the calendar it is from. */
export interface Shown extends CalendarEvent {
  readonly calendar: string;
}

/** The events of some calendars on a day, in order. */
export function shownOn(calendars: readonly Calendar[], day: string): Shown[] {
  const all = calendars.flatMap(({ connection, feed }) =>
    (feed?.events ?? []).map((event) => ({ ...event, calendar: connection.name })),
  );
  return eventsOn(all, day) as Shown[];
}

/** A day as the app's language names it, as `Tuesday, 17 November 2026`. */
export function dayName(day: string, language: string): string {
  const format = (tag: string) =>
    new Intl.DateTimeFormat(tag, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(dayBounds(day).start);
  try {
    return format(language);
  } catch {
    return format("en");
  }
}

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Lines saying which calendars could not be read, and when the others were. */
export function statusLines(calendars: readonly Calendar[]): string[] {
  const lines: string[] = [];
  for (const { connection, feed } of calendars) {
    if (feed?.failed !== undefined) {
      lines.push(fill(words.failed, { name: connection.name, reason: feed.failed }));
    } else if (feed === undefined || feed.read === 0) {
      lines.push(fill(words.notRead, { name: connection.name }));
    }
  }
  const read = calendars.flatMap(({ feed }) =>
    feed !== undefined && feed.read > 0 ? [feed.read] : [],
  );
  if (read.length > 0) {
    lines.push(fill(words.updated, { time: clock(new Date(Math.min(...read)).toISOString()) }));
  }
  return lines;
}

/** A block's days as HTML, plain enough for the page's cleaning to keep. */
export function blockHtml(
  calendars: readonly Calendar[],
  first: string,
  days: number,
  language: string,
): string {
  if (calendars.length === 0) return `<p>${escape(words.noCalendars)}</p>`;
  const parts: string[] = [];
  for (let at = 0; at < days; at++) {
    const day = addDays(first, at);
    const events = shownOn(calendars, day);
    parts.push(`<p><strong>${escape(dayName(day, language))}</strong></p>`);
    parts.push(
      events.length === 0
        ? `<p>${escape(words.nothing)}</p>`
        : `<ul>${events.map((event) => `<li>${eventHtml(event, calendars.length > 1)}</li>`).join("")}</ul>`,
    );
  }
  for (const line of statusLines(calendars)) parts.push(`<p><small>${escape(line)}</small></p>`);
  return parts.join("");
}

function eventHtml(event: Shown, named: boolean): string {
  const where = event.location === undefined ? "" : ` <small>${escape(event.location)}</small>`;
  const from = named ? ` <small>${escape(event.calendar)}</small>` : "";
  return `<span>${escape(timeOf(event, words.allDay))}</span> ${escape(event.title)}${where}${from}`;
}

/** The day a block or panel shows first: its own, the daily note's, or today. */
export function firstDay(
  asked: string | undefined,
  noteDay: string | undefined,
  now: Date,
): string {
  return asked ?? noteDay ?? localDay(now);
}
