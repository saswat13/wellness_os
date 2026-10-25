# FORM functional and technical audit

Audit date: October 17, 2026 (America/Los_Angeles). Scope: the existing local prototype, current source, development preview, production build and isolated Chromium tests. No AWS/IAM/infrastructure operations. No new product modules or dependencies. No real-user browser storage was read or reset by tests.

## Outcome

The workflows listed below were verified locally with assertions. This is not production or multi-user certification. The initial 21 domain cases and 14 browser tests passed, but added edge-case tests exposed real gaps. After corrections, 30 domain cases and 21 Chromium tests pass. Shared browser monitoring reports no console errors or unhandled runtime exceptions in the tested journeys. The previously reported extension hydration warning did not reproduce after the existing body-only fix, including with the exact injected attributes from the screenshot.

## Verified features and evidence

| Area                   | Verified behavior                                                                                                                                                                  | Evidence                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Food logging           | Search/select, gram weights including decimals, per-100-g scaling, four meals, exact daily totals                                                                                  | nutrition.spec.ts, audit.spec.ts, nutrition.test.ts, audit.test.ts |
| Diary editing/deletion | Update grams, explicitly reassign meal/date, stable entry ID, original nutrient snapshot, deletion and totals                                                                      | audit.spec.ts, audit.test.ts                                       |
| Independent dates      | Empty/new days start at zero; navigating away/back retains records; edits can move a record explicitly; refresh does not move entries                                              | audit.spec.ts, audit.test.ts                                       |
| Foods                  | Custom creation/edit/reuse, source/preparation values, favorites/recent search; original logs survive rename/value changes                                                         | nutrition.spec.ts, nutrition.test.ts                               |
| Raw/cooked/dry         | Distinct definitions, search filters and frozen preparation values; no automatic raw-to-cooked conversion                                                                          | nutrition.spec.ts, audit.test.ts                                   |
| Recipes                | Multiple weighed ingredients, totals, positive finished yield, per-100-g finished values, weighed servings, edits preserve logged portions                                         | nutrition.spec.ts, audit.spec.ts, nutrition.test.ts, audit.test.ts |
| Goals/preferences      | Save/Cancel numeric goals, macro calorie discrepancy information, immediate diary/Home updates, refresh persistence, units/name/time zone                                          | nutrition.spec.ts, nutrition.test.ts                               |
| Workouts               | Set fields, one-tap completion, add/remove, notes, units, optional RPE/rest timer, summary, template independence and safe export                                                  | workout.spec.ts, exercise-management.spec.ts, tracker.test.ts      |
| Custom exercises       | Name-only create, metadata/tags, search/filter, add, rename, archive/restore and frozen historical names                                                                           | exercise-management.spec.ts, tracker.test.ts                       |
| Unilateral logging     | Independent L/R reps/load/RPE/status, default weight shortcut, partial persistence, paired counts, completed-side volume, corresponding-side prefill, historical mode preservation | unilateral.spec.ts, unilateral.test.ts                             |
| History/persistence    | Archived results stay detached from drafts; repeated finish has one session ID; current/legacy migrations; malformed records retained; UTC-midnight dates respect chosen zone      | tracker.test.ts, unilateral.test.ts, audit.test.ts                 |
| Failure/concurrency    | Stale tabs cannot overwrite newer data in tested Chromium; writes validate snapshots; quota failure preserves prior store; private unsaved-data download; confirmed reload         | audit.spec.ts, persistence.test.ts                                 |
| Duplicate actions      | Repeated finish never duplicates a session; duplicate food submit events produce one entry; editing retains IDs                                                                    | audit.spec.ts, audit.test.ts                                       |
| Navigation             | Main sections, browser Back/Forward, Home mark, workout subviews, direct recent archive access and archive reload                                                                  | audit.spec.ts                                                      |
| Layout/runtime         | 320/390/1280px views, long 120-character names, no horizontal overflow; desktop meal grid; screenshot inspection and console/runtime capture                                       | audit.spec.ts, workout.spec.ts, local visual walkthrough           |

