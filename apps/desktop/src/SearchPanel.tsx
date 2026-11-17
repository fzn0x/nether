// The sidebar's search: words, "phrases", -exclusions and filters by tag,
// path and property, each note found with the text around a match. While
// search by meaning is on for the vault (ADR 0074), it can search by
// meaning instead, when Enter is pressed, since each search asks the
// provider: each note found by its closest passage, which opens at its
// heading. Filters apply to both.
import type { NoteId } from "@nether/core";
import type { LinkGraph } from "@nether/graph";
import { isEmptyQuery, parseQuery } from "@nether/search";
import type { Vault } from "@nether/storage";
import { type RefObject, type SyntheticEvent, useEffect, useState } from "react";
import type { MeaningHit, MeaningProgress } from "./meaning.ts";
import { t } from "./messages.ts";
import type { NotePart } from "./noteLinks.ts";
import { type SearchResult, passes, searchVault, snippetParts } from "./search.ts";
import { useGraph } from "./useGraph.ts";

const numbers = new Intl.NumberFormat();

/** How long typing pauses before a search runs. */
const pause = 150;

function folderOf(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? undefined : path.slice(0, slash);
}

/** Search by meaning, while it is on for the vault. */
export interface MeaningPanel {
  /** Sends what was typed to the provider, and gives the notes closest in meaning. */
  readonly search: (text: string) => Promise<readonly MeaningHit[]>;
  /** How far embedding the vault has come. */
  readonly progress: MeaningProgress | undefined;
}

type Mode = "words" | "meaning";

/** The innermost heading of a passage's, which its note opens at. */
function innermost(heading: string): string | undefined {
  const last = heading.split(" > ").at(-1);
  return last === undefined || last === "" ? undefined : last;
}

function countOf(found: number): string {
  return found === 0
    ? t("noResults")
    : found === 1
      ? t("oneNote")
      : t("noteCount", { count: numbers.format(found) });
}

export function SearchPanel(props: {
  readonly vault: Vault;
  readonly graph: LinkGraph;
  readonly onOpen: (id: NoteId, part?: NotePart) => void;
  readonly input: RefObject<HTMLInputElement | null>;
  readonly meaning?: MeaningPanel | undefined;
}) {
  const { vault, graph, onOpen, input, meaning } = props;
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<Mode>("words");
  const mode: Mode = meaning === undefined ? "words" : chosen;
  const [results, setResults] = useState<readonly SearchResult[] | undefined>();
  const [hits, setHits] = useState<readonly MeaningHit[] | undefined>();
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const version = useGraph(graph);

  useEffect(() => {
    if (mode !== "words") return;
    const query = parseQuery(text);
    if (isEmptyQuery(query)) {
      setResults(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void searchVault(vault, graph, query).then((found) => {
        if (current) setResults(found);
      });
    }, pause);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [mode, text, vault, graph, version]);

  const searchByMeaning = (event: SyntheticEvent) => {
    event.preventDefault();
    if (mode !== "meaning" || meaning === undefined || searching) return;
    const query = parseQuery(text);
    const asked = [...query.words, ...query.phrases].join(" ");
    if (asked === "") {
      setHits(undefined);
      return;
    }
    setSearching(true);
    setError(undefined);
    meaning
      .search(asked)
      .then(
        (found) => {
          setHits(
            found.filter(
              ({ note }) =>
                query.filters.every((filter) => passes(graph, note, filter)) &&
                !query.excludedFilters.some((filter) => passes(graph, note, filter)),
            ),
          );
        },
        (reason: unknown) => {
          setHits(undefined);
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      )
      .finally(() => {
        setSearching(false);
      });
  };

  const progress = meaning?.progress;
  return (
    <div className="search-panel">
      {meaning === undefined ? null : (
        <div className="search-modes" role="group" aria-label={t("searchBy")}>
          {(["words", "meaning"] as const).map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={mode === each}
              onClick={() => {
                setChosen(each);
                setError(undefined);
              }}
            >
              {t(each === "words" ? "searchByWords" : "searchByMeaning")}
            </button>
          ))}
        </div>
      )}
      <form className="search-form" role="search" onSubmit={searchByMeaning}>
        <input
          ref={input}
          type="search"
          className="search-input"
          aria-label={t(mode === "words" ? "searchLabel" : "searchMeaningLabel")}
          aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
          placeholder={t(mode === "words" ? "searchHint" : "searchMeaningHint")}
          value={text}
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </form>
      {mode === "meaning" && progress !== undefined && progress.done < progress.total ? (
        <p className="hint search-progress">
          {t("meaningEmbedding", {
            done: numbers.format(progress.done),
            total: numbers.format(progress.total),
          })}
        </p>
      ) : null}
      {mode === "meaning" && progress?.error !== undefined ? (
        <p className="hint search-progress">{t("meaningWaiting", { error: progress.error })}</p>
      ) : null}
      {mode === "words" ? (
        <>
          {results === undefined ? null : (
            <p className="count" role="status">
              {countOf(results.length)}
            </p>
          )}
          {results === undefined || results.length === 0 ? null : (
            <ul className="search-results" aria-label={t("searchResults")}>
              {results.map(({ note, snippet }) => {
                const folder = folderOf(note.path);
                return (
                  <li key={note.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onOpen(note.id);
                      }}
                    >
                      <span className="note-title">{note.title}</span>
                      {folder === undefined ? null : <span className="note-folder">{folder}</span>}
                    </button>
                    {snippet === undefined || snippet === "" ? null : (
                      <p className="search-snippet">
                        {snippetParts(snippet).map((part, index) =>
                          part.match ? (
                            <mark key={index}>{part.text}</mark>
                          ) : (
                            <span key={index}>{part.text}</span>
                          ),
                        )}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <>
          {error === undefined ? null : (
            <p className="search-error" role="alert">
              {error}
            </p>
          )}
          <p className="count" role="status">
            {searching ? t("searchingByMeaning") : hits === undefined ? "" : countOf(hits.length)}
          </p>
          {hits === undefined || hits.length === 0 ? null : (
            <ul className="search-results" aria-label={t("searchResults")}>
              {hits.map(({ note, heading, preview }) => {
                const folder = folderOf(note.path);
                const at = innermost(heading);
                return (
                  <li key={note.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onOpen(note.id, at === undefined ? undefined : { heading: at });
                      }}
                    >
                      <span className="note-title">{note.title}</span>
                      {folder === undefined ? null : <span className="note-folder">{folder}</span>}
                    </button>
                    {heading === "" ? null : <p className="search-heading">{heading}</p>}
                    {preview === "" ? null : <p className="search-snippet">{preview}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
