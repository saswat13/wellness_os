# FORM backend architecture proposal

Status: **Milestones 0, 1, 1.1 and 1.2 implemented locally; AWS deployment and real IAM changes remain unauthorized**. Milestone 1.2 reviewed October 18, 2026 (America/Los_Angeles). [Cloud frontend integration](milestone-1.2.md) adds explicit API-backed UI selection and active-draft discovery; its fake identity/Moto evidence is not live AWS verification. This is the entry point for the backend design documents. Earlier evidence sections retain their original milestone scope.

## Design documents

- [API contracts](api-contracts.md)
- [Database design](database-design.md)
- [Authentication and security](authentication-security.md)
- [Data migration](data-migration.md)
- [AWS cost estimate](aws-cost-estimate.md)
- [Implementation milestones](backend-tasks.md)

## Outcome and evidence

Use **one application backend and Cognito user pool**, with separate workout and nutrition APIs. The first cloud acceptance test is: A signs in, saves a workout and a meal, signs out, signs in on another device and retrieves both; B cannot read or change either record. Public sharing is not required for that acceptance test.

Inspection covered `lib/models.ts`, `lib/tracker.ts`, `lib/unilateral.ts`, `lib/nutrition.ts`, `lib/persistence.ts`, `app/hooks/use-snapshot-persistence.ts`, the application components and [the functional audit](audit.md). The audit reports 30 domain tests, 21 Chromium tests, lint, TypeScript and Webpack build passing. Those are **local prototype results**, not evidence of authentication or backend correctness. This milestone changes documentation only; those application checks were not rerun as backend verification.

Existing invariants become server invariants: IDs are independent of names; planned targets and actual logs stay separate; exercises/templates/foods can change without rewriting historical snapshots; partial L/R work persists and contributes volume; food preparation and finished recipe yield remain explicit; diary dates are independent; stale writes cannot overwrite newer records. The prototype remains usable while cloud support is developed behind a mode flag. Existing local keys and raw values are retained.

## Proposed components

| Component           | Initial choice and purpose                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Region              | `us-east-1` approved; one Region initially                                                                                                                                              |
| Authentication      | Cognito **Essentials**, email verification, managed login, authorization code + PKCE, confidential BFF client, PKCE, persistent HttpOnly session; optional TOTP; admin invitations only |
| API                 | One regional **API Gateway HTTP API**, REST resource paths under `/v1`, native JWT authorizer and route scopes                                                                          |
| Compute             | Python 3.13, arm64 Lambda, initially 512 MiB; BFF, Accounts, Workouts and Nutrition functions, plus an isolated Import function                                                         |
| Data                | Four candidate DynamoDB Standard on-demand tables: Accounts (including server sessions), Training, Nutrition and Catalog; validate access paths before acceptance                       |
| Browser integration | Repository adapters preserve existing domain/UI behavior; authenticated reads/writes replace whole-store cloud uploads                                                                  |
| Operations          | CDK v2 in TypeScript, CloudWatch, PITR, retained stateful resources, throttles, budgets and a tested restore runbook                                                                    |
| Small shared secret | Separate Secrets Manager secrets for cursor signing and the BFF confidential client                                                                                                     |

“REST” describes the resource contract. It does **not** require API Gateway's more expensive REST API product. HTTP API supports the required JWT authorization; validation occurs in Python because native REST request validators/usage plans are not part of this choice. If direct API WAF association or those features become mandatory, review the API product and estimate before implementation. See [AWS JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

Python 3.13 is a supported managed runtime; lock dependencies and confirm runtime/CDK support again at implementation. Arm64 is the baseline provided dependencies pass packaging tests. No VPC/NAT, direct browser DynamoDB access, identity pool, RDS, OpenSearch, queues, streams, WebSockets or per-entity microservices are needed for the first milestone. The native runtime support is documented in [Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html).

## Request and data boundaries

1. The browser uses same-origin `/auth/*` and `/bff/v1/*` routes with a persistent Secure/HttpOnly/SameSite session cookie. Valid sessions survive page refresh and browser restart; browser storage holds no Cognito bearer/refresh tokens.
2. A proposed Python BFF Lambda completes Cognito Authorization Code + PKCE server-side, stores token/session state in Accounts, validates cookie/CSRF and refreshes tokens when necessary. Next.js server handlers are an alternative if the chosen hosting already supplies a server runtime; placement/cost review is explicit.
3. The BFF calls downstream `/v1/*` with a short-lived access JWT. API Gateway validates issuer/client/scopes; Python middleware additionally enforces token use, principal and account state. The BFF never substitutes a client owner header for authenticated identity.
4. Domain handlers validate DTOs and nested owned/catalog references, then use conditional/transactional writes. Owner, revision and computed snapshots are server-authoritative.
5. Responses contain domain DTOs, never raw database keys or tokens. Signed cursors are identity/query-bound, private responses use no-store, and logout revokes the app session.

