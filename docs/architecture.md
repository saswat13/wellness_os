# Architecture

Next.js App Router renders the static shell with a client-side workout and management interface. Tailwind preserves FORM's existing spacing, colors and touch targets. Default local mode uses the original browser stores. Milestone 1.2 adds an explicit same-origin cloud adapter, implemented and tested offline; no infrastructure is deployed.

## Cloud adapter boundary — Milestone 1.2

`app/components/cloud-account.tsx` discovers the HttpOnly-cookie session and supplies the
existing screens through `CloudController` and `CloudWorkspace`. Generated OpenAPI types
in `lib/api-v1.generated.ts` feed `lib/form-api.ts`; `lib/cloud-client.ts` owns CSRF,
account epochs, aborts and cross-tab invalidation. Private UI projections clear on
logout/expiration/account changes. Pending writes now use a separate account-scoped device
journal with original revisions/keys; recovery requires that account's verified session
and explicit retry. An exclusive Web Lock permits one writer tab per account. Cloud mode
never invokes prototype restore/persistence hooks. `parseStore` retains the fixed local-user guard;
`validateStore` applies the same graph checks to an explicitly scoped cloud projection.
These browser checks do not replace backend Principal authorization.

`CloudController.discover()` reports failed API method/route, status and error code in the
account alert; query parameters are removed before display. Non-API failures identify the
session, device-recovery or record-loading stage. Diagnostics never include response
bodies, headers, credentials or record identifiers. Pending device data remains preserved.
Live authenticated discovery has not yet been verified.

See [pending-write reliability review](pending-write-review.md) for journal lifecycle,
quota/conflict handling, validation, privacy and the single-writer tab tradeoff.

See [Milestone 1.2](milestone-1.2.md) for APIs, active-draft index, test boundaries,
online-save/conflict behavior and bounded history windows. The following local architecture
sections continue to describe prototype storage, not the cloud database.

## Models

`lib/models.ts` defines TypeScript types and Zod runtime schemas:

- **Exercise**: immutable ID; system/custom source; nullable system owner or custom owner; current name; optional primary/secondary muscles, movement pattern and equipment; multiple tags and training types; unilateral flag; coaching notes; demonstration URL; archive flag; timestamps. System IDs are seeded constants; custom IDs are UUIDs, never generated from names.
- **WorkoutTemplate**: ID, owner, name, training type, private/public visibility and ordered entries referencing exercise IDs. Each entry has its own stable ID and a prescription (planned sets, rep target, coaching notes). Templates contain no actual set results or workout notes.
- **WorkoutSession**: ID, owner, source template ID, session name and training type, ordered exercise entries, actual set logs, units, private workout notes and completion timestamps. Each entry freezes a full exercise metadata snapshot and prescription. Session names/order/targets can change independently of the original template. A persisted sameWeight preference is initialized true for each new entry.
- **ExerciseSet**: its own side-record ID and stable groupId, plus owner/session/session-entry/exercise references; actual reps, canonical kg, optional RPE, side and completion. Repeated uses of the same exercise have independent session-entry IDs and independent logs.

Exercise definitions describe movements, template prescriptions describe intent, and sets describe actual performance. No editable name is used as a relational key. Reporting can group by stable exercise ID, exercise metadata snapshot at workout time, session training type, equipment, movement pattern or muscle group. Current library metadata can also support deliberate current-classification reports. Tags remain user-defined; controlled muscle/equipment/pattern values make grouping predictable.

## Local persistence and history

`lib/tracker.ts` implements creation, lookup, ownership guards, template/session construction, immutable history snapshots, archiving, migration and export. `form-tracker-v3` stores the library, templates, current session and completed sessions. The previous `form-tracker-v2` and original `form-workout-v1` keys are migrated without deleting them. V2 migration adds deterministic group IDs and default weight shortcuts while retaining original side-record IDs, weights, reps, RPE and partial flags. Corrupt/unknown-owner stores are not overwritten: the interface warns and allows temporary in-memory use.

Saved stores are parsed and checked for unique IDs, ownership and set/reference integrity. Completing a session adds a detached snapshot to history; resuming and finishing that same session again explicitly replaces its historical snapshot with the corrected results. Library or template edits never update historical snapshots. Archiving hides an exercise from normal search and prevents new additions/template starts while preserving existing references, active logs and history. Restore is available under Include archived.

