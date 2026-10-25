# Authentication, ownership and security proposal

**Milestone 1.2:** the UI now uses the same-origin BFF discovery/login/logout interface.
Its account-scoped memory state is invalidated before account switching, on logout/401,
on subject mismatches and through cross-tab notifications; in-flight old-account responses
cannot repopulate it. All mutations use CSRF and server-owned Principal authorization.
The callback returns to explicit cloud mode. Missing subject headers on gateway failures
retain a recoverable error; successful unbound responses are rejected. No credentials
are written to browser storage. Pending cloud records now use a separate
plaintext, account-scoped device journal; only a verified session for that account can
recover it through the app. Logout/expiration hide but retain pending records. Review the
[journal privacy and retention boundaries](pending-write-review.md). Only offline fake-identity browser and simulated
DynamoDB checks have run; production TLS/Cognito/session persistence remains unverified.
See [Milestone 1.2](milestone-1.2.md). The fake HTTP cookie/server are excluded from deployment.

Status: production specification plus tested local session/identity abstractions in backend/form_backend/sessions.py; no real Cognito integration. No user pools, policies, credentials or security settings have been changed. Scope is one private multi-user FORM backend with a future sharing boundary.

## Cognito and persistent browser session

**Product requirement: a valid session survives page refresh and browser restart.** Memory-only bearer-token storage is no longer the proposed experience. Refresh must restore the signed-in account and saved/pending workout state without asking for credentials again; explicit logout, revocation or an expired session may require sign-in.

### Reviewed options

| Option                                             | Refresh behavior                                               | Security/operational tradeoff                                                                                           | Decision               |
| -------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Browser memory only                                | Reload loses refresh capability                                | Small infrastructure footprint, fails workout usability requirement                                                     | Rejected               |
| Browser localStorage/IndexedDB bearer tokens       | Persists                                                       | JavaScript/XSS can read and exfiltrate long-lived credentials; encryption with a browser-readable key does not fix that | Not proposed           |
| JavaScript-readable token cookies                  | Persists                                                       | A cookie storage SDK does not provide HttpOnly protection; still exposes tokens to script                               | Not proposed           |
| Same-origin BFF and opaque HttpOnly session cookie | Persists without exposing Cognito tokens to browser JavaScript | Adds a server hop, session storage, CSRF controls and refresh concurrency handling                                      | Recommended for review |

Use Cognito Essentials managed login and Authorization Code Flow with **PKCE/S256**. A confidential app client belongs to the BFF; its client secret stays in a separate Secrets Manager secret. The BFF generates one-time state/nonce/verifier, stores the login transaction server-side for at most 10 minutes, binds it to a temporary HttpOnly login cookie, exchanges the code server-side and validates tokens before establishing a session. Only allowlisted relative return paths are permitted. No FORM password endpoint, implicit flow, identity pool or AWS keys in the browser. [AWS PKCE support](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html), [Cognito confidential-client guidance](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-security-best-practices.html).

### Session boundary and lifecycle

