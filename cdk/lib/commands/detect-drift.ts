import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { CommandQueue } from './command-queue';

export interface DetectDriftCommandProps {
  readonly api: apigateway.RestApi;
  readonly commandQueue: CommandQueue;
}

/**
 * State machine that runs CloudFormation drift detection on a stack
 * and polls until the detection is complete, then returns detailed drift results.
 *
 * Input:
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": { "stackName": "MyStack" }
 * }
 * ```
 */
export class DetectDriftCommand extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: DetectDriftCommandProps) {
    super(scope, id);

    const definition = lonicSfn.Step.of(
      new lonicSfn.tasks.DetectStackDriftStep(this, 'DetectDrift', {
        stackName: new lonicSfn.StateOutput('$states.context.Execution.Input.payload.stackName'),
      }),
    )
    .next(o =>
      lonicSfn.PollUntilStep.wrap(this, 'PollDetection', {
        interval: cdk.Duration.seconds(10),
        check: lonicSfn.Step.of(
          new lonicSfn.tasks.DescribeDriftDetectionStatusStep(this, 'CheckStatus', {
            stackDriftDetectionId: o.StackDriftDetectionId,
          }),
        ),
        successWhen: s => sfn.Condition.jsonata(
          `{% ${s.DetectionStatus.expression} = "DETECTION_COMPLETE" %}`,
        ),
        failWhen: s => sfn.Condition.jsonata(
          `{% ${s.DetectionStatus.expression} = "DETECTION_FAILED" %}`,
        ),
        failError: 'DETECTION_FAILED',
        failCause: 'Stack drift detection failed',
      })
    )
    .next(() =>
      lonicSfn.Step.of(
        new lonicSfn.tasks.DescribeStackResourceDriftsStep(this, 'GetDriftDetails', {
          stackName: new lonicSfn.StateOutput('$states.context.Execution.Input.payload.stackName'),
          stackResourceDriftStatusFilters: ['MODIFIED', 'DELETED', 'NOT_CHECKED'],
        }),
      )
    );

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition.startState),
      queryLanguage: sfn.QueryLanguage.JSONATA,
      timeout: cdk.Duration.minutes(10),
      stateMachineName: 'LonicAgent-DetectDrift',
    });

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudformation:DetectStackDrift',
        'cloudformation:DescribeStackDriftDetectionStatus',
        'cloudformation:DescribeStackResourceDrifts',
      ],
      resources: ['*'],
    }));

    props.commandQueue.addQueuedRoute(this, 'detect-drift', this.stateMachine);
  }
}
