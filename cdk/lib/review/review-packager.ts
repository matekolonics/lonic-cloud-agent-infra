import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface ReviewPackagerProps {
  /** S3 bucket for uploading review packages. */
  readonly uploadBucket: s3.IBucket;
  /** Secret containing the git provider access token for cloning private repos. */
  readonly gitTokenSecret: secretsmanager.ISecret;
  /** Secret containing the callback bearer token for the backend API. */
  readonly callbackTokenSecret: secretsmanager.ISecret;
  /** Base URL of the lonic hosted backend. */
  readonly callbackBaseUrl: string;
  /** Agent ID parameter. */
  readonly agentIdParam: cdk.CfnParameter;
}

/**
 * Lambda that receives Pull Request events from EventBridge (emitted by the
 * lonic-cdk-commons webhook infrastructure), clones the repository, creates
 * a review package (repo archive + diff + metadata), uploads it to S3, and
 * submits a review request to the lonic backend.
 *
 * Triggered by EventBridge rule matching:
 *   source: "lonic.webhook", detailType: "Pull Request"
 */
export class ReviewPackager extends Construct {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: ReviewPackagerProps) {
    super(scope, id);

    const keyPrefix = 'review-packages';

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(packagerHandlerCode()),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      ephemeralStorageSize: cdk.Size.gibibytes(2),
      description: 'Packages repo for AI review and submits to backend (triggered by PR EventBridge events)',
      environment: {
        UPLOAD_BUCKET: props.uploadBucket.bucketName,
        UPLOAD_KEY_PREFIX: keyPrefix,
        GIT_TOKEN_SECRET_ARN: props.gitTokenSecret.secretArn,
        CALLBACK_TOKEN_SECRET_ARN: props.callbackTokenSecret.secretArn,
        CALLBACK_BASE_URL: props.callbackBaseUrl,
        AGENT_ID: props.agentIdParam.valueAsString,
      },
    });

    props.uploadBucket.grantPut(this.fn, `${keyPrefix}/*`);
    props.gitTokenSecret.grantRead(this.fn);
    props.callbackTokenSecret.grantRead(this.fn);
  }
}

