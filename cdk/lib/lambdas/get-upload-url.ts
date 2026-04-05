import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface GetUploadUrlProps {
  readonly api: apigateway.RestApi;
  /** S3 bucket where uploads will be stored. */
  readonly uploadBucket: s3.IBucket;
  /**
   * Key prefix for uploaded source archives.
   * @default 'uploads'
   */
  readonly uploadKeyPrefix?: string;
  /**
   * Presigned URL expiration time.
   * @default Duration.minutes(15)
   */
  readonly urlExpiration?: cdk.Duration;
}

/**
 * Lambda-backed API route that generates a presigned S3 PUT URL,
 * allowing the lonic backend to upload a CDK source archive directly
 * to the agent's artifacts bucket without cross-account IAM credentials.
 *
 * Exposed at `POST /commands/get-upload-url` with IAM auth.
 *
 * Input:
 * ```json
 * {
 *   "filename": "source.zip"
 * }
 * ```
 *
 * Output:
 * ```json
 * {
 *   "uploadUrl": "https://s3.amazonaws.com/bucket/uploads/<uuid>/source.zip?...",
 *   "sourceUri": "s3://bucket/uploads/<uuid>/source.zip"
 * }
 * ```
 */
export class GetUploadUrl extends Construct {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: GetUploadUrlProps) {
    super(scope, id);

    const keyPrefix = props.uploadKeyPrefix ?? 'uploads';
    const urlExpirationSeconds = (props.urlExpiration ?? cdk.Duration.minutes(15)).toSeconds();

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const crypto = require("crypto");

const s3 = new S3Client();
const BUCKET = process.env.UPLOAD_BUCKET;
const KEY_PREFIX = process.env.UPLOAD_KEY_PREFIX;
const URL_EXPIRATION = parseInt(process.env.URL_EXPIRATION_SECONDS, 10);

exports.handler = async (event) => {
  const body = typeof event.body === "string" ? JSON.parse(event.body) : event;
  const filename = body.filename || "source.zip";
  const uploadId = crypto.randomUUID();
  const key = KEY_PREFIX + "/" + uploadId + "/" + filename;

  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: URL_EXPIRATION });

  return {
    statusCode: 200,
    body: JSON.stringify({
      uploadUrl,
      sourceUri: "s3://" + BUCKET + "/" + key,
      expiresInSeconds: URL_EXPIRATION,
    }),
  };
};
`),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      description: 'Generates presigned S3 PUT URLs for CDK source archive uploads',
      environment: {
        UPLOAD_BUCKET: props.uploadBucket.bucketName,
        UPLOAD_KEY_PREFIX: keyPrefix,
        URL_EXPIRATION_SECONDS: String(urlExpirationSeconds),
      },
    });

    props.uploadBucket.grantPut(this.fn, `${keyPrefix}/*`);

    const commandsResource = props.api.root.getResource('commands') as apigateway.Resource
      ?? props.api.root.addResource('commands');

    commandsResource.addResource('get-upload-url').addMethod('POST',
      new apigateway.LambdaIntegration(this.fn),
      { authorizationType: apigateway.AuthorizationType.IAM },
    );
  }
}
