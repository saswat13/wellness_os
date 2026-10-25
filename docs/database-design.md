# DynamoDB design proposal

## Milestone 1.2 active-session access pattern

Training adds an `ACTIVE#<encoded-session-id>` pointer within `USER#<verified-sub>`.
Only active pointers carry existing GSI1 keys `USER#<verified-sub>#ACTIVE` and
`<started-at>#<encoded-id>`. Owned bounded Query pagination re-reads the canonical root
and checks its active status. Pointer changes participate in the same root-CAS/row/receipt
transaction: completion removes index attributes; reopen restores them. No table Scan,
new index, table or IAM permission is required. GSI visibility is eventual; URL-selected
drafts use direct root reads. Memory and Moto tests cover owner/cursor/complete/reopen
semantics; real lag/capacity remains a controlled-deployment gate.

Status: design plus locally tested Milestone 1 adapters; no AWS resources exist. Read [architecture](backend-architecture.md) and [API contracts](api-contracts.md) together with this document. No tables or indexes have been created.

The table count remains a proposal, subject to the query validation gates below. Four tables preserve independent runtime IAM/operational boundaries without allocating a table per entity. Within each domain, related parent/child records use item collections and composite keys; a session is not one enormous document. This is a deliberate combination of multi-table boundaries and aggregate modeling, based on the identified access patterns rather than a rule that every app needs one table. See [AWS modeling foundations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/data-modeling-foundations.html).

## Key conventions and limits

Four Standard/on-demand tables use string `PK` and `SK`. `u` always means the **verified Cognito sub**. BFF-only opaque credential/session lookup keys are the explicit exception described below, not client-selected ownership keys. `U(u)` denotes `USER#<sub>`. Every identifier component is encoded separately with base64url UTF-8 before concatenation so legacy punctuation cannot inject key delimiters. External IDs remain their original strings; names never become IDs. New IDs are UUIDs; legacy nonempty IDs are preserved through import mappings. Normal API IDs have a 128-byte limit; exceptional legacy IDs require a reversible import alias, retaining the original in provenance.

Every record carries `entityType`, `schemaVersion`, server-owned `ownerSub` for private records, revision and server timestamps as applicable. DynamoDB physical keys are not public DTO fields. Catalog records are system-owned and have no user owner. Numbers use Decimal on the Python/DynamoDB boundary; do not convert imported JSON through binary-float rounding or integer hundredths. API JSON remains compatible with existing numeric inputs; rounding occurs only for display.

DynamoDB items are limited to 400 KiB, queries to 1 MiB per service page, and transactions to 100 distinct items/4 MiB. Application payloads/items target ≤256 KiB, returning explicit errors before platform limits. Query all needed pages; never treat the first page as the whole aggregate. A large local aggregate is staged/chunked or blocked with a recoverable import report; never truncate it. Transactions cannot update and separately condition-check the same item; put conditions directly on that item's update. [AWS transaction limits and isolation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

## Accounts table — no GSI

| PK                         | SK                             | Content and access                                                                                                                                                 |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| U(u)                       | PROFILE                        | Display name, unit preference, IANA time zone, lifecycle/account-disabled state; exact strong Get/conditional update                                               |
| AUTHSESSION#sha256(cookie) | META                           | BFF-only credential lookup: verified subject binding, server token bundle/generation, refresh lease, idle/absolute expiry, revocation; strong Get/CAS, TTL cleanup |
| U(u)                       | AUTHSESSIONREF#sessionHash     | Account-owned session locator for logout-all/deletion; no bearer cookie value; synchronized with session creation/revocation                                       |
| LOGIN#sha256(state)        | META                           | One-use OAuth state/nonce/PKCE verifier, login-cookie binding, allowlisted return path; <=10-minute lifetime, conditional consume                                  |
| U(u)                       | IMPORT#jobId                   | Source digest, normalized manifest digest, account binding, counts, decisions, operation state and revision                                                        |
| U(u)                       | IMPORT#jobId#MAP#type#sourceId | Stable source→destination mapping, digest, verification result; Query by job prefix                                                                                |
| U(u)                       | OP#operationId                 | Import validation/publication progress and lease, accepted ordered chunk digests; exact Get                                                                        |
| U(u)                       | IDEM#requestHash               | Atomic request receipt scoped to method/path/key, payload hash, status/resource/revision; TTL                                                                      |

