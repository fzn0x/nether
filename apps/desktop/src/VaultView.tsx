// An open vault: its notes, or its tags, on the left, and the selected note
// in the editor on the right. A tag shows the notes with it. New notes are
// made blank or from a template, and today's, this week's and this month's
// notes open, made the first time from theirs.
import type { NoteId, Period } from "@nether/core";
import type { NoteEntry, Vault } from "@nether/storage";
import { localize } from "@nether/plugin-api";
import {
  type CSSProperties,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Indexer } from "./indexer.ts";
import { directionOf, language, t } from "./messages.ts";
import type { VaultInfo } from "./mygo.ts";
import { backend } from "./backend.ts";
import { BookmarkList } from "./BookmarkList.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { ContextMenu, type MenuEntry, type MenuPoint } from "./ContextMenu.tsx";
import { type Menu, MenuBar } from "./MenuBar.tsx";
import { IconButton } from "./IconButton.tsx";
import { askIcon, assistIcon, buildIcon, commandIcons, itemIcons, menuIcons } from "./icons.ts";
import { NewFolderDialog } from "./NewFolderDialog.tsx";
import { TextPromptDialog } from "./TextPromptDialog.tsx";
import { myName, setMyName } from "./people.ts";
import { DeleteFolderDialog } from "./DeleteFolderDialog.tsx";
import { commandShown, shownEntries } from "./features.ts";
import { SidebarResizer, useSidebarWidth } from "./SidebarResizer.tsx";
import { builtInTheme } from "./appearance.ts";
import {
  type CommandId,
  commandIds,
  coreMenus,
  defaultHotkeys,
  menuOfCommand,
} from "./commands.ts";
import { builtinPlugins } from "./plugins/builtins.ts";
import { BlockRegistry } from "./plugins/blocks.ts";
import { CodeBlockRegistry, type NoteRequest } from "./plugins/codeBlocks.ts";
import { PanelRegistry, usePanels } from "./plugins/panels.ts";
import { ViewRegistry, extensionOf, useViews } from "./plugins/views.ts";
import { LayoutRegistry } from "./plugins/layouts.ts";
import { PropertyTypeRegistry } from "./plugins/propertyTypes.ts";
import { PropertyChangeRegistry } from "./plugins/propertyChanges.ts";
import { PaneViewOutput } from "./PaneViewOutput.tsx";
import { SidebarPanel } from "./PanelOutput.tsx";
import { PluginHost } from "./plugins/host.ts";
import { type VaultAccess, vaultAccess } from "./plugins/vault.ts";
import { isFolderOn, isOn, readBuiltins, usePluginState } from "./plugins/state.ts";
import { type Command, CommandRegistry } from "./plugins/registry.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import {
  ExportPolicyContext,
  useExportPolicy,
  usePurgeAsPolicySays,
  useTrashPolicy,
} from "./workspacePolicy.ts";
import { MergeNoteDialog } from "./MergeNoteDialog.tsx";
import { MoveNoteDialog } from "./MoveNoteDialog.tsx";
import { NewNoteDialog } from "./NewNoteDialog.tsx";
import { buttonNotePath, copyNote, freeNotePath, fullPath, vaultFolders } from "./noteActions.ts";
import { NoteTagsDialog } from "./NoteTagsDialog.tsx";
import { NoteList } from "./NoteList.tsx";
import { type Dragged, NoteTree } from "./NoteTree.tsx";
import { QuickSwitcher } from "./QuickSwitcher.tsx";
import { notOnPhones, phoneQuery, useMedia } from "./phone.ts";
import { RenameNoteDialog } from "./RenameNoteDialog.tsx";
import { TabStrip } from "./TabStrip.tsx";
import {
  type Layout,
  type Opened,
  activeNote,
  activeTab,
  fileTab,
  filePathOf,
  noteOf,
  chooseTab,
  closeNote,
  closeTab,
  cycleTab,
  emptyLayout,
  focusPane,
  openHere,
  openInNewTab,
  openToTheRight,
  readLayout,
  replaceNote,
  shownIn,
} from "./tabs.ts";
import { SearchPanel } from "./SearchPanel.tsx";
import { ShortcutsSettings } from "./ShortcutsSettings.tsx";
import { ariaKeys, commandFor, eventKeys } from "./shortcuts.ts";
import { TemplateSettings } from "./TemplateSettings.tsx";
import { SettingsDialog, type SettingsTab } from "./SettingsDialog.tsx";
import { PluginsSettings } from "./PluginsSettings.tsx";
import { PluginSettings } from "./PluginSettings.tsx";

import { useAi } from "./useAi.ts";
import { useMeaning } from "./useMeaning.ts";
import type { MeaningSource } from "./askNotes.ts";
import { useAppearance } from "./useAppearance.ts";
import { useBookmarks } from "./useBookmarks.ts";
import { TrashPanel } from "./TrashPanel.tsx";
import type { NotePart } from "./noteLinks.ts";
import type { NoteMode } from "./NoteView.tsx";
import type { AskedTurn } from "./AskPanel.tsx";
import { findTemplate, nameOf, periodicNote, periods, templateChoices } from "./templates.ts";
import { useGraph } from "./useGraph.ts";
import { hostOf, syncSummary } from "./sync.ts";
import { useHotkeys } from "./useHotkeys.ts";
import { useTemplateSettings } from "./useTemplateSettings.ts";
import { useSync } from "./useSync.ts";
import { usePeople, useNotifications } from "./useNotifications.ts";
import { queueMention } from "./notify.ts";
import { useFolders, useNotes, useVault, useViewFiles } from "./useVault.ts";

/** What the app's own commands do as the latest render has it. */
interface CommandState {
  /** What each does, or undefined where it cannot run now. */
  readonly run: Readonly<Record<CommandId, (() => void) | undefined>>;
  readonly nameNow: (id: CommandId) => string;
}

/**
 * A registry holding the app's own commands, those this build shows, each
 * running what the latest render says it does.
 */
function coreRegistry(state: { readonly current: CommandState | undefined }): CommandRegistry {
  const registry = new CommandRegistry();
  for (const id of commandIds) {
    if (!commandShown(id)) continue;
    registry.add({
      id,
      name: () => t(`command_${id}`),
      nameNow: () => state.current?.nameNow(id) ?? t(`command_${id}`),
      menu: menuOfCommand[id],
      keys: defaultHotkeys[id] ?? [],
      icon: commandIcons[id],
      ...(id === "trashNote" ? { danger: true } : {}),
      enabled: () => state.current?.run[id] !== undefined,
      run: () => {
        state.current?.run[id]?.();
      },
    });
  }
  return registry;
}

/** The label each menu of the menu bar has. */
const menuLabels = {
  file: "menuFile",
  note: "menuNote",
  view: "menuView",
  sync: "menuSync",
  settings: "menuSettings",
  plugins: "menuPlugins",
} as const;

// The editor and the Markdown parser load on their own, so the vault's notes
// show while they do. Not through lazy(): a lazy component waits on its
// first render even when its code has loaded, and React then holds back
// what it waited for a further 300 ms, as it does after any fallback.
type NoteViewModule = typeof import("./NoteView.tsx");
let noteViewModule: NoteViewModule | undefined;
const loadNoteView = () => import("./NoteView.tsx").then((module) => (noteViewModule = module));

/** The note view's code, loading as the vault opens, before a note is picked. */
function useNoteViewModule(): NoteViewModule | undefined {
  const [module, setModule] = useState(noteViewModule);
  useEffect(() => {
    if (module !== undefined) return;
    let current = true;
    void loadNoteView().then((loaded) => {
      if (current) setModule(loaded);
    });
    return () => {
      current = false;
    };
  }, [module]);
  return module;
}
// Making a note from a template takes the editor's document and the parser.
const loadCreateNote = () => import("./createNote.ts");
// Renaming a note reads the links to it with the parser.
const loadRenameNote = () => import("./renameNote.ts");
const loadMergeNote = () => import("./mergeNote.ts");
// So does making a database, which writes its note's frontmatter.
const loadDatabases = () => import("./databases.ts");
// The graph, with Sigma and its layout, loads the first time it opens.
const ThemeEffect = lazy(() => import("./ThemeEffect.tsx"));
// The import, appearance and servers dialogs, with the importers, load when they open.
const ImportDialog = lazy(() =>
  import("./ImportDialog.tsx").then(({ ImportDialog: dialog }) => ({ default: dialog })),
);
const AppearanceSettings = lazy(() =>
  import("./AppearanceSettings.tsx").then(({ AppearanceSettings: tab }) => ({ default: tab })),
);
// So does the AI tab, with the providers' code (ADR 0068).
const AiSettings = lazy(() =>
  import("./AiSettings.tsx").then(({ AiSettings: tab }) => ({ default: tab })),
);
// And asking your notes, the first time its tab opens (ADR 0075).
const AskPanel = lazy(() =>
  import("./AskPanel.tsx").then(({ AskPanel: panel }) => ({ default: panel })),
);
// And building with AI, the first time it is asked for (ADR 0078).
const BuildDialog = lazy(() =>
  import("./BuildDialog.tsx").then(({ BuildDialog: dialog }) => ({ default: dialog })),
);
const ServersDialog = lazy(() =>
  import("./ServersDialog.tsx").then(({ ServersDialog: dialog }) => ({ default: dialog })),
);
const SyncDialog = lazy(() =>
  import("./SyncDialog.tsx").then(({ SyncDialog: dialog }) => ({ default: dialog })),
);
const SpacesDialog = lazy(() =>
  import("./SpacesDialog.tsx").then(({ SpacesDialog: dialog }) => ({ default: dialog })),
);
const ShareDialog = lazy(() =>
  import("./ShareDialog.tsx").then(({ ShareDialog: dialog }) => ({ default: dialog })),
);
const MembersDialog = lazy(() =>
  import("./MembersDialog.tsx").then(({ MembersDialog: dialog }) => ({ default: dialog })),
);
const HistoryDialog = lazy(() =>
  import("./HistoryDialog.tsx").then(({ HistoryDialog: dialog }) => ({ default: dialog })),
);
const NotificationsDialog = lazy(() =>
  import("./NotificationsDialog.tsx").then(({ NotificationsDialog: dialog }) => ({
    default: dialog,
  })),
);
// The REST API's tokens and the workspace's webhooks (ADRs 0059 and 0060).
const TokensDialog = lazy(() =>
  import("./TokensDialog.tsx").then(({ TokensDialog: dialog }) => ({ default: dialog })),
);
const WebhooksDialog = lazy(() =>
  import("./WebhooksDialog.tsx").then(({ WebhooksDialog: dialog }) => ({ default: dialog })),
);
// The bar above the note, only at a phone's width (ADR 0087).
const PhoneBar = lazy(() => import("./PhoneBar.tsx"));

const numbers = new Intl.NumberFormat();

type NotesView = "folders" | "pages" | "list";
const notesViews: readonly NotesView[] = ["folders", "pages", "list"];
const viewKey = "nether.notesView";

/** How the sidebar shows notes, as the user last chose; storage may be closed to the page. */
function storedView(): NotesView {
  try {
    const stored = localStorage.getItem(viewKey);
    return notesViews.find((view) => view === stored) ?? "folders";
  } catch {
    return "folders";
  }
}

