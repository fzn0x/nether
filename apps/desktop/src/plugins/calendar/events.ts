// A calendar's events as the calendar plugin keeps and shows them (ADR
// 0090): read from an ICS feed by ical.js, which takes each feed's time
// zones from its VTIMEZONEs and expands recurrences with their exceptions,
// within a window from a month back to a year ahead. A TZID the feed does
// not define is read as an IANA zone when it is one, and as a floating
// time otherwise. Cancelled events are left out. Times are the device's.
import ICAL from "ical.js";

/** An event of one day or more, or a span of time, as the plugin keeps it. */
export interface CalendarEvent {
  readonly title: string;
  /** Whether it is all day: its start and end are then dates, its end not in it. */
  readonly allDay: boolean;
  /** A date as `2026-11-17`, all day; else an instant as an ISO string. */
  readonly start: string;
  readonly end: string;
  readonly location?: string;
}

/** The days a calendar is kept for around today. */
export const daysBack = 31;
export const daysAhead = 366;

/** The most occurrences one event gives, however its rule repeats. */
const occurrenceLimit = 2000;
/** The most steps through one event's rule, past occurrences included. */
const stepLimit = 50_000;

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** A day of the device's calendar, as `2026-11-17`. */
export function localDay(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether text is a day, as `2026-11-17`, that the calendar has. */
export function isDay(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return false;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDay(date) === text;
}

/** Local midnight at the start of a day, and of the day after. */
export function dayBounds(day: string): { readonly start: Date; readonly end: Date } {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return { start: new Date(year, month - 1, date), end: new Date(year, month - 1, date + 1) };
}

/** The day a number of days after another. */
export function addDays(day: string, days: number): string {
  const { start } = dayBounds(day);
  return localDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + days));
}

/** The window of days a calendar is kept for, around `now`. */
export function windowAround(now: Date): { readonly from: Date; readonly to: Date } {
  const today = dayBounds(localDay(now)).start;
  return {
    from: new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBack),
    to: new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysAhead),
  };
}

/** How far a zone is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/** Whether the device knows a zone by its IANA name. */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The instant a wall-clock time in a zone is, as that zone's offset then says. */
export function zonedInstant(time: ICAL.Time, zone: string): number {
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const first = wall - offsetAt(wall, zone);
  // Again at the guess, which may sit across a change of the zone's offset.
  return wall - offsetAt(first, zone);
}

/** An event's time as an instant: in its zone, the IANA zone it names, or the device's. */
function instantOf(time: ICAL.Time, tzid: string | undefined): number {
  if (time.zone !== ICAL.Timezone.localTimezone) return time.toJSDate().getTime();
  if (tzid !== undefined && knownZone(tzid)) return zonedInstant(time, tzid);
  return new Date(
    time.year,
    time.month - 1,
    time.day,
    time.hour,
    time.minute,
    time.second,
  ).getTime();
}

