# Authenticated food-loading failure

## Current evidence

The browser calls `/api/v1/nutrition/foods`; the BFF forwards it to the domain API
at `/v1/nutrition/foods`. The collection reader queries the user's custom foods,
then follows a signed cursor to read the shared catalog. An empty collection is
a successful response, not a reason to seed, delete or migrate application data.

The BFF parser substitutes `{}` for an absent body. Before this patch, HTTPX sent
that synthetic body upstream on GET requests. The patch removes GET payloads at
the forwarding boundary and retains mutation payloads, authentication and queries.
Its regression test fails before the patch and passes afterward.

`REQUEST_FAILED` is the frontend fallback for responses without FORM's
`error.code`, including generic gateway errors. It does not establish a DynamoDB
failure or prove that GET forwarding caused the reported live 503. Deployment
and live acceptance remain unverified.

## Diagnose from the authenticated deployment environment

Use the existing AWS CLI browser-login profile. Never copy its credential cache,
login exchange codes, cookies or tokens into GitHub, chat or this repository.
Account-specific values belong in the existing private deployment configuration.
Verify `aws sts get-caller-identity --profile <profile> --region <region>` against
the intended account before any change. Do not create another identity or role.

While signed into the deployed site, reproduce the error once in DevTools.
Record the UTC time, status, response body shape and response correlation headers:
`x-request-id`, `apigw-requestid`, `x-amzn-requestid`, `x-amz-apigw-id` and
`x-form-subject`, when present. Do not export an authenticated HAR or Copy as cURL.

In the existing BFF log group, filter for `request_failure`. A
`layer=bff_upstream` record gives the domain gateway request ID. Correlate it
with the existing HTTP API access logs and domain Lambda logs. For example:

```bash
aws logs filter-log-events --profile <profile> --region <region> \
  --log-group-name <existing-bff-log-group> \
  --filter-pattern '"request_failure"' --limit 30 \
  --query 'events[].{time:timestamp,message:message}' --output table
```

- `layer=bff` / `INVALID_CONFIGURATION`: inspect the existing server-only origin
  configuration, without printing credentials.
- `layer=bff_upstream` with an unstructured response: investigate the correlated
  gateway/integration failure; verify the GET payload on the deployed BFF code.
- Structured `STORAGE_UNAVAILABLE`: inspect the domain's `dynamodb_failure`
  category and AWS error code. This requires storage-specific diagnosis.
- `layer=domain`: inspect its safe exception category and correlation ID.
- Missing Lambda records: use gateway logs and deployed code metadata; absence
  alone does not prove that a particular handler or dependency failed.

## Conditional code-only release from Codespaces

Use the existing private deployment workflow if it supports a reviewed BFF-only
release. Do not run a broad CDK deployment from this public checkout: it excludes
account-specific configuration. Do not run bootstrap, change IAM or touch tables.

For a direct code-only update, first obtain the existing function's runtime,
architecture, handler, revision ID and code SHA (not its environment values), and
verify which version/alias the existing integration invokes. Download the current
deployment ZIP using its short-lived `get-function` download URL without logging
that URL. Preserve the ZIP privately, verify its base64 SHA-256 against
`Configuration.CodeSha256`, and retain the current routing/version metadata.

Before replacing anything, compare `form_backend/aws/runtime.py` from the live ZIP
to the patch's base commit. If it differs, stop and reconcile the deployed source;
do not overwrite private or newer application changes. Otherwise, make a candidate
ZIP by replacing only that module with this branch's patched module, retaining all
other deployed files and dependencies. Inspect the module diff and ZIP entry diff.

Only after access, diagnosis, intended diff and deployment routing are verified:

```bash
aws lambda update-function-code --profile <profile> --region <region> \
  --function-name <existing-bff-function> \
  --revision-id <verified-current-revision-id> \
  --zip-file fileb://<verified-candidate-zip> \
  --query '{FunctionName:FunctionName,CodeSha256:CodeSha256,LastUpdateStatus:LastUpdateStatus}'
aws lambda wait function-updated-v2 --profile <profile> --region <region> \
  --function-name <existing-bff-function>
```

This updates `$LATEST`; it does not move a pinned alias or version. If routing is
pinned, use the existing reviewed release process instead. Never change routing
merely to bypass that process. Retain the previous ZIP for rollback using the then
current revision ID. Code rollback does not require restoring application tables.

Verify the deployed code hash, then refresh the signed-in Nutrition screen. Require
HTTP 200 for the initial foods page and all continuation pages, rendered food data,
and no new correlated backend errors. Do not claim acceptance from an unauthenticated
401, an empty page without following its cursor, or a successful Lambda update alone.
If 503 persists, preserve the correlation evidence and stop attributing it to the
GET-body defect until the failing layer is established.
