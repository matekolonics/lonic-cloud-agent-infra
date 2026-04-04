import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { addStartExecutionRoute } from './api-sfn-integration';

export interface DeployStacksCommandProps {
  readonly api: apigateway.RestApi;
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

    const changeSetNameExpr = '"lonic-deploy-" & $replace($states.context.Execution.Name, ":", "-")';

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
          // Check if stack exists — catch determines CREATE vs UPDATE
          .next(() =>
            lonicSfn.Step.of(
              new sfn.CustomState(this, 'DescribeStack', {
                stateJson: {
                  Type: 'Task',
                  Resource: 'arn:aws:states:::aws-sdk:cloudformation:describeStacks',
                  Arguments: {
                    StackName: stackName.resolveJsonata(),
                  },
                  Output: { changeSetType: 'UPDATE' },
                  Catch: [{
                    ErrorEquals: ['CloudFormation.CloudFormationException'],
                    Comment: 'Stack does not exist',
                    Output: { changeSetType: 'CREATE' },
                    Next: 'CreateChangeSet',
                  }],
                },
              }),
              {},
            )
          )
          // Create change set (both success and catch paths arrive here)
          .next(() =>
            lonicSfn.Step.of(
              new sfn.CustomState(this, 'CreateChangeSet', {
                stateJson: {
                  Type: 'Task',
                  Resource: 'arn:aws:states:::aws-sdk:cloudformation:createChangeSet',
                  Arguments: {
                    StackName: stackName.resolveJsonata(),
                    ChangeSetName: `{% ${changeSetNameExpr} %}`,
                    ChangeSetType: '{% $states.input.changeSetType %}',
                    TemplateURL: `{% ${templateBaseUrl.expression} & "/" & ${stackName.expression} & ".template.json" %}`,
                    Capabilities: [
                      'CAPABILITY_NAMED_IAM',
                      'CAPABILITY_IAM',
                      'CAPABILITY_AUTO_EXPAND',
                    ],
                  },
                  Output: {},
                },
              }),
              {},
            )
          )
          // Poll change set status
          .next(() =>
            lonicSfn.Step.of(
              sfn.Wait.jsonata(this, 'WaitForChangeSet', {
                time: sfn.WaitTime.duration(cdk.Duration.seconds(5)),
              }),
              {},
            )
            .next((_, __, waitCs) =>
              lonicSfn.Step.of(
                new sfn.CustomState(this, 'DescribeChangeSet', {
                  stateJson: {
                    Type: 'Task',
                    Resource: 'arn:aws:states:::aws-sdk:cloudformation:describeChangeSet',
                    Arguments: {
                      ChangeSetName: `{% ${changeSetNameExpr} %}`,
                      StackName: stackName.resolveJsonata(),
                    },
                    Output: {
                      status: '{% $states.result.Status %}',
                    },
                  },
                }),
                { status: new lonicSfn.StateOutput('status') },
              )
              .choice(sfn.Choice.jsonata(this, 'IsChangeSetReady', {}))
              .branch(
                o => sfn.Condition.jsonata(`{% ${o.status.expression} = "FAILED" %}`),
                () => new sfn.Fail(this, 'ChangeSetFailed', {
                  cause: 'Change set creation failed',
                  error: 'CHANGE_SET_FAILED',
                }),
              )
              .branch(
                o => sfn.Condition.jsonata(`{% ${o.status.expression} != "CREATE_COMPLETE" %}`),
                () => waitCs,
              )
              // CREATE_COMPLETE — execute change set and poll deploy status
              .defaultBranch(() =>
                lonicSfn.Step.of(
                  new sfn.CustomState(this, 'ExecuteChangeSet', {
                    stateJson: {
                      Type: 'Task',
                      Resource: 'arn:aws:states:::aws-sdk:cloudformation:executeChangeSet',
                      Arguments: {
                        ChangeSetName: `{% ${changeSetNameExpr} %}`,
                        StackName: stackName.resolveJsonata(),
                      },
                      Output: {},
                    },
                  }),
                  {},
                )
                .next(() =>
                  lonicSfn.Step.of(
                    sfn.Wait.jsonata(this, 'WaitForDeploy', {
                      time: sfn.WaitTime.duration(cdk.Duration.seconds(10)),
                    }),
                    {},
                  )
                  .next((_, __, waitDeploy) =>
                    lonicSfn.Step.of(
                      new sfn.CustomState(this, 'CheckStackStatus', {
                        stateJson: {
                          Type: 'Task',
                          Resource: 'arn:aws:states:::aws-sdk:cloudformation:describeStacks',
                          Arguments: {
                            StackName: stackName.resolveJsonata(),
                          },
                          Output: {
                            status: '{% $states.result.Stacks[0].StackStatus %}',
                          },
                        },
                      }),
                      { status: new lonicSfn.StateOutput('status') },
                    )
                    .choice(sfn.Choice.jsonata(this, 'IsDeployComplete', {}))
                    .branch(
                      o => sfn.Condition.jsonata(
                        `{% ${o.status.expression} in ["CREATE_COMPLETE", "UPDATE_COMPLETE"] %}`,
                      ),
                      () => sfn.Succeed.jsonata(this, 'DeploySucceeded', {}),
                    )
                    .branch(
                      o => sfn.Condition.jsonata(
                        `{% ${o.status.expression} in ["CREATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"] %}`,
                      ),
                      () => waitDeploy,
                    )
                    .defaultBranch(() =>
                      new sfn.Fail(this, 'DeployFailed', {
                        cause: 'Stack deployment failed',
                        error: 'DEPLOY_FAILED',
                      }),
                    )
                    .build()
                  )
                )
              )
              .build()
            )
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

    addStartExecutionRoute(this, props.api, 'deploy-stacks', this.stateMachine);
  }
}
