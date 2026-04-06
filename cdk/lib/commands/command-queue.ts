import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export interface CommandQueueProps {
  /** API Gateway to add queued routes to. */
  readonly api: apigateway.RestApi;
}

/**
 * Shared SQS command queue that sits between API Gateway and Step Functions
 * for all asynchronous commands. Provides backpressure, retry, and dead-letter
 * handling transparently — the backend calls the same API endpoints.
 *
 * Architecture:
 * ```
 * API Gateway POST /commands/{name}
 *   → SQS SendMessage (native integration, embeds stateMachineArn)
 *   → Consumer Lambda (polls SQS, calls StartExecution)
 *   → Step Functions state machine
 * ```
 *
 * Synchronous commands (EXPRESS workflows) bypass the queue entirely.
 */
export class CommandQueue extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly consumerFn: lambda.Function;

  private readonly integrationRole: iam.Role;
  private readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: CommandQueueProps) {
    super(scope, id);

    this.api = props.api;

    // --- Dead-letter queue ---

    this.dlq = new sqs.Queue(this, 'DLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    // --- Main command queue ---

    this.queue = new sqs.Queue(this, 'Queue', {
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3,
      },
    });

    // --- Consumer Lambda ---

    this.consumerFn = new lambda.Function(this, 'ConsumerFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { SFNClient, StartExecutionCommand } = require("@aws-sdk/client-sfn");
const sfn = new SFNClient();

exports.handler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: message.stateMachineArn,
      input: message.input,
    }));
  }
};
`),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      description: 'Consumes commands from the SQS queue and starts Step Functions executions',
    });

    this.consumerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [
        cdk.Arn.format({
          service: 'states',
          resource: 'stateMachine',
          resourceName: 'LonicAgent-*',
        }, cdk.Stack.of(this)),
      ],
    }));

    this.consumerFn.addEventSource(new lambdaEventSources.SqsEventSource(this.queue, {
      batchSize: 1,
    }));

    // --- Shared API Gateway → SQS integration role ---

    this.integrationRole = new iam.Role(this, 'ApiSqsRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });

    this.queue.grantSendMessages(this.integrationRole);
  }

  /**
   * Adds a POST route under `/commands/{routePath}` that enqueues the request
   * into the SQS command queue. The message includes the target state machine
   * ARN so the consumer Lambda knows which execution to start.
   *
   * Returns 202 Accepted with `{"status":"accepted","messageId":"..."}`.
   */
  public addQueuedRoute(
    scope: Construct,
    routePath: string,
    stateMachine: sfn.StateMachine,
  ): void {
    const integration = new apigateway.AwsIntegration({
      service: 'sqs',
      path: `${cdk.Aws.ACCOUNT_ID}/${this.queue.queueName}`,
      integrationHttpMethod: 'POST',
      options: {
        credentialsRole: this.integrationRole,
        requestParameters: {
          'integration.request.header.Content-Type': "'application/x-www-form-urlencoded'",
        },
        requestTemplates: {
          'application/json': [
            'Action=SendMessage',
            `&MessageBody=$util.urlEncode('{"stateMachineArn":"${stateMachine.stateMachineArn}","input":"' + $util.escapeJavaScript($input.body) + '"}')`,
          ].join(''),
        },
        integrationResponses: [
          {
            statusCode: '202',
            responseTemplates: {
              'application/json': '{"status":"accepted","messageId":"$input.path(\'$.SendMessageResponse.SendMessageResult.MessageId\')"}',
            },
          },
          {
            statusCode: '500',
            selectionPattern: '5\\d{2}',
            responseTemplates: {
              'application/json': '{"error":"Failed to enqueue command"}',
            },
          },
        ],
      },
    });

    const commandsResource = this.getOrCreateCommandsResource();
    commandsResource.addResource(routePath).addMethod('POST', integration, {
      authorizationType: apigateway.AuthorizationType.IAM,
      methodResponses: [
        { statusCode: '202' },
        { statusCode: '500' },
      ],
    });
  }

  private getOrCreateCommandsResource(): apigateway.Resource {
    const existing = this.api.root.getResource('commands');
    if (existing) return existing as apigateway.Resource;
    return this.api.root.addResource('commands');
  }
}
