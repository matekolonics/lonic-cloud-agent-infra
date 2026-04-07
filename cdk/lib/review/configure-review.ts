import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface ConfigureReviewProps {
  readonly api: apigateway.RestApi;
  /** Secret containing the git provider access token (for creating webhooks on the provider). */
  readonly gitTokenSecret: secretsmanager.ISecret;
  /** Webhook API Gateway URL from the commons webhook infrastructure singleton. */
  readonly webhookApiUrl: string;
  /** Name of the commons webhook registrations DynamoDB table. */
  readonly webhookTableName: string;
  /** ARN of the commons webhook registrations DynamoDB table. */
  readonly webhookTableArn: string;
}

/**
 * Lambda-backed endpoint at `POST /commands/configure-review` that registers
 * or deregisters webhooks on git providers for AI code review.
 *
 * Creates webhook registrations in the commons webhook infrastructure's
 * DynamoDB table so the shared receiver Lambda can verify signatures and
 * emit EventBridge events.
 */
export class ConfigureReview extends Construct {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: ConfigureReviewProps) {
    super(scope, id);

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(configureReviewHandlerCode()),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      description: 'Registers/deregisters git provider webhooks for AI code review',
      environment: {
        GIT_TOKEN_SECRET_ARN: props.gitTokenSecret.secretArn,
        WEBHOOK_API_URL: props.webhookApiUrl,
        WEBHOOK_TABLE_NAME: props.webhookTableName,
      },
    });

    props.gitTokenSecret.grantRead(this.fn);

    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:PutItem',
        'dynamodb:GetItem',
        'dynamodb:DeleteItem',
      ],
      resources: [props.webhookTableArn],
    }));

    const commandsResource = props.api.root.getResource('commands') as apigateway.Resource
      ?? props.api.root.addResource('commands');

    commandsResource.addResource('configure-review').addMethod('POST',
      new apigateway.LambdaIntegration(this.fn),
      { authorizationType: apigateway.AuthorizationType.IAM },
    );
  }
}

