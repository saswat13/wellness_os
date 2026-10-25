# AWS cost estimate — Milestone 1.1

Milestone 1.2 adds no infrastructure resource or service. It uses the existing Training
GSI1 for active pointers and coalesces UI edits before saving. The planning estimates
below remain unchanged, not newly confirmed pricing or measured cloud consumption.
Active-pointer writes, history pagination and session polling must be included when
measuring the pilot's actual requests/capacity. The account alert remains $10; no spending
or deployment is authorized.

Planning estimate only, October 17, 2026 (America/Los_Angeles). USD/us-east-1, one
private-pilot environment. No account pricing, free allowance eligibility or bill was
queried. **No spending authorization.** These figures supersede the Milestone 1 $1.22/$9.65/$87.08 scenario.
Milestone 1.1 corrects monitoring to 15 alarms and includes the separate CDK asset bucket.
Immutable history and durable receipts remain included in storage/read/write allowances.

| Monthly active users | Cognito and CloudFront allowances available | Both allowances already consumed |
| -------------------: | ------------------------------------------: | -------------------------------: |
|                    2 |                                   **$2.13** |                        **$2.18** |
|                  100 |                                  **$10.56** |                       **$13.14** |
|                1,000 |                                  **$88.00** |                      **$113.80** |

These are expected-workload estimates, not caps or confirmed account charges. Taxes,
CI/CD, developer environments, real restore drills, unusual abuse and paid support are
excluded. The default CloudFront hostname/certificate requires no domain, Route 53
hosted zone or customer ACM certificate; none is provisioned. A later custom domain is
a separately approved and costed change.
At 1,000 users use a reviewed alert threshold around $125 rather than assuming the old
$100 proposal covers retained receipt growth. The synthesized pilot default remains $10.

## Workload assumptions

Per MAU/month: 20 active days, approximately 20 workouts, 160 meal entries and library/
history/goal activity; 2,000 browser API requests and 300 static requests. Conservatively
count two HTTP API calls and two Lambda invocations per browser API request. Domain
Lambda averages 512 MiB × 200 ms; BFF 512 MiB × 300 ms. No provisioned concurrency/NAT.

Allow **40,000 billed WRU and 40,000 RRU per user-month**, including transactional
rounding, snapshot source checks, day/root revisions, receipts, indexes and sessions.
Active draft changes write only changed rows; completed generations are copied once.
Batch/coalesce field edits rather than saving every keystroke. This is not a measured
cloud workload: actual consumed units and Lambda duration must replace the assumptions.

At month 12, retain **96 MB/MAU including indexes, 80 MB protected base data**, plus
20 MB shared overhead. The continuing-cohort assumption includes retained original
responses and immutable versions, and does not delete old or inactive user histories.
Storage grows with cumulative usage, not just current MAU. Abandoned staged generations
also need audited cleanup; there is deliberately no TTL on historical sets or receipts.

Logs: 8 MB/MAU/month, 30 days. Viewer egress: 100 MB/MAU including API/static payloads;
2,300 CloudFront viewer requests/MAU. S3: 0.5 GB including prior asset versions, 2,000
PUTs/month, 10% static cache misses (30 GETs/MAU). One cursor secret and 1,000 cached
retrievals/month. Fifteen standard metric alarms ($1.50/month before shared alarm allowances).
A separate 0.5 GB CDK asset/version allowance and 100 asset PUTs adds $0.012/month;
IAM roles/policies and the standard bootstrap SSM parameter add no standing charge. A $0.01/month planning reserve covers low-volume
revocation-worker/SNS operations. Two email messages/MAU conservatively use an SES
allowance even though the pilot currently uses Cognito's quota-limited default sender;
a dedicated production sender/SES configuration is not implemented or priced as deployed.

## Published rates used