/** The TZID a property names, when it names one. */
function tzidOf(component: ICAL.Component, name: string): string | undefined {
  const value = component.getFirstProperty(name)?.getParameter("tzid");
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A date of an all-day event, as `2026-11-17`. */
function dateOf(time: ICAL.Time): string {
  return `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}`;
}

/** An occurrence as the plugin keeps it; none for one cancelled. */
function eventOf(item: ICAL.Event, start: ICAL.Time, end: ICAL.Time): CalendarEvent | undefined {
  const status = item.component.getFirstPropertyValue("status");
  if (typeof status === "string" && status.toUpperCase() === "CANCELLED") return undefined;
  // Read from the component: ical.js gives null for one that is not there, whatever its types say.
  const text = (name: string): string => {
    const value: unknown = item.component.getFirstPropertyValue(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const summary = text("summary");
  const title = summary === "" ? "(no title)" : summary;
  const location = text("location");
  const allDay = start.isDate;
  let from: string;
  let to: string;
  if (allDay) {
    from = dateOf(start);
    // An all-day event with no end, or one that ends where it starts, is that day.
    const last = end.isDate ? dateOf(end) : from;
    to = last > from ? last : addDays(from, 1);
  } else {
    const startAt = instantOf(start, tzidOf(item.component, "dtstart"));
    const endAt = Math.max(
      startAt,
      instantOf(end, tzidOf(item.component, "dtend") ?? tzidOf(item.component, "dtstart")),
    );
    from = new Date(startAt).toISOString();
    to = new Date(endAt).toISOString();
  }
  return { title, allDay, start: from, end: to, ...(location === "" ? {} : { location }) };
}

/** When an event starts and ends, in milliseconds, for windows and order. */
export function spanOf(event: CalendarEvent): { readonly start: number; readonly end: number } {
  if (!event.allDay) return { start: Date.parse(event.start), end: Date.parse(event.end) };
  return {
    start: dayBounds(event.start).start.getTime(),
    end: dayBounds(event.end).start.getTime(),
  };
}

/** Whether an event overlaps the time from `from` to `to`. */
function overlaps(event: CalendarEvent, from: number, to: number): boolean {
  const span = spanOf(event);
  // An event of no length shows at its start.
  return span.start < to && (span.end > from || (span.end === span.start && span.start >= from));
}

/** Reads a feed's events within a window, recurrences expanded; throws when the text is no calendar. */
export function readEvents(text: string, from: Date, to: Date): CalendarEvent[] {
  const root = new ICAL.Component(ICAL.parse(text) as unknown[]);
  if (root.name !== "vcalendar") throw new Error("The feed is not a calendar.");
  const components = root.getAllSubcomponents("vevent");
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Component[] = [];
  const singles: ICAL.Event[] = [];
  for (const component of components) {
    if (component.hasProperty("recurrence-id")) {
      exceptions.push(component);
      continue;
    }
    const event = new ICAL.Event(component);
    if (event.isRecurring()) masters.set(event.uid, event);
    else singles.push(event);
  }
  for (const exception of exceptions) {
    const master = masters.get(String(exception.getFirstPropertyValue("uid") ?? ""));
    // An exception whose series is not in the feed is an event of its own.
    if (master === undefined) singles.push(new ICAL.Event(exception));
    else master.relateException(exception);
  }
  const fromAt = from.getTime();
  const toAt = to.getTime();
  const events: CalendarEvent[] = [];
  const keep = (event: CalendarEvent | undefined) => {
    if (event !== undefined && overlaps(event, fromAt, toAt)) events.push(event);
  };
  for (const single of singles) keep(eventOf(single, single.startDate, single.endDate));
  for (const master of masters.values()) {
    const expansion = master.iterator();
    let given = 0;
    for (let step = 0; step < stepLimit && given < occurrenceLimit; step++) {
      // Its types say a time, but the expansion gives none once the rule ends.
      const next = expansion.next() as ICAL.Time | undefined;
      if (next === undefined) break;
      const details = master.getOccurrenceDetails(next);
      const event = eventOf(details.item, details.startDate, details.endDate);
      if (event === undefined) continue;
      const span = spanOf(event);
      if (span.start >= toAt) break;
      if (overlaps(event, fromAt, toAt)) {
        events.push(event);
        given++;
      }
    }
  }
  return events.sort(byStart);
}

/** Earlier first; all-day events before the timed ones of the same start. */
function byStart(a: CalendarEvent, b: CalendarEvent): number {
  const first = spanOf(a).start - spanOf(b).start;
  if (first !== 0) return first;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return a.title.localeCompare(b.title);
}

/** The events on a day of the device's calendar, in order. */
export function eventsOn(events: readonly CalendarEvent[], day: string): CalendarEvent[] {
  const { start, end } = dayBounds(day);
  return events.filter((event) => overlaps(event, start.getTime(), end.getTime())).sort(byStart);
}

/** A time as the device's clock shows it, `09:30`. */
export function clock(instant: string): string {
  const date = new Date(instant);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** An event's time on a day: all day, or its start and end, as `09:00-09:30`. */
export function timeOf(event: CalendarEvent, allDay: string): string {
  return event.allDay ? allDay : `${clock(event.start)}-${clock(event.end)}`;
}

/** Characters a list item's text would read as Markdown. */
function plain(text: string): string {
  return text.replace(/\s+/g, " ").replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

/** The day's events as a Markdown list any app reads: `- 09:00-09:30 Standup (Room 2)`. */
export function eventLines(events: readonly CalendarEvent[], allDay: string): string {
  return events
    .map((event) => {
      const where = event.location === undefined ? "" : ` (${plain(event.location)})`;
      const when = event.allDay ? `${allDay}:` : timeOf(event, allDay);
      return `- ${when} ${plain(event.title)}${where}`;
    })
    .join("\n");
}
