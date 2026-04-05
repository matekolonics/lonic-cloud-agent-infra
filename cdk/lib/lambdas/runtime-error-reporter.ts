import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface RuntimeErrorReporterProps {
  /** Lambda functions to monitor for runtime errors. */
  readonly monitoredFunctions: lambda.IFunction[];
  /** Secrets Manager secret containing the bearer token for backend callbacks. */
  readonly callbackTokenSecret: secretsmanager.ISecret;
  /** Base URL of the lonic hosted backend. */
  readonly callbackBaseUrl: string;
  /** Agent ID parameter. */
  readonly agentIdParam: cdk.CfnParameter;
}

/**
 * Monitors agent Lambda functions for runtime errors and reports them
 * to the lonic backend via a separate, lightweight callback path.
 *
 * This catches the scenario where the primary event-reporter Lambda is
 * broken (e.g. after a bad self-update) — since the normal SFN → EventBridge
 * → event-reporter callback path would be dead, this independent alarm-based
 * path ensures the backend is still notified.
 *
 * Architecture:
 * ```
 * Lambda Errors metric → CloudWatch Alarm → SNS → error-reporter Lambda → backend
 * ```
 *
 * The error-reporter Lambda is intentionally minimal (Node.js inline, no
 * external dependencies beyond AWS SDK) to minimise the chance of it
 * breaking alongside the functions it monitors.
 */
export class RuntimeErrorReporter extends Construct {
  public readonly topic: sns.Topic;
  public readonly fn: lambda.Function;
  public readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: RuntimeErrorReporterProps) {
    super(scope, id);

    this.topic = new sns.Topic(this, 'Topic', {
      displayName: 'Lonic Agent Runtime Errors',
    });

    this.fn = new lambda.Function(this, 'Fn', {
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

    props.callbackTokenSecret.grantRead(this.fn);

    this.topic.addSubscription(new subscriptions.LambdaSubscription(this.fn));

    // Create a CloudWatch alarm for each monitored function
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
  }
}
