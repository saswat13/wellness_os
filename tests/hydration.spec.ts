import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("extension-added body attributes do not warn or break hydration and logging", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  // Reproduce Grammarly/shortcut extensions modifying the DOM before React starts.
  await page.addInitScript(() => {
    const attach = () => {
      if (!document.body) return false;
      document.body.setAttribute("data-new-gr-c-s-check-loaded", "14.1338.0");
      document.body.setAttribute("data-gr-ext-installed", "");
      document.body.setAttribute("cz-shortcut-listen", "true");
      return true;
    };
    if (!attach()) {
      const observer = new MutationObserver(() => {
        if (attach()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }
  });

  await page.goto("/?section=nutrition");
  await expect(
    page.getByRole("heading", { name: "Nutrition.", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute(
    "data-new-gr-c-s-check-loaded",
    "14.1338.0",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "cz-shortcut-listen",
    "true",
  );
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await page
    .getByRole("button", { name: "Select Banana raw", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "Portion grams", exact: true })
    .fill("125");
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  await expect(
    page.getByText("Portion logged. Daily totals updated.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("Banana", { exact: true })).toBeVisible();
  await expect(page.getByText("125 g · raw", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