function storeView(view: NotesView): void {
  try {
    localStorage.setItem(viewKey, view);
  } catch {
    // Not remembered: the view holds until the app closes.
  }
}

/** How far the link index has read, while it is reading. */
function IndexStatus(props: { readonly indexer: Indexer }) {
  const { indexer } = props;
  const progress = useSyncExternalStore(
    (listener) => indexer.subscribe(listener),
    () => indexer.progress(),
  );
  const error = useSyncExternalStore(
    (listener) => indexer.subscribe(listener),
    () => indexer.error(),
  );
  if (error !== undefined) {
    return (
      <p className="count" role="alert">
        {t("linksFailed", { error })}
      </p>
    );
  }
  if (progress.done >= progress.total) return null;
  return (
    <p className="count" role="status">
      {t("indexingLinks", {
        done: numbers.format(progress.done),
        total: numbers.format(progress.total),
      })}
    </p>
  );
}

/** The built-in plugins, their manifests read once. */
const builtins = readBuiltins(builtinPlugins);
const builtinIds: ReadonlySet<string> = new Set(builtins.map((each) => each.manifest.id));

/** The built-in graph plugin's view, which the app's Graph command opens. */
const graphView = "graph:graph";

/** The built-in plugins' panels that the app's commands Tags and Assigned show. */
const tagsPanel = "tags:tags";
const assignedPanel = "assigned:assigned";

/**
 * What a pane asks of the note it shows: blocks or source, kept from note
 * to note; where a link to a heading or block asked to go; and counters
 * that change to ask it to switch modes, take a new name, comment on its
 * selection, or show a thread a notification opened.
 */
interface PaneAsks {
  readonly mode: NoteMode;
  readonly focus?: (NotePart & { readonly key: number }) | undefined;
  /** Where in a file a link asked to go, as `page=3` in a PDF. */
  readonly at?: { readonly part: string; readonly key: number } | undefined;
  readonly source: number;
  readonly rename: number;
  readonly comment: number;
  /** Changes to ask for writing assist on the selection (ADR 0069). */
  readonly assist: number;
  readonly thread?: { readonly thread: string; readonly key: number } | undefined;
}

const noAsks: PaneAsks = { mode: "blocks", source: 0, rename: 0, comment: 0, assist: 0 };

