/* eslint-disable no-console */
import { exec } from 'child_process';

/**
 * Command to execute when `co:login` is called.
 * This is a workaround for CodeBuild pipeline, as the login is executed in the `pre_build` phase.
 */
const command = process.env.CODEBUILD_BUILD_ID
  ? 'echo CodeArtifact login prevented.'
  : 'aws codeartifact login --tool npm --repository lonic-cdk-commons --domain lonic';

exec(command, (error, stdout, stderr) => {
  if (error) {
    console.error(`CodeArtifact login error: ${error}`);
  }
  console.log(stdout);
});
