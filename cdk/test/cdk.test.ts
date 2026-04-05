import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { LonicCloudAgentStack } from '../lib/LonicCloudAgentStack';

const BACKEND_ROLE_ARN = 'arn:aws:iam::123456789012:role/LonicBackendRole';
const ARTIFACT_BUCKET = 'lonic-agent-artifacts';
const AGENT_VERSION = '0.1.0';
const CALLBACK_BASE_URL = 'https://api.lonic.dev';

function createStack(): Template {
  const app = new cdk.App();
  const stack = new LonicCloudAgentStack(app, 'TestStack', {
    backendRoleArn: BACKEND_ROLE_ARN,
    artifactBucket: ARTIFACT_BUCKET,
    agentVersion: AGENT_VERSION,
    callbackBaseUrl: CALLBACK_BASE_URL,
  });
  return Template.fromStack(stack);
}


// --- CfnParameters ---

test('has AgentId parameter with placeholder default', () => {
  const template = createStack();
  template.hasParameter('AgentId', {
    Type: 'String',
    Default: '{{AGENT_ID}}',
    NoEcho: true,
  });
});

test('has SetupToken parameter with placeholder default', () => {
  const template = createStack();
  template.hasParameter('SetupToken', {
    Type: 'String',
    Default: '{{SETUP_TOKEN}}',
    NoEcho: true,
  });
});

// --- API Gateway ---

test('creates a REST API with the correct name', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    Name: 'LonicCloudAgentApi',
  });
});

test('API has a resource policy allowing only the backend role', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    Policy: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Allow',
          Principal: { AWS: BACKEND_ROLE_ARN },
          Action: 'execute-api:Invoke',
        }),
        Match.objectLike({
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Action: 'execute-api:Invoke',
          Condition: {
            StringNotEquals: {
              'aws:PrincipalArn': BACKEND_ROLE_ARN,
            },
          },
        }),
      ]),
    }),
  });
});

test('root method uses IAM authorization', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    AuthorizationType: 'AWS_IAM',
    HttpMethod: 'ANY',
  });
});

// --- Secrets Manager ---

test('creates a Secrets Manager secret for the callback token', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Description: Match.stringLikeRegexp('Bearer token'),
  });
});

// --- Registration Custom Resource ---

test('registration Lambda uses Node.js and has correct env vars', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Description: Match.stringLikeRegexp('Registers the agent'),
    Environment: {
      Variables: Match.objectLike({
        CALLBACK_BASE_URL: CALLBACK_BASE_URL,
        SECRET_ARN: Match.anyValue(),
      }),
    },
  });
});

test('registration Lambda has permission to write to the callback token secret', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            'secretsmanager:PutSecretValue',
          ]),
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('custom resource passes AgentId and SetupToken from parameters', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
    AgentId: { Ref: 'AgentId' },
    SetupToken: { Ref: 'SetupToken' },
    AgentVersion: AGENT_VERSION,
  });
});

// --- Lambda: event-reporter ---

test('event-reporter Lambda uses ARM64 and provided.al2023', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'provided.al2023',
    Architectures: ['arm64'],
    Handler: 'bootstrap',
    Description: `lonic cloud agent event-reporter v${AGENT_VERSION}`,
  });
});

test('event-reporter Lambda pulls code from the versioned S3 artifact', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: ARTIFACT_BUCKET,
      S3Key: `agent/v${AGENT_VERSION}/event-reporter-arm64.zip`,
    },
  });
});

test('event-reporter Lambda has required environment variables', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({
        AGENT_ID: { Ref: 'AgentId' },
        LONIC_CALLBACK_BASE_URL: CALLBACK_BASE_URL,
        LONIC_CALLBACK_TOKEN_ARN: Match.anyValue(),
      }),
    },
  });
});

test('event-reporter has CloudFormation event enrichment permissions', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'cloudformation:DescribeStackEvents',
          Effect: 'Allow',
          Resource: '*',
        }),
      ]),
    }),
  });
});

// --- EventBridge ---

test('EventBridge rule routes state machine completions to event-reporter', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: Match.objectLike({
      source: ['aws.states'],
      'detail-type': ['Step Functions Execution Status Change'],
      detail: {
        status: ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'],
      },
    }),
  });
});

// --- Lambda: health-check ---

test('health-check Lambda uses ARM64 and provided.al2023', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'provided.al2023',
    Architectures: ['arm64'],
    Handler: 'bootstrap',
    Description: `lonic cloud agent health-check v${AGENT_VERSION}`,
  });
});

test('health-check Lambda pulls code from the versioned S3 artifact', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: ARTIFACT_BUCKET,
      S3Key: `agent/v${AGENT_VERSION}/health-check-arm64.zip`,
    },
  });
});

