import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { addSyncExecutionRoute } from './api-sfn-integration';

export interface StartExecutionCommandProps {
  readonly api: apigateway.RestApi;
}

/**
 * State machine that starts a Step Functions execution and returns
 * the execution ARN. Thin wrapper around the StartExecution SDK call.
 *
 * Input:
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": {
 *     "stateMachineArn": "arn:aws:states:...",
 *     "input": { ... }
 *   }
 * }
 * ```
 */
export class StartExecutionCommand extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: StartExecutionCommandProps) {
    super(scope, id);

    const definition = lonicSfn.Step.of(
      new lonicSfn.tasks.StartExecutionStep(this, 'StartExecution', {
        stateMachineArn: new lonicSfn.StateOutput('$states.input.payload.stateMachineArn'),
        input: new lonicSfn.StateOutput('$string($states.input.payload.input)'),
      }),
    );

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition.startState),
      stateMachineType: sfn.StateMachineType.EXPRESS,
      timeout: cdk.Duration.minutes(1),
      stateMachineName: 'LonicAgent-StartExecution',
    });

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: ['*'],
    }));

    addSyncExecutionRoute(this, props.api, 'start-execution', this.stateMachine);
  }
}
