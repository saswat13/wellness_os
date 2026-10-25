# FORM API contracts — proposed v1

**Milestone 1.2 update:** the generated OpenAPI also includes owned, paginated
`GET /v1/workouts/sessions/active`, conditional/idempotent
`PUT /v1/workouts/sessions/{id}/draft` and optional profile `favoriteFoodIds`.
Draft writes preserve server-owned exercise snapshots and stable side identities; completed
roots must first be explicitly reopened. The generated TypeScript client connects the
existing UI through `/api/v1/*`; `/auth/session`, login/callback/logout are separate BFF
interfaces. [Implementation and limits](milestone-1.2.md). Older proposal sections below
are not a claim that every proposed endpoint exists; the executed OpenAPI is authoritative.

Status: local domain contracts/models/dispatcher are implemented in backend/form_backend; [generated OpenAPI](../backend/contracts/openapi-v1.json) is authoritative for the implemented subset. Browser BFF HTTP routes, real Cognito and the broader proposed endpoints below remain future adapters/features. Browser requests use same-origin `/auth/*` and `/bff/v1/*`; the BFF calls a future regional HTTPS API with one downstream `/v1` prefix shared by workouts/nutrition. Cognito handles credentials/invitations/token issuance; FORM has no password or public-registration endpoint.

## Milestone 0 implementation boundary

The in-process dispatcher implements the routes in OpenAPI, strict DTOs and memory transactions, not an HTTP listener or Lambda handler. Proposed filters/search/favorites/export/import jobs, paginated generation detail, full analytics and hosted auth routes are not claimed implemented. Existing frontend behavior remains local and unchanged. Fake-session tests do not certify real Cognito or browser cookie security; see [setup/limits](../backend/README.md).

## Browser session contract

Persistent login across refresh/restart is required. Proposed same-origin BFF routes:

| Method/path               | Contract                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /auth/login           | Start server-held, one-use state/nonce/PKCE transaction bound to a temporary HttpOnly cookie; redirect to Cognito managed login; no public sign-up                               |
| GET /auth/callback        | Validate state/login-cookie/nonce, exchange code server-side, validate tokens, rotate opaque session cookie; redirect only to approved relative path                             |
| GET /auth/session         | Restore current server session after reload; safe subject/profile/session metadata and CSRF token only, no bearer credentials; 401 only for absent/expired/revoked session       |
| POST /auth/logout         | Exact Origin + CSRF validation; revoke server session/refresh, clear cookies, no-store                                                                                           |
| /bff/v1/{allowlistedPath} | Proxy allowed downstream methods/paths with server-held access JWT; session on every request and Origin/CSRF on mutations; never forward browser Authorization or arbitrary URLs |

