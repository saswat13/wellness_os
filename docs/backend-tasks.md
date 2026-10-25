# FORM backend implementation milestones

Status: **Milestones 0–1.2 implemented locally; no AWS provisioning/deployment authorization**. Region is us-east-1, BFF is same-origin HTTP API/Lambda, registration is invitation-only and the configurable session maximum defaults to seven days. Four tables remain provisional. See [backend setup and limits](../backend/README.md) and [Milestone 1.2](milestone-1.2.md). Earlier milestone lists retain their historical scope; live checks remain outstanding.

## Design deliverables and review

- [x] Inspect current models, persistence boundaries and [audit](audit.md).
- [x] Propose [shared architecture](backend-architecture.md), [API contracts](api-contracts.md), [DynamoDB access patterns](database-design.md), [authentication/authorization](authentication-security.md), [safe migration](data-migration.md) and [cost assumptions](aws-cost-estimate.md).
- [x] Review unnecessary infrastructure, immutable snapshots, partial L/R accounting, multi-device conflicts, import collisions and private sharing boundaries.
- [x] Record mandatory persistent login and invitation-only first deployment; memory-only login/public signup are superseded.
- [x] Map the five required queries to tenant/time/type key access, including targeted exercise-performance projections and weekly muscle summaries.
- [x] Conditionally approve us-east-1, same-origin HTTP API/Lambda BFF, server-held tokens, invitation-only release and configurable seven-day maximum session lifetime.
- [ ] Validate actual DynamoDB access/capacity, same-origin hosting/routing, privacy/retention and final costs before deployment.

The audited baseline reported 30 domain + 21 Chromium cases passing. Milestone 0 reruns those checks and adds local Python two-user tests; no real AWS two-user test has run. The existing full-development dependency advisory remains open; do not mark the entire dependency audit clean or force an incompatible Next/ESLint downgrade.

## Milestone 0 — local foundations implemented

- [x] Implement strict Python request/read/error models and generated versioned OpenAPI contracts for the required domains; test contract/route drift and schema references.
- [x] Define Accounts/Training/Nutrition/Catalog repository protocols and memory implementations with trusted-principal ownership and catalog write protection.
- [x] Implement local revision checks, atomic mutation/receipt commits, replay, rollback, detached snapshots and diary tombstones.
- [x] Preserve immutable workout/recipe/goal versions, planned-vs-actual results and independent L/R state; test unequal-side prefill, partial volume, paired counts and mode changes.
- [x] Implement a fake invitation-only identity/session abstraction: code/state/nonce/PKCE, opaque Secure/HttpOnly cookie specification, CSRF, configurable seven-day max, renewal, concurrent refresh and revocation tests. This is not real Cognito integration.
- [x] Validate in-memory query semantics for owner/time/exercise/day/prefix collections. Actual DynamoDB transaction/index/capacity/page-size validation remains required before accepting the physical layout.
- [x] Implement read-only export preflight with source hashes, graph validation, deterministic account-bound mappings, conflict detection and no source mutation; retain v1/v2 normalization in existing frontend code.
- [x] Generate synthetic cross-language fixtures from the existing TypeScript parsers/calculations; test Python day/workout parity and historical snapshots.
- [x] Run backend tests/Ruff and all existing frontend lint/type/domain/browser/build checks. Frontend source and browser keys remain unchanged.

Local implementation evidence does not establish production sign-in, real JWT verification, server persistence, cloud import or deployed isolation. See the [sanitized AWS status](aws-public-status.md). The frontend remains on its local adapter; selecting a cloud adapter is deferred until real adapters exist.

## Milestone 1 — local AWS adapters and infrastructure definitions

