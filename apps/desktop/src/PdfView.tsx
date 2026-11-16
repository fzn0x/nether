// A PDF, opened in a tab (ADR 0061): its pages drawn by pdf.js, only those
// near the screen, with the page's words laid over them for selecting;
// its highlights marked on the pages and listed beside them, each a
// callout in a note that links to its passage. Words are highlighted from
// a selection, or from Find, so the keyboard alone can highlight; a
// highlight's comment is written in its callout.
import type { NoteId } from "@nether/core";
import type { LinkGraph } from "@nether/graph";
import {
  type PdfPassage,
  type PdfSelection,
  type TextItem,
  commentMarkdown,
  findOnPage,
  locatePassage,
  passageWords,
  readPdfPlace,
} from "@nether/pdf";
import type { Vault } from "@nether/storage";
import {
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  PDFWorker,
  type RenderTask,
  TextLayer,
  getDocument,
} from "pdfjs-dist";
import PdfJsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "./messages.ts";
import type { NotePart } from "./noteLinks.ts";
import {
  type NoteHighlight,
  addPdfHighlight,
  highlightLink,
  highlightsHome,
  notesWithPassages,
  readPdfHighlights,
  removePdfHighlight,
  setHighlightComment,
} from "./pdfHighlights.ts";

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

/** A page's size at 100%, in CSS pixels. */
interface Size {
  readonly width: number;
  readonly height: number;
}

/** What is marked on a page: a highlight, the one chosen, the words to highlight, a match of Find, a link's passage. */
type MarkKind = "highlight" | "chosen" | "pending" | "match" | "focus";

interface Mark {
  readonly key: string;
  readonly kind: MarkKind;
  readonly selection: PdfSelection;
}

/** A place to show, and a key new each time it is asked, even for the same place. */
interface Focus {
  readonly page: number;
  readonly mark?: string;
  readonly key: number;
}

/** Words chosen to highlight, from a selection or from Find. */
interface Pending {
  readonly passage: PdfPassage;
  readonly words: string;
}

const minScale = 0.25;
const maxScale = 4;

/** Where pdf.js fetches what a PDF needs, as the build copies it (vite.config.ts). */
function resources() {
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.href).href;
  return {
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.name === "PasswordException") return t("pdfPassword");
  return error instanceof Error ? error.message : String(error);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.pdf$/i, "");
}

function keyOf(item: NoteHighlight): string {
  return `${item.note}:${item.highlight.id}`;
}

/** The PDF at `path`, loaded through the vault's files, again when the file changes. */
function usePdf(vault: Vault, path: string): { doc?: PDFDocumentProxy; error?: string } {
  const [state, setState] = useState<{ doc?: PDFDocumentProxy; error?: string }>({});
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let seen = vault.fileInfo(path);
    return vault.subscribe(() => {
      const now = vault.fileInfo(path);
      if (now?.modified === seen?.modified && now?.size === seen?.size) return;
      seen = now;
      setVersion((count) => count + 1);
    });
  }, [vault, path]);
  useEffect(() => {
    // StrictMode starts this twice: what the first start made is stopped.
    const controller = new AbortController();
    const stopped = () => controller.signal.aborted;
    let port: Worker | undefined;
    let worker: PDFWorker | undefined;
    let task: PDFDocumentLoadingTask | undefined;
    setState({});
    if (vault.fileInfo(path) === undefined) {
      setState({ error: t("pdfGone") });
      return;
    }
    vault
      .readBytes(path)
      .then(async (file) => {
        if (stopped()) return;
        // A worker of its own, stopped with the PDF, so that nothing stays once it closes.
        port = new PdfJsWorker();
        worker = PDFWorker.create({ port });
        task = getDocument({ data: file.bytes, worker, ...resources() });
        const doc = await task.promise;
        if (!stopped()) setState({ doc });
      })
      .catch((error: unknown) => {
        if (!stopped()) setState({ error: errorText(error) });
      });
    return () => {
      controller.abort();
      const done = task?.destroy() ?? Promise.resolve();
      void done.finally(() => {
        worker?.destroy();
        port?.terminate();
      });
    };
  }, [vault, path, version]);
  return state;
}

