// The calendar plugin (ADR 0090): feeds read as Google, Outlook and Apple
// export them, recurrences expanded with their exceptions, time zones
// defined and not, and what a block and the panel show, read again only
// when stale.
import type { Connection, HttpRequest, HttpResponse, Json } from "@nether/plugin-api";
import { afterAll, describe, expect, it } from "vitest";
import {
  type CalendarEvent,
  addDays,
  dayBounds,
  eventLines,
  eventsOn,
  isDay,
  localDay,
  readEvents,
  spanOf,
  timeOf,
  windowAround,
} from "../src/plugins/calendar/events.ts";
import {
  type Reach,
  calendars,
  isStale,
  keptCalendars,
  readKept,
  refresh,
} from "../src/plugins/calendar/feeds.ts";
import { periodOf } from "../src/plugins/calendar/main.ts";
import {
  blockHtml,
  chosen,
  dayName,
  fill,
  firstDay,
  readBlock,
  shownOn,
  statusLines,
  words,
} from "../src/plugins/calendar/view.ts";

// The device's clock is Berlin's here, so local days and times are known,
// from before the first date this file makes.
const { env } = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process;
const zoneBefore = env.TZ;
env.TZ = "Europe/Berlin";
afterAll(() => {
  // Undefined would be kept as the text "undefined".
  if (zoneBefore === undefined) delete env.TZ;
  else env.TZ = zoneBefore;
});

const crlf = (lines: readonly string[]) => `${lines.join("\r\n")}\r\n`;

