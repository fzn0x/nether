// A PDF's pages, drawn by pdf.js (ADR 0061), for the PDF view and for a
// PDF embedded in a note (ADR 0067): the PDF loaded through the vault's
// files, each page's canvas, the words laid over it for selecting, the
// marks of highlights and passages on it, and the PDF's own links. pdf.js
// loads with this module, which only the PDF view and a PDF embed on
// screen import.
import { type PdfRect, type PdfSelection, colorValue } from "@nether/pdf";
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
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { t } from "./messages.ts";
import { type PdfDestination, destinationOf, webAddress } from "./PdfOutline.tsx";

export type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

/** A page's size at 100%, in CSS pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * What is marked on a page: a highlight, the one chosen, the words to
 * highlight, a match of Find, a link's passage, or an area being drawn.
 */
export type MarkKind = "highlight" | "chosen" | "pending" | "match" | "focus" | "area";

/** A mark of words, by their selection, or of a box of the page, by PDF++'s rect (ADR 0067). */
export interface Mark {
  readonly key: string;
  readonly kind: MarkKind;
  readonly selection?: PdfSelection | undefined;
  readonly rect?: PdfRect | undefined;
  /** A highlight's color, as CSS; none for the default. */
  readonly color?: string | undefined;
}

/** A mark's box on its page, in CSS pixels from the page's corner. */
export interface MarkBox {
  readonly key: string;
  readonly kind: MarkKind;
  readonly color: string | undefined;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Drawing an area of a page (ADR 0067): what changes the box, and when it takes the focus. */
export interface AreaDrawing {
  /** Whether a drag on the page draws a box. */
  readonly drawing: boolean;
  /** Changes each time the box should take the keyboard's focus. */
  readonly focusKey: number;
  readonly onArea: (page: number, rect: PdfRect) => void;
  readonly onDone: () => void;
  readonly onCancel: () => void;
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

type Viewport = ReturnType<PDFPageProxy["getViewport"]>;

/** A box of the page, in its own units, as CSS pixels at a viewport. */
function rectBox(viewport: Viewport, rect: PdfRect) {
  const [x1, y1, x2, y2] = rect;
  const [left = 0, top = 0] = viewport.convertToViewportPoint(x1, y1) as number[];
  const [right = 0, bottom = 0] = viewport.convertToViewportPoint(x2, y2) as number[];
  return {
    left: Math.min(left, right),
    top: Math.min(top, bottom),
    width: Math.abs(right - left),
    height: Math.abs(bottom - top),
  };
}

/** Two corners in CSS pixels at a viewport, as a box of the page in its own units. */
function pdfRect(viewport: Viewport, a: readonly number[], b: readonly number[]): PdfRect {
  const [x1 = 0, y1 = 0] = viewport.convertToPdfPoint(a[0] ?? 0, a[1] ?? 0) as number[];
  const [x2 = 0, y2 = 0] = viewport.convertToPdfPoint(b[0] ?? 0, b[1] ?? 0) as number[];
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
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

/** A PDF open, and how many views and embeds draw it. */
interface Opened {
  refs: number;
  readonly doc: Promise<PDFDocumentProxy>;
  readonly stop: () => void;
}

/** The PDFs open, by vault, then by path and the file's size and time. */
const opened = new WeakMap<Vault, Map<string, Opened>>();

/** Loads a PDF through the vault's files, with a worker of its own, which `stop` ends. */
function load(vault: Vault, path: string): Opened {
  let port: Worker | undefined;
  let worker: PDFWorker | undefined;
  let task: PDFDocumentLoadingTask | undefined;
  let stopped = false;
  const doc = vault.readBytes(path).then((file) => {
    if (stopped) throw new Error(t("pdfGone"));
    port = new PdfJsWorker();
    worker = PDFWorker.create({ port });
    task = getDocument({ data: file.bytes, worker, ...resources() });
    return task.promise;
  });
  return {
    refs: 0,
    doc,
    stop() {
      stopped = true;
      const done = task?.destroy() ?? Promise.resolve();
      void done.finally(() => {
        worker?.destroy();
        port?.terminate();
        // What the text layers measured text with, unless another PDF still draws.
        TextLayer.cleanup();
      });
    },
  };
}

/**
 * The PDF at `path`, for one view or embed: every view and embed of the
 * same file shares one, which closes, with its worker, when the last lets
 * it go, so that nothing stays once none draws it.
 */
function acquire(vault: Vault, path: string, stamp: string) {
  let byFile = opened.get(vault);
  if (byFile === undefined) {
    byFile = new Map();
    opened.set(vault, byFile);
  }
  const key = `${path}\n${stamp}`;
  let entry = byFile.get(key);
  if (entry === undefined) {
    entry = load(vault, path);
    byFile.set(key, entry);
  }
  const held = entry;
  const files = byFile;
  held.refs += 1;
  let released = false;
  return {
    doc: held.doc,
    release() {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      files.delete(key);
      held.stop();
    },
  };
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
    // StrictMode starts this twice: what the first start held is let go.
    const controller = new AbortController();
    const stopped = () => controller.signal.aborted;
    setState({});
    const info = vault.fileInfo(path);
    if (info === undefined) {
      setState({ error: t("pdfGone") });
      return;
    }
    const held = acquire(vault, path, `${String(info.size)}:${String(info.modified)}`);
    held.doc.then(
      (doc) => {
        if (!stopped()) setState({ doc });
      },
      (error: unknown) => {
        if (!stopped()) setState({ error: errorText(error) });
      },
    );
    return () => {
      controller.abort();
      held.release();
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
  /** Drawing an area, when the view draws one. */
  readonly area?: AreaDrawing | undefined;
  /** Shows a mark a focus asked for; by default, scrolls it to the middle of the screen. */
  readonly onShow?: ((target: Element) => void) | undefined;
  /** Hears the marks' boxes each time they are laid out, as an embed crops to them. */
  readonly onBoxes?: ((boxes: readonly MarkBox[]) => void) | undefined;
}) {
  const { doc, number, count, size, scale, near, marks, focus, textOf, onText, onSize, onError } =
    props;
  const [links, setLinks] = useState<readonly PageLink[]>([]);
  const page = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [divs, setDivs] = useState<readonly HTMLElement[] | undefined>();
  const [viewport, setViewport] = useState<Viewport | undefined>();

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
      setViewport(viewport);
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
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = rect as number[];
        found.push({ ...rectBox(viewport, [x1, y1, x2, y2]), to });
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
      setViewport(undefined);
      setLinks([]);
      onText(number, undefined);
      container?.replaceChildren();
      if (drawn !== null) {
        drawn.width = 0;
        drawn.height = 0;
      }
    };
  }, [doc, number, scale, near, textOf, onText, onSize, onError]);

