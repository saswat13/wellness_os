# FORM launch catalog v1

This is a **local, reviewable seed bundle**, not evidence of a production import.
It contains 400 strength-focused exercises and 400 USDA reference foods. No images,
private records, user IDs, API keys or account-specific AWS configuration are included.

## Sources and rights

- **Exercises:** [yuhonas/free-exercise-db](https://github.com/yuhonas/free-exercise-db),
  pinned commit `f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5`. The text dataset declares
  the Unlicense; a copy is in `sources/EXERCISE-LICENSE.md`. Source IDs, attribution
  and instructions are retained. Exercises exceeding supported field bounds are
  excluded rather than truncating their instructions. Images and image references
  are excluded; third-party image rights have not been verified.
- **Foods:** U.S. Department of Agriculture, Agricultural Research Service,
  [FoodData Central](https://fdc.nal.usda.gov/), SR Legacy reference values. USDA
  data is public domain/CC0; attribution is retained in every food record. These
  are reference ingredients, not a current branded-product database.
- **Transport/provenance caveat:** the official USDA host was denied by this cloud
  environment's network policy. Original `fndds_ingredient_nutrient_value.csv` and
  `nutrient.csv` were retrieved from the USDA-release folder in the
  [pinned mirror](https://github.com/antiffraud/dataset-nutrisi-makanan/tree/ebd94b90f03476b93549af056524e9138a7c8e3e/FoodData_Central_csv_2025-04-24).
  Only rows explicitly sourced from SR Legacy are used. No TKPI, translations,
  notebooks, derivative nutrition estimates or other copyrighted files from that
  repository are used. `manifest.json` records the transport commit and full-file
  SHA-256 hashes. Those hashes pin retrieved files; they are **not** independent
  USDA archive-authenticity checks. Official-source cross-checking is outstanding.

## Curation and quality

`selection.json` lists original source IDs, food groups, preparation states and
classification reasons. `quality-report.json` records counts and exclusions.
Selection is deterministic; `backend/scripts/build_catalog.py` contains quotas,
common-food priority IDs, normalization and selection rules. It is a programmatically
curated launch set with reviewable selections, not a claim of individual expert
review of all 800 records. No item is certified vegetarian or allergen-free from
its description alone.

Food groups prioritize vegetables, legumes, grains, fruit, nuts/seeds and dairy/egg
alternatives; only 25 entries are in the meat/fish group. Raw, dry, cooked and
packaged records remain distinct. Frozen/canned foods retain those words in their
names and use the packaged state; raw mature legume seeds and raw grains use dry
weight. Ambiguous preparation descriptions are excluded. Names retain source
preparation detail; aliases add search synonyms without replacing source identity.

Required nutrition is **kcal plus grams of protein, carbohydrate and fat per
100 g edible portion**, taken directly from the ingredient source's per-100-g
values. USDA nutrient numbers 208, 203, 205 and 204 are mapped by number, with
units verified against `nutrient.csv`; array order is irrelevant. There is no
serving-to-100-g guess or silent kJ-to-kcal conversion. Missing values do not become
zero. Conflicting duplicate nutrients, nonfinite/negative values, wrong units,
macro values over 100 g, macro totals over a 105 g rounding tolerance and energy
over 950 kcal/100 g are rejected. No synthetic 4/4/9 replacement is made.

Muscles/equipment map to FORM's existing enums. Unsupported specific muscle groups
(e.g. lower back/forearms/adductors) use Other, retaining original primary labels
in tags. Only explicit single-arm/single-leg/alternating names and lunges enable
left/right logging. Bilateral dumbbell movements are not inferred unilateral.
Existing custom IDs, session snapshots and logged side values are untouched.

## Local validation and import

From the repository root, using the existing Python 3.13 venv:

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/seed_catalog.py --dry-run
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/seed_catalog.py --local --dry-run
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/seed_catalog.py --local --apply
```

The first command is offline validation and makes no AWS calls. `--local` creates
isolated Moto tables with fake credentials, never live resources. Local apply
also imports a second time to prove idempotency and reads every page through the
existing authenticated application API, verifying 400 system exercises and 400
system foods. The browser fixture is separately opt-in:

```bash
npm run build
npm run test:e2e:catalog
```

It starts the loopback-only fake BFF with `--catalog-bundle`; it does not change the
normal mock fixture, prototype localStorage or any deployed runtime entrypoint.

## Existing-table dry-run and future authorized apply

**The local implementation did not import or deploy to AWS.** A live release
requires explicit authorization and an operator's existing profile and the existing catalog table from
private deployment configuration. Do not infer a table, provision one, change IAM,
or use a Lambda runtime role to seed data.

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/seed_catalog.py \
  --dry-run --table EXISTING_CATALOG_TABLE --profile EXISTING_OPERATOR_PROFILE
```

This queries only the shared `TYPE#EXERCISE` / `TYPE#FOOD` partitions for duplicate
source IDs/names and reads exact target keys; it does not scan or inspect private
partitions. Existing shared duplicates under another ID are reported for review,
never merged or replaced.
A live write requires **all** of `--apply`, `--table`, matching `--confirm-table`,
`--profile` and `--expected-account`. The tool checks STS account identity before
writes. Use the existing authorized operator; denied access is a blocker, not
permission to edit IAM.

All bundle records and existing target rows are preflighted before the first
write. Only rows with this importer's marker and intact content hash can be updated.
Unmanaged collisions or externally edited payloads block the whole plan. Creates
use `attribute_not_exists`; updates compare revision, payload, importer and hash.
Identical payloads preserve their revision and timestamps. Changed managed rows
increment revision and preserve creation time. No delete, archive sweep, scan,
user-partition write or snapshot rewrite exists. A racing write can cause a partial
import to stop; rerun idempotently after inspection rather than deleting records.
The full import is not an all-or-nothing 800-row transaction.

**Release order:** deploy the additive model/API support before seeding the
new payload format; an older strict backend would reject new fields. Release the
frontend search/attribution support, then perform the reviewed import. Reconcile
source and deployed code before any release, preserving private BFF changes.
Reuse current endpoints: `/v1/workouts/exercises` and `/v1/nutrition/foods`. Lists
continue to page private entries followed by shared catalog entries; consumers must
follow `nextCursor`. Shared entries have null ownership and remain read-only to users.
Historical snapshots retain their original source revision and nutrition/side values.

## Rebuild from pinned originals

Download the three exact files referenced by `manifest.json` into a directory
outside the checkout: `exercises.json`, `nutrient.csv`, and
`fndds_ingredient_nutrient_value.csv`, plus the pinned exercise `LICENSE.md` as
`exercise-LICENSE.md`. Verify their SHA-256 hashes against the manifest before use.
Then:

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/build_catalog.py \
  --source-dir /PATH/TO/PINNED/SOURCES
```

The committed selected source excerpts allow source-to-bundle verification in tests
without downloading the full USDA CSV or requiring an API key. Official USDA download
domain additions were saved in the cloud environment draft; saving the draft alone
does not establish runtime access or publication.