/** The node and offset in a page's text layer where a character of an item is; past the end for the last. */
function boundary(
  divs: readonly HTMLElement[],
  index: number,
  offset: number,
  forward: boolean,
): { readonly node: Node; readonly offset: number } | undefined {
  // An empty item has no element on the page: the next one starts, or the one before ends.
  for (let at = index; at >= 0 && at < divs.length; at += forward ? 1 : -1) {
    const node = divs[at]?.firstChild;
    if (divs[at]?.isConnected !== true || !(node instanceof Text)) continue;
    if (at === index) return { node, offset: Math.min(offset, node.length) };
    return { node, offset: forward ? 0 : node.length };
  }
  return undefined;
}

/** The boxes a passage covers on its page, from the page's corner. */
function boxesOf(
  divs: readonly HTMLElement[],
  selection: PdfSelection,
  page: DOMRect,
): { left: number; top: number; width: number; height: number }[] {
  const start = boundary(divs, selection.beginIndex, selection.beginOffset, true);
  const end = boundary(divs, selection.endIndex, selection.endOffset, false);
  if (start === undefined || end === undefined) return [];
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return [];
  }
  return [...range.getClientRects()]
    .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
    .map((rect) => ({
      left: rect.left - page.left,
      top: rect.top - page.top,
      width: rect.width,
      height: rect.height,
    }));
}

/** Where in an item's element a range's end is, as an offset in the item's text. */
function offsetIn(div: HTMLElement, node: Node, offset: number): number {
  const length = div.textContent.length;
  if (node === div) return offset === 0 ? 0 : length;
  return node.nodeType === Node.TEXT_NODE ? Math.min(offset, length) : 0;
}

/** The passage a range selects on a page, from the items its text layer drew; undefined for none. */
function selectionOf(range: Range, divs: readonly HTMLElement[]): PdfSelection | undefined {
  let begin: readonly [number, number] | undefined;
  let end: readonly [number, number] | undefined;
  for (const [index, div] of divs.entries()) {
    if (!div.isConnected || div.textContent === "" || !range.intersectsNode(div)) continue;
    const from = div.contains(range.startContainer)
      ? offsetIn(div, range.startContainer, range.startOffset)
      : 0;
    const to = div.contains(range.endContainer)
      ? offsetIn(div, range.endContainer, range.endOffset)
      : div.textContent.length;
    if (from >= to) continue;
    begin ??= [index, from];
    end = [index, to];
  }
  return begin === undefined || end === undefined
    ? undefined
    : { beginIndex: begin[0], beginOffset: begin[1], endIndex: end[0], endOffset: end[1] };
}

