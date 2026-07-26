import { test, expect } from "@playwright/test";

test("panel DOM has a ready application and style boundaries", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4173/");
  await expect(page.locator("#mainTabMarkersButton")).toBeVisible();
  await expect(page.locator("html[data-autocut-ready='true']")).toHaveCount(1);
  await page.locator("#mainTabToolsButton").click();
  await expect(page.locator("#previewKeyframeTrack")).toBeVisible();
  await expect(page.locator(".keyframe-track")).toHaveCSS(
    "border-top-color",
    /.+/,
  );
  await expect(page.locator(".key-node").first()).toHaveCSS(
    "background-color",
    /.+/,
  );
});

test("Dolly-Style Motion uses explicit flat-clip keyframes", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4173/");
  await page.locator("#mainTabDollyButton").click();

  for (const id of [
    "dollyStartScaleSlider",
    "dollyMidScaleSlider",
    "dollyEndScaleSlider",
    "dollyStartXSlider",
    "dollyMidXSlider",
    "dollyEndXSlider",
    "dollyEasingSelect",
  ]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }

  await page.locator("#dollyIntensitySlider").fill("100");
  await page.locator("#dollyMidScaleSlider").fill("140");
  await page.locator("#dollyMidXSlider").fill("60");
  await page.locator("#dollyEasingSelect").selectOption("linear");

  const keyframes = await page
    .locator("#dollyFlatScene")
    .getAttribute("data-dolly-keyframes");
  expect(keyframes).not.toBeNull();
  const parsed = JSON.parse(keyframes ?? "{}");
  expect(parsed.easing).toBe("linear");
  expect(parsed.scaleKeys.map((key: { value: number }) => key.value)).toEqual([
    100, 140, 108,
  ]);
  expect(parsed.positionKeys[1].value[0]).toBe(60);

  await page.locator("#confirmDollyZoomButton").click();
  await expect(page.locator("#status")).toContainText(
    "Applied Dolly-Style Motion",
  );
});

test("panel remains usable at supported dock sizes", async ({ page }) => {
  for (const viewport of [
    { width: 240, height: 300 },
    { width: 280, height: 380 },
    { width: 520, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("http://127.0.0.1:4173/");
    await page.locator("#mainTabDollyButton").click();
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await expect(page.locator("#confirmDollyZoomButton")).toBeVisible();
  }
});
