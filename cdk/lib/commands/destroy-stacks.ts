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

    class Processor extends lonicSfn.MapItemProcessor<{ StackName: lonicSfn.StateOutput }> {
      constructor(s: Construct, pid: string, item: { StackName: lonicSfn.StateOutput }, vars: lonicSfn.VariableScope) {
        super(s, pid, item, vars);

        this.defineStep(
          lonicSfn.Step.of(
              sfn.Pass.jsonata(this, 'AssignVars', {
                  assign: vars.buildAssign({ StackName: item.StackName.resolveJsonata() }),
              }),
              {},
              {
                  StackName: vars.declare('StackName'),
              }
          )
          .next((_, vars) =>
            lonicSfn.Step.of(
              new lonicSfn.tasks.DeleteStackStep(this, 'DeleteStack', {
                stackName: vars.StackName,
              }),
            )
          )
          .next((_, vars) =>
            lonicSfn.PollUntilStep.wrap(this, 'PollDeletion', {
              interval: cdk.Duration.seconds(10),
              check: lonicSfn.Step.of(
                new lonicSfn.tasks.GetStackStep(this, 'CheckDeleteStatus', {
                  stackName: vars.StackName,
                }),
              ),
              successWhen: o => sfn.Condition.jsonata(
                `{% ${o.StackStatus.expression} = "DELETE_COMPLETE" or ${o.StackStatus.expression} = "DOES_NOT_EXIST" %}`,
              ),
              failWhen: o => sfn.Condition.jsonata(
                `{% ${o.StackStatus.expression} = "DELETE_FAILED" %}`,
              ),
              failError: 'DELETE_FAILED',
              failCause: 'Stack deletion failed',
            })
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
