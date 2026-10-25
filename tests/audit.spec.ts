import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";
import { seedNutrition } from "../lib/nutrition";
const main = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name, exact: true });
const readNutrition = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("form-nutrition-v1")!));

test("date navigation dismisses old portion and edit drafts without moving daily records", async ({
  page,
}) => {
  await page.goto("/?section=nutrition");
  const date = page.getByRole("textbox", { name: "Diary date", exact: true });
  await date.fill("2026-11-01");
  await page
    .getByRole("button", { name: "Add food to Dinner", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select Banana raw", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "Portion grams", exact: true })
    .fill("150");
  await page
    .getByRole("button", { name: "Next diary day", exact: true })
    .click();
  await expect(date).toHaveValue("2026-11-02");
  await expect(
    page.getByRole("button", { name: "Log portion", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add food to Lunch", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select Basmati rice cooked", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "Portion grams", exact: true })
    .fill("150");
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  const entry = (await readNutrition(page)).diary.at(-1);
  expect(entry.date).toBe("2026-11-02");
  expect(entry.meal).toBe("Lunch");
  expect((entry.grams * entry.snapshot.per100g.calories) / 100).toBe(195);
  await page
    .getByRole("button", { name: "Previous diary day", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit diary Basmati rice", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("progressbar", { name: "Calorie progress", exact: true }),
  ).toHaveAttribute("aria-valuetext", "0 of 2,400");
  await page
    .getByRole("button", { name: "Next diary day", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit diary Basmati rice", exact: true })
    .click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save diary entry", exact: true }),
  ).toHaveCount(0);
  expect(
    (await readNutrition(page)).diary.find(
      (e: { id: string }) => e.id === entry.id,
    ),
  ).toEqual(entry);
});

test("a stale browser tab cannot overwrite another tab's nutrition goals or workout history", async ({
  page,
  context,
}) => {
  await page.goto("/?section=nutrition");
  await expect(
    page.getByRole("heading", { name: "Nutrition.", exact: true }),
  ).toBeVisible();
  const second = await context.newPage();
  await second.goto("/?section=settings");
  await second
    .getByRole("spinbutton", { name: "Goal Calories", exact: true })
    .fill("2222");
  await second.getByRole("button", { name: "Save goals", exact: true }).click();
  await expect
    .poll(async () => (await readNutrition(second)).goals.calories)
    .toBe(2222);
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await page
    .getByRole("button", { name: "Select Banana raw", exact: true })
    .click();
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "another tab" }),
  ).toBeVisible();
  expect((await readNutrition(page)).goals.calories).toBe(2222);
  await expect(
    page.getByRole("button", { name: "Download unsaved data", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Load latest saved data", exact: true })
    .click();
  await expect(page.getByText("/ 2,222 kcal", { exact: true })).toBeVisible();
  // A completed workout from another tab must survive edits to the old draft.
  await main(page, "Workouts").click();
  await main(second, "Workouts").click();
  await second
    .getByRole("button", {
      name: "Complete Single-arm cable lat pulldown set 1 L",
      exact: true,
    })
    .click();
  await second
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await second
    .getByRole("button", { name: "Finish & view summary", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: /How did it feel/ })
    .fill("stale draft");
  await expect(
    page.getByRole("alert").filter({ hasText: "another tab" }),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("form-tracker-v3")!),
  );
  expect(saved.session.finished).toBe(true);
  expect(
    saved.history.filter((s: { id: string }) => s.id === saved.session.id),
  ).toHaveLength(1);
  await second.close();
});

test("logging, reassigning and deleting a portion updates independent dates and exact totals", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error") errors.push(e.text());
  });
  await page.goto("/?section=nutrition");
  await page
    .getByRole("textbox", { name: "Diary date", exact: true })
    .fill("2026-12-01");
  await page
    .getByRole("button", { name: "Add food to Breakfast", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select Basmati rice dry", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "Portion grams", exact: true })
    .fill("75.5");
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  await expect(
    page.getByRole("progressbar", { name: "Calorie progress", exact: true }),
  ).toHaveAttribute("aria-valuetext", "271.8 of 2,400");
  const original = (await readNutrition(page)).diary.at(-1);
  await page
    .getByRole("button", { name: "Edit diary Basmati rice", exact: true })
    .click();
  const editor = page.locator("form").filter({
    has: page.getByRole("heading", {
      name: "Edit Basmati rice",
      exact: true,
    }),
  });
  await editor
    .getByRole("spinbutton", { name: "Edit portion grams", exact: true })
    .fill("50");
  await editor
    .getByRole("combobox", { name: "Meal", exact: true })
    .selectOption("Dinner");
  await editor.getByLabel("Date", { exact: true }).fill("2026-12-02");
  await editor
    .getByRole("button", { name: "Save diary entry", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Diary date", exact: true }),
  ).toHaveValue("2026-12-02");
  await expect(
    page.getByRole("progressbar", { name: "Calorie progress", exact: true }),
  ).toHaveAttribute("aria-valuetext", "180 of 2,400");
  const changed = (await readNutrition(page)).diary.find(
    (e: { id: string }) => e.id === original.id,
  );
  expect(changed.snapshot).toEqual(original.snapshot);
  expect(changed.meal).toBe("Dinner");
  await page.reload();
  await page
    .getByRole("textbox", { name: "Diary date", exact: true })
    .fill("2026-12-01");
  await expect(
    page.getByRole("progressbar", { name: "Calorie progress", exact: true }),
  ).toHaveAttribute("aria-valuetext", "0 of 2,400");
  await page
    .getByRole("button", { name: "Next diary day", exact: true })
    .click();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Delete diary Basmati rice", exact: true })
    .click();
  await expect(
    page.getByRole("progressbar", { name: "Calorie progress", exact: true }),
  ).toHaveAttribute("aria-valuetext", "0 of 2,400");
  expect(
    (await readNutrition(page)).diary.filter(
      (e: { id: string }) => e.id === original.id,
    ),
  ).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("food favorites and long custom names fit mobile and desktop without console errors", async ({
  page,
}) => {
  const seed = seedNutrition();
  seed.foods.push({
    id: "long-food",
    ownerId: seed.user.id,
    source: "custom",
    name: "X".repeat(120),
    preparation: "cooked",
    per100g: { calories: 200, protein: 10, carbs: 20, fat: 5 },
    sourceInfo: "Mock audit",
  });
  await page.addInitScript(
    (data) => localStorage.setItem("form-nutrition-v1", JSON.stringify(data)),
    seed,
  );
  const errors: string[] = [];
  page.on("console", (e) => {
    if (e.type() === "error") errors.push(e.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?section=nutrition");
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await page
      .getByRole("navigation", { name: "Nutrition sections" })
      .getByRole("button", { name: "Foods", exact: true })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    for (const section of [
      "Home",
      "Progress",
      "Settings",
      "Workouts",
      "Nutrition",
    ]) {
      await main(page, section).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
    }
  }
  expect(errors).toEqual([]);
});

test("section navigation, browser Back/Forward, home logo and recent-session shortcuts agree with URLs", async ({
  page,
}) => {
  await page.goto("/");
  await main(page, "Nutrition").click();
  await main(page, "Settings").click();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Nutrition.", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Settings.", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "FORM home", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A little stronger.", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "View recent workout Upper body A mock-session-1",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/session=mock-session-1/);
  await expect(
    page.getByText("Sep 29, 2026 · mock session · read-only history", {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Sep 29, 2026 · mock session · read-only history", {
      exact: true,
    }),
  ).toBeVisible();
});

test("recipe optional ingredient input and zero-yield validation cannot block a valid saved recipe", async ({
  page,
}) => {
  await page.goto("/?section=nutrition");
  await page
    .getByRole("navigation", { name: "Nutrition sections" })
    .getByRole("button", { name: "Recipes", exact: true })
    .click();
  await page.getByRole("button", { name: "New recipe", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Recipe name", exact: true })
    .fill("Audit rice");
  await page
    .getByRole("combobox", { name: "Food for ingredient", exact: true })
    .selectOption("rice-dry");
  await page
    .getByRole("button", { name: "Add ingredient", exact: true })
    .click();
  await page
    .getByRole("spinbutton", {
      name: "Finished cooked/baked weight (grams)",
      exact: true,
    })
    .fill("0");
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  expect((await readNutrition(page)).recipes).toHaveLength(0);
  await page
    .getByRole("spinbutton", {
      name: "Finished cooked/baked weight (grams)",
      exact: true,
    })
    .fill("300");
  await page
    .getByRole("spinbutton", { name: "New ingredient grams", exact: true })
    .fill("");
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Log recipe Audit rice", exact: true }),
  ).toBeVisible();
  expect((await readNutrition(page)).recipes).toHaveLength(1);
});

test("duplicate submit events log one portion and failed writes preserve the previous saved diary", async ({
  page,
}) => {
  await page.goto("/?section=nutrition");
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await page
    .getByRole("button", { name: "Select Banana raw", exact: true })
    .click();
  const count = (await readNutrition(page)).diary.length;
  await page
    .getByRole("button", { name: "Log portion", exact: true })
    .evaluate((el: HTMLButtonElement) => {
      el.form!.requestSubmit();
      el.form!.requestSubmit();
    });
  await expect
    .poll(async () => (await readNutrition(page)).diary.length)
    .toBe(count + 1);
  const original = await page.evaluate(() =>
    localStorage.getItem("form-nutrition-v1"),
  );
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "form-nutrition-v1")
        throw new DOMException("Full", "QuotaExceededError");
      return write.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await page
    .getByRole("button", { name: "Select Rolled oats dry", exact: true })
    .click();
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "could not be saved" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("form-nutrition-v1")),
  ).toBe(original);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download unsaved data", exact: true })
    .click();
  const result = await download;
  const stream = await result.createReadStream();
  let json = "";
  for await (const part of stream!) json += part.toString();
  expect(JSON.parse(json).nutrition.diary).toHaveLength(count + 2);
});
