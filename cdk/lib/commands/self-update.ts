import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { addStartExecutionRoute } from './api-sfn-integration';

export interface SelfUpdateCommandProps {
  readonly api: apigateway.RestApi;
}

/**
 * State machine that updates the agent's own CloudFormation stack
 * by applying a raw CloudFormation template via change sets.
 *
 * The backend synthesises the new agent template ahead of time, uploads
 * it to S3 via the `get-upload-url` endpoint, and triggers this command
 * with the template's S3 URL.
 *
 * Flow: CreateChangeSet → poll until ready → ExecuteChangeSet → poll until complete.
 *
 * Input:
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": {
 *     "stackName": "LonicCloudAgent",
 *     "templateUrl": "https://s3.amazonaws.com/bucket/path/template.json"
 *   }
 * }
 * ```
 */
export class SelfUpdateCommand extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: SelfUpdateCommandProps) {
    super(scope, id);

    const stackName = new lonicSfn.StateOutput('$states.context.Execution.Input.payload.stackName');
    const changeSetName = new lonicSfn.StateOutput('"lonic-self-update-" & $replace($states.context.Execution.Name, ":", "-")');

    const definition = lonicSfn.Step.of(
      new lonicSfn.tasks.CreateChangeSetStep(this, 'CreateChangeSet', {
        stackName,
        changeSetName,
        exists: new lonicSfn.StateOutput('true'),
        templateUrl: new lonicSfn.StateOutput('$states.context.Execution.Input.payload.templateUrl'),
        capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_IAM', 'CAPABILITY_AUTO_EXPAND'],
      }),
    )
    // Poll until change set is ready
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
        failCause: 'Self-update change set creation failed',
      })
    )
    // Execute the change set
    .next(() =>
      lonicSfn.Step.of(
        new lonicSfn.tasks.ExecuteChangeSetStep(this, 'ExecuteChangeSet', {
          stackName,
          changeSetName,
        }),
      )
    )
    // Poll until stack update completes (manual loop to avoid duplicate
    // state names from a second PollUntilStep in the same state machine)
    .next(() =>
      lonicSfn.Step.of(
        sfn.Wait.jsonata(this, 'WaitForUpdate', {
          time: sfn.WaitTime.duration(cdk.Duration.seconds(10)),
        }),
        {},
      )
      .next((_, __, waitStep) =>
        lonicSfn.Step.of(
          new lonicSfn.tasks.GetStackStep(this, 'CheckStackStatus', {
            stackName,
          }),
        )
        .choice(sfn.Choice.jsonata(this, 'IsUpdateComplete', {}))
        .branch(
          o => sfn.Condition.jsonata(
            `{% ${o.StackStatus.expression} in ["UPDATE_COMPLETE"] %}`,
          ),
          () => sfn.Succeed.jsonata(this, 'UpdateSucceeded', {}),
        )
        .branch(
          o => sfn.Condition.jsonata(
            `{% ${o.StackStatus.expression} in ["UPDATE_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"] %}`,
          ),
          () => waitStep,
        )
        .defaultBranch(() =>
          new sfn.Fail(this, 'UpdateFailed', {
            cause: 'Agent stack update failed',
            error: 'UPDATE_FAILED',
          }),
        )
        .build()
      )
    );

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition.startState),
      timeout: cdk.Duration.minutes(30),
      stateMachineName: 'LonicAgent-SelfUpdate',
    });

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudformation:CreateChangeSet',
        'cloudformation:DescribeChangeSet',
        'cloudformation:ExecuteChangeSet',
        'cloudformation:DescribeStacks',
      ],
      resources: ['*'],
    }));

    // The change set may update any resource in the agent stack
    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['*'],
      resources: ['*'],
      conditions: {
        'ForAnyValue:StringEquals': {
          'aws:CalledVia': ['cloudformation.amazonaws.com'],
        },
      },
    }));

    addStartExecutionRoute(this, props.api, 'self-update', this.stateMachine);
  }
}
