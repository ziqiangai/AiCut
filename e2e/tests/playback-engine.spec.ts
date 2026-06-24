import { expect, test } from "@playwright/test";

/**
 * Verifies the new pluggable PlaybackEngine surface end-to-end:
 * the demo offers a radio to switch between the default
 * HtmlVideoEngine and the host-supplied CanvasCompositorEngine,
 * and flipping it really swaps the rendering surface (raw <video>
 * vs <canvas> + HUD badge).
 *
 * Both modes must remain interactive — play / pause / seek go
 * through the same EditorApi regardless of which engine answered.
 */
test.describe("PlaybackEngine swap", () => {
  test("default mode renders via <video>, canvas mode via <canvas> + HUD badge", async ({
    page,
  }) => {
    await page.goto("/");

    const preview = page.getByTestId("aicut-preview");
    await expect(preview).toBeVisible();

    // Default: HTML5 video engine — preview has at least one <video>,
    // no canvas under the preview, no compositor HUD.
    await expect(page.getByTestId("demo-engine-html")).toBeChecked();
    await expect(preview.locator("video")).toHaveCount(2); // two sources seeded
    await expect(preview.locator("canvas")).toHaveCount(0);
    await expect(preview.locator(".aicut-preview__badge")).toHaveCount(0);

    // Flip to the canvas engine.
    await page.getByTestId("demo-engine-canvas").check();
    await expect(page.getByTestId("demo-engine-canvas")).toBeChecked();

    // Now preview owns a canvas + the engine HUD; the decode videos
    // are kept off the DOM tree (canvas owns the pixels).
    await expect(preview.locator("canvas")).toHaveCount(1);
    await expect(preview.locator(".aicut-preview__badge")).toHaveText(
      /canvas compositor/,
    );
    await expect(preview.locator("video")).toHaveCount(0);

    // Editor controls are still wired — play through the editor API.
    await expect
      .poll(
        async () =>
          await page.evaluate(() => Boolean((window as any).__aicut?.api)),
        { timeout: 10_000 },
      )
      .toBe(true);
    await page.evaluate(() => (window as any).__aicut.api.seek(500));
    await expect(preview.locator(".aicut-preview__badge")).toContainText(
      /t=0\.5/,
    );

    // Switching back restores the default engine — same contract.
    await page.getByTestId("demo-engine-html").check();
    await expect(preview.locator("canvas")).toHaveCount(0);
    await expect(preview.locator(".aicut-preview__badge")).toHaveCount(0);
    await expect(preview.locator("video")).toHaveCount(2);
  });
});
