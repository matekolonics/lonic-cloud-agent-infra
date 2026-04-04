import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { addStartExecutionRoute } from './api-sfn-integration';

export interface DestroyStacksCommandProps {
  readonly api: apigateway.RestApi;
}

/**
 * State machine that deletes CloudFormation stacks and waits for completion.
 * Stacks are deleted sequentially (caller provides dependency-aware order).
 *
 * Input:
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": { "stackNames": ["ChildStack", "ParentStack"] }
 * }
 * ```
 */
export class DestroyStacksCommand extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: DestroyStacksCommandProps) {
    super(scope, id);

    const command = this;

    class Processor extends lonicSfn.MapItemProcessor<{ StackName: lonicSfn.StateOutput }> {
      constructor(s: Construct, pid: string, item: { StackName: lonicSfn.StateOutput }, vars: lonicSfn.VariableScope) {
        super(s, pid, item, vars);

        const stackName = vars.declare('StackName');

        this.defineStep(
          lonicSfn.Step.of(
            new sfn.CustomState(this, 'DeleteStack', {
              stateJson: {
                Type: 'Task',
                Resource: 'arn:aws:states:::aws-sdk:cloudformation:deleteStack',
                Arguments: {
                  StackName: item.StackName.resolveJsonata(),
                },
                Assign: vars.buildAssign({
                  StackName: item.StackName.resolveJsonata(),
                }),
                Output: {},
              },
            }),
            {},
          )
          .next(() =>
            lonicSfn.Step.of(
              sfn.Wait.jsonata(this, 'WaitForDelete', {
                time: sfn.WaitTime.duration(cdk.Duration.seconds(10)),
              }),
              {},
            )
            .next((_, __, waitStep) =>
              lonicSfn.Step.of(
                new sfn.CustomState(this, 'CheckDeleteStatus', {
                  stateJson: {
                    Type: 'Task',
                    Resource: 'arn:aws:states:::aws-sdk:cloudformation:describeStacks',
                    Arguments: {
                      StackName: stackName.resolveJsonata(),
                    },
                    Output: {
                      status: '{% $states.result.Stacks[0].StackStatus %}',
                    },
                    Catch: [{
                      ErrorEquals: ['CloudFormation.CloudFormationException'],
                      Comment: 'Stack no longer exists — delete succeeded',
                      Output: {},
                      Next: 'DeleteSucceeded',
                    }],
                  },
                }),
                { status: new lonicSfn.StateOutput('status') },
              )
              .choice(sfn.Choice.jsonata(this, 'IsDeleting', {}))
              .branch(
                o => sfn.Condition.jsonata(`{% ${o.status.expression} = "DELETE_IN_PROGRESS" %}`),
                () => waitStep,
              )
              .branch(
                o => sfn.Condition.jsonata(`{% ${o.status.expression} = "DELETE_COMPLETE" %}`),
                () => sfn.Succeed.jsonata(this, 'DeleteSucceeded', {}),
              )
              .defaultBranch(() =>
                new sfn.Fail(this, 'DeleteFailed', {
                  cause: 'Stack deletion failed',
                  error: 'DELETE_FAILED',
                }),
              )
              .build()
            )
          )
        );
      }
    }

    const definition = lonicSfn.tasks.MapStep.jsonata(this, 'MapStacks', {
      items: '{% $states.input.payload.stackNames %}',
      maxConcurrency: 1,
      itemSelector: {
        StackName: '{% $states.context.Map.Item.Value %}',
      },
    }).itemProcessor(Processor);

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition.startState),
      timeout: cdk.Duration.minutes(30),
      stateMachineName: 'LonicAgent-DestroyStacks',
    });

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DeleteStack', 'cloudformation:DescribeStacks'],
      resources: ['*'],
    }));

    addStartExecutionRoute(this, props.api, 'destroy-stacks', this.stateMachine);
  }
}