The Lambda execution role covers its domain's tables; it is **not a distinct IAM identity per app user**. App-user isolation is enforced by server key construction, reference checks and tests, not by CORS or assumed automatic IAM tenant isolation. [Authentication and security](authentication-security.md) defines the boundary.

## Storage and consistency choices

[Database design](database-design.md) specifies keys and access patterns. Mutable definitions use entity revisions. Recipes have immutable ingredient/yield versions. Workouts use a stable session ID, mutable draft generations and frozen completed generations; reopening a workout creates a new draft instead of modifying the previous completed version. This preserves the prototype's latest-workout correction workflow while retaining prior results.

Each set remains an individual record with stable `id`, `groupId`, entry ID and `side`. Session completion publishes an already validated generation, so a large session does not require rewriting every set in one transaction. Small edits atomically update rows, parent revision and an idempotency receipt. Large create/copy/import operations stage invisible rows, then publish a validated pointer. Interrupted operations are resumable and never appear as complete data.

The four-table count is provisional, justified by access patterns rather than fixed in advance. Workouts in a time range use GSI1 keyed by user and UTC start time, projecting bounded per-primary-muscle summaries. The last five exercise performances use a dedicated **base-table exercise/time collection**, not a search through unrelated workouts. Today’s diary and saved recipes use tenant/date or tenant/type key queries. Weekly chest volume queries only that week's workout summaries; no raw-set/history walk is required. [Database design](database-design.md#five-required-access-patterns) provides exact keys, indexes, pagination, correction handling and consistency limits. No required operation uses DynamoDB Scan or an unbounded user-history walk. The exercise/time projection needs no duplicate GSI because its primary keys already provide that access path.

GSI1 remains eventually consistent. Direct resource/day/exercise-history reads use strong base-table reads and publication/revision checks. Derived projections are staged before completing a generation and become eligible only when its root pointer publishes; older correction versions never count twice. These are design-level query validations, not measured DynamoDB performance; local access-plan fixtures, consumed-capacity tests and two-user tests are implementation gates.

## Frontend preservation and rollout

- Keep existing local parsers and migrations. Add explicit local/cloud repository selection; do not silently reinterpret local-demo-user as a signed-in identity.
- Introduce per-account caches and pending-write queues. On account change, unmount old views, abort requests and clear old in-memory data. Do not delete the legacy browser stores.
- Keep large touch targets, meal navigation, set logging, paired-side semantics, templates and current mock labels. No lengthy required metadata forms.
- Cloud autosave coalesces edits by set group with a stable mutation ID. Mark pending/saved/conflicted states; a lost response never silently loses a draft or creates a duplicate.
- First cloud milestone requires online synchronization and safe retry. Offline edits remain visibly pending and bound to the original account; automatic conflict merging and full offline synchronization are deferred. Never imply a pending edit is saved remotely.
- Keep template export allowlisted. Hosted public publishing/discovery is deferred; existing `visibility: public` is intent, **not authorization to expose a private record**.

Import is an explicit, previewed action after sign-in, with a private backup and unchanged local originals. See [migration](data-migration.md). Cloud mode becomes the default only after acceptance tests; local mode remains an explicit recovery path, not a fallback that can silently split the same account's records.

## Infrastructure proposal, not deployment authorization

A future `infra/` CDK app will use separate Auth/Data/API/Observability constructs in one stack per environment. The frontend hosting stack is a separate decision. Stateful resources have stable construct IDs, retention policies, deletion protection where supported and stack termination protection for production. DynamoDB uses AWS-owned encryption keys initially, PITR with a 35-day recovery window, TLS-only access and no public endpoints exposed directly to users. Cognito user pool deletion protection is enabled. Backups do not replace a restore rehearsal or account-deletion policy.

HTTP API routes target Lambda aliases with permission scoped to the API/stage; no function URLs. Browser BFF routes use cookie/CSRF validation; downstream domain routes retain JWT authorizers. Roles grant only required table/index item operations, their own log stream writes and the cursor-secret read; BFF alone has confidential-client secret/session-store access. The Import role temporarily needs all private tables; it has no catalog write or infrastructure/IAM permissions. [Security](authentication-security.md) contains the permission matrix. Deploy-time seed tooling is separately scoped to Catalog and never runs with an app user's credentials.

Start with 10-second interactive Lambda timeouts and a 20-second bounded Import handler; retryable chunks must finish within those limits. Proposed pilot route throttles: reads 20 requests/s, writes 10 requests/s, imports 2 requests/s, with modest bursts; confirm account quotas. Set concurrency ceilings in the implementation plan after checking available regional concurrency; do not assume a small account can reserve a particular amount. On-demand table throughput ceilings and per-user request/import limits supplement API throttles. These are damage controls, not exact spending caps.

