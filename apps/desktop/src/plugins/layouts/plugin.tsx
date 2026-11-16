// The database layouts beside the table (ADR 0056): a board, a gallery, a
// list, a calendar and a timeline, which keep their names in a database's
// schema. A built-in plugin, through the host's live views.
import {
  BoardLayout,
  CalendarLayout,
  GalleryLayout,
  ListLayout,
  TimelineLayout,
} from "../../DatabaseLayouts.tsx";
import type { BuiltinModule } from "../host.ts";
import type { LayoutHostProps } from "../layouts.ts";

/** What every layout shows: the view, its rows, their groups and the properties shown. */
function shown({ view, rows, groups, visible, onOpen }: LayoutHostProps) {
  return { view, rows, ...(groups === undefined ? {} : { groups }), visible, onOpen };
}

const plugin: BuiltinModule = {
  activate(context) {
    const { layouts } = context.host;
    layouts.view("board", (props) => (
      <BoardLayout {...shown(props)} onMove={props.onMove} onCreate={props.onCreate} />
    ));
    layouts.view("gallery", (props) => <GalleryLayout {...shown(props)} coverOf={props.coverOf} />);
    layouts.view("list", (props) => <ListLayout {...shown(props)} />);
    layouts.view("calendar", ({ view, rows, visible, onOpen, onCreateOn }) => (
      <CalendarLayout
        view={view}
        rows={rows}
        visible={visible}
        onOpen={onOpen}
        dateKey={view.date ?? "$updated"}
        {...(onCreateOn === undefined ? {} : { onCreate: onCreateOn })}
      />
    ));
    layouts.view("timeline", ({ view, rows, visible, onOpen }) => (
      <TimelineLayout
        view={view}
        rows={rows}
        visible={visible}
        onOpen={onOpen}
        dateKey={view.date ?? "$updated"}
        {...(view.end === undefined ? {} : { endKey: view.end })}
      />
    ));
  },
};

export default plugin;