Profile creation is a lazy, conditional insert on first authenticated bootstrap, not a trigger that can overwrite migrated preferences. A new profile starts with defaults only after the user chooses create-empty or import. Favorites use separate Nutrition items below; Cognito owns credentials; the BFF additionally stores app sessions server-side to support refresh-persistent login. Workouts/Nutrition repository access is PROFILE-only. Planned IAM prefix conditions also deny domain/Import roles the AUTHSESSION#/LOGIN# credential namespaces; allowing USER#* supports existing user records but does not enforce per-user authorization or an SK-level PROFILE boundary. Server key construction still enforces those. Only the BFF may read/write credential records. Only the BFF may resolve an opaque cookie hash; it derives the principal from its validated server binding, never from a cookie-supplied user ID. Enforce expiry/revocation before use; TTL is delayed cleanup, not authorization. Exclude ephemeral token/login records from user exports and review token exposure in retained backups. A restore runbook must invalidate all restored app sessions/login transactions before reopening traffic; old backups must not revive a logged-out session.

## Catalog table — no GSI

| PK            | SK            | Content                                                                                             |
| ------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| TYPE#EXERCISE | ID#exerciseId | System exercise definition, catalog version, optional muscles/pattern/equipment/tags/training types |
| TYPE#FOOD     | ID#foodId     | Explicit preparation, nutrient values per 100 g, source attribution, mock/verified provenance       |
| META          | VERSION       | Seed version, content digest and publication time                                                   |

System IDs such as `pulldown` and `rice-dry` are stable sample identifiers, not validated nutrition authorities. Runtime functions can only Get/Query catalog records. Server deployment tooling alone may version/update the seed. Definition edits never propagate into existing session/ingredient/diary snapshots. A changed catalog definition has a new revision; historical source revision is retained where known. Initial search fetches paginated small catalog + owned definitions and filters client-side; do not use DynamoDB Scan/FilterExpression as a pretend full-text index.

## Training table

| PK                       | SK                                   | Content and access                                                                                                                             |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| U(u)                     | EXERCISE#id                          | Owned custom definition and revision; Query prefix/Get; archive flag                                                                           |
| U(u)                     | TEMPLATE#id                          | Ordered entry IDs, exercise references, prescriptions, revision, sharing intent; Get/Query prefix                                              |
| U(u)                     | SESSION#id                           | Stable session root: current draft generation, latest completed generation/version, revision, original start time, summary; Get                |
| U(u)                     | CURRENT_SESSION                      | Explicit current logger session pointer and revision; strong bootstrap Get, never infer current from GSI ordering                              |
| U(u)                     | SESSIONCOLLECTION                    | Revision incremented on root creation/completed-version publication; strong prefill collection guard                                           |
| U(u)#SESSION#id          | VERSION#zeroPaddedCompletedVersion   | Immutable completed-version → generation pointer and summary; Query version list                                                               |
| U(u)#SESSION#id#GEN#g    | META                                 | Generation state, frozen session name/template reference/training type/start/completion times, unit, notes, mock provenance, ordered entry IDs |
| U(u)#SESSION#id#GEN#g    | ENTRY#entryId                        | Frozen exercise metadata, prescription, unilateral mode, sameWeight preference, ordered group IDs                                              |
| U(u)#SESSION#id#GEN#g    | SET#entryId#groupId#side             | Individual original set ID, exercise/entry/group refs, side, reps, kg, nullable RPE, done                                                      |
| U(u)#EXERCISE#exerciseId | PERFORMANCE#startedAtUTC#sessionId#g | Compact frozen performance projection: generation/version, entry IDs/modes, counts and volume; no full logs/notes; Query one exercise by time  |
| U(u)                     | OP#operationId                       | Training create/copy progress, manifests and lease; exact Get/conditional advance                                                              |
| U(u)                     | IDEM#requestHash                     | Transactional receipt; exact Get, conditional insert, expiry                                                                                   |

