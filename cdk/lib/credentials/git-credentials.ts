import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface GitCredentialsProps {
  readonly api: apigateway.RestApi;
}

/**
 * End-to-end encrypted git-credential storage in the customer's AWS account.
 *
 * Resources created:
 * - **KMS asymmetric key** (`RSA_2048`, `ENCRYPT_DECRYPT`) — public key emitted
 *   so the lonic dashboard can encrypt PATs client-side. Private key never
 *   leaves KMS.
 * - **Secrets Manager secret** `lonic/git-credentials` — single secret that
 *   holds all credentials as a JSON object (`{ "<key>": "<plaintext-pat>" }`).
 *   One secret per agent at $0.40/month, regardless of how many credentials
 *   the customer has.
 * - **Three API routes** under `/v1/commands/git-credentials/`:
 *   - `POST save` — accepts `{ key, ciphertext }` (base64-encoded RSA-OAEP-SHA256
 *     ciphertext), KMS-decrypts to recover the plaintext, merges into the
 *     secret JSON, returns `{ secretArn, fieldName }`.
 *   - `GET list` — returns `{ keys: [...] }` (key names only, never values).
 *   - `POST delete` — accepts `{ key }`, removes that JSON field.
 *
 * The agent code never has a plaintext-credential-accepting endpoint —
 * `save` only ever takes ciphertext. Auditors verifying the "credentials
 * never leave the customer account in plaintext" claim can read the agent
 * source and confirm.
 */
export class GitCredentials extends Construct {
  /** KMS asymmetric key used to decrypt credential ciphertexts. */
  public readonly key: kms.Key;

  /** Secrets Manager secret holding all credentials as a JSON object. */
  public readonly secret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: GitCredentialsProps) {
    super(scope, id);

    this.key = new kms.Key(this, 'Key', {
      description: 'Decrypts git credentials posted to /commands/git-credentials/save. Private key never leaves KMS.',
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
      enableKeyRotation: false, // KMS asymmetric keys cannot be rotated automatically; customer can rotate by replacing the construct.
    });

    this.secret = new secretsmanager.Secret(this, 'Secret', {
      secretName: 'lonic/git-credentials',
      description: 'Customer git credentials (PATs, deploy keys) keyed by GitConnection id. JSON-shaped, accessed by per-field via CodeBuild SECRETS_MANAGER syntax or AWS CLI.',
      secretStringValue: cdk.SecretValue.unsafePlainText('{}'),
    });

    const sharedHandlerPrefix = `
const { KMSClient, DecryptCommand } = require("@aws-sdk/client-kms");
const { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const kms = new KMSClient();
const sm = new SecretsManagerClient();
const KEY_ID = process.env.KMS_KEY_ID;
const SECRET_ID = process.env.SECRET_ID;

function ok(body) { return { statusCode: 200, body: JSON.stringify(body) }; }
function err(code, msg) { return { statusCode: code, body: JSON.stringify({ error: msg }) }; }

async function readSecretJson() {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  return JSON.parse(res.SecretString || "{}");
}

async function writeSecretJson(obj) {
  await sm.send(new PutSecretValueCommand({
    SecretId: SECRET_ID,
    SecretString: JSON.stringify(obj),
  }));
}
`;

    const saveFn = new lambda.Function(this, 'SaveFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      description: 'Decrypts a posted credential ciphertext via KMS and merges it into the lonic/git-credentials secret.',
      environment: {
        KMS_KEY_ID: this.key.keyId,
        SECRET_ID: this.secret.secretArn,
      },
      code: lambda.Code.fromInline(`${sharedHandlerPrefix}
exports.handler = async (event) => {
  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body || {});
  } catch (e) {
    return err(400, "invalid JSON body");
  }
  const { key, ciphertext } = body;
  if (!key || !ciphertext) return err(400, "key and ciphertext are required");

  // Decrypt — RSA-OAEP-SHA256 matches Web Crypto's import + encrypt on the dashboard side.
  let plaintext;
  try {
    const result = await kms.send(new DecryptCommand({
      KeyId: KEY_ID,
      CiphertextBlob: Buffer.from(ciphertext, "base64"),
      EncryptionAlgorithm: "RSAES_OAEP_SHA_256",
    }));
    plaintext = Buffer.from(result.Plaintext).toString("utf-8");
  } catch (e) {
    console.error("KMS Decrypt failed:", e.message);
    return err(400, "ciphertext could not be decrypted with the agent key");
  }

  const current = await readSecretJson();
  current[key] = plaintext;
  await writeSecretJson(current);

  return ok({ secretArn: SECRET_ID, fieldName: key });
};
`),
    });

    this.key.grantDecrypt(saveFn);
    this.secret.grantRead(saveFn);
    this.secret.grantWrite(saveFn);

    const listFn = new lambda.Function(this, 'ListFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      description: 'Returns the names of the git credentials currently stored in lonic/git-credentials. Never returns values.',
      environment: {
        SECRET_ID: this.secret.secretArn,
      },
      code: lambda.Code.fromInline(`${sharedHandlerPrefix}
exports.handler = async () => {
  const current = await readSecretJson();
  return ok({ keys: Object.keys(current) });
};
`),
    });

    this.secret.grantRead(listFn);

    const deleteFn = new lambda.Function(this, 'DeleteFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      description: 'Removes a single key from the lonic/git-credentials secret JSON.',
      environment: {
        SECRET_ID: this.secret.secretArn,
      },
      code: lambda.Code.fromInline(`${sharedHandlerPrefix}
exports.handler = async (event) => {
  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body || {});
  } catch (e) {
    return err(400, "invalid JSON body");
  }
  const { key } = body;
  if (!key) return err(400, "key is required");

  const current = await readSecretJson();
  delete current[key];
  await writeSecretJson(current);

  return ok({ deleted: key });
};
`),
    });

    this.secret.grantRead(deleteFn);
    this.secret.grantWrite(deleteFn);

    const commandsResource = props.api.root.getResource('commands') as apigateway.Resource
      ?? props.api.root.addResource('commands');
    const credsResource = commandsResource.addResource('git-credentials');

    credsResource.addResource('save').addMethod('POST',
      new apigateway.LambdaIntegration(saveFn),
      { authorizationType: apigateway.AuthorizationType.IAM },
    );
    credsResource.addResource('list').addMethod('GET',
      new apigateway.LambdaIntegration(listFn),
      { authorizationType: apigateway.AuthorizationType.IAM },
    );
    credsResource.addResource('delete').addMethod('POST',
      new apigateway.LambdaIntegration(deleteFn),
      { authorizationType: apigateway.AuthorizationType.IAM },
    );
  }

  /**
   * IAM resource pattern that consumers (e.g. CodeBuild projects that need to
   * read git tokens at clone time) should use when granting
   * `secretsmanager:GetSecretValue`.
   */
  public readSecretArnPattern(): string {
    return cdk.Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: 'lonic/*',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
  }
}
