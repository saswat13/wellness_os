import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";
import { seedStore } from "../lib/tracker";
const name = "Single-arm cable lat pulldown";
const input = (
  page: Page,
  exercise: string,
  pair: number,
  side: "L" | "R" | "both",
  field: "reps" | "weight in kg",
) =>
  page.getByRole("spinbutton", {
    name: `${exercise} set ${pair} ${side} ${field}`,
    exact: true,
  });
const done = (
  page: Page,
  exercise: string,
  pair: number,
  side: "L" | "R" | "both",
  completed = false,
) =>
  page.getByRole("button", {
    name: `${completed ? "Uncomplete" : "Complete"} ${exercise} set ${pair} ${side}`,
    exact: true,
  });
const section = (page: Page, tab: string) =>
  page
    .getByRole("navigation", { name: "FORM sections" })
    .getByRole("button", { name: tab, exact: true });

test("paired mobile logger links weight edits, keeps independent sides, counts once and saves partial state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/?section=workouts");
  const pair = page.getByRole("group", { name: `${name} set 1`, exact: true });
  await expect(pair.getByText("Set 1", { exact: true })).toBeVisible();
  await expect(pair.getByText("Left", { exact: true })).toBeVisible();
  await expect(pair.getByText("Right", { exact: true })).toBeVisible();
  const link = page.getByRole("checkbox", {
    name: `${name}: Same weight for both sides`,
    exact: true,
  });
  await expect(link).toBeChecked();
  await input(page, name, 1, "L", "weight in kg").fill("30");
  await expect(input(page, name, 1, "R", "weight in kg")).toHaveValue("30");
  await expect(input(page, name, 2, "R", "weight in kg")).toHaveValue("22.5");
  await link.uncheck();
  await input(page, name, 1, "R", "weight in kg").fill("24");
  await input(page, name, 1, "L", "reps").fill("10");
  await input(page, name, 1, "R", "reps").fill("8");
  await page.getByRole("checkbox", { name: "Show optional RPE" }).check();
  await page
    .getByRole("combobox", { name: `${name} set 1 L RPE`, exact: true })
    .selectOption("8");
  await page
    .getByRole("combobox", { name: `${name} set 1 R RPE`, exact: true })
    .selectOption("9");
  await done(page, name, 1, "L").click();
  await expect(pair).toContainText("1 of 2 sides complete");
  await expect(page.getByText("0/12", { exact: true })).toBeVisible();
  await expect(done(page, name, 1, "R")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.reload();
  await expect(done(page, name, 1, "L", true)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(done(page, name, 1, "R")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(link).not.toBeChecked();
  await expect(input(page, name, 1, "R", "weight in kg")).toHaveValue("24");
  await page.getByRole("checkbox", { name: "Show optional RPE" }).check();
  await expect(
    page.getByRole("combobox", { name: `${name} set 1 L RPE`, exact: true }),
  ).toHaveValue("8");
  await expect(
    page.getByRole("combobox", { name: `${name} set 1 R RPE`, exact: true }),
  ).toHaveValue("9");
  await done(page, name, 1, "R").click();
  await expect(page.getByText("1/12", { exact: true })).toBeVisible();
  await expect(pair.getByText("Complete", { exact: true })).toBeVisible();
  await input(page, name, 3, "L", "weight in kg").fill("27");
  await input(page, name, 3, "R", "weight in kg").fill("21");
  await page
    .getByRole("button", { name: "Add left / right pair", exact: true })
    .click();
  await expect(input(page, name, 4, "L", "weight in kg")).toHaveValue("27");
  await expect(input(page, name, 4, "R", "weight in kg")).toHaveValue("21");
  await expect(page.getByText("1/13", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: `Remove ${name} set 4 pair`, exact: true })
    .click();
  await expect(input(page, name, 4, "L", "reps")).toHaveCount(0);
  await expect(input(page, name, 4, "R", "reps")).toHaveCount(0);
  await expect(page.getByText("1/12", { exact: true })).toBeVisible();
  await page
    .locator("main section")
    .first()
    .screenshot({ path: "/tmp/form-unilateral-mobile.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Finish & view summary", exact: true })
    .click();
  await expect(
    page.getByText("1 completed pair · 492 kg · reps", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Average RPE" }),
  ).toContainText("8.0");
  await expect(
    page.getByRole("row").filter({ hasText: "Average RPE" }),
  ).toContainText("9.0");
  await expect(page.getByText(/Matched-pair volume difference/)).toContainText(
    "-108 kg × reps",
  );
});

test("asymmetric history prefills the corresponding pair/side and survives a bilateral switch", async ({
  page,
}) => {
  const exercise = "Offset row";
  await page.goto("/?section=workouts");
  await section(page, "Library").click();
  await page
    .getByRole("textbox", { name: "Create a custom exercise" })
    .fill(exercise);
  await page
    .getByRole("button", { name: "Create exercise", exact: true })
    .click();
  let card = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: exercise, exact: true }),
  });
  await card
    .getByRole("button", { name: `Edit ${exercise}`, exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Log left and right separately" })
    .check();
  await page
    .getByRole("button", { name: "Save exercise", exact: true })
    .click();
  await card
    .getByRole("button", { name: `Add ${exercise} to workout`, exact: true })
    .click();
  await section(page, "Workout").click();
  await page
    .getByRole("checkbox", {
      name: `${exercise}: Same weight for both sides`,
      exact: true,
    })
    .uncheck();
  await page.getByRole("checkbox", { name: "Show optional RPE" }).check();
  for (const [side, kg, reps, rpe] of [
    ["L", "35", "11", "8"],
    ["R", "25", "9", "9"],
  ] as const) {
    await input(page, exercise, 1, side, "weight in kg").fill(kg);
    await input(page, exercise, 1, side, "reps").fill(reps);
    await page
      .getByRole("combobox", {
        name: `${exercise} set 1 ${side} RPE`,
        exact: true,
      })
      .selectOption(rpe);
    await done(page, exercise, 1, side).click();
  }
  await input(page, exercise, 2, "R", "weight in kg").fill("17");
  await input(page, exercise, 2, "R", "reps").fill("7");
  await done(page, exercise, 2, "R").click();
  await input(page, exercise, 3, "L", "weight in kg").fill("99");
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Finish & view summary", exact: true })
    .click();
  await section(page, "Templates").click();
  await page
    .getByRole("button", { name: "Save current as template", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Template name", exact: true })
    .fill("Offset day");
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start Offset day", exact: true })
    .click();
  await expect(input(page, exercise, 1, "L", "weight in kg")).toHaveValue("35");
  await expect(input(page, exercise, 1, "R", "weight in kg")).toHaveValue("25");
  await expect(input(page, exercise, 1, "L", "reps")).toHaveValue("11");
  await expect(input(page, exercise, 1, "R", "reps")).toHaveValue("9");
  await expect(
    page.getByRole("checkbox", {
      name: `${exercise}: Same weight for both sides`,
      exact: true,
    }),
  ).toBeChecked();
  await expect(input(page, exercise, 2, "L", "weight in kg")).toHaveValue("0");
  await expect(input(page, exercise, 2, "R", "weight in kg")).toHaveValue("17");
  await expect(input(page, exercise, 3, "L", "weight in kg")).toHaveValue("0");
  await expect(done(page, exercise, 1, "L")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByRole("checkbox", { name: "Show optional RPE" }).check();
  await expect(
    page.getByRole("combobox", {
      name: `${exercise} set 1 R RPE`,
      exact: true,
    }),
  ).toHaveValue("9");
  const workoutCard = page.locator("main section").filter({
    has: page.getByRole("button", { name: /CUSTOM · EXERCISE Offset row/ }),
  });
  await workoutCard
    .getByRole("button", { name: "History", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Left / right performance analytics");
  await expect(dialog).toContainText("Partially complete");
  await expect(dialog).toContainText("Not completed");
  await expect(dialog).toContainText("RPE 9");
  await expect(
    dialog.getByText(/Matched-pair volume difference/).first(),
  ).toContainText("-160 kg × reps");
  await page
    .getByRole("button", { name: "Close history", exact: true })
    .click();
  await section(page, "Library").click();
  card = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: exercise, exact: true }),
  });
  await card
    .getByRole("button", { name: `Edit ${exercise}`, exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Log left and right separately" })
    .uncheck();
  await page
    .getByRole("button", { name: "Save exercise", exact: true })
    .click();
  await section(page, "Workout").click();
  await expect(input(page, exercise, 1, "L", "weight in kg")).toBeVisible();
  await section(page, "Templates").click();
  await page
    .getByRole("button", { name: "Start Offset day", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Replace current workout", exact: true })
    .click();
  await expect(input(page, exercise, 1, "both", "weight in kg")).toBeVisible();
  await expect(input(page, exercise, 1, "L", "weight in kg")).toHaveCount(0);
  await section(page, "Library").click();
  card = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: exercise, exact: true }),
  });
  await card.getByText("Performance history (1)", { exact: true }).click();
  await expect(card).toContainText("Left / right performance analytics");
  await expect(card).toContainText("35.0 kg");
  await expect(card).toContainText("25.0 kg");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("form-tracker-v3")!).library.filter(
          (e: { name: string }) => e.name === "Offset row",
        ).length,
    ),
  ).toBe(1);
});

