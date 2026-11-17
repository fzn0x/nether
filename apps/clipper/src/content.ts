// What the popup injects into the tab it clips, when its button is pressed
// and not before (ADR 0066): a function, in the extension's own world of
// the tab, that reads the page as the popup asks. The popup calls it next.
import { readPage } from "./page.ts";

(globalThis as { netherReadPage?: (whole: boolean) => unknown }).netherReadPage = (whole) =>
  readPage(document, window.getSelection(), whole);
