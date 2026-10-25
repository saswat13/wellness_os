import { Validations } from "aws-cdk-lib";
import type { Stack } from "aws-cdk-lib";
export function applyReviewedSuppressions(stack: Stack) {
  for (const finding of [
    {
      id: "AwsSolutions::AwsSolutions-IAM5",
      reason:
        "Only generated log-stream resources, exact GSI ARN, OAC bucket-object ARN and USER/auth namespace LeadingKeys patterns. Template tests forbid wildcard Action/Resource and Scan.",
    },
    {
      id: "AwsSolutions::AwsSolutions-COG2",
      reason:
        "Private invitation-only pilot offers TOTP MFA; mandatory MFA is an explicit pre-public-launch decision.",
    },
    {
      id: "AwsSolutions::AwsSolutions-COG3",
      reason:
        "Essentials plan with invite-only access; paid advanced threat protection is a separately costed release decision.",
    },
    {
      id: "AwsSolutions::AwsSolutions-S1",
      reason:
        "Static public assets only. S3 access logs are not enabled to avoid storing duplicate request metadata; HTTP API operational logs retained 30 days.",
    },
    {
      id: "AwsSolutions::AwsSolutions-CFR1",
      reason:
        "Geo restrictions are not a security boundary for invited users; API authorization enforces ownership.",
    },
    {
      id: "AwsSolutions::AwsSolutions-CFR2",
      reason:
        "No WAF configured for private pilot; HTTP API throttles and bounded Lambda concurrency limit exposure. Reassess before public launch.",
    },
    {
      id: "AwsSolutions::AwsSolutions-CFR3",
      reason:
        "CloudFront access logs intentionally disabled: query strings may contain authorization codes; API logs use an explicit safe field allowlist.",
    },
    {
      id: "AwsSolutions::AwsSolutions-CFR4",
      reason:
        "CloudFront default hostname/certificate requested for the pilot. AWS controls its TLSv1 minimum policy; modern connections negotiate stronger TLS. Accept this limitation explicitly before provisioning, or approve a custom hostname/certificate.",
    },
    {
      id: "AwsSolutions::AwsSolutions-COG8",
      reason:
        "Approved Essentials invitation-only pilot; Plus threat protection requires a separate cost and public-launch decision.",
    },
    {
      id: "AwsSolutions::AwsSolutions-SMG4",
      reason:
        "Cursor signing key rotation intentionally invalidates short-lived pagination cursors; rotate explicitly with reviewed overlap before enabling automatic rotation.",
    },
    {
      id: "AwsSolutions::AwsSolutions-L1",
      reason:
        "Python 3.13 arm64 is the approved runtime; 3.14 is newer but outside the validated target.",
    },
  ])
    Validations.of(stack).acknowledge(finding);
  for (const name of ["ANY--auth--{proxy+}", "ANY--api--{proxy+}"]) {
    const route = stack.node.findChild("HttpApi").node.findChild(name);
    Validations.of(route).acknowledge({
      id: "AwsSolutions::AwsSolutions-APIG4",
      reason:
        "BFF login/callback must be publicly reachable; session/authenticated proxy routes validate opaque durable cookies and exact Origin plus CSRF in application code. Domain routes require Cognito JWT.",
    });
  }
}
