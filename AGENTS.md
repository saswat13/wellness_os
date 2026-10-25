# Workspace instructions

At the start of a new session, read docs/HANDOVER.md for the current milestone,
evidence, environment caveats and approval boundaries. Treat it as a snapshot to verify
against current files and the user's latest instructions, not authorization to provision.

Build the Fitness & Nutrition Tracker with Next.js, TypeScript and Tailwind. Preserve unrelated files, including the existing AWS CLI installer. Current milestone is a local hypertrophy frontend only: do not deploy, provision AWS, change IAM or incur cloud charges. Keep planned targets separate from logged results. Label fabricated history as mock data. Use accessible mobile touch targets and explicit left/right logs. Run npm run lint, npm run typecheck, npm test and npm run build after meaningful changes. Keep docs/requirements.md, architecture.md, tasks.md and progress.md current. Future authentication must isolate every user's data on the server; local storage is only prototype persistence.

Exercise and template management is now part of the local prototype. Use lib/models.ts for live models and lib/tracker.ts for mutations. Never use exercise names as IDs. Library and template changes must not rewrite session snapshots or historical sets. Keep session-only edits separate from explicit template saves. Archive referenced exercises rather than deleting them. Preserve storage migrations and run both npm test and npm run test:e2e for domain/UI changes. Sharing must use the allowlisted template export and never include private sessions, set logs, workout notes or owner IDs. Client-side mock ownership guards are not production authorization.

Unilateral sets use stable groupId on separate L/R records. Use lib/unilateral.ts for grouping, counts and mutations. Completed set counts require both sides; volume includes every completed side and must retain partial contributions. Never infer pairing from row position outside legacy migrations, copy a missing side from its partner, or rewrite historical mode/values. The sameWeight preference copies weight edits only within a pair; loading history or toggling it must not equalize existing values. Keep v1/v2 migration keys intact. History and analytics must include original side completion/RPE and exclude partial pairs from matched-pair comparisons.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

The current milestone is a complete local workout and nutrition prototype. Preserve the unified Home/Workouts/Nutrition/Progress/Settings navigation and existing unilateral behavior. Nutrition models and operations live in lib/nutrition.ts; foods, recipe ingredient definitions and diary snapshots must remain separate. Food/recipe edits must never rewrite logged nutrition. Gram calculations use unrounded values internally and finished recipe yield must be positive. Keep explicit raw/cooked/dry/packaged distinctions. Goals and profile belong to the mock user; do not treat local ownership guards as production authorization. Nutrition uses form-nutrition-v1 independently of workout migrations; invalid data is preserved with a warning. Run all domain and browser checks. Production builds use Next's supported Webpack option to avoid Turbopack worker-port restrictions in this environment.

For audited persistence, use lib/persistence.ts and app/hooks/use-snapshot-persistence.ts. Validate complete snapshots before writing, serialize cooperating tabs with Web Locks where available, and pause stale/failed writes instead of overwriting newer records. Preserve existing storage keys and migration sources. Recovery downloads contain private local records and must remain user-initiated downloads. Date navigation dismisses old diary drafts; editing an entry keeps its original nutrient snapshot. New generated set reps must fit the schema even when targets are free text. Keep the shared browser console/runtime fixture enabled for UI tests.

Milestone 0 backend foundations are authorized locally under backend/. Preserve the frontend/browser stores. Use the strict Python models, trusted Principal boundary, repository protocols and local atomic unit of work; never construct identity from client owner fields or unverified bearer tokens. The fake issuer/memory session coordinator is test-only and must not be deployed. The approved future target is us-east-1, same-origin HTTP API/Python Lambda BFF, server-held Cognito tokens, Secure HttpOnly cookies, invitation-only enrollment and a configurable seven-day maximum session lifetime. Run the backend unittest suite, Ruff and existing frontend checks; backend/README.md has commands and boundaries. Regenerate contracts/openapi-v1.json from the executed route/model registry after contract changes. Preserve raw migration sources; preflight is not a cloud import. No AWS provisioning, IAM change or deployment is authorized in Milestone 0.

Milestone 1 adds local AWS integration adapters under backend/form_backend/aws and offline CDK under infra. Production entrypoints must never select the fake identity provider or memory repositories. Derive tenant keys from verified Principal only; atomically commit revisions and durable receipts. Active draft row changes share the root CAS transaction; completed generations stay immutable. Runtime code must not accept request-selected AWS endpoints. Tests may target Moto or the explicitly allowlisted loopback DynamoDB Local emulator with fake credentials. Keep cloud transport opt-in, invalidate private state on account changes, and never import/clear localStorage implicitly. Rebuild the Python 3.13 arm64 asset after backend edits; run Python tests, Ruff/Mypy, all frontend checks, infrastructure tests and offline cdk synth. No bootstrap, deployment, real IAM change, migration or AWS spending is authorized. Provisioning requires separate explicit user approval.

Pending cloud writes now use lib/cloud-pending.ts and the separate form-cloud-pending-v1:<authenticated-subject> journal. Persist targets and exact mutation keys/preconditions before HTTP; keep the active batch separate from newer edits and retain keys until the whole batch is acknowledged. Recovery requires that account's verified session and explicit retry; navigation/background reads must not trigger replay. Never silently rebase conflicts, clear journals on logout/expiration, inspect another account's journal or alter prototype keys. Keep the checkpoint's acknowledged entity IDs/revisions, including existing diary entries. Use the shared snapshot comparison plus an exclusive account Web Lock; other tabs are read-only. Storage failure must pause writes and expose a private download without claiming durability. Journals contain private device data, never tokens/cookies/CSRF credentials. Preserve invalid data and run recovery, lost-acknowledgement, conflict, two-user and browser closure checks.

<!-- BEGIN AWS Agent Toolkit rules -->

# AWS Guidance

- Where these AWS rules conflict with the project's own instructions, the
  project's instructions take precedence.
- Prefer the AWS MCP Server for AWS interactions — it provides sandboxed
  execution, observability, and audit logging. If unavailable, use the
  AWS CLI directly.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.

<!-- END AWS Agent Toolkit rules -->
