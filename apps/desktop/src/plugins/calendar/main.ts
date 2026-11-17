// The calendar plugin (ADR 0090): events from the person's ICS feeds,
// shown in a `calendar` code block and in the Events panel beside a note,
// for a daily note's day or today, and added to the note as a Markdown list
// when asked. It is one of Nether's integrations: a built-in plugin that
// runs apart, in the sandbox, written only against the public SDK, and
// reaching its feeds only through the app's connections.
import { type PanelProps, definePlugin } from "@nether/plugin-api";
import { type Calendar, type Reach, calendars, keptCalendars } from "./feeds.ts";
import { eventLines, localDay } from "./events.ts";
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
} from "./view.ts";

/** How often a calendar is read again, in minutes, as the plugin's settings say. */
export function periodOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1440, Math.max(5, Math.round(value)))
    : 15;
}

export default definePlugin({
  async activate(context) {
    const reach: Reach = context;
    const minutes = () => periodOf(context.settings.values().refresh);

    await context.codeBlocks.register("calendar", async (source, block) => {
      const now = new Date();
      const asked = readBlock(source, localDay(now));
      if ("error" in asked) return { error: asked.error };
      const all = await calendars(reach, { minutes: minutes(), now: now.getTime() });
      const picked = chosen(all, asked.calendars);
      if ("missing" in picked)
        return { error: fill(words.noSuchCalendar, { name: picked.missing }) };
      const day = firstDay(asked.day, block.note?.day, now);
      return { html: blockHtml(picked.calendars, day, asked.days, context.language) };
    });

    await context.panels.register("events", {
      mount(element, first) {
        const document = element.ownerDocument;
        let props: PanelProps = first;
        let shown: readonly Calendar[] = [];
        let notice = "";
        let busy = false;
        let gone = false;

        const make = <K extends keyof HTMLElementTagNameMap>(
          tag: K,
          text?: string,
        ): HTMLElementTagNameMap[K] => {
          const made = document.createElement(tag);
          if (text !== undefined) made.textContent = text;
          return made;
        };
        const button = (text: string, onClick: () => void) => {
          const made = make("button", text);
          made.type = "button";
          made.addEventListener("click", onClick);
          return made;
        };

        const day = () => firstDay(undefined, props.note?.day, new Date());

        const draw = () => {
          if (gone) return;
          element.replaceChildren();
          if (shown.length === 0) {
            element.append(
              make("p", words.noCalendars),
              button(words.addCalendar, () => {
                void context.connections.add("ics");
              }),
            );
            return;
          }
          const today = day();
          element.append(make("p", dayName(today, context.language)));
          const events = shownOn(shown, today);
          if (events.length === 0) {
            element.append(make("p", words.nothing));
          } else {
            const list = make("ul");
            for (const event of events) {
              const item = make("li", eventLines([event], words.allDay).replace(/^- /, ""));
              if (shown.length > 1) item.append(" ", make("small", event.calendar));
              list.append(item);
            }
            element.append(list);
          }
          for (const line of statusLines(shown)) element.append(make("p", line));
          if (busy) element.append(make("p", words.refreshing));
          if (notice !== "") {
            const said = make("p", notice);
            said.setAttribute("role", "status");
            element.append(said);
          }
          const actions = make("p");
          const refreshing = button(words.refresh, () => {
            void load(true);
          });
          refreshing.disabled = busy;
          actions.append(refreshing);
          const note = props.note;
          if (note !== undefined && events.length > 0) {
            actions.append(
              " ",
              button(words.addToNote, () => {
                void addToNote(note.path, events);
              }),
            );
          }
          element.append(actions);
        };

        const addToNote = async (path: string, events: Parameters<typeof eventLines>[0]) => {
          try {
            const text = await context.vault.read(path);
            const gap =
              text.endsWith("\n\n") || text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
            await context.vault.write(path, `${text}${gap}${eventLines(events, words.allDay)}\n`);
            notice = words.added;
          } catch (error) {
            notice = error instanceof Error ? error.message : String(error);
          }
          draw();
        };

        const load = async (force: boolean) => {
          busy = true;
          draw();
          try {
            shown = await calendars(reach, {
              minutes: minutes(),
              now: Date.now(),
              force,
            });
          } catch (error) {
            notice = error instanceof Error ? error.message : String(error);
          }
          busy = false;
          draw();
        };

        // What was kept shows at once; a stale calendar is read again after.
        void keptCalendars(reach)
          .then((kept) => {
            shown = kept;
            draw();
          })
          .then(() => load(false));
        const watching = context.connections.onChange(() => {
          void load(false);
        });

        return {
          update(next) {
            props = next;
            notice = "";
            draw();
          },
          unmount() {
            gone = true;
            void watching.then((each) => each.dispose());
          },
        };
      },
    });
  },
});
