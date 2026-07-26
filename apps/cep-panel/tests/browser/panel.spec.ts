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
