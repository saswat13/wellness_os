# Fitness & Nutrition Tracker requirements

## Product vision

Mobile-first multi-user tracking for hypertrophy, powerlifting, HYROX/running and gram-based nutrition. Future scope includes public registration, server-enforced private histories, reusable templates and performance analytics.

## Current milestone

Milestone 1.2 connects the existing Next.js / TypeScript / Tailwind interface to the typed
same-origin APIs. Implementation and offline tests only; no AWS resources, IAM changes or
deployment. The independent local prototype remains the default. [Current scope and
limits](milestone-1.2.md) supersede the initial milestone description below.

- Explicit local/cloud selection; no implicit local import or deletion.
- Persistent cookie-session discovery, account switching and private-state invalidation.
- Cloud discovery failures identify the failed stage or API method/route, HTTP status and
  API error code without exposing query values or credentials; device recovery data remains
  on the device.
- Server-backed workout/exercise/template and nutrition CRUD with CSRF, revisions,
  idempotency, saved/error/retry/conflict states and immutable historical snapshots.
- Owned active-draft discovery, partial L/R saves, resume, completion and history.
- Offline fake-identity integration tests; actual AWS acceptance remains separately gated.
- Recoverable account-scoped pending-write journal before HTTP; refresh/closure recovery,
  original revision/idempotency replay, explicit Saved/Saving/Pending/Failed states,
  single-writer tab lease and safe logout/expiration retention. See [reliability review](pending-write-review.md).

- One scrolling workout with collapsible exercise cards.
- Prescribed sets, rep ranges, coaching notes and external demonstration search links.
- Previous actual results prefill editable logs; completion is always initially unchecked.
- Edit reps/load; add/remove sets; one-tap completion.
- Previous performance inline and three-session dated exercise history with load progression.
- Optional RPE, workout notes and configurable rest timers.
- Immutable planned targets kept separate from actual set logs.
- Left/right entries for unilateral exercises; pair addition/removal.
- Completion summary counts completed entries and load × reps volume.
- Configurable kg/lb with canonical kg storage.
- Browser-local draft persistence. This is not multi-user isolation or cloud history.

## Sample data

Exercises: single-arm cable lat pulldown, seated cable chest flyes, wide-grip seated cable row and incline Smith press. No historical spreadsheet values were supplied in this conversation; all historical sets and dates are illustrative and explicitly labeled mock. Demonstration links open YouTube technique search results rather than claiming a verified coaching video.

## Usability

Large controls, legible spacing, numeric inputs, minimal navigation, no decorative animation, keyboard labels and visible focus states. Optional RPE uses whole-number 5–10 values. Paired unilateral set counts require both sides; each completed side contributes volume; fly load is per handle and Smith load excludes bar mass. Volume is a consistent logging metric, not a biomechanics measure.

## Exercise and template management refinement

- The four original exercises are seed examples, never a fixed exercise list.
- Library includes system exercises and custom exercises owned by the mock user.
- Name-only quick creation; renaming/editing, archiving and restoration of custom exercises.
- System exercise customization creates an independent user-owned copy.
- Stable exercise UUIDs survive renames; session/template entry IDs also distinguish repeated movements.
- Optional primary muscle, secondary muscles, movement pattern, equipment, training types, multiple tags, coaching notes and demonstration URL.
- Search matches names and metadata; filters include primary muscle, equipment, movement pattern, training type, tag, source and archive state.
- Add exercises to the active workout or a template draft.
- Separate Exercise, WorkoutTemplate, WorkoutSession and ExerciseSet models.
- Session-only name/order/target changes never modify reusable templates; template editors save explicitly.
- Create empty templates or copy current prescriptions; edit names/training types, add/remove/reorder movements and change targets; start reusable plans.
- Archive completed session snapshots and show performance history under the stable exercise ID, with the originally logged name and metadata preserved.
- Template-only JSON export supports eventual sharing without exposing private history or workout notes.
- All persistence remains local. One mock owner is implemented; real multi-user authorization and publication remain future work.
- Migrate original saved logs and preserve the original storage key. Invalid stores are not silently overwritten.

## Complete unilateral support

- One stable exercise ID; paired sets contain separate L/R side records sharing a stable group ID.
- One displayed set number with Left and Right rows; independent reps, load, RPE and completion.
- Same weight shortcut enabled by default, persistent per session exercise, affecting weight edits only within a pair.
- Corresponding-side prefill from completed historical groups, preserving asymmetric performance and missing-side position.
- Complete pairs count once; partial pairs are retained and volume includes each completed side.
- Add/remove entire groups; planned targets remain independent of actual groups.
- History retains both sides, unfinished status and RPE. Analytics compare completed-side reps, average load/RPE and volume, with matched-pair differences excluding partial pairs.
- Unilateral/bilateral mode is frozen in session snapshots; changing the library definition applies to future sessions and preserves all prior side records.
- V2 and V1 local data migration retains original keys and side values; malformed pair structures are rejected without overwriting saved data.

## Complete fitness and nutrition website

Extend FORM into a cohesive, fully navigable local prototype. Home is the default entry; the responsive persistent navigation contains Home, Workouts, Nutrition, Progress and Settings. Every displayed action must function. Retain colors, spacing, rounded cards, large targets, existing library/template features and unilateral logging. Single mock user and local-only status must be visible; production accounts and infrastructure remain out of scope.

