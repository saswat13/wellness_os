import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";
const main = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name, exact: true });
const nutritionTab = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Nutrition sections" })
    .getByRole("button", { name, exact: true });
const snapshot = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("form-nutrition-v1")!));

test("Home, quick food search, grams, edit/delete, favorites and browser persistence", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A little stronger." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open workout", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Quick Log Food", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search foods and recipes" })
    .fill("basmati");
  await expect(
    page.getByRole("button", { name: "Select Basmati rice dry", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Select Basmati rice cooked",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Preparation filter" })
    .selectOption("dry");
  await expect(
    page.getByRole("button", {
      name: "Select Basmati rice cooked",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Favorite Basmati rice dry", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Food list filter" })
    .selectOption("favorites");
  await page
    .getByRole("button", { name: "Select Basmati rice dry", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "Portion grams", exact: true })
    .fill("75");
  await expect(page.getByText(/270 kcal · P 5.3 g/)).toBeVisible();
  const before = (await snapshot(page)).diary.length;
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  await expect
    .poll(async () => (await snapshot(page)).diary.length)
    .toBe(before + 1);
  const entry = (await snapshot(page)).diary.at(-1);
  expect(entry.grams).toBe(75);
  expect(entry.snapshot.preparation).toBe("dry");
  expect(entry.snapshot.per100g.calories).toBe(360);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Nutrition." })).toBeVisible();
  await expect
    .poll(async () => (await snapshot(page)).diary.at(-1).id)
    .toBe(entry.id);
  await page
    .getByRole("button", { name: "Edit diary Basmati rice", exact: true })
    .last()
    .click();
  await page.getByRole("spinbutton", { name: "Edit portion grams" }).fill("50");
  await page
    .getByRole("button", { name: "Save diary entry", exact: true })
    .click();
  await expect
    .poll(async () => (await snapshot(page)).diary.at(-1).grams)
    .toBe(50);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete diary Basmati rice", exact: true })
    .last()
    .click();
  await expect
    .poll(async () => (await snapshot(page)).diary.length)
    .toBe(before);
  await main(page, "Home").click();
  await expect(
    page.getByRole("heading", { name: "Today’s meals" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});

test("goal save/cancel, macro warning, immediate dashboard targets and preferences", async ({
  page,
}) => {
  await page.goto("/?section=nutrition");
  await page.getByRole("button", { name: "Edit Goals", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Nutrition Goals", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "Goal Calories", exact: true })
    .fill("3000");
  await page
    .getByRole("spinbutton", { name: "Goal Protein", exact: true })
    .fill("150");
  await page
    .getByRole("spinbutton", { name: "Goal Carbohydrates", exact: true })
    .fill("250");
  await page
    .getByRole("spinbutton", { name: "Goal Fat", exact: true })
    .fill("60");
  await expect(
    page.getByText("Macro-derived calories: 2,140 kcal", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/differs materially/)).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("spinbutton", { name: "Goal Calories", exact: true }),
  ).toHaveValue("2400");
  await page
    .getByRole("spinbutton", { name: "Goal Calories", exact: true })
    .fill("2100");
  await page
    .getByRole("spinbutton", { name: "Goal Protein", exact: true })
    .fill("140");
  await page
    .getByRole("spinbutton", { name: "Goal Carbohydrates", exact: true })
    .fill("250");
  await page
    .getByRole("spinbutton", { name: "Goal Fat", exact: true })
    .fill("60");
  await page.getByRole("button", { name: "Save goals", exact: true }).click();
  await expect
    .poll(async () => (await snapshot(page)).goals.calories)
    .toBe(2100);
  await page.getByRole("textbox", { name: "Display name" }).fill("Alex");
  await page
    .getByRole("combobox", { name: "Preferred weight units" })
    .selectOption("lb");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await main(page, "Home").click();
  await expect(page.getByText(/Alex ·/)).toBeVisible();
  await expect(page.getByText("/ 2,100 kcal", { exact: true })).toBeVisible();
  await main(page, "Nutrition").click();
  await expect(page.getByText("/ 2,100 kcal", { exact: true })).toBeVisible();
  await main(page, "Workouts").click();
  await expect(
    page.getByRole("combobox", { name: "Weight units" }),
  ).toHaveValue("lb");
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Weight units" }),
  ).toHaveValue("lb");
  await main(page, "Settings").click();
  await expect(
    page.getByRole("spinbutton", { name: "Goal Protein", exact: true }),
  ).toHaveValue("140");
});

test("custom food creation, reuse and editing preserve previously logged values", async ({
  page,
}) => {
  await page.goto("/?section=nutrition");
  await nutritionTab(page, "Foods").click();
  await page.getByRole("button", { name: "Custom food", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Food name", exact: true })
    .fill("My tofu");
  await page
    .getByRole("combobox", { name: "Preparation state" })
    .selectOption("cooked");
  for (const [field, value] of [
    ["Calories", "200"],
    ["Protein", "20"],
    ["Carbohydrates", "10"],
    ["Fat", "8"],
  ])
    await page
      .getByRole("spinbutton", { name: `Food ${field}`, exact: true })
      .fill(value);
  await page
    .getByRole("textbox", { name: "Source information (optional)" })
    .fill("My package");
  await page.getByRole("button", { name: "Save food", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search foods and recipes" })
    .fill("tofu");
  await page
    .getByRole("button", { name: "Select My tofu cooked", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "Portion grams", exact: true })
    .fill("150");
  await expect(page.getByText(/300 kcal · P 30 g/)).toBeVisible();
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  const entry = (await snapshot(page)).diary.at(-1);
  const foodId = entry.sourceId;
  await nutritionTab(page, "Foods").click();
  await page
    .getByRole("button", { name: "Edit food My tofu", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Food name", exact: true })
    .fill("Renamed tofu");
  await page
    .getByRole("spinbutton", { name: "Food Calories", exact: true })
    .fill("250");
  await page.getByRole("button", { name: "Save food", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).foods.find(
          (f: { id: string }) => f.id === foodId,
        ).name,
    )
    .toBe("Renamed tofu");
  expect((await snapshot(page)).diary.at(-1)).toEqual(entry);
  await nutritionTab(page, "Diary").click();
  await expect(page.getByText("My tofu", { exact: true })).toBeVisible();
  await page.reload();
  expect((await snapshot(page)).diary.at(-1).snapshot.per100g.calories).toBe(
    200,
  );
});

test("recipe ingredients, cooked yield and weighed portions with immutable diary snapshots", async ({
  page,
}) => {
  await page.goto("/?section=nutrition");
  await nutritionTab(page, "Recipes").click();
  await page.getByRole("button", { name: "New recipe", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Recipe name", exact: true })
    .fill("Breakfast bake");
  await page
    .getByRole("combobox", { name: "Food for ingredient" })
    .selectOption("oats");
  await page
    .getByRole("spinbutton", { name: "New ingredient grams" })
    .fill("100");
  await page
    .getByRole("button", { name: "Add ingredient", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Food for ingredient" })
    .selectOption("yogurt");
  await page
    .getByRole("spinbutton", { name: "New ingredient grams" })
    .fill("200");
  await page
    .getByRole("button", { name: "Add ingredient", exact: true })
    .click();
  await page
    .getByRole("spinbutton", {
      name: "Finished cooked/baked weight (grams)",
      exact: true,
    })
    .fill("350");
  await expect(page.getByText(/525 kcal · P 33.2 g/)).toBeVisible();
  await expect(page.getByText(/150 kcal · P 9.5 g/)).toBeVisible();
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await page
    .getByRole("button", { name: "Log recipe Breakfast bake", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "Portion grams", exact: true })
    .fill("175");
  await expect(page.getByText(/262.5 kcal · P 16.6 g/)).toBeVisible();
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  const original = (await snapshot(page)).diary.at(-1);
  expect(original.snapshot.per100g.calories).toBe(150);
  expect(original.grams).toBe(175);
  await nutritionTab(page, "Recipes").click();
  await page
    .getByRole("button", { name: "Edit recipe Breakfast bake", exact: true })
    .click();
  await page
    .getByRole("spinbutton", {
      name: "Finished cooked/baked weight (grams)",
      exact: true,
    })
    .fill("700");
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  expect((await snapshot(page)).diary.at(-1)).toEqual(original);
  await page
    .getByRole("button", { name: "Log recipe Breakfast bake", exact: true })
    .click();
  await expect(page.getByText(/75 kcal · P 4.7 g/).first()).toBeVisible();
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  await expect
    .poll(
      async () => (await snapshot(page)).diary.at(-1).snapshot.per100g.calories,
    )
    .toBe(75);
  await page.reload();
  const data = await snapshot(page);
  expect(data.diary.find((e: { id: string }) => e.id === original.id)).toEqual(
    original,
  );
  await main(page, "Progress").click();
  await page
    .getByRole("navigation", { name: "Progress sections" })
    .getByRole("button", { name: "Nutrition", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Calories · past 7 days", exact: true }),
  ).toBeVisible();
});

test("completed workout archive, session/template replacements and mobile navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await main(page, "Workouts").click();
  const card = page.getByRole("button", { name: /CABLE · LATS/ }).locator("..");
  await card
    .getByText("Edit exercise in this session", { exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Replace Single-arm cable lat pulldown in session",
      exact: true,
    })
    .click();
  const lateral = page.getByRole("article").filter({
    has: page.getByRole("heading", {
      name: "Dumbbell lateral raise",
      exact: true,
    }),
  });
  await lateral
    .getByRole("button", {
      name: "Add Dumbbell lateral raise to workout",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("spinbutton", {
      name: "Dumbbell lateral raise set 1 both reps",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Complete Dumbbell lateral raise set 1 both",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Finish & view summary", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "FORM sections" })
    .getByRole("button", { name: "History", exact: true })
    .click();
  await page
    .getByRole("button", { name: "View workout initial-session", exact: true })
    .click();
  await expect(
    page.getByText("completed session · read-only history", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Dumbbell lateral raise", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "FORM sections" })
    .getByRole("button", { name: "Templates", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit template Upper body A", exact: true })
    .click();
  await page
    .getByRole("combobox", {
      name: "Replace Single-arm cable lat pulldown in template",
      exact: true,
    })
    .selectOption("row");
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await main(page, "Progress").click();
  await page
    .getByRole("combobox", { name: "Report by" })
    .selectOption("equipment");
  await expect(
    page.getByRole("cell", { name: "Dumbbell", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("rowheader", { name: "Dumbbell", exact: true }),
  ).toBeVisible();
  for (const name of [
    "Home",
    "Nutrition",
    "Progress",
    "Settings",
    "Workouts",
  ]) {
    await main(page, name).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
  }
});

test("invalid saved nutrition is warned about without replacing the original store", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("form-nutrition-v1", '{"version":999}'),
  );
  await page.goto("/");
  await expect(
    page.getByRole("alert").filter({ hasText: "Saved nutrition data" }),
  ).toContainText("Saved nutrition data could not be restored");
  await main(page, "Settings").click();
  await page
    .getByRole("spinbutton", { name: "Goal Calories", exact: true })
    .fill("2200");
  await page.getByRole("button", { name: "Save goals", exact: true }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("form-nutrition-v1")),
  ).toBe('{"version":999}');
});
