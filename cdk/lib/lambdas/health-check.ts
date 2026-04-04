import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface HealthCheckProps {
  readonly artifactBucket: s3.IBucket;
  readonly artifactPrefix: string;
  readonly agentVersion: string;
  readonly agentIdParam: cdk.CfnParameter;
  readonly api: apigateway.RestApi;
}

export class HealthCheck extends Construct {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: HealthCheckProps) {
    super(scope, id);

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromBucket(props.artifactBucket, `${props.artifactPrefix}/health-check-arm64.zip`),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      description: `lonic cloud agent health-check v${props.agentVersion}`,
      environment: {
        AGENT_ID: props.agentIdParam.valueAsString,
      },
    });

    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:GetCallerIdentity'],
      resources: ['*'],
    }));

    const healthResource = props.api.root.addResource('health');
    healthResource.addMethod('GET',
      new apigateway.LambdaIntegration(this.fn),
      { authorizationType: apigateway.AuthorizationType.IAM },
    );
  }
}
