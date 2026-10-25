import test from "node:test";
import assert from "node:assert/strict";
import { matchesCatalogSearch } from "./catalog-search";
import { foodSchema, seedNutrition } from "./nutrition";
import { blankExercise } from "./tracker";
import { exerciseSchema } from "./models";

test("catalog search includes aliases, identifiers and preparation without depending on word order", () => {
  assert.ok(
    matchesCatalogSearch("DB incline", [
      "Alternate Incline Dumbbell Curl",
      "DB",
    ]),
  );
  assert.ok(
    matchesCatalogSearch("chana cooked", [
      "Chickpeas",
      "cooked",
      "chana",
      "173757",
    ]),
  );
  assert.ok(matchesCatalogSearch("173757", ["Chickpeas", "173757"]));
  assert.ok(matchesCatalogSearch("cafe au lait", ["Café-au-lait"]));
  assert.ok(
    !matchesCatalogSearch("chana cooked", ["Chickpeas", "raw", "chana"]),
  );
  assert.ok(matchesCatalogSearch("", ["A custom food", null, undefined]));
});

test("old custom records and nutrition snapshots retain their values without a migration", () => {
  const custom = blankExercise("My custom lift");
  const parsed = exerciseSchema.parse(custom);
  assert.deepEqual(parsed, custom);
  const food = seedNutrition().foods[0];
  assert.deepEqual(foodSchema.parse(food), food);
  assert.equal(parsed.unilateral, false);
  assert.ok(
    matchesCatalogSearch("my custom lift", [
      parsed.name,
      ...(parsed.aliases ?? []),
    ]),
  );
});