/** New York's zone as Google writes it into a feed. */
const newYork = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const feed = crlf([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  ...newYork,
  // A meeting in New York's time, whose zone the feed defines.
  "BEGIN:VEVENT",
  "UID:call@example.org",
  "DTSTART;TZID=America/New_York:20261117T090000",
  "DTEND;TZID=America/New_York:20261117T093000",
  "SUMMARY:Call with New York",
  "LOCATION:Room 2",
  "END:VEVENT",
  // An all-day event of two days.
  "BEGIN:VEVENT",
  "UID:trip@example.org",
  "DTSTART;VALUE=DATE:20261117",
  "DTEND;VALUE=DATE:20261119",
  "SUMMARY:Trip",
  "END:VEVENT",
  // A daily standup, in UTC, with one day left out and one moved.
  "BEGIN:VEVENT",
  "UID:standup@example.org",
  "DTSTART:20261116T080000Z",
  "DTEND:20261116T081500Z",
  "RRULE:FREQ=DAILY;COUNT=5",
  "EXDATE:20261118T080000Z",
  "SUMMARY:Standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup@example.org",
  "RECURRENCE-ID:20261119T080000Z",
  "DTSTART:20261119T100000Z",
  "DTEND:20261119T101500Z",
  "SUMMARY:Standup, later",
  "END:VEVENT",
  // A cancelled event, and one with no title.
  "BEGIN:VEVENT",
  "UID:gone@example.org",
  "DTSTART:20261117T120000Z",
  "DTEND:20261117T130000Z",
  "STATUS:CANCELLED",
  "SUMMARY:Lunch",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:blank@example.org",
  "DTSTART:20261117T150000Z",
  "SUMMARY: ",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** Outlook's export, naming an IANA zone it does not define, and a floating time. */
const outlook = crlf([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:tokyo@example.org",
  "DTSTART;TZID=Asia/Tokyo:20261117T180000",
  "DTEND;TZID=Asia/Tokyo:20261117T190000",
  "SUMMARY:Tokyo",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:floating@example.org",
  "DTSTART;TZID=Somewhere/Else:20261117T110000",
  "DTEND;TZID=Somewhere/Else:20261117T113000",
  "SUMMARY:Somewhere",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:orphan@example.org",
  "RECURRENCE-ID:20261117T070000Z",
  "DTSTART:20261117T070000Z",
  "DTEND:20261117T073000Z",
  "SUMMARY:A moved one, its series gone",
  "END:VEVENT",
  "END:VCALENDAR",
]);

const from = new Date(2026, 9, 17);
const to = new Date(2027, 10, 18);

describe("readEvents", () => {
  it("reads a feed's events in their zones, recurrences expanded with their exceptions", () => {
    const events = readEvents(feed, from, to);
    expect(events.map((event) => [event.title, event.start, event.end])).toEqual([
      ["Standup", "2026-11-16T08:00:00.000Z", "2026-11-16T08:15:00.000Z"],
      ["Trip", "2026-11-17", "2026-11-19"],
      ["Standup", "2026-11-17T08:00:00.000Z", "2026-11-17T08:15:00.000Z"],
      // 09:00 in New York, in November, is 14:00 UTC.
      ["Call with New York", "2026-11-17T14:00:00.000Z", "2026-11-17T14:30:00.000Z"],
      ["(no title)", "2026-11-17T15:00:00.000Z", "2026-11-17T15:00:00.000Z"],
      ["Standup, later", "2026-11-19T10:00:00.000Z", "2026-11-19T10:15:00.000Z"],
      ["Standup", "2026-11-20T08:00:00.000Z", "2026-11-20T08:15:00.000Z"],
    ]);
    expect(events.find((event) => event.title === "Call with New York")?.location).toBe("Room 2");
    expect(events.find((event) => event.title === "Trip")?.allDay).toBe(true);
  });

  it("reads an IANA zone the feed does not define, and a zone no one knows as floating", () => {
    const events = readEvents(outlook, from, to);
    expect(events.map((event) => [event.title, event.start])).toEqual([
      ["A moved one, its series gone", "2026-11-17T07:00:00.000Z"],
      // 18:00 in Tokyo is 09:00 UTC.
      ["Tokyo", "2026-11-17T09:00:00.000Z"],
      // 11:00 where the device is, in Berlin, is 10:00 UTC in November.
      ["Somewhere", "2026-11-17T10:00:00.000Z"],
    ]);
  });

  it("keeps only what falls in the window, and refuses what is no calendar", () => {
    const after = readEvents(feed, new Date(2026, 10, 20), to);
    expect(after.map((event) => event.title)).toEqual(["Standup"]);
    expect(() => readEvents("BEGIN:VCARD\r\nEND:VCARD\r\n", from, to)).toThrow(
      "The feed is not a calendar.",
    );
  });

  it("stops a rule that repeats without end at the window", () => {
    const daily = crlf([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:forever@example.org",
      "DTSTART;VALUE=DATE:20200101",
      "RRULE:FREQ=DAILY",
      "SUMMARY:Water the plants",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    const events = readEvents(daily, new Date(2026, 10, 1), new Date(2026, 10, 11));
    expect(events.map((event) => event.start)).toEqual(
      Array.from({ length: 10 }, (_unused, at) => `2026-11-${String(at + 1).padStart(2, "0")}`),
    );
  });
});

describe("days", () => {
  it("knows a day, its bounds, the next ones, and the window around one", () => {
    expect(isDay("2026-11-17")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("17.11.2026")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dayBounds("2026-11-17").start.toISOString()).toBe("2026-11-16T23:00:00.000Z");
    expect(localDay(new Date("2026-11-17T23:30:00Z"))).toBe("2026-11-18");
    const { from: start, to: end } = windowAround(new Date(2026, 10, 17, 15));
    expect([localDay(start), localDay(end)]).toEqual(["2026-10-17", "2027-11-18"]);
  });

  it("gives a day's events in order, all-day first, and writes them as a list", () => {
    const events = readEvents(feed, from, to);
    const day = eventsOn(events, "2026-11-17");
    expect(day.map((event) => event.title)).toEqual([
      "Trip",
      "Standup",
      "Call with New York",
      "(no title)",
    ]);
    const [trip, standup] = day;
    if (trip === undefined || standup === undefined) throw new Error("No events.");
    expect(timeOf(standup, "All day")).toBe("09:00-09:15");
    expect(eventLines(day, "All day")).toBe(
      [
        "- All day: Trip",
        "- 09:00-09:15 Standup",
        "- 15:00-15:30 Call with New York (Room 2)",
        "- 16:00-16:00 (no title)",
      ].join("\n"),
    );
    // The trip's second day, and not the day it ends.
    expect(eventsOn(events, "2026-11-18").map((event) => event.title)).toEqual(["Trip"]);
    expect(spanOf(trip).end).toBe(dayBounds("2026-11-19").start.getTime());
  });

  it("writes what Markdown would read as its own as text", () => {
    const odd: CalendarEvent = {
      title: "Plan *all* [the] things",
      allDay: true,
      start: "2026-11-17",
      end: "2026-11-18",
      location: "Room <2>",
    };
    expect(eventLines([odd], "All day")).toBe(
      "- All day: Plan \\*all\\* \\[the\\] things (Room \\<2\\>)",
    );
  });
});

/** A connection to a feed, as the app lists one. */
const work: Connection = {
  id: "c1",
  service: "ics",
  name: "Work",
  address: "calendar.example.org",
  where: "device",
};

/** What the plugin reaches, standing in for the app: its connections, requests and store. */
function fakeReach(answers: ((request: HttpRequest) => HttpResponse | Promise<HttpResponse>)[]) {
  const kept = new Map<string, Json>();
  const sent: HttpRequest[] = [];
  let connections: Connection[] = [work];
  const reach: Reach = {
    connections: {
      list: () => Promise.resolve(connections),
      add: () => Promise.resolve(),
      onChange: () => Promise.resolve({ dispose: () => Promise.resolve() }),
    },
    http: {
      async fetch(request) {
        sent.push(request);
        const answer = answers.shift();
        if (answer === undefined) throw new Error("calendar.example.org could not be reached.");
        return answer(request);
      },
    },
    store: {
      get: (key) => Promise.resolve(kept.get(key)),
      set(key, value) {
        kept.set(key, value);
        return Promise.resolve();
      },
      delete(key) {
        kept.delete(key);
        return Promise.resolve();
      },
      keys: () => Promise.resolve([...kept.keys()]),
    },
  };
  return {
    reach,
    sent,
    kept,
    set connections(next: Connection[]) {
      connections = next;
    },
  };
}

const now = new Date(2026, 10, 17, 8).getTime();

describe("feeds", () => {
  it("reads a feed, keeps it with its tags, and asks again as it was last read", async () => {
    const fake = fakeReach([
      () => ({ status: 200, headers: { etag: '"1"', "last-modified": "Tue" }, text: feed }),
      () => ({ status: 304, headers: {} }),
    ]);
    const first = await refresh(fake.reach, work, now);
    expect(first.events.length).toBeGreaterThan(5);
    expect([first.etag, first.modified, first.failed]).toEqual(['"1"', "Tue", undefined]);
    const second = await refresh(fake.reach, work, now + 60_000);
    expect(second.read).toBe(now + 60_000);
    expect(second.events).toEqual(first.events);
    expect(fake.sent.map((request) => request.headers)).toEqual([
      {},
      { "if-none-match": '"1"', "if-modified-since": "Tue" },
    ]);
  });

  it("keeps what it had, and says why, when a refresh fails", async () => {
    const fake = fakeReach([
      () => ({ status: 200, headers: {}, text: feed }),
      () => ({ status: 500, headers: {} }),
    ]);
    const first = await refresh(fake.reach, work, now);
    const failed = await refresh(fake.reach, work, now + 1);
    expect(failed.failed).toBe("The feed answered 500.");
    expect(failed.events).toEqual(first.events);
    expect(failed.read).toBe(now);
    const never = await refresh(fakeReach([]).reach, work, now);
    expect(never).toEqual({
      read: 0,
      from: 0,
      to: 0,
      events: [],
      failed: "calendar.example.org could not be reached.",
    });
    const odd = await refresh(
      fakeReach([() => ({ status: 200, headers: {}, text: "<html>" })]).reach,
      work,
      now,
    );
    expect(odd.failed).toBeDefined();
  });

  it("reads a feed again only when stale, or its window moved, or when asked", async () => {
    const fake = fakeReach([
      () => ({ status: 200, headers: {}, text: feed }),
      () => ({ status: 200, headers: {}, text: feed }),
      () => ({ status: 200, headers: {}, text: feed }),
    ]);
    const kept = await refresh(fake.reach, work, now);
    expect(isStale(kept, 15, now + 14 * 60_000)).toBe(false);
    expect(isStale(kept, 15, now + 15 * 60_000)).toBe(true);
    expect(isStale(kept, 1440, now + 2 * 86_400_000)).toBe(true);
    expect(isStale(undefined, 15, now)).toBe(true);
    await calendars(fake.reach, { minutes: 15, now: now + 60_000 });
    expect(fake.sent).toHaveLength(1);
    await calendars(fake.reach, { minutes: 15, now: now + 60_000, force: true });
    expect(fake.sent).toHaveLength(2);
    // Another service's connection is not the calendar's.
    fake.connections = [work, { ...work, id: "c2", service: "github" }];
    expect((await keptCalendars(fake.reach)).map((each) => each.connection.id)).toEqual(["c1"]);
  });

  it("reads back only what it kept", () => {
    expect(readKept(undefined)).toBeUndefined();
    expect(readKept([1])).toBeUndefined();
    expect(readKept({ read: 1, from: 0, to: 0 })).toBeUndefined();
    expect(
      readKept({
        read: 1,
        from: 0,
        to: 2,
        events: [{ title: "A", allDay: true, start: "2026-11-17", end: "2026-11-18" }, { x: 1 }],
      })?.events,
    ).toHaveLength(1);
  });
});

describe("what the calendar shows", () => {
  it("reads a block's keys, and says what is wrong with them", () => {
    expect(readBlock("", "2026-11-17")).toEqual({ days: 1, calendars: [] });
    expect(readBlock("day: today\ndays: 3\ncalendars: Work, Home\n# a note", "2026-11-17")).toEqual(
      { day: "2026-11-17", days: 3, calendars: ["work", "home"] },
    );
    expect(readBlock('day: "2026-11-20"', "2026-11-17")).toMatchObject({ day: "2026-11-20" });
    expect(readBlock("day: soon", "2026-11-17")).toEqual({ error: words.badDay });
    expect(readBlock("days: 40", "2026-11-17")).toEqual({ error: words.badDays });
    expect(readBlock("color: red", "2026-11-17")).toEqual({
      error: "color is not one of day, days and calendars.",
    });
  });

  it("chooses calendars by name, and names one there is none of", async () => {
    const fake = fakeReach([() => ({ status: 200, headers: {}, text: feed })]);
    const all = await calendars(fake.reach, { minutes: 15, now });
    expect(chosen(all, [])).toEqual({ calendars: all });
    expect(chosen(all, ["work"])).toEqual({ calendars: all });
    expect(chosen(all, ["home"])).toEqual({ missing: "home" });
  });

  it("draws a block's days as plain HTML, with when the calendars were read", async () => {
    const fake = fakeReach([() => ({ status: 200, headers: {}, text: feed })]);
    const all = await calendars(fake.reach, { minutes: 15, now });
    const html = blockHtml(all, "2026-11-17", 2, "en");
    expect(html).toContain("<strong>Tuesday, November 17, 2026</strong>");
    expect(html).toContain("<span>15:00-15:30</span> Call with New York <small>Room 2</small>");
    expect(html).toContain("<span>All day</span> Trip");
    expect(html).toContain("<strong>Wednesday, November 18, 2026</strong>");
    expect(html).toContain("<small>Updated at 08:00</small>");
    expect(blockHtml([], "2026-11-17", 1, "en")).toBe(`<p>${words.noCalendars}</p>`);
    const quiet = blockHtml(all, "2027-03-01", 1, "en");
    expect(quiet).toContain(words.nothing);
    const named = blockHtml(
      [...all, { ...all[0], connection: { ...work, name: "Home" } }] as never,
      "2026-11-17",
      1,
      "en",
    );
    expect(named).toContain("<small>Home</small>");
    expect(blockHtml(all, "2026-11-17", 1, "en")).not.toContain("<script");
  });

  it("escapes what a feed writes, so nothing of it is markup", () => {
    const sneaky = [
      {
        connection: work,
        feed: {
          read: now,
          from: 0,
          to: 0,
          events: [
            {
              title: '<img src=x onerror="steal()">',
              allDay: true,
              start: "2026-11-17",
              end: "2026-11-18",
            },
          ],
        },
      },
    ];
    expect(blockHtml(sneaky, "2026-11-17", 1, "en")).toContain(
      "&lt;img src=x onerror=&quot;steal()&quot;&gt;",
    );
  });

  it("says which calendars could not be read, and names days in the app's language", () => {
    expect(
      statusLines([
        { connection: work, feed: undefined },
        {
          connection: { ...work, name: "Home" },
          feed: { read: 0, from: 0, to: 0, events: [], failed: "Gone." },
        },
      ]),
    ).toEqual(["Work has not been read yet.", "Home could not be read: Gone."]);
    expect(dayName("2026-11-17", "fr")).toBe("mardi 17 novembre 2026");
    expect(dayName("2026-11-17", "not a language!")).toBe("Tuesday, November 17, 2026");
    expect(fill("{a} and {b}", { a: "1" })).toBe("1 and {b}");
    expect(firstDay(undefined, "2026-11-20", new Date(now))).toBe("2026-11-20");
    expect(firstDay("2026-11-21", "2026-11-20", new Date(now))).toBe("2026-11-21");
    expect(firstDay(undefined, undefined, new Date(now))).toBe("2026-11-17");
    expect(shownOn([], "2026-11-17")).toEqual([]);
  });

  it("reads its period from its settings, within its bounds", () => {
    expect([periodOf(30), periodOf(1), periodOf(5000), periodOf("x"), periodOf(7.6)]).toEqual([
      30, 5, 1440, 15, 8,
    ]);
  });
});
