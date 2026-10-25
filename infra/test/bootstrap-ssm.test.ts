import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const support = JSON.parse(
  readFileSync(
    new URL("../iam/deployment-support.template.json", import.meta.url),
    "utf8",
  ),
);
type Statement = { Action: string[]; Resource: unknown[] };
const marker = {
  "Fn::Sub":
    "arn:${AWS::Partition}:ssm:us-east-1:${AWS::AccountId}:parameter/form-pilot/bootstrap/version",
};

test("CloudFormation resolves bootstrap SSM parameters through both exact-scoped IAM layers", () => {
  const role = support.Resources.CfnExecution.Properties;
  const grants: Statement[] = role.ManagedPolicyArns.flatMap(
    (ref: { Ref: string }) =>
      support.Resources[ref.Ref].Properties.PolicyDocument.Statement,
  );
  const cap: Statement[] =
    support.Resources[role.PermissionsBoundary.Ref].Properties.PolicyDocument
      .Statement;
  for (const statements of [grants, cap]) {
    const ssm = statements.filter((s) =>
      s.Action.some((a) => a.startsWith("ssm:")),
    );
    assert.equal(ssm.length, 1);
    assert.deepEqual(ssm[0].Action, ["ssm:GetParameters"]);
    assert.deepEqual(ssm[0].Resource, [marker]);
  }
  const deploy: Statement[] =
    support.Resources.CdkDeploy.Properties.Policies[0].PolicyDocument.Statement;
  const singular = deploy.find((s) => s.Action.includes("ssm:GetParameter"));
  assert.deepEqual(singular?.Resource, [marker]);
  assert.ok(!grants.some((s) => s.Action.includes("ssm:*")));
});
