# Safe local-to-cloud migration proposal

**Milestone 1.2 boundary:** selecting/signing into cloud mode does not run a migration,
read prototype keys, clear them or submit their records. The cloud browser workflow verifies
unchanged original storage bytes after logging/completion/refresh. Cloud recovery downloads
contain pending account-scoped memory and are user initiated; they are not a published
import protocol. The existing explicit claim/preflight/staging design remains independently
gated. No real-user export or AWS migration was run.

Status: read-only local preflight and synthetic migration tests are implemented in backend/form_backend/migration.py. No importer, storage rewrite or upload has run. Migration is an explicit, account-bound, resumable **copy**, not a destructive conversion. Existing local mode remains available throughout development.

## Sources and invariants

Read `form-tracker-v3`, `form-tracker-v2`, `form-workout-v1` and independent `form-nutrition-v1` if present; retain every original key and exact raw value. The existing recovery export `{exportVersion:1, workouts, nutrition}` is a second supported source after validation, not a file to upload automatically. Prefer the highest valid workout version as the active candidate, while reporting divergent older keys as separate recovery candidates. Do not blindly merge all generations and duplicate the same workout. Run existing v1/v2 normalization logic on a detached copy, never write normalized results over originals.

Preserve exercise/template/session/set/food/recipe/diary IDs, ordered entries/groups, original dates/instants, kg, per-side reps/RPE/status, mock flags, source preparation and historical nutrient snapshots. Never infer session entry uniqueness globally; sample histories reuse exercise IDs as entry IDs. Keep `(sessionId, entryId, groupId, side)` context. Never re-pair modern sets by row position, copy a missing side's actuals from its partner, recalculate old diary from a new food, or assign a changed template/exercise definition to an old session.

Legacy owner `local-demo-user` is not an authenticated identity. The user must explicitly claim “copy these local records into this signed-in account.” Server destination owner is always the verified subject. An account's imported nested references may resolve only to that same account or the approved Catalog. A source may contain stale/mock owner IDs for historical provenance; these never grant access to someone else's private data.

## Proposed user journey

1. **Detect without changing:** show which local stores/export are available, schema versions, counts, approximate sizes and validation warnings. Do not render legacy records automatically in a different signed-in user's cloud view.
2. **Backup:** offer a user-initiated download of the exact raw sources plus a manifest of schema/key/digest/time. Preserve invalid originals too. Warn that this file contains private history; it is not a public template export. No automatic email or third-party upload.
3. **Select account/source:** display the destination account identity, choose local source(s), mock-data handling and import-vs-create-empty. Make shared-device ownership explicit. No default adoption into every subsequent account.
4. **Dry run:** normalize detached copies, validate complete graphs and show accepted/rejected/conflicting objects and planned mappings. Nothing is published in cloud domain APIs yet.
5. **Review:** show the exact destination, profile/goals choices, date interpretation, ambiguous samples and conflicts. User approval binds the source and normalized manifest digests, not an editable later payload.
6. **Copy/resume:** submit bounded chunks with persisted job/key/digest state. Display verified progress; retry/resume against the same job after network loss or reauthentication as the same subject.
7. **Reconcile:** server re-reads durable data, validates referential integrity and compares canonical manifests, sets/side values, total training volume and per-day nutrients. Show a receipt of imported/skipped/blocked counts and unresolved issues.
8. **Choose cloud mode:** only after reconciliation mark this source imported into this account. Retain browser originals and backup permanently until the user chooses an independent local cleanup action in a later feature. Do not silently switch to local mode after a cloud failure.

A normal refresh restores the BFF session and resumes an account-bound job without requiring sign-in. A genuinely expired/revoked/changed account cannot resume the job under a new subject. Sign out suspends pending work; the job ID is owner-bound and foreign GET/PUT returns 404. In-memory source data and private cache are cleared from signed-out views; legacy storage itself is not deleted.

## Mapping, collisions and historical nuances

