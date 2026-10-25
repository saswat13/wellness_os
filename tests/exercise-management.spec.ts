import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";
const section = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "FORM sections" })
    .getByRole("button", { name, exact: true });
const exerciseCard = (page: Page, name: string) =>
  page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });

test("name-only custom creation, optional attributes, filtering, snapshots and archive persistence", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?section=workouts");
  await section(page, "Library").click();
  await page
    .getByRole("textbox", { name: "Create a custom exercise" })
    .fill("My single-arm row");
  await page
    .getByRole("button", { name: "Create exercise", exact: true })
    .click();
  let card = exerciseCard(page, "My single-arm row");
  await expect(card).toBeVisible();
  const originalId = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("form-tracker-v3")!).library.find(
        (e: { name: string }) => e.name === "My single-arm row",
      ).id,
  );
  await card
    .getByRole("button", { name: "Edit My single-arm row", exact: true })
    .click();
  const editor = page.locator("form").filter({
    has: page.getByRole("heading", { name: "Edit custom exercise" }),
  });
  await editor
    .getByRole("checkbox", { name: "Log left and right separately" })
    .check();
  await editor
    .getByText("Advanced attributes (optional)", { exact: true })
    .click();
  await editor
    .getByRole("combobox", { name: "Primary muscle", exact: true })
    .selectOption("Upper back");
  await editor
    .getByRole("combobox", { name: "Equipment", exact: true })
    .selectOption("Cable");
  await editor
    .getByRole("combobox", { name: "Movement pattern", exact: true })
    .selectOption("Horizontal pull");
  await editor
    .getByRole("textbox", { name: "Custom tags (comma separated)" })
    .fill("home gym, favourite");
  await editor
    .getByRole("group", { name: "Secondary muscles" })
    .getByRole("checkbox", { name: "Biceps", exact: true })
    .check();
  await editor
    .getByRole("group", { name: "Training types" })
    .getByRole("checkbox", { name: "hypertrophy" })
    .check();
  await editor
    .getByRole("button", { name: "Save exercise", exact: true })
    .click();
  await page.getByText("Filter exercises", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Equipment filter" })
    .selectOption("Cable");
  await page
    .getByRole("combobox", { name: "Tag filter" })
    .selectOption("home gym");
  await page
    .getByRole("textbox", { name: "Search exercises" })
    .fill("single-arm row");
  await expect(page.getByRole("article")).toHaveCount(1);
  await card
    .getByRole("button", {
      name: "Add My single-arm row to workout",
      exact: true,
    })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await section(page, "Workout").click();
  await page
    .getByRole("spinbutton", {
      name: "My single-arm row set 1 L weight in kg",
      exact: true,
    })
    .fill("35");
  await page
    .getByRole("button", {
      name: "Complete My single-arm row set 1 L",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: /How did it feel/ })
    .fill("PRIVATE WORKOUT NOTE");
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Finish & view summary", exact: true })
    .click();
  await section(page, "Library").click();
  card = exerciseCard(page, "My single-arm row");
  await card.getByText("Performance history (1)", { exact: true }).click();
  await expect(card).toContainText("My single-arm row");
  await expect(card).toContainText("35.0 kg");
  await card
    .getByRole("button", { name: "Edit My single-arm row", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Exercise name", exact: true })
    .fill("Renamed unilateral row");
  await page
    .getByRole("button", { name: "Save exercise", exact: true })
    .click();
  card = exerciseCard(page, "Renamed unilateral row");
  await card.getByText("Performance history (1)", { exact: true }).click();
  await expect(card).toContainText("My single-arm row");
  await expect(card).toContainText("35.0 kg");
  await card
    .getByRole("button", {
      name: "Archive Renamed unilateral row",
      exact: true,
    })
    .click();
  await expect(card).toHaveCount(0);
  await page.getByText("Filter exercises", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Include archived" }).check();
  card = exerciseCard(page, "Renamed unilateral row");
  await card
    .getByRole("button", {
      name: "Restore Renamed unilateral row",
      exact: true,
    })
    .click();
  await page.reload();
  await section(page, "Library").click();
  await expect(exerciseCard(page, "Renamed unilateral row")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("form-tracker-v3")!).library.find(
          (e: { name: string }) => e.name === "Renamed unilateral row",
        ).id,
    ),
  ).toBe(originalId);
  expect(errors).toEqual([]);
});

test("templates edit independently, reorder, add exercises, prefill and export without private history", async ({
  page,
}) => {
  await page.goto("/?section=workouts");
  await page
    .getByRole("spinbutton", {
      name: "Single-arm cable lat pulldown set 1 L weight in kg",
      exact: true,
    })
    .fill("31");
  await page
    .getByRole("button", {
      name: "Complete Single-arm cable lat pulldown set 1 L",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: /How did it feel/ })
    .fill("SECRET HISTORY");
  await section(page, "Templates").click();
  await page
    .getByRole("button", { name: "Edit template Upper body A", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Template name", exact: true })
    .fill("Upper remix");
  await page
    .getByRole("button", {
      name: "Move Seated cable chest flyes up",
      exact: true,
    })
    .click();
  await page
    .getByRole("spinbutton", { name: "Planned sets", exact: true })
    .first()
    .fill("4");
  await page
    .getByRole("textbox", { name: "Rep target", exact: true })
    .first()
    .fill("6–8");
  await page
    .getByRole("button", { name: "Add exercise to template", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Add Dumbbell lateral raise to template",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Upper remix", exact: true }),
  ).toBeVisible();
  await section(page, "Workout").click();
  await expect(
    page.getByRole("heading", { name: "Upper body A." }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", {
      name: "Single-arm cable lat pulldown set 1 L weight in kg",
      exact: true,
    }),
  ).toHaveValue("31");
  await expect(
    page.getByRole("spinbutton", {
      name: "Dumbbell lateral raise set 1 both reps",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Finish & view summary", exact: true })
    .click();
  await section(page, "Templates").click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export template Upper remix", exact: true })
    .click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let text = "";
  for await (const chunk of stream!) text += chunk.toString();
  const exported = JSON.parse(text);
  expect(exported.exercises[0].exercise.name).toBe("Seated cable chest flyes");
  expect(exported.exercises[0].prescription.plannedSets).toBe(4);
  expect(text).not.toContain("SECRET HISTORY");
  for (const field of ["ownerId", "logs", "sessionId", "history"])
    expect(text).not.toContain(`"${field}"`);
  await page
    .getByRole("button", { name: "Start Upper remix", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Upper remix." }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", {
      name: "Single-arm cable lat pulldown set 1 L weight in kg",
      exact: true,
    }),
  ).toHaveValue("31");
  await expect(
    page.getByRole("button", {
      name: "Complete Single-arm cable lat pulldown set 1 L",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("spinbutton", {
      name: "Dumbbell lateral raise set 1 both reps",
      exact: true,
    }),
  ).toBeVisible();
  const firstCard = page.locator("main section").first();
  await expect(firstCard).toContainText("Seated cable chest flyes");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Upper remix." }),
  ).toBeVisible();
});
