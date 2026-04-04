import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface AgentApiProps {
  readonly backendRoleArn: string;
}

export class AgentApi extends Construct {
  public readonly restApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: AgentApiProps) {
    super(scope, id);

    this.restApi = new apigateway.RestApi(this, 'RestApi', {
      restApiName: 'LonicCloudAgentApi',
      description: 'API Gateway for the lonic cloud agent. Receives commands from the hosted backend.',
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.ArnPrincipal(props.backendRoleArn)],
            actions: ['execute-api:Invoke'],
            resources: [cdk.Fn.join('', ['execute-api:/', '*'])],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: [cdk.Fn.join('', ['execute-api:/', '*'])],
            conditions: {
              StringNotEquals: {
                'aws:PrincipalArn': props.backendRoleArn,
              },
            },
          }),
        ],
      }),
      deployOptions: {
        stageName: 'v1',
      },
    });

    this.restApi.root.addMethod('ANY', undefined, {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
  }
}
