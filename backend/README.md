# FORM Milestone 0 — local backend foundations

**Current status: Milestone 1.2 local cloud-frontend integration.** The historical
Milestone 0 descriptions below retain their original scope. AWS adapters/entrypoints
exist and the UI now has explicit cloud selection. Nothing is deployed. See
[Milestone 1.2 report](../docs/milestone-1.2.md) for the offline fake BFF, typed client,
active-session/draft routes, tests and review commands. `backend/local/server.py` and
`local_sessions.py` are test-only and excluded from the Python 3.13 arm64 asset.

Current checks also include `backend/local` in Ruff and
`npm run contracts:check` / `npm run test:e2e:cloud` for generated types and offline UI
integration. Moto remains simulated AWS; the fake BFF stores records only in memory.

This is an **in-process Python API and test harness**. It does not open a network port, connect the frontend, validate real Cognito JWTs, call AWS, or deploy infrastructure. The current FORM frontend continues to use its existing browser stores unchanged.

## Install and check

From the workspace root, with Python 3.13 or newer:

```bash
python -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.lock
PYTHONPATH=backend backend/.venv/bin/python -m unittest discover -s backend/tests -v
backend/.venv/bin/ruff check backend/form_backend backend/tests
backend/.venv/bin/ruff format --check backend/form_backend backend/tests
PYTHONPATH=backend backend/.venv/bin/python -m form_backend.contracts
```

The dependency lock includes Pydantic and the development formatter/linter; there is no AWS SDK dependency. This workspace has Python 3.14.2; Python 3.13/arm64 packaging must be tested before selecting the deployment runtime. Tests check that the committed OpenAPI document matches the executed route registry. Regenerate it deliberately after a contract change. Existing frontend checks remain `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` and `npm run build`.

## What is implemented

- [OpenAPI 3.1 v1 contracts](contracts/openapi-v1.json) generated from `api.py` and the Pydantic models, covering exercises, templates, workouts/sets/groups/completion/history, foods, recipes/versions, goals, diary entries and profiles. The document describes **only the implemented local domain routes**; the broader design document also lists future routes.
- Strict numeric/date/enum/unknown-field validation, typed read/error envelopes, UUID creates/idempotency keys, metadata ownership assigned server-side, 256-KiB request bound and bounded signed-cursor pages. JSON numeric strings, booleans as numbers, nonfinite values and duplicate JSON object keys are rejected. No raw exception/request value is returned in validation errors.
- Accounts, Training, Nutrition and Catalog repository protocols and local in-memory implementations. Dictionary keys are tuples scoped to domain/subject/entity/ID. Catalog is read-only; public/private names never provide ownership. Shared mutable state is confined to a local unit of work, with detached reads.
- Process-local atomic mutation/receipt commits under a lock, rollback on any operation/response-validation failure, revision checks and exact-resource replay before stale-precondition checking. Idempotency fingerprints include the canonical body and precondition, with caller/route/key scoping. Diary IDs remain tombstoned after deletion.
- Frozen exercise/food ingredient snapshots, immutable completed workout/recipe/goal versions, independent L/R state, whole-pair add/remove, explicitly requested paired-load shortcut, corresponding-side prefill and completed-side volume. A correction keeps the same logical workout ID and retains the older completed version. Planned targets never become actual completion.
- In-memory date/exercise/day indexes, version eligibility, paging and query fixture tests. Completed versions store muscle-volume summaries. These demonstrate access semantics, **not DynamoDB physical reads, transaction limits, GSI lag or capacity**.
- Exact decimal JSON input/output and 38-significant-digit arithmetic for computed values, without display quantization. Repeating ratios necessarily have finite decimal precision. Input values outside the future DynamoDB numeric budget are rejected, never silently rounded. Historical imported snapshots are not recalculated.

To instantiate locally, construct `MemoryUnitOfWork`, the four memory repositories, `Service` and `API` as shown in `tests/test_foundations.py`. `API.handle(..., principal=...)` is a trusted adapter boundary: **never create Principal from request JSON, owner headers or an unverified JWT**. There is intentionally no deployable `lambda_handler` or HTTP fake-login endpoint. Do not deploy this harness as authentication.

## BFF/session abstraction

`sessions.py` contains an IdentityProvider protocol, a server-session repository protocol, fake invite-roster issuer and local session coordinator. Tests pass through code/state/nonce/PKCE and opaque-cookie creation; no real token endpoint or browser integration exists.