function PdfPage(props: {
  readonly doc: PDFDocumentProxy;
  readonly number: number;
  readonly count: number;
  readonly size: Size;
  readonly scale: number;
  readonly near: boolean;
  readonly marks: readonly Mark[];
  readonly focus: Focus | undefined;
  readonly textOf: (page: number) => Promise<TextContent>;
  readonly onText: (page: number, divs: readonly HTMLElement[] | undefined) => void;
  readonly onSize: (page: number, size: Size) => void;
  readonly onError: (error: unknown) => void;
  readonly register: (page: number, element: HTMLElement | null) => void;
}) {
  const { doc, number, count, size, scale, near, marks, focus, textOf, onText, onSize, onError } =
    props;
  const page = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [divs, setDivs] = useState<readonly HTMLElement[] | undefined>();

  // Drawn while near the screen; far away, its canvas lets its pixels go.
  useEffect(() => {
    if (!near) return;
    // Read through a function: the flag changes while this waits.
    const controller = new AbortController();
    const cancelled = () => controller.signal.aborted;
    let render: RenderTask | undefined;
    let text: TextLayer | undefined;
    void (async () => {
      const proxy = await doc.getPage(number);
      if (cancelled()) return;
      const whole = proxy.getViewport({ scale: 1 });
      onSize(number, { width: whole.width, height: whole.height });
      const viewport = proxy.getViewport({ scale });
      const drawn = canvas.current;
      const container = layer.current;
      if (drawn === null || container === null) return;
      const ratio = window.devicePixelRatio || 1;
      drawn.width = Math.floor(viewport.width * ratio);
      drawn.height = Math.floor(viewport.height * ratio);
      render = proxy.render({
        canvas: drawn,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      const content = await textOf(number);
      if (cancelled()) return;
      container.replaceChildren();
      text = new TextLayer({ textContentSource: content, container, viewport });
      await text.render();
      if (cancelled()) return;
      setDivs(text.textDivs);
      onText(number, text.textDivs);
      await render.promise;
    })().catch((error: unknown) => {
      if (cancelled() || (error instanceof Error && error.name === "RenderingCancelledException")) {
        return;
      }
      onError(error);
    });
    const drawn = canvas.current;
    const container = layer.current;
    return () => {
      controller.abort();
      render?.cancel();
      text?.cancel();
      setDivs(undefined);
      onText(number, undefined);
      container?.replaceChildren();
      if (drawn !== null) {
        drawn.width = 0;
        drawn.height = 0;
      }
    };
  }, [doc, number, scale, near, textOf, onText, onSize, onError]);

  // The marks, from the words' boxes once the text layer is drawn.
  const [boxes, setBoxes] = useState<
    readonly {
      key: string;
      kind: MarkKind;
      left: number;
      top: number;
      width: number;
      height: number;
    }[]
  >([]);
  useLayoutEffect(() => {
    const element = page.current;
    if (divs === undefined || element === null) {
      setBoxes([]);
      return;
    }
    const corner = element.getBoundingClientRect();
    setBoxes(
      marks.flatMap((mark) =>
        boxesOf(divs, mark.selection, corner).map((box, index) => ({
          ...box,
          key: `${mark.key}:${String(index)}`,
          kind: mark.kind,
        })),
      ),
    );
  }, [divs, marks]);

  // A passage asked for is scrolled to once its marks are drawn.
  const shown = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (focus?.page !== number || focus.mark === undefined || shown.current === focus.key) return;
    const target = page.current?.querySelector(`[data-mark="${CSS.escape(focus.mark)}"]`);
    if (target === null || target === undefined) return;
    shown.current = focus.key;
    target.scrollIntoView({ block: "center" });
  }, [boxes, focus, number]);

  const { register } = props;
  return (
    <div
      ref={(element) => {
        page.current = element;
        register(number, element);
      }}
      className="pdf-page"
      role="group"
      data-page={number}
      aria-label={t("pdfPage", { page: number, count })}
      style={
        {
          width: `${String(size.width * scale)}px`,
          height: `${String(size.height * scale)}px`,
          "--total-scale-factor": String(scale),
          "--scale-round-x": "1px",
          "--scale-round-y": "1px",
        } as CSSProperties
      }
    >
      <canvas ref={canvas} className="pdf-canvas" aria-hidden="true" />
      <div className="pdf-marks" aria-hidden="true">
        {boxes.map((box) => (
          <div
            key={box.key}
            className={`pdf-mark pdf-mark-${box.kind}`}
            data-mark={box.key.slice(0, box.key.lastIndexOf(":"))}
            style={{
              left: `${String(box.left)}px`,
              top: `${String(box.top)}px`,
              width: `${String(box.width)}px`,
              height: `${String(box.height)}px`,
            }}
          />
        ))}
      </div>
      <div ref={layer} className="textLayer" />
    </div>
  );
}

