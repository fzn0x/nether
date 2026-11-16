// A PDF's pages, drawn by pdf.js (ADR 0061), for the PDF view and for a
// PDF embedded in a note (ADR 0067): the PDF loaded through the vault's
// files, each page's canvas, the words laid over it for selecting, the
// marks of highlights and passages on it, and the PDF's own links. pdf.js
// loads with this module, which only the PDF view and a PDF embed on
// screen import.
import { type PdfSelection, colorValue } from "@nether/pdf";
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
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "./messages.ts";
import { type PdfDestination, destinationOf, webAddress } from "./PdfOutline.tsx";

export type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

/** A page's size at 100%, in CSS pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** What is marked on a page: a highlight, the one chosen, the words to highlight, a match of Find, a link's passage. */
export type MarkKind = "highlight" | "chosen" | "pending" | "match" | "focus";

export interface Mark {
  readonly key: string;
  readonly kind: MarkKind;
  readonly selection: PdfSelection;
  /** A highlight's color, as CSS; none for the default. */
  readonly color?: string | undefined;
}

/** A link of the PDF's own on a page (ADR 0062): its box, and where it goes. */
export interface PageLink {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly to: PdfDestination | { readonly url: string };
}

/** A place to show, and a key new each time it is asked, even for the same place. */
export interface Focus {
  readonly page: number;
  readonly mark?: string;
  readonly key: number;
}

/** The most pixels a page's canvas holds, 64 MB: past it, a page is drawn finer than the screen no more. */
const maxPixels = 2 ** 24;

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

export function errorText(error: unknown): string {
  if (error instanceof Error && error.name === "PasswordException") return t("pdfPassword");
  return error instanceof Error ? error.message : String(error);
}

/** A color as CSS, CSS's own names known by the page. */
export function cssColor(color: string | undefined): string | undefined {
  return colorValue(color, (name) => CSS.supports("color", name));
}

/** The PDF at `path`, loaded through the vault's files, again when the file changes. */
export function usePdf(vault: Vault, path: string): { doc?: PDFDocumentProxy; error?: string } {
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
        // What the text layers measured text with, unless another PDF still draws.
        TextLayer.cleanup();
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
export function selectionOf(range: Range, divs: readonly HTMLElement[]): PdfSelection | undefined {
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

export function PdfPage(props: {
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
  /** Follows a link of the PDF's own. */
  readonly onLink: (to: PageLink["to"]) => void;
}) {
  const { doc, number, count, size, scale, near, marks, focus, textOf, onText, onSize, onError } =
    props;
  const [links, setLinks] = useState<readonly PageLink[]>([]);
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
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(maxPixels / (viewport.width * viewport.height)),
      );
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
      // Its links, to its own pages or to the web; others do nothing, so they are left out.
      const found: PageLink[] = [];
      for (const annotation of (await proxy.getAnnotations({ intent: "display" })) as unknown[]) {
        const { subtype, rect, dest, url } = annotation as {
          subtype?: unknown;
          rect?: unknown;
          dest?: unknown;
          url?: unknown;
        };
        if (subtype !== "Link" || !Array.isArray(rect) || rect.length !== 4) continue;
        const web = webAddress(url);
        const to = web !== undefined ? { url: web } : await destinationOf(doc, dest);
        if (to === undefined) continue;
        const [x1, y1, x2, y2] = rect as number[];
        const [left = 0, top = 0] = viewport.convertToViewportPoint(x1 ?? 0, y1 ?? 0) as number[];
        const [right = 0, bottom = 0] = viewport.convertToViewportPoint(
          x2 ?? 0,
          y2 ?? 0,
        ) as number[];
        found.push({
          left: Math.min(left, right),
          top: Math.min(top, bottom),
          width: Math.abs(right - left),
          height: Math.abs(bottom - top),
          to,
        });
      }
      if (cancelled()) return;
      setLinks(found);
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
      setLinks([]);
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
      color: string | undefined;
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
          color: mark.color,
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
              ...(box.color === undefined ? {} : { "--mark-color": box.color }),
            }}
          />
        ))}
      </div>
      <div ref={layer} className="textLayer" />
      {links.length === 0 ? null : (
        <div className="pdf-links">
          {links.map((link, index) => (
            <button
              key={index}
              type="button"
              className="pdf-link"
              aria-label={
                "url" in link.to
                  ? t("pdfLinkTo", { address: link.to.url })
                  : t("pdfGoToPage", { page: link.to.page })
              }
              title={"url" in link.to ? link.to.url : t("pdfGoToPage", { page: link.to.page })}
              style={{
                left: `${String(link.left)}px`,
                top: `${String(link.top)}px`,
                width: `${String(link.width)}px`,
                height: `${String(link.height)}px`,
              }}
              onClick={() => {
                props.onLink(link.to);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
