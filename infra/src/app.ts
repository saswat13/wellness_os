import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { FormStack } from "./stack.js";
import { applyReviewedSuppressions } from "./security.js";
const app = new App({ analyticsReporting: false });
const pilotId = app.node.tryGetContext("pilotId") as string | undefined;
const stack = new FormStack(
  app,
  pilotId ? `FormPilot-${pilotId}` : "FormPrivatePilot",
  pilotId,
);
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
applyReviewedSuppressions(stack);
if (pilotId) {
  Validations.of(stack).acknowledge({
    id: "AwsSolutions::AwsSolutions-DDB3",
    reason:
      "Explicit disposable pilot: no PITR; all pilot data is deleted by the separately approved cleanup workflow. Retained stack configuration is unchanged.",
  });
}
app.synth();