  // The marks: words' boxes once the text layer is drawn, a box of the page once its viewport is known.
  const [boxes, setBoxes] = useState<readonly MarkBox[]>([]);
  const { onBoxes } = props;
  useLayoutEffect(() => {
    const element = page.current;
    if (element === null) {
      setBoxes([]);
      return;
    }
    const corner = element.getBoundingClientRect();
    const laid = marks.flatMap((mark) => {
      let found: { left: number; top: number; width: number; height: number }[] = [];
      if (mark.rect !== undefined) {
        if (viewport !== undefined) found = [rectBox(viewport, mark.rect)];
      } else if (divs !== undefined && mark.selection !== undefined) {
        found = boxesOf(divs, mark.selection, corner);
      }
      return found.map((box, index) => ({
        ...box,
        key: `${mark.key}:${String(index)}`,
        kind: mark.kind,
        color: mark.color,
      }));
    });
    setBoxes(laid);
    onBoxes?.(laid);
  }, [divs, viewport, marks, onBoxes]);

  // An area being drawn by a drag, from where it started, in CSS pixels.
  const { area } = props;
  const [dragged, setDragged] = useState<
    { readonly from: readonly number[]; readonly to: readonly number[] } | undefined
  >();
  const pointAt = (event: PointerEvent<HTMLElement>): number[] => {
    const corner = page.current?.getBoundingClientRect();
    return [event.clientX - (corner?.left ?? 0), event.clientY - (corner?.top ?? 0)];
  };
  const areaButton = useRef<HTMLButtonElement>(null);
  const areaBox = boxes.find((box) => box.kind === "area");
  const hasArea = areaBox !== undefined;
  const areaFocus = area?.focusKey ?? 0;
  useEffect(() => {
    if (areaFocus > 0 && hasArea) areaButton.current?.focus();
  }, [areaFocus, hasArea]);
  /** Moves the area by the arrow keys, or resizes it with Shift, a fiftieth of the page a press. */
  const onAreaKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (area === undefined || areaBox === undefined || viewport === undefined) return;
    if (event.key === "Escape") {
      event.preventDefault();
      area.onCancel();
      return;
    }
    const steps: Readonly<Record<string, readonly [number, number]>> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const dx = (step[0] * viewport.width) / 50;
    const dy = (step[1] * viewport.height) / 50;
    const { left, top, width, height } = areaBox;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    if (event.shiftKey) {
      const right = clamp(left + width + dx, left + 8, viewport.width);
      const bottom = clamp(top + height + dy, top + 8, viewport.height);
      area.onArea(number, pdfRect(viewport, [left, top], [right, bottom]));
      return;
    }
    const x = clamp(left + dx, 0, viewport.width - width);
    const y = clamp(top + dy, 0, viewport.height - height);
    area.onArea(number, pdfRect(viewport, [x, y], [x + width, y + height]));
  };

  // A passage asked for is scrolled to once its marks are drawn.
  const shown = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (focus?.page !== number || focus.mark === undefined || shown.current === focus.key) return;
    const target = page.current?.querySelector(`[data-mark="${CSS.escape(focus.mark)}"]`);
    if (target === null || target === undefined) return;
    shown.current = focus.key;
    if (props.onShow === undefined) target.scrollIntoView({ block: "center" });
    else props.onShow(target);
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
        {boxes
          .filter((box) => box.kind !== "area")
          .map((box) => (
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
      {area?.drawing === true ? (
        <div
          className="pdf-draw"
          aria-hidden="true"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const at = pointAt(event);
            setDragged({ from: at, to: at });
          }}
          onPointerMove={(event) => {
            if (dragged !== undefined) setDragged({ from: dragged.from, to: pointAt(event) });
          }}
          onPointerUp={(event) => {
            const drag = dragged === undefined ? undefined : { ...dragged, to: pointAt(event) };
            setDragged(undefined);
            if (drag === undefined || viewport === undefined) return;
            const [fx = 0, fy = 0] = drag.from;
            const [tx = 0, ty = 0] = drag.to;
            // A click, not a drag, draws nothing.
            if (Math.abs(tx - fx) < 6 || Math.abs(ty - fy) < 6) return;
            area.onArea(number, pdfRect(viewport, drag.from, drag.to));
          }}
        >
          {dragged === undefined ? null : (
            <div
              className="pdf-mark pdf-mark-area"
              style={{
                left: `${String(Math.min(dragged.from[0] ?? 0, dragged.to[0] ?? 0))}px`,
                top: `${String(Math.min(dragged.from[1] ?? 0, dragged.to[1] ?? 0))}px`,
                width: `${String(Math.abs((dragged.to[0] ?? 0) - (dragged.from[0] ?? 0)))}px`,
                height: `${String(Math.abs((dragged.to[1] ?? 0) - (dragged.from[1] ?? 0)))}px`,
              }}
            />
          )}
        </div>
      ) : null}
      {area === undefined || areaBox === undefined || viewport === undefined ? null : (
        <button
          ref={areaButton}
          type="button"
          className="pdf-mark pdf-mark-area pdf-area"
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Enter Escape"
          aria-label={t("pdfAreaBox", {
            page: number,
            left: Math.round((areaBox.left / viewport.width) * 100),
            top: Math.round((areaBox.top / viewport.height) * 100),
            width: Math.round((areaBox.width / viewport.width) * 100),
            height: Math.round((areaBox.height / viewport.height) * 100),
          })}
          style={{
            left: `${String(areaBox.left)}px`,
            top: `${String(areaBox.top)}px`,
            width: `${String(areaBox.width)}px`,
            height: `${String(areaBox.height)}px`,
          }}
          onClick={area.onDone}
          onKeyDown={onAreaKey}
        />
      )}
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
