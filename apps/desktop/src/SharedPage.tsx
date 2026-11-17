// The page a share link opens in the web app (ADR 0071): the link's
// password when it has one, then the shared page and its subpages, each
// read-only, as the server syncs them to the link's visit. The visit is
// the server's, in a cookie the page cannot read; the token leaves the
// address once it is used, and a reload finds the visit again.
import { NoteEditor, type NoteFiles } from "@nether/editor";
import { LinkIndex } from "@nether/storage";
import { HocuspocusChannel, vaultFiles } from "@nether/sync-client";
import { type SyntheticEvent, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { t } from "./messages.ts";
import { webServer } from "./web.ts";

/** What a visit opens, as the server says. */
interface Opened {
  readonly workspace: string;
  readonly unit: string;
  readonly document: string;
  readonly page: string;
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
    typeof opened.page === "string"
  );
}

async function messageOf(answer: Response): Promise<string> {
  try {
    const body = (await answer.json()) as { readonly message?: unknown };
    return typeof body.message === "string" ? body.message : answer.statusText;
  } catch {
    return answer.statusText;
  }
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
  return <Visit opened={step.opened} />;
}

/** A visit's page: the shared notes listed, and the one chosen shown read-only. */
function Visit(props: { readonly opened: Opened }) {
  const { opened } = props;
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
  return (
    <div className="shared shared-visit">
      <nav className="shared-pages" aria-label={t("sharedPages")}>
        <p className="hint">{t("sharedReadOnly")}</p>
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
        ) : (
          <SharedNote
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

/** One shared note, synced once and shown read-only, with its images from the workspace. */
function SharedNote(props: {
  readonly channel: HocuspocusChannel;
  readonly opened: Opened;
  readonly id: string;
  readonly path: string;
  readonly vault: Y.Doc;
  readonly paths: readonly string[];
}) {
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

  const files = useMemo((): NoteFiles => {
    const stored = vaultFiles(vault);
    const index = new LinkIndex([...paths, ...stored.keys()]);
    return {
      url(link) {
        const found = index.resolve(link, path);
        const file = found === undefined ? undefined : stored.get(found);
        return file === undefined
          ? undefined
          : `${webServer}/api/workspaces/${opened.workspace}/attachments/${file.blob}`;
      },
    };
  }, [vault, paths, path, opened.workspace]);

  if (error !== undefined) return <p role="alert">{error}</p>;
  if (!ready) return <p role="status">{t("sharedOpening")}</p>;
  return (
    <article>
      <h1>{titleOf(path)}</h1>
      <NoteEditor document={document} editable={false} label={titleOf(path)} files={files} />
    </article>
  );
}