Calculation examples used as assertions: 75.5 g mock dry rice at 360 kcal/100 g = 271.8 kcal; reassigning the same entry to another date at 50 g yields 180 kcal with the same ID. A 100 g dry-rice recipe at 300 g finished yield has 120 kcal/100 g. The oats/yogurt recipe example retains the original 150 kcal/100 g snapshot after its yield is edited. Two mock chicken definitions remain distinct: 200 g raw = 240 kcal, 200 g cooked = 330 kcal. These values are test fixtures, not verified nutrition guidance.

## Bugs identified and fixed

| Finding                                              | Reproduction or evidence                                                                                                                                              | Correction                                                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portion date became stale                            | Open portion on Nov 1, change the diary to Nov 2; old form remained tied to Nov 1. Today also left old edit forms open. Added test failed before correction.          | All date navigation dismisses old portion/edit drafts without changing saved records.                                                                                     |
| Another tab could overwrite history/goals            | Two tabs held old snapshots; saving from the older tab overwrote changes made in the newer one. New multi-tab regression failed before correction.                    | Validate and compare snapshots, serialize supporting browsers with Web Locks, pause stale writes, retain in-memory drafts and offer recovery export/reload.               |
| Long rep targets generated invalid actual sets       | A template target of 1000–1200 created reps=1000, outside the schema. Domain regression failed before correction; later refresh could reject the whole saved workout. | Bound generated actual reps to the schema range for new entries and added groups. Planned text remains intact.                                                            |
| Long custom names broke narrow layout                | A valid 120-character unbroken food name overflowed the document. Added 320px regression failed before correction.                                                    | Wrap user content and allow form controls to shrink; verified at mobile and desktop widths.                                                                               |
| Unused recipe ingredient grams blocked Save          | Clearing the next-ingredient amount created a zero value that failed native validation for the outer recipe form, even when existing ingredients/yield were valid.    | Next-ingredient input is optional to Save; Add ingredient still requires a valid positive amount.                                                                         |
| Calorie display appeared inconsistent                | Consumed calories rounded to whole numbers while remaining calories retained decimals (936 + 1464.5 against a 2400 target).                                           | Both use the same display precision; internal calculations remain unrounded.                                                                                              |
| URL/browser navigation and shortcuts were incomplete | Main actions used replaceState with no popstate restoration; FORM used a same-route link instead of explicit state navigation; recent rows opened the generic list.   | Native history stack with validated restoration, explicit Home action, direct archived-session URLs and refresh support.                                                  |
| Exercise date/summary interpretation                 | Exercise dates used UTC slicing while archives used the chosen zone; first-row loads could include an unfinished side.                                                | Consistent preferred-zone dates; label unfinished previous sides and remove the misleading arbitrary-first-row trend claim. Full progression remains in Progress/history. |
| Invalid timestamps could reach history formatting    | Restore accepted arbitrary completedAt strings or unrenderable started values.                                                                                        | Validate ISO completion times and renderable timestamps before restoring.                                                                                                 |
| Lint raced generated browser artifacts               | ESLint hit ENOENT while Playwright recreated test-results.                                                                                                            | Ignore test-results and playwright-report in lint configuration.                                                                                                          |

The prior hydration fix remains narrowly scoped to body. No global console suppression was introduced. tests/hydration.spec.ts injects the reported Grammarly/shortcut attributes before hydration and verifies logging/refresh without errors.

## Final checks

| Check                       | Result                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| npm run lint                | Passed, no warnings                                                                                                 |
| npm run typecheck           | Passed                                                                                                              |
| npm test                    | 30 individual cases passed                                                                                          |
| npm run test:e2e            | 21 Chromium cases passed, with shared console/runtime monitoring                                                    |
| npm run build               | Passed, supported Webpack production build; routes prerendered                                                      |
| Prettier check              | Passed for changed source, tests and documentation                                                                  |
| Visual walkthrough          | All five main sections at 320, 390 and 1280px; no document overflow; desktop/mobile screenshots inspected           |
| npm audit --omit=dev --json | Zero reported production vulnerabilities                                                                            |
| npm audit --json            | Nonzero: one braces advisory propagates through five development ESLint dependency packages, reported high severity |