New sessions use the latest completed session for that exercise ID with the same tracking mode, match original group position and side, prefill reps/load/RPE, and initialize all completion flags unchecked. Unfinished/missing sides use planned reps, zero load and blank RPE; they are never filled from the opposite side or a different group. Templates determine planned set count; actual set addition/removal remains independent. Current-session prescription changes do not silently alter existing actual sets. Starting another template confirms replacement of an unfinished active session.

Rest timers use absolute deadlines and remain transient. RPE visibility, filters and editor drafts are transient. Library, templates, logs, completion, workout notes and units persist.

## UI

- app/page.tsx: existing workout cards, current-session editing, summary, timer and history, plus compact Workout / Library / Templates navigation.
- app/components/set-logger.tsx: paired/bilateral rows, independent side controls and the shared-weight shortcut.
- app/components/performance-history.tsx: structured history and side comparison tables in both the workout and library.
- lib/unilateral.ts: grouping, completed/partial set counts, pair mutation and side analytics.
- app/components/management.tsx: name-only quick creation, optional advanced metadata, search/filter, archive/restore, system exercise copying, private exercise history, template drafts, ordered prescriptions and export.
- lib/workout.ts: original illustrative fixture data, legacy shape for migration tests and volume/unit helpers; the live UI uses the normalized models.
- tests: domain tests and Chromium interaction coverage for original logging and new management workflows.

The four original exercises are examples, not a fixed workout catalog. Users can remove all session exercises, build empty templates and add any custom movement. System definitions are read-only; Customize copy gives a new user-owned ID and fully editable definition.

## Future authorization and public sharing

The prototype has one mock identity, `local-demo-user`. Ownership fields and local guards are design boundaries, not security. localStorage is accessible to anyone using the browser profile. A real server must derive user ID from authenticated credentials, never from a submitted ownerId. Enforce ownership on every private session/set read and write, including history queries; users may edit only their custom exercises/templates. System exercise writes require administrator privileges. Foreign records and forged set references are rejected by local persistence validation.

Template visibility supports future private/public templates. All current templates remain local and private. Export for sharing produces an allowlisted DTO containing template title/training type, prescriptions and inline exercise definitions, with no owner IDs, sessions, actual logs, workout notes or performance history. Exercise names/tags/coaching notes are intentionally included and should be reviewed by the user before sharing. Future public endpoints must serve only this safe representation; public template visibility must never authorize access to its author's private sessions. Importing shared definitions will need attribution and ID remapping/ownership validation before multi-user sharing is implemented.

Codespaces forwarding remains configured in next.config.ts using explicit development origins. No remote fonts or assets are needed.

## Unilateral invariants

A unilateral set group contains exactly one L and one R record sharing groupId. A bilateral group contains one both record. Pairing validation uses each session entry's frozen mode, never its current library definition. Group IDs are stable through edits, row reordering, history snapshots and persistence. Display numbers are derived from ordered groups and may renumber after removal; they are not relational keys. Grouping scopes IDs by session/session-entry, so comparisons cannot merge sides from separate workouts or exercise occurrences.

Complete means both L and R are done. A single completed side remains partial. Session totals, card counters and summaries count paired groups once; volume sums kg × reps for every completed side. Finishing with only one side is permitted and preserves the whole pair with independent completion flags, including the unfinished side's entered values.

Same weight is an entry-level editing shortcut, not a data equality constraint. Only a load edit copies to the other side of that group; all other fields remain independent. Loading history or enabling the shortcut never rewrites unequal values. Adding pairs copies the last group's corresponding side without coercing its values. Actual group addition/removal never changes template or session prescriptions.

Side analytics include completed-side totals and average recorded RPE/load. The matched-pair volume difference is Right − Left and excludes partial pairs; full side totals retain partial contributions. These are descriptive logging metrics. History renders both completed and unfinished sides and preserves original names, modes and metadata. Switching a library exercise to bilateral affects future additions/sessions, with no rewrite of current or historical snapshots and no creation of side-specific exercise records.

## Unified application and nutrition milestone

`app/page.tsx` retains the existing workout state, timer, logger and migration flow. It adds a shared header and five-section responsive navigation, central nutrition state, independent restore/persistence warnings and section URLs (`?section=workouts`, etc.). Home is the default. The timer remains mounted across section navigation. Session footers sit above the main navigation, with safe-area spacing and enough page padding for small screens. Next's dev badge is disabled because it otherwise covers the Home touch target.

