import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { CommandQueue } from './command-queue';

export interface DeployStacksCommandProps {
  readonly api: apigateway.RestApi;
  readonly commandQueue: CommandQueue;
}

/**
 * State machine that deploys CloudFormation stacks via change sets.
 *
 * For each stack: checks if it exists, creates a change set (CREATE or UPDATE),
 * waits for the change set, executes it, and waits for completion.
 *
 * Input:
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": {
 *     "stackNames": ["Stack1", "Stack2"],
 *     "templateBaseUrl": "https://s3.amazonaws.com/bucket/prefix"
 *   }
 * }
 * ```
 */
export class DeployStacksCommand extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: DeployStacksCommandProps) {
    super(scope, id);

    const changeSetName = new lonicSfn.StateOutput('"lonic-deploy-" & $replace($states.context.Execution.Name, ":", "-")');

    class Processor extends lonicSfn.MapItemProcessor<{
      StackName: lonicSfn.StateOutput;
      TemplateBaseUrl: lonicSfn.StateOutput;
    }> {
      constructor(
        s: Construct,
        pid: string,
        item: { StackName: lonicSfn.StateOutput; TemplateBaseUrl: lonicSfn.StateOutput },
        vars: lonicSfn.VariableScope,
      ) {
        super(s, pid, item, vars);

        const stackName = vars.declare('StackName');
        const templateBaseUrl = vars.declare('TemplateBaseUrl');

        this.defineStep(
          // Assign variables from item selector so they persist across all states
          lonicSfn.Step.of(
            sfn.Pass.jsonata(this, 'AssignVars', {
              assign: vars.buildAssign({
                StackName: item.StackName.resolveJsonata(),
                TemplateBaseUrl: item.TemplateBaseUrl.resolveJsonata(),
              }),
            }),
            {},
          )
          // Check if stack exists (returns DOES_NOT_EXIST for missing stacks)
          .next(() =>
            lonicSfn.Step.of(
              new lonicSfn.tasks.GetStackStep(this, 'CheckExists', {
                stackName,
              }),
            )
          )
          // Create change set (CREATE for new stacks, UPDATE for existing)
          .next(o =>
            lonicSfn.Step.of(
              new lonicSfn.tasks.CreateChangeSetStep(this, 'CreateChangeSet', {
                stackName,
                changeSetName,
                exists: new lonicSfn.StateOutput(`${o.StackStatus.expression} != "DOES_NOT_EXIST"`),
                templateUrl: new lonicSfn.StateOutput(`${templateBaseUrl.expression} & "/" & ${stackName.expression} & ".template.json"`),
                capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_IAM', 'CAPABILITY_AUTO_EXPAND'],
              }),
            )
          )
          // Poll change set until ready
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
              failError: 'CHANGE_SET_FAILED',
              failCause: 'Change set creation failed',
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
          // Poll until stack deployment completes
          .next(() =>
            lonicSfn.PollUntilStep.wrap(this, 'PollDeploy', {
              interval: cdk.Duration.seconds(10),
              check: lonicSfn.Step.of(
                new lonicSfn.tasks.GetStackStep(this, 'CheckDeployStatus', {
                  stackName,
                }),
              ),
              successWhen: o => sfn.Condition.jsonata(
                `{% ${o.StackStatus.expression} in ["CREATE_COMPLETE", "UPDATE_COMPLETE"] %}`,
              ),
              failWhen: o => sfn.Condition.jsonata(
                `{% not (${o.StackStatus.expression} in ["CREATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"]) %}`,
              ),
              failError: 'DEPLOY_FAILED',
              failCause: 'Stack deployment failed',
            })
          )
        );
      }
    }

    const definition = lonicSfn.tasks.MapStep.jsonata(this, 'MapStacks', {
      items: '{% $states.input.payload.stackNames %}',
      maxConcurrency: 5,
      itemSelector: {
        StackName: '{% $states.context.Map.Item.Value %}',
        TemplateBaseUrl: '{% $states.context.Execution.Input.payload.templateBaseUrl %}',
      },
    }).itemProcessor(Processor);

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition.startState),
      timeout: cdk.Duration.minutes(60),
      stateMachineName: 'LonicAgent-DeployStacks',
    });

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudformation:DescribeStacks',
        'cloudformation:CreateChangeSet',
        'cloudformation:DescribeChangeSet',
        'cloudformation:ExecuteChangeSet',
      ],
      resources: ['*'],
    }));

    // Stacks being deployed may create any resource — grant via CalledVia condition
    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['*'],
      resources: ['*'],
      conditions: {
        'ForAnyValue:StringEquals': {
          'aws:CalledVia': ['cloudformation.amazonaws.com'],
        },
      },
    }));

    props.commandQueue.addQueuedRoute(this, 'deploy-stacks', this.stateMachine);
  }
}
