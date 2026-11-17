// A PDF embedded in a note (ADR 0067), until it comes near the screen: a
// box of its size with the PDF's name. Only then does it load the code
// that draws PDFs, pdf.js with it, so a note with embeds far down loads
// none of it while they stay there.
import { readEmbedSize, readPdfPlace } from "@nether/pdf";
import type { Vault } from "@nether/storage";
import { type ReactNode, Suspense, lazy, useEffect, useRef, useState } from "react";
import { t } from "./messages.ts";

const PdfEmbedView = lazy(() => import("./PdfEmbedView.tsx"));

/** What a PDF embed shows, and what it opens. */
export interface PdfEmbedProps {
  readonly vault: Vault;
  /** The PDF, by its path in the vault. */
  readonly path: string;
  /** What followed the link's `#`: a page, a passage, a box, a height. */
  readonly part: string | undefined;
  /** Opens the PDF in a tab, at a place, as a link's part after `#`. */
  readonly onOpen?: ((part: string) => void) | undefined;
}

/** How tall a whole PDF's box is unless the link says, as Obsidian's `#height=`. */
export const embedHeight = 480;

/** Whether an embed shows a passage or a box alone, rather than the PDF. */
export function showsPassage(part: string | undefined): boolean {
  const place = part === undefined ? undefined : readPdfPlace(part);
  return place?.selection !== undefined || place?.rect !== undefined;
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.pdf$/i, "");
}

export function PdfEmbed(props: PdfEmbedProps) {
  const { path, part } = props;
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (element === null || near) return;
    const watching = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "50% 0px" },
    );
    watching.observe(element);
    return () => {
      watching.disconnect();
    };
  }, [near]);
  const name = nameOf(path);
  const passage = showsPassage(part);
  const { height, width } = readEmbedSize(part);
  const waiting = (
    <p
      className="pdf-embed-waiting"
      style={{ height: `${String(passage ? 160 : (height ?? embedHeight))}px` }}
    >
      {name}
    </p>
  );
  return (
    <div
      ref={box}
      className={passage ? "pdf-embed pdf-embed-passage" : "pdf-embed"}
      role="figure"
      aria-label={t("pdfEmbed", { name })}
      style={width === undefined ? undefined : { maxWidth: `${String(width)}px` }}
    >
      {near ? (
        <Suspense fallback={waiting}>
          <PdfEmbedView {...props} name={name} />
        </Suspense>
      ) : (
        waiting
      )}
    </div>
  );
}

/** A PDF embed, for the editor's files and embeds, which are not components of the app's own. */
export function pdfEmbed(props: PdfEmbedProps): ReactNode {
  return <PdfEmbed key={`${props.path}#${props.part ?? ""}`} {...props} />;
}