`app/components/overview.tsx` implements Home, read-only WorkoutArchive, Progress and Settings. Progress uses accessible labeled bars and semantic tables, with historical exercise classifications frozen in session snapshots. `app/components/nutrition.tsx` implements the diary, food picker, portion logger, custom-food editor and recipe builder. Search, favorite/recent/preparation filters and gram input make frequent food logging short. Editors use explicit Save/Cancel and positive gram/yield constraints.

### Nutrition entities and calculations

`lib/nutrition.ts` exports Zod schemas, TypeScript models and guarded mutations:

- User: mock ID, display name, preferred weight units and IANA time zone. Production authentication remains absent.
- NutritionGoals: stable ID, owner and daily calories/protein/carbs/fat.
- Food: stable system ID or custom UUID, nullable system owner/custom user owner, name, preparation state, per-100-g nutrients and optional source.
- Recipe: owned UUID, name, finished grams, updated timestamp, stable ingredient IDs with food reference, weighed grams and frozen food snapshot. Existing ingredients preserve their saved definitions when editing; removing/re-adding an ingredient deliberately captures its current food definition.
- DiaryEntry: owned UUID, calendar date, meal, source type/ID, grams, creation time and frozen name/preparation/per-100-g nutrient snapshot. Editing grams/date/meal keeps the original snapshot; deletion affects only that diary entry.
- NutritionStore: version 1, user, goals, foods, recipes, diary and favorite food IDs.

Portion nutrients = per-100-g values × grams / 100. Recipe totals sum each ingredient's scaled snapshot. Recipe per-100-g = totals × 100 / positive finished yield. New recipe portions snapshot that value. Food/recipe renaming or nutrition/yield changes never reprice existing diary entries or saved recipe ingredient definitions. Values are not rounded until display. Calories are stored independently of macros; only goals show informational macro-derived calories.

Nutrition persists in `form-nutrition-v1`, independently of `form-tracker-v3`. Validation rejects foreign owners, duplicate entity/ingredient/favorite IDs, forged/missing references, invalid dates, nonfinite/negative nutrition and nonpositive grams/yields. Invalid source stores remain untouched and temporary usage shows a warning. Favorites and recent foods are private user state. Mutation guards and browser persistence are architectural boundaries, not security; future servers must derive owners from authentication and authorize every record read/write.

`replaceInSession` uses a new session-entry/set identity, preserves the old position/planned set count and preloads the replacement's corresponding history. UI confirmation protects already completed current sets. Templates and archived sessions remain untouched. Template replacement updates only a draft reference until Save template.

Seven-day nutrition analytics include empty days as zero logged intake and use the current goal marker, not a historical goal snapshot. Training reports include clearly labeled seeded sessions and use completed-side volume, with paired groups counted once. The existing privacy-safe template export remains an allowlist; no nutrition state is included.

No dependencies were added. Production builds use bundled Webpack due restricted Turbopack CSS worker ports; domain tests disable subprocess isolation to execute all cases reliably in the agent environment.

## Hydration and browser extensions

RootLayout uses suppressHydrationWarning on body only because extensions may add data-new-gr-c-s-check-loaded, data-gr-ext-installed or cz-shortcut-listen before React hydrates. The layout has no dynamic body attributes of its own. The suppression is shallow: application descendants keep their hydration diagnostics. Extension attributes are left intact; no global console filtering, DOM cleanup or client-only layout workaround is used. tests/hydration.spec.ts reproduces pre-hydration extension injection with an init-script MutationObserver, captures browser console/runtime errors, and verifies food logging and refresh persistence.

## Audit corrections and persistence concurrency

`lib/persistence.ts` validates candidate snapshots and compares the currently stored raw value with the last value this tab loaded/wrote. A stale write throws PersistenceConflict. `app/hooks/use-snapshot-persistence.ts` runs the comparison and write inside a named navigator.locks request on supporting browsers. It cancels superseded queued writes and listens for storage events. Divergent writes or storage failures pause saving, retain in-memory edits, preserve the newer/last successful stored value and show recovery controls. A user can download both in-memory stores as private JSON before explicitly confirming reload. No keys were renamed, deleted or reseeded for existing users. Invalid original stores continue to be retained.