- Browser receives only an unguessable ≥256-bit opaque `__Host-form_session` cookie: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain attribute, persistent Max-Age capped by server expiry. It contains no JWT, subject or personal record. Store a SHA-256 hash of its random value as the lookup key, not the cookie itself.
- Store token bundles and principal binding **server-side** in Accounts AUTHSESSION items, protected by DynamoDB encryption, restricted BFF-role access and redacted logs. TTL is cleanup only; enforce idle/absolute expiry on every request. Cognito still authenticates users; the BFF stores application sessions, not passwords.
- Approved local default: configurable seven-day **maximum** app-session lifetime (superseding the earlier 30-day proposal), idle expiry capped at that maximum; target access tokens ~10 minutes and align future Cognito refresh validity with the approved session maximum. Activity may slide idle expiry, never the absolute cap. Cookie lifetime must match the remaining server limits. This supports routine refresh/restart without promising permanent login.
- `GET /auth/session` restores the account from the cookie and returns only safe profile/session metadata and a CSRF token. Tokens, client secret and verifier never enter browser responses, localStorage, IndexedDB, sessionStorage or URLs.
- The BFF forwards only allowlisted FORM API paths/methods, adding the server-held access token. Reject browser-supplied Authorization/owner headers, arbitrary upstream URLs and hop-by-hop headers; never build an open proxy. Downstream API Gateway JWT/scopes and domain ownership checks remain in force.
- Serialize refresh by session using a short conditional lease and token-generation CAS; configure a reviewed Cognito rotation grace period. Concurrent tabs must not revoke each other's valid session or overwrite the newest refresh token. A token-service outage returns retryable unavailability and preserves drafts, not an automatic logout. Refresh response-loss/crash recovery is an explicit test gate.
- Every state-changing BFF request, including logout, requires an exact approved Origin plus an account-bound CSRF token/custom header. Check Fetch Metadata when present and use JSON content types; SameSite alone is insufficient. OAuth callback validates single-use state/nonce/PKCE and login-cookie binding. Callback pages have no analytics/third-party scripts, use no-store and do not log the authorization-code query.
- Sign-out deletes/revokes the server app session, clears cookies/cache, revokes refresh capability and performs Cognito logout. Subsequent app-cookie requests fail immediately. A previously leaked access JWT may remain usable at the downstream JWT API until expiry; this residual window is not eliminated by Cognito logout. Account-disable checks remain server-enforced. [AWS revocation limitations](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html).

HttpOnly reduces token exfiltration; it does not prevent an XSS payload from making same-origin requests. Keep CSP, escaping, dependency review, CSRF protection and account-switch cleanup. Preserve unsent drafts under the original account during an expired session; authentication persistence must not be used as a substitute for durable workout writes.

### BFF placement and cost tradeoff — not deployment approval

Recommend a small **Python BFF Lambda** beside the domain Lambdas, with `/auth/*` and `/bff/v1/*` routed under the **same frontend origin**. The browser-facing route validates its cookie/CSRF in the BFF; it does not use the downstream bearer JWT authorizer. BFF→`/v1/*` calls do use the JWT authorizer. All browser data routes must deny missing/foreign/expired sessions. Same-origin routing must be proven for the selected frontend hosting; a static-only site cannot host a BFF by itself.

An alternative is Next.js server Route Handlers when hosting already supplies a compatible server runtime: fewer new hosting components, but Node hosting/runtime/security work and a revised estimate. Separate-origin cookies introduce CORS/third-party-cookie problems, so are not the default. No CloudFront/NAT/extra hosting stack is silently approved here. [Cost estimate](aws-cost-estimate.md) now includes a conservative Lambda BFF/API hop and server-session budget, and still excludes the undecided frontend hosting/routing bill. Python Lambda/API Gateway placement is now conditionally approved; finalize compatible same-origin hosting/callbacks before deployment. Persistent login and the seven-day default maximum are settled requirements.

### Private first release

**Invitation-only is required for the first deployment, not an optional default.** Disable Cognito self-registration (`AllowAdminCreateUserOnly=true`), omit public sign-up routes/buttons, and do not configure social/federated providers that could create uninvited accounts. A separately authorized operator invites a small explicit roster using Cognito admin creation. The ordinary BFF/domain runtime roles cannot create/invite users. Review email verification, first-login password change, optional TOTP, recovery, invitation expiry and offboarding. Cognito settings must reject direct unauthenticated SignUp calls, not merely hide the UI. [AWS user-creation policy](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-admin-create-user-policy.html).

Public registration/sharing remains disabled until a later explicit release approval with abuse/privacy/cost review. Private means restricted application membership; this proposal does not require a private VPC API or provision any network resources now.

## Enforce ownership at every layer

