// A note as search by meaning embeds it (ADR 0074): passages of its text,
// each under its headings, cut at a paragraph's end once it passes about
// 1,000 characters, and a long paragraph at a sentence's end. A passage is
// embedded with the note's title and its headings before its text, so it
// keeps what it is about, and kept with a hash of that, so a note that
// changes sends only its changed passages again.

/** About how long a passage grows before it is cut, at a paragraph's end. */
export const passageLength = 1000;

/** A paragraph longer than this is cut at the ends of its sentences. */
const paragraphLength = 2000;

/** At most this many passages are made of one note. */
export const passagesPerNote = 200;

/** How much of a passage's text a result shows. */
const previewLength = 200;

export interface Passage {
  /** Its place among the note's passages, from 0. */
  readonly ordinal: number;
  /** The headings it is under, the outermost first; none before the note's first. */
  readonly headings: readonly string[];
  /** What is embedded: the note's title and the headings, then the text. */
  readonly input: string;
  /** A hash of `input`, which tells whether it changed. */
  readonly hash: string;
  /** The start of its text, its spaces folded, for a result to show. */
  readonly preview: string;
}

/** A short hash of a text, the same for the same text, to tell when it changes. */
export function hashText(text: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return (second >>> 0).toString(16).padStart(8, "0") + (first >>> 0).toString(16).padStart(8, "0");
}

/** A note's text without the frontmatter it may start with. */
function withoutFrontmatter(markdown: string): string {
  const found = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(markdown);
  return found === null ? markdown : markdown.slice(found[0].length);
}

/** A paragraph in pieces no longer than a passage, cut at sentences' ends, or at a space. */
function piecesOf(paragraph: string): string[] {
  if (paragraph.length <= paragraphLength) return [paragraph];
  const pieces: string[] = [];
  let piece = "";
  for (const sentence of paragraph.split(/(?<=[.!?。！？])\s+/)) {
    let rest = sentence;
    // A sentence longer than a passage is cut at its last space before one.
    while (rest.length > passageLength) {
      const space = rest.lastIndexOf(" ", passageLength);
      const end = space > 0 ? space : passageLength;
      if (piece !== "") {
        pieces.push(piece);
        piece = "";
      }
      pieces.push(rest.slice(0, end).trim());
      rest = rest.slice(end).trim();
    }
    if (piece !== "" && piece.length + 1 + rest.length > passageLength) {
      pieces.push(piece);
      piece = "";
    }
    piece = piece === "" ? rest : `${piece} ${rest}`;
  }
  if (piece !== "") pieces.push(piece);
  return pieces.filter((each) => each !== "");
}

/** Whether a line closes the fenced code block `fence` opened. */
function closes(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && trimmed === fence.charAt(0).repeat(trimmed.length);
}

/** A note's passages, as search by meaning embeds them; none for a note with no text. */
export function passagesOf(title: string, markdown: string): Passage[] {
  const passages: Passage[] = [];
  const headings: { readonly level: number; readonly text: string }[] = [];
  let paragraph: string[] = [];
  let pending: string[] = [];
  let pendingLength = 0;
  let fence: string | undefined;

  const flush = () => {
    if (pending.length === 0 || passages.length >= passagesPerNote) {
      pending = [];
      pendingLength = 0;
      return;
    }
    const text = pending.join("\n\n");
    const under = headings.map((heading) => heading.text);
    const input = `${[title, ...under].join(" > ")}\n\n${text}`;
    passages.push({
      ordinal: passages.length,
      headings: under,
      input,
      hash: hashText(input),
      preview: text.replace(/\s+/g, " ").trim().slice(0, previewLength),
    });
    pending = [];
    pendingLength = 0;
  };

  const endParagraph = () => {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (text === "") return;
    for (const piece of piecesOf(text)) {
      pending.push(piece);
      pendingLength += piece.length;
      if (pendingLength >= passageLength) flush();
    }
  };

  for (const line of withoutFrontmatter(markdown).split(/\r?\n/)) {
    if (fence !== undefined) {
      paragraph.push(line);
      if (closes(line, fence)) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening?.[1] !== undefined) {
      fence = opening[1];
      paragraph.push(line);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading?.[1] !== undefined) {
      endParagraph();
      flush();
      const level = heading[1].length;
      while ((headings.at(-1)?.level ?? 0) >= level) headings.pop();
      const text = (heading[2] ?? "").trim();
      if (text !== "") headings.push({ level, text });
      continue;
    }
    if (line.trim() === "") endParagraph();
    else paragraph.push(line);
  }
  endParagraph();
  flush();
  return passages;
}
