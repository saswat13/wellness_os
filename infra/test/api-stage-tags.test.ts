import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const template = JSON.parse(
  readFileSync(
    new URL("../iam/deployment-support.template.json", import.meta.url),
    "utf8",
  ),
);
type Statement = { Action: string[]; Resource: unknown[] };

test("CreateStage tagging is explicitly allowed only on the HTTP API stage collection in both layers", () => {
  const role = template.Resources.CfnExecution.Properties;
  const grants: Statement[] = role.ManagedPolicyArns.flatMap(
    (r: { Ref: string }) =>
      template.Resources[r.Ref].Properties.PolicyDocument.Statement,
  );
  const cap: Statement[] =
    template.Resources[role.PermissionsBoundary.Ref].Properties.PolicyDocument
      .Statement;
  for (const statements of [grants, cap]) {
    const tags = statements.filter((s) =>
      s.Action.includes("apigateway:TagResource"),
    );
    assert.equal(tags.length, 1);
    assert.deepEqual(tags[0].Action, ["apigateway:TagResource"]);
    assert.deepEqual(tags[0].Resource, [
      {
        "Fn::Sub": "arn:${AWS::Partition}:apigateway:us-east-1::/apis/*/stages",
      },
    ]);
    assert.ok(!statements.some((s) => s.Action.includes("apigateway:*")));
  }
  const lifecycle = grants.find((s) => s.Action.includes("apigateway:POST"));
  assert.ok(JSON.stringify(lifecycle?.Resource).includes("/apis/*"));
  // /apis/* covers /stages, /stages/$default, /routes, /integrations and
  // /authorizers; the observed gap was the explicit action, not these verbs.
});