function configureReviewHandlerCode(): string {
  return `
const crypto = require("crypto");
const https = require("https");
const { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const dynamo = new DynamoDBClient();
const sm = new SecretsManagerClient();

const GIT_TOKEN_SECRET_ARN = process.env.GIT_TOKEN_SECRET_ARN;
const WEBHOOK_API_URL = process.env.WEBHOOK_API_URL;
const TABLE_NAME = process.env.WEBHOOK_TABLE_NAME;

let gitTokenCache = null;

async function getGitToken() {
  if (!gitTokenCache) {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: GIT_TOKEN_SECRET_ARN }));
    gitTokenCache = res.SecretString;
  }
  return gitTokenCache;
}

// ── Provider webhook creation ──────────────────────────────────────────────

function httpsRequest(method, hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method, hostname, path: reqPath, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ statusCode: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function createProviderWebhook(provider, owner, repo, callbackUrl, webhookSecret, pat) {
  const p = provider.toLowerCase();

  if (p === "github") {
    const body = JSON.stringify({
      config: { url: callbackUrl, content_type: "json", secret: webhookSecret },
      events: ["pull_request"],
      active: true,
    });
    const { statusCode, body: res } = await httpsRequest("POST", "api.github.com",
      "/repos/" + owner + "/" + repo + "/hooks",
      { Authorization: "Bearer " + pat, "User-Agent": "lonic-webhook-manager", Accept: "application/vnd.github.v3+json", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      body);
    if (statusCode !== 201) throw new Error("GitHub webhook creation failed (" + statusCode + "): " + JSON.stringify(res));
    return String(res.id);
  }

  if (p === "gitlab") {
    const projectId = encodeURIComponent(owner + "/" + repo);
    const body = JSON.stringify({
      url: callbackUrl, token: webhookSecret,
      push_events: false, merge_requests_events: true, enable_ssl_verification: true,
    });
    const { statusCode, body: res } = await httpsRequest("POST", "gitlab.com",
      "/api/v4/projects/" + projectId + "/hooks",
      { Authorization: "Bearer " + pat, "User-Agent": "lonic-webhook-manager", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      body);
    if (statusCode !== 201) throw new Error("GitLab webhook creation failed (" + statusCode + "): " + JSON.stringify(res));
    return String(res.id);
  }

  if (p === "bitbucket") {
    const body = JSON.stringify({
      description: "lonic-ai-review",
      url: callbackUrl, secret: webhookSecret, active: true,
      events: ["pullrequest:created", "pullrequest:updated"],
    });
    const { statusCode, body: res } = await httpsRequest("POST", "api.bitbucket.org",
      "/2.0/repositories/" + owner + "/" + repo + "/hooks",
      { Authorization: "Bearer " + pat, "User-Agent": "lonic-webhook-manager", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      body);
    if (statusCode !== 201) throw new Error("Bitbucket webhook creation failed (" + statusCode + "): " + JSON.stringify(res));
    return String(res.uuid);
  }

  throw new Error("Unsupported provider: " + provider);
}

async function deleteProviderWebhook(provider, owner, repo, webhookId, pat) {
  const p = provider.toLowerCase();
  let hostname, reqPath;

  if (p === "github") {
    hostname = "api.github.com";
    reqPath = "/repos/" + owner + "/" + repo + "/hooks/" + webhookId;
  } else if (p === "gitlab") {
    hostname = "gitlab.com";
    reqPath = "/api/v4/projects/" + encodeURIComponent(owner + "/" + repo) + "/hooks/" + webhookId;
  } else if (p === "bitbucket") {
    hostname = "api.bitbucket.org";
    reqPath = "/2.0/repositories/" + owner + "/" + repo + "/hooks/" + webhookId;
  } else {
    console.warn("Unsupported provider for deletion:", provider);
    return;
  }

  const { statusCode } = await httpsRequest("DELETE", hostname, reqPath, {
    Authorization: "Bearer " + pat, "User-Agent": "lonic-webhook-manager",
    Accept: p === "github" ? "application/vnd.github.v3+json" : undefined,
  });

  if (statusCode !== 204 && statusCode !== 404) {
    throw new Error("Webhook deletion failed (" + statusCode + ") for " + provider + " " + owner + "/" + repo);
  }
}

// ── Handler ────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const body = typeof event.body === "string" ? JSON.parse(event.body) : event;
  const payload = body.payload || body;
  const { enabled, provider, repositories, registrationIds } = payload;

  const pat = await getGitToken();

  // ── Disable: delete existing registrations ──
  if (enabled === false) {
    const ids = registrationIds || [];
    for (const registrationId of ids) {
      const { Item } = await dynamo.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { registrationId: { S: registrationId } },
      }));

      if (Item) {
        const [owner, repo] = Item.fullRepositoryId.S.split("/");
        await deleteProviderWebhook(Item.provider.S, owner, repo, Item.providerWebhookId.S, pat);
        await dynamo.send(new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: { registrationId: { S: registrationId } },
        }));
      }
    }

    console.log("Deleted review webhooks", { count: ids.length });
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "disabled", deleted: ids.length }),
    };
  }

  // ── Enable: create webhooks for repositories ──
  if (!provider || !repositories || repositories.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "provider and repositories are required when enabling" }),
    };
  }

  // Normalize provider name to match commons convention
  const providerNormalized =
    provider === "github" ? "GitHub" :
    provider === "gitlab" ? "GitLab" :
    provider === "bitbucket" ? "Bitbucket" : provider;

  const registrations = [];

  for (const fullRepo of repositories) {
    const [owner, repo] = fullRepo.split("/");
    const registrationId = crypto.randomUUID();
    const webhookSecret = crypto.randomBytes(32).toString("hex");
    const callbackUrl = WEBHOOK_API_URL + "/" + registrationId;

    const providerWebhookId = await createProviderWebhook(
      provider, owner, repo, callbackUrl, webhookSecret, pat,
    );

    await dynamo.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        registrationId:    { S: registrationId },
        webhookSecret:     { S: webhookSecret },
        provider:          { S: providerNormalized },
        providerWebhookId: { S: providerWebhookId },
        fullRepositoryId:  { S: fullRepo },
      },
    }));

    registrations.push({
      repository: fullRepo,
      registrationId,
      webhookUrl: callbackUrl,
    });

    console.log("Created review webhook", { repo: fullRepo, registrationId });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "enabled",
      webhookApiUrl: WEBHOOK_API_URL,
      registrations,
    }),
  };
};
`;
}