1. Construct `Principal(sub, scopes, pool, client)` exclusively from the validated API request context. Direct unit calls must provide an explicit trusted principal, never an arbitrary request owner.
2. Repository methods require principal as a nonoptional parameter and build tenant-prefixed keys internally. Handlers never accept raw PK/SK or a user ID query/path switch.
3. Verify the account is enabled; query owned records directly using caller keys. Foreign private IDs and absent IDs return the same 404 shape. Do not fetch globally by ID and rely on UI filtering.
4. Verify **all nested references**: template→exercise, session→template/entry/group/side, recipe→food/version, diary→food/recipe, cursor→query, operation→job. Catalog reads are explicitly allowlisted; catalog mutation is never a user's action.
5. Check parent publication/generation state before exposing children. A guessed staged or foreign generation/set ID cannot bypass root ownership or immutability.
6. Reject ordinary write owner/system/revision/timestamp/snapshot fields. Import routes have separate DTOs that bind every record and nested snapshot to the authenticated destination or system provenance after validation. Retain original owner labels only in private import provenance.
7. Authenticate before checking private revisions/idempotency receipts. Receipt/cursor/operation namespaces include the caller; B cannot replay A's request key to retrieve a response.

Local `ownerId=local-demo-user` checks remain prototype guards, not production authorization. Stable IDs and UUID unpredictability are not access controls. Per-user partitioning prevents many accidental cross-user queries but does not replace tests and code review. There are no cross-user admin data APIs in the first cloud milestone.

## Planned IAM boundary

This is a permission design, **not an executable IAM policy**. Exact resource ARNs and SDK call-derived policies will be reviewed once Python handlers exist. IAM cannot automatically substitute a Cognito JWT subject into a shared Lambda role's DynamoDB LeadingKeys condition. The application still enforces each user's namespace.

| Principal                 | Allowed data surface                                                                                                                                                     | Excluded                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| BFF Lambda                | Accounts AUTHSESSION/login/session-reference item operations and account-state reads; confidential-client secret read; own logs; allowlisted HTTPS calls to Cognito/FORM | Training/Nutrition/Catalog data writes, user invitation, IAM, arbitrary URL proxying |
| Accounts Lambda           | Accounts item reads/writes/conditions/queries, own logs, cursor secret read if pagination needed                                                                         | Training/Nutrition/Catalog writes, IAM, table management                             |
| Workouts Lambda           | Training item operations + GSI1 Query, Catalog read, Accounts PROFILE read for account check, own logs, cursor secret read                                               | Nutrition data, catalog writes, Scan, account administration                         |
| Nutrition Lambda          | Nutrition item operations/Query, Catalog read, Accounts PROFILE read, own logs, cursor secret read                                                                       | Training data, catalog writes, Scan                                                  |
| Import Lambda             | Accounts/Training/Nutrition scoped item operations and required indexes, Catalog read, own logs                                                                          | Catalog mutation, infrastructure/IAM, cross-account operations                       |
| Catalog seed role/tool    | Versioned Catalog seed writes only, separately approved release process                                                                                                  | Private user tables                                                                  |
| Cognito email integration | Approved SES sender identity/conditions only                                                                                                                             | Application DynamoDB tables                                                          |
| Future deployment role    | Separate environment-scoped CDK deployment authority, reviewed trust boundary                                                                                            | Never available to browser or runtime handlers                                       |

