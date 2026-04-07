import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface ReviewResultHandlerProps {
  readonly api: apigateway.RestApi;
  /** Secret containing the git provider access token for posting review comments. */
  readonly gitTokenSecret: secretsmanager.ISecret;
}

/**
 * Lambda-backed endpoint at `POST /commands/review-result` that receives
 * review results from the backend (managed mode callback) and posts
 * comments to the git provider.
 *
 * Uses IAM auth on the main agent API — the backend sends the callback
 * using its IAM role, same as all other agent commands.
 *
 * The provider is determined from the `metadata.provider` field in the
 * callback payload (set by the review packager when submitting the review).
 */
export class ReviewResultHandler extends Construct {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: ReviewResultHandlerProps) {
    super(scope, id);

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(resultHandlerCode()),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'Receives review results from backend and posts comments to git provider',
      environment: {
        GIT_TOKEN_SECRET_ARN: props.gitTokenSecret.secretArn,
      },
    });

    props.gitTokenSecret.grantRead(this.fn);

    const commandsResource = props.api.root.getResource('commands') as apigateway.Resource
      ?? props.api.root.addResource('commands');

    commandsResource.addResource('review-result').addMethod('POST',
      new apigateway.LambdaIntegration(this.fn),
      { authorizationType: apigateway.AuthorizationType.IAM },
    );
  }
}

function resultHandlerCode(): string {
  return `
const https = require("https");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const sm = new SecretsManagerClient();
const GIT_TOKEN_SECRET_ARN = process.env.GIT_TOKEN_SECRET_ARN;

let gitTokenCache = null;

async function getGitToken() {
  if (!gitTokenCache) {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: GIT_TOKEN_SECRET_ARN }));
    gitTokenCache = res.SecretString;
  }
  return gitTokenCache;
}

function formatComment(comment) {
  let body = "**AI Review** — " + comment.severity + "\\n\\n" + comment.body;
  if (comment.suggestion) {
    body += "\\n\\n\\\`\\\`\\\`suggestion\\n" + comment.suggestion + "\\n\\\`\\\`\\\`";
  }
  return body;
}

function mapApprovalToEvent(approval) {
  if (approval === "approve") return "APPROVE";
  if (approval === "request_changes") return "REQUEST_CHANGES";
  return "COMMENT";
}

async function postToGitHub(token, repoFullName, prId, result) {
  const [owner, repo] = repoFullName.split("/");

  const reviewBody = {
    body: result.summary,
    event: mapApprovalToEvent(result.approval),
    comments: (result.comments || []).map((c) => {
      const comment = {
        path: c.file,
        line: c.line,
        body: formatComment(c),
      };
      if (c.endLine && c.endLine !== c.line) {
        comment.start_line = c.line;
        comment.line = c.endLine;
      }
      return comment;
    }),
  };

  await githubApi("POST", "/repos/" + owner + "/" + repo + "/pulls/" + prId + "/reviews", reviewBody, token);
  console.log("Posted review to GitHub", { owner, repo, prId, comments: reviewBody.comments.length });
}

async function postToGitLab(token, repoFullName, mrId, result) {
  const projectId = encodeURIComponent(repoFullName);

  await gitlabApi("POST", "/projects/" + projectId + "/merge_requests/" + mrId + "/notes", {
    body: "**AI Review Summary**\\n\\n" + result.summary,
  }, token);

  for (const c of (result.comments || [])) {
    await gitlabApi("POST", "/projects/" + projectId + "/merge_requests/" + mrId + "/discussions", {
      body: formatComment(c),
      position: {
        position_type: "text",
        new_path: c.file,
        new_line: c.line,
      },
    }, token);
  }

  console.log("Posted review to GitLab", { projectId, mrId, comments: (result.comments || []).length });
}

async function postToBitbucket(token, repoFullName, prId, result) {
  const [workspace, repo] = repoFullName.split("/");

  await bitbucketApi("POST", "/repositories/" + workspace + "/" + repo + "/pullrequests/" + prId + "/comments", {
    content: { raw: "**AI Review Summary**\\n\\n" + result.summary },
  }, token);

  for (const c of (result.comments || [])) {
    let body = "**AI Review** — " + c.severity + "\\n\\n" + c.body;
    if (c.suggestion) {
      body += "\\n\\n\\\`\\\`\\\`\\n" + c.suggestion + "\\n\\\`\\\`\\\`";
    }
    await bitbucketApi("POST", "/repositories/" + workspace + "/" + repo + "/pullrequests/" + prId + "/comments", {
      content: { raw: body },
      inline: { path: c.file, to: c.line },
    }, token);
  }

  console.log("Posted review to Bitbucket", { workspace, repo, prId, comments: (result.comments || []).length });
}

function githubApi(method, apiPath, body, token) {
  return apiRequest("api.github.com", method, apiPath, body, {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "lonic-cloud-agent",
  });
}

function gitlabApi(method, apiPath, body, token) {
  return apiRequest("gitlab.com", method, "/api/v4" + apiPath, body, {
    "PRIVATE-TOKEN": token,
  });
}

function bitbucketApi(method, apiPath, body, token) {
  return apiRequest("api.bitbucket.org", method, "/2.0" + apiPath, body, {
    Authorization: "Bearer " + token,
  });
}

function apiRequest(host, method, reqPath, body, headers) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      method,
      path: reqPath,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => responseBody += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseBody ? JSON.parse(responseBody) : {});
        } else {
          console.error("API error:", res.statusCode, responseBody);
          reject(new Error("API request failed: " + res.statusCode + " " + responseBody));
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  const body = typeof event.body === "string" ? JSON.parse(event.body) : event;
  const { reviewId, result, metadata } = body;

  if (!result) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing result" }) };
  }

  console.log("Received review result", { reviewId, approval: result.approval, comments: (result.comments || []).length });

  const provider = (metadata?.provider || "").toLowerCase();
  const repoFullName = metadata?.repository;
  const prId = metadata?.pullRequest?.id;

  if (!repoFullName || !prId || !provider) {
    console.warn("Missing repository/PR/provider metadata in callback, cannot post comments");
    return { statusCode: 200, body: JSON.stringify({ status: "received", posted: false, reason: "missing metadata" }) };
  }

  const token = await getGitToken();

  if (provider === "github") {
    await postToGitHub(token, repoFullName, prId, result);
  } else if (provider === "gitlab") {
    await postToGitLab(token, repoFullName, prId, result);
  } else if (provider === "bitbucket") {
    await postToBitbucket(token, repoFullName, prId, result);
  }

  return { statusCode: 200, body: JSON.stringify({ status: "received" }) };
};
`;
}
