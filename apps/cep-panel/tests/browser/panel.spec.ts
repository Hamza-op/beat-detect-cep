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

test("the shipped marker workflow analyzes and applies through the chunked CEP host API", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4173/");
  await page.locator("#analyzeButton").click();
  await expect(page.locator("#status")).toContainText("keeping 42");
  await expect(page.locator("#applyButton")).toBeEnabled();

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#applyButton").click();
  await expect(page.locator("#status")).toContainText("Applied 42");

  const calls = await page.evaluate(
    () =>
      (window as Window & { __autocutPreviewCalls?: string[] })
        .__autocutPreviewCalls ?? [],
  );
  expect(
    calls.some((call) => call.startsWith("AutoCutStudio.scanMarkers")),
  ).toBe(true);
  expect(
    calls.some((call) => call.startsWith("AutoCutStudio.applyMarkersChunk")),
  ).toBe(true);
  expect(
    calls.some((call) => /^AutoCutStudio\.applyMarkers\(/.test(call)),
  ).toBe(false);
});

test("the timing slider shifts every applied marker without changing detection", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4173/");
  await expect(page.locator("#markerTimingOffsetLabel")).toHaveText("0 ms");

  await page.locator("#markerTimingOffsetSlider").fill("137");
  await expect(page.locator("#markerTimingOffsetLabel")).toHaveText("+137 ms");
  await page.locator("#markerTimingOffsetSlider").fill("-125");
  await expect(page.locator("#markerTimingOffsetLabel")).toHaveText("-125 ms");

  await page.locator("#analyzeButton").click();
  await expect(page.locator("#status")).toContainText("keeping 42");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#applyButton").click();
  await expect(page.locator("#status")).toContainText("Applied 42");

  const call = await page.evaluate(() => {
    const calls =
      (window as Window & { __autocutPreviewCalls?: string[] })
        .__autocutPreviewCalls ?? [];
    return (
      calls.find((entry) =>
        entry.startsWith("AutoCutStudio.applyMarkersChunk"),
      ) ?? ""
    );
  });
  const encodedPayload = call.slice(call.indexOf("(") + 1, -1);
  const payload = JSON.parse(JSON.parse(encodedPayload)) as {
    events: Array<{ time: number; score: number }>;
  };

  expect(payload.events).toHaveLength(42);
  payload.events.forEach((event, index) => {
    expect(event.time).toBeCloseTo(0.395 + index * 0.5, 6);
  });
});

test("cancelling marker removal does not leave the production UI locked", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4173/");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#removeButton").click();
  await expect(page.locator("#removeButton")).toBeEnabled();
  await expect(page.locator("#analyzeButton")).toBeEnabled();
});

test("Auto Color uses the canonical prepare and apply host functions", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4173/");
  await page.locator("#mainTabColorButton").click();
  await page.locator("#autoColorButton").click();
  await expect(page.locator("#status")).toContainText("Auto color applied");

  const calls = await page.evaluate(
    () =>
      (window as Window & { __autocutPreviewCalls?: string[] })
        .__autocutPreviewCalls ?? [],
  );
  expect(
    calls.some((call) =>
      call.startsWith("AutoCutStudio.prepareAutoColorAtPlayhead"),
    ),
  ).toBe(true);
  expect(
    calls.some((call) =>
      call.startsWith("AutoCutStudio.autoColorSelectedClips"),
    ),
  ).toBe(true);
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