Approved deployment shape: `us-east-1`, same-origin API Gateway HTTP API/Python Lambda BFF, confidential Cognito Authorization Code + PKCE, HttpOnly/Secure/SameSite cookie, server-held tokens, invitation-only enrollment. Default **absolute maximum is seven days**, configurable through SessionConfig; idle expiry defaults to seven days and cannot extend the configured absolute expiry. Renewal changes credentials, not the original absolute deadline. Real Cognito refresh validity must be aligned to that maximum.

The local abstraction tests login-transaction expiry and single use, session-bound CSRF/exact Origin, account isolation, cookie persistence across coordinator recreation with shared storage, access-token renewal, concurrent refresh serialization, temporary provider failure, logout/revocation and expiry. The callback result is an internal grant: a future HTTP adapter must send only its Set-Cookie header and redirect, never JSON-serialize its internal cookie value. Cookie refresh/restart persistence is **simulated**, not proof from a real browser. Restarting the Python process loses in-memory records and sessions.

Before production, implement and test:

1. `/auth/login` and `/auth/callback` adapters with exact callbacks/return-path allowlists, transient Secure/HttpOnly login cookie, nonce/state/code-verifier binding, one-use transaction consumption, confidential client secret and **cryptographic** issuer/audience/client/token-use/nonce verification.
2. `/auth/session`, `/auth/logout` and allowlisted `/bff/v1/*` HTTP handling. Set/clear cookies and refresh Max-Age within idle/absolute bounds; prohibit arbitrary upstream URLs or forwarded client identity/Authorization headers. Protect every mutation including logout with exact Origin and account-bound CSRF; no token/cookie/code logging.
3. Durable encrypted server-side session/login storage, hashed cookie lookup, expiry enforcement independent of TTL, session references for account-wide revocation/deletion and account-disabled checks. Invalidate restored sessions before reopening a backup.
4. Distributed per-session refresh leases, fencing/version CAS, reviewed Cognito rotation grace and recovery after token-rotation response loss/crash. A Python RLock is only a test model, not distributed coordination. Temporary refresh failures retain drafts and return retryable errors; genuine expiry/revocation requires reauthentication.
5. Local session revocation even if remote token revocation fails, with a durable retry/incident policy. Already-issued downstream JWTs can remain valid until expiry; do not claim immediate JWT invalidation. Test account switching and in-flight responses with real browsers.
6. Cognito self-registration disabled, no federated enrollment bypass, operator-only invitations and real negative signup tests. Runtime handlers must have no admin-create-user permissions.

The production HTTP boundary, Cognito adapter, DynamoDB session adapter, shared hosting/origin routing and real-user credential handling remain future work.

## Migration preflight

`migration.plan_export(raw_bytes, trusted_principal, claim=True)` is a **read-only preflight**, not an import endpoint. It validates the current browser recovery export (workouts v3, nutrition v1), ownership/reference/side graphs, dates and unique IDs; records raw/normalized hashes, stable composite mappings, conflicts, warnings, source counts and original diary totals. It never overwrites localStorage or uploads data. Read-side source revisions may be null for legacy snapshots whose original catalog revision cannot be established; no fabricated revision is assigned.

`normalized_workout` is a pure fixture/preflight conversion that keeps group/side IDs, results and frozen exercise metadata; raw bytes remain the recovery authority. Original timestamps/legacy metadata need provenance in the eventual persisted import format. v1/v2 sources must be normalized on a detached copy by the existing frontend migrations first. Unknown schemas, overlong IDs, missing references and invalid data block preflight rather than being guessed/truncated. Destination collisions require review. An approved plan is not yet a committed transfer.

Before a cloud import: retain exact source keys/raw backup; claim the destination account explicitly; preview mock/unknown-source-version handling; reserve deterministic IDs/mappings; stage resumable, digest-checked chunks; publish whole validated aggregates; reconcile counts/IDs/per-side values and day totals through fresh reads. Preserve current/history same-ID roles, old nutrient snapshots and all local originals. Durable manifests, aliases, chunk publication/rollback, browser recovery UI and actual DynamoDB import remain Milestone 3 work.

