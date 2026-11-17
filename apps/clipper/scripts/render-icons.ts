// Renders the desktop app's icon.svg to the clipper's icons, icons/icon-16.png
// to icons/icon-128.png, with transparent corners. Run it after changing
// the icon: pnpm --filter @nether/clipper icons
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const svg = await readFile(new URL("../../desktop/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${String(size)}px;height:${String(size)}px}</style>${svg}`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL(`../icons/icon-${String(size)}.png`, import.meta.url)),
      omitBackground: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
