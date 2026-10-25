import { test } from "../tests/fixtures";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
test.use({ expectedApiStatuses: [401, 404, 409, 412, 503] });
const saved = (page: Page) =>
  expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved");
async function signIn(page: Page, user: "A" | "B" = "A") {
  await page.goto("/?mode=cloud");
  await page
    .getByRole("link", { name: "Sign in to FORM", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Sign in as pilot ${user}`, exact: true })
    .click();
  await saved(page);
  expect((await auth(page)).subject).toBe(`pilot-${user}`);
}
async function section(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
}
async function auth(page: Page) {
  return (await (await page.request.get("/auth/session")).json()) as {
    csrfToken: string;
    subject: string;
  };
}
async function api(page: Page, path: string) {
  const r = await page.request.get("/api/v1" + path);
  expect(r.status()).toBe(200);
  return r.json();
}

test("cloud header stays compact and account actions belong in Settings", async ({
  page,
}) => {
  await signIn(page);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.locator("header").getByRole("status", { name: "Save status" }),
    ).toHaveText("Saved");
    await expect(
      page.getByRole("button", { name: "Sign out", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Start new workout", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/Cloud account ·/)).toHaveCount(0);
    await expect(
      page.getByText(/Pending edits stay on this device/),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await section(page, "Settings");
  const account = page.getByRole("region", { name: "Account", exact: true });
  await expect(
    account.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeEnabled();
  await expect(
    account.getByRole("link", { name: "Switch account", exact: true }),
  ).toBeVisible();
  await expect(
    account.getByRole("button", { name: "Use local demo", exact: true }),
  ).toBeVisible();
  await section(page, "Workouts");
  await expect(
    page.getByRole("button", { name: "Start new workout", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Load earlier workout history",
      exact: true,
    }),
  ).toHaveCount(0);
  await section(page, "History");
  await expect(
    page.getByRole("button", {
      name: "Load earlier workout history",
      exact: true,
    }),
  ).toBeVisible();
});

test("A signs in, logs asymmetric sets, refreshes/resumes, completes once and preserves local stores", async ({
  page,
}) => {
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!localStorage.getItem("form-tracker-v3") &&
          !!localStorage.getItem("form-nutrition-v1"),
      ),
    )
    .toBe(true);
  const raw = await page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
    ),
  );
  await signIn(page);
  await section(page, "Workouts");
  await page
    .getByRole("button", { name: "Start new workout", exact: true })
    .click();
  await saved(page);
  await section(page, "Workouts");
  await section(page, "Library");
  const exercise = "Single-arm cable lat pulldown";
  await page
    .getByRole("button", { name: `Add ${exercise} to workout`, exact: true })
    .click();
  await saved(page);
  await section(page, "Workout");
  await page
    .getByRole("checkbox", {
      name: `${exercise}: Same weight for both sides`,
      exact: true,
    })
    .uncheck();
  await page
    .getByRole("spinbutton", {
      name: `${exercise} set 1 L weight in kg`,
      exact: true,
    })
    .fill("25");
  await page
    .getByRole("spinbutton", {
      name: `${exercise} set 1 R weight in kg`,
      exact: true,
    })
    .fill("20");
  await page
    .getByRole("spinbutton", { name: `${exercise} set 1 L reps`, exact: true })
    .fill("10");
  await page
    .getByRole("button", { name: `Complete ${exercise} set 1 L`, exact: true })
    .click();
  await saved(page);
  const draft = new URL(page.url()).searchParams.get("draft")!;
  await page.reload();
  await saved(page);
  await expect(
    page.getByRole("spinbutton", {
      name: `${exercise} set 1 L weight in kg`,
      exact: true,
    }),
  ).toHaveValue("25");
  await expect(
    page.getByRole("spinbutton", {
      name: `${exercise} set 1 R weight in kg`,
      exact: true,
    }),
  ).toHaveValue("20");
  await expect(
    page.getByText("1 of 2 sides complete", { exact: true }),
  ).toBeVisible();
  const before = await api(page, `/workouts/sessions/${draft}`);
  expect(before.data.exercises[0].sets[0].done).toBe(true);
  expect(before.data.exercises[0].sets[1].done).toBe(false);
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await page.getByRole("button", { name: "Finish & view summary" }).click();
  await saved(page);
  const completed = await api(page, `/workouts/sessions/${draft}`);
  expect(completed.data.summary.volumeKgReps).toBe(250);
  expect(completed.data.summary.completedGroups).toBe(0);
  await page.reload();
  await saved(page);
  await section(page, "Workouts");
  await section(page, "History");
  await expect(
    page.getByRole("heading", { name: "Workout history.", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage).map((key) => [
          key,
          localStorage.getItem(key),
        ]),
      ),
    ),
  ).toEqual(raw);
});

test("food logging, date records, goals, preferences and immutable nutrition survive refresh", async ({
  page,
}) => {
  await signIn(page);
  await section(page, "Nutrition");
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Select Mock cooked rice cooked",
      exact: true,
    })
    .click();
  await page
    .getByRole("spinbutton", { name: "Portion grams", exact: true })
    .fill("150");
  await page
    .getByRole("combobox", { name: "Meal", exact: true })
    .selectOption("Lunch");
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  await saved(page);
  const date = await page
    .getByLabel("Diary date", { exact: true })
    .inputValue();
  let day = await api(page, `/nutrition/diary?date=${date}`);
  expect(day.data.totals.calories).toBe(195);
  const entry = day.data.entries[0];
  expect(entry.meal).toBe("Lunch");
  await page.reload();
  await saved(page);
  await expect(
    page.getByText("Mock cooked rice", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Previous diary day", exact: true })
    .click();
  await saved(page);
  await expect(page.getByText("Mock cooked rice", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await saved(page);
  await page
    .getByRole("button", { name: "Edit diary Mock cooked rice", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "Edit portion grams", exact: true })
    .fill("200");
  await page
    .getByRole("button", { name: "Save diary entry", exact: true })
    .click();
  await saved(page);
  day = await api(page, `/nutrition/diary?date=${date}`);
  expect(day.data.totals.calories).toBe(260);
  expect(day.data.entries[0].snapshot).toEqual(entry.snapshot);
  await page.getByRole("button", { name: "Edit Goals", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "Goal Calories", exact: true })
    .fill("2700");
  await page.getByRole("button", { name: "Save goals", exact: true }).click();
  await saved(page);
  await page
    .getByRole("textbox", { name: "Display name", exact: true })
    .fill("Pilot A profile");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await saved(page);
  await page.reload();
  await saved(page);
  await expect(
    page.getByRole("spinbutton", { name: "Goal Calories", exact: true }),
  ).toHaveValue("2700");
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Pilot A profile");
  await section(page, "Nutrition");
  expect(
    (await api(page, `/nutrition/diary?date=${date}`)).data.goals.calories,
  ).toBe(2700);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete diary Mock cooked rice", exact: true })
    .click();
  await saved(page);
  expect(
    (await api(page, `/nutrition/diary?date=${date}`)).data.totals.calories,
  ).toBe(0);
});

test("B cannot read or modify A's records; expiration clears private UI", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await section(page, "Workouts");
  await page
    .getByRole("button", { name: "Start new workout", exact: true })
    .click();
  await saved(page);
  const id = new URL(page.url()).searchParams.get("draft")!;
  const own = await api(page, `/workouts/sessions/${id}`);
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:3001",
  });
  const other = await context.newPage();
  try {
    await signIn(other, "B");
    expect(
      (await other.request.get(`/api/v1/workouts/sessions/${id}`)).status(),
    ).toBe(404);
    const session = await auth(other);
    const mutation = await other.request.patch(
      `/api/v1/workouts/sessions/${id}`,
      {
        headers: {
          Origin: "http://127.0.0.1:3001",
          "X-CSRF-Token": session.csrfToken,
          "Idempotency-Key": crypto.randomUUID(),
          "If-Match": `"${own.data.revision}"`,
        },
        data: { notes: "Foreign change" },
      },
    );
    expect(mutation.status()).toBe(404);
    expect((await api(page, `/workouts/sessions/${id}`)).data.notes).toBe(
      own.data.notes,
    );
    await other.request.post("/__test/expire", {
      headers: { "X-Form-Test-Key": "local-test-control-only" },
    });
    await other.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      other.getByRole("link", { name: "Sign in to FORM", exact: true }),
    ).toBeVisible();
    await expect(
      other.getByRole("status", { name: "Save status" }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
  await section(page, "Settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Sign in to FORM", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status", { name: "Save status" })).toHaveCount(
    0,
  );
});

test("cross-tab account switching clears old visible records", async ({
  page,
}) => {
  await signIn(page);
  const tab = await page.context().newPage();
  await tab.goto("/?mode=cloud");
  await saved(tab);
  await section(tab, "Settings");
  await tab.getByRole("link", { name: "Switch account", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Sign in to FORM", exact: true }),
  ).toBeVisible();
  await tab
    .getByRole("button", { name: "Sign in as pilot B", exact: true })
    .click();
  await saved(tab);
  expect((await auth(tab)).subject).toBe("pilot-B");
  await saved(tab);
  await expect(
    page.getByRole("link", { name: "Sign in to FORM", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status", { name: "Save status" })).toHaveCount(
    0,
  );
  await tab.close();
});

test("custom exercises and reusable templates save through the UI without rewriting sessions", async ({
  page,
}) => {
  await signIn(page);
  await section(page, "Workouts");
  await page
    .getByRole("button", { name: "Start new workout", exact: true })
    .click();
  await saved(page);
  await section(page, "Workouts");
  await section(page, "Library");
  await page
    .getByRole("textbox", { name: "Create a custom exercise", exact: true })
    .fill("Cloud cable row");
  await page
    .getByRole("button", { name: "Create exercise", exact: true })
    .click();
  await saved(page);
  await page
    .getByRole("button", { name: "Edit Cloud cable row", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Log left and right separately",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Save exercise", exact: true })
    .click();
  await saved(page);
  const exercises = await api(page, "/workouts/exercises");
  const custom = exercises.items.find(
    (e: { name: string }) => e.name === "Cloud cable row",
  );
  expect(custom.unilateral).toBe(true);
  await section(page, "Templates");
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Template name", exact: true })
    .fill("Cloud upper plan");
  await page
    .getByRole("button", { name: "Add exercise to template", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Add Cloud cable row to template",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await saved(page);
  await page
    .getByRole("button", { name: "Start Cloud upper plan", exact: true })
    .click();
  await saved(page);
  await expect(
    page.getByRole("heading", { name: "Cloud upper plan.", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", {
      name: "Cloud cable row set 1 L reps",
      exact: true,
    }),
  ).toBeVisible();
  const sessionId = new URL(page.url()).searchParams.get("draft")!;
  await section(page, "Library");
  await page
    .getByRole("button", { name: "Edit Cloud cable row", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Exercise name", exact: true })
    .fill("Renamed cloud row");
  await page
    .getByRole("button", { name: "Save exercise", exact: true })
    .click();
  await saved(page);
  expect((await api(page, `/workouts/exercises/${custom.id}`)).data.name).toBe(
    "Renamed cloud row",
  );
  expect(
    (await api(page, `/workouts/sessions/${sessionId}`)).data.exercises[0]
      .snapshot.name,
  ).toBe("Cloud cable row");
  await section(page, "Templates");
  await page
    .getByRole("button", {
      name: "Edit template Cloud upper plan",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: "Rep target", exact: true })
    .fill("6–8");
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await saved(page);
  expect(
    (await api(page, `/workouts/sessions/${sessionId}`)).data.exercises[0]
      .prescription.target,
  ).toBe("8–12");
  await page.reload();
  await saved(page);
  await section(page, "Workouts");
  await section(page, "Workout");
  await expect(
    page.getByRole("spinbutton", {
      name: "Cloud cable row set 1 L reps",
      exact: true,
    }),
  ).toBeVisible();
});

test("custom foods and finished-yield recipe versions preserve logged snapshots", async ({
  page,
}) => {
  await signIn(page);
  await section(page, "Nutrition");
  await section(page, "Foods");
  await page.getByRole("button", { name: "Custom food", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Food name", exact: true })
    .fill("Cloud oats dry");
  await page
    .getByRole("combobox", { name: "Preparation state", exact: true })
    .selectOption("dry");
  for (const [field, value] of [
    ["Calories", "400"],
    ["Protein", "10"],
    ["Carbohydrates", "60"],
    ["Fat", "10"],
  ])
    await page
      .getByRole("spinbutton", { name: `Food ${field}`, exact: true })
      .fill(value);
  await page.getByRole("button", { name: "Save food", exact: true }).click();
  await saved(page);
  const foods = await api(page, "/nutrition/foods");
  const food = foods.items.find(
    (f: { name: string }) => f.name === "Cloud oats dry",
  );
  await section(page, "Recipes");
  await page.getByRole("button", { name: "New recipe", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Recipe name", exact: true })
    .fill("Cloud oat bake");
  await page
    .getByRole("combobox", { name: "Food for ingredient", exact: true })
    .selectOption(food.id);
  await page
    .getByRole("spinbutton", { name: "New ingredient grams", exact: true })
    .fill("100");
  await page
    .getByRole("button", { name: "Add ingredient", exact: true })
    .click();
  await page
    .getByRole("spinbutton", {
      name: "Finished cooked/baked weight (grams)",
      exact: true,
    })
    .fill("200");
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await saved(page);
  const recipes = await api(page, "/nutrition/recipes");
  const recipe = recipes.items.find(
    (r: { name: string }) => r.name === "Cloud oat bake",
  );
  expect(recipe.version).toBe(1);
  await page
    .getByRole("button", { name: "Log recipe Cloud oat bake", exact: true })
    .click();
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  await saved(page);
  const date = await page
    .getByLabel("Diary date", { exact: true })
    .inputValue();
  const original = (
    await api(page, `/nutrition/diary?date=${date}`)
  ).data.entries.find((e: { sourceId: string }) => e.sourceId === recipe.id);
  expect(original.snapshot.per100g.calories).toBe(200);
  expect(original.sourceRevision).toBe(1);
  await section(page, "Recipes");
  await page
    .getByRole("button", { name: "Edit recipe Cloud oat bake", exact: true })
    .click();
  await page
    .getByRole("spinbutton", {
      name: "Finished cooked/baked weight (grams)",
      exact: true,
    })
    .fill("400");
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await saved(page);
  expect(
    (await api(page, `/nutrition/recipes/${recipe.id}`)).data.version,
  ).toBe(2);
  expect(
    (await api(page, `/nutrition/recipes/${recipe.id}/versions/1`)).data
      .finishedGrams,
  ).toBe(200);
  const entry = (
    await api(page, `/nutrition/diary?date=${date}`)
  ).data.entries.find((e: { id: string }) => e.id === original.id);
  expect(entry).toEqual(original);
  await page.getByText("Historical recipe versions", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Recipe history", exact: true })
    .selectOption(recipe.id);
  await page
    .getByRole("button", { name: "View recipe version", exact: true })
    .click();
  await saved(page);
  await expect(
    page.getByText("Cloud oat bake · 200 g finished yield", { exact: true }),
  ).toBeVisible();
  await section(page, "Foods");
  await page
    .getByRole("button", { name: "Edit food Cloud oats dry", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "Food Calories", exact: true })
    .fill("500");
  await page.getByRole("button", { name: "Save food", exact: true }).click();
  await saved(page);
  await page.reload();
  await saved(page);
  expect(
    (await api(page, `/nutrition/recipes/${recipe.id}/versions/1`)).data
      .ingredients[0].snapshot.per100g.calories,
  ).toBe(400);
  expect(
    (await api(page, `/nutrition/diary?date=${date}`)).data.entries.find(
      (e: { id: string }) => e.id === original.id,
    ),
  ).toEqual(original);
});

test("revision conflicts pause writes; lost responses retry without duplicating entries", async ({
  page,
}) => {
  await signIn(page);
  await section(page, "Workouts");
  await page
    .getByRole("button", { name: "Start new workout", exact: true })
    .click();
  await saved(page);
  await section(page, "Workouts");
  await section(page, "Workout");
  const id = new URL(page.url()).searchParams.get("draft")!;
  const baseline = await api(page, `/workouts/sessions/${id}`);
  const identity = await auth(page);
  const external = await page.request.patch(`/api/v1/workouts/sessions/${id}`, {
    headers: {
      Origin: "http://127.0.0.1:3001",
      "X-CSRF-Token": identity.csrfToken,
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": `"${baseline.data.revision}"`,
    },
    data: { notes: "Other device notes" },
  });
  expect(external.status()).toBe(200);
  await page
    .getByRole("textbox", { name: /How did it feel/ })
    .fill("Pending local notes");
  await expect(page.getByText("Save paused", { exact: true })).toBeVisible();
  expect((await api(page, `/workouts/sessions/${id}`)).data.notes).toBe(
    "Other device notes",
  );
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Reload server data", exact: true })
    .click();
  await saved(page);
  await section(page, "Nutrition");
  const keys: string[] = [];
  let lose = true;
  await page.route("**/api/v1/nutrition/diary/entries", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    keys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    if (lose) {
      lose = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "X-Form-Subject": "pilot-A" },
        body: JSON.stringify({ error: { code: "SIMULATED_LOST_RESPONSE" } }),
      });
    } else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Select Mock cooked rice cooked",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  await expect(
    page.getByText("Couldn’t save", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry cloud save", exact: true })
    .click();
  await saved(page);
  expect(keys.length).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  const date = await page
    .getByLabel("Diary date", { exact: true })
    .inputValue();
  const day = await api(page, `/nutrition/diary?date=${date}`);
  expect(
    day.data.entries.filter(
      (e: { sourceId: string }) => e.sourceId === "system-rice",
    ).length,
  ).toBe(1);
});

const pendingState = (page: Page) =>
  expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
const failedState = (page: Page) =>
  expect(page.getByText("Couldn’t save", { exact: true })).toBeVisible();
const journal = (page: Page, who = "pilot-A") =>
  page.evaluate(
    (who) =>
      localStorage.getItem("form-cloud-pending-v1:" + encodeURIComponent(who)),
    who,
  );
async function failedWorkout(page: Page, note: string) {
  await section(page, "Workouts");
  await page
    .getByRole("button", { name: "Start new workout", exact: true })
    .click();
  await saved(page);
  await section(page, "Workouts");
  await section(page, "Workout");
  await page.route("**/api/v1/workouts/sessions/*/draft", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "SIMULATED_NETWORK_FAILURE" } }),
    }),
  );
  await page.getByRole("textbox", { name: /How did it feel/ }).fill(note);
  await failedState(page);
}

test("failed workout survives tab closure and remains recoverable without touching prototype keys", async ({
  page,
}) => {
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!localStorage.getItem("form-tracker-v3") &&
          !!localStorage.getItem("form-nutrition-v1"),
      ),
    )
    .toBe(true);
  const originals = await page.evaluate(() => [
    localStorage.getItem("form-tracker-v3"),
    localStorage.getItem("form-nutrition-v1"),
  ]);
  await signIn(page);
  await failedWorkout(page, "Recover after accidental closure");
  const id = new URL(page.url()).searchParams.get("draft")!;
  const raw = await journal(page);
  expect(raw).toContain("Recover after accidental closure");
  const context = page.context();
  await page.close();
  const next = await context.newPage();
  try {
    await next.goto("/?mode=cloud&section=workouts");
    await pendingState(next);
    await expect(
      next.getByRole("textbox", { name: /How did it feel/ }),
    ).toHaveValue("Recover after accidental closure");
    expect((await api(next, `/workouts/sessions/${id}`)).data.notes).toBe("");
    await next
      .getByRole("button", { name: "Retry cloud save", exact: true })
      .click();
    await saved(next);
    expect((await api(next, `/workouts/sessions/${id}`)).data.notes).toBe(
      "Recover after accidental closure",
    );
    expect(await journal(next)).toBeNull();
    expect(
      await next.evaluate(() => [
        localStorage.getItem("form-tracker-v3"),
        localStorage.getItem("form-nutrition-v1"),
      ]),
    ).toEqual(originals);
  } finally {
    await next.close();
  }
});

test("food committed before a lost response recovers after refresh with the original key and no duplicate", async ({
  page,
}) => {
  await signIn(page);
  await section(page, "Nutrition");
  const attempts: Array<{ key: string; body: string }> = [];
  let lose = true;
  await page.route("**/api/v1/nutrition/diary/entries", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData()!,
    });
    const response = await route.fetch();
    if (lose) {
      lose = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "SIMULATED_LOST_ACK" } }),
      });
    } else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Log food", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Select Mock cooked rice cooked",
      exact: true,
    })
    .click();
  await page
    .getByRole("spinbutton", { name: "Portion grams", exact: true })
    .fill("175");
  await page.getByRole("button", { name: "Log portion", exact: true }).click();
  await failedState(page);
  const body = JSON.parse(attempts[0].body);
  await page.reload();
  await pendingState(page);
  expect(attempts.length, "no automatic replay on page load").toBe(1);
  await page
    .getByRole("button", { name: "Retry cloud save", exact: true })
    .click();
  await saved(page);
  expect(attempts.length).toBe(2);
  expect(attempts[1]).toEqual(attempts[0]);
  const entries = (
    await api(page, `/nutrition/diary?date=${body.date}`)
  ).data.entries.filter((e: { id: string }) => e.id === body.id);
  expect(entries).toHaveLength(1);
  expect(entries[0].grams).toBe(175);
  expect(entries[0].snapshot.per100g.calories).toBe(130);
  expect(await journal(page)).toBeNull();
});

test("pending revisions survive refresh and conflict without overwriting another device", async ({
  page,
}) => {
  await signIn(page);
  await failedWorkout(page, "Original pending notes");
  const id = new URL(page.url()).searchParams.get("draft")!;
  const root = await api(page, `/workouts/sessions/${id}`);
  const identity = await auth(page);
  const response = await page.request.patch(`/api/v1/workouts/sessions/${id}`, {
    headers: {
      Origin: "http://127.0.0.1:3001",
      "X-CSRF-Token": identity.csrfToken,
      "If-Match": `"${root.data.revision}"`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: { notes: "Newer device notes" },
  });
  expect(response.status()).toBe(200);
  await page.unroute("**/api/v1/workouts/sessions/*/draft");
  await page.reload();
  await pendingState(page);
  await page
    .getByRole("button", { name: "Retry cloud save", exact: true })
    .click();
  await expect(page.getByText("Save paused", { exact: true })).toBeVisible();
  expect((await api(page, `/workouts/sessions/${id}`)).data.notes).toBe(
    "Newer device notes",
  );
  expect(await journal(page)).toContain("Original pending notes");
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Reload server data", exact: true })
    .click();
  await saved(page);
  expect(await journal(page)).toBeNull();
});

test("logout and account switching retain A's recovery privately; B cannot see or send it", async ({
  page,
}) => {
  await signIn(page);
  await failedWorkout(page, "Only A can recover this pending workout");
  const id = new URL(page.url()).searchParams.get("draft")!;
  const raw = await journal(page);
  const loggedOut = page.waitForURL(
    (url) => url.pathname === "/" && url.search === "?mode=cloud",
    { waitUntil: "load" },
  );
  await section(page, "Settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await loggedOut;
  await expect(
    page.getByRole("link", { name: "Sign in to FORM", exact: true }),
  ).toBeVisible();
  expect(await journal(page)).toBe(raw);
  await page
    .getByRole("link", { name: "Sign in to FORM", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign in as pilot B", exact: true })
    .click();
  await saved(page);
  await expect(
    page.getByText("Only A can recover this pending workout", { exact: true }),
  ).toHaveCount(0);
  expect(await journal(page)).toBe(raw);
  expect(
    (await page.request.get(`/api/v1/workouts/sessions/${id}`)).status(),
  ).toBe(404);
  await section(page, "Settings");
  await page.getByRole("link", { name: "Switch account", exact: true }).click();
  await page
    .getByRole("button", { name: "Sign in as pilot A", exact: true })
    .click();
  await pendingState(page);
  await page.unroute("**/api/v1/workouts/sessions/*/draft");
  await page
    .getByRole("button", { name: "Retry cloud save", exact: true })
    .click();
  await saved(page);
  expect((await api(page, `/workouts/sessions/${id}`)).data.notes).toBe(
    "Only A can recover this pending workout",
  );
});

test("expired sessions hide pending UI and restore it only after the same account signs in", async ({
  page,
}) => {
  await signIn(page);
  await failedWorkout(page, "Pending through expiration");
  const raw = await journal(page);
  await page.request.post("/__test/expire", {
    headers: { "X-Form-Test-Key": "local-test-control-only" },
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("link", { name: "Sign in to FORM", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: /How did it feel/ }),
  ).toHaveCount(0);
  expect(await journal(page)).toBe(raw);
  await page
    .getByRole("link", { name: "Sign in to FORM", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign in as pilot A", exact: true })
    .click();
  await pendingState(page);
  expect(await journal(page)).toBe(raw);
});

test("device storage failure blocks writes and exposes a private recovery download", async ({
  page,
}) => {
  await signIn(page);
  await section(page, "Workouts");
  await page
    .getByRole("button", { name: "Start new workout", exact: true })
    .click();
  await saved(page);
  await section(page, "Workouts");
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().endsWith("/draft")) writes++;
  });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("form-cloud-pending-v1:"))
        throw new DOMException("Full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page
    .getByRole("textbox", { name: /How did it feel/ })
    .fill("Download unprotected edit");
  await expect(page.getByText("Couldn’t save", { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download pending cloud edits", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("form-cloud-pending.json");
});

test("starting a workout after a lost acknowledgement survives refresh without creating another workout", async ({
  page,
}) => {
  await signIn(page);
  const before = (await api(page, "/workouts/sessions/active")).items.length;
  const attempts: Array<{ key: string; body: string }> = [];
  let lose = true;
  await page.route("**/api/v1/workouts/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData()!,
    });
    const response = await route.fetch();
    if (lose) {
      lose = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "LOST_START_ACK" } }),
      });
    } else await route.fulfill({ response });
  });
  await section(page, "Workouts");
  await page
    .getByRole("button", { name: "Start new workout", exact: true })
    .click();
  await failedState(page);
  const id = JSON.parse(attempts[0].body).id;
  await page.reload();
  await pendingState(page);
  await page
    .getByRole("button", { name: "Retry cloud save", exact: true })
    .click();
  await saved(page);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(new URL(page.url()).searchParams.get("draft")).toBe(id);
  expect((await api(page, "/workouts/sessions/active")).items.length).toBe(
    before + 1,
  );
});

test("completion acknowledgement loss cannot create another completed generation on refresh", async ({
  page,
}) => {
  await signIn(page);
  await section(page, "Workouts");
  await page
    .getByRole("button", { name: "Start new workout", exact: true })
    .click();
  await saved(page);
  await section(page, "Workouts");
  await section(page, "Library");
  await page
    .getByRole("button", {
      name: "Add Seated cable chest flyes to workout",
      exact: true,
    })
    .click();
  await saved(page);
  await section(page, "Workout");
  await page
    .getByRole("button", {
      name: "Complete Seated cable chest flyes set 1 both",
      exact: true,
    })
    .click();
  await saved(page);
  const id = new URL(page.url()).searchParams.get("draft")!;
  const attempts: Array<{ key: string; revision: string }> = [];
  let lose = true;
  await page.route("**/api/v1/workouts/sessions/*/complete", async (route) => {
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      revision: route.request().headers()["if-match"],
    });
    const response = await route.fetch();
    if (lose) {
      lose = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "LOST_COMPLETE_ACK" } }),
      });
    } else await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Finish & view summary", exact: true })
    .click();
  await failedState(page);
  const committed = (await api(page, `/workouts/sessions/${id}`)).data;
  expect(committed.status).toBe("completed");
  await page.reload();
  await pendingState(page);
  await page
    .getByRole("button", { name: "Retry cloud save", exact: true })
    .click();
  await saved(page);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await api(page, `/workouts/sessions/${id}`)).data).toEqual(committed);
});

test("recipe edits with lost acknowledgements do not duplicate immutable versions after refresh", async ({
  page,
}) => {
  await signIn(page);
  const recipes = await api(page, "/nutrition/recipes");
  const recipe = recipes.items.find(
    (r: { name: string }) => r.name === "Cloud oat bake",
  );
  const originalVersion = (
    await api(
      page,
      `/nutrition/recipes/${recipe.id}/versions/${recipe.version}`,
    )
  ).data;
  await section(page, "Nutrition");
  await section(page, "Recipes");
  const attempts: Array<{ key: string; revision: string; body: string }> = [];
  let lose = true;
  await page.route(
    `**/api/v1/nutrition/recipes/${recipe.id}`,
    async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      attempts.push({
        key: route.request().headers()["idempotency-key"],
        revision: route.request().headers()["if-match"],
        body: route.request().postData()!,
      });
      const response = await route.fetch();
      if (lose) {
        lose = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "LOST_RECIPE_ACK" } }),
        });
      } else await route.fulfill({ response });
    },
  );
  await page
    .getByRole("button", { name: "Edit recipe Cloud oat bake", exact: true })
    .click();
  await page
    .getByRole("spinbutton", {
      name: "Finished cooked/baked weight (grams)",
      exact: true,
    })
    .fill(String(recipe.finishedGrams + 123));
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await failedState(page);
  await page.reload();
  await pendingState(page);
  await page
    .getByRole("button", { name: "Retry cloud save", exact: true })
    .click();
  await saved(page);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(
    (await api(page, `/nutrition/recipes/${recipe.id}`)).data.version,
  ).toBe(recipe.version + 1);
  expect(
    (
      await api(
        page,
        `/nutrition/recipes/${recipe.id}/versions/${recipe.version}`,
      )
    ).data,
  ).toEqual(originalVersion);
});
