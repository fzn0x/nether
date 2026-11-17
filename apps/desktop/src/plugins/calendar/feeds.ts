// The calendars the calendar plugin reads (ADR 0090): each of the person's
// ICS feeds, kept in the plugin's store on this device with when it was
// read, and read again when what shows it finds it older than the
// plugin's period. A feed is asked with If-None-Match and
// If-Modified-Since, so one that has not changed sends nothing again. A
// day outside the days kept is read when it is shown.
import { type Connection, type Json, type PluginContext, isJsonObject } from "@nether/plugin-api";
import { type CalendarEvent, addDays, dayBounds, readEvents, windowAround } from "./events.ts";

/** A feed as the store keeps it. */
export interface KeptFeed {
  /** When it was last read, in milliseconds. */
  readonly read: number;
  /** The days it was read for. */
  readonly from: number;
  readonly to: number;
  readonly etag?: string;
  readonly modified?: string;
  readonly events: readonly CalendarEvent[];
  /** Why its last refresh failed, if it did. */
  readonly failed?: string;
}

/** A calendar as the plugin shows it: its connection, what was kept of it, and why it could not be read. */
export interface Calendar {
  readonly connection: Connection;
  readonly feed: KeptFeed | undefined;
}

const keyOf = (connection: Connection) => `feed:${connection.id}`;

function isEvent(value: Json): value is CalendarEvent & Json {
  if (!isJsonObject(value)) return false;
  const { title, allDay, start, end, location } = value;
  return (
    typeof title === "string" &&
    typeof allDay === "boolean" &&
    typeof start === "string" &&
    typeof end === "string" &&
    (location === undefined || typeof location === "string")
  );
}

/** A feed as the store gives it; none when what is there does not read. */
export function readKept(value: Json | undefined): KeptFeed | undefined {
  if (value === undefined || !isJsonObject(value)) return undefined;
  const { read, from, to, etag, modified, events, failed } = value;
  if (
    typeof read !== "number" ||
    typeof from !== "number" ||
    typeof to !== "number" ||
    !Array.isArray(events)
  ) {
    return undefined;
  }
  return {
    read,
    from,
    to,
    events: events.filter(isEvent),
    ...(typeof etag === "string" ? { etag } : {}),
    ...(typeof modified === "string" ? { modified } : {}),
    ...(typeof failed === "string" ? { failed } : {}),
  };
}

function keptJson(feed: KeptFeed): Json {
  return {
    read: feed.read,
    from: feed.from,
    to: feed.to,
    events: feed.events.map((event) => ({ ...event })),
    ...(feed.etag === undefined ? {} : { etag: feed.etag }),
    ...(feed.modified === undefined ? {} : { modified: feed.modified }),
    ...(feed.failed === undefined ? {} : { failed: feed.failed }),
  };
}

/** What the plugin reaches to read its calendars. */
export type Reach = Pick<PluginContext, "connections" | "http" | "store">;

/** What a feed kept says: how old it is, against a period in minutes, at `now`. */
export function isStale(feed: KeptFeed | undefined, minutes: number, now: number): boolean {
  if (feed === undefined) return true;
  const { from, to } = windowAround(new Date(now));
  return (
    now - feed.read >= minutes * 60_000 || feed.from > from.getTime() || feed.to < to.getTime()
  );
}

/** Reads a feed again, and keeps what it gives, or why it failed beside what was kept. */
export async function refresh(
  reach: Reach,
  connection: Connection,
  now: number,
): Promise<KeptFeed> {
  const kept = readKept(await reach.store.get(keyOf(connection)));
  const { from, to } = windowAround(new Date(now));
  const sameWindow = kept !== undefined && kept.from <= from.getTime() && kept.to >= to.getTime();
  let next: KeptFeed;
  try {
    const answer = await reach.http.fetch({
      connection: connection.id,
      headers: {
        // Asked as it was last read, unless the window moved and it must be read whole.
        ...(sameWindow && kept.etag !== undefined ? { "if-none-match": kept.etag } : {}),
        ...(sameWindow && kept.modified !== undefined
          ? { "if-modified-since": kept.modified }
          : {}),
      },
    });
    if (answer.status === 304 && kept !== undefined) {
      next = withoutFailure({ ...kept, read: now });
    } else if (answer.status < 200 || answer.status > 299) {
      throw new Error(`The feed answered ${String(answer.status)}.`);
    } else {
      const etag = answer.headers.etag;
      const modified = answer.headers["last-modified"];
      next = {
        read: now,
        from: from.getTime(),
        to: to.getTime(),
        events: readEvents(answer.text ?? "", from, to),
        ...(etag === undefined ? {} : { etag }),
        ...(modified === undefined ? {} : { modified }),
      };
    }
  } catch (error) {
    const failed = error instanceof Error ? error.message : String(error);
    next =
      kept === undefined
        ? { read: 0, from: 0, to: 0, events: [], failed }
        : { ...withoutFailure(kept), failed };
  }
  await reach.store.set(keyOf(connection), keptJson(next));
  return next;
}

function withoutFailure(feed: KeptFeed): KeptFeed {
  return {
    read: feed.read,
    from: feed.from,
    to: feed.to,
    events: feed.events,
    ...(feed.etag === undefined ? {} : { etag: feed.etag }),
    ...(feed.modified === undefined ? {} : { modified: feed.modified }),
  };
}

/** The calendars of the person's feeds, as the store keeps them, read again where stale or asked. */
export async function calendars(
  reach: Reach,
  options: { readonly minutes: number; readonly now: number; readonly force?: boolean },
): Promise<Calendar[]> {
  const connections = (await reach.connections.list()).filter(
    (connection) => connection.service === "ics",
  );
  return Promise.all(
    connections.map(async (connection) => {
      const kept = readKept(await reach.store.get(keyOf(connection)));
      const feed =
        options.force === true || isStale(kept, options.minutes, options.now)
          ? await refresh(reach, connection, options.now)
          : kept;
      return { connection, feed };
    }),
  );
}

/**
 * The calendars for days that may lie outside the window kept: a calendar
 * whose kept days do not hold them is read for those days alone, and what
 * it gives is shown, not kept.
 */
export async function covering(
  reach: Reach,
  all: readonly Calendar[],
  first: string,
  days: number,
): Promise<Calendar[]> {
  const from = dayBounds(first).start;
  const to = dayBounds(addDays(first, days)).start;
  return Promise.all(
    all.map(async (calendar) => {
      const { feed } = calendar;
      if (feed === undefined || (feed.from <= from.getTime() && feed.to >= to.getTime())) {
        return calendar;
      }
      try {
        const answer = await reach.http.fetch({ connection: calendar.connection.id });
        if (answer.status < 200 || answer.status > 299) {
          throw new Error(`The feed answered ${String(answer.status)}.`);
        }
        const events = readEvents(answer.text ?? "", from, to);
        return { ...calendar, feed: { ...withoutFailure(feed), events } };
      } catch (error) {
        const failed = error instanceof Error ? error.message : String(error);
        return { ...calendar, feed: { ...withoutFailure(feed), events: [], failed } };
      }
    }),
  );
}

/** The calendars as kept, read again nowhere: what shows at once, before a refresh. */
export async function keptCalendars(reach: Reach): Promise<Calendar[]> {
  const connections = (await reach.connections.list()).filter(
    (connection) => connection.service === "ics",
  );
  return Promise.all(
    connections.map(async (connection) => ({
      connection,
      feed: readKept(await reach.store.get(keyOf(connection))),
    })),
  );
}
