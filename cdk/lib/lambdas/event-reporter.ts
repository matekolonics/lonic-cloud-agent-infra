import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface EventReporterProps {
  readonly artifactBucket: s3.IBucket;
  readonly artifactPrefix: string;
  readonly agentVersion: string;
  readonly agentIdParam: cdk.CfnParameter;
  readonly callbackBaseUrl: string;
  readonly callbackTokenSecret: secretsmanager.ISecret;
}

export class EventReporter extends Construct {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: EventReporterProps) {
    super(scope, id);

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromBucket(props.artifactBucket, `${props.artifactPrefix}/event-reporter-arm64.zip`),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: `lonic cloud agent event-reporter v${props.agentVersion}`,
      environment: {
        LONIC_CALLBACK_TOKEN_ARN: props.callbackTokenSecret.secretArn,
        LONIC_CALLBACK_BASE_URL: props.callbackBaseUrl,
        AGENT_ID: props.agentIdParam.valueAsString,
      },
    });

    props.callbackTokenSecret.grantRead(this.fn);

    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStackEvents'],
      resources: ['*'],
    }));

    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codebuild:BatchGetBuilds'],
      resources: ['*'],
    }));
  }
}
