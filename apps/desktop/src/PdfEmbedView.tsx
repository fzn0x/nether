// A PDF embedded in a note, drawn by pdf.js (ADR 0067): the whole PDF in
// a box, at a page and a height, or a passage or a box of a page alone,
// cut to it and marked. It loads only once its embed comes near the
// screen (PdfEmbed.tsx), and shares the PDF with every other view of it.
import {
  type PdfMarked,
  isArea,
  markedOf,
  readEmbedSize,
  readPdfPlace,
  writePdfPlace,
} from "@nether/pdf";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend } from "./backend.ts";
import { t } from "./messages.ts";
import { type PdfEmbedProps, embedHeight } from "./PdfEmbed.tsx";
import type { PdfDestination } from "./PdfOutline.tsx";
import {
  type Mark,
  type MarkBox,
  PdfPage,
  type Size,
  type TextContent,
  cssColor,
  usePdf,
} from "./pdfPages.tsx";

const ignore = () => undefined;

/** Each page's words, read once while the PDF is open. */
function useTextOf(doc: PDFDocumentProxy | undefined) {
  return useMemo(() => {
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
}

/** How wide the embed is, as the note lays it out. */
function useWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (element === null) return;
    setWidth(element.clientWidth);
    const watching = new ResizeObserver(() => {
      setWidth(element.clientWidth);
    });
    watching.observe(element);
    return () => {
      watching.disconnect();
    };
  }, [element]);
  return width;
}

function Bar(props: {
  readonly name: string;
  readonly where: string;
  readonly onOpen: (() => void) | undefined;
}) {
  const { name, where, onOpen } = props;
  return (
    <div className="pdf-embed-bar">
      <span className="pdf-embed-name">{name}</span>
      <span className="pdf-embed-where">{where}</span>
      {onOpen === undefined ? null : (
        <button
          type="button"
          className="quiet"
          title={t("pdfEmbedOpenHint", { name })}
          onClick={onOpen}
        >
          {t("pdfEmbedOpen")}
        </button>
      )}
    </div>
  );
}

/** The whole PDF in a box, from a page, its pages drawn as they near what the box shows. */
function WholePdf(props: {
  readonly doc: PDFDocumentProxy;
  readonly name: string;
  readonly start: number;
  readonly height: number;
  readonly onOpen: ((part: string) => void) | undefined;
  readonly onError: (error: unknown) => void;
}) {
  const { doc, name, start, height, onOpen, onError } = props;
  const textOf = useTextOf(doc);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const width = useWidth(scroller);
  const [sizes, setSizes] = useState<readonly Size[]>([]);
  useEffect(() => {
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
    }, onError);
    return () => {
      live = false;
    };
  }, [doc, onError]);
  const onSize = useCallback((page: number, size: Size) => {
    setSizes((current) => {
      const was = current[page - 1];
      if (was === undefined || (was.width === size.width && was.height === size.height)) {
        return current;
      }
      return current.with(page - 1, size);
    });
  }, []);
  const firstWidth = sizes[0]?.width;
  const scale = firstWidth === undefined || width === 0 ? undefined : (width - 16) / firstWidth;

  // The pages near what the box shows, drawn.
  const elements = useRef(new Map<number, HTMLElement>());
  const [near, setNear] = useState<ReadonlySet<number>>(new Set());
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  useEffect(() => {
    if (scroller === null) return;
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
      { root: scroller, rootMargin: "100% 0px" },
    );
    observer.current = watching;
    for (const element of elements.current.values()) watching.observe(element);
    return () => {
      watching.disconnect();
      observer.current = undefined;
    };
  }, [scroller]);
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
  const goTo = useCallback(
    (page: number, y = 0) => {
      const element = elements.current.get(page);
      if (element !== undefined && scroller !== null) {
        scroller.scrollTop = element.offsetTop + y * (scale ?? 1) - 4;
      }
    },
    [scroller, scale],
  );

  // At its page, once the pages are laid out.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || scale === undefined || sizes.length === 0) return;
    started.current = true;
    goTo(Math.min(start, sizes.length));
  }, [scale, sizes.length, start, goTo]);
  const [current, setCurrent] = useState(start);
  const onScroll = () => {
    if (scroller === null) return;
    const line = scroller.scrollTop + scroller.clientHeight / 3;
    let found = 1;
    for (const [page, element] of elements.current) {
      if (element.offsetTop <= line && page > found) found = page;
    }
    setCurrent(found);
  };
  const onLink = useCallback(
    (to: PdfDestination | { readonly url: string }) => {
      if ("url" in to) void backend.openUrl(to.url);
      else goTo(to.page, to.y);
    },
    [goTo],
  );

  return (
    <>
      <Bar
        name={name}
        where={t("pdfEmbedPage", { page: current, count: sizes.length })}
        onOpen={
          onOpen === undefined
            ? undefined
            : () => {
                onOpen(writePdfPlace({ page: current }));
              }
        }
      />
      <div
        ref={setScroller}
        className="pdf-embed-pages"
        tabIndex={0}
        role="region"
        aria-label={t("pdfPages", { name })}
        style={{ height: `${String(height)}px` }}
        onScroll={onScroll}
      >
        {scale === undefined
          ? null
          : sizes.map((size, index) => (
              <PdfPage
                key={index + 1}
                doc={doc}
                number={index + 1}
                count={sizes.length}
                size={size}
                scale={scale}
                near={near.has(index + 1)}
                marks={noMarks}
                focus={undefined}
                textOf={textOf}
                onText={ignore}
                onSize={onSize}
                onError={onError}
                register={register}
                onLink={onLink}
              />
            ))}
      </div>
    </>
  );
}

