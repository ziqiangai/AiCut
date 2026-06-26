import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Capture spec — produces the PNGs referenced from the root README.
 *
 * These aren't assertions on product behaviour (the editor-* specs
 * cover that). Their job is to land deterministic, cleanly-framed
 * screenshots in `docs/screenshots/` whenever we re-run them.
 *
 * Run just this suite:
 *   pnpm --filter @aicut/e2e exec playwright test screenshots.spec.ts
 *
 * Framing rules — these are README hero shots, NOT proof of demo
 * tooling. So:
 *   - Hide the dev sidebar (`.demo-sidebar`) and shell padding so
 *     the editor fills the viewport.
 *   - Seed via the editor API rather than waiting on the demo's
 *     `ready` event — the canvas paints clip rectangles even when
 *     the media at 127.0.0.1:8091 isn't reachable.
 */

const SCREENSHOTS_DIR = path.resolve(__dirname, "../../docs/screenshots");

// Media served straight from the dev server's `public/` dir (same
// origin as the demo) — no separate media server to spin up. Drop a
// real file at `examples/react-demo/public/sample.mp4` before running
// these specs.
const SEED_PROJECT = {
  version: 1,
  sources: [
    {
      id: "src-a",
      url: "/sample.mp4",
      kind: "video" as const,
      name: "sample.mp4",
      duration: 5_000,
    },
  ],
  tracks: [
    {
      id: "tr-1",
      kind: "video" as const,
      clips: [
        { id: "cl-1", sourceId: "src-a", in: 0, out: 5_000, start: 0 },
        { id: "cl-2", sourceId: "src-a", in: 0, out: 5_000, start: 5_000 },
      ],
    },
    {
      id: "tr-2",
      kind: "video" as const,
      clips: [
        { id: "cl-3", sourceId: "src-a", in: 0, out: 4_000, start: 1_500 },
      ],
    },
  ],
};

async function waitForApi(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.evaluate(() => Boolean((window as any).__aicut?.api)),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function seed(page: Page): Promise<void> {
  await page.evaluate((p) => {
    const api = (window as any).__aicut.api;
    api.setProject(p);
  }, SEED_PROJECT);
  await page.waitForTimeout(300);
}

/**
 * Strip the demo's dev sidebar + outer padding so the editor takes
 * the full viewport — these screenshots show the LIBRARY, not the
 * tooling around it. Inject as a <style> tag so the layout settles
 * before we snap.
 */
async function isolateEditor(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      .demo-sidebar { display: none !important; }
      .demo-shell {
        display: block !important;
        padding: 0 !important;
        margin: 0 !important;
      }
      .demo-editor {
        height: 100vh !important;
        width: 100vw !important;
      }
      html, body, #root { height: 100% !important; }
    `,
  });
  await page.waitForTimeout(200);
}

test.describe("README screenshots", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test("editor in dark theme (hero)", async ({ page }) => {
    await page.goto("/");
    await waitForApi(page);
    await seed(page);
    await isolateEditor(page);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "editor-dark.png"),
      fullPage: false,
    });
  });

  test("editor in light theme", async ({ page }) => {
    await page.goto("/");
    await waitForApi(page);
    await page.getByTestId("demo-theme-toggle").click();
    await seed(page);
    await isolateEditor(page);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "editor-light.png"),
      fullPage: false,
    });
  });

  test("toolbar custom slots close-up", async ({ page }) => {
    await page.goto("/");
    await waitForApi(page);
    await seed(page);
    await isolateEditor(page);
    await page.waitForSelector('[data-testid="demo-header-export"]');
    const toolbar = page.getByTestId("aicut-toolbar");
    const tb = await toolbar.boundingBox();
    if (!tb) throw new Error("toolbar not visible");
    const pad = 6;
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "toolbar-slots.png"),
      clip: {
        x: Math.max(0, tb.x - pad),
        y: Math.max(0, tb.y - pad),
        width: tb.width + pad * 2,
        height: tb.height + pad * 2,
      },
    });
  });

  test("export progress overlay", async ({ page }) => {
    await page.goto("/");
    await waitForApi(page);
    await seed(page);
    // Don't isolate — we want to show the in-flight progress UI which
    // lives in the sidebar. Just narrow to the relevant block.
    const export_btn = page.getByTestId("demo-export");
    await export_btn.click();
    await page.waitForSelector('[data-testid="demo-export-status"] progress', {
      timeout: 5_000,
    });
    const status = page.locator('[data-testid="demo-export-status"]');
    const box = await status.boundingBox();
    if (!box) throw new Error("export status not visible");
    const pad = 12;
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "export-progress.png"),
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: box.width + pad * 2,
        height: box.height + pad * 2,
      },
    });
  });

  test("standalone frame picker", async ({ page }) => {
    await page.goto("/");
    await waitForApi(page);
    const picker = page.locator(".demo-framepicker");
    await picker.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await picker.screenshot({
      path: path.join(SCREENSHOTS_DIR, "frame-picker.png"),
    });
  });
});