The npm tooling recommendation is a major downgrade of eslint-config-next to 14.2.35. No forced downgrade or dependency changes were made. The development advisory chain remains an explicit follow-up, not a clean full-audit result. No new browser errors were observed; this does not prove every possible extension/browser state is error-free.

## Partially implemented or missing

- One local mock identity; no registration, authentication, server authorization or multi-device persistence.
- Browser conflict detection pauses rather than merges. Web Locks serialize cooperating tabs in supporting browsers; browsers without Web Locks have best-effort optimistic checks and storage events, not transactional guarantees. Backend concurrency handling is still needed.
- Recovery download contains private workout/nutrition data. A validated backup importer/merge/recovery UI is not implemented. Invalid originals remain untouched for manual recovery.
- Main sections/workout views persist in the URL. Nutrition sub-tabs, selected diary date, filters, editor drafts and timer visibility/state are transient. Daily records themselves persist independently.
- Recipe/custom-food create/edit/log flows work. Food/recipe archive/delete lifecycle and nested recipes are not implemented. Editing food definitions does not update saved recipe ingredient snapshots; remove/re-add an ingredient deliberately to use its new definition.
- Templates export an allowlisted definition/plan. Hosted public publishing, import, duplicate/delete lifecycle and public discovery are absent.
- The latest completed session can be reopened through Back to workout; finishing corrections replaces that same session ID. Older archive views are read-only. Full versioned workout corrections are not implemented.
- Analytics are descriptive and limited to current goals, seven nutrition days and recent training/exercise bars. Historical goal versions and richer period comparisons are missing. Seeded history/system-food values remain mock data.
- Exercise demos are external search links unless a custom URL is supplied; videos are not curated or verified.
- Powerlifting/HYROX/running exist as classification choices, not complete discipline-specific tracking workflows. Calendar-based workout scheduling is absent.
- Chromium automation and screenshot review were completed. Real-device, Firefox/WebKit, screen-reader, slow/offline-network and production-server load testing were not completed. The production build was checked, but no cloud deployment or backend was exercised.

## Before AWS backend integration

1. Define authenticated identity and server-enforced ownership for every private entity; never trust the submitted mock ownerId.
2. Finalize versioned API/database contracts, timestamp/unit conventions, validation and referential integrity; plan imports of existing local IDs/snapshots and composite session-entry identities.
3. Add transactional/idempotent writes, revision conflict handling, retries and recovery for offline/multi-device use. Local browser protections are not server guarantees.
4. Implement a validated local-data migration/import path with backup, deduplication and snapshot-preserving dry runs; do not clear current browser data on sign-in.
5. Review/fix the development tooling advisory chain before shared production CI, and pin a reviewed dependency update policy.
6. Add two-user authorization tests, API integration/migration tests and cross-browser/device acceptance; choose infrastructure only in a separately authorized milestone.

## Files changed

- Added lib/persistence.ts, app/hooks/use-snapshot-persistence.ts, lib/persistence.test.ts, lib/audit.test.ts, tests/audit.spec.ts, tests/fixtures.ts and this report.
- Updated app/page.tsx, app/components/nutrition.tsx, app/components/overview.tsx, app/components/management.tsx, app/globals.css, lib/models.ts, lib/tracker.ts, lib/unilateral.ts and eslint.config.mjs.
- Updated existing browser tests to use shared console/runtime monitoring, plus AGENTS.md, README.md, docs/requirements.md and docs/architecture.md.
- No storage keys, dependencies, migration source keys or AWS installer files were removed or replaced. All test-created data lived in isolated browser contexts.