- [x] Cognito confidential PKCE exchange and cryptographic verification code, durable BFF sessions, CSRF, distributed refresh fencing, logout/revocation outbox and expiration.
- [x] DynamoDB repositories, atomic conditional revisions/receipts, snapshots, side records, delta draft writes, completed immutable generations and bounded native Query pagination.
- [x] Execute API/isolation/conflict/large-page/recipe/diary/session tests against Moto and DynamoDB Local; explicitly distinguish both from real AWS verification.
- [x] Add header-only weekly primary-muscle volume and dated/per-exercise/diary/recipe access patterns without Scan.
- [x] Add optional account-safe CloudClient; preserve the selected local UI and all browser keys.
- [x] Author CDK Cognito, HTTP API, BFF/domain Lambdas, four tables/GSI, session namespace, cursor secret, S3/CloudFront, logs/alarms/budget and hourly revocation retries.
- [x] Run template assertions and AWS Solutions security checks; document every acknowledgment and least-privilege runtime/deployment permission boundary.
- [x] Validate Python 3.13 locally, strict Python typing/lint, pinned arm64 wheel/ELF packaging, offline synth and static frontend export.
- [x] Implement/test unexposed synthetic import preparation/staging/reconciliation; no real source changes, account migration or publication.
- [x] Review dependency advisories and revise recurring estimates for receipts/history/static hosting.
- [x] Update architecture, API/security/database/migration, progress and approval checklist documentation.

Real Cognito login, arm64 Lambda execution, IAM enforcement, GSI lag/capacity, restore and
billing remain unverified until the separately authorized cloud pilot. Very large
transactions, orphan cleanup, full cloud UI selection and import publication are explicitly
recorded follow-ups. See [backend architecture](backend-architecture.md) and the [sanitized AWS status](aws-public-status.md).

**Stop here.** No bootstrap, deploy, real policy changes or cloud charges are authorized.
Any cloud action requires separate explicit authorization.

## Milestone 2 — minimal cloud vertical slice

Only after separate approval to provision an isolated test environment:

