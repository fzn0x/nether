// A PDF's own places (ADR 0062): where its outline's entries and its links
// go, a page and how far down it, and its outline, a nested list of
// buttons beside the pages.
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useEffect, useState } from "react";
import { t } from "./messages.ts";

/** A place in the PDF: its page, from 1, and how far down it, at 100%, when it says. */
export interface PdfDestination {
  readonly page: number;
  readonly y?: number;
}

function isRef(value: unknown): value is { num: number; gen: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { num?: unknown }).num === "number" &&
    typeof (value as { gen?: unknown }).gen === "number"
  );
}

/** The height a destination names, in the PDF's own units, by its kind. */
function topOf(kind: unknown, args: readonly unknown[]): unknown {
  const name =
    typeof kind === "object" && kind !== null ? (kind as { name?: unknown }).name : undefined;
  switch (name) {
    case "XYZ":
      return args[1];
    case "FitH":
    case "FitBH":
      return args[0];
    case "FitR":
      return args[3];
    default:
      return undefined;
  }
}

/** Where a destination of the PDF is, named or explicit; undefined when it names no page of it. */
export async function destinationOf(
  doc: PDFDocumentProxy,
  dest: unknown,
): Promise<PdfDestination | undefined> {
  const explicit: unknown = typeof dest === "string" ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) return undefined;
  const [target, kind, ...args] = explicit as unknown[];
  let index: number | undefined;
  if (typeof target === "number" && Number.isInteger(target)) index = target;
  else if (isRef(target)) index = await doc.getPageIndex(target);
  if (index === undefined || index < 0 || index >= doc.numPages) return undefined;
  const page = index + 1;
  const top = topOf(kind, args);
  if (typeof top !== "number") return { page };
  const proxy: PDFPageProxy = await doc.getPage(page);
  const point = proxy.getViewport({ scale: 1 }).convertToViewportPoint(0, top) as number[];
  const y = point[1];
  return typeof y === "number" ? { page, y: Math.max(0, y) } : { page };
}

/** A web address a PDF names, if it is one the system's browser may open. */
export function webAddress(url: unknown): string | undefined {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : undefined;
}

interface Entry {
  readonly title: string;
  readonly dest: unknown;
  readonly url: string | undefined;
  readonly items: readonly Entry[];
}

/** An outline's entries; none for what is not a list, as the null of a PDF without one. */
function entriesOf(items: unknown): Entry[] {
  if (!Array.isArray(items)) return [];
  return (items as unknown[]).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const {
      title,
      dest,
      url,
      items: children,
    } = item as {
      title?: unknown;
      dest?: unknown;
      url?: unknown;
      items?: unknown;
    };
    return [
      {
        title: typeof title === "string" && title.trim() !== "" ? title : t("pdfUntitled"),
        dest,
        url: webAddress(url),
        items: entriesOf(children),
      },
    ];
  });
}

function OutlineList(props: {
  readonly entries: readonly Entry[];
  readonly onGo: (dest: unknown) => void;
  readonly onOpenUrl: (url: string) => void;
}) {
  const { entries, onGo, onOpenUrl } = props;
  return (
    <ul>
      {entries.map((entry, index) => (
        <li key={index}>
          <button
            type="button"
            className="pdf-outline-entry"
            disabled={entry.dest === null && entry.url === undefined}
            onClick={() => {
              if (entry.url !== undefined) onOpenUrl(entry.url);
              else onGo(entry.dest);
            }}
          >
            {entry.title}
          </button>
          {entry.items.length === 0 ? null : (
            <OutlineList entries={entry.items} onGo={onGo} onOpenUrl={onOpenUrl} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** The PDF's outline, beside its pages: each entry a button to its place. */
export function PdfOutline(props: {
  readonly doc: PDFDocumentProxy;
  readonly onGo: (dest: unknown) => void;
  readonly onOpenUrl: (url: string) => void;
}) {
  const { doc, onGo, onOpenUrl } = props;
  const [entries, setEntries] = useState<readonly Entry[] | undefined>();
  useEffect(() => {
    let live = true;
    doc.getOutline().then(
      (outline) => {
        if (live) setEntries(entriesOf(outline));
      },
      () => {
        if (live) setEntries([]);
      },
    );
    return () => {
      live = false;
    };
  }, [doc]);
  return (
    <aside className="pdf-panel pdf-outline" aria-labelledby="pdf-outline-title">
      <h2 id="pdf-outline-title">{t("pdfOutline")}</h2>
      {entries === undefined ? null : entries.length === 0 ? (
        <p className="placeholder">{t("pdfNoOutline")}</p>
      ) : (
        <OutlineList entries={entries} onGo={onGo} onOpenUrl={onOpenUrl} />
      )}
    </aside>
  );
}