The root alone has sparse index attributes `GSI1PK=U(u)#SESSIONS`, `GSI1SK=<original startedAt UTC>#<sessionId>`. **GSI1** projects session ID, start time, root revision, completed-version pointer, draft indicator, mock flag and bounded summary including a per-primary-muscle volume map; it never projects notes/set payloads. Query descending with optional start/end bounds. No LSI or other GSI initially: the exercise-history collection already has the required primary key/time sort order, and adding an identical GSI would duplicate storage/write cost. Roots in staging have no index fields. GSI results are eventually consistent candidates; fetch canonical roots before returning their current completed pointer/summary. A just-finished session may be missing from a list briefly; the write response and exact Get are authoritative.

`entryId` is scoped by session, not globally unique: existing sample history reuses exercise IDs as entry IDs. Side grouping identity is `(owner, sessionId, generation, entryId, groupId)`. Record identity is not inferred from display order. `ENTRY.groupIds` defines order; physical SK order is irrelevant. Duplicate instances of the same exercise in one session have different entry IDs in new data.

### Session lifecycle and atomicity

- Start: freeze template/catalog/custom exercise data in a new draft generation. Root publication occurs only after all expected rows and their manifest have been validated; creating a root also increments SESSIONCOLLECTION atomically. Small sessions fit in one transaction; larger starts use the operation protocol below. Current logger selection is a separate revisioned CURRENT_SESSION pointer; selecting another workout never deletes the previous draft, and starting/reopening only switches that pointer in the final guarded publication transaction.
- Edit: transaction updates the root with `revision=expected AND draftGeneration=g AND state=ACTIVE`, affected draft entry/side rows and receipt. Every mutation bumps the **same root revision**, including notes/reorder. This deliberately favors safe conflicts over automatic cross-device merges. Delete a unilateral group by deleting both side records and updating ordered groups atomically.
- Read completed versions: Query the session VERSION# collection and validate the owned root before resolving any generation. Historical generation requests require a matching immutable published version lookup; a staged generation is not authorized merely because its ID is known.
- Read draft: read root at revision r, query requested generation pages, re-read root; if it changed, retry a bounded number or return 409. A multi-page cursor includes r and fails with 409 after a mutation. A summary is returned only from a coherent generation.
- Complete: conditionally move the root/draft into FINALIZING at its expected revision, blocking further edits to that generation; validate all draft pages and compute side/group/per-primary-muscle summaries. Stage one compact performance projection per distinct exercise in bounded transactions, with a manifest/digests. For normal small sessions this can be one operation; large sessions return 202 and resume. The final publication transaction freezes META, publishes the root's latest completed pointer/version and muscle summary, clears its draft pointer, writes immutable version lookup/receipt and increments SESSIONCOLLECTION. Never publish before every expected performance projection exists and validates. All edits condition on root state/revision, so frozen generations cannot be changed. A failed/interrupted finalization remains resumable; abort discards only unpublished derived rows and restores the preserved draft after a revision-guarded state change.
- Correct/reopen: create a **new** draft generation by copying the latest completed generation into staging. Publish the draft pointer only after the copy verifies and root CAS succeeds. Keep the existing completed pointer visible to History until the correction is completed. Completion publishes version n+1 under the same session ID; old versions remain readable via an explicit version route and are excluded from normal duplicate counts.
- A concurrent correction/create operation cannot replace another draft: pointer CAS rejects it. An abandoned draft never silently replaces history. UI history reads completed generations; the logger reads drafts.

