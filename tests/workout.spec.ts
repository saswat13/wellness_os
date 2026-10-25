import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("mobile workout logs, units, history, persistence and completion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?section=workouts");
  await expect(
    page.getByRole("heading", { name: "Upper body A." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finish workout" }),
  ).toBeDisabled();
  const reps = page.getByRole("spinbutton", {
    name: "Single-arm cable lat pulldown set 1 L reps",
    exact: true,
  });
  const weight = page.getByRole("spinbutton", {
    name: "Single-arm cable lat pulldown set 1 L weight in kg",
    exact: true,
  });
  await expect(reps).toHaveValue("12");
  await expect(weight).toHaveValue("22.5");
  await reps.fill("11");
  await weight.fill("25");
  await page.getByRole("checkbox", { name: "Show optional RPE" }).check();
  await page
    .getByRole("combobox", {
      name: "Single-arm cable lat pulldown set 1 L RPE",
      exact: true,
    })
    .selectOption("8");
  await page
    .getByRole("button", {
      name: "Complete Single-arm cable lat pulldown set 1 L",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Uncomplete Single-arm cable lat pulldown set 1 L",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Start or restart rest timer" }),
  ).toContainText("1:");
  await page.getByRole("button", { name: "Add left / right pair" }).click();
  await expect(
    page.getByRole("spinbutton", {
      name: "Single-arm cable lat pulldown set 4 L reps",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Remove Single-arm cable lat pulldown set 4 pair",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("spinbutton", {
      name: "Single-arm cable lat pulldown set 4 L reps",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("combobox", { name: "Weight units" }).selectOption("lb");
  await expect(
    page.getByRole("spinbutton", {
      name: "Single-arm cable lat pulldown set 1 L weight in lb",
      exact: true,
    }),
  ).toHaveValue("55.1");
  await page.getByRole("combobox", { name: "Weight units" }).selectOption("kg");
  await page
    .locator("main section")
    .getByRole("button", { name: "History", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("22.5");
  await expect(dialog).toContainText("Sep 22, 2026");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("textbox", { name: /How did it feel/ })
    .fill("Strong session; focus on the stretch.");
  await page.reload();
  await expect(reps).toHaveValue("11");
  await expect(
    page.getByRole("button", {
      name: "Uncomplete Single-arm cable lat pulldown set 1 L",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: /How did it feel/ }),
  ).toHaveValue("Strong session; focus on the stretch.");
  await page.getByRole("button", { name: "Finish workout" }).click();
  await page.getByRole("button", { name: "Finish & view summary" }).click();
  await expect(
    page.getByRole("heading", { name: "Work put in." }),
  ).toBeVisible();
  await expect(
    page.getByText("0 completed pairs · 1 partial pair · 275 kg · reps", {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Work put in." }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("small screen fits RPE fields and timer footer; cards collapse", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/?section=workouts");
  await page.getByRole("checkbox", { name: "Show optional RPE" }).check();
  await page
    .getByRole("button", {
      name: "Complete Single-arm cable lat pulldown set 1 L",
      exact: true,
    })
    .click();
  await page.screenshot({ path: "/tmp/form-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const card = page.getByRole("button", { name: /CABLE · LATS/ });
  await card.click();
  await expect(card).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("spinbutton", {
      name: "Single-arm cable lat pulldown set 1 L reps",
      exact: true,
    }),
  ).toHaveCount(0);
  await card.click();
  await expect(card).toHaveAttribute("aria-expanded", "true");
});
