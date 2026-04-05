import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface RuntimeErrorReporterProps {
  /** API Gateway to add the error-stats route to. */
  readonly api: apigateway.RestApi;
  /** Lambda functions to monitor for runtime errors. */
  readonly monitoredFunctions: lambda.IFunction[];
  /** Secrets Manager secret containing the bearer token for backend callbacks. */
  readonly callbackTokenSecret: secretsmanager.ISecret;
  /** Base URL of the lonic hosted backend. */
  readonly callbackBaseUrl: string;
  /** Agent ID parameter. */
  readonly agentIdParam: cdk.CfnParameter;
  /**
   * How often to push aggregated error stats to the backend.
   * @default Duration.minutes(5)
   */
  readonly reportingInterval?: cdk.Duration;
}

/**
 * Monitors agent Lambda functions for runtime errors and reports them
 * to the lonic backend via multiple paths:
 *
 * 1. **Real-time alarms** — CloudWatch Alarm on each Lambda's `Errors` metric
 *    → SNS → alarm-reporter Lambda → backend POST `/agent/runtime-error`.
 *    Catches the scenario where the primary event-reporter is broken.
 *
 * 2. **Scheduled push** — EventBridge rule (every 5 min by default) → Lambda
 *    queries CloudWatch metrics → backend POST `/agent/error-stats`.
 *    Proactive aggregated reporting; the backend never needs to poll.
 *
 * 3. **On-demand stats** — `GET /error-stats` returns error counts per function
 *    over 1h/24h windows. Simple request/response for debugging.
 *
 * All Lambdas are intentionally minimal (Node.js inline, no external
 * dependencies beyond AWS SDK) to minimise the chance of them breaking
 * alongside the functions they monitor.
 */