Performance projections are immutable per completed generation. A history query strongly resolves candidate session roots and accepts only their currently published completed generation; staged, aborted, mock-excluded and superseded candidates do not count. Group duplicate exercise entries into one performance per logical session while retaining entry IDs/modes for detailed retrieval. Correction completion replaces the root summary and eligibility pointer; it never adds the prior version to current analytics. Retained versions remain accessible through explicit version history.

Frozen generations are immutable by repository policy and conditional operations; the shared Lambda role still has update permissions, so this must be tested rather than called cryptographic immutability. No TTL applies to history.

### Unilateral invariants

Each unilateral group contains exactly one L and one R, with distinct stable set IDs and one group ID; bilateral groups contain exactly one `both`. Reps/weight/RPE/done are independent. Partial completion is valid, including in a finished workout. A paired completed count requires L.done AND R.done; volume is `sum(reps * kg)` over **every done side**, including partial pairs. Prescribed sets count groups once. Matched-side comparisons require both completed; report missing/partial sides explicitly and retain per-side RPE.

`sameWeight` is an entry preference: an explicit load edit can include both sides in one transaction. Merely enabling it, loading prior data or completing a side must not equalize values. Prefill uses the corresponding completed side from a prior completed session with matching historical unilateral mode, following current `lib/tracker.ts`/`lib/unilateral.ts`; missing sides use planned defaults, never their partner's actuals. Switching a library definition back to bilateral affects future entries only.

## Nutrition table — no GSI

| PK                 | SK                           | Content and access                                                                                               |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| U(u)               | FOOD#id                      | Custom food, explicit preparation, per100g, sourceInfo, revision, archive lifecycle                              |
| U(u)               | RECIPE#id                    | Recipe head, name, current immutable version pointer, revision                                                   |
| U(u)#RECIPE#id     | VERSION#zeroPaddedVersion    | Immutable ingredient IDs/grams/full food snapshots, positive finishedGrams, calculated total/per100g, provenance |
| U(u)               | DIARYID#entryId              | Stable locator containing date, revision and deletion tombstone; exact strong Get                                |
| U(u)#MONTH#YYYY-MM | DAY#YYYY-MM-DD#ENTRY#entryId | Diary entry with meal/grams/source type+ID+revision, frozen name/preparation/per100g, createdAt and revision     |
| U(u)#MONTH#YYYY-MM | DAYREV#YYYY-MM-DD            | Daily mutation revision, bumped by every create/update/move/delete affecting that day                            |
| U(u)               | GOALS#CURRENT                | Current head/revision and latest effective date                                                                  |
| U(u)               | GOALS#DATE#YYYY-MM-DD        | Date-effective pointer to latest goal change for that day; Query up to date descending Limit 1                   |
| U(u)               | GOALS#VERSION#changeId       | Immutable target/change record and effective date; exact Get after resolving date pointer                        |
| U(u)               | FAVORITE#foodId              | Favorite reference; Put/Delete, Query prefix                                                                     |
| U(u)               | OP#operationId               | Nutrition staged-create progress and lease, if required                                                          |
| U(u)               | IDEM#requestHash             | Domain receipt with expiry                                                                                       |

Diary creation reserves DIARYID and writes entry + DAYREV + receipt in one transaction. Editing checks locator/entry revisions; moving dates transactionally deletes the old row, puts the new row, updates locator, bumps **both** day revisions and writes receipt. Same-day edits bump one day revision. Deletion removes the diary row and leaves a permanent minimal locator tombstone so a late retry cannot recreate the same ID after receipt expiry. No hard deletion of source definitions while referenced; archive/restore only in the first lifecycle implementation.

Day reads strongly query the base-table day prefix, sum unrounded values and verify DAYREV before/after across all pages. Range reads are capped at 31 local dates and return per-day revisions; they do not promise a global multi-day instant. Recent food references derive from a bounded diary range initially; avoid an unbounded Scan. Empty days have zero totals and implicit revision zero. Goals/preferences do not rewrite diary entries. A goal edit transaction writes an immutable change record, updates its date pointer and CAS-updates the current head plus receipt. The CURRENT pointer is the concurrency head; effective targets are always resolved by local date, including scheduled or backdated changes.

