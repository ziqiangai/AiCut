import { expect, test } from "@playwright/test";

/**
 * Keyframe end-to-end. v4.1 model:
 *   - Keyframes are per-property (panX / panY / scale).
 *   - Toolbar's diamond button captures all three at the playhead.
 *   - Library panel shows up ONLY when a keyframe is selected — it
 *     edits that moment's three values + has a Reset (0 0 1) button.
 */
test.describe("Keyframes (v4.1)", () => {
  test("toolbar add → select diamond → panel edit + reset + undo", async ({
    page,
  }) => {
    await page.goto("/");

    await expect
      .poll(
        async () =>
          await page.evaluate(() => Boolean((window as any).__aicut?.api)),
        { timeout: 10_000 },
      )
      .toBe(true);

    // Seed a clip + select it.
    await page.evaluate(() => {
      const api = (window as any).__aicut.api;
      const p = api.getProject();
      const src = p.sources[0];
      p.tracks[0].clips = [
        {
          id: "kf-test-clip",
          sourceId: src.id,
          in: 0,
          out: 5000,
          start: 0,
        },
      ];
      api.setProject(p);
      api.setSelection("kf-test-clip");
    });

    // Toolbar hidden until the demo toggle.
    const kfBtn = page.getByTestId("aicut-keyframe");
    await expect(kfBtn).toBeHidden();
    await page.getByTestId("demo-keyframes-toggle").check();
    await expect(kfBtn).toBeVisible();

    // Panel hidden until a keyframe is selected.
    const panel = page.getByTestId("aicut-keyframe-panel");
    await expect(panel).toBeHidden();

    // Click the toolbar at t=1000 → 3 kfs land (panX/panY/scale).
    await page.evaluate(() => (window as any).__aicut.api.seek(1000));
    await kfBtn.click();
    const ids = await page.evaluate(() => {
      const p = (window as any).__aicut.api.getProject();
      const clip = p.tracks[0].clips.find(
        (c: { id: string }) => c.id === "kf-test-clip",
      );
      return (clip?.keyframes ?? []).map((k: { id: string }) => k.id);
    });
    expect(ids).toHaveLength(3);

    // Programmatically select one of those keyframes (clicking the
    // canvas diamond is fragile — covered separately).
    await page.evaluate(
      ([id]) =>
        (window as any).__aicut.api.setSelectedKeyframe({
          clipId: "kf-test-clip",
          keyframeId: id,
        }),
      [ids[0]],
    );
    await expect(panel).toBeVisible();

    // Edit Scale via the panel input → kf at the selected moment
    // gets its value updated.
    const scaleIn = page.getByTestId("aicut-kf-scale");
    await scaleIn.fill("1.5");
    await scaleIn.blur();
    await expect
      .poll(async () =>
        await page.evaluate(() => {
          const p = (window as any).__aicut.api.getProject();
          const c = p.tracks[0].clips.find(
            (c: { id: string }) => c.id === "kf-test-clip",
          );
          return (
            c?.keyframes?.find(
              (k: { prop: string; time: number }) =>
                k.prop === "scale" && k.time === 1000,
            )?.value ?? null
          );
        }),
      )
      .toBe(1.5);

    // Reset button pins all three to identity at the selected moment.
    await page.getByTestId("aicut-keyframe-reset").click();
    await expect
      .poll(async () =>
        await page.evaluate(() => {
          const p = (window as any).__aicut.api.getProject();
          const c = p.tracks[0].clips.find(
            (c: { id: string }) => c.id === "kf-test-clip",
          );
          const kfs = (c?.keyframes ?? []).filter(
            (k: { time: number }) => k.time === 1000,
          );
          const map: Record<string, number> = {};
          for (const k of kfs) map[k.prop] = k.value;
          return map;
        }),
      )
      .toEqual({ panX: 0, panY: 0, scale: 1 });

    // Undo → scale = 1.5 again.
    await page.evaluate(() => (window as any).__aicut.api.undo());
    await expect
      .poll(async () =>
        await page.evaluate(() => {
          const p = (window as any).__aicut.api.getProject();
          const c = p.tracks[0].clips.find(
            (c: { id: string }) => c.id === "kf-test-clip",
          );
          return (
            c?.keyframes?.find(
              (k: { prop: string; time: number }) =>
                k.prop === "scale" && k.time === 1000,
            )?.value ?? null
          );
        }),
      )
      .toBe(1.5);

    // Clearing selection hides the panel.
    await page.evaluate(() =>
      (window as any).__aicut.api.setSelectedKeyframe(null),
    );
    await expect(panel).toBeHidden();

    // Disable / re-enable → data preserved.
    await page.getByTestId("demo-keyframes-toggle").uncheck();
    await expect(kfBtn).toBeHidden();
    const stillThere = await page.evaluate(() => {
      const p = (window as any).__aicut.api.getProject();
      const c = p.tracks[0].clips.find(
        (c: { id: string }) => c.id === "kf-test-clip",
      );
      return c?.keyframes?.length ?? 0;
    });
    expect(stillThere).toBe(3);
  });
});
