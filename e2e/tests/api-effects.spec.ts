import { expect, test } from "@playwright/test";

/**
 * Covers the `@aicut/effects` bear overlay wired into the `/#/api`
 * playground. Since the pro rewrite, the default AI-op feedback lives
 * in the canvas itself (`animateClip` / `flashCut` on `<Timeline>`),
 * and the bear overlay is opt-in via the "Bear overlay: on" chip in
 * the playground header. These tests exercise the opt-in path.
 *
 * Assertions target DOM markers on the overlay (`[data-aicut-effects]`
 * root, `[data-effect-kind="…"]` children) — the animations themselves
 * are timing-visual and not asserted here.
 */

const OVERLAY = "[data-aicut-effects]";
const EFFECT_ROOT = `${OVERLAY} [data-effect-kind]`;

async function gotoPlayground(page: import("@playwright/test").Page) {
  await page.goto("/#/api");
  await expect(page.getByTestId("apiplay-toggle-effects")).toBeVisible();
}

async function enableBear(page: import("@playwright/test").Page) {
  const chip = page.getByTestId("apiplay-toggle-effects");
  if ((await chip.innerText()).includes("off")) await chip.click();
  await expect(chip).toContainText("on");
}

test("bear overlay is off by default; toggle chip is present", async ({ page }) => {
  await gotoPlayground(page);
  await expect(page.getByTestId("apiplay-toggle-effects")).toContainText("off");
  // With bear off, the AiCutEffects component renders no overlay root
  // because there are no handlers registered — hosts see nothing.
  await expect(page.locator(EFFECT_ROOT)).toHaveCount(0);
});

test("splitClip fires bear effect when overlay is enabled", async ({ page }) => {
  await gotoPlayground(page);
  await enableBear(page);
  const splitCard = page.getByTestId("apiplay-card-splitClip");
  await splitCard.locator(".apiplay-run-btn").click();
  await expect(
    page.locator(`${OVERLAY} [data-effect-kind="splitClip"]`),
  ).toBeAttached({ timeout: 800 });
  // Split effect currently runs ~1.4s at the testing-phase duration.
  await expect(
    page.locator(`${OVERLAY} [data-effect-kind="splitClip"]`),
  ).toHaveCount(0, { timeout: 2500 });
});

test("moveClipTo fires bear effect when overlay is enabled", async ({ page }) => {
  await gotoPlayground(page);
  await enableBear(page);
  const moveCard = page.getByTestId("apiplay-card-moveClipTo");
  await moveCard.locator(".apiplay-run-btn").click();
  await expect(
    page.locator(`${OVERLAY} [data-effect-kind="moveClipTo"]`),
  ).toBeAttached({ timeout: 800 });
  // Move effect currently runs ~1.8s at the testing-phase duration.
  await expect(
    page.locator(`${OVERLAY} [data-effect-kind="moveClipTo"]`),
  ).toHaveCount(0, { timeout: 3000 });
});

test("bear overlay off keeps overlay empty even on op", async ({ page }) => {
  await gotoPlayground(page);
  // Default state is off — click splitClip and verify nothing appears
  // in the overlay layer (in-canvas flash still fires, but that's on
  // the timeline canvas, not on this DOM tree).
  const splitCard = page.getByTestId("apiplay-card-splitClip");
  await splitCard.locator(".apiplay-run-btn").click();
  await page.waitForTimeout(400);
  await expect(page.locator(EFFECT_ROOT)).toHaveCount(0);
});
