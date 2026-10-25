# FORM infrastructure definitions

CDK infrastructure definitions for the FORM application. Account-specific IAM policies,
pilot configuration, and live deployment evidence are intentionally excluded from this
public repository. No bootstrap, deployment, policy attachment, user invitation or asset
publishing is authorized. See the approval gates in
[the sanitized AWS status summary](../docs/aws-public-status.md).

Prerequisite: existing pinned Python 3.13 arm64 asset in `backend/lambda-dist` (rebuild
following [backend/README.md](../backend/README.md) after backend source changes).

```bash
npm run typecheck --prefix infra
npm run test --prefix infra
npm run synth --prefix infra
python infra/scripts/cost-estimate.py
```

Synthesis is `--no-lookups --strict`, with no Docker or account queries. cdk-nag v3 uses
`Validations` with documented acknowledgments. Generated outputs are ignored. Deployment
must be separately reviewed and approved.

The website uses its generated CloudFront HTTPS domain and default certificate. No hostname,
ACM certificate or DNS parameter is needed. The API resource and distribution precede the
Cognito client; the generated domain feeds callbacks, logout and both APP_ORIGIN values
without a dependency cycle. An infrastructure test traverses the generated dependency graph.

Future parameters: **AlertEmail is mandatory without a default**; BudgetDollars is fixed
to 10; SessionMaximumSeconds defaults to 604800, range 300–604800. Validate and confirm the
SNS email subscription and budget recipient before admitting users. Default-certificate
TLS policy limitations require explicit acceptance; see the deployment review.

Application: 57 resources; separate operator-owned deployment support: 16. Four retained,
encrypted, PITR/deletion-protected tables, private Cognito, BFF/domain Python Lambdas,
HTTP API, durable sessions, cursor secret, private S3/OAC and CloudFront, 15 alarms,
SNS email, three 30-day logs, hourly revocation retry rule and retained $10 account budget.
Private routes disable caching, override viewer no-store headers and set all configurable
error TTLs to zero. No VPC/NAT, provisioned concurrency, public signup, import publication,
invitation Lambda is included. Milestone 1.2 adds explicit cloud UI selection using the
same-origin routes; local data remains the default and no hosting is deployed. The fake
integration server is never a deployment asset. See [Milestone 1.2](../docs/milestone-1.2.md).