test('health-check Lambda has AGENT_ID environment variable', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::Lambda::Function', {
    Description: Match.stringLikeRegexp('health-check'),
    Environment: {
      Variables: Match.objectLike({
        AGENT_ID: { Ref: 'AgentId' },
      }),
    },
  });
});

test('health-check has STS permissions', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'sts:GetCallerIdentity',
          Effect: 'Allow',
          Resource: '*',
        }),
      ]),
    }),
  });
});

test('health-check route exists at GET /health with IAM auth', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'GET',
    AuthorizationType: 'AWS_IAM',
  });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'health',
  });
});

// --- State Machines ---

test('creates command and pipeline state machines', () => {
  const template = createStack();
  const stateMachines = template.findResources('AWS::StepFunctions::StateMachine');
  // 7 command state machines + pipeline state machine + child express workflows from DeployStacksStep
  expect(Object.keys(stateMachines).length).toBeGreaterThan(7);
});

test('describe-stacks state machine has CloudFormation permissions', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'cloudformation:DescribeStacks',
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('get-execution-status state machine has SFN permissions', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'states:DescribeExecution',
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('destroy-stacks state machine has delete and describe permissions', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: ['cloudformation:DeleteStack', 'cloudformation:DescribeStacks'],
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('deploy-stacks state machine has full change set permissions', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: [
            'cloudformation:DescribeStacks',
            'cloudformation:CreateChangeSet',
            'cloudformation:DescribeChangeSet',
            'cloudformation:ExecuteChangeSet',
          ],
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('API Gateway has command routes', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'commands',
  });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'describe-stacks',
  });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'get-execution-status',
  });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'destroy-stacks',
  });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'deploy-stacks',
  });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'detect-drift',
  });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'get-changeset',
  });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'start-execution',
  });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'deploy-pipeline',
  });
});

test('API Gateway has get-upload-url route', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'get-upload-url',
  });
});

test('command routes use POST with IAM auth', () => {
  const template = createStack();
  // 7 command routes + 1 pipeline route + 1 get-upload-url route = 9 POST methods
  const postMethods = template.findResources('AWS::ApiGateway::Method', {
    Properties: {
      HttpMethod: 'POST',
      AuthorizationType: 'AWS_IAM',
    },
  });
  expect(Object.keys(postMethods).length).toBe(9);
});

// --- Outputs ---

test('outputs API URL, API ARN, and callback token secret ARN via SSM parameters', () => {
  const template = createStack();
  template.resourceCountIs('AWS::SSM::Parameter', 3);
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: Match.stringLikeRegexp('/lonic-cdk-commons/TestStack/ApiUrl-'),
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: Match.stringLikeRegexp('/lonic-cdk-commons/TestStack/ApiArn-'),
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: Match.stringLikeRegexp('/lonic-cdk-commons/TestStack/CallbackTokenSecretArn-'),
  });
});

// --- Deployment Pipeline ---

test('pipeline creates a CodeBuild project for CDK synth', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::CodeBuild::Project', {
    Description: Match.stringLikeRegexp('CDK'),
    Source: { Type: 'NO_SOURCE' },
  });
});

test('pipeline creates an artifacts S3 bucket', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test('pipeline state machine has CloudFormation CalledVia permissions', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: '*',
          Effect: 'Allow',
          Resource: '*',
          Condition: {
            'ForAnyValue:StringEquals': {
              'aws:CalledVia': ['cloudformation.amazonaws.com'],
            },
          },
        }),
      ]),
    }),
  });
});

// --- Phase 7: Additional stack management commands ---

test('detect-drift state machine has drift detection permissions', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: [
            'cloudformation:DetectStackDrift',
            'cloudformation:DescribeStackDriftDetectionStatus',
            'cloudformation:DescribeStackResourceDrifts',
          ],
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('get-changeset state machine has change set permissions', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: [
            'cloudformation:CreateChangeSet',
            'cloudformation:DescribeChangeSet',
            'cloudformation:DeleteChangeSet',
          ],
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('start-execution state machine has SFN start permissions', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'states:StartExecution',
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

// --- Get Upload URL ---

test('get-upload-url Lambda uses Node.js 22 on ARM64', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Architectures: ['arm64'],
    Description: Match.stringLikeRegexp('presigned'),
  });
});

test('get-upload-url Lambda has upload bucket environment variables', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::Lambda::Function', {
    Description: Match.stringLikeRegexp('presigned'),
    Environment: {
      Variables: Match.objectLike({
        UPLOAD_BUCKET: Match.anyValue(),
        UPLOAD_KEY_PREFIX: 'uploads',
        URL_EXPIRATION_SECONDS: '900',
      }),
    },
  });
});

test('get-upload-url Lambda has S3 PutObject permissions on upload prefix', () => {
  const template = createStack();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['s3:PutObject']),
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});