Recipe edits put a new immutable VERSION and conditional-update its head plus receipt. Ingredients copy authorized food snapshots once; food edits never update them. A deliberate ingredient refresh resolves the current food revision explicitly. Normal diary creation resolves an authorized food or immutable recipe version and freezes per100g server-side. Gram/meal/date edits preserve the existing snapshot; a different source is an explicit replacement action, not an implicit refresh. Imports may preserve older snapshots unavailable in current definitions through the restricted import path.

## Five required access patterns

`U(u)=USER#<verified sub>` and all ID components use the encoding above. Sort timestamps are fixed-width UTC RFC3339; calendar date filters convert the requested user's IANA-zone boundaries to UTC **before** forming key ranges. Use half-open time ranges `[start, end)`; implement inclusive DynamoDB BETWEEN with an end-exclusive boundary check or the last representable millisecond plus a valid ID suffix. This prevents midnight/DST errors and adjacent-week double counts.

| Product question                       | Table / index                         | Exact partition and sort-key predicate                                                           | Result and work bound                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All workouts in the last 30 days       | Training / **GSI1**                   | `GSI1PK = U(u)#SESSIONS`; `GSI1SK` between the UTC start/end timestamp bounds, descending        | Only that user's dated root summaries, then strong root Gets to resolve current published versions; paginate all pages, no unrelated dates/tenants                                                                             |
| Last five performances of one exercise | Training **base table**, no extra GSI | `PK = U(u)#EXERCISE#exerciseId`; `begins_with(SK, PERFORMANCE#)`, descending, initially Limit 5  | Strong targeted Query + candidate root checks; continue until five eligible distinct sessions/exhaustion. Load selected immutable generation/entry side rows for detail; do not enumerate other exercises or all user sessions |
| Today's meals and daily macros         | Nutrition **base table**              | `PK = U(u)#MONTH#YYYY-MM`; `begins_with(SK, DAY#YYYY-MM-DD#ENTRY#)`                              | Strong Query of that day only, sum original per100g snapshots × grams/100, DAYREV before/after guard; page all entries before declaring complete totals                                                                        |
| All saved recipes                      | Nutrition **base table**              | `PK = U(u)`; `begins_with(SK, RECIPE#)`                                                          | Paginated heads only; immutable recipe versions/diary data are in separate key collections and aren't read                                                                                                                     |
| Weekly chest-training volume           | Training / **GSI1**                   | Same user partition as workout list, sort-key range for the selected local week converted to UTC | Sum `root.summary.primaryMuscleVolumeKgReps.Chest` from current published root summaries only; exclude mock by default. Reads that week's headers, never set rows or the user's whole history                                  |

Weekly muscle volume needs no separate GSI-per-muscle: one compact map covers the fixed primary-muscle taxonomy and a typical week contains a small number of headers. Root summaries use **frozen exercise metadata** and all completed sides; partial pairs contribute their completed side's volume. A correction recomputes/replaces its root's map once, so history versions never accumulate double volume. Secondary-muscle associations are separately labeled, not added again to primary totals. If measurements later justify a muscle/time projection, add one deliberately rather than index every optional tag in advance.

GSI1 projections cannot be strongly read. Membership may lag; canonical root Gets avoid stale summary/version values for rows already returned but cannot recover a newly missing index row. Writes return their canonical summary immediately; UI merges confirmed recent results and exposes indexing/pending state instead of claiming a globally fresh aggregate. [AWS GSI consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html). Base-table exercise projections are written **before** root publication, so strong queries cannot miss an already published projection. Wrap resumable prefill lookup with strong SESSIONCOLLECTION before/after checks and restart on concurrent publication. No full-user-session fallback remains.