export class RuntimeErrorReporter extends Construct {
  public readonly topic: sns.Topic;
  public readonly alarmReporterFn: lambda.Function;
  public readonly statsFn: lambda.Function;
  public readonly scheduledReporterFn: lambda.Function;
  public readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: RuntimeErrorReporterProps) {
    super(scope, id);

    // Build a JSON map of { label: functionName } for Lambdas to query
    const functionMap: Record<string, string> = {};
    for (const fn of props.monitoredFunctions) {
      const label = fn.node.scope?.node.id ?? fn.node.id;
      functionMap[label] = fn.functionName;
    }

    // --- Real-time alarm path: Lambda Errors → CloudWatch Alarm → SNS → Lambda → backend ---

    this.topic = new sns.Topic(this, 'Topic', {
      displayName: 'Lonic Agent Runtime Errors',
    });

    this.alarmReporterFn = new lambda.Function(this, 'AlarmReporterFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const https = require("https");

const sm = new SecretsManagerClient();
const BASE_URL = process.env.LONIC_CALLBACK_BASE_URL;
const SECRET_ARN = process.env.LONIC_CALLBACK_TOKEN_ARN;
const AGENT_ID = process.env.AGENT_ID;

let cachedToken;

async function getToken() {
  if (cachedToken) return cachedToken;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  cachedToken = res.SecretString;
  return cachedToken;
}

function post(url, body, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

exports.handler = async (event) => {
  const token = await getToken();
  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);
    const payload = {
      agentId: AGENT_ID,
      type: "runtime-error",
      alarm: {
        name: message.AlarmName,
        description: message.AlarmDescription,
        newState: message.NewStateValue,
        reason: message.NewStateReason,
        timestamp: message.StateChangeTime,
      },
    };
    await post(BASE_URL + "/agent/runtime-error", payload, token);
  }
};
`),
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      description: 'Reports Lambda runtime errors to the lonic backend when the normal callback path may be broken',
      environment: {
        LONIC_CALLBACK_BASE_URL: props.callbackBaseUrl,
        LONIC_CALLBACK_TOKEN_ARN: props.callbackTokenSecret.secretArn,
        AGENT_ID: props.agentIdParam.valueAsString,
      },
    });

    props.callbackTokenSecret.grantRead(this.alarmReporterFn);

    this.topic.addSubscription(new subscriptions.LambdaSubscription(this.alarmReporterFn));

    this.alarms = props.monitoredFunctions.map((fn) => {
      const parentId = fn.node.scope?.node.id ?? fn.node.id;
      const alarm = new cloudwatch.Alarm(this, `Alarm${parentId}`, {
        metric: fn.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: `Runtime errors detected in ${fn.functionName}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cw_actions.SnsAction(this.topic));
      alarm.addOkAction(new cw_actions.SnsAction(this.topic));
      return alarm;
    });

    // --- Shared CloudWatch query logic (used by both stats endpoint and scheduled reporter) ---

    const cloudwatchQueryCode = `
const { CloudWatchClient, GetMetricStatisticsCommand } = require("@aws-sdk/client-cloudwatch");

const cw = new CloudWatchClient();
const FUNCTIONS = JSON.parse(process.env.MONITORED_FUNCTIONS);
const WINDOWS = [
  { label: "1h", seconds: 3600 },
  { label: "24h", seconds: 86400 },
];

async function getErrorCount(functionName, windowSeconds) {
  const now = new Date();
  const start = new Date(now.getTime() - windowSeconds * 1000);
  const res = await cw.send(new GetMetricStatisticsCommand({
    Namespace: "AWS/Lambda",
    MetricName: "Errors",
    Dimensions: [{ Name: "FunctionName", Value: functionName }],
    StartTime: start,
    EndTime: now,
    Period: windowSeconds,
    Statistics: ["Sum"],
  }));
  const dp = res.Datapoints || [];
  return dp.reduce((sum, d) => sum + (d.Sum || 0), 0);
}

async function collectStats() {
  const results = {};
  let totalErrors = 0;
  for (const [label, functionName] of Object.entries(FUNCTIONS)) {
    const windows = {};
    for (const w of WINDOWS) {
      const count = await getErrorCount(functionName, w.seconds);
      windows[w.label] = count;
      totalErrors += count;
    }
    results[label] = { functionName, errors: windows };
  }
  return { healthy: totalErrors === 0, totalErrors, functions: results, queriedAt: new Date().toISOString() };
}`;

    // --- On-demand stats endpoint: GET /error-stats ---

    this.statsFn = new lambda.Function(this, 'StatsFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`${cloudwatchQueryCode}

exports.handler = async () => {
  const stats = await collectStats();
  return { statusCode: 200, body: JSON.stringify(stats) };
};
`),
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      description: 'Returns aggregated Lambda error statistics from CloudWatch metrics',
      environment: {
        MONITORED_FUNCTIONS: JSON.stringify(functionMap),
      },
    });

    this.statsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));

    const errorStatsResource = props.api.root.addResource('error-stats');
    errorStatsResource.addMethod('GET',
      new apigateway.LambdaIntegration(this.statsFn),
      { authorizationType: apigateway.AuthorizationType.IAM },
    );

    // --- Scheduled push: EventBridge rule → Lambda → CloudWatch query → backend ---

    this.scheduledReporterFn = new lambda.Function(this, 'ScheduledReporterFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`${cloudwatchQueryCode}

const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const https = require("https");

const sm = new SecretsManagerClient();
const BASE_URL = process.env.LONIC_CALLBACK_BASE_URL;
const SECRET_ARN = process.env.LONIC_CALLBACK_TOKEN_ARN;
const AGENT_ID = process.env.AGENT_ID;

let cachedToken;

async function getToken() {
  if (cachedToken) return cachedToken;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  cachedToken = res.SecretString;
  return cachedToken;
}

function post(url, body, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

exports.handler = async () => {
  const stats = await collectStats();
  if (!stats.healthy) {
    const token = await getToken();
    await post(BASE_URL + "/agent/error-stats", { agentId: AGENT_ID, ...stats }, token);
  }
};
`),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      description: 'Periodically pushes aggregated Lambda error statistics to the lonic backend',
      environment: {
        MONITORED_FUNCTIONS: JSON.stringify(functionMap),
        LONIC_CALLBACK_BASE_URL: props.callbackBaseUrl,
        LONIC_CALLBACK_TOKEN_ARN: props.callbackTokenSecret.secretArn,
        AGENT_ID: props.agentIdParam.valueAsString,
      },
    });

    this.scheduledReporterFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));

    props.callbackTokenSecret.grantRead(this.scheduledReporterFn);

    new events.Rule(this, 'ScheduleRule', {
      description: 'Periodically triggers aggregated error stats reporting to the lonic backend.',
      schedule: events.Schedule.rate(props.reportingInterval ?? cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(this.scheduledReporterFn)],
    });
  }
}
