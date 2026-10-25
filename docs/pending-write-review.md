# Milestone 1.2 — pending-write reliability review

October 18, 2026 (America/Los_Angeles). Local changes and tests only; no AWS, IAM,
deployment, bootstrap, invitations or real-user migration.

## Finding and correction

The original `CloudController.pending`, in-flight targets, `CloudWorkspace.mutations`
idempotency keys and start request existed only in memory. Refresh could lose edits or
the exact retry identity after the server committed but its response was lost.

`lib/cloud-pending.ts` now stores a versioned recovery journal under
`form-cloud-pending-v1:<encoded authenticated subject>`. It uses the existing
`lib/persistence.ts` snapshot comparison under an exclusive account Web Lock and verifies
writes by reading them back. Prototype workout/nutrition keys and migration sources are
never read, rewritten or cleared by this mechanism.

The journal contains the original server baseline/revisions, current immutable in-flight
batch, newer queued targets, stable mutation fingerprints/UUID keys and any pending
workout-start payload. Acknowledged diary IDs/revisions are retained so existing entries
cannot be mistaken for new creates. Completed historical collections are omitted to reduce storage;
normal refresh after recovery restores the full normal history range from the server.
Cloud data/ownership and journal envelopes are validated before writes and recovery.
Malformed/foreign/oversized or unexpectedly changed journals are preserved, not reseeded.

## Durability and replay rules

1. An edit synchronously persists its target before the input event returns. Every
   mutation persists its exact key, payload derivation and precondition before HTTP starts.
2. The active batch is separate from later edits. A lost response cannot replace its
   original target with a newer target or silently change its expected revision.
3. Mutation keys remain until the complete batch is acknowledged and its journal clears.
   A server commit followed by response loss, browser refresh or failure to clear device
   storage replays the original request/receipt. New creates retain their original IDs;
   recipe edits and completion retain the original version-producing request.
4. Recovery first requires a verified BFF session for the same subject. It displays
   **Pending**, pauses edits and requires explicit Retry. It never silently rebases onto
   newly fetched revisions. A stale revision produces a conflict and keeps the journal.
5. Successful acknowledgement clears only that account's journal. Explicit discard/reload
   requires user confirmation. A private recovery download includes pending display data
   and available journal metadata; it is not an implemented import/publish endpoint.

The UI distinguishes **Saved on server**, **Saving to server**, **Pending — saved on this
device**, **Failed — pending edits kept on device**, storage failure and revision conflict.
If storage is unavailable/full, no new mutation is sent; the UI blocks further edits,
warns that the newest changes may be memory-only and offers a download/retry. It never
claims successful device recovery for a failed storage write.

## Account and tab boundaries

- The journal key comes only from authenticated session discovery. Only that key is read;
  foreign-account journals are not enumerated or displayed. Server identity still controls
  all backend ownership independently of local data.
- One tab holds the account write lock. Other tabs show server records read-only and can
  acquire the lock after the writer closes by retrying discovery. Unsupported Web Locks
  disable cloud editing; there is no unsafe concurrent-write fallback.
- Logout, expiration and account switching cancel old requests, unmount private views,
  release the writer lock and retain the original account's journal. Reauthentication as
  that account can recover it. Signing in as B never displays or uploads A's pending data.
- New accounts get independent journals. Epoch checks prevent a late A response from
  clearing A's retained journal or populating B's state. Prototype mode remains independent.

## Local storage limitations and privacy

This is recoverable device storage, not a guarantee against browser-data deletion,
eviction, private-mode cleanup, disk failure or malicious extensions. Each journal is
limited to two million characters; very large records fail visibly rather than truncate.
Storage denial/quota failures pause saving. The pilot should use supported current browsers
and avoid private browsing for pending-write recovery.

Pending records are **plaintext private data on this browser profile**, accessible to
same-origin JavaScript and someone with device/profile inspection access. No Cognito
tokens, cookies, CSRF values or credentials are stored in the journal. UI/account binding
does not provide encryption or protect against XSS/physical profile access. Sign-out hides
records but intentionally retains pending changes until saved or explicitly discarded.
Review this retention/shared-device policy before inviting real users. Encrypting data with
a key stored beside it would not solve same-origin/XSS exposure.

This bounded pending-write journal is not a general offline synchronization/merge engine.
Recovery needs online session verification and server writes; conflicts require review.
Existing loaded-range analytics, transaction-size limits, import/public-sharing gaps and
Milestone 1.1 deployment/security prerequisites remain unchanged.

## Verification and preflight recommendation

**Passed:** 126 backend, 54 frontend, 16 cloud Chromium, 21 prototype Chromium and
16 infrastructure tests; zero remaining failures. Lint, both TypeScript checks,
Ruff/format, Mypy, generated-contract drift check, production/static builds and offline
CDK/cdk-nag synth pass. Runtime asset source matching and AArch64 packaging checks pass.

Local validation records are intentionally excluded from this public repository. Tests
cover pre-debounce edits, failed writes, refresh/tab closure, lost server
acknowledgements, ordered batches, create/completion/recipe replay, conflicts, quota,
corrupt/foreign data, cross-tab leases, expiration/logout and A/B isolation.

The backend's existing two-worker test initially exposed Moto's whole-table rollback
race. Its test-only commit step now serializes Moto transactions after the competing
requests' read barrier. Assertions still require one successful update, one conflict and
the preserved new revision. DynamoDB Local does not use this simulated lock and was not
rerun in this follow-up. Production adapters still use DynamoDB conditional transactions;
simulator commits are not evidence of actual AWS concurrency, IAM or propagation behavior.

The local implementation is ready for **controlled AWS preflight review**, not
approval to provision or proof of live pilot readiness. Preflight must review browser
storage retention/shared-device expectations, alert recipient, account-specific IAM,
CloudFront TLS/security exceptions, dependencies, current assets and the controlled
Cognito/DynamoDB/arm64/cross-device acceptance plan. No live AWS validation is claimed.
