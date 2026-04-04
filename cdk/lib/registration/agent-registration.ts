import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface AgentRegistrationProps {
  readonly agentIdParam: cdk.CfnParameter;
  readonly setupTokenParam: cdk.CfnParameter;
  readonly agentVersion: string;
  readonly callbackBaseUrl: string;
}

export class AgentRegistration extends Construct {
  public readonly callbackTokenSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: AgentRegistrationProps) {
    super(scope, id);

    this.callbackTokenSecret = new secretsmanager.Secret(this, 'CallbackTokenSecret', {
      description: 'Bearer token for authenticating agent callbacks to the lonic hosted backend.',
    });

    const registrationFn = new lambda.Function(this, 'RegistrationFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(registrationHandlerCode()),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      description: 'Registers the agent with the lonic backend and stores the callback token.',
      environment: {
        CALLBACK_BASE_URL: props.callbackBaseUrl,
        SECRET_ARN: this.callbackTokenSecret.secretArn,
      },
    });

    this.callbackTokenSecret.grantWrite(registrationFn);

    const registrationProvider = new cr.Provider(this, 'RegistrationProvider', {
      onEventHandler: registrationFn,
    });

    const registration = new cdk.CustomResource(this, 'AgentRegistration', {
      serviceToken: registrationProvider.serviceToken,
      properties: {
        AgentId: props.agentIdParam.valueAsString,
        SetupToken: props.setupTokenParam.valueAsString,
        AgentVersion: props.agentVersion,
      },
    });

    registration.node.addDependency(this.callbackTokenSecret);
  }
}

function registrationHandlerCode(): string {
  return `
const https = require('https');
const { SecretsManagerClient, PutSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const smClient = new SecretsManagerClient();

exports.handler = async (event) => {
  const { AgentId, SetupToken, AgentVersion } = event.ResourceProperties;

  if (event.RequestType === 'Delete') {
    try {
      await callBackend('/agent/deregister', { agentId: AgentId });
    } catch (e) {
      console.log('Deregistration failed (non-fatal):', e.message);
    }
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const result = await callBackend('/agent/register', {
    agentId: AgentId,
    setupToken: SetupToken,
    agentVersion: AgentVersion,
  });

  if (!result.callbackToken) {
    throw new Error('Backend did not return a callbackToken');
  }

  await smClient.send(new PutSecretValueCommand({
    SecretId: process.env.SECRET_ARN,
    SecretString: result.callbackToken,
  }));

  return {
    PhysicalResourceId: AgentId,
    Data: { AgentId },
  };
};

function callBackend(path, body) {
  const url = new URL(path, process.env.CALLBACK_BASE_URL);
  const data = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(responseBody));
        } else {
          reject(new Error(\`Registration failed: HTTP \${res.statusCode} — \${responseBody}\`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
`;
}
