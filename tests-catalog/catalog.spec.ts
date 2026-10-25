import { test } from "../tests/fixtures";
import { expect } from "@playwright/test";

test.use({ expectedApiStatuses: [401] });

test("shared launch entries are searchable in the existing exercise and food interfaces", async ({
  page,
}) => {
  await page.goto("/?mode=cloud");
  await page
    .getByRole("link", { name: "Sign in to FORM", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign in as pilot A", exact: true })
    .click();
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
    "Saved",
  );
  await page.getByRole("button", { name: "Workouts", exact: true }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search exercises" })
    .fill("DB incline curl");
  await expect(
    page.getByRole("heading", {
      name: "Alternate Incline Dumbbell Curl",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("Source attribution", { exact: true }).first().click();
  await expect(
    page.getByText(/free-exercise-db;.*Unlicense/).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Nutrition", exact: true }).click();
  await page.getByRole("button", { name: "Foods", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search foods and recipes" })
    .fill("chana cooked");
  const chickpeas = page.getByRole("button", {
    name: "Select Chickpeas (garbanzo beans, bengal gram), mature seeds, cooked, boiled, without salt cooked",
    exact: true,
  });
  await expect(chickpeas).toBeVisible();
  await expect(chickpeas).toContainText("USDA FoodData Central · FDC 173757");
  await expect(chickpeas).not.toContainText("mock");
  await page
    .getByRole("textbox", { name: "Search foods and recipes" })
    .fill("168877");
  await expect(
    page.getByRole("button", {
      name: "Select Rice, white, long-grain, regular, raw, enriched dry",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('img[src*="free-exercise-db"]')).toHaveCount(0);
});