`tests/fixtures/browser-export.json` contains only generated **mock seed data**, never an actual user's browser export. `generate-fixture.mjs` validates it using the existing TypeScript parsers and generates shared calculation results; run `node --import tsx backend/tests/generate-fixture.mjs`. Only `--regenerate` replaces the synthetic seed fixture. Python tests compare day/workout calculations against TypeScript results, preserving an explicit numeric tolerance for legacy JavaScript floating-point output.

## Remaining boundaries

The frontend is not wired to this backend; no cloud mode is selectable yet. API Gateway/Lambda adapters, real Cognito, database adapters, distributed atomicity, durable idempotency/TTL, large staged cloud writes, DynamoDB >1-MiB/capacity tests, public sharing, favorites/search/filter parity and cloud migration commits are not implemented. The known frontend development ESLint advisory remains a pre-production follow-up; no forced dependency downgrade was made.

## Milestone 1: AWS integration code (local validation only)

`form_backend/aws/` contains DynamoDB repositories, buffered conditional transactions,
immutable completed generations, delta writes for active drafts, bounded Query pagination,
Cognito RS256/token exchange, DynamoDB-backed BFF sessions and HTTP API v2 entrypoints.
Importing modules never creates AWS clients. Production entrypoints require server
configuration; there is no request-selectable fake-auth or alternate database endpoint.
The UI still selects its existing local adapter. `lib/cloud-client.ts` is an opt-in
transport with account-bound memory caches, aborts, cross-tab invalidation and CSRF.
It does not read, import or clear prototype localStorage.

### Safe failure diagnostics

The HTTP handlers log a layer, API Gateway request ID, status/problem category, and
exception type for server failures. BFF upstream failures also include the upstream API
Gateway request ID; DynamoDB failures include the operation, AWS error code, and AWS
request ID. Exception messages, request/response bodies, headers, cookies, tokens, codes,
and DynamoDB keys are not logged. These diagnostics identify a failure layer only after
the updated Lambda asset is deployed; local tests do not establish live AWS behavior.

Use Python 3.13 (the validation interpreter was 3.13.16):

```bash
python3.13 -m venv backend/.venv313
backend/.venv313/bin/python -m pip install -r backend/requirements.lock
PYTHONPATH=backend backend/.venv313/bin/python -m unittest discover -s backend/tests -v
backend/.venv313/bin/ruff check backend/form_backend backend/tests backend/scripts
backend/.venv313/bin/ruff format --check backend/form_backend backend/tests backend/scripts
PYTHONPATH=backend backend/.venv313/bin/mypy --config-file backend/pyproject.toml backend/form_backend
```

The default integration backend is Moto, a simulated AWS API. For the free AWS
DynamoDB Local Java emulator, start it separately in memory on loopback port 8000,
then run the same suite with:

```bash
FORM_DYNAMODB_LOCAL_URL=http://127.0.0.1:8000 PYTHONPATH=backend \
  backend/.venv313/bin/python -m unittest discover -s backend/tests -v
```

Tests accept **only that exact loopback endpoint**, use literal fake credentials and
create/delete only emulator tables. Never point these tests at an AWS endpoint.
Cognito responses are always simulated, using locally generated RSA keys for verification.
Neither emulator nor Moto verifies real IAM, Cognito login, GSI lag, throttling or recovery.

For a reproducible Python 3.13/arm64 asset (downloads public dependency wheels only):

```bash
backend/.venv313/bin/python -m pip install --only-binary=:all: \
  --platform manylinux_2_34_aarch64 --platform manylinux2014_aarch64 \
  --implementation cp --python-version 3.13 --target backend/lambda-dist \
  -r backend/requirements-runtime.lock
backend/.venv313/bin/python backend/scripts/package_lambda.py
npm ci --prefix infra --ignore-scripts
npm run typecheck --prefix infra
npm run test --prefix infra
npm run synth --prefix infra
```

`lambda-dist` and `cdk.out` are generated and ignored. Rebuild the asset after backend
source changes. Inspect wheel tags/ELF AArch64 headers locally; executing those binaries
on arm64 Lambda remains a controlled-deployment gate. Never deploy the developer venv,
Moto, tests, browser exports or fake issuer. The fake issuer and memory session coordinator live in `local_sessions.py`, which is
explicitly excluded from the assembled Lambda asset. Production handlers never select
local stores.

See [Milestone 1 implementation report](../docs/milestone-1.md),
[infrastructure commands](../infra/README.md), and
[deployment checklist](../docs/controlled-deployment.md). No backend is deployed.
