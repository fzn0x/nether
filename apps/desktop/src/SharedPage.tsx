// The page a share link opens in the web app (ADR 0071): the link's
// password when it has one, then the shared page and its subpages, as the
// server syncs them to the link's visit: read-only for a view link; live,
// with their comments, for a comment link; live and editable, with the
// others' carets, for an edit link. A visitor who writes gives a name
// first, which their comments and their caret carry. The visit is the
// server's, in a cookie the page cannot read; the token leaves the
// address once it is used, and a reload finds the visit again.
import {
  type CommentAnchor,
  type CommentAuthor,
  type CommentThread,
  type NoteCollaboration,
  type NoteCommentsView,
  NoteEditor,
  type NoteFiles,
  observeThreads,
  readThreads,
} from "@nether/editor";
import { LinkIndex } from "@nether/storage";
import { HocuspocusChannel, vaultFiles } from "@nether/sync-client";
import { type SyntheticEvent, useEffect, useMemo, useState } from "react";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { CommentsPanel } from "./CommentsPanel.tsx";
import { t } from "./messages.ts";
import { colorFor } from "./presence.ts";
import { messageOf, webServer } from "./web.ts";

/** What a link lets its visitors do: read, comment, or edit. */
type Level = "view" | "comment" | "edit";

/** What a visit opens, as the server says. */
interface Opened {
  readonly workspace: string;
  readonly unit: string;
  readonly document: string;
  readonly page: string;
  readonly level: Level;
}

type Step =
  | { readonly status: "opening" }
  | { readonly status: "password"; readonly token: string; readonly wrong: boolean }
  | { readonly status: "gone"; readonly message: string }
  | { readonly status: "open"; readonly opened: Opened };

function isOpened(value: unknown): value is Opened {
  const opened = value as Partial<Opened> | null;
  return (
    typeof opened?.workspace === "string" &&
    typeof opened.unit === "string" &&
    typeof opened.document === "string" &&
    typeof opened.page === "string" &&
    (opened.level === "view" || opened.level === "comment" || opened.level === "edit")
  );
}