Cookie is persistent Secure/HttpOnly/SameSite=Lax, host-only, Path=/ and opaque; configurable seven-day maximum, with idle expiry capped by that maximum. Refresh-token rotation is serialized server-side. Token expiry is handled transparently while the app session remains valid; upstream refresh outage returns 503 with pending drafts retained, not a false 401/log-out. Browser mutations include `X-CSRF-Token`, If-Match and Idempotency-Key; token values never go into JavaScript storage or responses. The downstream API retains JWT authorization independently. No server-side invitation endpoint is available to ordinary users; pool-level self-registration is disabled. See [session security](authentication-security.md#cognito-and-persistent-browser-session).

## Common contract

- Downstream private `/v1` routes require `Authorization: Bearer <access_token>` and `form/read` or `form/write` custom scope as appropriate. Owner is derived from verified claims. No `/users/{ownerId}` private API. Reject supplied `ownerId`, `ownerSub`, `userId`, keys, revisions masquerading as data and unknown fields in ordinary writes; profile read may return the caller's subject.
- JSON UTF-8, `schemaVersion: 1` in resource DTOs; IDs never derive from names. New client-generated UUID IDs support retries, while imports retain legacy IDs/mappings. Nested entry/group/set IDs remain stable and explicitly scoped. Server resolves every reference under caller ownership or the read-only Catalog.
- Entity response: `{ "data": <DTO>, "meta": { "requestId": "...", "revision": 7 } }`, with strong `ETag: "7"`. Collection response: `{ "items": [...], "nextCursor": null, "meta": { "requestId": "..." } }`. An operation response may be `202` with an operation ID and `Location`.
- Creates require `Idempotency-Key` (UUID). All mutations, including DELETE/actions, require it. Updates/deletes/actions on existing entities additionally require `If-Match: "<revision>"`. For sets, entries and completion this is the **session root revision**, not a separate side revision. Missing precondition: 428; stale: 412. A not-yet-created singleton goal/current-session head has revision 0 and requires an explicit create-if-absent condition for an expected zero; ordinary entity PATCH never upserts. No last-write-wins or silent upserts.
- Idempotency is scoped to `(sub, method, canonical path, key)` and the hash of canonical validated body plus expected revision. Check an existing receipt **before** rechecking a now-stale If-Match: a successful retry returns its original result. Changed payload/precondition with same key: 409 `IDEMPOTENCY_KEY_REUSED`. Commit receipt and mutation together. Retain receipts ≥7 days; clients persist pending keys and do not retry expired uncertain creates with new IDs automatically.
- A retry after receipt expiry still cannot duplicate an existing ID; return 409 `ID_EXISTS` (or the existing authorized resource if its original creation digest matches). DELETE tombstones prevent resurrecting diary IDs. Successful creates return 201 + Location; updates/actions 200; deletion 204. Retry response may identify `Idempotency-Replayed: true`.
- Dates are real `YYYY-MM-DD` local calendar dates, independent of UTC instant. Timestamps use RFC3339 UTC with milliseconds (`...000Z`); accept offset input and normalize. Store selected IANA time zone and original offset/time-zone provenance for workout/import interpretation. Future preference changes must not move diary days. Workout date filters use the supplied/default profile zone; return the zone used.
- Canonical stored load is kg, food/yield mass grams, energy kcal and nutrients grams. UI kg/lb preference changes display, not stored loads; convert lb using exact `0.45359237 kg/lb`. No inferred raw↔cooked conversion. API decimal numbers retain available precision; never round persisted calculations to display precision. Reject NaN/infinity, malformed dates, negative quantities and out-of-range values. Missing RPE becomes `null` (legacy `""` maps to null); initial RPE accepts integers 5–10 to match the UI, not an unannounced new scale.
- Page `limit` defaults 25, max 100. Opaque HMAC-authenticated cursors contain version/kid, caller subject, route/filter/order hash, last key and expiry (15 minutes); bind to subject and reconstruct tenant keys server-side. Tampered, expired or mismatched cursors return 400 without disclosing keys. A cursor is not authorization. Never claim snapshot pagination over a mutable list; collection membership can change. Draft and diary multi-page snapshots bind parent/day revision and return 409 `COLLECTION_CHANGED` if it changes.
- Request bodies ≤256 KiB; batch side edits ≤20 rows/request; write transactions are split using staged operations where necessary, never partially applied as one claimed atomic action. Recipe ≤100 ingredients; existing name/tag/note/range limits match local Zod schemas. A session's total rows may exceed one page/transaction: manifests/pagination preserve them. Larger valid legacy definitions require a recoverable import plan, not truncation.
- No raw request-body/JWT logging. All private responses `Cache-Control: no-store`; return request ID on success and error. Retry 429/503/504 with bounded exponential backoff/jitter and the same idempotency key; don't automatically retry validation or revision conflicts. API Gateway-generated failures may have its standard body; the frontend normalizes them using status/request ID rather than assuming every platform failure is the custom envelope.

## Accounts and operations

| Method/path                               | Contract                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET /v1/me                                | Profile/preferences/account state; 404 `PROFILE_NOT_INITIALIZED` on first login; never returns local data automatically |
| POST /v1/me                               | Explicit create-empty/bootstrap after import choice; conditional create; body name/unit/timeZone only                   |
| PATCH /v1/me                              | Update allowlisted name/unit/timeZone; If-Match; changing zone does not rewrite records                                 |
| GET /v1/{domain}/operations/{id}          | Own operation progress/counts/conflicts; foreign/missing IDs both 404                                                   |
| POST /v1/{domain}/operations/{id}/advance | Bounded resumable copy/validation/publication step; idempotency and operation If-Match                                  |

Here `{domain}` is exactly `workouts` or `nutrition`; routes target that domain function and its own operation records, never an arbitrary table. Import jobs have their dedicated `/v1/imports` routes.

A pending import can initialize profile from confirmed local preferences without first writing default preferences over them. Disabled/closing accounts cannot make writes; account lifecycle actions themselves require a separate authenticated privacy flow before public launch.

## Workout domain

All paths below are prefixed `/v1/workouts`.

| Method/path                                                | Contract                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET /exercises                                             | Paginated merged system/owned exercise library; filters source/archived/muscle/equipment/pattern/tag/trainingType; client search over loaded pages, no promise of global full-text ranking |
| POST /exercises                                            | Name-only sufficient; optional metadata/tags/unilateral; source forced custom, owner server-set                                                                                            |
| GET, PATCH /exercises/{id}                                 | Read definition; edit own custom only; system writes 403; revision guard                                                                                                                   |
| POST /exercises/{id}/archive, /restore                     | Own custom lifecycle; references/history retained; no hard delete                                                                                                                          |
| GET, POST /templates                                       | Own reusable templates; create with ordered entries and prescriptions                                                                                                                      |
| GET, PATCH /templates/{id}                                 | Definition edits/reordering, strict owned/system exercise references; never saves current session implicitly                                                                               |
| GET /templates/{id}/export                                 | Existing allowlisted plan-only export, excludes owners, history, actual sets and private workout notes                                                                                     |
| GET, PUT /current-session                                  | Read/select own logger session pointer; PUT requires pointer If-Match and target ownership, never deletes another draft                                                                    |
| GET, POST /sessions                                        | List by started range/status/mock filter; start from owned template revision or explicit exercises; client ID; server freezes definitions; 201 or staged 202                               |
| GET /sessions/{id}                                         | Metadata, root revision, draft pointer/latest completed version; default logger view uses draft when present                                                                               |
| GET /sessions/{id}/generations/{generationId}              | Published generation metadata/ordered entry snapshots; caller must own its root; staged generations inaccessible                                                                           |
| GET /sessions/{id}/generations/{generationId}/sets         | Paged side records; generation/entry/group IDs; draft revision cursor; immutable historical page if completed                                                                              |
| PATCH /sessions/{id}                                       | Session-only name/notes/display unit/entry order; cannot alter template                                                                                                                    |
| POST /sessions/{id}/exercises                              | Add owned/catalog exercise with frozen metadata and previous-side prefill                                                                                                                  |
| PATCH, DELETE /sessions/{id}/exercises/{entryId}           | Session-only prescription/preference edit or removal from draft; completed generations immutable                                                                                           |
| POST /sessions/{id}/exercises/{entryId}/groups             | Add entire group: one both row or two explicit side rows with distinct IDs                                                                                                                 |
| DELETE /sessions/{id}/exercises/{entryId}/groups/{groupId} | Remove whole draft group atomically                                                                                                                                                        |
| PATCH /sessions/{id}/sets                                  | Atomic allowlisted side edits; root If-Match; optional explicit paired weight shortcut                                                                                                     |
| POST /sessions/{id}/complete                               | Validate root revision, finalize generation, stage exercise-performance projections, compute muscle summary and publish; 200/202, partial pairs preserved                                  |
| POST /sessions/{id}/reopen                                 | Copy latest completed generation into a new draft; requires explicit action; 201/202; old completed version remains readable                                                               |
| GET /sessions/{id}/versions                                | Completed generation/version list, not multiple logical workouts                                                                                                                           |
| GET /exercises/{id}/history                                | Date-bounded completed sets/snapshots including per-side status/RPE and comparison eligibility                                                                                             |
| GET /analytics                                             | Date-bounded root muscle summaries; bounded detail reads for other facets; completed-side volume; mock excluded by default                                                                 |

The UI's explicit “save as template” creates a template or PATCHes one using **that template's revision** and a plan-only DTO. It never copies actual sets, previous results or workout notes. No endpoint auto-updates a template when a session changes. New/corrected sessions retain original exercise snapshots even if a library exercise's mode/name changes; current drafts may replace an exercise only through an explicit action that creates a new entry identity.

Example independent side edits:

```json
{
  "edits": [
    {
      "entryId": "entry-1",
      "groupId": "group-1",
      "setId": "set-L",
      "side": "L",
      "reps": 11,
      "kg": 22.5,
      "rpe": 8,
      "done": true
    },
    {
      "entryId": "entry-1",
      "groupId": "group-1",
      "setId": "set-R",
      "side": "R",
      "reps": 10,
      "kg": 20,
      "rpe": null,
      "done": false
    }
  ]
}
```

The server validates all supplied identities against the stored side records. Here completedGroups=0 and completed volume=247.5 kg·reps; the unfinished right side contributes zero. A weight shortcut request explicitly identifies the changed side/group and `applyWeightToPair: true`; handler requires saved `sameWeight=true`, expands only kg to its partner and preserves that partner's reps/RPE/done. Updating the preference alone never copies values. History responses retain original side values/status and show whether comparisons are eligible.

Previous-side lookup uses the targeted strong base-table exercise/time collection, not all session roots; it may still need multiple bounded candidate pages for corrections/staging. Return a prefill operation/continuation instead of silently inventing equality or overwriting a side the user has edited while lookup was pending. Apply asynchronous prefill only against the unchanged entry revision/root revision or obtain explicit user confirmation.

## Nutrition domain

All paths below are prefixed `/v1/nutrition`.

| Method/path                                                      | Contract                                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET, POST /foods                                                 | Merged system/owned pages; create name/preparation/per100g/sourceInfo, server-owned custom food                        |
| GET, PATCH /foods/{id}                                           | Revision-guarded custom edit; no diary/recipe snapshot rewrite                                                         |
| POST /foods/{id}/archive, /restore                               | Proposed archive lifecycle; existing local UI lifecycle still needs implementation                                     |
| PUT, DELETE /favorites/{foodId}                                  | Owned favorite pointer; idempotent; source must be accessible                                                          |
| GET, POST /recipes                                               | Own recipe heads; create ingredient refs/grams and positive finishedGrams, immutable v1                                |
| GET, PATCH /recipes/{id}                                         | Read head; edit creates new immutable version, CAS head; explicit ingredient snapshot retention/refresh                |
| GET /recipes/{id}/versions; GET /recipes/{id}/versions/{version} | Own immutable recipe history; version-specific yield/nutrients                                                         |
| POST /recipes/{id}/archive, /restore                             | Proposed non-destructive lifecycle                                                                                     |
| GET /diary?date=YYYY-MM-DD                                       | Entries, calculated totals, effective goals and dayRevision; all day pages read before declaring totals complete       |
| GET /diary?from=...&to=...                                       | Up to 31 days, per-day revisions, explicit continuation; no silent missing pages                                       |
| POST /diary/entries                                              | ID/date/meal/source type+ID+revision-or-version/grams; resolve and freeze authorized source                            |
| GET, PATCH, DELETE /diary/entries/{id}                           | Stable ID lookup; PATCH grams/meal/date only using old nutrient snapshot; move is atomic; deletion leaves ID tombstone |
| GET /goals?date=YYYY-MM-DD                                       | Effective targets/version, or unknown before first known date                                                          |
| PUT /goals                                                       | If-Match current goal head; targets+effectiveFrom; immutable change record and date-effective pointer                  |

Example food entry create:

```json
{
  "id": "dc22fc3c-4be1-4ea8-94ea-68b4a4a41911",
  "date": "2026-10-17",
  "meal": "Lunch",
  "sourceType": "food",
  "sourceId": "rice-dry",
  "sourceRevision": 1,
  "grams": 75.5
}
```

No owner or arbitrary snapshot is accepted. Mock rice at 360 kcal/100 g yields 271.8 kcal; editing to 50 g later still uses that original snapshot. A stale food source revision returns 409 `SOURCE_CHANGED` with a prompt to use the reviewed version/current definition; it never silently switches preparation. Recipes reference an immutable `recipeVersion`. An old diary snapshot may lack an available source; gram/meal/date edits remain valid and never require refreshing its nutrients.

Recipe editing identifies existing ingredient IDs with `retainSnapshot: true`, or supplies food ID/revision for an explicit refresh/new ingredient. A caller cannot inject a full nutrient snapshot on ordinary routes. Recipe totals sum `ingredient.per100g * ingredientGrams / 100`; finished per100g is total *100/finishedGrams; portions multiply by grams/100. Keep independent stated kcal and macros, including the existing discrepancy information; do not force kcal=4P+4C+9F.

Goal changes default to **today in the user's zone** and apply prospectively; do not rewrite prior dates. Same-day changes select the latest version for that local day while retaining every change record. First migration preserves the known current goal without fabricating older values. Backdated goal changes require an explicit date and warning; implementation must make that deliberate. Day totals are actual consumption and do not depend on goal versions.

## Restricted local import API

| Method/path                            | Contract                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| POST /v1/imports                       | Create owner-bound job from source digests/manifest, original schema versions and explicit claim/mock choices; returns mapping/conflict plan |
| PUT /v1/imports/{id}/chunks/{sequence} | Ordered bounded chunks, normalized records and source hashes; repeated identical chunk is safe, changed hash 409                             |
| POST /v1/imports/{id}/validate         | Resumable validation/dry-run result; no published aggregates                                                                                 |
| POST /v1/imports/{id}/commit           | Commit approved manifest digest + current job revision; publish validated aggregates with progress; not an all-database transaction          |
| GET /v1/imports/{id}                   | Own progress, mapping, rejected records and reconciliation summary, no other user's metadata                                                 |

Imports are the only route that accepts historical client snapshots, under explicit import DTOs and server validation. The authenticated subject remains the owner of the destination. Every imported ID/ref is resolved through the job mapping; nested legacy owner IDs are provenance only. See [migration](data-migration.md) for retry/rollback rules.

## Errors and conflicts

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "This workout changed on another device.",
    "requestId": "req-example",
    "details": { "currentRevision": 8 }
  }
}
```

| HTTP            | Codes and behavior                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400             | MALFORMED_JSON, INVALID_CURSOR, UNKNOWN_FIELD; no stack traces                                                                                        |
| 401             | Downstream invalid token or absent/expired/revoked BFF session; BFF refreshes access expiry transparently, retains drafts on genuine reauthentication |
| 403             | INSUFFICIENT_SCOPE, CSRF_FAILED, SYSTEM_RECORD_READ_ONLY, ACCOUNT_DISABLED; no foreign record details                                                 |
| 404             | NOT_FOUND for missing **and foreign private** IDs, including nested resources and operations                                                          |
| 409             | IDEMPOTENCY_KEY_REUSED, ID_EXISTS, SOURCE_CHANGED, COLLECTION_CHANGED, IMPORT_CONFLICT, INVALID_STATE                                                 |
| 412 / 428       | REVISION_CONFLICT / PRECONDITION_REQUIRED; latest revision only disclosed for an owned record                                                         |
| 413 / 422       | PAYLOAD_TOO_LARGE / VALIDATION_FAILED with allowlisted field paths and reason, not submitted private values                                           |
| 429             | RATE_LIMITED, Retry-After when known; clients back off                                                                                                |
| 500 / 503 / 504 | Sanitized internal failure or transient unavailability/timeout; uncertain write retried with same key                                                 |

On 412, fetch the latest owned entity and offer reload/compare/reapply; retain the user's draft and original mutation. Do not automatically replay a conflicting snapshot over a newer revision. Independent side updates conflict at the session root initially; a deliberate resolution can reapply only the changed fields with a new key and current revision.

## Milestone 1 adapters

The same executed route/model registry now backs Python HTTP API v2 domain handlers;
`backend/contracts/openapi-v1.json` is regenerated after descriptive/type updates.
Browser traffic uses same-origin `/api/v1/...`; the BFF supplies its server-held access
JWT to downstream `/v1/...`. `/auth/login`, `/auth/callback`, `/auth/session` and
POST `/auth/logout` implement the cookie flow; they never return token bundles.
`/auth/session` exposes only subject, CSRF token and absolute expiry. Mutations require
exact Origin and X-CSRF-Token in addition to domain Idempotency-Key/If-Match rules.

Native DynamoDB pages are bounded by limit/LastEvaluatedKey and signed against tenant,
query, collection revision and expiry. A short/empty page can still have nextCursor;
clients must follow the cursor, not infer completion from item count. Exercise/food
custom rows precede the system catalog phase. Invalid, cross-user and stale cursors
fail with 400/409 rather than being treated as new list requests. AWS GSI membership
remains eventually consistent; strong ID reads are authoritative.

All private/auth responses are no-store; private proxy responses include the verified
X-Form-Subject boundary for account-switch guards. Retryable storage/provider failures
use sanitized 503 and Retry-After; retry mutations with the original idempotency key.
Oversized records/transactions return 413 with no partial publication. There is no
production import, public sharing or active-session-discovery route in this milestone.
