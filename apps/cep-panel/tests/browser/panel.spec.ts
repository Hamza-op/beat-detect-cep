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

test("the beat percentage keeps an exact evenly distributed subset", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4173/");
  await page.locator("#beatSelectionSlider").fill("50");
  await expect(page.locator("#beatSelectionLabel")).toHaveText("50%");
  await page.locator("#analyzeButton").click();
  await expect(page.locator("#filteredCount")).toHaveText("21");
  await expect(page.locator("#beatSelectionSummary")).toContainText(
    "Keeps 21 of 42",
  );

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#applyButton").click();
  await expect(page.locator("#status")).toContainText("Applied 21");

  const times = await page.evaluate(() => {
    const calls =
      (window as Window & { __autocutPreviewCalls?: string[] })
        .__autocutPreviewCalls ?? [];
    const call =
      calls.find((entry) =>
        entry.startsWith("AutoCutStudio.applyMarkersChunk"),
      ) ?? "";
    const encoded = call.slice(call.indexOf("(") + 1, -1);
    const payload = JSON.parse(JSON.parse(encoded)) as {
      events: Array<{ time: number }>;
    };
    return payload.events.map((event) => event.time);
  });
  expect(times).toHaveLength(21);
  for (let index = 1; index < times.length; index += 1) {
    expect(times[index]).toBeGreaterThan(times[index - 1]);
    expect(times[index] - times[index - 1]).toBeLessThanOrEqual(1.5);
  }
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
  await expect(page.locator("#status")).toContainText(
    "Editable starting grade applied",
  );
  await expect(page.locator("#status")).toContainText(
    "Refine it in Effect Controls",
  );

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

test("the motion toolbox exposes only ten reliable Scale movements", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4173/");
  await page.locator("#mainTabToolsButton").click();
  await expect(page.locator(".movement-btn")).toHaveCount(10);
  await expect(page.locator("#mainTabDollyButton")).toHaveCount(0);
  await expect(page.locator("#warpStabilizerButton")).toHaveCount(0);

  const modes = await page
    .locator(".movement-btn")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-mode")),
    );
  expect(new Set(modes).size).toBe(10);

  await page.locator('.movement-btn[data-mode="punch_out"]').click();
  await expect(page.locator("#selectedMomentLabel")).toHaveText(
    "Beat Punch-Out",
  );
  await expect(page.locator("#previewSubject")).toHaveClass(
    /animate-punch-out/,
  );
  await page.locator("#gimbalZoomButton").click();
  await expect(page.locator("#status")).toContainText(
    "Applied gimbal zoom keyframes",
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
    await page.locator("#mainTabToolsButton").click();
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await expect(page.locator("#gimbalZoomButton")).toBeVisible();
  }
});