export function VaultView(props: {
  readonly info: VaultInfo;
  /** The note to open first, by its path, as the command line names one; else the last open. */
  readonly note?: string;
  readonly onClose: () => void;
}) {
  const { info, note: startNote, onClose } = props;
  const state = useVault(info);
  const vault = state.status === "open" ? state.vault : undefined;
  const sync = useSync(vault);
  // The AI provider the vault uses, if any: with none, nothing of AI shows (ADR 0068).
  const ai = useAi(vault, sync.link);
  // Whether the workspace's data policy lets its notes be exported (ADR 0088).
  const exportPolicy = useExportPolicy(vault, sync.link);
  // The trash and the vault's own history purged once it has settled, unless its workspace is on hold.
  usePurgeAsPolicySays(vault, sync.link);
  // Search by meaning, when it is on for the vault (ADR 0074).
  const meaning = useMeaning(vault, ai, sync.link);
  // Asking your notes finds notes by meaning too, while search by meaning runs.
  const meaningSearch = meaning.panel?.search;
  const askMeaning = useMemo((): MeaningSource | undefined => {
    if (meaningSearch === undefined) return undefined;
    return async (question, limit) =>
      (await meaningSearch(question)).slice(0, limit).map((hit) => {
        const heading = hit.heading.split(" > ").at(-1);
        return { note: hit.note.id, heading: heading === "" ? undefined : heading };
      });
  }, [meaningSearch]);
  const meaningProvider = ai.settings.providers.find(
    (provider) => provider.id === meaning.choice?.provider,
  );
  const askMeaningVia =
    askMeaning === undefined || meaning.choice === undefined
      ? undefined
      : t("askMeaningVia", {
          model: meaning.choice.model,
          name: meaningProvider?.name ?? meaning.choice.provider,
        });
  // The questions asked of the vault's notes, kept while it is open, and
  // the count that asks the question's box for focus.
  const [askTurns, setAskTurns] = useState<readonly AskedTurn[]>([]);
  const [askFocus, setAskFocus] = useState(0);
  const notifications = useNotifications(vault, sync.link);
  const people = usePeople(sync.link);
  // The vault's light or dark, theme and snippets, on the page while it is open.
  const appearance = useAppearance(vault);
  const graph = state.status === "open" ? state.indexer.graph : undefined;
  const notes = useNotes(vault);
  const folders = useFolders(vault);
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  const bookmarks = useBookmarks(vault);
  // Where notes are open: tabs in one pane or two (ADR 0046). Commands
  // about a note act on the note the focused pane shows.
  const [layout, setLayout] = useState<Layout>(emptyLayout);
  const layoutNow = useRef(layout);
  const changeLayout = useCallback((change: (current: Layout) => Layout): Layout => {
    const next = change(layoutNow.current);
    layoutNow.current = next;
    setLayout(next);
    return next;
  }, []);
  const selected = activeNote(layout);
  // Whether the graph shows in place of the note.
  // A plugin's view of its own filling the pane over the notes open, as the graph does.
  const [paneView, setPaneView] = useState<string | undefined>();
  const lastNoteKey = `nether.lastNote.${info.id}`;
  const tabsKey = `nether.tabs.${info.id}`;

  // The vault's links load once the note it opens to shows, or at once when
  // it opens to none: loaded alongside it, they held that note back.
  const indexer = state.status === "open" ? state.indexer : undefined;
  const linksStarted = useRef<Indexer | undefined>(undefined);
  const loadLinks = useCallback(() => {
    if (indexer === undefined || linksStarted.current === indexer) return;
    linksStarted.current = indexer;
    void (async () => {
      await indexer.start();
      backend.mark("links-loaded");
      // Then the notes the index has not read, all of them the first time.
      await indexer.idle();
      backend.mark("notes-read");
      // Opening the vault is done, and what it took to open it can go.
      backend.settle();
    })();
  }, [indexer]);
  /** Resolves once the links are loaded, starting them now if they have not started. */
  const linksLoaded = useCallback(async () => {
    loadLinks();
    await indexer?.idle();
  }, [loadLinks, indexer]);
  useEffect(() => {
    // Should the note never show.
    const timer = setTimeout(loadLinks, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [loadLinks]);

  // What each pane, by its key, asks of the note it shows.
  const [asks, setAsks] = useState<Readonly<Record<number, PaneAsks>>>({});
  const ask = useCallback((key: number, change: (current: PaneAsks) => PaneAsks) => {
    setAsks((all) => ({ ...all, [key]: change(all[key] ?? noAsks) }));
  }, []);
  const focusedKey = layout.panes[layout.focused]?.key ?? 0;
  const mode = (asks[focusedKey] ?? noAsks).mode;
  // The sidebar's tab: the app's own, or a plugin's panel by its ID.
  const [panel, setPanel] = useState<string>("notes");
  // What the trash panel shows of the workspace's policy, asked as it opens.
  const trashPolicy = useTrashPolicy(panel === "trash" ? vault : undefined, sync.link);
  // Whether the dialog that asks for the name this device goes by is open.
  const [namingMe, setNamingMe] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  // On a phone, one note shows at a time, and the sidebar is a drawer over
  // it, opened from the bar above it, which closes as a note opens (ADR 0087).
  const phone = useMedia(phoneQuery);
  const [drawer, setDrawer] = useState(false);
  const drawerOpen = phone && drawer;
  const shownNow = `${activeTab(layout) ?? ""} ${paneView ?? ""}`;
  useEffect(() => {
    setDrawer(false);
  }, [shownNow]);
  // The drawer takes the focus as it opens, and gives it back to its button as it closes.
  const drawerWas = useRef(false);
  useEffect(() => {
    if (drawerOpen === drawerWas.current) return;
    drawerWas.current = drawerOpen;
    if (drawerOpen) {
      document.querySelector<HTMLElement>("#sidebar .drawer-close")?.focus();
    } else if (phone) {
      document.getElementById("phone-menu")?.focus();
    }
  }, [drawerOpen, phone]);
  const searchInput = useRef<HTMLInputElement>(null);
  const [tag, setTag] = useState<string | undefined>();
  const [dialog, setDialog] = useState<
    | "newNote"
    | "settings"
    | "servers"
    | "sync"
    | "members"
    | "spaces"
    | "share"
    | "notifications"
    | "webhooks"
    | "tokens"
    | "history"
    | "export"
    | "import"
    | "build"
    | "palette"
    | undefined
  >();
  // The server whose API tokens the tokens dialog shows.
  const [tokensServer, setTokensServer] = useState<string | undefined>();
  // The settings' tab chosen, which each settings command opens at its own.
  const [settingsTab, setSettingsTab] = useState("templates");
  // A note's menu, open at a point, and the dialog one of its items opened for a note.
  const [menu, setMenu] = useState<{ readonly id: NoteId; readonly at: MenuPoint } | undefined>();
  const [noteDialog, setNoteDialog] = useState<
    { readonly kind: "rename" | "move" | "merge" | "tags"; readonly id: NoteId } | undefined
  >();
  // Every command, the app's own and its plugins' (ADR 0055): the app's
  // run what the latest render says they do.
  const commandState = useRef<CommandState | undefined>(undefined);
  const [registry] = useState(() => coreRegistry(commandState));
  // The code block languages plugins draw, such as Mermaid's.
  const [codeBlocks] = useState(() => new CodeBlockRegistry());
  // And the blocks they add, of types named `plugin-id/type`.
  const [blocks] = useState(() => new BlockRegistry());
  // And their panels, in the sidebar and beside a note.
  const [panels] = useState(() => new PanelRegistry());
  // And their views, of files by extension and of their own.
  const [views] = useState(() => new ViewRegistry());
  // And their database layouts, beside the table.
  const [layouts] = useState(() => new LayoutRegistry());
  // And their property types, each stored as one of the app's.
  const [propertyTypes] = useState(() => new PropertyTypeRegistry());
  // And what watches the properties the app changes: triggers (ADR 0072).
  const [propertyChanges] = useState(() => new PropertyChangeRegistry());
  const plugins = useMemo(
    () => ({
      commands: registry,
      codeBlocks,
      blocks,
      panels,
      views,
      layouts,
      propertyTypes,
      propertyChanges,
    }),
    [registry, codeBlocks, blocks, panels, views, layouts, propertyTypes, propertyChanges],
  );
  const allViews = useViews(views);
  // Whether a plugin opens canvases, for New canvas.
  const canvasOpens = allViews.some((view) => view.extensions.includes("canvas"));
  // The files that open in a tab, beside the notes: those plugins open, as
  // PDFs, and canvases, which showed there before a plugin opened them.
  const viewExtensions = useMemo(
    () => [...new Set(["canvas", ...allViews.flatMap((view) => view.extensions)])].sort(),
    [allViews],
  );
  const viewFiles = useViewFiles(vault, viewExtensions);
  const sidebarPanels = usePanels(panels, "sidebar");
  const commands = useSyncExternalStore(
    useCallback((listener: () => void) => registry.subscribe(listener), [registry]),
    () => registry.all(),
  );
  const {
    hotkeys,
    chosen: chosenHotkeys,
    save: saveHotkeys,
  } = useHotkeys(vault, registry.defaults());
  // Whether the app updates itself, and checks on its own.
  const [updates, setUpdates] = useState({ available: false, automatic: false });
  const readUpdates = useCallback(() => {
    backend.updateSettings().then(setUpdates, () => undefined);
  }, []);
  useEffect(readUpdates, [readUpdates]);
  // While the shortcuts dialog listens for keys, they run no command.
  const listening = useRef(false);
  const setListening = useCallback((value: boolean) => {
    listening.current = value;
  }, []);
  // The folder a new note goes in, when made from the tree.
  const [newIn, setNewIn] = useState("");
  // The folder a new folder goes in, while its dialog is open.
  const [newFolderIn, setNewFolderIn] = useState<string | undefined>();
  // The folder with notes or files in it that is asked about before it goes.
  const [deletingFolder, setDeletingFolder] = useState<string | undefined>();
  // A canvas's menu, open at a point (ADR 0051).
  const [fileMenu, setFileMenu] = useState<
    { readonly path: string; readonly at: MenuPoint } | undefined
  >();
  // A folder's menu, open at a point.
  const [folderMenu, setFolderMenu] = useState<
    { readonly path: string; readonly at: MenuPoint } | undefined
  >();
  const [notesView, setNotesView] = useState<NotesView>(storedView);
  // What happened to a note: a template the vault no longer has, or the note moved to the trash.
  const [notice, setNotice] = useState<
    | {
        readonly text: string;
        /** Where in the trash what it moved there went, which Restore puts back. */
        readonly restore?: string | readonly string[];
      }
    | undefined
  >();
  // The built-in plugins, those the vault has on, whose contributions show
  // at once and whose code loads when one is first used; what goes wrong
  // with one shows as a notice.
  // What plugins that ask for it reach of the vault open (ADR 0064).
  const reachVault = useRef<VaultAccess | undefined>(undefined);
  const [host] = useState(
    () =>
      new PluginHost(plugins, {
        language,
        direction: directionOf(language),
        onError: (plugin, message) => {
          setNotice({ text: t("pluginFailed", { plugin, message }) });
        },
        onOpenView: setPaneView,
        vault: () => reachVault.current,
      }),
  );
  useEffect(() => {
    reachVault.current =
      vault === undefined
        ? undefined
        : vaultAccess(vault, ({ id, title, where, plugin }) => {
            // As the app moves a note to the trash: its tabs close, and the notice puts it back.
            changeLayout((current) => closeNote(current, id));
            setNotice({ text: t("pluginMovedToTrash", { plugin, name: title }), restore: where });
          });
  }, [vault]);
  const pluginState = usePluginState(vault, info.id, builtins);
  // The code each plugin from a folder runs, by its hash, to start it again when that changes.
  const folderCode = useRef(new Map<string, string>());
  useEffect(
    () => () => {
      host.close();
    },
    [host],
  );
  useEffect(() => {
    const { state: loaded } = pluginState;
    if (loaded === undefined) return;
    const added = new Set(host.ids());
    for (const { plugin, manifest } of builtins) {
      host.setSettings(manifest.id, loaded.settings[manifest.id]);
      if (!isOn(loaded, manifest.id)) {
        host.remove(manifest.id);
      } else if (!added.has(manifest.id)) {
        const problems = host.add(plugin);
        if (problems.length > 0) setNotice({ text: problems.join(" ") });
      }
    }
    // Those from folders that are on, and approved as they are now (ADR 0058).
    const running = new Map<string, string>();
    for (const entry of loaded.folders) {
      const { manifest, raw, code } = entry;
      if (manifest === undefined || code === undefined || !isFolderOn(loaded, entry)) continue;
      running.set(manifest.id, code.hash);
      host.setSettings(manifest.id, loaded.settings[manifest.id]);
      const before = folderCode.current.get(manifest.id);
      if (before === code.hash && added.has(manifest.id)) continue;
      host.remove(manifest.id);
      const problems = host.addFolder({ manifest: raw, code: code.text });
      if (problems.length > 0) setNotice({ text: problems.join(" ") });
      else folderCode.current.set(manifest.id, code.hash);
    }
    for (const id of added) {
      if (builtinIds.has(id) || running.has(id)) continue;
      host.remove(id);
      folderCode.current.delete(id);
    }
  }, [host, pluginState]);
  const { settings, save } = useTemplateSettings(vault);
  const version = useGraph(graph);

  const noteView = useNoteViewModule();

  /** Opens a note in the focused pane's tab, in a new tab, or in the pane to the right; returns that pane's key. */
  const openNote = useCallback(
    (id: NoteId, part?: NotePart, where: "here" | "tab" | "right" = "here"): number => {
      setPaneView(undefined);
      const next = changeLayout((current) =>
        where === "tab"
          ? openInNewTab(current, id)
          : where === "right"
            ? openToTheRight(current, id)
            : openHere(current, id),
      );
      const key = next.panes[next.focused]?.key ?? 0;
      const focus =
        part !== undefined && (part.heading !== undefined || part.block !== undefined)
          ? { ...part, key: Date.now() }
          : undefined;
      ask(key, (current) => ({ ...current, focus }));
      return key;
    },
    [changeLayout, ask],
  );

  /**
   * Opens a file, as a canvas or a PDF, by its path, in the focused pane, a
   * new tab or the pane to the right; at a place in it, as a link's `page=3`.
   */
  const openFile = useCallback(
    (path: string, where: "here" | "tab" | "right" = "here", part?: string) => {
      setPaneView(undefined);
      const tab = fileTab(path);
      const next = changeLayout((current) =>
        where === "tab"
          ? openInNewTab(current, tab)
          : where === "right"
            ? openToTheRight(current, tab)
            : openHere(current, tab),
      );
      const key = next.panes[next.focused]?.key ?? 0;
      const at = part === undefined ? undefined : { part, key: Date.now() };
      ask(key, (current) => ({ ...current, at }));
    },
    [changeLayout, ask],
  );

  /** Opens a file a link names, at the place the link names, when a plugin's view opens it. */
  const openLinkedFile = useCallback(
    (path: string, part?: string): boolean => {
      if (views.forFile(path) === undefined) return false;
      openFile(path, "here", part);
      return true;
    },
    [views, openFile],
  );

  const showTag = useCallback((name: string) => {
    setTag(name);
    setPanel("notes");
  }, []);

  /**
   * Makes a note at `path`, blank or from a template, and opens it with the
   * cursor where the template puts it, unless asked not to.
   */
  const makeNote = useCallback(
    async (path: string, template: NoteEntry | undefined, date: Date, open = true) => {
      if (vault === undefined) return;
      const [{ createNote }, file] = await Promise.all([
        loadCreateNote(),
        template === undefined ? undefined : vault.read(template.id),
      ]);
      const text =
        file === undefined || file.missing === true || file.binary === true ? undefined : file.text;
      const values = {
        title: nameOf(path),
        date,
        now: new Date(),
        dateFormat: settings.dateFormat,
        timeFormat: settings.timeFormat,
      };
      const created = await createNote(
        vault,
        path,
        text === undefined ? undefined : { text, values },
      );
      if (!open) return;
      setTag(undefined);
      setPanel("notes");
      openNote(created.id, created.cursor);
    },
    [vault, settings, openNote],
  );

  /**
   * Makes the note a button asks for (ADR 0072), from its template when it
   * names one, beside a note of its name unless that one should open.
   */
  const buttonNote = useCallback(
    async (request: NoteRequest) => {
      if (vault === undefined) return;
      const name = request.name ?? t("untitled");
      const path = buttonNotePath(request.folder, name);
      if (path === undefined) {
        throw new Error(t("buttonBadPlace", { path: `${request.folder}/${name}` }));
      }
      const existing = vault.noteAt(path);
      if (existing !== undefined && request.openIfExists) {
        openNote(existing.id);
        return;
      }
      const named = request.template;
      const template =
        named === undefined ? undefined : findTemplate(vault.notes(), settings, named);
      if (named !== undefined && template === undefined) {
        throw new Error(t("buttonNoTemplate", { template: named }));
      }
      await makeNote(freeNotePath(vault, path), template, new Date(), request.open);
    },
    [vault, settings, openNote, makeNote],
  );

  /** Opens the note for the day, week or month it is, made from its template the first time. */
  const openPeriodic = useCallback(
    (period: Period) => {
      if (vault === undefined) return;
      setNotice(undefined);
      const { path, date } = periodicNote(settings, period, new Date());
      const existing = vault.noteAt(path);
      if (existing !== undefined) {
        openNote(existing.id);
        return;
      }
      const named = settings[period].template;
      const template = findTemplate(vault.notes(), settings, named);
      if (named !== "" && template === undefined) {
        setNotice({ text: t("templateMissing", { template: named }) });
      }
      makeNote(path, template, date).catch((error: unknown) => {
        setNotice({ text: error instanceof Error ? error.message : String(error) });
      });
    },
    [vault, settings, openNote, makeNote],
  );

  /** Moves a note to the trash, and offers to put it back. */
  const trashNote = useCallback(
    (id: NoteId) => {
      if (vault === undefined) return;
      const title = vault.note(id)?.title ?? "";
      vault.remove(id).then(
        (where) => {
          changeLayout((current) => closeNote(current, id));
          setNotice({ text: t("movedToTrash", { name: title }), restore: where });
        },
        (error: unknown) => {
          setNotice({ text: error instanceof Error ? error.message : String(error) });
        },
      );
    },
    [vault],
  );

  /** Moves a canvas to the trash, closing its tabs; the notice restores it. */
  const trashFile = useCallback(
    (path: string) => {
      if (vault === undefined) return;
      const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.canvas$/i, "");
      vault.removeFile(path).then(
        (where) => {
          changeLayout((current) => closeNote(current, fileTab(path)));
          setNotice({ text: t("movedToTrash", { name }), restore: where });
        },
        (error: unknown) => {
          setNotice({ text: error instanceof Error ? error.message : String(error) });
        },
      );
    },
    [vault, changeLayout],
  );

  /** Makes an empty canvas in a folder, named as the first free "Untitled canvas", and opens it. */
  const newCanvas = useCallback(
    async (folder: string) => {
      if (vault === undefined) return;
      const base = `${folder === "" ? "" : `${folder}/`}${t("newCanvasName")}`;
      let path = `${base}.canvas`;
      for (let n = 2; vault.fileInfo(path) !== undefined; n++) path = `${base} ${String(n)}.canvas`;
      const { emptyCanvas, writeCanvas } = await import("@nether/canvas");
      await vault.writeFile(path, writeCanvas(emptyCanvas), "");
      openFile(path);
    },
    [vault, openFile],
  );

  /** Renames a note in its folder, once the link index knows every link to it. */
  const renameCurrent = useCallback(
    async (id: NoteId, name: string) => {
      if (state.status !== "open") return;
      const note = state.vault.note(id);
      if (note === undefined) return;
      const { carryFolder, moveFiles, pageMoves, pagesFolder, renamedPath } =
        await loadRenameNote();
      const target = renamedPath(note.path, name);
      if ("error" in target) {
        throw new Error(target.error === "empty" ? t("noteNameEmpty") : t("noteNameUnsafe"));
      }
      await state.indexer.idle();
      // Its pages, in the folder with its name, follow it.
      await moveFiles(
        state.vault,
        state.indexer.graph,
        pageMoves(state.vault, note.path, target.path),
      );
      await carryFolder(state.vault, pagesFolder(note.path), pagesFolder(target.path));
    },
    [state],
  );

  /** Moves a note, with its pages, or a folder, with the page that names it, into a folder. */
  const moveInTree = useCallback(
    (dragged: Dragged, folder: string) => {
      if (state.status !== "open") return;
      const { vault: open, indexer } = state;
      const name = dragged.path.slice(dragged.path.lastIndexOf("/") + 1);
      const to = folder === "" ? name : `${folder}/${name}`;
      setNotice(undefined);
      void (async () => {
        const { carryFolder, folderMoves, moveFiles, pageMoves, pagesFolder } =
          await loadRenameNote();
        const moves =
          dragged.kind === "note"
            ? pageMoves(open, dragged.path, to)
            : dragged.kind === "file"
              ? [{ from: dragged.path, to }]
              : [
                  ...folderMoves(open, dragged.path, to),
                  ...(open.noteAt(`${dragged.path}.md`) === undefined
                    ? []
                    : [{ from: `${dragged.path}.md`, to: `${to}.md` }]),
                ];
        await indexer.idle();
        await moveFiles(open, indexer.graph, moves);
        // Canvases open in tabs follow where they went.
        changeLayout((current) =>
          moves.reduce(
            (layout, move) => replaceNote(layout, fileTab(move.from), fileTab(move.to)),
            current,
          ),
        );
        // The folder goes too, with the folders in it no note is in.
        if (dragged.kind === "folder") await carryFolder(open, dragged.path, to);
        else if (dragged.kind === "note") {
          await carryFolder(open, pagesFolder(dragged.path), pagesFolder(to));
        }
      })().catch((error: unknown) => {
        setNotice({ text: error instanceof Error ? error.message : String(error) });
      });
    },
    [state],
  );

  const newNoteIn = useCallback((folder: string) => {
    setNewIn(folder);
    setDialog("newNote");
  }, []);

  /** Merges a note into another, which opens in its place when it was open. */
  const mergeInto = useCallback(
    async (id: NoteId, into: NoteEntry) => {
      if (state.status !== "open") return;
      const { vault: open, indexer } = state;
      const name = open.note(id)?.title ?? "";
      setNotice(undefined);
      const { mergeNote } = await loadMergeNote();
      await indexer.idle();
      await mergeNote(open, indexer.graph, id, into.id);
      changeLayout((current) => replaceNote(current, id, into.id));
      setNotice({ text: t("mergedNote", { name, into: into.title }) });
    },
    [state],
  );

  /** Opens a note restored from the trash. */
  const openRestored = useCallback(
    (path: string) => {
      setNotice(undefined);
      const note = vault?.noteAt(path);
      if (note !== undefined) openNote(note.id);
    },
    [vault, openNote],
  );

  const openInTab = useCallback(
    (id: NoteId) => {
      openNote(id, undefined, "tab");
    },
    [openNote],
  );
  const openMenu = useCallback((id: NoteId, at: MenuPoint) => {
    setMenu({ id, at });
  }, []);
  const closeMenu = useCallback(() => {
    setMenu(undefined);
  }, []);
  const openFolderMenu = useCallback((path: string, at: MenuPoint) => {
    setFolderMenu({ path, at });
  }, []);
  const closeFolderMenu = useCallback(() => {
    setFolderMenu(undefined);
  }, []);

  /** Whether the vault has a folder or file at a path, as Windows and macOS compare names. */
  const pathTaken = useCallback(
    (path: string) => {
      const wanted = path.toLowerCase();
      return (
        folders.some((folder) => folder.toLowerCase() === wanted) ||
        (vault?.files().some((file) => file.toLowerCase() === wanted) ?? false)
      );
    },
    [folders, vault],
  );

  /**
   * Deletes a folder: what is in it, notes and files, goes to the trash one
   * by one, each restorable where it was, and the folders it emptied are
   * deleted. One that holds hidden files stays, as they are not the vault's.
   */
  const deleteFolder = useCallback(
    async (path: string) => {
      if (vault === undefined) return;
      const name = path.slice(path.lastIndexOf("/") + 1);
      const trashed: string[] = [];
      const gone: Opened[] = [];
      try {
        for (const file of vault.files().filter((other) => other.startsWith(`${path}/`))) {
          const note = vault.noteAt(file);
          trashed.push(
            note === undefined ? await vault.removeFile(file) : await vault.remove(note.id),
          );
          gone.push(note === undefined ? fileTab(file) : note.id);
        }
      } finally {
        changeLayout((current) => gone.reduce(closeNote, current));
      }
      const emptied = vault
        .folders()
        .filter((folder) => folder === path || folder.startsWith(`${path}/`))
        .sort((a, b) => b.length - a.length);
      for (const folder of emptied) await vault.removeFolder(folder).catch(() => undefined);
      const kept = vault.folders().includes(path);
      setNotice({
        text: kept
          ? t("folderKeptHidden", { name })
          : trashed.length === 0
            ? t("deletedFolder", { name })
            : t("deletedFolderWith", { name, count: String(trashed.length) }),
        ...(trashed.length === 0 ? {} : { restore: trashed }),
      });
    },
    [vault],
  );

  /** A canvas's menu: opening it, where, and moving it to the trash. */
  const fileEntries = (path: string): MenuEntry[] => [
    {
      label: t("menuOpen"),
      icon: itemIcons.open,
      run: () => {
        openFile(path);
      },
    },
    // A phone shows one note at a time, without tabs.
    ...(phone
      ? []
      : [
          {
            label: t("menuOpenNewTab"),
            icon: itemIcons.openNewTab,
            run: () => {
              openFile(path, "tab");
            },
          },
          {
            label: t("menuOpenRight"),
            icon: itemIcons.openRight,
            run: () => {
              openFile(path, "right");
            },
          },
        ]),
    "separator",
    {
      label: t("moveToTrash"),
      icon: itemIcons.trash,
      danger: true,
      run: () => {
        trashFile(path);
      },
    },
  ];

  /** A folder's menu: notes and folders made in it, and deleting it, asked first unless empty. */
  const folderEntries = (path: string): MenuEntry[] => {
    const inside = (other: string) => other.startsWith(`${path}/`);
    const empty = !(vault?.files().some(inside) ?? false) && !folders.some(inside);
    const name = path.slice(path.lastIndexOf("/") + 1);
    return [
      {
        label: t("newNoteHere"),
        icon: itemIcons.newNote,
        run: () => {
          newNoteIn(path);
        },
      },
      {
        label: t("newFolderHere"),
        icon: itemIcons.newFolder,
        run: () => {
          setNewFolderIn(path);
        },
      },
      ...(canvasOpens
        ? [
            {
              label: t("newCanvasHere"),
              icon: commandIcons.newCanvas,
              run: () => {
                void newCanvas(path);
              },
            },
          ]
        : []),
      "separator",
      {
        label: empty ? t("deleteFolder") : t("deleteFolderAsk"),
        icon: itemIcons.trash,
        danger: true,
        run: () => {
          if (!empty) {
            setDeletingFolder(path);
            return;
          }
          vault?.removeFolder(path).then(
            () => {
              setNotice({ text: t("deletedFolder", { name }) });
            },
            (error: unknown) => {
              setNotice({ text: error instanceof Error ? error.message : String(error) });
            },
          );
        },
      },
    ];
  };

  /** Copies text, and says so in the sidebar. */
  const copyText = useCallback((text: string, done: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setNotice({ text: done });
      },
      () => {
        setNotice({ text: t("copyFailed") });
      },
    );
  }, []);

  /** Bookmarks a note, or takes its bookmark away. */
  const toggleBookmark = useCallback(
    (path: string) => {
      bookmarks.toggle(path).catch((error: unknown) => {
        setNotice({ text: error instanceof Error ? error.message : String(error) });
      });
    },
    [bookmarks],
  );

  /** What a note's menu offers: what the app can do with it from the list, without opening it first. */
  const menuEntries = useCallback(
    (id: NoteId): MenuEntry[] => {
      if (state.status !== "open") return [];
      const { vault: open, media } = state;
      const note = open.note(id);
      if (note === undefined) return [];
      const failed = (error: unknown) => {
        setNotice({ text: error instanceof Error ? error.message : String(error) });
      };
      const { open: openFile, reveal } = media;
      return [
        {
          label: t("menuOpen"),
          icon: itemIcons.open,
          run: () => {
            openNote(id);
          },
        },
        // A phone shows one note at a time, without tabs.
        ...(phone
          ? []
          : [
              {
                label: t("menuOpenNewTab"),
                icon: itemIcons.openNewTab,
                run: () => {
                  openNote(id, undefined, "tab");
                },
              },
              {
                label: t("menuOpenRight"),
                icon: itemIcons.openRight,
                run: () => {
                  openNote(id, undefined, "right");
                },
              },
            ]),
        "separator",
        {
          label: t("menuRename"),
          icon: itemIcons.rename,
          run: () => {
            setNoteDialog({ kind: "rename", id });
          },
        },
        {
          label: t("menuCopy"),
          icon: itemIcons.copy,
          run: () => {
            setNotice(undefined);
            copyNote(open, id).then((copy) => {
              setNotice({ text: t("copiedNote", { name: note.title, copy: copy.title }) });
              openNote(copy.id);
            }, failed);
          },
        },
        {
          label: t("menuMove"),
          icon: itemIcons.move,
          run: () => {
            setNoteDialog({ kind: "move", id });
          },
        },
        {
          label: t("menuMerge"),
          icon: itemIcons.merge,
          run: () => {
            setNoteDialog({ kind: "merge", id });
          },
        },
        {
          label: t("menuTags"),
          icon: itemIcons.tags,
          run: () => {
            setNoteDialog({ kind: "tags", id });
          },
        },
        {
          label: bookmarks.has(note.path) ? t("menuUnbookmark") : t("menuBookmark"),
          icon: itemIcons.bookmark,
          run: () => {
            toggleBookmark(note.path);
          },
        },
        "separator",
        {
          label: t("menuCopyLink"),
          icon: itemIcons.copyLink,
          run: () => {
            // The shortest link that finds it, as Obsidian writes one.
            const link = open.linkTo(note.path, "").replace(/\.md$/i, "");
            copyText(`[[${link}]]`, t("copiedLink", { name: note.title }));
          },
        },
        {
          label: t("menuCopyPath"),
          icon: itemIcons.copyPath,
          run: () => {
            copyText(note.path, t("copiedPath", { name: note.title }));
          },
        },
        {
          label: t("menuCopyFullPath"),
          icon: itemIcons.copyPath,
          run: () => {
            copyText(fullPath(info.path, note.path), t("copiedPath", { name: note.title }));
          },
        },
        ...(openFile === undefined && reveal === undefined ? [] : ["separator" as const]),
        ...(openFile === undefined
          ? []
          : [
              {
                label: t("menuOpenDefault"),
                icon: itemIcons.openDefault,
                run: () => {
                  openFile(note.path).catch(failed);
                },
              },
            ]),
        ...(reveal === undefined
          ? []
          : [
              {
                label: t("menuReveal"),
                icon: itemIcons.reveal,
                run: () => {
                  reveal(note.path).catch(failed);
                },
              },
            ]),
        "separator",
        {
          label: t("menuExport"),
          icon: itemIcons.export,
          run: () => {
            openNote(id);
            setDialog("export");
          },
        },
        {
          label: t("menuHistory"),
          icon: itemIcons.history,
          run: () => {
            openNote(id);
            setDialog("history");
          },
        },
        "separator",
        {
          label: t("moveToTrash"),
          icon: itemIcons.trash,
          danger: true,
          run: () => {
            trashNote(id);
          },
        },
      ];
    },
    [state, info.path, openNote, trashNote, copyText, bookmarks, toggleBookmark, phone],
  );

  /** What each command does, and whether it can now: those about a note need one open. */
  const run = useMemo((): Readonly<Record<CommandId, (() => void) | undefined>> => {
    const open = state.status === "open";
    const note = open && selected !== undefined ? selected : undefined;
    const show = (name: string) => () => {
      setTag(undefined);
      setPanel(name);
    };
    const openSettings = (tab: string) => () => {
      setSettingsTab(tab);
      setDialog("settings");
      // A plugin put in the vault's folder since shows in the Plugins tab.
      pluginState.reload();
    };
    /** Shows a plugin's panel, when the plugin is there. */
    const showPanel = (id: string) =>
      open && sidebarPanels.some((each) => each.id === id) ? show(id) : undefined;
    const all: Record<CommandId, (() => void) | undefined> = {
      palette: () => {
        setDialog("palette");
      },
      switcher: open
        ? () => {
            setSwitcher(true);
          }
        : undefined,
      search: open
        ? () => {
            setPanel("search");
            // Once the panel shows.
            requestAnimationFrame(() => searchInput.current?.focus());
          }
        : undefined,
      newNote: open
        ? () => {
            setNewIn("");
            setDialog("newNote");
          }
        : undefined,
      newFolder: open
        ? () => {
            setNewFolderIn("");
          }
        : undefined,
      newCanvas:
        open && canvasOpens
          ? () => {
              const folder =
                selectedPath?.includes("/") === true
                  ? selectedPath.slice(0, selectedPath.lastIndexOf("/"))
                  : "";
              void newCanvas(folder).catch((error: unknown) => {
                setNotice({ text: error instanceof Error ? error.message : String(error) });
              });
            }
          : undefined,
      newDatabase: open
        ? () => {
            const vault = state.vault;
            const folder =
              selectedPath?.includes("/") === true
                ? selectedPath.slice(0, selectedPath.lastIndexOf("/"))
                : "";
            void loadDatabases()
              .then(({ createDatabase }) => createDatabase(vault, folder, t("newDatabaseName")))
              .then((created) => {
                setTag(undefined);
                setPanel("notes");
                openNote(created.id);
              });
          }
        : undefined,
      dayNote: open
        ? () => {
            openPeriodic("day");
          }
        : undefined,
      weekNote: open
        ? () => {
            openPeriodic("week");
          }
        : undefined,
      monthNote: open
        ? () => {
            openPeriodic("month");
          }
        : undefined,
      toggleSource:
        note === undefined
          ? undefined
          : () => {
              ask(focusedKey, (current) => ({ ...current, source: current.source + 1 }));
            },
      rename:
        note === undefined
          ? undefined
          : () => {
              ask(focusedKey, (current) => ({ ...current, rename: current.rename + 1 }));
            },
      bookmark:
        note === undefined || !open
          ? undefined
          : () => {
              const path = state.vault.note(note)?.path;
              if (path !== undefined) toggleBookmark(path);
            },
      history:
        note === undefined
          ? undefined
          : () => {
              setDialog("history");
            },
      // Comments name their writer: a vault linked to a workspace has one (ADR 0044).
      comment:
        note === undefined ||
        mode !== "blocks" ||
        sync.me === undefined ||
        sync.levelOf?.(note) === "view"
          ? undefined
          : () => {
              ask(focusedKey, (current) => ({ ...current, comment: current.comment + 1 }));
            },
      export:
        note === undefined
          ? undefined
          : () => {
              setDialog("export");
            },
      splitRight:
        note === undefined
          ? undefined
          : () => {
              openNote(note, undefined, "right");
            },
      nextTab:
        (layout.panes[layout.focused]?.tabs.length ?? 0) < 2
          ? undefined
          : () => {
              changeLayout((current) => cycleTab(current, 1));
            },
      previousTab:
        (layout.panes[layout.focused]?.tabs.length ?? 0) < 2
          ? undefined
          : () => {
              changeLayout((current) => cycleTab(current, -1));
            },
      closeTab:
        note === undefined
          ? undefined
          : () => {
              changeLayout((current) =>
                closeTab(current, current.focused, current.panes[current.focused]?.active ?? 0),
              );
            },
      import: open
        ? () => {
            setDialog("import");
          }
        : undefined,
      trashNote:
        note === undefined
          ? undefined
          : () => {
              trashNote(note);
            },
      showNotes: open ? show("notes") : undefined,
      showTags: showPanel(tagsPanel),
      showTrash: open ? show("trash") : undefined,
      showAssigned: showPanel(assignedPanel),
      myName: () => {
        setNamingMe(true);
      },
      openGraph:
        open && allViews.some((view) => view.id === graphView)
          ? () => {
              setPaneView(graphView);
            }
          : undefined,
      templateSettings: open ? openSettings("templates") : undefined,
      appearance: open ? openSettings("appearance") : undefined,
      servers: () => {
        setDialog("servers");
      },
      sync: open
        ? () => {
            setDialog("sync");
          }
        : undefined,
      members:
        open && sync.link !== undefined
          ? () => {
              setDialog("members");
            }
          : undefined,
      // An encrypted workspace has General alone (ADR 0042).
      spaces:
        open && sync.link !== undefined && sync.link.encrypted !== true
          ? () => {
              setDialog("spaces");
            }
          : undefined,
      share:
        note !== undefined && sync.link !== undefined && sync.link.encrypted !== true
          ? () => {
              setDialog("share");
            }
          : undefined,
      notifications:
        open && sync.link !== undefined
          ? () => {
              setDialog("notifications");
            }
          : undefined,
      // The server cannot name an encrypted workspace's notes, so it has no webhooks.
      webhooks:
        open && sync.link !== undefined && sync.link.encrypted !== true
          ? () => {
              setDialog("webhooks");
            }
          : undefined,
      apiTokens:
        sync.link === undefined
          ? undefined
          : () => {
              setTokensServer(sync.link?.server);
              setDialog("tokens");
            },
      shortcuts: open ? openSettings("shortcuts") : undefined,
      plugins: open ? openSettings("plugins") : undefined,
      checkUpdates: updates.available
        ? () => {
            void backend.checkForUpdates();
          }
        : undefined,
      updateChecks: updates.available
        ? () => {
            backend.setAutomaticUpdates(!updates.automatic).then(readUpdates, () => undefined);
          }
        : undefined,
      closeVault: onClose,
    };
    // What this build does not show, as sync before its release, cannot run.
    for (const id of commandIds) if (!commandShown(id)) all[id] = undefined;
    return all;
  }, [
    state.status,
    selected,
    openPeriodic,
    trashNote,
    onClose,
    updates,
    readUpdates,
    sync.link,
    sync.me,
    sync.levelOf,
    mode,
    toggleBookmark,
    ask,
    focusedKey,
    layout,
    changeLayout,
    openNote,
    sidebarPanels,
    allViews,
    canvasOpens,
  ]);

  const closeDialog = () => {
    setDialog(undefined);
  };
  /** The settings' tabs: the app's own, Plugins, then each plugin's on that has settings. */
  const settingsTabs = (open: Vault): SettingsTab[] => [
    {
      id: "templates",
      name: t("templates"),
      render: () => (
        <TemplateSettings
          settings={settings}
          templates={templateChoices(notes, settings.folder, "").map((note) =>
            note.path.replace(/\.md$/i, ""),
          )}
          onSave={save}
          onClose={closeDialog}
        />
      ),
    },
    {
      id: "appearance",
      name: t("appearance"),
      render: () => (
        <Suspense fallback={null}>
          <AppearanceSettings vault={open} state={appearance} onClose={closeDialog} />
        </Suspense>
      ),
    },
    {
      id: "shortcuts",
      name: t("shortcuts"),
      render: () => (
        <ShortcutsSettings
          commands={commands.map((command) => ({ id: command.id, name: command.name() }))}
          defaults={registry.defaults()}
          chosen={chosenHotkeys}
          onListening={setListening}
          onSave={saveHotkeys}
          onClose={closeDialog}
        />
      ),
    },
    // Where AI is set up, the one place it shows before it is: on this
    // device in the desktop app (ADR 0068), on the server in the web app
    // (ADR 0070).
    {
      id: "ai",
      name: t("aiTab"),
      render: () => (
        <Suspense fallback={null}>
          <AiSettings
            ai={ai}
            encrypted={sync.link?.encrypted === true}
            server={sync.link?.server}
            meaning={meaning}
            onClose={closeDialog}
          />
        </Suspense>
      ),
    },
    ...(pluginState.state === undefined
      ? []
      : (() => {
          const loaded = pluginState.state;
          return [
            {
              id: "plugins",
              name: t("pluginsTab"),
              render: () => (
                <PluginsSettings
                  key={loaded.folders
                    .map((each) => `${each.folder}:${each.code?.hash ?? ""}`)
                    .join()}
                  plugins={builtins.map((each) => each.manifest)}
                  state={loaded}
                  onSave={pluginState.saveOn}
                  onClose={closeDialog}
                  vault={open}
                  onInstalled={pluginState.reload}
                />
              ),
            },
            ...[
              ...builtins.flatMap(({ manifest }) => (isOn(loaded, manifest.id) ? [manifest] : [])),
              ...loaded.folders.flatMap((entry) =>
                entry.manifest !== undefined && isFolderOn(loaded, entry) ? [entry.manifest] : [],
              ),
            ]
              .filter((manifest) => manifest.contributes.settings.length > 0)
              .map((manifest) => ({
                id: `plugin:${manifest.id}`,
                name: localize(manifest.name, language),
                render: () => (
                  <PluginSettings
                    manifest={manifest}
                    stored={loaded.settings[manifest.id]}
                    onSave={(values) => pluginState.saveSettings(manifest.id, values)}
                    onClose={closeDialog}
                  />
                ),
              })),
          ];
        })()),
  ];

  // The plugin's view of its own filling the pane, if one does.
  const shownView = paneView === undefined ? undefined : views.get(paneView);

  // The plugin's panel the sidebar shows, if it shows one.
  const shownPanel = sidebarPanels.find((each) => each.id === panel);

  // Shortcuts run their commands, before the editors, which have their own uses for keys.
  const latest = useRef(hotkeys);
  latest.current = hotkeys;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (listening.current) return;
      const keys = eventKeys(event);
      if (keys === undefined) return;
      const id = commandFor(latest.current, keys);
      const command = id === undefined ? undefined : registry.get(id);
      if (command?.enabled() !== true) return;
      event.preventDefault();
      event.stopPropagation();
      command.run();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [registry]);

  const keysOf = (id: string) => hotkeys[id]?.[0];
  const ariaOf = (id: CommandId) => {
    const keys = keysOf(id);
    return keys === undefined ? undefined : ariaKeys(keys);
  };

  // The tabs open when the vault was last open come back, with the note the
  // app was started with shown in the focused pane; with no tabs remembered,
  // the note open last, found by its path.
  useEffect(() => {
    if (vault === undefined) return;
    let restored = false;
    try {
      const stored = localStorage.getItem(tabsKey);
      let next =
        stored === null
          ? emptyLayout
          : readLayout(JSON.parse(stored) as unknown, (id) => {
              const file = filePathOf(id);
              return file === undefined
                ? vault.note(id as NoteId) !== undefined
                : vault.fileInfo(file) !== undefined;
            });
      const path =
        startNote ?? (activeTab(next) === undefined ? localStorage.getItem(lastNoteKey) : null);
      const note = path === null ? undefined : vault.noteAt(path);
      if (note !== undefined) next = openHere(next, note.id);
      if (activeTab(next) !== undefined) {
        changeLayout((current) => (activeTab(current) === undefined ? next : current));
        // A note shown starts the links loading; a canvas does not.
        restored = activeNote(next) !== undefined;
      }
    } catch {
      // Storage closed to the page, or what it kept unreadable: the vault opens to no note.
    }
    if (!restored) loadLinks();
  }, [vault, startNote, lastNoteKey, tabsKey, loadLinks, changeLayout]);
  useEffect(() => {
    if (vault === undefined) return;
    try {
      localStorage.setItem(tabsKey, JSON.stringify(layout));
    } catch {
      // Not remembered: the vault opens to its last note next time.
    }
  }, [vault, layout, tabsKey]);
  const selectedPath = selected === undefined ? undefined : vault?.note(selected)?.path;
  useEffect(() => {
    if (selectedPath === undefined) return;
    try {
      localStorage.setItem(lastNoteKey, selectedPath);
    } catch {
      // Not remembered: the vault opens to no note next time.
    }
  }, [selectedPath, lastNoteKey]);

  const shown = useMemo(() => {
    if (tag === undefined || graph === undefined) return notes;
    const tagged = new Set(graph.notesWithTag(tag));
    return notes.filter((note) => tagged.has(note.id));
  }, [notes, tag, graph, version]);

  /** A command's name, as it reads now: a bookmarked note's is to remove it. */
  const commandName = (id: CommandId): string =>
    id === "updateChecks" && !updates.automatic
      ? t("command_updateChecksOn")
      : id === "bookmark" && selectedPath !== undefined && bookmarks.has(selectedPath)
        ? t("command_bookmarkRemove")
        : t(`command_${id}`);

  commandState.current = { run, nameNow: commandName };

  // Writing assist works on the focused pane's note, in blocks, where this
  // person may edit it; the command shows only while the vault has an AI
  // provider (ADR 0068), and so does its shortcut.
  const assistNow = useRef<(() => void) | undefined>(undefined);
  assistNow.current =
    state.status === "open" &&
    selected !== undefined &&
    mode === "blocks" &&
    sync.levelOf?.(selected) !== "view" &&
    sync.levelOf?.(selected) !== "comment"
      ? () => {
          ask(focusedKey, (current) => ({ ...current, assist: current.assist + 1 }));
        }
      : undefined;
  const aiReady = ai.resolution.provider !== undefined;
  useEffect(() => {
    if (!aiReady) return;
    return registry.add({
      id: "assist",
      name: () => t("aiAssistCommand"),
      menu: "note",
      keys: ["Mod+J"],
      icon: assistIcon,
      enabled: () => assistNow.current !== undefined,
      run: () => {
        assistNow.current?.();
      },
    });
  }, [registry, aiReady]);
  // Asking your notes, a tab of the sidebar while the vault has a provider.
  useEffect(() => {
    if (!aiReady) return;
    return registry.add({
      id: "ask",
      name: () => t("askCommand"),
      menu: "view",
      keys: [],
      icon: askIcon,
      enabled: () => true,
      run: () => {
        setTag(undefined);
        setPanel("ask");
        setAskFocus((count) => count + 1);
      },
    });
  }, [registry, aiReady]);
  useEffect(() => {
    if (!aiReady && panel === "ask") setPanel("notes");
  }, [aiReady, panel]);
  // Building with AI, in the File menu while the vault has a provider.
  useEffect(() => {
    if (!aiReady) return;
    return registry.add({
      id: "build",
      name: () => t("buildCommand"),
      menu: "file",
      keys: [],
      icon: buildIcon,
      enabled: () => true,
      run: () => {
        setDialog("build");
      },
    });
  }, [registry, aiReady]);

  /**
   * The menus' items, each a command; one that cannot run now shows, but
   * cannot be chosen, and one this build leaves out does not show at all.
   * Plugins' commands come after a menu's own, and in a Plugins menu
   * unless they name another; a menu with no items does not show.
   */
  const menuItem = (command: Command): MenuEntry => {
    const keys = keysOf(command.id);
    return {
      label: (command.nameNow ?? command.name)(),
      run: command.run,
      disabled: !command.enabled(),
      ...(command.danger === true ? { danger: true } : {}),
      ...(command.icon === undefined ? {} : { icon: command.icon }),
      ...(keys === undefined ? {} : { keys }),
    };
  };
  // Plugins' commands, and those the app adds while they can run, as writing
  // assist with an AI provider, come after a menu's own.
  const coreIds = new Set<string>(commandIds);
  const pluginCommands = commands.filter(
    (command) => command.plugin !== undefined || !coreIds.has(command.id),
  );
  const menus: readonly Menu[] = [...coreMenus, { name: "plugins" as const, entries: [] }].flatMap(
    ({ name, entries }) => {
      const own = shownEntries(
        entries,
        (id) => registry.get(id) !== undefined && !(phone && notOnPhones.has(id)),
      ).flatMap((id): MenuEntry[] => {
        if (id === "separator") return [id];
        const command = registry.get(id);
        return command === undefined ? [] : [menuItem(command)];
      });
      const added = pluginCommands.filter((command) => command.menu === name).map(menuItem);
      const items = [
        ...own,
        ...(own.length > 0 && added.length > 0 ? ["separator" as const] : []),
        ...added,
      ];
      return items.length === 0
        ? []
        : [{ label: t(menuLabels[name]), icon: menuIcons[name], entries: items }];
    },
  );

  return (
    <ExportPolicyContext.Provider value={exportPolicy}>
      <div
        className={drawerOpen ? "vault drawer-open" : "vault"}
        style={{ "--sidebar-width": `${String(sidebarWidth)}px` } as CSSProperties}
      >
        {(() => {
          const effect = builtInTheme(appearance.appearance.theme)?.effect;
          return effect === undefined ? null : (
            <Suspense fallback={null}>
              <ThemeEffect effect={effect} />
            </Suspense>
          );
        })()}
        <aside
          id="sidebar"
          className="sidebar"
          aria-label={info.name}
          // Closed on a phone, the drawer is out of sight and out of reach.
          inert={phone && !drawerOpen}
          onKeyDown={(event) => {
            if (!drawerOpen || event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            setDrawer(false);
          }}
        >
          <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} controls="sidebar" />
          <header className="sidebar-header">
            <h2 title={info.path}>{info.name}</h2>
            <div className="sidebar-header-actions">
              <button type="button" className="quiet" onClick={onClose}>
                {t("closeVault")}
              </button>
              {phone ? (
                <button
                  type="button"
                  className="icon-button drawer-close"
                  aria-label={t("phoneSidebarClose")}
                  onClick={() => {
                    setDrawer(false);
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </div>
          </header>
          {state.status === "open" ? <MenuBar label={t("menus")} menus={menus} /> : null}
          {state.status === "opening" ? (
            <p className="placeholder" role="status">
              {t("indexing")}
            </p>
          ) : state.status === "failed" ? (
            <p role="alert">{state.error.message}</p>
          ) : (
            <>
              <div className="sidebar-actions">
                <IconButton
                  icon={commandIcons.newNote}
                  label={t("newNote")}
                  keys={keysOf("newNote")}
                  ariaKeys={ariaOf("newNote")}
                  hasPopup="dialog"
                  onClick={() => {
                    setNewIn("");
                    setDialog("newNote");
                  }}
                />
                <IconButton
                  icon={commandIcons.newFolder}
                  label={t("newFolder")}
                  keys={keysOf("newFolder")}
                  ariaKeys={ariaOf("newFolder")}
                  hasPopup="dialog"
                  onClick={() => {
                    setNewFolderIn("");
                  }}
                />
                <IconButton
                  icon={commandIcons.newDatabase}
                  label={t("newDatabase")}
                  keys={keysOf("newDatabase")}
                  ariaKeys={ariaOf("newDatabase")}
                  disabled={run.newDatabase === undefined}
                  onClick={() => {
                    run.newDatabase?.();
                  }}
                />
                {periods
                  .filter((period) => settings[period].enabled)
                  .map((period) => (
                    <IconButton
                      key={period}
                      icon={commandIcons[`${period}Note`]}
                      label={t(`${period}Note`)}
                      keys={keysOf(`${period}Note`)}
                      ariaKeys={ariaOf(`${period}Note`)}
                      onClick={() => {
                        openPeriodic(period);
                      }}
                    />
                  ))}
              </div>
              {notice === undefined ? null : (
                <p className="notice sidebar-notice" role="status">
                  <span className="sidebar-notice-text">
                    {notice.text}
                    {notice.restore === undefined ? null : (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => {
                          const where = notice.restore;
                          if (where === undefined) return;
                          const fail = (error: unknown) => {
                            setNotice({
                              text: error instanceof Error ? error.message : String(error),
                            });
                          };
                          if (typeof where === "string") {
                            state.vault.restore(where).then(openRestored, fail);
                            return;
                          }
                          // A folder's notes and files, each back where it was, one at a time.
                          void (async () => {
                            for (const item of where) await state.vault.restore(item);
                            setNotice(undefined);
                          })().catch(fail);
                        }}
                      >
                        {t("restore")}
                      </button>
                    )}
                  </span>
                  <button
                    type="button"
                    className="quiet notice-dismiss"
                    aria-label={t("dismiss")}
                    title={t("dismiss")}
                    onClick={() => {
                      setNotice(undefined);
                    }}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </p>
              )}
              <div className="sidebar-tabs">
                <button
                  type="button"
                  aria-pressed={panel === "notes"}
                  onClick={() => {
                    setPanel("notes");
                  }}
                >
                  {t("notes")}
                </button>
                <button
                  type="button"
                  aria-pressed={panel === "search"}
                  aria-keyshortcuts={ariaOf("search")}
                  onClick={() => {
                    setPanel("search");
                  }}
                >
                  {t("search")}
                </button>
                <button
                  type="button"
                  aria-pressed={panel === "trash"}
                  onClick={() => {
                    setPanel("trash");
                  }}
                >
                  {t("trash")}
                </button>
                {aiReady ? (
                  <button
                    type="button"
                    aria-pressed={panel === "ask"}
                    onClick={() => {
                      setPanel("ask");
                    }}
                  >
                    {t("askTab")}
                  </button>
                ) : null}
                {sidebarPanels.map((each) => (
                  <button
                    key={each.id}
                    type="button"
                    aria-pressed={panel === each.id}
                    onClick={() => {
                      setPanel(each.id);
                    }}
                  >
                    {each.name()}
                  </button>
                ))}
              </div>
              {shownPanel !== undefined ? (
                <SidebarPanel
                  key={shownPanel.id}
                  processor={shownPanel}
                  viewProps={{
                    vault: state.vault,
                    graph: state.indexer.graph,
                    openNote,
                    openTag: showTag,
                    askMyName: () => {
                      setNamingMe(true);
                    },
                  }}
                />
              ) : panel === "trash" ? (
                <TrashPanel vault={state.vault} policy={trashPolicy} onRestored={openRestored} />
              ) : panel === "ask" && ai.resolution.provider !== undefined ? (
                <Suspense fallback={null}>
                  <AskPanel
                    vault={state.vault}
                    provider={ai.resolution.provider}
                    workspaceId={sync.link?.workspaceId}
                    through={
                      ai.settings.server === undefined || sync.link === undefined
                        ? undefined
                        : hostOf(sync.link.server)
                    }
                    allowedNow={ai.allowedNow}
                    meaning={askMeaning}
                    meaningVia={askMeaningVia}
                    turns={askTurns}
                    onTurns={setAskTurns}
                    onOpen={openNote}
                    focusRequest={askFocus}
                  />
                </Suspense>
              ) : panel === "search" ? (
                <SearchPanel
                  vault={state.vault}
                  graph={state.indexer.graph}
                  onOpen={openNote}
                  input={searchInput}
                  meaning={meaning.panel}
                />
              ) : notes.length === 0 && folders.length === 0 ? (
                <p className="placeholder">{t("noNotes")}</p>
              ) : (
                <>
                  {tag === undefined ? null : (
                    <p className="filter">
                      {t("taggedWith", { tag })}
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => {
                          setTag(undefined);
                        }}
                      >
                        {t("allNotes")}
                      </button>
                    </p>
                  )}
                  {tag === undefined && bookmarks.list.length > 0 ? (
                    <BookmarkList
                      vault={state.vault}
                      bookmarks={bookmarks.list}
                      selected={selected}
                      onOpen={openNote}
                      onRemove={toggleBookmark}
                      onMenu={openMenu}
                      menuFor={menu?.id}
                      storageKey={`nether.bookmarks.${info.id}`}
                    />
                  ) : null}
                  {tag === undefined ? (
                    <div className="view-switch" role="group" aria-label={t("notesView")}>
                      {notesViews.map((view) => (
                        <button
                          key={view}
                          type="button"
                          aria-pressed={notesView === view}
                          onClick={() => {
                            setNotesView(view);
                            storeView(view);
                          }}
                        >
                          {t(`view_${view}`)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {tag !== undefined || notesView === "list" ? (
                    <NoteList
                      notes={shown}
                      selected={selected}
                      onSelect={openNote}
                      onMenu={openMenu}
                      onOpenInNewTab={openInTab}
                      menuFor={menu?.id}
                      label={t("notes")}
                    />
                  ) : (
                    <NoteTree
                      notes={notes}
                      mode={notesView}
                      selected={selected}
                      onSelect={openNote}
                      onMove={moveInTree}
                      onNewIn={newNoteIn}
                      onMenu={openMenu}
                      folders={folders}
                      files={viewFiles}
                      onOpenFile={(path, newTab) => {
                        openFile(path, newTab ? "tab" : "here");
                      }}
                      onFileMenu={(path, at) => {
                        setFileMenu({ path, at });
                      }}
                      selectedFile={filePathOf(activeTab(layout))}
                      fileMenuFor={fileMenu?.path}
                      onFolderMenu={openFolderMenu}
                      folderMenuFor={folderMenu?.path}
                      onOpenInNewTab={openInTab}
                      menuFor={menu?.id}
                      label={t("notes")}
                      storageKey={`nether.tree.${info.id}.${notesView}`}
                    />
                  )}
                  <p className="count" role="status">
                    {notes.length === 1
                      ? t("oneNote")
                      : t("noteCount", { count: numbers.format(notes.length) })}
                  </p>
                </>
              )}
              <IndexStatus indexer={state.indexer} />
              {sync.link === undefined ? null : (
                <p className="notify-line">
                  <button
                    type="button"
                    className="quiet"
                    aria-haspopup="dialog"
                    onClick={() => {
                      setDialog("notifications");
                    }}
                  >
                    {notifications.unread === 0
                      ? t("notifications")
                      : t("notificationsUnread", { count: notifications.unread })}
                  </button>
                </p>
              )}
              {sync.link === undefined ? null : (
                <p className="sync-line" aria-live="polite">
                  <button
                    type="button"
                    className="quiet"
                    aria-haspopup="dialog"
                    onClick={() => {
                      setDialog("sync");
                    }}
                  >
                    {syncSummary(sync.link, sync.status, sync.signedOut, sync.problem)}
                  </button>
                </p>
              )}
            </>
          )}
        </aside>
        {drawerOpen ? (
          // A tap beside the open drawer closes it; its button and Escape do too.
          <div
            className="drawer-scrim"
            aria-hidden="true"
            onClick={() => {
              setDrawer(false);
            }}
          />
        ) : null}
        {phone ? (
          <Suspense fallback={<div className="phone-bar" />}>
            <PhoneBar
              title={
                (selected === undefined ? undefined : vault?.note(selected)?.title) ?? info.name
              }
              drawerOpen={drawerOpen}
              inert={drawerOpen}
              onDrawer={() => {
                setDrawer((open) => !open);
              }}
              onSwitcher={() => {
                setSwitcher(true);
              }}
              onPalette={() => {
                setDialog("palette");
              }}
            />
          </Suspense>
        ) : null}
        {switcher && state.status === "open" ? (
          <QuickSwitcher
            vault={state.vault}
            graph={state.indexer.graph}
            onOpen={openNote}
            onClose={() => {
              setSwitcher(false);
            }}
          />
        ) : null}
        {dialog === "newNote" && state.status === "open" ? (
          <NewNoteDialog
            notes={notes}
            folder={newIn}
            settings={settings}
            onCreate={(path, template) => makeNote(path, template, new Date())}
            onClose={() => {
              setDialog(undefined);
            }}
          />
        ) : null}
        {dialog === "build" && state.status === "open" && ai.resolution.provider !== undefined ? (
          <Suspense fallback={null}>
            <BuildDialog
              vault={state.vault}
              provider={ai.resolution.provider}
              workspaceId={sync.link?.workspaceId}
              through={
                ai.settings.server === undefined || sync.link === undefined
                  ? undefined
                  : hostOf(sync.link.server)
              }
              allowedNow={ai.allowedNow}
              templatesFolder={settings.folder}
              onOpen={(path) => {
                const note = state.vault.noteAt(path);
                if (note !== undefined) openNote(note.id);
              }}
              onClose={() => {
                setDialog(undefined);
              }}
            />
          </Suspense>
        ) : null}
        {dialog === "import" && state.status === "open" ? (
          <Suspense fallback={null}>
            <ImportDialog
              vault={state.vault}
              importer={state.importer}
              onOpen={(path) => {
                const note = state.vault.noteAt(path);
                setDialog(undefined);
                if (note !== undefined) openNote(note.id);
              }}
              onClose={() => {
                setDialog(undefined);
              }}
            />
          </Suspense>
        ) : null}
        {dialog === "sync" && state.status === "open" ? (
          <Suspense fallback={null}>
            <SyncDialog
              vault={state.vault}
              sync={sync}
              onServers={() => {
                setDialog("servers");
              }}
              onClose={() => {
                setDialog(undefined);
              }}
            />
          </Suspense>
        ) : null}
        {dialog === "spaces" && sync.link !== undefined && state.status === "open" ? (
          <Suspense fallback={null}>
            <SpacesDialog
              link={sync.link}
              folders={[
                ...new Set(
                  state.vault
                    .notes()
                    .flatMap((entry) =>
                      entry.path.includes("/")
                        ? [entry.path.slice(0, entry.path.indexOf("/"))]
                        : [],
                    ),
                ),
              ].sort()}
              onClose={() => {
                setDialog(undefined);
              }}
            />
          </Suspense>
        ) : null}
        {dialog === "share" &&
        sync.link !== undefined &&
        state.status === "open" &&
        selected !== undefined
          ? (() => {
              const note = state.vault.note(selected);
              return note === undefined ? null : (
                <Suspense fallback={null}>
                  <ShareDialog
                    link={sync.link}
                    note={note}
                    onClose={() => {
                      setDialog(undefined);
                    }}
                  />
                </Suspense>
              );
            })()
          : null}
        {dialog === "notifications" && sync.link !== undefined && state.status === "open" ? (
          <Suspense fallback={null}>
            <NotificationsDialog
              link={sync.link}
              notifications={notifications}
              hasNote={(id) => state.vault.note(id as NoteId) !== undefined}
              onOpen={(id, thread) => {
                setDialog(undefined);
                const key = openNote(id as NoteId);
                if (thread !== undefined) {
                  ask(key, (current) => ({
                    ...current,
                    thread: { thread, key: (current.thread?.key ?? 0) + 1 },
                  }));
                }
              }}
              onClose={() => {
                setDialog(undefined);
              }}
            />
          </Suspense>
        ) : null}
        {dialog === "members" && sync.link !== undefined ? (
          <Suspense fallback={null}>
            <MembersDialog
              link={sync.link}
              onLeft={() => {
                setDialog(undefined);
                void sync.unlink();
              }}
              onClose={() => {
                setDialog(undefined);
              }}
            />
          </Suspense>
        ) : null}
        {dialog === "servers" ? (
          <Suspense fallback={null}>
            <ServersDialog
              onClose={() => {
                setDialog(undefined);
              }}
              onTokens={(server) => {
                setTokensServer(server);
                setDialog("tokens");
              }}
            />
          </Suspense>
        ) : null}
        {dialog === "tokens" && tokensServer !== undefined ? (
          <Suspense fallback={null}>
            <TokensDialog
              server={tokensServer}
              onClose={() => {
                setDialog(undefined);
              }}
            />
          </Suspense>
        ) : null}
        {dialog === "webhooks" && sync.link !== undefined ? (
          <Suspense fallback={null}>
            <WebhooksDialog
              link={sync.link}
              onClose={() => {
                setDialog(undefined);
              }}
            />
          </Suspense>
        ) : null}
        {dialog === "settings" && state.status === "open" ? (
          <SettingsDialog
            tabs={settingsTabs(state.vault)}
            tab={settingsTab}
            onTab={setSettingsTab}
            onClose={closeDialog}
          />
        ) : null}
        {fileMenu === undefined || state.status !== "open" ? null : (
          <ContextMenu
            label={t("canvasMenu", { name: fileMenu.path })}
            at={fileMenu.at}
            entries={fileEntries(fileMenu.path)}
            onClose={() => {
              setFileMenu(undefined);
            }}
          />
        )}
        {folderMenu === undefined || state.status !== "open" ? null : (
          <ContextMenu
            label={t("folderMenu", { name: folderMenu.path })}
            at={folderMenu.at}
            entries={folderEntries(folderMenu.path)}
            onClose={closeFolderMenu}
          />
        )}
        {deletingFolder === undefined || state.status !== "open" ? null : (
          <DeleteFolderDialog
            path={deletingFolder}
            notes={notes.filter((note) => note.path.startsWith(`${deletingFolder}/`)).length}
            files={
              state.vault
                .files()
                .filter(
                  (file) =>
                    file.startsWith(`${deletingFolder}/`) && state.vault.noteAt(file) === undefined,
                ).length
            }
            onDelete={() => deleteFolder(deletingFolder)}
            onClose={() => {
              setDeletingFolder(undefined);
            }}
          />
        )}
        {namingMe ? (
          <TextPromptDialog
            title={t("myNameTitle")}
            label={t("myNameLabel")}
            value={myName()}
            onSubmit={setMyName}
            onClose={() => {
              setNamingMe(false);
            }}
          />
        ) : null}
        {newFolderIn === undefined || state.status !== "open" ? null : (
          <NewFolderDialog
            folder={newFolderIn}
            taken={pathTaken}
            onCreate={(path) => state.vault.makeFolder(path)}
            onClose={() => {
              setNewFolderIn(undefined);
            }}
          />
        )}
        {menu === undefined || state.status !== "open" ? null : (
          <ContextMenu
            label={t("noteMenu", { name: state.vault.note(menu.id)?.title ?? "" })}
            at={menu.at}
            entries={menuEntries(menu.id)}
            onClose={closeMenu}
          />
        )}
        {noteDialog === undefined || state.status !== "open"
          ? null
          : (() => {
              const note = state.vault.note(noteDialog.id);
              if (note === undefined) return null;
              const close = () => {
                setNoteDialog(undefined);
              };
              switch (noteDialog.kind) {
                case "rename":
                  return (
                    <RenameNoteDialog
                      note={note}
                      onRename={(name) => renameCurrent(note.id, name)}
                      onClose={close}
                    />
                  );
                case "move":
                  return (
                    <MoveNoteDialog
                      note={note}
                      folders={vaultFolders(state.vault.files())}
                      onMove={(folder) => {
                        moveInTree({ kind: "note", path: note.path }, folder);
                        return Promise.resolve();
                      }}
                      onClose={close}
                    />
                  );
                case "merge":
                  return (
                    <MergeNoteDialog
                      note={note}
                      notes={notes}
                      onMerge={(into) => mergeInto(note.id, into)}
                      onClose={close}
                    />
                  );
                case "tags":
                  return (
                    <NoteTagsDialog
                      vault={state.vault}
                      note={note}
                      known={state.indexer.graph.tags().map((entry) => entry.tag)}
                      onClose={close}
                    />
                  );
              }
            })()}
        {dialog === "export" && state.status === "open" && selected !== undefined
          ? (() => {
              const note = state.vault.note(selected);
              return note === undefined ? null : (
                <ExportDialog
                  vault={state.vault}
                  vaultName={info.name}
                  graph={state.indexer.graph}
                  media={state.media}
                  exporter={state.exporter}
                  codeBlocks={codeBlocks}
                  note={note}
                  notes={notes}
                  policy={exportPolicy}
                  onClose={() => {
                    setDialog(undefined);
                  }}
                />
              );
            })()
          : null}
        {dialog === "history" && state.status === "open" && selected !== undefined
          ? (() => {
              const note = state.vault.note(selected);
              return note === undefined ? null : (
                <Suspense fallback={null}>
                  <HistoryDialog
                    vault={state.vault}
                    note={note}
                    link={sync.link}
                    onClose={() => {
                      setDialog(undefined);
                    }}
                  />
                </Suspense>
              );
            })()
          : null}
        {dialog === "palette" ? (
          <CommandPalette
            commands={commands
              .filter((command) => command.enabled() && !(phone && notOnPhones.has(command.id)))
              .map((command) => ({
                id: command.id,
                name: (command.nameNow ?? command.name)(),
                keys: hotkeys[command.id] ?? [],
              }))}
            onRun={(id) => {
              registry.get(id)?.run();
            }}
            onClose={() => {
              setDialog(undefined);
            }}
          />
        ) : null}
        <main className="pane" inert={drawerOpen}>
          {state.status === "open" && shownView !== undefined ? (
            <PaneViewOutput
              processor={shownView}
              loading={
                <p className="placeholder">
                  {shownView.id === graphView ? t("loadingGraph") : null}
                </p>
              }
              viewProps={{
                vault: state.vault,
                graph: state.indexer.graph,
                media: state.media,
                ...(selected === undefined ? {} : { note: selected }),
                openNote,
                close: () => {
                  setPaneView(undefined);
                },
              }}
            />
          ) : state.status === "open" && layout.panes.some((pane) => pane.tabs.length > 0) ? (
            noteView === undefined ? null : (
              <div className={`panes${!phone && layout.panes.length > 1 ? " split" : ""}`}>
                {layout.panes.map((pane, index) => {
                  // A phone shows the focused pane alone, without its tabs.
                  if (phone && index !== layout.focused) return null;
                  const shown = shownIn(pane);
                  const id = noteOf(shown);
                  const file = filePathOf(shown);
                  const fileView = file === undefined ? undefined : views.forFile(file);
                  const paneAsks = asks[pane.key] ?? noAsks;
                  const split = !phone && layout.panes.length > 1;
                  const side = index === 0 ? "Left" : "Right";
                  const panelId = `pane-${String(pane.key)}`;
                  const tabId = (tab: number) => `pane-${String(pane.key)}-tab-${String(tab)}`;
                  const focusHere = () => {
                    changeLayout((current) => focusPane(current, index));
                  };
                  return (
                    <section
                      key={pane.key}
                      className={`note-pane${split && index === layout.focused ? " focused" : ""}`}
                      aria-label={split ? t(`pane${side}`) : undefined}
                      onFocusCapture={focusHere}
                      onMouseDownCapture={focusHere}
                    >
                      {phone ? null : (
                        <TabStrip
                          pane={pane}
                          label={split ? t(`openNotes${side}`) : t("openNotes")}
                          panelId={panelId}
                          tabId={tabId}
                          titleOf={(tab) => {
                            const file = filePathOf(tab);
                            return file === undefined
                              ? (state.vault.note(tab as NoteId)?.title ?? "")
                              : file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
                          }}
                          onChoose={(tab) => {
                            changeLayout((current) => chooseTab(current, index, tab));
                          }}
                          onClose={(tab) => {
                            changeLayout((current) => closeTab(current, index, tab));
                          }}
                          onMenu={(tab, at) => {
                            const file = filePathOf(tab);
                            if (file === undefined) openMenu(tab as NoteId, at);
                            else setFileMenu({ path: file, at });
                          }}
                        />
                      )}
                      <div
                        className={`pane-body${file === undefined ? "" : " view-body"}`}
                        {...(phone
                          ? {}
                          : {
                              role: "tabpanel",
                              id: panelId,
                              "aria-labelledby": tabId(pane.active),
                            })}
                      >
                        {file !== undefined ? (
                          fileView === undefined ? (
                            <p className="placeholder">
                              {t("noViewFor", { extension: extensionOf(file) })}
                            </p>
                          ) : (
                            <PaneViewOutput
                              key={file}
                              processor={fileView}
                              viewProps={{
                                vault: state.vault,
                                graph: state.indexer.graph,
                                media: state.media,
                                path: file,
                                at: paneAsks.at,
                                linksLoaded,
                                openNote,
                                close: () => undefined,
                              }}
                            />
                          )
                        ) : id === undefined ? (
                          <p className="placeholder">{t("selectNote")}</p>
                        ) : (
                          <noteView.default
                            live={sync.live}
                            vault={state.vault}
                            media={state.media}
                            exporter={state.exporter}
                            graph={state.indexer.graph}
                            plugins={plugins}
                            id={id}
                            titleId={index === 0 ? "note-title" : "note-title-right"}
                            keyboardBar={phone}
                            focus={paneAsks.focus}
                            onOpenNote={openNote}
                            onOpenFile={openLinkedFile}
                            onOpenTag={showTag}
                            onCreateNote={buttonNote}
                            mode={paneAsks.mode}
                            onMode={(next) => {
                              ask(pane.key, (current) => ({ ...current, mode: next }));
                            }}
                            onTrash={() => {
                              trashNote(id);
                            }}
                            onExport={() => {
                              focusHere();
                              setDialog("export");
                            }}
                            onRename={(name) => renameCurrent(id, name)}
                            sourceRequest={paneAsks.source}
                            renameRequest={paneAsks.rename}
                            sourceKeys={keysOf("toggleSource")}
                            me={sync.me}
                            canComment={sync.levelOf?.(id) !== "view"}
                            commentRequest={paneAsks.comment}
                            commentKeys={keysOf("comment")}
                            {...(ai.resolution.provider === undefined
                              ? {}
                              : {
                                  ai: {
                                    provider: ai.resolution.provider,
                                    request: paneAsks.assist,
                                    allowedNow: ai.allowedNow,
                                    workspaceId: sync.link?.workspaceId,
                                    // The web app's requests go through its server.
                                    through:
                                      ai.settings.server === undefined || sync.link === undefined
                                        ? undefined
                                        : hostOf(sync.link.server),
                                  },
                                })}
                            people={people}
                            onMention={(thread, mentioned, body) => {
                              const link = sync.link;
                              const note = state.vault.note(id);
                              if (link === undefined || note === undefined) return;
                              // An encrypted workspace's server is told who, never what.
                              const text =
                                link.encrypted === true
                                  ? {}
                                  : {
                                      title: note.title.slice(0, 200),
                                      excerpt: body.slice(0, 500),
                                    };
                              void queueMention(state.vault.settings, {
                                server: link.server,
                                workspaceId: link.workspaceId,
                                note: id,
                                thread,
                                people: mentioned.map((person) => person.id),
                                ...text,
                              }).then(notifications.refresh);
                            }}
                            {...(paneAsks.thread === undefined
                              ? {}
                              : { threadRequest: paneAsks.thread })}
                            onShown={loadLinks}
                          />
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            )
          ) : (
            <p className="placeholder">{t("selectNote")}</p>
          )}
        </main>
      </div>
    </ExportPolicyContext.Provider>
  );
}
