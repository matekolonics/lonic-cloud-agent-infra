import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { CommandQueue } from './command-queue';

export interface GetChangesetCommandProps {
  readonly api: apigateway.RestApi;
  readonly commandQueue: CommandQueue;
}

/**
 * State machine that creates a CloudFormation change set (without executing it),
 * polls until ready, returns the list of changes, and cleans up the change set.
 *
 * Input:
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": {
 *     "stackName": "MyStack",
 *     "templateUrl": "https://s3.amazonaws.com/bucket/template.json",
 *     "changeSetType": "UPDATE"
 *   }
 * }
 * ```
 */
export class GetChangesetCommand extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: GetChangesetCommandProps) {
    super(scope, id);

    // Use Execution.Input so these expressions remain valid across all states, not just the first
    const stackName = new lonicSfn.StateOutput('$states.context.Execution.Input.payload.stackName');
    const changeSetName = new lonicSfn.StateOutput('"lonic-preview-" & $replace($states.context.Execution.Name, ":", "-")');

    const definition = lonicSfn.Step.of(
      new lonicSfn.tasks.CreateChangeSetStep(this, 'CreateChangeSet', {
        stackName,
        changeSetName,
        exists: new lonicSfn.StateOutput('$states.context.Execution.Input.payload.changeSetType = "UPDATE"'),
        templateUrl: new lonicSfn.StateOutput('$states.context.Execution.Input.payload.templateUrl'),
      }),
    )
    .next(() =>
      lonicSfn.PollUntilStep.wrap(this, 'PollChangeSet', {
        interval: cdk.Duration.seconds(5),
        check: lonicSfn.Step.of(
          new lonicSfn.tasks.GetChangeSetStatusStep(this, 'DescribeChangeSet', {
            stackName,
            changeSetName,
          }),
        ),
        successWhen: o => sfn.Condition.jsonata(
          `{% ${o.Status.expression} = "CREATE_COMPLETE" %}`,
        ),
        failWhen: o => sfn.Condition.jsonata(
          `{% ${o.Status.expression} = "FAILED" %}`,
        ),
        failError: 'CHANGESET_FAILED',
        failCause: 'Change set creation failed',
      })
    )
    .next(() =>
      lonicSfn.Step.of(
        new lonicSfn.tasks.DeleteChangeSetStep(this, 'DeleteChangeSet', {
          stackName,
          changeSetName,
        }),
      )
    );

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition.startState),
      timeout: cdk.Duration.minutes(10),
      stateMachineName: 'LonicAgent-GetChangeset',
    });

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudformation:CreateChangeSet',
        'cloudformation:DescribeChangeSet',
        'cloudformation:DeleteChangeSet',
      ],
      resources: ['*'],
    }));

    props.commandQueue.addQueuedRoute(this, 'get-changeset', this.stateMachine);
  }
}
