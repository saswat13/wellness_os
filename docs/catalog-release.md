# Catalog release runbook

This runbook does not grant deployment permission. Execute only after the user has
explicitly authorized the catalog release in the active session, using existing
operator authentication and private deployment configuration. No infrastructure,
IAM, role, runtime-capacity, private-data or existing-history changes are required
by the application patch. Do not create resources or expand permissions to work
around a denial.

The tested release adds 400 exercises and 400 foods. Read
`backend/catalog/launch-v1/README.md`, including the pinned USDA-mirror provenance
caveat and `validation.json`. The official USDA archive cross-check is outstanding;
keep that caveat in the release report. Do not represent mirror checksums as official
USDA verification.

## 1. Use the existing target and profiles

Preserve private configuration and local changes when fetching this branch. Verify
STS account identity, existing domain Lambda, current integration routing, existing
catalog table, website bucket and distribution from private stack/configuration
evidence. Do not guess ARNs, create profiles/roles or use root credentials.

Use the already-configured deployment and website-publisher roles where authorized.
The role that could update only the BFF may not be allowed to update the domain
Lambda or seed catalog rows. Try the existing authorized operator path; report the
exact action/resource/error for any actual denial rather than repeating sign-in or
requesting generic administrator access.

## 2. Release domain model support first

An older strict domain backend cannot decode the new catalog fields. Before seeding:

- Preserve the current **domain** Lambda ZIP privately; verify its checksum against
  Lambda's reported code hash and record its revision and routing metadata.
- Compare `form_backend/models.py` in that ZIP with the release parent's version.
  Review/reconcile any live differences, preserving private or newer source changes.
- Apply only the additive model patch from this release: the `Aliases` declaration,
  exercise `aliases`/`external_id`/`source_info`, and food `aliases`/`external_id`.
  All new fields have defaults. Verify the resulting diff and ZIP entries.
- Retain every other deployed module and native dependency. In particular, preserve
  the live BFF GET-body fix and logging changes. Do not replace either function
  with a whole public-repository ZIP without reconciling live source first.
- Update the existing domain function with its verified revision ID, wait for
  success, and verify the deployed code hash. Use the existing reviewed release
  workflow instead if its integration is pinned to a version/alias.

The handler uses the model module's dynamic API/read-model registry; new table
payload support needs no new endpoint. The importer library/scripts and source
bundles run in the operator environment, not inside Lambda. The already-working BFF
requires no code change for this release.

## 3. Publish the updated frontend

Build once with `npm run build:static`. The completed unit/browser/backend checks
are recorded in the bundle validation report; do not repeat unchanged suites as a
prerequisite to publication.

Use the existing website-publisher workflow. Upload hashed assets before HTML,
retain old assets for open tabs, preserve the existing website target and use the
established HTML cache policy. Do not use `--delete`. Request an invalidation only
through an already-authorized existing path. If it is denied, report it and verify
whether live HTML/assets nevertheless match the new build; do not change IAM merely
to clear a cache.

## 4. Dry-run, then seed the existing catalog

From the repository root, resolve the exact existing catalog table and authorized
operator profile from private configuration. A dry-run queries only the two shared
catalog partitions and reads target keys; no private partitions or scans are used.

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/seed_catalog.py \
  --dry-run --region REGION --profile OPERATOR_PROFILE --table EXISTING_CATALOG_TABLE
```

Review the plan. Unmanaged collisions, duplicate shared identities/names or modified
payloads stop before writes; preserve them and investigate rather than deleting or
adopting rows. Once the plan and target are verified and the release is authorized:

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/seed_catalog.py \
  --apply --region REGION --profile OPERATOR_PROFILE \
  --table EXISTING_CATALOG_TABLE --confirm-table EXISTING_CATALOG_TABLE \
  --expected-account VERIFIED_ACCOUNT
```

This needs existing operator access to STS identity verification and DynamoDB Query,
GetItem and PutItem on the catalog table only. A denial is not permission to modify
IAM. The tool uses importer ownership, content hashes and conditional writes, never
clears a partition, and never merges/deletes existing rows. It may stop after partial
progress if a concurrent conditional write fails; inspect and rerun idempotently.
No 800-row atomic transaction is claimed. The same command after success must report
800 unchanged managed entries, not increment every record's revision again.

## 5. Verify the authenticated product

Use the actual signed-in browser, never copied cookies/tokens or an unauthenticated
probe as acceptance. Follow every `nextCursor` on the existing exercise and food
list endpoints. Require all 400 `freeex-` exercise IDs and 400 `usda-fdc-` food IDs
from this bundle to be present exactly once, with system ownership and source IDs.
Existing custom/other catalog records may make total collection counts larger.

Verify the live frontend loads, exercise search `DB incline curl` finds the launch
entry, Foods search `chana cooked` finds chickpeas with source attribution, and source
ID search `168877` finds dry raw long-grain rice. Verify cooked rice is a distinct
record. Confirm there are no new 503s or console/runtime errors. Preserve user data:
exercise functional reads/search first, and use explicit test entries only if the
user has authorized creating them. Do not clear pending journals or localStorage.

Report exactly which code, assets and records were released, count live API results,
retain rollback ZIPs privately, and list any actual remaining blocker. Once rows use
the new fields, do not roll the domain model back to an incompatible strict schema.
A recovery should preserve the additive decoder or use a forward correction; never
delete catalog rows that user snapshots may reference merely to roll back code.