DynamoDB Limit counts evaluated items, not accepted results: an obsolete correction or unpublished candidate may require continuation to fill five performances. Validate every candidate against its authenticated parent and generation, and cap evaluation at 50 candidates/request with an opaque continuation. Do not silently return “five latest” if the search is unfinished. Abandoned projection cleanup prevents staging debris from building up; retained correction versions are still targeted to the same exercise, not a table-wide read. [AWS Query semantics](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html).

### Other access paths

- Profile, current logger pointer, entity heads, locators and operation status: exact scoped Gets.
- Custom exercises/foods/templates/favorites: `PK=U(u)` with the corresponding type prefix and pagination; catalog: exact TYPE partition Query. Client search is over loaded library pages, not a claimed full-text index.
- Recipe versions/session versions: owned aggregate partition and VERSION# prefix. Set details: exact owned generation partition and entry/group prefix.
- Exercise progression: the same targeted PERFORMANCE# collection, optionally date-bounded. Preserving historical mode/side values requires reading the referenced frozen generation, not the current library.
- Broader muscle/equipment/movement/training reports: bounded date-header queries plus explicitly budgeted frozen generation reads for attributes not in summary. These are separate from the five validated core paths and must not quietly expand to unbounded history queries.

### Synthetic fixture results

Five temporary local key-selection fixture groups passed for this revision (mock data, no AWS SDK or application code):

1. A 30-day user/date query excluded older, out-of-range and foreign-user rows.
2. The last-five exercise query returned five distinct published sessions, skipped staged/superseded candidates, and evaluated the same seven targeted candidates after adding 20,000 unrelated records.
3. A daily diary query returned two entries and unrounded totals of 465.8 kcal / 21.285 g protein / 67.645 g carbs / 4.755 g fat; other dates/users stayed separate.
4. Recipe-prefix lookup returned only two owned recipe heads, excluding foods, versions and another user.
5. Weekly Chest volume was 1,227.5 kg·reps from four candidate headers, preserving a completed-left/unfinished-right contribution, excluding mock data and replacing an old correction summary. A separate boundary assertion covered a 169-hour DST-transition week.

These fixtures validate key predicates/arithmetic only; the temporary model is not committed as backend implementation and is not a DynamoDB emulator or proof of server authorization.

### Validation status and implementation gate

This is **design-level access-plan validation**, not an executed DynamoDB load benchmark. Each of the five questions maps to Query/Get with tenant equality and a time/type prefix, no Scan and no FilterExpression standing in for an index. The original last-five plan that searched all session roots is superseded.

Local synthetic key-selection fixtures verify date ranges, reverse ordering/limit, recipe isolation, independent diary days, cross-user namespaces, correction exclusion and partial-side chest-volume arithmetic. They model query predicates only; they do not emulate DynamoDB consistency/capacity or prove the deployed authorizer. Before accepting the four-table layout in implementation, run the same cases against local DynamoDB/test fixtures, use >1-MiB pages and many correction versions, and measure read/write units/item bytes. Require changing unrelated exercises or another user's history not to increase last-five candidate reads; week queries must scale with that week's headers, not lifetime sets. Record Query vs Scan SDK calls and repeat in the separately authorized cloud environment with real A/B identities before release.

Secondary-muscle volume reporting is **non-additive**: do not credit 100% to every secondary muscle and then sum it as total session volume. Primary-muscle totals can sum volume once; secondary associations are labeled overlapping. Bodyweight load=0 retains current external-load-volume semantics; bodyweight tonnage and estimated 1RM are not invented.

## Staging, idempotency and growth

Create/copy/import operations use an owner-bound OP record, manifest and immutable staged chunks. Operation records live in the mutating domain table (Training or Nutrition); import operations live in Accounts, avoiding cross-domain writes for normal handlers. Each ≤50-row transaction contains data rows plus operation progress and receipt within the 100-item/4-MiB limit. The operation's revision/digests reject changed chunks and repeated IDs. Rows are unreachable through normal resource pointers until final verification and a conditional publication transaction. Reads always require a published parent; guessed generation IDs cannot bypass that gate. A checksum alone is insufficient: validate shapes, references, counts, numeric values and per-side completeness.

