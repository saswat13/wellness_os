import { test } from "../tests/fixtures";
import { expect } from "@playwright/test";

test.use({ expectedApiStatuses: [401, 503] });

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

test("a workout can be saved and recovered with the full launch catalog loaded", async ({
  page,
}) => {
  await page.goto("/?mode=cloud");
  await page
    .getByRole("link", { name: "Sign in to FORM", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign in as pilot A", exact: true })
    .click();
  const status = page.getByRole("status", { name: "Save status" });
  await expect(status).toHaveText("Saved");
  await page.getByRole("button", { name: "Workouts", exact: true }).click();
  await page
    .getByRole("button", { name: "Start new workout", exact: true })
    .click();
  await expect(status).toHaveText("Saved");
  for (const name of [
    "Alternate Incline Dumbbell Curl",
    "One-Arm Dumbbell Row",
  ]) {
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByRole("textbox", { name: "Search exercises" }).fill(name);
    await page
      .getByRole("button", { name: `Add ${name} to workout`, exact: true })
      .click();
    await expect(status).toHaveText("Saved");
  }
  await page.getByRole("button", { name: "Workout", exact: true }).click();
  const attempts: Array<{ key: string; revision: string; body: string }> = [];
  let fail = true;
  await page.route("**/api/v1/workouts/sessions/*/draft", async (route) => {
    const request = route.request();
    attempts.push({
      key: request.headers()["idempotency-key"],
      revision: request.headers()["if-match"],
      body: request.postData()!,
    });
    if (fail)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "SIMULATED_OUTAGE" } }),
      });
    else await route.continue();
  });
  await page
    .getByRole("textbox", { name: /How did it feel/ })
    .fill("Full catalog workout saved");
  await expect(status).toHaveText("Couldn’t save");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(status).toHaveText("Unsaved changes");
  expect(attempts).toHaveLength(1);
  await expect(
    page.getByRole("textbox", { name: /How did it feel/ }),
  ).toHaveValue("Full catalog workout saved");
  fail = false;
  await page
    .getByRole("button", { name: "Retry cloud save", exact: true })
    .click();
  await expect(status).toHaveText("Saved");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect(status).toHaveText("Saved");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(status).toHaveText("Saved");
  await expect(
    page.getByRole("textbox", { name: /How did it feel/ }),
  ).toHaveValue("Full catalog workout saved");
});