/** A passage or a box of a page alone, cut to it and marked, as wide as the embed. */
function Passage(props: {
  readonly doc: PDFDocumentProxy;
  readonly name: string;
  readonly passage: PdfMarked;
  readonly onOpen: (() => void) | undefined;
  readonly onError: (error: unknown) => void;
}) {
  const { doc, name, passage, onOpen, onError } = props;
  const page = Math.min(passage.page, doc.numPages);
  const textOf = useTextOf(doc);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const width = useWidth(frame);
  const [proxy, setProxy] = useState<PDFPageProxy | undefined>();
  const size = useMemo((): Size | undefined => {
    const viewport = proxy?.getViewport({ scale: 1 });
    return viewport === undefined ? undefined : { width: viewport.width, height: viewport.height };
  }, [proxy]);
  useEffect(() => {
    let live = true;
    void doc.getPage(page).then((found) => {
      if (live) setProxy(found);
    }, onError);
    return () => {
      live = false;
    };
  }, [doc, page, onError]);
  // A box fills the embed's width; a passage shows its page's whole width.
  const area = isArea(passage) ? passage.rect : undefined;
  const across = area === undefined ? size?.width : area[2] - area[0];
  const scale =
    across === undefined || width === 0 ? undefined : Math.min(4, Math.max(0.25, width / across));
  // Words are marked in their color; a box is what the embed shows, unmarked.
  const marks = useMemo(
    (): readonly Mark[] =>
      passage.selection === undefined
        ? noMarks
        : [
            {
              key: "passage",
              kind: "highlight",
              selection: passage.selection,
              color: cssColor(passage.color),
            },
          ],
    [passage],
  );
  // Cut to the lines the words are on, once they are laid out.
  const [lines, setLines] = useState<{ top: number; height: number } | undefined>();
  const onBoxes = useCallback((boxes: readonly MarkBox[]) => {
    if (boxes.length === 0) return;
    const top = Math.max(0, Math.min(...boxes.map((box) => box.top)) - 2);
    const bottom = Math.max(...boxes.map((box) => box.top + box.height)) + 2;
    setLines({ top, height: bottom - top });
  }, []);
  // Cut to a box, from where its corners are on the page at this scale.
  const boxCut = useMemo(() => {
    if (area === undefined || proxy === undefined || scale === undefined) return undefined;
    const viewport = proxy.getViewport({ scale });
    const [a = 0, b = 0] = viewport.convertToViewportPoint(area[0], area[1]) as number[];
    const [c = 0, d = 0] = viewport.convertToViewportPoint(area[2], area[3]) as number[];
    return {
      left: Math.min(a, c),
      top: Math.min(b, d),
      width: Math.abs(c - a),
      height: Math.abs(d - b),
    };
  }, [area, proxy, scale]);
  const cut =
    area === undefined
      ? lines === undefined
        ? undefined
        : { left: 0, width: 0, ...lines }
      : boxCut;
  const onLink = useCallback((to: PdfDestination | { readonly url: string }) => {
    if ("url" in to) void backend.openUrl(to.url);
  }, []);
  return (
    <>
      <Bar name={name} where={t("pdfOnPage", { page })} onOpen={onOpen} />
      <div
        ref={setFrame}
        className="pdf-embed-cut"
        style={{
          height: `${String(cut?.height ?? 160)}px`,
          ...(cut === undefined || cut.width === 0 ? {} : { width: `${String(cut.width)}px` }),
        }}
      >
        {scale === undefined || size === undefined ? null : (
          <div
            className="pdf-embed-shift"
            style={{
              transform: `translate(${String(-(cut?.left ?? 0))}px, ${String(-(cut?.top ?? 0))}px)`,
            }}
          >
            <PdfPage
              doc={doc}
              number={page}
              count={doc.numPages}
              size={size}
              scale={scale}
              near
              marks={marks}
              focus={undefined}
              textOf={textOf}
              onText={ignore}
              onSize={ignore}
              onError={onError}
              register={ignore}
              onLink={onLink}
              onBoxes={onBoxes}
            />
          </div>
        )}
      </div>
    </>
  );
}

export default function PdfEmbedView(props: PdfEmbedProps & { readonly name: string }) {
  const { vault, path, part, name, onOpen } = props;
  const { doc, error } = usePdf(vault, path);
  const [problem, setProblem] = useState<string | undefined>();
  const onError = useCallback((reason: unknown) => {
    setProblem(reason instanceof Error ? reason.message : String(reason));
  }, []);
  const place = part === undefined ? undefined : readPdfPlace(part);
  const passage = markedOf(place);
  const { height } = readEmbedSize(part);
  if (error !== undefined || problem !== undefined) {
    return (
      <p className="pdf-embed-error" role="alert">
        {error ?? problem}
      </p>
    );
  }
  if (doc === undefined) {
    return (
      <p className="pdf-embed-waiting" style={{ height: `${String(height ?? embedHeight)}px` }}>
        {t("pdfLoading")}
      </p>
    );
  }
  return passage === undefined ? (
    <WholePdf
      doc={doc}
      name={name}
      start={place?.page ?? 1}
      height={height ?? embedHeight}
      onOpen={onOpen}
      onError={onError}
    />
  ) : (
    <Passage
      doc={doc}
      name={name}
      passage={passage}
      onOpen={
        onOpen === undefined || part === undefined
          ? undefined
          : () => {
              onOpen(part);
            }
      }
      onError={onError}
    />
  );
}

const noMarks: readonly Mark[] = [];
