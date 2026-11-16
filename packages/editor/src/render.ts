// Math and code drawn for a page outside the editor, as an exported note
// shows them: math as MathML, which browsers draw with no fonts or styles
// of KaTeX's, and code highlighted as the editor highlights it, as spans
// with highlight.js's classes. KaTeX loads on first use.
import { codeLanguage, lowlight } from "./schema.ts";

type Highlighted = ReturnType<typeof lowlight.highlight>;
type HighlightNode = Highlighted | Highlighted["children"][number];

const escapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (char) => escapes[char] ?? char);
}

function toHtml(node: HighlightNode): string {
  switch (node.type) {
    case "root":
      return node.children.map(toHtml).join("");
    case "text":
      return escape(node.value);
    case "element": {
      const names = node.properties.className;
      const classes = Array.isArray(names) ? names.join(" ") : "";
      return `<span class="${escape(classes)}">${node.children.map(toHtml).join("")}</span>`;
    }
    default:
      return "";
  }
}

/**
 * Code as HTML, highlighted in the languages the editor highlights; code
 * without a language, or in one it does not know, as its text.
 */
export function highlightCode(text: string, info: string): string {
  const language = codeLanguage(info);
  return language !== "" && lowlight.registered(language)
    ? toHtml(lowlight.highlight(language, text))
    : escape(text);
}

type RenderMath = (latex: string, display: boolean) => string;
let loadingMath: Promise<RenderMath> | undefined;

/** LaTeX as MathML, or as its text in an error's colors when KaTeX cannot read it. */
export async function mathToMathml(latex: string, display: boolean): Promise<string> {
  loadingMath ??= import("katex").then(
    ({ default: katex }) =>
      (source: string, block: boolean) =>
        katex.renderToString(source, { output: "mathml", displayMode: block, throwOnError: false }),
  );
  return (await loadingMath)(latex, display);
}
