// The clipper's popup (ADR 0066). The first time, it asks for the person's
// Nether server and a write token, and the browser for that one origin.
// Then, each time its button is pressed, it reads the tab it was pressed
// on, the selection or the whole page, shows the Markdown to edit, and
// saves it as a new note, added to a note, or a database row, in a
// workspace the token reaches. Nothing goes anywhere but that server.
import {
  type Connection,
  type Listed,
  type Workspace,
  Refused,
  account,
  addRow,
  changeNote,
  databases,
  findNotes,
  makeNote,
  originPattern,
  serverAddress,
  workspaces,
} from "./api.ts";
import { type Extension, type Kept, extension, kept } from "./browser.ts";
import {
  appendedText,
  clipPath,
  clipProperties,
  clipTitle,
  newNoteText,
  pageMarkdown,
} from "./clip.ts";
import { type MessageKey, t } from "./messages.ts";
import type { Page } from "./page.ts";

type Destination = "note" | "append" | "row";

const browser = extension();

/** Makes an element, with its attributes and children. */
function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string | boolean>> = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === true) element.setAttribute(name, "");
    else if (value !== false) element.setAttribute(name, value);
  }
  element.append(...children);
  return element;
}

let fields = 0;

/**
 * A control with its label beside it, by `for`: a label around a list would
 * take the list's chosen option into its name.
 */
function field(label: MessageKey, control: HTMLElement): HTMLDivElement {
  fields += 1;
  control.id = `field-${String(fields)}`;
  return make("div", { class: "field" }, [make("label", { for: control.id }, [t(label)]), control]);
}