export default function PdfView(props: {
  readonly vault: Vault;
  readonly graph: LinkGraph;
  readonly path: string;
  readonly at?: { readonly part: string; readonly key: number } | undefined;
  readonly linksLoaded?: (() => Promise<void>) | undefined;
  readonly onOpenNote: (id: NoteId, part?: NotePart) => void;
}) {
  const { vault, graph, path, at, linksLoaded, onOpenNote } = props;
  const name = nameOf(path);
  const { doc, error } = usePdf(vault, path);
  const [notice, setNotice] = useState<string | undefined>();
  const [status, setStatus] = useState("");
  const report = useCallback((problem: unknown) => {
    setNotice(errorText(problem));
  }, []);

  // Each page's words, read once while the PDF is open, as Obsidian's
  // viewer counts them: marked content aside, the text not normalized.
  const textOf = useMemo(() => {
    const texts = new Map<number, Promise<TextContent>>();
    return (page: number): Promise<TextContent> => {
      if (doc === undefined) return Promise.reject(new Error("No PDF is open."));
      let found = texts.get(page);
      if (found === undefined) {
        found = doc
          .getPage(page)
          .then((proxy) =>
            proxy.getTextContent({ includeMarkedContent: true, disableNormalization: true }),
          );
        texts.set(page, found);
      }
      return found;
    };
  }, [doc]);
  const itemsOf = useCallback(
    async (page: number): Promise<readonly TextItem[]> =>
      (await textOf(page)).items.flatMap((item) => ("str" in item ? [item] : [])),
    [textOf],
  );

  // Every page as large as the first until it is drawn, then as large as it is.
  const [sizes, setSizes] = useState<readonly Size[]>([]);
  useEffect(() => {
    setSizes([]);
    if (doc === undefined) return;
    let live = true;
    void doc.getPage(1).then((first) => {
      const viewport = first.getViewport({ scale: 1 });
      if (live) {
        setSizes(
          Array.from({ length: doc.numPages }, () => ({
            width: viewport.width,
            height: viewport.height,
          })),
        );
      }
    }, report);
    return () => {
      live = false;
    };
  }, [doc, report]);
  const onSize = useCallback((page: number, size: Size) => {
    setSizes((current) => {
      const was = current[page - 1];
      if (was === undefined || (was.width === size.width && was.height === size.height)) {
        return current;
      }
      return current.with(page - 1, size);
    });
  }, []);

  // As wide as the pane, to start with.
  const scroller = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<number | undefined>();
  const firstSize = sizes[0];
  useEffect(() => {
    if (firstSize === undefined || scale !== undefined || scroller.current === null) return;
    const room = scroller.current.clientWidth - 48;
    setScale(Math.min(2, Math.max(minScale, room / firstSize.width)));
  }, [firstSize, scale]);
  const zoom = (factor: number) => {
    setScale((current) => Math.min(maxScale, Math.max(minScale, (current ?? 1) * factor)));
  };

  // The pages near what shows, drawn; the page at the top, named in the toolbar.
  const elements = useRef(new Map<number, HTMLElement>());
  const [near, setNear] = useState<ReadonlySet<number>>(new Set());
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  useEffect(() => {
    const root = scroller.current;
    if (root === null) return;
    const watching = new IntersectionObserver(
      (entries) => {
        setNear((current) => {
          const next = new Set(current);
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.page);
            if (entry.isIntersecting) next.add(page);
            else next.delete(page);
          }
          return next;
        });
      },
      { root, rootMargin: "100% 0px" },
    );
    observer.current = watching;
    for (const element of elements.current.values()) watching.observe(element);
    return () => {
      watching.disconnect();
      observer.current = undefined;
    };
  }, [doc]);
  const register = useCallback((page: number, element: HTMLElement | null) => {
    const was = elements.current.get(page);
    if (was === element) return;
    if (was !== undefined) observer.current?.unobserve(was);
    if (element === null) {
      elements.current.delete(page);
      return;
    }
    elements.current.set(page, element);
    observer.current?.observe(element);
  }, []);
  const [current, setCurrent] = useState(1);
  const onScroll = () => {
    const root = scroller.current;
    if (root === null) return;
    const line = root.scrollTop + root.clientHeight / 3;
    let found = 1;
    for (const [page, element] of elements.current) {
      if (element.offsetTop <= line && page > found) found = page;
    }
    setCurrent(found);
  };
  const [focus, setFocus] = useState<Focus | undefined>();
  const goTo = useCallback((page: number, mark?: string) => {
    const element = elements.current.get(page);
    const root = scroller.current;
    if (element !== undefined && root !== null) root.scrollTop = element.offsetTop - 8;
    setCurrent(page);
    setFocus({ page, ...(mark === undefined ? {} : { mark }), key: Date.now() });
  }, []);

  // The text layers drawn, by page, to read a selection from.
  const layers = useRef(new Map<number, readonly HTMLElement[]>());
  const onText = useCallback((page: number, divs: readonly HTMLElement[] | undefined) => {
    if (divs === undefined) layers.current.delete(page);
    else layers.current.set(page, divs);
  }, []);

  // The words chosen to highlight: a selection in the pages, or a match of Find.
  const [pending, setPending] = useState<Pending | undefined>();
  useEffect(() => {
    const onChange = () => {
      const root = scroller.current;
      const selection = document.getSelection();
      if (root === null || selection === null || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!root.contains(range.startContainer)) return;
      if (selection.isCollapsed) {
        setPending(undefined);
        return;
      }
      const start =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement;
      // A highlight stays on one page: the page the selection starts on.
      let pageElement = start?.closest<HTMLElement>(".pdf-page") ?? undefined;
      pageElement ??= [...elements.current.values()].find((element) =>
        range.intersectsNode(element),
      );
      const page = Number(pageElement?.dataset.page);
      const divs = layers.current.get(page);
      const chosen = divs === undefined ? undefined : selectionOf(range, divs);
      if (chosen === undefined) {
        setPending(undefined);
        return;
      }
      void itemsOf(page).then((items) => {
        const words = passageWords(items, chosen);
        setPending(
          words === undefined || words === ""
            ? undefined
            : { passage: { page, selection: chosen }, words },
        );
      }, report);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
    };
  }, [itemsOf, report]);

  // The PDF's highlights, from every note that links to a passage of it.
  const [highlights, setHighlights] = useState<readonly NoteHighlight[]>([]);
  // Whether they were read once the vault's links were in, which a link's place waits for.
  const [listed, setListed] = useState(false);
  const written = useRef(new Set<NoteId>());
  const known = useRef(new Set<NoteId>());
  const refresh = useCallback(() => {
    const notes = new Set([...notesWithPassages(vault, graph, path), ...written.current]);
    known.current = notes;
    return readPdfHighlights(vault, notes, path).then(setHighlights, report);
  }, [vault, graph, path, report]);
  useEffect(() => {
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (live()) void refresh();
      }, 250);
    };
    void refresh();
    void (linksLoaded?.() ?? Promise.resolve()).then(async () => {
      if (!live()) return;
      await refresh();
      if (live()) setListed(true);
    });
    const stopGraph = graph.subscribe(later);
    const stopVault = vault.subscribe((changed) => {
      if (changed.some((note) => known.current.has(note))) later();
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      stopGraph();
      stopVault();
    };
  }, [vault, graph, refresh, linksLoaded]);

  // Where each highlight's passage is now, by its selection and its words.
  const [located, setLocated] = useState<ReadonlyMap<string, PdfPassage | null>>(new Map());
  useEffect(() => {
    if (doc === undefined) return;
    const controller = new AbortController();
    void (async () => {
      const found = new Map<string, PdfPassage | null>();
      for (const item of highlights) {
        const { passage, words } = item.highlight;
        found.set(
          keyOf(item),
          (await locatePassage(passage, words, doc.numPages, itemsOf)) ?? null,
        );
      }
      if (!controller.signal.aborted) setLocated(found);
    })().catch(report);
    return () => {
      controller.abort();
    };
  }, [doc, highlights, itemsOf, report]);

  const [chosen, setChosen] = useState<string | undefined>();

  // Find: every place some words are, page by page.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ query: string; found: readonly PdfPassage[] }>();
  const [match, setMatch] = useState(0);
  const findField = useRef<HTMLInputElement>(null);
  const showMatch = async (found: readonly PdfPassage[], index: number) => {
    const passage = found[index];
    if (passage === undefined) return;
    setMatch(index);
    const words = passageWords(await itemsOf(passage.page), passage.selection) ?? "";
    setPending({ passage, words });
    goTo(passage.page, "match");
    setStatus(t("pdfMatch", { index: index + 1, count: found.length }));
  };
  const findNext = async (back: boolean) => {
    if (doc === undefined || query.trim() === "") return;
    const found = matches?.query === query ? matches.found : undefined;
    if (found === undefined) {
      const all: PdfPassage[] = [];
      for (let page = 1; page <= doc.numPages; page++) {
        for (const selection of findOnPage(await itemsOf(page), query)) {
          all.push({ page, selection });
        }
      }
      setMatches({ query, found: all });
      if (all.length === 0) {
        setStatus(t("pdfNoMatch"));
        return;
      }
      // From the page shown on.
      const after = all.findIndex((each) => each.page >= current);
      await showMatch(all, after === -1 ? 0 : after);
      return;
    }
    if (found.length === 0) {
      setStatus(t("pdfNoMatch"));
      return;
    }
    await showMatch(found, (match + (back ? found.length - 1 : 1)) % found.length);
  };
  const openFind = () => {
    setFinding(true);
    requestAnimationFrame(() => {
      findField.current?.focus();
      findField.current?.select();
    });
  };

  const highlight = async () => {
    if (pending === undefined) return;
    try {
      const added = await addPdfHighlight(
        vault,
        path,
        highlightsHome(highlights),
        t("pdfHighlightsName", { name }),
        {
          passage: pending.passage,
          words: pending.words,
          name: t("pdfPageName", { name, page: pending.passage.page }),
        },
      );
      written.current.add(added.note);
      setPending(undefined);
      setMatches(undefined);
      document.getSelection()?.removeAllRanges();
      setChosen(`${added.note}:${added.id}`);
      setStatus(t("pdfHighlighted", { words: pending.words }));
      await refresh();
    } catch (problem) {
      report(problem);
    }
  };

  // Comments, written in each highlight's callout.
  const [editing, setEditing] = useState<{ key: string; text: string } | undefined>();
  const saveComment = async (item: NoteHighlight, text: string) => {
    try {
      const saved = await setHighlightComment(vault, item.note, item.highlight.id, text);
      setEditing(undefined);
      setStatus(saved ? t("pdfCommentSaved") : t("pdfHighlightGone"));
      await refresh();
    } catch (problem) {
      report(problem);
    }
  };
  const remove = async (item: NoteHighlight) => {
    try {
      const removed = await removePdfHighlight(vault, item.note, item.highlight.id);
      setStatus(removed ? t("pdfHighlightRemoved") : t("pdfHighlightGone"));
      await refresh();
    } catch (problem) {
      report(problem);
    }
  };
  const copyLink = (item: NoteHighlight) => {
    navigator.clipboard.writeText(highlightLink(vault, graph, item.note, item.highlight.id)).then(
      () => {
        setStatus(t("pdfLinkCopied"));
      },
      () => {
        setStatus(t("copyFailed"));
      },
    );
  };
  const show = (item: NoteHighlight) => {
    const key = keyOf(item);
    setChosen(key);
    const passage = located.get(key);
    if (passage !== undefined && passage !== null) goTo(passage.page, key);
  };

  // A link's place: its page, and its passage marked, a highlight's chosen in the list.
  const [linked, setLinked] = useState<PdfPassage | undefined>();
  const asked = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (
      at === undefined ||
      !listed ||
      sizes.length === 0 ||
      scale === undefined ||
      asked.current === at.key
    ) {
      return;
    }
    asked.current = at.key;
    const place = readPdfPlace(at.part);
    if (place === undefined) return;
    const page = Math.min(place.page, sizes.length);
    if (place.selection === undefined) {
      setLinked(undefined);
      goTo(page);
      return;
    }
    const passage = { page, selection: place.selection };
    const same = highlights.find((item) => {
      const { passage: own } = item.highlight;
      return (
        own.page === place.page && JSON.stringify(own.selection) === JSON.stringify(place.selection)
      );
    });
    if (same === undefined) {
      setLinked(passage);
      goTo(page, "focus");
      return;
    }
    const key = keyOf(same);
    setChosen(key);
    setLinked(undefined);
    const where = located.get(key);
    goTo(where === undefined || where === null ? page : where.page, key);
  }, [at, listed, sizes.length, scale, highlights, located, goTo]);

  // What each page marks.
  const marksByPage = useMemo(() => {
    const byPage = new Map<number, Mark[]>();
    const add = (passage: PdfPassage, key: string, kind: MarkKind) => {
      const list = byPage.get(passage.page) ?? [];
      list.push({ key, kind, selection: passage.selection });
      byPage.set(passage.page, list);
    };
    for (const item of highlights) {
      const key = keyOf(item);
      const passage = located.get(key);
      if (passage !== undefined && passage !== null) {
        add(passage, key, key === chosen ? "chosen" : "highlight");
      }
    }
    if (linked !== undefined) add(linked, "focus", "focus");
    if (pending !== undefined && matches !== undefined) add(pending.passage, "match", "match");
    return byPage;
  }, [highlights, located, chosen, linked, pending, matches]);

  const [listOpen, setListOpen] = useState(true);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && event.key.toLowerCase() === "f" && !event.shiftKey) {
      event.preventDefault();
      openFind();
    } else if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === "h") {
      event.preventDefault();
      void highlight();
    }
  };

  if (error !== undefined) {
    return (
      <div className="pdf-view">
        <div className="pdf-toolbar">
          <h1 className="pdf-title">{name}</h1>
        </div>
        <p role="alert" className="pdf-error">
          {error}
        </p>
      </div>
    );
  }

  const count = sizes.length;
  return (
    <div className="pdf-view" onKeyDown={onKeyDown}>
      <div className="pdf-toolbar">
        <h1 className="pdf-title">{name}</h1>
        <div className="pdf-tools" role="toolbar" aria-label={t("pdfTools", { name })}>
          <button
            type="button"
            className="quiet"
            disabled={current <= 1}
            onClick={() => {
              goTo(current - 1);
            }}
          >
            {t("pdfPreviousPage")}
          </button>
          <label className="pdf-page-number">
            <span>{t("pdfPageField")}</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, count)}
              value={current}
              onChange={(event) => {
                const page = Number(event.target.value);
                if (Number.isInteger(page) && page >= 1 && page <= count) goTo(page);
              }}
            />
            <span>{t("pdfOfPages", { count })}</span>
          </label>
          <button
            type="button"
            className="quiet"
            disabled={current >= count}
            onClick={() => {
              goTo(current + 1);
            }}
          >
            {t("pdfNextPage")}
          </button>
          <span className="pdf-zoom" role="group" aria-label={t("canvasZoom")}>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                zoom(1 / 1.25);
              }}
            >
              {t("zoomOut")}
            </button>
            <span className="pdf-zoom-level" aria-live="polite">
              {`${String(Math.round((scale ?? 1) * 100))}%`}
            </span>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                zoom(1.25);
              }}
            >
              {t("zoomIn")}
            </button>
          </span>
          <button
            type="button"
            className="quiet"
            aria-expanded={finding}
            aria-keyshortcuts="Control+F Meta+F"
            onClick={openFind}
          >
            {t("pdfFind")}
          </button>
          <button
            type="button"
            className="quiet pdf-highlight-button"
            disabled={pending === undefined}
            aria-keyshortcuts="Control+Shift+H Meta+Shift+H"
            onClick={() => {
              void highlight();
            }}
          >
            {t("pdfHighlight")}
          </button>
          <button
            type="button"
            className="quiet"
            aria-pressed={listOpen}
            onClick={() => {
              setListOpen((open) => !open);
            }}
          >
            {t("pdfHighlights")}
          </button>
        </div>
      </div>
      {finding ? (
        <div className="pdf-find" role="search" aria-label={t("pdfFindIn", { name })}>
          <input
            ref={findField}
            type="search"
            aria-label={t("pdfFindWords")}
            placeholder={t("pdfFindWords")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatches(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void findNext(event.shiftKey);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setFinding(false);
                setMatches(undefined);
                scroller.current?.focus();
              }
            }}
          />
          <button
            type="button"
            className="quiet"
            onClick={() => {
              void findNext(true);
            }}
          >
            {t("pdfFindPrevious")}
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() => {
              void findNext(false);
            }}
          >
            {t("pdfFindNext")}
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() => {
              setFinding(false);
              setMatches(undefined);
            }}
          >
            {t("close")}
          </button>
        </div>
      ) : null}
      {notice === undefined ? null : (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}
      <p className="pdf-status" role="status">
        {status}
      </p>
      <div className="pdf-body">
        <div
          ref={scroller}
          className="pdf-pages"
          tabIndex={0}
          role="region"
          aria-label={t("pdfPages", { name })}
          onScroll={onScroll}
        >
          {doc === undefined || scale === undefined ? (
            count === 0 ? (
              <p className="placeholder">{t("pdfLoading")}</p>
            ) : null
          ) : (
            sizes.map((size, index) => (
              <PdfPage
                key={index + 1}
                doc={doc}
                number={index + 1}
                count={count}
                size={size}
                scale={scale}
                near={near.has(index + 1)}
                marks={marksByPage.get(index + 1) ?? noMarks}
                focus={focus}
                textOf={textOf}
                onText={onText}
                onSize={onSize}
                onError={report}
                register={register}
              />
            ))
          )}
        </div>
        {listOpen ? (
          <aside className="pdf-highlights" aria-labelledby="pdf-highlights-title">
            <h2 id="pdf-highlights-title">{t("pdfHighlights")}</h2>
            {highlights.length === 0 ? (
              <p className="placeholder">{t("pdfNoHighlights")}</p>
            ) : (
              <ol>
                {highlights.map((item) => {
                  const key = keyOf(item);
                  const where = located.get(key);
                  const lost = where === null;
                  const page = where?.page ?? item.highlight.passage.page;
                  const comment = commentMarkdown(item.highlight.comment);
                  const words =
                    item.highlight.words === "" ? t("pdfNoWords") : item.highlight.words;
                  return (
                    <li key={key} className={key === chosen ? "chosen" : undefined}>
                      <button
                        type="button"
                        className="pdf-highlight-go"
                        aria-current={key === chosen ? "true" : undefined}
                        onClick={() => {
                          show(item);
                        }}
                      >
                        <span className="pdf-highlight-page">
                          {lost ? t("pdfNotFound") : t("pdfOnPage", { page })}
                        </span>
                        <span className="pdf-highlight-words">{words}</span>
                      </button>
                      {editing?.key === key ? (
                        <form
                          className="pdf-comment-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveComment(item, editing.text);
                          }}
                        >
                          <label>
                            <span>{t("pdfComment")}</span>
                            <textarea
                              value={editing.text}
                              rows={3}
                              // The field opens for typing, as its button asked.
                              autoFocus
                              onChange={(event) => {
                                setEditing({ key, text: event.target.value });
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  setEditing(undefined);
                                } else if (
                                  event.key === "Enter" &&
                                  (event.ctrlKey || event.metaKey)
                                ) {
                                  event.preventDefault();
                                  void saveComment(item, editing.text);
                                }
                              }}
                            />
                          </label>
                          <span className="pdf-comment-buttons">
                            <button type="submit">{t("pdfSaveComment")}</button>
                            <button
                              type="button"
                              className="quiet"
                              onClick={() => {
                                setEditing(undefined);
                              }}
                            >
                              {t("cancel")}
                            </button>
                          </span>
                        </form>
                      ) : comment === "" ? null : (
                        <p className="pdf-highlight-comment">{comment}</p>
                      )}
                      <span
                        className="pdf-highlight-actions"
                        role="group"
                        aria-label={t("pdfHighlightActions", { page })}
                      >
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => {
                            setEditing({ key, text: comment });
                          }}
                        >
                          {comment === "" ? t("pdfAddComment") : t("pdfEditComment")}
                        </button>
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => {
                            copyLink(item);
                          }}
                        >
                          {t("pdfCopyLink")}
                        </button>
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => {
                            onOpenNote(item.note, { block: item.highlight.id });
                          }}
                        >
                          {t("pdfShowInNote")}
                        </button>
                        <button
                          type="button"
                          className="quiet danger"
                          onClick={() => {
                            void remove(item);
                          }}
                        >
                          {t("pdfRemoveHighlight")}
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

const noMarks: readonly Mark[] = [];
