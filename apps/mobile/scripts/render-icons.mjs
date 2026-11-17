// Renders the desktop app's icon.svg to Android's launcher icons for the
// launchers before adaptive icons, Android 7: mipmap-*/ic_launcher.png, and
// ic_launcher_round.png on a round body. Android 8 and later draw the
// adaptive icon from drawable-v24/ic_launcher_foreground.xml instead. Run it
// after changing the icon: pnpm --filter @nether/mobile icons
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const svg = await readFile(new URL("../../desktop/icon.svg", import.meta.url), "utf8");
// The same mark on a circle, for launchers that show round icons.
const round = svg.replace(/<rect [^>]*\/>/, '<circle cx="512" cy="512" r="430" fill="#17141f"/>');
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const res = new URL("../android/app/src/main/res/", import.meta.url);

const browser = await chromium.launch();
try {
  for (const [density, size] of Object.entries(densities)) {
    for (const [name, source] of [
      ["ic_launcher", svg],
      ["ic_launcher_round", round],
    ]) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block;width:${String(size)}px;height:${String(size)}px}</style>${source}`,
      );
      await page.screenshot({
        path: fileURLToPath(new URL(`mipmap-${density}/${name}.png`, res)),
        omitBackground: true,
      });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