/** A radio button with its label, in a group by `name`. */
function choice(name: string, value: string, label: MessageKey, checked: boolean) {
  const input = make("input", { type: "radio", name, value, checked });
  return { input, label: make("label", { class: "choice" }, [input, t(label)]) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function show(...children: Node[]): void {
  const root = document.getElementById("popup");
  root?.replaceChildren(...children);
}

/** The tab the clip is of: the one the button was pressed on, or the one a test names. */
async function targetTab(api: Extension): Promise<number> {
  const named = Number(new URLSearchParams(location.search).get("tab"));
  if (Number.isInteger(named) && named > 0) return named;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error(t("cannotRead"));
  return tab.id;
}

/** Reads the tab, in the tab: its selection unless `whole`, else its article. */
async function readTab(api: Extension, tab: number, whole: boolean): Promise<Page> {
  try {
    await api.scripting.executeScript({ target: { tabId: tab }, files: ["content.js"] });
    const [ran] = await api.scripting.executeScript({
      target: { tabId: tab },
      func: (asked: boolean) =>
        (globalThis as { netherReadPage?: (whole: boolean) => unknown }).netherReadPage?.(asked),
      args: [whole],
    });
    const page = ran?.result as Page | undefined;
    if (page === undefined) throw new Error(t("cannotRead"));
    return page;
  } catch {
    throw new Error(t("cannotRead"));
  }
}

function showSetup(state: Kept, problem?: string): void {
  const server = make("input", {
    type: "text",
    autocomplete: "url",
    required: true,
    value: state.server ?? "",
    placeholder: "nether.example.org",
  });
  const token = make("input", { type: "password", autocomplete: "off", required: true });
  const alert = make("p", { role: "alert" }, problem === undefined ? [] : [problem]);
  const button = make("button", { type: "submit", class: "primary" }, [t("connect")]);
  const form = make("form", { "aria-labelledby": "setup-title" }, [
    make("h1", { id: "setup-title" }, [t("title")]),
    make("p", { class: "hint" }, [t("setupHint")]),
    field("server", server),
    field("token", token),
    button,
    alert,
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const address = serverAddress(server.value);
    if (address === undefined) {
      alert.textContent = t("serverInvalid");
      return;
    }
    // Asked for at once, while the press still counts as the person's.
    const granted = browser.permissions.request({ origins: [originPattern(address)] });
    button.disabled = true;
    void (async () => {
      try {
        if (!(await granted)) throw new Error(t("permissionRefused", { server: address }));
        const connection = { server: address, token: token.value.trim(), fetch };
        const who = await account(connection);
        if (who.access !== "write") throw new Error(t("readToken"));
        await browser.storage.local.set({
          server: address,
          token: connection.token,
          name: who.name,
        });
        await showClip({ ...state, server: address, token: connection.token, name: who.name });
      } catch (error) {
        alert.textContent = messageOf(error);
        button.disabled = false;
      }
    })();
  });
  show(form);
  server.focus();
}

async function showClip(state: Kept): Promise<void> {
  if (state.server === undefined || state.token === undefined) {
    showSetup(state);
    return;
  }
  const server = state.server;
  const connection: Connection = { server, token: state.token, fetch };
  const status = make("p", { role: "status" });
  const alert = make("p", { role: "alert" });
  const fail = (error: unknown) => {
    status.textContent = "";
    alert.textContent = messageOf(error);
  };

  const disconnect = make("button", { type: "button" }, [t("disconnect")]);
  disconnect.addEventListener("click", () => {
    void (async () => {
      await browser.storage.local.remove(["server", "token", "name"]);
      await browser.permissions.remove({ origins: [originPattern(server)] }).catch(() => false);
      showSetup({});
    })();
  });
  const header = make("div", { class: "account" }, [
    make("p", { class: "hint" }, [
      t("signedInAs", { server: new URL(server).host, name: state.name ?? "" }),
    ]),
    disconnect,
  ]);

  const selection = choice("what", "selection", "theSelection", true);
  const whole = choice("what", "whole", "theWholePage", false);
  const workspace = make("select");
  const destination = (state.destination ?? "note") as Destination;
  const asNote = choice("destination", "note", "newNote", destination === "note");
  const asAppend = choice("destination", "append", "addToNote", destination === "append");
  const asRow = choice("destination", "row", "databaseRow", destination === "row");
  const folder = make("input", { type: "text", value: state.folder ?? "Clips" });
  const title = make("input", { type: "text", required: true });
  const search = make("input", { type: "search" });
  const findButton = make("button", { type: "button" }, [t("find")]);
  const notes = make("select");
  const database = make("select");
  const markdown = make("textarea", { spellcheck: false });
  const save = make("button", { type: "submit", class: "primary" }, [t("save")]);

  const folderField = field("folder", folder);
  const titleField = field("noteTitle", title);
  const findField = make("div", { class: "row" }, [field("findNote", search), findButton]);
  const notesField = field("note", notes);
  const databaseField = field("database", database);
  const form = make("form", { "aria-labelledby": "clip-title" }, [
    make("h1", { id: "clip-title" }, [t("title")]),
    header,
    make("fieldset", {}, [make("legend", {}, [t("clip")]), selection.label, whole.label]),
    field("workspace", workspace),
    make("fieldset", {}, [
      make("legend", {}, [t("saveAs")]),
      asNote.label,
      asAppend.label,
      asRow.label,
    ]),
    folderField,
    findField,
    notesField,
    databaseField,
    titleField,
    field("markdown", markdown),
    save,
    status,
    alert,
  ]);
  show(form);
  status.textContent = t("reading");

  let page: Page | undefined;
  let spaces: readonly Workspace[] = [];
  let found: readonly Listed[] = [];
  let rows: readonly Listed[] = [];
  const chosen = (): Destination =>
    asAppend.input.checked ? "append" : asRow.input.checked ? "row" : "note";

  const layout = () => {
    const where = chosen();
    folderField.hidden = where !== "note";
    titleField.hidden = where === "append";
    findField.hidden = where !== "append";
    notesField.hidden = where !== "append" || found.length === 0;
    databaseField.hidden = where !== "row";
    title.required = where !== "append";
  };

  const loadDatabases = async () => {
    database.replaceChildren();
    if (chosen() !== "row" || workspace.value === "") return;
    rows = await databases(connection, workspace.value);
    database.append(
      ...(rows.length === 0
        ? [make("option", { value: "" }, [t("noDatabases")])]
        : rows.map((item) => make("option", { value: item.id }, [item.title]))),
    );
  };

  for (const item of [asNote, asAppend, asRow]) {
    item.input.addEventListener("change", () => {
      layout();
      loadDatabases().catch(fail);
    });
  }
  workspace.addEventListener("change", () => {
    found = [];
    notes.replaceChildren();
    layout();
    loadDatabases().catch(fail);
  });

  const find = async () => {
    found = await findNotes(connection, workspace.value, search.value);
    notes.replaceChildren(
      ...(found.length === 0
        ? [make("option", { value: "" }, [t("noNotes")])]
        : found.map((item) =>
            make("option", { value: item.id }, [`${item.title} (${item.path})`]),
          )),
    );
    notesField.hidden = false;
  };
  findButton.addEventListener("click", () => {
    find().catch(fail);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      find().catch(fail);
    }
  });

  const tab = await targetTab(browser).catch((error: unknown) => {
    fail(error);
    return undefined;
  });
  const read = async (all: boolean) => {
    if (tab === undefined) return;
    page = await readTab(browser, tab, all);
    selection.input.disabled = !page.hasSelection;
    selection.input.checked = page.selected;
    whole.input.checked = !page.selected;
    markdown.value = pageMarkdown(page);
    title.value = clipTitle(page.title === "" ? new URL(page.url).host : page.title);
    status.textContent = "";
  };
  for (const item of [selection, whole]) {
    item.input.addEventListener("change", () => {
      read(whole.input.checked).catch(fail);
    });
  }

  try {
    spaces = (await workspaces(connection)).filter((item) => !item.encrypted);
    workspace.append(...spaces.map((item) => make("option", { value: item.id }, [item.name])));
    if (spaces.some((item) => item.id === state.workspace)) workspace.value = state.workspace ?? "";
    if (spaces.length === 0) throw new Error(t("noWorkspaces"));
    layout();
    await loadDatabases();
    await read(false);
  } catch (error) {
    if (error instanceof Refused && error.status === 401) {
      showSetup(state, error.message);
      return;
    }
    fail(error);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (page === undefined || workspace.value === "") return;
    const clipped = page;
    const where = chosen();
    const space = spaces.find((item) => item.id === workspace.value);
    save.disabled = true;
    alert.textContent = "";
    status.textContent = t("saving");
    void (async () => {
      try {
        const now = new Date();
        let saved: Listed;
        if (where === "note") {
          saved = await makeNote(
            connection,
            workspace.value,
            clipPath(folder.value, title.value),
            newNoteText(clipped, markdown.value, now),
          );
        } else if (where === "append") {
          if (notes.value === "") throw new Error(t("chooseNote"));
          saved = await changeNote(connection, workspace.value, notes.value, (existing) =>
            appendedText(existing, clipped, markdown.value),
          );
        } else {
          saved = await addRow(connection, workspace.value, database.value, {
            title: clipTitle(title.value),
            properties: clipProperties(clipped, now),
            markdown: markdown.value,
          });
        }
        await browser.storage.local.set({
          workspace: workspace.value,
          destination: where,
          folder: folder.value,
        });
        status.textContent = t("savedTo", { path: saved.path, workspace: space?.name ?? "" });
      } catch (error) {
        fail(error);
      } finally {
        save.disabled = false;
      }
    })();
  });
}

void kept(browser).then(showClip, (error: unknown) => {
  showSetup({}, messageOf(error));
});
