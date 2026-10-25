import test from "node:test";
import assert from "node:assert/strict";
import { App, Validations } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { FormStack } from "../src/stack.js";
import { applyReviewedSuppressions } from "../src/security.js";

function fixture() {
  const app = new App({ analyticsReporting: false });
  const stack = new FormStack(app, "TestForm");
  return { app, stack, template: Template.fromStack(stack) };
}

test("four on-demand encrypted retained tables use PITR and deletion protection", () => {
  const { template } = fixture();
  template.resourceCountIs("AWS::DynamoDB::Table", 4);
  const tables = template.findResources("AWS::DynamoDB::Table");
  for (const resource of Object.values(tables)) {
    assert.equal(resource.DeletionPolicy, "Retain");
    assert.equal(resource.Properties.BillingMode, "PAY_PER_REQUEST");
    assert.equal(resource.Properties.DeletionProtectionEnabled, true);
    assert.equal(
      resource.Properties.PointInTimeRecoverySpecification
        .PointInTimeRecoveryEnabled,
      true,
    );
    assert.equal(
      resource.Properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays,
      35,
    );
    assert.equal(resource.Properties.SSESpecification.SSEEnabled, true);
  }
  const training = Object.values(tables).find(
    (t) => t.Properties.GlobalSecondaryIndexes,
  );
  assert.equal(training?.Properties.GlobalSecondaryIndexes.length, 1);
  assert.deepEqual(training?.Properties.GlobalSecondaryIndexes[0].KeySchema, [
    { AttributeName: "GSI1PK", KeyType: "HASH" },
    { AttributeName: "GSI1SK", KeyType: "RANGE" },
  ]);
});

test("Cognito is private, code-only, confidential, revocable and seven-day bounded", () => {
  const { template } = fixture();
  template.hasResourceProperties("AWS::Cognito::UserPool", {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    UserPoolTier: "ESSENTIALS",
    DeletionProtection: "ACTIVE",
    MfaConfiguration: "OPTIONAL",
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    GenerateSecret: true,
    EnableTokenRevocation: true,
    AllowedOAuthFlows: ["code"],
    RefreshTokenValidity: 10080,
    TokenValidityUnits: {
      AccessToken: "minutes",
      IdToken: "minutes",
      RefreshToken: "minutes",
    },
    AccessTokenValidity: 10,
    IdTokenValidity: 10,
    RefreshTokenRotation: { Feature: "ENABLED", RetryGracePeriodSeconds: 60 },
    SupportedIdentityProviders: ["COGNITO"],
  });
  const parameters = template.toJSON().Parameters;
  assert.equal(parameters.SessionMaximumSeconds.MaxValue, 604800);
  assert.equal(parameters.AlertEmail.NoEcho, true);
});

test("API private routes require JWT and browsers use uncached same-origin BFF routes", () => {
  const { template } = fixture();
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "ANY /v1/{proxy+}",
    AuthorizationType: "JWT",
    AuthorizationScopes: ["form/read"],
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    DefaultRouteSettings: { ThrottlingBurstLimit: 40, ThrottlingRateLimit: 20 },
  });
  const distribution = Object.values(
    template.findResources("AWS::CloudFront::Distribution"),
  )[0].Properties.DistributionConfig;
  for (const prefix of ["/auth/*", "/api/*"]) {
    const behavior = distribution.CacheBehaviors.find(
      (b: { PathPattern: string }) => b.PathPattern === prefix,
    );
    assert.equal(
      behavior.CachePolicyId,
      "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    );
    assert.equal(
      behavior.OriginRequestPolicyId,
      "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    );
    assert.equal(behavior.ViewerProtocolPolicy, "https-only");
    assert.equal(behavior.AllowedMethods.length, 7);
  }
  assert.equal(distribution.DefaultCacheBehavior.ForwardedValues, undefined);
  assert.ok(
    distribution.CustomErrorResponses.every(
      (v: { ErrorCachingMinTTL: number; ResponseCode?: number }) =>
        v.ErrorCachingMinTTL === 0 && v.ResponseCode === undefined,
    ),
  );
});