| Case                                                                       | Rule                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New user / unchanged stable ID                                             | Preserve external ID. Physical keys prepend authenticated owner; the same legacy ID in A and B is safe and separate                                                            |
| Same account + same source/digest reimport                                 | Reuse durable mapping/creation digest and return existing result; do not duplicate records                                                                                     |
| Same ID but different existing cloud content                               | Stop that aggregate; show conflict. Choose skip, retain both with a new mapped destination ID, or explicit later revision/correction. No import overwrite                      |
| Known system ID with identical catalog definition                          | Retain reference to that approved ID/revision; keep original historical snapshot anyway                                                                                        |
| System ID with modified/unknown/mismatching definition                     | Retain imported snapshot/provenance; if needed create a private imported definition and mapping. Never mutate Catalog or silently adopt current nutrients                      |
| Current session and history share ID and equal finished content            | One logical session and completed generation, current pointer as appropriate; no second workout                                                                                |
| Current session shares ID with history but has unfinished/corrected values | Preserve historical completed generation plus a separate draft generation under the same stable session ID                                                                     |
| Multiple differing finished copies of same session ID                      | Report/import as explicitly ordered historical versions, or retain both via a reviewed mapping if chronology is unknowable; never select one by array order alone              |
| Missing referenced definition                                              | Use a valid frozen session/ingredient snapshot to create a private archived definition if approved; otherwise block reference-dependent aggregate; keep raw source recoverable |
| Malformed side shape / duplicate IDs / invalid timestamp                   | Quarantine with field paths/reasons; do not invent a partner or overwrite a good server record                                                                                 |
| Identifier exceeds new API encoding limits                                 | Deterministic reversible import alias and provenance; show mapping; never silently lose original identity                                                                      |

Mapping identities include source dataset/type/scope, not just a bare ID. Session entries are scoped by session; group IDs by entry; set IDs retain their original explicit association. A canonical digest excludes obsolete ownership fields only for destination equivalence checking, while raw-source digests/provenance retain them. Canonicalization sorts object keys, retains array order and decimal values, normalizes timestamp representations deliberately and versions the digest algorithm. Store both source and destination digests; do not expect raw JSON and normalized database JSON to hash identically.

Unilateral historical mode comes from its frozen session exercise, not current library mode. Preserve independent sides and incomplete pairs. Only `done` sides contribute volume; pair counts require both. RPE `""` becomes null without inventing a value. Existing `started` epoch milliseconds become a UTC timestamp; preserve the original numeric value in provenance. Offset completion times normalize to UTC with original offset preserved. Diary dates remain literal local dates, not UTC conversions.

Food/ingredient/diary snapshots preserve their original per100g numbers even when source definitions disagree. Legacy recipes become immutable version 1 using their **saved ingredient snapshots and saved finished yield**. Imported diary snapshots need not match that reconstructed recipe version: an older logged version may no longer exist locally. Mark source revision/version unknown and preserve the original snapshot instead of fabricating a match. Do not recompute stored snapshots using Python rounding or enforce macro-derived calories.

A template's public flag is imported as private sharing intent only; no hosted publication. Template/session edits remain separate. Profile/preferences require an explicit choice if cloud values already exist. Import known current goals with an effective date approved by the user (default import day); earlier targets remain unknown, since the local app has no goal history. Do not apply today's target retrospectively as historical fact.

### Mock data

Workout `mock` flags survive, and real analytics exclude them by default. Seed system foods are mock nutrition definitions and need truthful provenance until replaced by verified values. Local seeded nutrition diary entries have **no reliable mock flag**. Do not classify a user's entries by matching calories, IDs or seed-looking names alone. Show that ambiguity and let the user exclude examples or import with an `unverified-local` provenance label. The raw backup retains everything, including excluded examples. An “exclude mock” choice never deletes source data.

## Import protocol and transactions

Use [restricted import endpoints](api-contracts.md) and Accounts job/mapping items. The server independently validates the manifest, per-object limits, dates, IDs, ownership references and side structure. Client checks are not authority. No ordinary create endpoint accepts arbitrary historical snapshots. Import payloads are private and must never enter log messages or metrics labels.

Each chunk transaction includes staged rows, accepted chunk digest/progress and a receipt within DynamoDB limits. Repeated sequence+digest replays success; changed content or a gap is rejected. Every ID is reserved/mapped conditionally. Objects larger than a single request are fragmented according to an explicit manifest and only assembled/published after complete validation. Oversized individual definitions that cannot fit the final item are reported as blocked with a lossless source export; do not falsely report full migration. Session generations naturally span many set/entry items and need not fit one transaction.