test("v2 browser migration retains IDs, side values and partial completion without modifying the old key", async ({
  page,
}) => {
  const current = seedStore();
  current.session.logs.pulldown[0] = {
    ...current.session.logs.pulldown[0],
    kg: 31,
    reps: 11,
    rpe: "8",
    done: true,
  };
  current.session.logs.pulldown[1] = {
    ...current.session.logs.pulldown[1],
    kg: 22,
    reps: 9,
    rpe: "9",
    done: false,
  };
  const old = JSON.parse(JSON.stringify(current));
  old.version = 2;
  for (const session of [old.session, ...old.history]) {
    for (const entry of session.exercises) delete entry.sameWeight;
    for (const rows of Object.values(session.logs) as Record<
      string,
      unknown
    >[][])
      for (const row of rows) delete row.groupId;
  }
  const oldJson = JSON.stringify(old);
  await page.addInitScript(
    (value) => localStorage.setItem("form-tracker-v2", value),
    oldJson,
  );
  await page.goto("/?section=workouts");
  await expect(input(page, name, 1, "L", "weight in kg")).toHaveValue("31");
  await expect(input(page, name, 1, "R", "weight in kg")).toHaveValue("22");
  await expect(done(page, name, 1, "L", true)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(done(page, name, 1, "R")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByText("0/12", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("form-tracker-v2")),
  ).toBe(oldJson);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("form-tracker-v3")!),
  );
  expect(saved.version).toBe(3);
  expect(saved.session.logs.pulldown[0].id).toBe(
    current.session.logs.pulldown[0].id,
  );
  expect(saved.session.logs.pulldown[0].groupId).toBe(
    saved.session.logs.pulldown[1].groupId,
  );
  await page.reload();
  await expect(input(page, name, 1, "R", "weight in kg")).toHaveValue("22");
});
