/**
 * Visual-parity screenshot helper (template).
 *
 * Renders two URLs at matched widths and saves viewport + full-page screenshots so you can compare
 * a migrated store against the client's live original, region by region.
 *
 * Usage:
 *   npm i -D playwright && npx playwright install chromium
 *   node compare.mjs http://localhost:4321/<tenant>/ https://www.client-store.com
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const [, , mineUrl, originalUrl] = process.argv;
if (!mineUrl || !originalUrl) {
  console.error("usage: node compare.mjs <mine-url> <original-url>");
  process.exit(1);
}

const WIDTHS = [390, 1280]; // mobile + desktop
const targets = [
  { name: "mine", url: mineUrl, dismissAgeGate: true },
  { name: "original", url: originalUrl, dismissAgeGate: false },
];

await mkdir("shots", { recursive: true });
const browser = await chromium.launch();

for (const t of targets) {
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(t.url, { waitUntil: "networkidle" });
    if (t.dismissAgeGate) {
      // Best-effort: click a "21 or older" affordance if present so it doesn't cover the fold.
      const btn = page.getByRole("button", { name: /21|older|yes|enter/i }).first();
      if (await btn.count()) await btn.click().catch(() => {});
    }
    await page.screenshot({ path: `shots/${t.name}-${width}-viewport.png` });
    await page.screenshot({ path: `shots/${t.name}-${width}-full.png`, fullPage: true });
    console.log(`saved shots/${t.name}-${width}-*.png`);
    await page.close();
  }
}

await browser.close();
