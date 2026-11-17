// @vitest-environment jsdom
// Reading a page in its tab (ADR 0066): the selection as it is, or the
// whole page's article through Readability, its menus left behind, and
// every link's and image's address made absolute.
import { describe, expect, it } from "vitest";
import { absolute, readPage } from "../src/page.ts";

const article = `
  <nav><a href="/">Home</a> <a href="/about">About</a></nav>
  <article>
    <h1>How tides work</h1>
    <p class="byline">By Ada Lovelace</p>
    ${Array.from(
      { length: 8 },
      (_, index) =>
        `<p>The moon pulls the sea toward it, paragraph ${String(index + 1)} of a long article about tides,
        with a <a href="notes/tides.html">link</a> and enough words that a reader view takes it
        for the page's text rather than its furniture.</p>`,
    ).join("\n")}
    <p><img src="images/moon.png" srcset="images/moon-2x.png 2x" alt="The moon"></p>
  </article>
  <footer>Copyright and cookies</footer>
  <script>tracking()</script>`;

function load(html: string, title = "How tides work | The Sea Paper"): Document {
  window.history.replaceState(null, "", "/2026/tides/index.html");
  document.title = title;
  document.body.innerHTML = html;
  return document;
}

/** Selects the text of an element. */
function select(selector: string): Selection {
  const selection = window.getSelection();
  if (selection === null) throw new Error("No selection here.");
  const range = document.createRange();
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`No ${selector} here.`);
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("readPage", () => {
  it("reads the whole page's article, leaving its menus, footer and scripts behind", () => {
    const page = readPage(load(article), window.getSelection(), false);
    expect(page.selected).toBe(false);
    expect(page.hasSelection).toBe(false);
    expect(page.url).toBe(`${location.origin}/2026/tides/index.html`);
    expect(page.html).toContain("The moon pulls the sea toward it");
    expect(page.html).not.toContain("Copyright and cookies");
    expect(page.html).not.toContain("tracking()");
    expect(page.html).not.toContain(">About<");
    expect(page.html).toContain(`href="${location.origin}/2026/tides/notes/tides.html"`);
    expect(page.html).toContain(`src="${location.origin}/2026/tides/images/moon.png"`);
    expect(page.html).not.toContain("srcset");
    expect(page.byline).toBe("By Ada Lovelace");
    // The title is the page's heading, without the site's name.
    expect(page.title).toBe("How tides work");
  });

  it("reads the selection as it is, unless asked for the whole page", () => {
    load(article);
    const selection = select("article p:nth-of-type(3)");
    const page = readPage(document, selection, false);
    expect(page).toMatchObject({
      selected: true,
      hasSelection: true,
      title: "How tides work",
    });
    expect(page.html).toContain("paragraph 2 of a long article");
    expect(page.html).not.toContain("paragraph 3 of");
    expect(page.html).toContain(`href="${location.origin}/2026/tides/notes/tides.html"`);
    const whole = readPage(document, selection, true);
    expect(whole).toMatchObject({ selected: false, hasSelection: true });
    expect(whole.html).toContain("paragraph 8 of");
  });

  it("clips the body of a page Readability finds no article in", () => {
    const page = readPage(load("<p>Short.</p><style>p {}</style>", "Note"), null, false);
    expect(page.html).toContain("Short.");
    expect(page.html).not.toContain("<style>");
    expect(page.title).toBe("Note");
  });
});

describe("absolute", () => {
  it("makes addresses absolute, and drops script links", () => {
    const holder = document.createElement("div");
    holder.innerHTML =
      '<a href="../up.html">up</a><a href="javascript:alert(1)">no</a><img src="//cdn.example/x.png">';
    absolute(holder, "https://example.org/a/b/page.html");
    expect(holder.innerHTML).toBe(
      '<a href="https://example.org/a/up.html">up</a><a>no</a><img src="https://cdn.example/x.png">',
    );
  });
});
