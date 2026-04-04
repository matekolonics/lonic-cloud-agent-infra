#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { LonicCloudAgentStack } from '../lib/LonicCloudAgentStack';

const app = new cdk.App();

function requireContext(app: cdk.App, key: string): string {
  const value = app.node.tryGetContext(key);
  if (!value) {
    throw new Error(`Context variable "${key}" is required. Pass it with -c ${key}=VALUE`);
  }
  return value;
}

new LonicCloudAgentStack(app, 'LonicCloudAgentStack', {
  backendRoleArn: requireContext(app, 'backendRoleArn'),
  artifactBucket: requireContext(app, 'artifactBucket'),
  agentVersion: requireContext(app, 'agentVersion'),
  callbackBaseUrl: requireContext(app, 'callbackBaseUrl'),
});