This is conflict protection, not synchronization or automatic merging. Browsers without Web Locks use a best-effort optimistic check and storage events; transactional multi-device guarantees still require a backend. The private backup is a recovery export, not a completed import/merge workflow.

The main section, workout subview and selected archived session use query parameters with native pushState/popstate. The FORM mark uses an explicit Home action. Recent-session rows open their own archived session, which also survives refresh. Nutrition sub-tabs, date selection, drafts and filters remain transient. Actual diary records stay keyed by date and stable ID.

Diary date changes dismiss stale editors rather than leave an old portion date under a different daily summary. Recipe ingredient creation fields are optional to the outer recipe save; clearing the next-ingredient grams cannot invalidate already-added ingredients. Snapshot nutrition is still frozen when foods/recipes change. Consumed/remaining calories use the same display precision.

plannedReps in lib/models.ts bounds generated actual reps while leaving prescribed text untouched; both entry creation and pair addition use it. Session timestamps are validated before history rendering. historyFor accepts the preferred time zone; all history surfaces forward it. Inline previous results label unfinished sides, and the modal no longer calls the first arbitrary row a working-load progression.

The shared tests/fixtures.ts captures browser console errors and page exceptions. ESLint ignores Playwright artifacts so concurrently generated/deleted test-results do not break lint traversal. See docs/audit.md for verified coverage, reproduction evidence and outstanding boundaries.

## Proposed backend boundary

The local architecture above remains implemented. A separate [backend proposal](backend-architecture.md) defines Cognito, one versioned HTTP API, Python domain Lambdas, four DynamoDB tables, immutable history generations, conditional/idempotent writes and opt-in migration retaining all browser originals. It awaits approval; no cloud adapter, backend or infrastructure has been implemented.

## Backend design revision

The [proposal](backend-architecture.md) now requires refresh-persistent login and a private invitation-only first release. It compares BFF storage/placement options, recommends server-held Cognito tokens plus an opaque HttpOnly cookie, and adds targeted exercise-performance collections plus dated muscle-summary queries. Four tables remain provisional pending measured access-pattern tests. The existing local application is unchanged.

## Milestone 0 local backend implementation

backend/form_backend separates Pydantic DTOs/calculations, a trusted Principal boundary, four repository protocols and memory adapters, atomic mutation receipts/revisions, domain services, an in-process versioned API dispatcher, generated OpenAPI and fake session coordination. This is independent of the Next.js runtime and introduces no frontend data-path change. Memory aggregates preserve immutable completed/recipe versions; future DynamoDB adapters must decompose workouts into the designed generation/set rows, not serialize an arbitrarily large workout as one item. Durable transactions, staging, real JWT verification and distributed session leases are not implemented by Python locks.

The approved BFF target is API Gateway HTTP API/Python Lambda in us-east-1, invitation-only, with a configurable seven-day maximum app session. The fake supports isolated tests only; backend/README.md documents installation, exact scope and remaining cloud/security work. Existing browser migrations/keys and the raw recovery path remain intact.

## Milestone 1 AWS adapter layer

`backend/form_backend/aws/` adds production entrypoints and locally tested database,
Cognito, session, pagination and import-staging adapters. Python strict schemas and domain
operations remain the shared contract. `infra/` contains offline infrastructure
definitions; it does not authorize deployment. `lib/cloud-client.ts` is an opt-in
transport, and local browser persistence remains the default. `npm run build:static`
adds a static export mode. See [backend architecture](backend-architecture.md),
[Milestone 1.2](milestone-1.2.md) and the
[sanitized AWS status](aws-public-status.md).

## Cloud deployment status

The local cloud-mode frontend and infrastructure definitions are not production
authorization or proof of live backend behavior. AWS account-specific deployment and
recovery artifacts are intentionally excluded from this public repository. See the
[sanitized AWS status summary](aws-public-status.md).

Authenticated cloud reads pass from `CloudClient` (`/api/v1/...`) through the BFF to
`/v1/...` on the domain API. BFF GET forwarding has no request body: the parser's
synthetic `{}` default is only for local validation. Mutation payloads and query
parameters are preserved. A gateway response without FORM's `error.code` is displayed
as `REQUEST_FAILED`; that fallback alone does not identify a storage failure.