Item permissions are limited to necessary `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, `ConditionCheckItem` (and batch actions only if actually used); exact tables and GSI ARNs, not `Resource:*`. `TransactWriteItems` is an SDK API whose underlying item permissions must be granted; do not invent a `dynamodb:TransactWriteItems` IAM action. Use transactions and the relevant item actions. Confirm SDK call inventory with IAM Policy Autopilot during implementation before finalizing policies; validate actions against the [DynamoDB service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_dynamodb.html). Pre-create log groups so roles only need their own `CreateLogStream`/`PutLogEvents`; domain secret reads are restricted to the cursor-signing secret; only the BFF reads its separate confidential-client secret. Use reviewed DynamoDB LeadingKeys namespace restrictions to exclude AUTHSESSION#/LOGIN# from domain/Import roles while permitting their USER# records; this is namespace isolation, not automatic per-user authorization. BFF session lookup keys are a narrowly scoped credential-resolution exception to user-prefixed application keys, never accepted by private domain endpoints. Production runtime roles have no DynamoDB Scan, export, backup, delete-table or IAM powers. Restore/export/deletion maintenance uses a separately reviewed operator role.

CDK uses L2 constructs, scoped grants reviewed for excess actions, environment-separated tables/user pools, resource retention, encryption at rest and TLS. AWS-owned DynamoDB keys avoid a fixed customer-key charge initially; customer-managed KMS keys require a specific compliance need and revised costs. Secrets Manager encrypts cursor keys, uses key IDs and an overlap window during rotation, and is cached in warm Lambda containers without user state. No credentials in repository or frontend bundles. Lambda clients may be reused globally; user records and authorizations may not.

## Privacy, sharing and abuse

Browser-facing nutrition/workout/profile routes require the BFF session; downstream APIs require Cognito access JWTs. Both use `no-store`. CORS permits approved frontend origins/methods/headers, including Authorization/If-Match/Idempotency-Key, and exposes ETag/Location/request IDs. OPTIONS must work without login. CORS is a browser policy, not authorization; direct HTTP clients must still fail ownership checks. Escape user text in React, reject unsafe URL schemes, and apply CSP appropriate to the chosen hosting environment. The backend does not fetch arbitrary demo/source URLs, preventing SSRF from that field.

A future public-template feature must **publish a sanitized copy** into a separate public collection/table after an explicit action. Allowlist title, prescribed plan and approved exercise descriptions/metadata only. Exclude owner IDs, set logs, session IDs, private notes/history, source links containing private tokens and private custom metadata not explicitly selected for sharing. A template's local `visibility` flag alone publishes nothing. Public IDs must not provide private-table lookup paths. Revoke/unpublish and clone must be designed before hosted sharing is enabled.

Account switching is a confidentiality boundary: cache and pending queues are keyed by environment+sub, responses from A are discarded after switching to B, URL IDs are revalidated under B, and old views are unmounted. Retain legacy local originals in place with an explicit local recovery entry point; never automatically display/import them to whichever user signs in next. Cloud logout clears cloud UI/cache, not legacy storage. Browser-local prototype data remains plaintext and device-accessible; cloud authentication cannot retroactively protect that old storage. Explain this in the opt-in migration screen.

Use request/body size limits, bounded analytics ranges, per-sub write/import limits, route throttles, operator-approved invitations and budget alerts. Registration/email abuse and request flooding can still cost money; no budget alarm is a hard spending cap. HTTP API has no direct WAF integration assumed here; if that becomes necessary review the API product/edge and bypass protection. Do not bolt on a paid edge stack without its own threat/cost justification.

## Required two-user authorization tests

The local two-user/fake-session subset is executed in backend/tests/test_foundations.py. The real gateway/Cognito matrix below is **not executed against AWS**. Unit tests of key builders are necessary but insufficient: acceptance requires real A/B browser sessions through the BFF and negative direct-token tests through the configured gateway in an explicitly authorized isolated environment.

| Case                   | Action with user B after A creates private fixtures                                                                                 | Required assertion                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| All resource IDs       | GET/PATCH/archive/delete A's exercise, template, session, set, food, recipe/version, diary, goal resource                           | 404 for foreign private IDs on ID-addressable routes; identity-only routes return B's data only; no writes to A; A's revisions/digests unchanged |
| Nested references      | Create B template/session referencing A custom exercise/template; B recipe referencing A food; B diary referencing A recipe version | Reject inaccessible reference without returning A data; no partial creates                                                                       |
| Owner injection        | POST/PATCH with ownerId=A, nested ownerSub=A or raw PK/SK, including imports                                                        | Reject normal DTO fields; import ownership stays B; never writes A partition                                                                     |
| Side/history boundary  | Target A entry/group/set/generation through B's session path or a guessed completed generation                                      | 404; no side changes, no frozen history rewrite                                                                                                  |
| Lists/analytics        | B query A date/exercise IDs; manipulate pagination last key/filter/subject                                                          | No A rows/counts/metadata; tampered cursor 400, inaccessible private IDs 404                                                                     |
| Receipts/operations    | Reuse A idempotency key/import ID/chunk/operation cursor under B                                                                    | No cached A response/progress; B namespace independent                                                                                           |
| Public/shared          | Export/publish intent on private A template; anonymous/other-user query                                                             | No private payload; later public DTO excludes all forbidden fields                                                                               |
| Account switch         | A has pending save/fetch, logout, B login, A response arrives                                                                       | No A content in B view/cache; pending A write not sent with B token                                                                              |
| Token enforcement      | No token, expired/tampered token, ID token, wrong client/pool, missing scope                                                        | 401/403 before handler data operations; verify disabled account as well                                                                          |
| Cross-device conflicts | Two A devices update same session/day entry from revision r; identical retry after response loss                                    | Exactly one conflicting mutation succeeds; other 412, identical retry replays one result                                                         |

Run the resource matrix in **both directions** and include list/count/export paths, not only GET-by-ID. Capture expected status and before/after owned hashes without dumping private payloads in CI logs. Separate tests verify missing IDs and foreign IDs have the same public shape. Backend unit/integration tests must demonstrate that every repository query includes an authenticated scope.

Additional release tests: refresh/restart while logging preserves authentication and completed/partial sets; access expiry refreshes transparently; concurrent-tab token refresh is safe; logout/idle/absolute expiry clears the session; CSRF/cookie fixation/tampered callback fail; temporary Cognito failure retains drafts; direct SignUp is disabled and an uninvited account cannot enter. These remain specified tests, not executed backend evidence.

Before real users, approve privacy notice, retention, user export, account deletion and backup expiry. Deletion must disable writes/revoke refresh, enumerate and purge every owned partition/index/operation, handle retries and verify no live data remains; retained PITR backups expire on their documented schedule and must not resurrect a deleted user after restore. This lifecycle is a public-launch blocker, not a claim of completed compliance.

## Milestone 1 code and verification boundary

Production entrypoints are `form_backend.aws.runtime.bff_handler` and `domain_handler`.
The Cognito adapter uses pinned managed-login/issuer origins, confidential exchange,
PKCE, RS256 JWKS verification and access-vs-ID token, nonce, client, scope, email and
expiry checks. Invite-only policy is enforced in CDK (`AllowAdminCreateUserOnly=true`);
no runtime invitation permission or social provider is configured. Real Cognito managed
login has not been exercised. Locally generated RSA keys and simulated endpoints test
success and negative verification cases.

LOGIN state is durably one-use and bound to an HttpOnly login cookie. AUTHSESSION stores
tokens server-side under a hash of a random opaque cookie; Accounts encryption and
separate IAM LeadingKeys namespaces isolate BFF credentials from domain data handlers.
Seven days is the hard configurable maximum, never extended by refresh. Shorter idle
configuration may expire conservatively; no sliding activity-extension write is claimed.
Refresh leases use conditional revision fencing; a logged-out worker cannot resurrect a
session. Lost/failed refresh retries wait for lease expiry within a 60-second Cognito
rotation grace period. CSRF checks occur before refresh. Logout does not require a
successful refresh: local revocation and a durable revocation-outbox write happen before
contacting the provider, with an hourly retry worker.

The BFF emits no-store responses, checks exact Origin + CSRF on mutations, forwards only
allowlisted routes/headers, and labels private responses with server-derived
`X-Form-Subject`. The opt-in CloudClient rejects mismatched subjects, clears account
caches, aborts old requests and broadcasts invalidation across tabs without touching
prototype browser keys. It is not yet selected by existing app screens. Cloud UI
selection and real browser A/B tests are deployment acceptance requirements.

Review the [sanitized AWS status](aws-public-status.md) for cloud verification limits.
Local tests do not establish deployed authorization or live session guarantees.