Use JSON logs with request ID, route template, status, duration and sanitized failure code; no JWTs, email addresses, food/workout contents, query bodies or import payloads. Set 30-day log retention. Six standard alarms cover API errors, latency, aggregate Lambda errors/throttles and database read/write throttling. Use existing AWS metrics without high-cardinality per-user metrics. Budget alerts and a manual write-disable runbook supplement monitoring. Treat auth callbacks/session routes as sensitive: omit query strings/cookies, and log route templates only. No production tracing payload capture; sample tracing only after redaction review.

## Complexity and risk review

| Risk / temptation                                          | Decision                                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Split nutrition and training into separate infrastructures | Shared user pool, API, operational stack; domain-specific functions/tables remain clear                                       |
| Giant session JSON rewritten on each tap                   | Individual side rows; transactional revision changes; generation publication for history                                      |
| Whole-store last-write-wins sync                           | Conditional entity/aggregate revisions; retain conflicts for review                                                           |
| Historical recalculation from current libraries            | Frozen definitions/nutrients and immutable completed/recipe versions                                                          |
| Indefinite background import machinery                     | Client-driven resumable operations; no queue/worker platform initially                                                        |
| Query/index explosion                                      | User/date GSI with muscle summaries; targeted exercise/time collection; bounded diary/recipe key queries; no Scan             |
| Long-lived browser tokens                                  | Persistent opaque HttpOnly cookie, server-held tokens, reviewed BFF/CSRF/refresh behavior; browser reload must preserve login |
| Public template flag leaks history                         | No public private-table route; later sanitized publication records only                                                       |
| “Serverless means free”                                    | Metered, assumption-based [estimate](aws-cost-estimate.md); abuse and retention can dominate                                  |

## Decisions to approve before implementation

User requirements now settled: persistent login across refresh and an invitation-only first deployment. Milestone 0 is authorized with the Lambda BFF and seven-day maximum. Deployment still requires review of real-session security, hosting/cost choices and the integration-tested storage layout; these requirements do not authorize deployment.

1. **Topology/access paths:** shared Cognito + HTTP API, Python BFF/domain Lambdas, four candidate tables, versioned history and explicit query/index plan. Accept the table count only after local key/query fixtures and capacity tests validate it.
2. **Region and hosting:** us-east-1 is approved; same-origin BFF routing/HTTPS must be supported; select frontend origin/callback domains and hosting. Hosting is outside this backend cost estimate.
3. **Persistent sessions (required):** the same-origin HTTP API/Lambda BFF is conditionally approved with opaque HttpOnly cookie, server-held refresh tokens and CSRF protection; the chosen BFF is API Gateway HTTP API plus Python Lambda; choose compatible same-origin frontend hosting/routing. Use a configurable seven-day maximum, with idle expiry capped by that maximum; review refresh/revocation behavior. Memory-only login and browser localStorage tokens are not proposed.
4. **Private release (required):** admin invitations only, Cognito self-registration disabled, no public sign-up or federated enrollment. Public registration needs separate later approval. Review optional TOTP, retention, export/deletion and backup expiry before real users.
5. **Import:** explicit claiming of local records; mock workouts excluded from real analytics by default; ambiguous seeded nutrition reviewed by the user; collisions require review, never overwrite.
6. **Corrections and goals:** preserve completed workout versions; new goals apply from a chosen local date without inventing past targets; exact same-day goal behavior is specified in the API proposal.
7. **Budget/operations:** approve estimates, alert recipients, pilot budget, quotas, recovery objectives and access for the later separately authorized implementation/deployment stages.

Proposed recovery objectives are RPO ≤5 minutes using PITR and RTO ≤24 hours after a rehearsed restore; these are targets, not AWS guarantees or measured results. Single-Region outage continuity is deferred. [Implementation milestones](backend-tasks.md) contain acceptance gates; Milestone 0 is complete locally and stops before cloud work.

## Milestone 1 implementation status

The locally implemented AWS adapters and offline CDK definitions now accompany this
proposal. See [backend commands](../backend/README.md), [current cost estimate](aws-cost-estimate.md)
and the [sanitized AWS status](aws-public-status.md). The UI still uses local persistence;
local implementation does not establish production authorization or live backend behavior.

The refined implementation uses active-generation delta writes under aggregate CAS and
immutable completed generations, a single HTTP API with cookie-authenticated BFF routes
and JWT-authenticated domain routes, four tables and one cursor secret. Cognito's
confidential client secret is retrieved server-side with a pool-scoped DescribeUserPoolClient
permission instead of keeping a second Secrets Manager copy. Static S3/CloudFront
hosting is now defined, with existing custom DNS/ACM prerequisites to avoid callback
configuration cycles. Token renewal uses durable leases/fencing, not the test fake's lock.
The first cloud acceptance milestone and outstanding real-AWS verification remain unchanged.