After all dependencies for an aggregate are verified, conditionally publish its root pointer/head and record completion. **The whole account import is not one atomic transaction.** Imported completed sessions must stage/validate their exercise-performance projections and root muscle summaries before publication, just like newly completed workouts. An interrupted import cannot leave a published workout missing these access paths.

A paused job may have some verified exercises/recipes/sessions/days published and other aggregates pending; progress reports that truthfully. No partially copied session or recipe becomes readable. Diary batches publish atomic entries plus locators/day revisions; a daily dataset can be partially imported while job status is pending, so the UI displays an import-in-progress banner and withholds an “all totals reconciled” assertion until verification finishes.

Do not replay old cloud state over newer edits. Once an imported aggregate is published and modified, rollback must not delete it automatically. Prefer resume/repair; an optional rollback requires a preview, per-item import provenance and unchanged-revision conditions, and otherwise reports conflicts. Sources remain untouched regardless. Abandoned staging cleanup uses job state/lease and publication checks; never set history TTL or delete based only on age. Mapping/manifest receipts outlive short HTTP idempotency TTL so a retry months later still identifies imported entities.

## Verification required before release

Tests use isolated synthetic browser contexts and a separately authorized test backend; never reset a real user's localStorage.

- Round-trip v1/v2/v3 workouts and nutrition v1; malformed/unknown schemas retained with warnings. Current+history same-ID cases and composite entry identities are explicit fixtures.
- Snapshot mismatch fixtures: food renamed/changed since logging, recipe yield changed, recipe ingredient retaining older food, unilateral→bilateral library change, partial L/R and unequal kg/RPE. Assert exact preserved values and IDs/mappings.
- Duplicate import, lost responses, changed chunk, expired token, wrong account resume, copy crash before publication, crash after publication, transaction contention and conflict with newly edited cloud data; refresh/restart while the app session is valid, plus logout/expiry/account switching. Verify imported sessions appear in exercise/date/muscle query fixtures without changing source snapshots.
- Compare normalized counts and sorted IDs/refs, per-side status/reps/load/RPE, completed group counts, volume and per-day unrounded nutrients; tolerate only documented numeric representation differences, never silent rounding.
- Read every imported aggregate back with a fresh browser/device and verify A/B authorization. Confirm original local key values/digests unchanged before/after successful, failed and cancelled runs.
- Rehearse selective repair and restore without resurrecting deleted accounts. No automatic source deletion after success.

These are release requirements, not completed migration tests. A source with blocked records cannot be labeled fully migrated.

## Executed local preflight evidence

The Milestone 0 planner validates the current v3-workout/v1-nutrition recovery export, legacy owners/references/side groups, uniqueness, dates/yields and schema bounds. Tests check exact raw-byte retention, deterministic digests/account-bound mappings, collisions, shared current/history IDs, unequal/partial sides, changed definitions and TypeScript calculation parity. Invalid or unsupported sources return a blocked plan, never a claimed migration. Older v1/v2 workout sources require the existing frontend detached normalization; no replacement migrator or upload/commit path was introduced. Durable manifests/chunks, aliasing of exceptional IDs, actual DynamoDB write/reconciliation and browser recovery UI remain future work.

## Milestone 1 preparation implementation

`aws/import_staging.py` adds unexposed preparation and owner-scoped staging, tested only
with synthetic exports in Moto/DynamoDB Local. Preparation preserves raw byte chunks,
source/manifest digests, stable IDs, current/history roles, exact ingredient and diary
snapshots, unknown historical source revisions, completion/mock flags and structured
L/R records. The prototype's one saved recipe becomes an explicitly identified version;
missing older recipe versions are not fabricated. Goal effective date must be supplied
explicitly. Original browser keys/files are never read or deleted by this component.

Staging verifies repeat chunk hashes, rejects changed chunks, and reconstructs original
bytes and normalized records for reconciliation. Staged data is outside normal entity
queries and marked STAGED_ONLY; it is never reported migrated. There is no deployed
import role, public route, automatic local claim, destination overwrite or publication
worker. Production collision/resume/publication/read-back and source retention remain
separate Milestone 3 work and require explicit user consent. See the deployment checklist.
