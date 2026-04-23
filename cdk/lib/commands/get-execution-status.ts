import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { addSyncExecutionRoute } from './api-sfn-integration';

export interface GetExecutionStatusCommandProps {
  readonly api: apigateway.RestApi;
}

/**
 * State machine that queries a Step Functions execution status.
 *
 * Input:
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": { "executionArn": "arn:aws:states:..." }
 * }
 * ```
 */
export class GetExecutionStatusCommand extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: GetExecutionStatusCommandProps) {
    super(scope, id);

    const definition = lonicSfn.Step.of(
      new lonicSfn.tasks.DescribeExecutionStep(this, 'DescribeExecution', {
        executionArn: new lonicSfn.StateOutput('$states.input.payload.executionArn'),
      }),
    );

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition.startState),
      queryLanguage: sfn.QueryLanguage.JSONATA,
      stateMachineType: sfn.StateMachineType.EXPRESS,
      timeout: cdk.Duration.minutes(1),
      stateMachineName: 'LonicAgent-GetExecutionStatus',
    });

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:DescribeExecution'],
      resources: ['*'],
    }));

    addSyncExecutionRoute(this, props.api, 'get-execution-status', this.stateMachine);
  }
}
