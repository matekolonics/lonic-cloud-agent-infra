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

const artifactBucket = requireContext(app, 'artifactBucket');
const agentVersion = requireContext(app, 'agentVersion');

new LonicCloudAgentStack(app, 'LonicCloudAgentStack', {
  backendRoleArn: requireContext(app, 'backendRoleArn'),
  artifactBucket,
  agentVersion,
  callbackBaseUrl: requireContext(app, 'callbackBaseUrl'),
  // Customers deploy this template with plain `aws cloudformation create-stack` —
  // no `cdk bootstrap` required. Redirect CDK file assets to the templates bucket
  // (which the pipeline populates) and suppress the bootstrap version check.
  synthesizer: new cdk.DefaultStackSynthesizer({
    generateBootstrapVersionRule: false,
    fileAssetsBucketName: artifactBucket,
    bucketPrefix: `agent/v${agentVersion}/assets/`,
    deployRoleArn: '',
    cloudFormationExecutionRole: '',
    fileAssetPublishingRoleArn: '',
    imageAssetPublishingRoleArn: '',
    lookupRoleArn: '',
  }),
});
