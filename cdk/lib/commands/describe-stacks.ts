import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { addSyncExecutionRoute } from './api-sfn-integration';

export interface DescribeStacksCommandProps {
  readonly api: apigateway.RestApi;
}

/**
 * State machine that calls CloudFormation DescribeStacks for each requested stack.
 *
 * Input:
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": { "stackNames": ["Stack1", "Stack2"] }
 * }
 * ```
 */
export class DescribeStacksCommand extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: DescribeStacksCommandProps) {
    super(scope, id);

    class Processor extends lonicSfn.MapItemProcessor<{ StackName: lonicSfn.StateOutput }> {
      constructor(s: Construct, pid: string, item: { StackName: lonicSfn.StateOutput }, vars: lonicSfn.VariableScope) {
        super(s, pid, item, vars);
        this.defineStep(
          lonicSfn.Step.of(
            new sfn.CustomState(this, 'DescribeStacks', {
              stateJson: {
                Type: 'Task',
                Resource: 'arn:aws:states:::aws-sdk:cloudformation:describeStacks',
                Arguments: {
                  StackName: item.StackName.resolveJsonata(),
                },
                Output: {
                  stacks: '{% $states.result.Stacks %}',
                },
              },
            }),
            {},
          ),
        );
      }
    }

    const definition = lonicSfn.tasks.MapStep.jsonata(this, 'MapStacks', {
      items: '{% $states.input.payload.stackNames %}',
      maxConcurrency: 5,
      itemSelector: {
        StackName: '{% $states.context.Map.Item.Value %}',
      },
    }).itemProcessor(Processor);

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition.startState),
      stateMachineType: sfn.StateMachineType.EXPRESS,
      timeout: cdk.Duration.minutes(5),
      stateMachineName: 'LonicAgent-DescribeStacks',
    });

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: ['*'],
    }));

    addSyncExecutionRoute(this, props.api, 'describe-stacks', this.stateMachine);
  }
}
