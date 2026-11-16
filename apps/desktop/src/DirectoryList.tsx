// The plugin and theme directory in a settings tab (ADR 0065): read only
// once asked, searched, and installed from one entry at a time. What was
// read stays for a few minutes, and so does whether it was open, as the
// Plugins tab draws itself anew when a plugin is installed.
import { useEffect, useRef, useState } from "react";
import { type Directory, type DirectoryEntry, loadDirectory } from "./directory.ts";
import { t } from "./messages.ts";

type Kind = "plugins" | "themes";
type Installed = "none" | "same" | "other";

/** How long what was read of the directory is shown again before it is read anew. */
const keepFor = 5 * 60_000;
let kept: { readonly at: number; readonly directory: Directory } | undefined;
const open: Record<Kind, boolean> = { plugins: false, themes: false };
const lastSaid: Record<Kind, string | undefined> = { plugins: undefined, themes: undefined };

/** The directory, as read in the last few minutes or read now. */
async function directory(): Promise<Directory> {
  if (kept !== undefined && Date.now() - kept.at < keepFor) return kept.directory;
  const read = await loadDirectory();
  kept = { at: Date.now(), directory: read };
  return read;
}

type Shown =
  | { readonly status: "closed" }
  | { readonly status: "reading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly entries: readonly DirectoryEntry[] };

export function DirectoryList(props: {
  readonly kind: Kind;
  /** Whether an entry is installed as the directory has it, as another version, or not. */
  readonly installedOf: (entry: DirectoryEntry) => Promise<Installed>;
  readonly install: (entry: DirectoryEntry) => Promise<void>;
  /** Told once an entry is installed, to read the vault's plugins or themes again. */
  readonly onInstalled: () => void;
}) {
  const { kind, installedOf, install, onInstalled } = props;
  // Open again as it was, when the tab is drawn anew.
  const [shown, setShown] = useState<Shown>(() =>
    open[kind] ? { status: "reading" } : { status: "closed" },
  );
  /** How many times the directory was asked for; reading it follows each. */
  const [asked, setAsked] = useState(() => (open[kind] ? 1 : 0));
  const installedNow = useRef(installedOf);
  useEffect(() => {
    installedNow.current = installedOf;
  }, [installedOf]);
  const [query, setQuery] = useState("");
  const [installed, setInstalled] = useState<ReadonlyMap<string, Installed>>(new Map());
  const [busy, setBusy] = useState<string | undefined>();
  const [said, setSaid] = useState<string | undefined>(lastSaid[kind]);
  const [failure, setFailure] = useState<string | undefined>();

  const browse = () => {
    setShown({ status: "reading" });
    setAsked((count) => count + 1);
  };

  useEffect(() => {
    if (asked === 0) return;
    let current = true;
    open[kind] = true;
    directory().then(
      (read) => {
        if (current) {
          setShown({ status: "ready", entries: kind === "plugins" ? read.plugins : read.themes });
        }
      },
      (reason: unknown) => {
        open[kind] = false;
        if (current) {
          setShown({
            status: "failed",
            message: reason instanceof Error ? reason.message : String(reason),
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [asked, kind]);

  const entries = shown.status === "ready" ? shown.entries : undefined;
  useEffect(() => {
    if (entries === undefined) return;
    let current = true;
    void Promise.all(
      entries.map(async (entry) => [entry.id, await installedNow.current(entry)] as const),
    ).then((states) => {
      if (current) setInstalled(new Map(states));
    });
    return () => {
      current = false;
    };
  }, [entries]);

  const installOne = (entry: DirectoryEntry) => {
    setBusy(entry.id);
    setFailure(undefined);
    install(entry).then(
      () => {
        const message = t(
          kind === "plugins" ? "directoryPluginInstalled" : "directoryThemeInstalled",
          {
            name: entry.name,
          },
        );
        lastSaid[kind] = message;
        setSaid(message);
        setBusy(undefined);
        setInstalled((current) => new Map([...current, [entry.id, "same"]]));
        onInstalled();
      },
      (reason: unknown) => {
        setBusy(undefined);
        setFailure(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const wanted = query.trim().toLowerCase();
  const matching =
    entries?.filter((entry) =>
      [entry.name, entry.description, entry.author, entry.id].some((field) =>
        field.toLowerCase().includes(wanted),
      ),
    ) ?? [];

  return (
    <section className="directory" aria-label={t("directory")}>
      <h4>{t("directory")}</h4>
      <p className="hint">
        {t(kind === "plugins" ? "directoryPluginsIntro" : "directoryThemesIntro")}
      </p>
      {shown.status === "closed" || shown.status === "failed" ? (
        <button type="button" onClick={browse}>
          {t("directoryBrowse")}
        </button>
      ) : null}
      {shown.status === "reading" ? <p role="status">{t("directoryReading")}</p> : null}
      {shown.status === "failed" ? (
        <p role="alert">{t("directoryUnreachable", { message: shown.message })}</p>
      ) : null}
      {entries === undefined ? null : entries.length === 0 ? (
        <p className="hint">{t("directoryEmpty")}</p>
      ) : (
        <>
          <label className="field">
            {t("directorySearch")}
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </label>
          {matching.length === 0 ? (
            <p className="hint">{t("directoryNoMatch")}</p>
          ) : (
            <ul className="plugin-list">
              {matching.map((entry) => {
                const state = installed.get(entry.id) ?? "none";
                const label =
                  busy === entry.id
                    ? t("directoryInstalling")
                    : state === "same"
                      ? t("directoryInstalled")
                      : state === "other"
                        ? t("directoryUpdate")
                        : t("directoryInstall");
                return (
                  <li key={entry.id} className="directory-entry">
                    <div>
                      <strong>{entry.name}</strong>
                      <p className="hint">
                        {entry.description === "" ? null : <>{entry.description} </>}
                        {t("directoryBy", { author: entry.author })}{" "}
                        {entry.version === undefined
                          ? null
                          : t("pluginVersion", { version: entry.version })}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy !== undefined || state === "same"}
                      aria-label={
                        state === "same"
                          ? undefined
                          : t(
                              state === "other" ? "directoryUpdateNamed" : "directoryInstallNamed",
                              {
                                name: entry.name,
                              },
                            )
                      }
                      onClick={() => {
                        installOne(entry);
                      }}
                    >
                      {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {said === undefined ? null : <p role="status">{said}</p>}
      {failure === undefined ? null : <p role="alert">{failure}</p>}
    </section>
  );
}
