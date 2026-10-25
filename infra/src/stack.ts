import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  Stack,
  Duration,
  RemovalPolicy,
  CfnOutput,
  CfnParameter,
  Aws,
  Tags,
  DefaultStackSynthesizer,
  aws_dynamodb as db,
  aws_cognito as cognito,
  aws_lambda as lambda,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
  aws_cloudfront as cdn,
  aws_cloudfront_origins as origins,
  aws_apigatewayv2 as gateway,
  aws_apigatewayv2_integrations as integrations,
  aws_apigatewayv2_authorizers as authorizers,
  aws_cloudwatch as watch,
  aws_budgets as budgets,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
  aws_cloudwatch_actions as actions,
  aws_secretsmanager as secrets,
  aws_apigateway as rest,
  aws_events as events,
  aws_events_targets as targets,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export class FormStack extends Stack {
  constructor(scope: Construct, id: string, pilotId?: string) {
    if (pilotId && !/^[a-z][a-z0-9]{2,7}$/.test(pilotId))
      throw new Error(
        "pilotId must be 3-8 lowercase alphanumeric characters, starting with a letter",
      );
    const disposable = Boolean(pilotId);
    const prefix = pilotId ? `form-pilot-${pilotId}` : "form-pilot";
    const removal = disposable ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    super(scope, id, {
      description:
        "FORM private pilot: shared authentication and isolated workout/nutrition data; deployment requires separate approval",
      env: {
        region: "us-east-1",
        ...(pilotId && process.env.CDK_DEFAULT_ACCOUNT
          ? { account: process.env.CDK_DEFAULT_ACCOUNT }
          : {}),
      },
      terminationProtection: !disposable,
      synthesizer: new DefaultStackSynthesizer({
        qualifier: "formpilot",
        fileAssetsBucketName:
          "form-pilot-cdk-assets-${AWS::AccountId}-us-east-1",
        fileAssetPublishingRoleArn:
          "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/form-pilot/deployment/file-publisher",
        deployRoleArn:
          "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/form-pilot/deployment/cdk-deploy",
        cloudFormationExecutionRole:
          "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/form-pilot/deployment/cfn-execution",
        bootstrapStackVersionSsmParameter: "/form-pilot/bootstrap/version",
        useLookupRoleForStackOperations: false,
      }),
    });
    this.templateOptions.metadata = {
      AWSToolsMetrics: { AWSAgentToolkit: "aws-cloudformation@3" },
      "com.aws.cloudformation.Context": {
        ref: [
          {
            at: "docs/aws-public-status.md",
            has: "current cloud status and authorization boundaries",
          },
        ],
        must: [
          "No provisioning without explicit approval",
          pilotId
            ? "Keep private responses uncached; disposable pilot data deletion is explicit"
            : "Keep private responses uncached and historical records retained",
        ],
      },
    };
    Tags.of(this).add("FormApplication", "FORM");
    Tags.of(this).add("FormEnvironment", "pilot");
    const alertEmail = new CfnParameter(this, "AlertEmail", {
      type: "String",
      allowedPattern: "[^@\\s]+@[^@\\s]+\\.[^@\\s]+",
      noEcho: true,
    });
    const budgetDollars = new CfnParameter(this, "BudgetDollars", {
      type: "Number",
      default: 10,
      minValue: 10,
      maxValue: 10,
    });
    const sessionMaximum = new CfnParameter(this, "SessionMaximumSeconds", {
      type: "Number",
      default: 604800,
      minValue: 300,
      maxValue: 604800,
    });

    // Only the HTTP API resource is an origin dependency: routes/integrations follow
    // Cognito. This keeps CloudFront -> callback URL -> client -> Lambda acyclic.
    const api = new gateway.HttpApi(this, "HttpApi", {
      apiName: prefix,
      createDefaultStage: false,
    });
    const assets = new s3.Bucket(this, "Frontend", {
      bucketName: `${prefix}-frontend-${Aws.ACCOUNT_ID}-us-east-1`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: !disposable,
      removalPolicy: removal,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: disposable
            ? undefined
            : Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });
    const origin = new origins.HttpOrigin(
      `${api.apiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}`,
      { protocolPolicy: cdn.OriginProtocolPolicy.HTTPS_ONLY },
    );
    const privateHeaders = new cdn.ResponseHeadersPolicy(
      this,
      "PrivateHeaders",
      {
        responseHeadersPolicyName: `${prefix}-private-no-store`,
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cdn.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: cdn.HeadersReferrerPolicy.NO_REFERRER,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(365),
            includeSubdomains: true,
            override: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "Cache-Control",
              value: "private, no-store, max-age=0",
              override: true,
            },
            { header: "Pragma", value: "no-cache", override: true },
            { header: "Expires", value: "0", override: true },
          ],
        },
      },
    );
    const privateBehavior: cdn.BehaviorOptions = {
      origin,
      allowedMethods: cdn.AllowedMethods.ALLOW_ALL,
      cachePolicy: cdn.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cdn.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cdn.ViewerProtocolPolicy.HTTPS_ONLY,
      responseHeadersPolicy: privateHeaders,
    };
    const distribution = new cdn.Distribution(this, "FrontendDistribution", {
      defaultRootObject: "index.html",
      // CloudFront's default certificate uses its service-controlled TLSv1 policy.
      // A stricter minimum requires a separately approved custom hostname/certificate.
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(assets),
        viewerProtocolPolicy: cdn.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cdn.ResponseHeadersPolicy.SECURITY_HEADERS,
        cachePolicy: new cdn.CachePolicy(this, "StaticCache", {
          defaultTtl: Duration.minutes(5),
          minTtl: Duration.seconds(0),
          maxTtl: Duration.days(1),
          enableAcceptEncodingBrotli: true,
          enableAcceptEncodingGzip: true,
        }),
      },
      additionalBehaviors: {
        "/auth/*": privateBehavior,
        "/api/*": privateBehavior,
      },
      // No global 403/404 SPA fallback: it would replace private API errors with cached HTML.
      errorResponses: [
        400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504,
      ].map((httpStatus) => ({ httpStatus, ttl: Duration.seconds(0) })),
      priceClass: cdn.PriceClass.PRICE_CLASS_100,
      enableLogging: false,
    });
    (distribution.node.defaultChild as cdn.CfnDistribution).addPropertyOverride(
      "DistributionConfig.ViewerCertificate",
      { CloudFrontDefaultCertificate: true },
    );
    const appOrigin = `https://${distribution.distributionDomainName}`;
    const tables = Object.fromEntries(
      ["Accounts", "Training", "Nutrition", "Catalog"].map((name) => {
        const table = new db.Table(this, name, {
          tableName: `${prefix}-${name.toLowerCase()}`,
          partitionKey: { name: "PK", type: db.AttributeType.STRING },
          sortKey: { name: "SK", type: db.AttributeType.STRING },
          billingMode: db.BillingMode.PAY_PER_REQUEST,
          encryption: db.TableEncryption.AWS_MANAGED,
          pointInTimeRecoverySpecification: {
            pointInTimeRecoveryEnabled: !disposable,
            recoveryPeriodInDays: disposable ? undefined : 35,
          },
          deletionProtection: !disposable,
          removalPolicy: removal,
          timeToLiveAttribute: name === "Accounts" ? "expires" : undefined,
          maxReadRequestUnits: 100,
          maxWriteRequestUnits: 100,
        });
        return [name, table];
      }),
    ) as Record<string, db.Table>;
    tables.Training.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: db.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: db.AttributeType.STRING },
      projectionType: db.ProjectionType.ALL,
      maxReadRequestUnits: 100,
      maxWriteRequestUnits: 100,
    });

    const pool = new cognito.UserPool(this, "Users", {
      userPoolName: `${prefix}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(2),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: !disposable,
      removalPolicy: removal,
    });
    const readScope = new cognito.ResourceServerScope({
      scopeName: "read",
      scopeDescription: "Read owned FORM records",
    });
    const writeScope = new cognito.ResourceServerScope({
      scopeName: "write",
      scopeDescription: "Change owned FORM records",
    });
    const resourceServer = pool.addResourceServer("DomainScopes", {
      identifier: "form",
      scopes: [readScope, writeScope],
    });
    const poolClient = pool.addClient("WebBff", {
      generateSecret: true,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      authFlows: {
        userSrp: false,
        adminUserPassword: false,
        userPassword: false,
        custom: false,
      },
      accessTokenValidity: Duration.minutes(10),
      idTokenValidity: Duration.minutes(10),
      refreshTokenValidity: Duration.days(7),
      refreshTokenRotationGracePeriod: Duration.seconds(60),
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
        callbackUrls: [appOrigin + "/auth/callback"],
        logoutUrls: [appOrigin],
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.resourceServer(resourceServer, readScope),
          cognito.OAuthScope.resourceServer(resourceServer, writeScope),
        ],
      },
    });
    const loginDomain = pool.addDomain("Login", {
      cognitoDomain: {
        domainPrefix: pilotId
          ? `form-${pilotId}-${Aws.ACCOUNT_ID}-${Aws.REGION}`
          : `form-${Aws.ACCOUNT_ID}-${Aws.REGION}`,
      },
    });
    const cursor = new secrets.Secret(this, "CursorSigningKey", {
      secretName: pilotId
        ? `form-pilot/${pilotId}/cursor-signing-key`
        : "form-pilot/cursor-signing-key",
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: removal,
    });
    const sourceRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    // Packaging is a separate, offline-validated step. Synth itself never invokes Docker/AWS.
    const code = lambda.Code.fromAsset(
      path.join(sourceRoot, "backend/lambda-dist"),
    );
    const common = {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      code,
      memorySize: 512,
      timeout: Duration.seconds(29),
      reservedConcurrentExecutions: 5,
      environment: {
        ACCOUNTS_TABLE: tables.Accounts.tableName,
        TRAINING_TABLE: tables.Training.tableName,
        NUTRITION_TABLE: tables.Nutrition.tableName,
        CATALOG_TABLE: tables.Catalog.tableName,
        COGNITO_POOL_ID: pool.userPoolId,
        COGNITO_CLIENT_ID: poolClient.userPoolClientId,
        COGNITO_ISSUER: pool.userPoolProviderUrl,
        COGNITO_DOMAIN: loginDomain.baseUrl(),
        APP_ORIGIN: appOrigin,
        SESSION_MAX_SECONDS: sessionMaximum.valueAsString,
      },
    };
    const domainLog = new logs.LogGroup(this, "DomainLogs", {
      logGroupName: `/aws/lambda/${prefix}-domain`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: removal,
    });
    const bffLog = new logs.LogGroup(this, "BffLogs", {
      logGroupName: `/aws/lambda/${prefix}-bff`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: removal,
    });
    // Explicit log roles avoid AWSLambdaBasicExecutionRole's account-wide log resources.
    const domainRole = new iam.Role(this, "DomainRole", {
      roleName: pilotId ? `form-${pilotId}-domain` : "domain",
      path: pilotId
        ? `/form-pilot/runtime/${pilotId}/`
        : "/form-pilot/runtime/",
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(
        this,
        "DomainBoundary",
        `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:policy/form-pilot/boundaries/domain`,
      ),
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const bffRole = new iam.Role(this, "BffRole", {
      roleName: pilotId ? `form-${pilotId}-bff` : "bff",
      path: pilotId
        ? `/form-pilot/runtime/${pilotId}/`
        : "/form-pilot/runtime/",
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(
        this,
        "BffBoundary",
        `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:policy/form-pilot/boundaries/bff`,
      ),
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    domainLog.grantWrite(domainRole);
    bffLog.grantWrite(bffRole);
    const domain = new lambda.Function(this, "Domain", {
      functionName: `${prefix}-domain`,
      ...common,
      role: domainRole,
      logGroup: domainLog,
      handler: "form_backend.aws.runtime.domain_handler",
      environment: {
        ...common.environment,
        CURSOR_SECRET_ARN: cursor.secretArn,
      },
    });
    domainRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [cursor.secretArn],
      }),
    );
    const httpLog = new logs.LogGroup(this, "HttpLogs", {
      logGroupName: `/aws/lambda/${prefix}-http`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: removal,
    });
    new gateway.HttpStage(this, "Stage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
      accessLogSettings: {
        destination: new gateway.LogGroupLogDestination(httpLog),
        format: rest.AccessLogFormat.custom(
          '{"requestId":"$context.requestId","status":"$context.status","latency":"$context.responseLatency"}',
        ),
      },
    });
    const bff = new lambda.Function(this, "Bff", {
      functionName: `${prefix}-bff`,
      ...common,
      role: bffRole,
      logGroup: bffLog,
      handler: "form_backend.aws.runtime.bff_handler",
      environment: {
        ...common.environment,
        DOMAIN_API_ORIGIN: `https://${api.apiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}`,
      },
    });
    const jwt = new authorizers.HttpJwtAuthorizer(
      "CognitoJwt",
      pool.userPoolProviderUrl,
      { jwtAudience: [poolClient.userPoolClientId] },
    );
    api.addRoutes({
      path: "/v1/{proxy+}",
      methods: [gateway.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration(
        "DomainIntegration",
        domain,
      ),
      authorizer: jwt,
      authorizationScopes: ["form/read"],
    });
    api.addRoutes({
      path: "/auth/{proxy+}",
      methods: [gateway.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration(
        "AuthIntegration",
        bff,
      ),
    });
    api.addRoutes({
      path: "/api/{proxy+}",
      methods: [gateway.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration(
        "BffIntegration",
        bff,
      ),
    });

    // Refined from Autopilot output and service authorization metadata. No Scan,
    // ListTables, permission-management actions or catalog writes in runtime roles.
    const mutationActions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:ConditionCheckItem",
    ];
    domainRole.addToPolicy(
      new iam.PolicyStatement({
        actions: mutationActions,
        resources: [
          tables.Training.tableArn,
          tables.Nutrition.tableArn,
          tables.Accounts.tableArn,
        ],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
          Null: { "dynamodb:LeadingKeys": "false" },
        },
      }),
    );
    domainRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [tables.Training.tableArn + "/index/GSI1"],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
          Null: { "dynamodb:LeadingKeys": "false" },
        },
      }),
    );
    domainRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        resources: [tables.Catalog.tableArn],
      }),
    );
    bffRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
        ],
        resources: [tables.Accounts.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AUTHSESSION#*",
              "LOGIN#*",
              "REVOCATION#*",
            ],
          },
          Null: { "dynamodb:LeadingKeys": "false" },
        },
      }),
    );
    bffRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:DescribeUserPoolClient"],
        resources: [pool.userPoolArn],
      }),
    );
    new events.Rule(this, "RevocationRetries", {
      ruleName: `${prefix}-revocations`,
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [new targets.LambdaFunction(bff)],
    });

    const notifications = new sns.Topic(this, "OperationsNotifications", {
      topicName: `${prefix}-operations`,
      enforceSSL: true,
    });
    notifications.addSubscription(
      new subscriptions.EmailSubscription(alertEmail.valueAsString),
    );
    const metrics: [string, watch.IMetric][] = [
      ["DomainErrors", domain.metricErrors()],
      ["BffErrors", bff.metricErrors()],
      ["DomainThrottles", domain.metricThrottles()],
      ["BffThrottles", bff.metricThrottles()],
      [
        "HttpServerErrors",
        api.metricServerError({ period: Duration.minutes(5) }),
      ],
    ];
    for (const [name, table] of Object.entries(tables)) {
      for (const metricName of ["ReadThrottleEvents", "WriteThrottleEvents"]) {
        metrics.push([
          `${name}${metricName}`,
          new watch.Metric({
            namespace: "AWS/DynamoDB",
            metricName,
            dimensionsMap: { TableName: table.tableName },
            statistic: "Sum",
            period: Duration.minutes(5),
          }),
        ]);
      }
    }
    for (const metricName of ["ReadThrottleEvents", "WriteThrottleEvents"]) {
      metrics.push([
        `TrainingGSI1${metricName}`,
        new watch.Metric({
          namespace: "AWS/DynamoDB",
          metricName,
          dimensionsMap: {
            TableName: tables.Training.tableName,
            GlobalSecondaryIndexName: "GSI1",
          },
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
      ]);
    }
    const alarms = metrics.map(([label, metric]) => {
      const alarm = new watch.Alarm(this, label, {
        alarmName: `${prefix}-${label}`,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: watch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new actions.SnsAction(notifications));
      return alarm;
    });
    notifications.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchAlarmPublisher",
        principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [notifications.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID },
          ArnEquals: { "aws:SourceArn": alarms.map((alarm) => alarm.alarmArn) },
        },
      }),
    );
    const accountBudget = new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: `${prefix}-account-monthly`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: budgetDollars.valueAsNumber, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "ACTUAL",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [
            { address: alertEmail.valueAsString, subscriptionType: "EMAIL" },
          ],
        },
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "FORECASTED",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [
            { address: alertEmail.valueAsString, subscriptionType: "EMAIL" },
          ],
        },
      ],
    });
    // Keep account-level cost notifications if the application is later removed.
    accountBudget.applyRemovalPolicy(removal);
    new CfnOutput(this, "WebsiteBucket", { value: assets.bucketName });
    new CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });
    new CfnOutput(this, "Website", { value: appOrigin });
    new CfnOutput(this, "UserPoolId", { value: pool.userPoolId });
    new CfnOutput(this, "ApiOrigin", { value: api.apiEndpoint });
  }
}