- Home: today's current workout, open/resume/summary, choose template, completed counts, recent sessions, quick exercise history; calories/macros, Quick Log Food and today's meal overview.
- Workouts: preserve logger; explicit exercise replacement for current sessions and template drafts; complete read-only session archive with historical notes, prescriptions, side records and progression. Session edits do not alter templates or previous sessions.
- Diary: calories consumed/target/remaining, P/C/F versus goals and visual meters; breakfast/lunch/dinner/snacks; date navigation; add/edit/delete gram-based entries; searchable foods/recipes, preparation filter, favorites/recent/custom filters.
- Food definitions: stable ID, system/custom source, owner, name, explicit raw/cooked/dry/packaged state, calories/P/C/F per 100 g and optional source. Custom foods are editable and searchable; seeded nutrition is marked illustrative mock data.
- Recipes: stable owned ID, name, multiple ingredient references/snapshots and grams; automatic whole-recipe totals; positive finished cooked/baked grams; per-100-g finished values; save/edit and log arbitrary weighed portions. Definition edits preserve previously logged values.
- Goals: owned calories/protein/carbs/fat targets, numeric inputs, explicit Save/Cancel, immediate diary/dashboard updates, macro-derived calories (4P + 4C + 9F). Show an informational warning when difference exceeds the larger of 100 kcal or 10% of the calorie target. Zero targets are allowed and meters avoid division by zero.
- Preferences: owned display name, kg/lb and time zone; Today follows that zone. Nutrition logging always uses grams.
- Progress: completed-session volume and counts, reports by frozen primary muscle/equipment/movement/training type, exercise progression and unilateral comparisons; seven-day calories, current goal marker, average logged nutrition and daily macros.
- Persistence: independent workout and nutrition stores, validated ownership/IDs/references. Preserve old workout migrations and invalid stores. Food/recipe diary snapshots keep original per-100-g values even when definitions change. Editing diary grams scales its original snapshot.

Backend authentication/authorization, cross-device sync, hosted sharing, verified food database integration and discipline-specific trackers are deferred. No AWS resources, deployment or IAM changes are permitted.

## Browser-extension compatibility

Tolerate attributes that browser extensions add to the outer body before hydration (for example Grammarly and shortcut listeners). Limit hydration-warning suppression to the body element; retain normal checking for application descendants. Browser-extension compatibility must not reset or rewrite saved workout/nutrition data.

## Functional audit safeguards

- Changing diary dates (arrows, picker or Today) dismisses old portion/edit drafts and never moves saved entries implicitly. Meal/date reassignment is explicit in the entry editor.
- Show consumed and remaining calories with consistent display precision. Unrounded values remain authoritative internally.
- Validate snapshots before persistence. Detect stale tabs, pause writes and offer a private in-memory backup download plus confirmed reload of the latest saved records. Never silently merge or overwrite divergent histories.
- Rep target text may describe ranges or AMRAP; generated actual reps must remain within 0–999. Reject invalid historical session timestamps during restore.
- Browser Back/Forward, FORM home and recent-session shortcuts must restore the corresponding view; workout subviews and selected archived sessions are encoded in the URL.
- Respect the chosen time zone in exercise history as well as session archives. Previous incomplete sides must be labeled incomplete; do not infer progression from an arbitrary first row.
- Wrap long user-created names and tags; use two diary meal columns on wider screens and one column on phones.
- Browser automation must capture console errors and unhandled runtime errors, alongside functional assertions.

## Proposed cloud milestone — awaiting approval

The next design milestone specifies shared Cognito authentication, separate workout/nutrition REST APIs, server-enforced private ownership, safe local import and cross-device access. Its acceptance gate is A saving/retrieving a workout and meal from another device while B cannot access either. See [backend architecture](backend-architecture.md). These are proposed requirements, not implemented functionality; current local stores and UI remain unchanged. No AWS resource or IAM/deployment action is authorized by this design milestone.

## Backend design revisions — persistent login and private pilot

The cloud design must preserve authentication across normal refresh/restart without browser-stored Cognito bearer/refresh tokens. Review the proposed same-origin BFF, opaque HttpOnly cookie, CSRF and server-token refresh strategy before implementation. The first cloud deployment is invitation-only with Cognito self-registration disabled; public enrollment requires separate later approval. Validate the five core date/exercise/diary/recipe/muscle queries against explicit tenant/time/type keys before accepting a table layout. See [revised architecture](backend-architecture.md) and [query plans](database-design.md#five-required-access-patterns). No deployment or code change is authorized by these design revisions.

## Milestone 0 backend foundations

Local Python contracts, owner-scoped repositories, atomic memory mutations, immutable history, calculations, fake-session tests and read-only export preflight are implemented under backend/. The current frontend and browser persistence stay unchanged. Real cloud identity, persistence, import and frontend integration remain unverified; see [backend setup/limits](../backend/README.md) and the [sanitized AWS status](aws-public-status.md).

## Cloud implementation status

Local cloud-mode adapters and infrastructure definitions are present, but they are not
production authorization or proof of live backend behavior. Local persistence remains
separate from cloud-mode data. Account-specific deployment and recovery details are kept
out of this public repository. See the
[sanitized AWS status summary](aws-public-status.md).

## Cloud status

Account-specific deployment evidence is maintained locally and excluded from the public
repository. Local and cloud data modes remain separate; a deployed frontend does not
establish authenticated backend acceptance. See the
[sanitized AWS status summary](aws-public-status.md).

Authenticated BFF GET requests must be forwarded without a payload, including when
an incoming GET supplies a body. Mutation JSON, pagination queries and trusted
server-side authentication must retain their existing behavior.

Cloud account bootstrap must fit bounded backend concurrency. Collection pagination
and all seven diary days must complete without an unbounded request burst; failures
must remain visible and must not discard pending data.