function packagerHandlerCode(): string {
  return `
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const https = require("https");

const s3 = new S3Client();
const sm = new SecretsManagerClient();

const BUCKET = process.env.UPLOAD_BUCKET;
const KEY_PREFIX = process.env.UPLOAD_KEY_PREFIX;
const GIT_TOKEN_SECRET_ARN = process.env.GIT_TOKEN_SECRET_ARN;
const CALLBACK_TOKEN_SECRET_ARN = process.env.CALLBACK_TOKEN_SECRET_ARN;
const CALLBACK_BASE_URL = process.env.CALLBACK_BASE_URL;
const AGENT_ID = process.env.AGENT_ID;

let gitTokenCache = null;
let callbackTokenCache = null;

async function getSecret(arn) {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  return res.SecretString;
}

async function getGitToken() {
  if (!gitTokenCache) gitTokenCache = await getSecret(GIT_TOKEN_SECRET_ARN);
  return gitTokenCache;
}

async function getCallbackToken() {
  if (!callbackTokenCache) callbackTokenCache = await getSecret(CALLBACK_TOKEN_SECRET_ARN);
  return callbackTokenCache;
}

function buildCloneUrl(provider, fullRepositoryId, token) {
  // The EventBridge event from commons uses provider names like "GitHub", "GitLab", "Bitbucket"
  const p = provider.toLowerCase();
  if (p === "github") return "https://x-access-token:" + token + "@github.com/" + fullRepositoryId + ".git";
  if (p === "gitlab") return "https://oauth2:" + token + "@gitlab.com/" + fullRepositoryId + ".git";
  if (p === "bitbucket") return "https://x-token-auth:" + token + "@bitbucket.org/" + fullRepositoryId + ".git";
  throw new Error("Unsupported provider: " + provider);
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts });
}

exports.handler = async (event) => {
  // EventBridge event from lonic-cdk-commons webhook infrastructure
  const detail = event.detail;
  const provider = detail.provider;
  const fullRepositoryId = detail.fullRepositoryId;
  const prNumber = String(detail.prNumber);
  const sourceBranch = detail.sourceBranch;
  const targetBranch = detail.targetBranch;
  const commitId = detail.commitId;
  const title = detail.title || "";
  const authorLogin = detail.authorLogin || "";

  const reviewId = "rev_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const workDir = "/tmp/" + reviewId;

  console.log("Starting review packaging", { reviewId, repo: fullRepositoryId, pr: prNumber, action: detail.action });

  try {
    fs.mkdirSync(workDir, { recursive: true });

    const gitToken = await getGitToken();
    const cloneUrl = buildCloneUrl(provider, fullRepositoryId, gitToken);

    // Clone the repo with enough depth to have both branches
    exec("git clone --depth 100 " + JSON.stringify(cloneUrl) + " repo", { cwd: workDir });
    const repoDir = path.join(workDir, "repo");

    // Fetch both branches
    exec("git fetch origin " + JSON.stringify(targetBranch) + " " + JSON.stringify(sourceBranch), { cwd: repoDir });

    // Create repo archive at target branch
    exec("git checkout " + JSON.stringify(targetBranch), { cwd: repoDir });
    const targetSha = exec("git rev-parse HEAD", { cwd: repoDir }).trim();
    exec("git archive --format=tar.gz HEAD > ../repo.tar.gz", { cwd: repoDir, shell: "/bin/sh" });

    // Create diff between target and source
    const sourceSha = exec("git rev-parse origin/" + sourceBranch, { cwd: repoDir }).trim();
    const diffCmd = "git diff " + JSON.stringify(targetBranch) + "..origin/" + JSON.stringify(sourceBranch);
    try {
      const diff = exec(diffCmd, { cwd: repoDir, maxBuffer: 50 * 1024 * 1024 });
      fs.writeFileSync(path.join(workDir, "changes.patch"), diff);
    } catch (e) {
      if (e.stdout) {
        fs.writeFileSync(path.join(workDir, "changes.patch"), e.stdout);
      } else {
        throw e;
      }
    }

    // Create metadata.json
    const metadata = {
      provider: provider.toLowerCase(),
      repository: fullRepositoryId,
      pullRequest: {
        id: prNumber,
        title,
        sourceBranch,
        targetBranch,
        sourceSha,
        targetSha,
      },
      packaging: {
        format: "archive+patch",
        archiveRef: targetSha,
        patchRange: targetSha + ".." + sourceSha,
      },
    };
    fs.writeFileSync(path.join(workDir, "metadata.json"), JSON.stringify(metadata, null, 2));

    // Bundle into review-package.tar.gz
    exec("tar -czf review-package.tar.gz repo.tar.gz changes.patch metadata.json", { cwd: workDir, shell: "/bin/sh" });

    // Upload to S3
    const uploadKey = KEY_PREFIX + "/" + reviewId + "/review-package.tar.gz";
    const packageData = fs.readFileSync(path.join(workDir, "review-package.tar.gz"));

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: uploadKey,
      Body: packageData,
      ContentType: "application/gzip",
    }));

    const sourceUri = "s3://" + BUCKET + "/" + uploadKey;
    console.log("Uploaded review package", { sourceUri, size: packageData.length });

    // Submit review to backend
    const callbackToken = await getCallbackToken();
    const reviewRequest = {
      agentId: AGENT_ID,
      reviewId,
      sourceUri,
      metadata: {
        provider: provider.toLowerCase(),
        repository: fullRepositoryId,
        pullRequest: {
          id: prNumber,
          title,
          sourceBranch,
          targetBranch,
        },
      },
    };

    const result = await postToBackend("/agent/review", reviewRequest, callbackToken);
    console.log("Review submitted", { reviewId, status: result.data?.status });

    return { reviewId, status: "submitted" };
  } finally {
    try { exec("rm -rf " + JSON.stringify(workDir), { shell: "/bin/sh" }); } catch (_) {}
  }
};

function postToBackend(urlPath, body, token) {
  const url = new URL(urlPath, CALLBACK_BASE_URL);
  const data = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "Authorization": "Bearer " + token,
      },
    }, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => responseBody += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(responseBody));
        } else {
          const err = new Error("Backend request failed: HTTP " + res.statusCode + " — " + responseBody);
          console.error(err.message);
          if ([400, 403, 409].includes(res.statusCode)) {
            console.warn("Non-retryable error, skipping review:", responseBody);
            resolve({ data: { status: "skipped", reason: responseBody } });
          } else {
            reject(err);
          }
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
`;
}