| Component                | Rate / eligibility assumption                                                                                                                                 | Primary source                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP API                 | $1/million requests                                                                                                                                           | [API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/)                                                                        |
| Lambda                   | $0.20/million requests, arm64 $0.0000133334/GB-second                                                                                                         | [Lambda pricing](https://aws.amazon.com/lambda/pricing/)                                                                                  |
| DynamoDB                 | $0.625/million WRU, $0.125/million RRU, $0.25/GB-month storage                                                                                                | [DynamoDB on-demand pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/)                                                          |
| PITR                     | $0.20/protected GB-month; GSIs excluded from backup basis                                                                                                     | [DynamoDB recovery cost guidance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamodbDisasterRecoveryStrategy.html) |
| Logs / alarms            | $0.50/GB ingest + $0.03/GB stored; $0.10/standard alarm metric                                                                                                | [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)                                                                          |
| Secrets Manager          | $0.40/secret + $0.05/10,000 retrievals                                                                                                                        | [Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/)                                                                |
| S3 Standard              | $0.023/GB, $0.005/1,000 PUTs, $0.0004/1,000 GETs                                                                                                              | [S3 pricing](https://aws.amazon.com/s3/pricing/)                                                                                          |
| Cognito Essentials       | Eligible direct/social allowance: 10,000 MAU shared per account/organization; otherwise $0.015/MAU at this scale                                              | [Cognito pricing](https://aws.amazon.com/cognito/pricing/)                                                                                |
| CloudFront pay-as-you-go | Eligible shared monthly allowance: 1 TB and 10 million HTTP(S) requests; exhausted-allowance example uses US/Europe $0.085/GB and $0.01/10,000 HTTPS requests | [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/), [allowance FAQ](https://aws.amazon.com/cloudfront/faqs/)                |
| Email reserve            | $0.16/1,000 outbound under current SES Essentials example; actual sender/plan must be confirmed                                                               | [SES pricing](https://aws.amazon.com/ses/pricing/)                                                                                        |

AWS-origin transfer to CloudFront is free; do not charge separate API internet egress
again for the same viewer bytes. [CloudFront service guidance](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html).
The stack uses pay-as-you-go distribution definitions, not a CloudFront flat-rate plan.

Published rate references were reviewed during architecture/integration work; quantities,
retention, cache ratios and exact totals are estimates. Cognito and CloudFront eligibility
are explicitly conditional. Other service free tiers, trial credits and data-transfer
allowances are not subtracted, giving a conservative comparison. Reconfirm rates,
request-size increments and account eligibility in AWS Pricing Calculator before approval.

## Reproducible calculation and controls

Run `python infra/scripts/cost-estimate.py`; the checked-in
[component estimates](../infra/cost-estimate.json) sum unrounded values. Approximate
1,000-MAU components: API $4, Lambda $7.47, Dynamo writes $25, reads $5, storage $24.01,
PITR $16, logs $4.24, with alarms/secrets/static/email bringing the total to $88.00 under
the two eligible allowances. Without them, Cognito adds $15 and CloudFront adds $10.80.

On-demand table/GSI ceilings of 100 read/write units, API rate/burst 20/40 and five reserved
concurrent executions per function limit accidental throughput; they can also throttle
legitimate bursts and must be load-tested. Budget alerts at 80% actual/100% forecast are
notifications, not shutdowns or hard spending caps. No automatic destructive action is
configured. Record actual cost/latency/retained bytes during the invitation-only pilot.

## Two-user hardening delta and retained costs

The approximately $0.91/month increase is nine alarms ($0.90) plus the explicit asset
bucket allowance ($0.012). The 15 alarms and cursor secret together are about **$1.91/month**
before traffic. These are the main fixed costs, not Lambda or DynamoDB throughput. No NAT
gateway, customer-managed KMS key, WAF, Route 53 zone, paid CloudFront plan, ECR repository
or provisioned concurrency is in the definitions. Current public CloudWatch pricing also
shows a shared 10-standard-alarm allowance; this estimate conservatively does not subtract
it. Eligible unused alarm allowance could reduce the total by up to $1/month.

The $10 **account-wide** monthly budget is retained and sends >80% actual / >100% forecast
email alerts. It includes other account spending, is not a hard cap and does not stop
resources. The alert recipient remains missing and mandatory before deployment. At 100
users this workload already exceeds $10/month; revise approval and budget before expansion.

Deleting the application stack will not delete retained tables/PITR, S3 frontend/asset
objects and versions, cursor secret, log groups or Cognito user pool. Storage/PITR and
the secret can continue billing; retained user pools incur MAU charges when active.
Log-group metadata alone has no standing charge once 30-day data expires. The retained
budget preserves cost notifications. The support bucket needs explicit version-aware
cleanup after rollback/asset-reference review; deleting roles alone does not stop charges.

CloudWatch/Cognito/CloudFront public pricing pages were rechecked for this hardening review.
Exact account discounts, remaining allowances, taxes, region/edge geography, service email
quotas, restore tests and traffic costs remain unverified. Use a conservative **$3/month
pilot planning allowance**, plus unrelated account spend; this is not a spending limit.