test("Lambda assets target Python 3.13 arm64 with bounded concurrency and no credentials", () => {
  const { template } = fixture();
  template.resourceCountIs("AWS::Lambda::Function", 2);
  for (const fn of Object.values(
    template.findResources("AWS::Lambda::Function"),
  )) {
    assert.equal(fn.Properties.Runtime, "python3.13");
    assert.deepEqual(fn.Properties.Architectures, ["arm64"]);
    assert.equal(fn.Properties.ReservedConcurrentExecutions, 5);
    assert.equal(fn.Properties.VpcConfig, undefined);
    assert.equal(
      fn.Properties.Environment.Variables.AWS_ACCESS_KEY_ID,
      undefined,
    );
    assert.equal(
      fn.Properties.Environment.Variables.COGNITO_CLIENT_SECRET,
      undefined,
    );
  }
});

test("runtime IAM excludes scans, policy changes, catalog writes and shared token access", () => {
  const { template } = fixture();
  for (const policy of Object.values(
    template.findResources("AWS::IAM::Policy"),
  )) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      if (statement.Effect !== "Allow") continue;
      const actions: string[] = [statement.Action].flat();
      assert.ok(
        actions.every(
          (a) =>
            !a.includes("*") &&
            a !== "dynamodb:Scan" &&
            a !== "dynamodb:ListTables" &&
            !a.startsWith("iam:") &&
            a !== "cognito-idp:AdminCreateUser",
        ),
      );
      assert.ok(![statement.Resource].flat().includes("*"));
      if (
        statement.Condition?.["ForAllValues:StringLike"]?.[
          "dynamodb:LeadingKeys"
        ]
      ) {
        assert.equal(statement.Condition.Null["dynamodb:LeadingKeys"], "false");
      }
    }
  }
  const policies = template.findResources("AWS::IAM::Policy");
  const domain = Object.entries(policies).find(([id]) =>
    id.startsWith("DomainRole"),
  )?.[1];
  const bff = Object.entries(policies).find(([id]) =>
    id.startsWith("BffRole"),
  )?.[1];
  assert.ok(domain && bff);
  assert.ok(!JSON.stringify(domain).includes("AUTHSESSION#"));
  assert.ok(JSON.stringify(bff).includes("AUTHSESSION#"));
  assert.ok(!JSON.stringify(bff).includes('"Ref":"Training'));
});

test("static hosting is private OAC, TLS protected, versioned and retained", () => {
  const { template } = fixture();
  template.hasResourceProperties("AWS::S3::Bucket", {
    VersioningConfiguration: { Status: "Enabled" },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  template.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: "cloudfront.amazonaws.com" },
          Condition: { StringEquals: { "AWS:SourceArn": Match.anyValue() } },
        }),
      ]),
    },
  });
});

test("operational controls include alarms, sanitized 30-day logs, budget and revocation worker", () => {
  const { template } = fixture();
  template.resourceCountIs("AWS::CloudWatch::Alarm", 15);
  template.resourceCountIs("AWS::Budgets::Budget", 1);
  template.resourceCountIs("AWS::Events::Rule", 1);
  for (const group of Object.values(
    template.findResources("AWS::Logs::LogGroup"),
  )) {
    assert.equal(group.Properties.RetentionInDays, 30);
    assert.equal(group.DeletionPolicy, "Retain");
  }
  const stage = Object.values(
    template.findResources("AWS::ApiGatewayV2::Stage"),
  )[0].Properties;
  assert.ok(
    !/authorization|cookie|query|body|ip/i.test(stage.AccessLogSettings.Format),
  );
});

test("AWS Solutions security checks synthesize with only documented acknowledgments", () => {
  const app = new App({ analyticsReporting: false });
  const stack = new FormStack(app, "SecurityForm");
  Validations.of(app).addPlugins(
    new AwsSolutionsChecks(app, { verbose: true }),
  );
  applyReviewedSuppressions(stack);
  const assembly = app.synth();
  assert.ok(assembly.getStackArtifact(stack.artifactId).template);
});