- [ ] Cognito A/B test users, gateway JWT/scopes enforcement, explicit profile bootstrap.
- [ ] Start/log/complete a workout, individual L/R rows and volume/count summary, immutable completed generation.
- [ ] Create/log/edit a weighed food entry, server snapshot/day totals and effective goals.
- [ ] Entity revisions, transactional idempotency and response-loss retries on both domains.
- [ ] UI sign-in/out, **refresh/restart without reauthentication**, expired-access silent refresh, concurrent tabs, logout/CSRF/expiry failure cases, online saved/pending/conflict state and account-switch cleanup.
- [ ] Negative direct SignUp/uninvited-account tests; first deployment admits only the explicitly invited pilot roster.
- [ ] Re-run the five key/query fixtures against the authorized AWS environment, record consumed capacity/bytes and verify no table Scan or lifetime-history walk in the core query paths.
- [ ] Execute the full [two-user matrix](authentication-security.md#required-two-user-authorization-tests), including write/reference/cursor/import/export paths, not just UI visibility.

**Success gate:** A signs in, saves a workout and meal, signs out, signs in on another device and retrieves both accurately; B cannot list/read/modify or indirectly reference A's private records. A must remain signed in after refreshing during partial L/R logging, with saved work preserved. Uninvited registration must fail. Also retry a lost response without duplication and reject a stale same-user revision. Record actual HTTP/backend test evidence; local mock tests alone cannot satisfy this gate.

## Milestone 3 — frontend feature parity and safe local import

- [ ] Exercise library metadata/name-only create/archive, template reorder/explicit save, corresponding-side prefill, whole-group changes, partial completion, RPE/history/analytics and versioned corrections.
- [ ] Custom foods/favorites, immutable recipe versions/ingredient snapshots/finished yield, diary moves/deletes, date independence and persisted profile/goals.
- [ ] Keep export plan-only; do not introduce public hosting of private templates as an incidental feature.
- [ ] Implement opt-in backup/dry-run/claim/mapping, resumable staged chunks, publication, reconciliation and retained source digests. Handle same current/history session ID and divergent legacy keys explicitly.
- [ ] Add migration fixtures for changed recipes/foods, ambiguous seeded nutrition, invalid data, unequal/partial L/R, unknown source versions and conflicts with live edits.
- [ ] Exercise failures before/after commit, expired authentication, wrong-account resume, quota limits and interrupted copies. Fresh-device read-back and unchanged original local key hashes are required.

Exit: original 30/21 regression coverage remains passing or is intentionally extended; production-equivalent cloud parity evidence is recorded. No record reported migrated unless reconciled; blocked/invalid sources remain recoverable. Cloud becomes the explicit primary adapter only after successful import/parity acceptance.

## Milestone 4 — operational/public-release readiness

- [ ] Production lint, TypeScript, domain + Python tests, Chromium + Firefox/WebKit/mobile/device checks and production build/server smoke tests.
- [ ] Gateway end-to-end token cases, both-direction authorization, load/latency/consumed-capacity tests, rate-limit and email-abuse controls.
- [ ] Rehearse PITR restore, account export/deletion, restore-with-deleted-users handling, secret rotation and incident/write-disable runbooks.
- [ ] Verify privacy notice/retention, email deliverability, cost/account allowances, alert recipients and budget forecast from measured traffic.
- [ ] Review CSP, XSS/CSRF/session strategy, dependency advisories and deployment rollback plan; approve public registration separately from the invitation-only pilot.

Exit: measured recovery targets and no unresolved data-isolation/data-loss defects. Public sharing, richer analytics indexes, full offline merge, social login and discipline-specific workflows are later milestones justified by demand, not prerequisites for A/B workout-and-meal synchronization.

## Verification boundaries

Current local checks and limitations are described in the [sanitized AWS status](aws-public-status.md).
AWS SDK calls in tests target only Moto or an exact loopback emulator with fake credentials.
Synthesis uses no live context lookup. No actual user browser storage, IAM policy, AWS account
or resource has been modified. Any provisioning requires explicit authorization.

## Milestone 1.1 — local deployment hardening

- [x] Use default CloudFront domain/certificate; wire callbacks/logout/APP_ORIGIN without manual hostname edits or cyclic dependencies.
- [x] Disable private/error caching and add no-store response policy regression checks.
- [x] Authorize exact CloudWatch alarm publishers in SNS and correct table/index throttle metrics.
- [x] Retain fixed $10 account budget and mandatory deployment email.
- [x] Provide custom file-only deployment support, scoped IAM policies/trust/boundaries, frontend publisher and security-operator review artifacts; retain device-login permission in proposed user boundary.
- [x] Reconcile 57 application + 16 support resources, retained-cost cleanup and conservative costs.
- [x] Run offline synth/security/schema checks, 16 infra tests, 116 Moto-backed tests, frontend lint/types/33 tests/21 browser tests and default/static builds; record warnings and unverified AWS limits.
- [ ] Approve recipient, account-specific IAM/SCP/bootstrap review, TLS minimum and other pilot security exceptions before separate provisioning approval.
- [x] Implement cloud UI selection/sign-in/out/account reset plus revision/idempotent save states locally; fake-identity browser checks are not real-user AWS acceptance.
- [x] Add owned active-session discovery/recovery semantics/access patterns; local refresh, completed history and diary synchronization tests. Live cross-device validation remains below.
- [ ] Perform separately authorized live Cognito/arm64/IAM/cache/email/recovery/A↔B tests; prepare reviewed real migration publication separately.

## Milestone 1.2 — cloud frontend integration

- [x] Add durable account-scoped pending-write recovery with original request/revision replay.
- [x] Validate logout/expiry retention, single-writer leases, storage failures and wrong-account rejection.
- [x] Extend failure tests to refresh/closure, food/start/completion/recipe acknowledgement loss and conflicts.
- [x] Record final reliability check counts and controlled-preflight review recommendation.

- [x] Generate typed client operations from executed OpenAPI v1; add contract drift check.
- [x] Reuse existing screens with explicit, isolated local/cloud adapters; no automatic storage import/clear.
- [x] Session discovery, persistent-cookie interface, sign-in/out/account switch and cross-tab/in-flight invalidation.
- [x] Connect workout drafts, L/R sets, templates, custom exercises, completion and history.
- [x] Connect foods, recipe versions, diary/date/meal/edit/delete, goals, profile and favorites.
- [x] Conditional/idempotent whole-draft route, owned active GSI pointers and cursor tests with memory/Moto.
- [x] Add cloud browser scenarios for A–F acceptance, template/recipe snapshots, conflicts and response-loss retries.
- [x] Keep fake issuer outside runtime asset; rebuild and verify Python 3.13 arm64 package.
- [x] Record final combined frontend/backend/browser/infrastructure checks in progress and the Milestone 1.2 validation manifest.
- [ ] Review local integration, approve a separately scoped controlled deployment only after all existing prerequisites.
- [ ] Verify actual Cognito/TLS/session renewal, IAM/arm64/GSI behavior, seed reviewed catalog and profile defaults, and complete real A/B cross-device acceptance.

Stop after local integration review. No bootstrap, IAM binding, deployment, real migration
or invitations are authorized by Milestone 1.2.

## Authenticated cloud read forwarding correction

- [x] Remove synthetic/caller GET payloads from BFF upstream requests while retaining mutation bodies.
- [x] Add HTTPX transport regression coverage for foods GET pagination/authentication and POST payload fidelity.
- [x] Cover the frontend generic-gateway 503 `REQUEST_FAILED` fallback without invalidating the account.
- [ ] Verify the reported deployed 503 against live correlation logs and a controlled release; local tests do not establish the live cause.

Local validation: 132 backend and 56 frontend unit tests pass; Ruff, Mypy,
frontend lint/typecheck, contract check, production build, arm64 asset verification
and offline CDK synthesis pass. Infrastructure tests: 8 pass, 2 require the excluded
account-specific deployment-support template. Browser suites executed with system
Chromium: 21 local and 16 cloud tests fail the existing missing-favicon console
assertion. No AWS resources or deployment configuration were changed.

## Cloud bootstrap capacity follow-up

- [x] Serialize initial collection/entity reads and the seven diary-day reads.
- [x] Reproduce capacity-limited bootstrap failure, then verify ready state and every required read without overlap.
- [ ] Release the updated frontend through existing hosting and verify the complete authenticated cloud screen. The operator reported the BFF-only update already deployed; preserve its live changes.

Follow-up checks: 57 frontend unit tests, lint, typecheck, production build and
static export pass. The representative static-site/fake-BFF browser journey
completed its functional assertions but fails the existing console assertion on
the missing favicon 404. Live full-screen acceptance remains outstanding.

## Cloud UI cleanup

- Move account controls to Settings and contextual actions to Workouts, History and Recipes.
- Replace technical header panels with one compact Saved/Saving/Unsaved indicator; retain error/recovery actions.
- Remove raw account IDs and normal-state recovery prose; keep account-isolation checks in browser tests.
- Add a FORM favicon and cover compact mobile/desktop layout plus account actions.

Cleanup validation: 57 unit tests, 21 local browser tests and 17 cloud browser tests
pass. Lint, typecheck, production build and static export pass. Mobile static-export
screens were inspected for the header and Settings layout. No backend, infrastructure,
IAM or application-data changes; frontend publication remains separate.

## Shared catalog launch (local implementation)

- [x] Prepare 400 strength exercises and 400 USDA foods with source IDs, attribution and no images.
- [x] Add strict nutrition/state normalization, duplicate checks and conditional importer-owned upserts.
- [x] Verify the isolated Moto import is idempotent and both application APIs return all 400 shared records through pagination.
- [x] Preserve private/custom records, frozen snapshots and independent unilateral side values during shared updates.
- [x] Add backward-compatible API models and alias/source-ID search to the existing interfaces.
- [ ] Cross-check the pinned USDA mirror files against an official USDA download when network access permits.
- [ ] Release the code and seed the existing catalog through an explicitly authorized operator; verify all launch IDs through the live APIs. No live changes were made during local implementation.

Catalog validation: 144 backend tests, 59 frontend unit tests and 39 browser tests
pass, including the launch-bundle UI fixture. Ruff/Mypy, lint/typecheck, contracts,
production/static builds, arm64 ELF asset checks and offline synth pass. Eight
infrastructure tests pass; two need the intentionally excluded deployment-support
template. The pinned source rebuild is byte-identical; official USDA archive
cross-checking remains outstanding. Full local evidence is in the bundle
`validation.json`; no production API verification or live seeding is claimed.