/** Opens a link with its token, and its password if given. */
async function open(
  token: string,
  password?: string,
): Promise<Opened | { readonly status: number; readonly message: string }> {
  const answer = await fetch(`${webServer}/api/links/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(password === undefined ? { token } : { token, password }),
    credentials: "same-origin",
  });
  if (!answer.ok) return { status: answer.status, message: await messageOf(answer) };
  const body: unknown = await answer.json();
  if (!isOpened(body)) throw new Error("The server's answer is not a page.");
  return body;
}

/** The visit this browser's cookie carries, if it still opens something. */
async function visit(): Promise<Opened | undefined> {
  const answer = await fetch(`${webServer}/api/links/visit`, { credentials: "same-origin" });
  if (!answer.ok) return undefined;
  const body: unknown = await answer.json();
  return isOpened(body) ? body : undefined;
}

/** A note's title: its file's name, without its folder or `.md`. */
function titleOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

export function SharedPage() {
  const [step, setStep] = useState<Step>({ status: "opening" });
  const [password, setPassword] = useState("");

  useEffect(() => {
    let current = true;
    const token = location.hash.slice(1);
    // The token leaves the address, and the history, once it is read.
    if (token !== "") history.replaceState(null, "", location.pathname);
    const start =
      token === ""
        ? visit().then((found) =>
            found === undefined
              ? ({ status: "gone", message: t("sharedGone") } as const)
              : ({ status: "open", opened: found } as const),
          )
        : open(token).then((opened) =>
            "status" in opened
              ? opened.status === 401
                ? ({ status: "password", token, wrong: false } as const)
                : ({ status: "gone", message: opened.message } as const)
              : ({ status: "open", opened } as const),
          );
    start.then(
      (next) => {
        if (current) setStep(next);
      },
      (reason: unknown) => {
        if (current) {
          setStep({ status: "gone", message: t("sharedUnreachable", { message: String(reason) }) });
        }
      },
    );
    return () => {
      current = false;
    };
  }, []);

  if (step.status === "opening") {
    return (
      <main className="shared">
        <p role="status">{t("sharedOpening")}</p>
      </main>
    );
  }
  if (step.status === "gone") {
    return (
      <main className="shared">
        <p role="alert">{step.message}</p>
      </main>
    );
  }
  if (step.status === "password") {
    const submit = (event: SyntheticEvent) => {
      event.preventDefault();
      const { token } = step;
      open(token, password).then(
        (opened) => {
          if (!("status" in opened)) setStep({ status: "open", opened });
          else if (opened.status === 401) setStep({ status: "password", token, wrong: true });
          else setStep({ status: "gone", message: opened.message });
        },
        (reason: unknown) => {
          setStep({ status: "gone", message: t("sharedUnreachable", { message: String(reason) }) });
        },
      );
    };
    return (
      <main className="shared">
        <form className="shared-password" onSubmit={submit}>
          <p>{t("sharedPasswordIntro")}</p>
          <label className="field">
            {t("password")}
            <input
              type="password"
              value={password}
              autoComplete="off"
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          </label>
          {step.wrong ? <p role="alert">{t("sharedWrongPassword")}</p> : null}
          <button type="submit" className="primary">
            {t("sharedOpen")}
          </button>
        </form>
      </main>
    );
  }
  return <Visitor opened={step.opened} />;
}

/** Where this browser keeps who its visitor is: the name they gave, and an ID of their own. */
const visitorKey = "nether.visitor";

function keptVisitor(): CommentAuthor | undefined {
  try {
    const kept = JSON.parse(localStorage.getItem(visitorKey) ?? "null") as Partial<
      Record<string, unknown>
    > | null;
    if (typeof kept?.id === "string" && typeof kept.name === "string" && kept.name !== "") {
      return { id: kept.id, name: kept.name };
    }
  } catch {
    // Storage refused, or a value that does not read, keeps no one.
  }
  return undefined;
}

function keepVisitor(name: string): CommentAuthor {
  const visitor = { id: `visitor-${crypto.randomUUID()}`, name };
  try {
    localStorage.setItem(visitorKey, JSON.stringify(visitor));
  } catch {
    // Kept for this page only, then.
  }
  return visitor;
}

/** A visit that writes asks the visitor's name first, for their comments and their caret. */
function Visitor(props: { readonly opened: Opened }) {
  const { opened } = props;
  const [me, setMe] = useState<CommentAuthor | undefined>(keptVisitor);
  const [name, setName] = useState("");
  if (opened.level === "view" || me !== undefined) return <Visit opened={opened} me={me} />;
  return (
    <main className="shared">
      <form
        className="shared-password"
        onSubmit={(event) => {
          event.preventDefault();
          const given = name.trim();
          if (given !== "") setMe(keepVisitor(given));
        }}
      >
        <p>{t(opened.level === "edit" ? "sharedNameToEdit" : "sharedNameToComment")}</p>
        <label className="field">
          {t("sharedYourName")}
          <input
            type="text"
            value={name}
            required
            autoComplete="name"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        <button type="submit" className="primary">
          {t("sharedOpen")}
        </button>
      </form>
    </main>
  );
}

/** What each level's visitor is told they may do. */
const levelHints = {
  view: "sharedReadOnly",
  comment: "sharedCanComment",
  edit: "sharedCanEdit",
} as const;

/** A visit's page: the shared notes listed, and the one chosen shown as its link allows. */
function Visit(props: { readonly opened: Opened; readonly me: CommentAuthor | undefined }) {
  const { opened, me } = props;
  const [vault] = useState(() => new Y.Doc());
  const [channel, setChannel] = useState<HocuspocusChannel | undefined>();
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(new Map());
  const [chosen, setChosen] = useState<string>(opened.page);
  const [error, setError] = useState<string | undefined>();
  const [stored, setStored] = useState(0);

  useEffect(() => {
    // The visit's cookie signs the socket in, as a session's does in the web app.
    const made = new HocuspocusChannel(
      { server: webServer, token: "", workspaceId: opened.workspace },
      {
        onSynced: () => {
          setError(undefined);
        },
        onStored: () => {
          setStored((count) => count + 1);
        },
        onOffline: (reason) => {
          if (reason !== undefined) setError(reason);
        },
      },
    );
    made.vaults(new Map([[opened.document, vault]]));
    setChannel(made);
    const listed = vault.getMap<string>("notes");
    const read = () => {
      setNotes(new Map([...listed.entries()].sort(([, a], [, b]) => a.localeCompare(b))));
    };
    listed.observe(read);
    read();
    return () => {
      listed.unobserve(read);
      made.close();
    };
  }, [opened, vault]);

  const path = notes.get(chosen);
  const writes = opened.level !== "view" && me !== undefined;
  return (
    <div className={writes ? "shared shared-visit with-comments" : "shared shared-visit"}>
      <nav className="shared-pages" aria-label={t("sharedPages")}>
        <p className="hint">{t(levelHints[opened.level], { name: me?.name ?? "" })}</p>
        <ul>
          {[...notes].map(([id, notePath]) => (
            <li key={id}>
              <button
                type="button"
                aria-current={id === chosen ? "page" : undefined}
                onClick={() => {
                  setChosen(id);
                }}
              >
                {titleOf(notePath)}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="shared-note">
        {error === undefined ? null : <p role="alert">{error}</p>}
        {channel === undefined || path === undefined ? (
          <p role="status">{t("sharedOpening")}</p>
        ) : writes ? (
          <LiveNote
            key={chosen}
            channel={channel}
            opened={opened}
            me={me}
            id={chosen}
            path={path}
            vault={vault}
            paths={[...notes.values()]}
          />
        ) : (
          <SharedNote
            // Read-only, a note is synced again each time the server stores it.
            key={`${chosen}:${String(stored)}`}
            channel={channel}
            opened={opened}
            id={chosen}
            path={path}
            vault={vault}
            paths={[...notes.values()]}
          />
        )}
      </main>
    </div>
  );
}

/** A shared note's images and files, from its workspace's attachments. */
function useFiles(
  vault: Y.Doc,
  paths: readonly string[],
  path: string,
  workspace: string,
): NoteFiles {
  return useMemo((): NoteFiles => {
    const stored = vaultFiles(vault);
    const index = new LinkIndex([...paths, ...stored.keys()]);
    return {
      url(link) {
        const found = index.resolve(link, path);
        const file = found === undefined ? undefined : stored.get(found);
        return file === undefined
          ? undefined
          : `${webServer}/api/workspaces/${workspace}/attachments/${file.blob}`;
      },
    };
  }, [vault, paths, path, workspace]);
}

interface NoteProps {
  readonly channel: HocuspocusChannel;
  readonly opened: Opened;
  readonly id: string;
  readonly path: string;
  readonly vault: Y.Doc;
  readonly paths: readonly string[];
}

/** One shared note, synced once and shown read-only, with its images from the workspace. */
function SharedNote(props: NoteProps) {
  const { channel, opened, id, path, vault, paths } = props;
  const [document] = useState(() => new Y.Doc());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let current = true;
    channel.sync(id, document).then(
      () => {
        if (current) setReady(true);
      },
      (reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [channel, id, document]);

  const files = useFiles(vault, paths, path, opened.workspace);
  if (error !== undefined) return <p role="alert">{error}</p>;
  if (!ready) return <p role="status">{t("sharedOpening")}</p>;
  return (
    <article>
      <h1>{titleOf(path)}</h1>
      <NoteEditor document={document} editable={false} label={titleOf(path)} files={files} />
    </article>
  );
}

/**
 * One shared note for a visitor who writes, live as the others change it,
 * with its comments beside it: editable, with each person's caret, for an
 * edit link; read-only for a comment link, whose visitor comments only.
 */
function LiveNote(props: NoteProps & { readonly me: CommentAuthor }) {
  const { channel, opened, me, id, path, vault, paths } = props;
  const edits = opened.level === "edit";
  const [document] = useState(() => new Y.Doc());
  const [comments] = useState(() => new Y.Doc());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [collaboration, setCollaboration] = useState<NoteCollaboration | undefined>();
  const [threads, setThreads] = useState<readonly CommentThread[]>([]);
  const [active, setActive] = useState<string | undefined>();
  const [draft, setDraft] = useState<CommentAnchor | undefined>();
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let current = true;
    const stops: (() => void)[] = [];
    // Synced first, so the editor opens on the note as it is, not on an empty one.
    channel.sync(id, document).then(
      () => {
        if (!current) return;
        const awareness = new Awareness(document);
        // Only an edit link's visitor has a caret for the others to see.
        if (!edits) awareness.setLocalState(null);
        const note = channel.live(id, document, awareness);
        const quiet = new Awareness(comments);
        quiet.setLocalState(null);
        const noteComments = channel.live(`${id}.comments`, comments, quiet);
        const show = () => {
          setThreads(readThreads(comments));
        };
        stops.push(observeThreads(comments, show), () => {
          note?.stop();
          noteComments?.stop();
          awareness.destroy();
          quiet.destroy();
        });
        show();
        if (edits) setCollaboration({ awareness, user: { name: me.name, color: colorFor(me.id) } });
        setReady(true);
      },
      (reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
      for (const stop of stops) stop();
    };
  }, [channel, id, document, comments, edits, me]);

  const files = useFiles(vault, paths, path, opened.workspace);
  const commentsView = useMemo((): NoteCommentsView => {
    const shown = threads.filter((thread) => thread.resolved === undefined);
    // The text a new thread is being written on shows as the active one.
    return {
      threads:
        draft === undefined
          ? shown
          : [...shown, { id: "", anchor: draft, created: 0, comments: [], resolved: undefined }],
      active: draft === undefined ? active : "",
      onActivate: setActive,
      onComment: setDraft,
      request,
    };
  }, [threads, draft, active, request]);

  if (error !== undefined) return <p role="alert">{error}</p>;
  if (!ready) return <p role="status">{t("sharedOpening")}</p>;
  return (
    <div className="shared-with-comments">
      <article>
        <h1>{titleOf(path)}</h1>
        <button
          type="button"
          className="shared-comment"
          onClick={() => {
            setRequest((count) => count + 1);
          }}
        >
          {t("command_comment")}
        </button>
        <NoteEditor
          document={document}
          editable={edits}
          label={titleOf(path)}
          files={files}
          comments={commentsView}
          {...(collaboration === undefined ? {} : { collaboration })}
        />
      </article>
      <CommentsPanel
        comments={{ document: comments, threads }}
        me={me}
        canComment
        active={active}
        onActivate={setActive}
        draft={draft}
        onDraftDone={() => {
          setDraft(undefined);
        }}
        commentKeys={undefined}
      />
    </div>
  );
}
