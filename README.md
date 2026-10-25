# FORM · Fitness & Nutrition

A complete local, mobile-first prototype built with Next.js, TypeScript and Tailwind. Home, Workouts, Nutrition, Progress and Settings share FORM's muted green design and one mock user. Workout and food histories persist in this browser; local prototype data is not deployed.

An explicit cloud-mode UI is implemented and tested locally with a fake identity provider:
see [Milestone 1.2](docs/milestone-1.2.md). Its separate account-scoped pending journal
recovers unacknowledged edits after refresh/tab closure; same-account sign-in and explicit
retry are required. No credentials are stored in that journal. Read the [reliability and
device-privacy review](docs/pending-write-review.md) before a controlled pilot.

## Start and preview in Codespaces

From `/workspaces/codespaces-blank`:

```bash
npm ci
npm run dev
```

Dependencies are already installed in this workspace. In Codespaces, open **Ports**, choose **Forward a Port**, enter **3000**, keep visibility **Private**, and click **Open in Browser**. The development server listens on `0.0.0.0:3000`. On a local computer open `http://localhost:3000`.

Stop the development server with Ctrl+C before starting a production preview:

```bash
npm run build
npm start
```

Forward the same private port 3000. The build uses Next.js's supported Webpack bundler because Turbopack's CSS worker tries to bind a restricted local port in the agent environment. No network fonts, assets or backend are required.

## Try the complete journeys

1. **Workout:** Home → Open/Resume workout, or Workouts → Templates → Start workout. Change reps/load or tap completion directly. Optional RPE and rest timers remain available. Finish → summary → Workouts → History → View session to review frozen results and partial pairs.
2. **Custom exercise:** Workouts → Library → type a name → Create → Edit. Muscles, equipment, pattern, tags and training types are optional. Enable left/right logging if needed; Add to workout, return to Workout and log its sets. Archive/restore and Customize copy work as before.
3. **Session versus template:** Expand Edit exercise in this session to move, replace, remove or change planned targets. Replacing logged sets asks for confirmation. Templates → Edit template supports replacement, ordering and prescriptions; Save template never changes the active session. Export for sharing includes only definitions and planned targets, with no private logs.
4. **Food diary:** Nutrition → Diary → Log food or Add beside a meal → search/select a food → enter grams and choose meal/date → Log portion. Try Basmati rice in both dry and cooked states. Recent/Favorites filters reduce searching; the star toggles favorites. Edit/delete buttons update logged items. Date arrows and Today work.
5. **Goals:** Diary → Edit Goals, or Settings → Nutrition Goals. Change calories/protein/carbs/fat → Save goals → return to Home/Diary and check targets. Cancel restores saved values. Macro-derived calories use 4P + 4C + 9F; a mismatch notice is informational and does not block saving. Settings also saves display name, kg/lb and time zone.
6. **Custom foods:** Nutrition → Foods → Custom food → name/preparation/per-100-g values → Save food. Search it and log grams. Edit its definition afterward; historical diary and recipe ingredient snapshots retain the original values.
7. **Recipe:** Nutrition → Recipes → New recipe → add ingredients and grams → enter finished cooked/baked weight → Save recipe → Log portion. Example: 100 g mock oats + 200 g mock yogurt = 525 kcal. With 350 g finished yield, that's 150 kcal/100 g; a 175 g serving logs 262.5 kcal. Edit the yield to 700 g: new servings use 75 kcal/100 g, while old diary entries stay unchanged.
8. **Progress:** Explore training volume, reports by primary muscle/equipment/movement/training type, exercise progression and left/right comparisons. Nutrition shows 7 daily calorie bars, average logged intake and daily macros.
9. Refresh after edits to verify persistence. Navigate all five main sections at mobile and desktop widths.

## Unilateral logging

Each paired set has Left and Right rows with independent reps, weight, optional RPE and completion. Both sides must complete before the pair counts once; one completed side retains partial status and contributes volume. Same weight starts enabled and copies only weight edits within that pair. Loading history or enabling the shortcut never equalizes unequal values. Add/remove affects the entire pair. Prefill uses the corresponding completed side from the previous session in the same tracking mode; missing sides use planned reps and zero load. Switching the library exercise to bilateral changes future sessions only.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Chromium is installed here. On a fresh Codespace run `npx playwright install --with-deps chromium` before browser tests. Playwright starts and stops its own local development server when port 3000 is free. Domain tests use one process so individual cases execute reliably in the restricted agent environment.

## Data and boundaries

- `form-tracker-v3`: exercises, templates, active workout and historical session snapshots. Existing v2/v1 keys migrate without deletion.
- `form-nutrition-v1`: mock user/preferences, goals, system/custom foods, recipes, favorites and diary snapshots.
- Data is separate for each browser/origin/profile. A Codespaces preview and localhost have different storage. Invalid stores are preserved with a warning and temporary in-memory use; browser storage failure also displays a warning.
- System nutrition values and seeded meals/workouts are illustrative mock data. Enter your own source values for custom foods. Internal calculations retain precision; UI values are rounded for reading.
- Public registration, server authorization, sync, public template publication/import, verified food databases and powerlifting/HYROX/running-specific logging are future milestones. Template training types support classification now.
- No AWS resources, IAM changes, cloud deployment or paid infrastructure.

See [requirements](docs/requirements.md), [architecture](docs/architecture.md), [functional audit](docs/audit.md) and [sanitized AWS status](docs/aws-public-status.md).

Account-specific AWS deployment and recovery artifacts are intentionally excluded from
this public repository. See the [sanitized AWS status summary](docs/aws-public-status.md).

## Functional and technical audit

See [docs/audit.md](docs/audit.md) for the verified feature matrix, fixed bugs, test evidence and remaining backend blockers. Desktop meal cards now use two columns; phones retain one column. Date navigation closes old food/edit drafts, and consumed/remaining calories use consistent precision. Main navigation supports browser Back/Forward and archived-session URLs.

Saving validates complete snapshots. If another tab changes a store or browser storage fails, FORM pauses writes and shows a warning. **Download unsaved data** creates a private JSON backup of this tab's in-memory workout/nutrition data. **Load latest saved data** confirms discarding unsaved edits and reloads the browser's latest stored records. Keep backups private. Automatic backup import/merging and cross-device synchronization are future work; Web Locks strengthen same-browser coordination where supported.

## Local backend foundations

Milestone 0 adds an isolated Python backend test harness; the frontend still uses its existing browser data. See [backend setup and commands](backend/README.md), [v1 OpenAPI](backend/contracts/openapi-v1.json) and [implementation status](docs/backend-tasks.md). No real Cognito/DynamoDB integration or deployment is included.