Receipt keys hash the caller/method/canonical path/idempotency key only; payload and precondition hashes are stored fields compared on replay, not part of the lookup key. Store compact original responses or immutable response references so retries do not reconstruct a different result from a subsequently changed entity.

Idempotency receipts are co-located in the mutating domain's table; cross-table import publications can transactionally include an Accounts receipt. Retain receipts for at least 7 days and enforce logical expiry in handlers because TTL deletion is asynchronous. Entity IDs and diary tombstones remain unique beyond that period. AWS `ClientRequestToken` has a 10-minute window and is only an additional transport safeguard, not the application's retry protocol. Staging expiry/cleanup is separate from history: no active/imported private record receives TTL automatically.

The proposed 1,000-MAU workload is a sizing hypothesis pending measurements, not a validated throughput claim: roots/custom entities partition by user and sets by user/session/generation. Catalog partitions are small/read-heavy. Monitor consumed units, item size, GSI lag and per-query work before adding caches, streams or indexes. No public aggregate query or cross-user Scan belongs to a runtime role. All schema upgrades are additive first, versioned and reversible; destructive rekeying requires an explicit migration plan.

## Milestone 1 physical adapter and local verification

`backend/form_backend/aws/dynamo.py` implements the provisional four-table layout using
base64url components and trusted-Principal user partitions. Actual simple entity SKs
are `EXERCISE#id`, `TEMPLATE#id`, `SESSION#id`, `FOOD#id`, `RECIPE#id`, `DIARY#id`,
`GOALS#current`, `GOALVERSION#id` and `PROFILE#profile` (ID components encoded).
Immutable workout/recipe versions use owned aggregate partitions and zero-padded
`VERSION#000000000001` keys. This is a documented local refinement of the proposal's
spelling; do not assume unimplemented ACTIVE_SESSION/GOALS#DATE pointers exist.

Diary locators are full canonical snapshots at `USER/DIARY#id`; monthly day entries are
small ID indexes at `USER#MONTH#YYYY-MM / DAY#date#ENTRY#id`. Moves, tombstones and both
day counters commit atomically. `COLLECTION#kind` revisions guard pagination/source
membership. Effective goals currently Query only the owned GOALVERSION prefix, then
select the effective version; no full-table query or Scan is used.

Mutable active workout generations hold META, ENTRY and separate `SET#entry#group#L/R/both`
rows. Only changed draft rows join the root-CAS/receipt transaction. Completing stages
a distinct immutable generation in ≤40-row transactions and atomically publishes the
root/version/exercise projections. A root revision reread detects concurrent changes
while reading mutable draft rows. Reopening copies into another editable generation.
Frozen generations and ID tombstones have no TTL. Abandoned generations require future
reference-aware reconciliation; never blindly TTL all generation rows.

Sparse Training GSI1 (`USER#u#SESSIONS`, original UTC start + session ID) supports dated
history. Per-exercise `PERFORMANCE#start#session` pointers are updated atomically to the
latest completed version, so corrections do not duplicate logical performances.
`publishedSummary` retains completed primary-muscle volume even when reopening a draft;
weekly volume queries dated headers and strong canonical roots, excludes mock sessions,
and includes completed partial-side volume. It never queries generation/set collections.

Native API pages Query at most the requested limit before per-record validation;
LastEvaluatedKey is wrapped in a signed user/query/revision/expiry cursor. Deleted/stale
rows may produce a short or empty page with a continuation. Exercise/food libraries page
owned custom rows then immutable system catalog rows. No standard path uses Scan.
The local suite exercises >1 MiB pagination, two-worker CAS conflicts, recipe/diary
immutability, isolation and draft/frozen-side records against DynamoDB Local as well as
Moto. AWS consistency lag, real capacity and IAM remain explicitly unverified.
