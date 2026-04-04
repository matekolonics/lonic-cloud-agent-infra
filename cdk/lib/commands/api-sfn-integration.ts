import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

/**
 * Adds a POST route to the API Gateway that starts a Step Functions Standard
 * Workflow execution asynchronously via an AWS service integration.
 *
 * Returns the execution ARN and start date in the response.
 */
export function addStartExecutionRoute(
  scope: Construct,
  api: apigateway.RestApi,
  routePath: string,
  stateMachine: sfn.StateMachine,
): void {
  const integrationRole = new iam.Role(scope, 'ApiSfnRole', {
    assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
  });
  stateMachine.grantStartExecution(integrationRole);

  const integration = new apigateway.AwsIntegration({
    service: 'states',
    action: 'StartExecution',
    integrationHttpMethod: 'POST',
    options: {
      credentialsRole: integrationRole,
      requestTemplates: {
        'application/json': `{
  "stateMachineArn": "${stateMachine.stateMachineArn}",
  "input": "$util.escapeJavaScript($input.body)"
}`,
      },
      integrationResponses: [
        {
          statusCode: '200',
          responseTemplates: {
            'application/json': `{
  "executionArn": $input.json('$.executionArn'),
  "startDate": $input.json('$.startDate')
}`,
          },
        },
        {
          statusCode: '500',
          selectionPattern: '5\\d{2}',
          responseTemplates: {
            'application/json': '{"error": "Failed to start execution"}',
          },
        },
      ],
    },
  });

  const commandsResource = getOrCreateCommandsResource(api);
  commandsResource.addResource(routePath).addMethod('POST', integration, {
    authorizationType: apigateway.AuthorizationType.IAM,
    methodResponses: [
      { statusCode: '200' },
      { statusCode: '500' },
    ],
  });
}

/**
 * Adds a POST route to the API Gateway that runs a Step Functions Express
 * Workflow synchronously and returns the output directly.
 */
export function addSyncExecutionRoute(
  scope: Construct,
  api: apigateway.RestApi,
  routePath: string,
  stateMachine: sfn.StateMachine,
): void {
  const integrationRole = new iam.Role(scope, 'ApiSfnRole', {
    assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
  });
  stateMachine.grantStartSyncExecution(integrationRole);

  const integration = new apigateway.AwsIntegration({
    service: 'states',
    action: 'StartSyncExecution',
    integrationHttpMethod: 'POST',
    options: {
      credentialsRole: integrationRole,
      requestTemplates: {
        'application/json': `{
  "stateMachineArn": "${stateMachine.stateMachineArn}",
  "input": "$util.escapeJavaScript($input.body)"
}`,
      },
      integrationResponses: [
        {
          statusCode: '200',
          selectionPattern: '200',
          responseTemplates: {
            'application/json': [
              '#set($output = $input.json(\'$.output\'))',
              '#if($input.json(\'$.status\') == "SUCCEEDED")',
              '$output',
              '#else',
              '{"error": $input.json(\'$.error\'), "cause": $input.json(\'$.cause\')}',
              '#end',
            ].join('\n'),
          },
        },
        {
          statusCode: '500',
          selectionPattern: '5\\d{2}',
          responseTemplates: {
            'application/json': '{"error": "Failed to execute"}',
          },
        },
      ],
    },
  });

  const commandsResource = getOrCreateCommandsResource(api);
  commandsResource.addResource(routePath).addMethod('POST', integration, {
    authorizationType: apigateway.AuthorizationType.IAM,
    methodResponses: [
      { statusCode: '200' },
      { statusCode: '500' },
    ],
  });
}

function getOrCreateCommandsResource(api: apigateway.RestApi): apigateway.Resource {
  const existing = api.root.getResource('commands');
  if (existing) return existing as apigateway.Resource;
  return api.root.addResource('commands');
}
