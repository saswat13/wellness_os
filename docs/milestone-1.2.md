# Milestone 1.2 — cloud frontend integration

October 18, 2026 (America/Los_Angeles). Local implementation and simulated integration
only. No AWS provisioning, IAM change, deployment, invitation or real-data migration.
The existing FORM screens and browser stores remain available as the default local mode.

**Reliability follow-up:** the memory-only pending-write limitation below is superseded
by the [durable pending-write review](pending-write-review.md). Unacknowledged edits,
original revisions, request keys and queued batches now survive refresh/tab closure in a
separate account journal. Same-account verification and explicit retry are required.
No automatic merge or live AWS verification is claimed.

## Implemented

- Explicit **Use cloud account** mode (`?mode=cloud`) reuses the workout, library,
  template, nutrition, progress and settings UI. It does not read, import, overwrite or
  clear prototype localStorage. Returning to local mode restores the independent stores.
- Generated TypeScript request/response types match the executed OpenAPI v1 registry.
  The API client sends cookie credentials, account-bound CSRF, revision preconditions and
  stable idempotency keys. It follows bounded cursor pages and rejects stale-account data.
- Account discovery on load, sign-in/out, explicit account switching, focus/visibility
  and periodic session checks, authentication loading/error states and cross-tab clearing.
  Cognito tokens remain server-side. Production uses the existing PKCE/HttpOnly-cookie
  BFF adapter; no browser bearer-token store was introduced.
- Server-backed custom exercise creation/edit/archive, templates and ordered prescriptions,
  workout start/resume, draft saves, individual side results, completion/reopen and history.
  Existing logging controls retain partial pairs, independent loads/reps/RPE and planned
  versus actual values. Server-side snapshots and corresponding-side prefill remain authoritative.
- Custom foods, recipes and immutable version retrieval, weighed diary portions, meal/date
  changes, deletion, server day totals, effective goals, profile/unit/time-zone preferences
  and favorites. Existing calculation helpers provide immediate previews; saved totals and
  snapshots come from the backend rather than a second new calculation implementation.
- Visible saving/saved/error/conflict states, coalesced online writes, explicit retries and
  user-initiated private recovery downloads. Conflicts pause writes; reload requires consent
  to discard pending device-journal cloud edits. Requests acknowledged before a batch failure
  are not recreated on retry.

## API and database additions

`GET /v1/workouts/sessions/active` lists only the authenticated user's unfinished roots,
with bounded signed cursor pagination. It precedes the generic `{id}` route.
`PUT /v1/workouts/sessions/{id}/draft` atomically saves ordered entries, prescriptions,
notes/unit and structured set/side records with If-Match and an idempotency key.
It accepts references/results, never submitted ownership or exercise snapshots. Existing
entry snapshots and set identities cannot be reassigned; completed roots reject draft edits.

The existing Training GSI1 gains a sparse active pointer: PK `USER#<verified-sub>`,
SK `ACTIVE#<encoded-session-id>`, GSI1PK `USER#<verified-sub>#ACTIVE`,
GSI1SK `<started-at>#<encoded-session-id>`. Root, pointer, changed rows and receipt share
the conditional transaction. Completion removes the pointer's GSI keys; reopening restores
them. Query results re-read and check the owned canonical root. No Scan, new table/index
or runtime IAM action was added. GSI discovery is eventually consistent; an explicit draft
ID in the URL uses a direct root read after refresh. Real propagation delay remains unverified.

Profile writes now include optional `favoriteFoodIds`. OpenAPI and generated TypeScript
must change together (`npm run contracts:check` detects type drift; Python tests detect
registry/OpenAPI drift). The OAuth callback returns to `/?mode=cloud`.

## Offline review

Install the pinned Python requirements as described in [backend setup](../backend/README.md).
Use two terminals from the workspace root:

```bash
npm run build
npm run start
```

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/local/server.py --fake-auth
```

Open `http://127.0.0.1:3001/?mode=cloud` using local port forwarding, then choose a
synthetic pilot identity. The harness deliberately binds only loopback and checks the
exact loopback Host/Origin; a Codespaces public-domain URL is not an accepted origin.
Use VS Code desktop forwarding to localhost for this harness. The ordinary local prototype
still previews on Codespaces port 3000. Do not publish or deploy the fake identity service.

The harness proxies the local frontend and executes the real strict domain dispatcher
with memory repositories. Only synthetic pilot-A/pilot-B are selectable. It is outside
the Lambda asset, uses a distinct test-only HTTP cookie, and loses data/sessions on process
restart. Refresh persistence during a running process is verified; restart durability,
Secure cookies over TLS and actual Cognito are not established by these browser tests.
Moto tests separately exercise DynamoDB transactions and repository behavior.

```bash
npm run test:e2e:cloud
npm run test:e2e
npm run contracts:check
```

The cloud suite starts/stops its own fake server and local frontend as needed. Keep the
normal production build for these checks; run static export afterwards. Shared browser
console/runtime auditing stays enabled. Only explicitly expected negative API statuses
are allowlisted for the security/conflict scenarios.

## Verification

Original Milestone 1.2 checks passed: **126 backend, 41 frontend, 21 existing Chromium, 7 cloud Chromium and
16 infrastructure tests; zero failing tests.** ESLint, both TypeScript checks, Ruff/format,
Mypy, generated contracts, default/static builds, offline synthesis and cdk-nag pass.
Detailed local validation manifests and logs are intentionally excluded from the public
repository. See the [sanitized AWS status](aws-public-status.md) and
[pending-write review](pending-write-review.md).
Coverage includes refresh/resume, asymmetric partial pairs, completed-side volume,
meal/date/edit/delete/goals, library/template snapshot independence, finished recipe yield
and immutable versions, direct two-user denials, logout/expiration/cross-tab clearing,
revision conflicts, response-loss retries and unchanged prototype storage bytes.

## Limits and next gate

- Server saves require connectivity. A separate validated device journal now retains pending
  edits and original request identities across refresh/tab closure. Browser storage denial,
  clearing/eviction and quota remain explicit limits. Recovery needs verified same-account
  login and user retry; stale revisions conflict rather than automatically merge.
- Initial history loads the last 365 days; Load earlier workout history adds bounded year
  windows. Exercise history can fetch that exercise's full paged history. Nutrition initially
  loads seven dates and additional selected dates; trend summaries cover the loaded dates.
  Lifetime analytics/range selection is not complete.
- Multiple unfinished workouts are retained and selectable. Starting another never deletes
  one. Very large aggregates remain subject to existing payload/transaction limits; failures
  pause saving rather than truncate records. Automatic discard/cleanup is not implemented.
- No automatic import, cloud import publication, public signup/sharing, public template
  hosting or production catalog seeding was added. New real accounts can edit UI defaults;
  the operator-approved cloud catalog/profile-bootstrap procedure remains a deployment task.
- Existing development dependency advisory and Milestone 1.1 email/IAM/TLS/security
  prerequisites remain open. Infrastructure resources and IAM scopes are unchanged; the
  rebuilt application asset and generated contracts require a fresh approval review.

Next milestone, only after explicit provisioning approval: execute the controlled AWS
pilot checklist with two invited users, actual Cognito/TLS/CloudFront/session renewal,
arm64 Lambda, IAM enforcement, DynamoDB GSI consistency and cross-device read-back.
Verify A saves a workout and meal, signs out, retrieves both from another device, and B
cannot read or modify either. Local simulated results do not satisfy that live gate.
