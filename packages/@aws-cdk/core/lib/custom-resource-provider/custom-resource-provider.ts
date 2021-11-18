import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import { AssetStaging } from '../asset-staging';
import { FileAssetPackaging } from '../assets';
import { CfnResource } from '../cfn-resource';
import { Duration } from '../duration';
import { Size } from '../size';
import { Stack } from '../stack';
import { Token } from '../token';

const ENTRYPOINT_FILENAME = '__entrypoint__';
const ENTRYPOINT_NODEJS_SOURCE = path.join(__dirname, 'nodejs-entrypoint.js');

/**
 * Initialization properties for `CustomResourceProvider`.
 *
 */
export interface CustomResourceProviderProps {
  /**
   * A local file system directory with the provider's code. The code will be
   * bundled into a zip asset and wired to the provider's AWS Lambda function.
   */
  readonly codeDirectory: string;

  /**
   * The AWS Lambda runtime and version to use for the provider.
   */
  readonly runtime: CustomResourceProviderRuntime;

  /**
   * A set of IAM policy statements to include in the inline policy of the
   * provider's lambda function.
   *
   * **Please note**: these are direct IAM JSON policy blobs, *not* `iam.PolicyStatement`
   * objects like you will see in the rest of the CDK.
   *
   * @default - no additional inline policy
   *
   * @example
   * const provider = CustomResourceProvider.getOrCreateProvider(this, 'Custom::MyCustomResourceType', {
   *   codeDirectory: `${__dirname}/my-handler`,
   *   runtime: CustomResourceProviderRuntime.NODEJS_12_X,
   *   policyStatements: [
   *     {
   *       Effect: 'Allow',
   *       Action: 's3:PutObject*',
   *       Resource: '*',
   *     }
   *   ],
   * });
   */
  readonly policyStatements?: any[];

  /**
   * AWS Lambda timeout for the provider.
   *
   * @default Duration.minutes(15)
   */
  readonly timeout?: Duration;

  /**
   * The amount of memory that your function has access to. Increasing the
   * function's memory also increases its CPU allocation.
   *
   * @default Size.mebibytes(128)
   */
  readonly memorySize?: Size;

  /**
   * Key-value pairs that are passed to Lambda as Environment
   *
   * @default - No environment variables.
   */
  readonly environment?: { [key: string]: string };

  /**
   * A description of the function.
   *
   * @default - No description.
   */
  readonly description?: string;
}

/**
 * The lambda runtime to use for the resource provider. This also indicates
 * which language is used for the handler.
 */
export enum CustomResourceProviderRuntime {
  /**
   * Node.js 12.x
   *
   * @deprecated Use {@link NODEJS_12_X}
   */
  NODEJS_12 = 'nodejs12.x',

  /**
   * Node.js 12.x
   */
  NODEJS_12_X = 'nodejs12.x',

  /**
   * Node.js 14.x
   */
  NODEJS_14_X = 'nodejs14.x',
}

/**
 * An AWS-Lambda backed custom resource provider.
 *
 */
export class CustomResourceProvider extends Construct {
  /**
   * Returns a stack-level singleton ARN (service token) for the custom resource
   * provider.
   *
   * @param scope Construct scope
   * @param uniqueid A globally unique id that will be used for the stack-level
   * construct.
   * @param props Provider properties which will only be applied when the
   * provider is first created.
   * @returns the service token of the custom resource provider, which should be
   * used when defining a `CustomResource`.
   */
  public static getOrCreate(scope: Construct, uniqueid: string, props: CustomResourceProviderProps) {
    return this.getOrCreateProvider(scope, uniqueid, props).serviceToken;
  }

  /**
   * Returns a stack-level singleton for the custom resource provider.
   *
   * @param scope Construct scope
   * @param uniqueid A globally unique id that will be used for the stack-level
   * construct.
   * @param props Provider properties which will only be applied when the
   * provider is first created.
   * @returns the service token of the custom resource provider, which should be
   * used when defining a `CustomResource`.
   */
  public static getOrCreateProvider(scope: Construct, uniqueid: string, props: CustomResourceProviderProps) {
    const id = `${uniqueid}CustomResourceProvider`;
    const stack = Stack.of(scope);
    const provider = stack.node.tryFindChild(id) as CustomResourceProvider
      ?? new CustomResourceProvider(stack, id, props);

    return provider;
  }

  /**
   * The ARN of the provider's AWS Lambda function which should be used as the
   * `serviceToken` when defining a custom resource.
   *
   * @example
   * declare const myProvider: CustomResourceProvider;
   *
   * new CustomResource(this, 'MyCustomResource', {
   *   serviceToken: myProvider.serviceToken,
   *   properties: {
   *     myPropertyOne: 'one',
   *     myPropertyTwo: 'two',
   *   },
   * });
   */
  public readonly serviceToken: string;

  /**
   * The ARN of the provider's AWS Lambda function role.
   */
  public readonly roleArn: string;

  protected constructor(scope: Construct, id: string, props: CustomResourceProviderProps) {
    super(scope, id);

    const stack = Stack.of(scope);

    // copy the entry point to the code directory
    fs.copyFileSync(ENTRYPOINT_NODEJS_SOURCE, path.join(props.codeDirectory, `${ENTRYPOINT_FILENAME}.js`));

    // verify we have an index file there
    if (!fs.existsSync(path.join(props.codeDirectory, 'index.js'))) {
      throw new Error(`cannot find ${props.codeDirectory}/index.js`);
    }

    const staging = new AssetStaging(this, 'Staging', {
      sourcePath: props.codeDirectory,
    });

    const asset = stack.synthesizer.addFileAsset({
      fileName: staging.relativeStagedPath(stack),
      sourceHash: staging.assetHash,
      packaging: FileAssetPackaging.ZIP_DIRECTORY,
    });

    const policies = !props.policyStatements ? undefined : [
      {
        PolicyName: 'Inline',
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: props.policyStatements,
        },
      },
    ];

    const role = new CfnResource(this, 'Role', {
      type: 'AWS::IAM::Role',
      properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
        },
        ManagedPolicyArns: [
          { 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' },
        ],
        Policies: policies,
      },
    });
    this.roleArn = Token.asString(role.getAtt('Arn'));

    const timeout = props.timeout ?? Duration.minutes(15);
    const memory = props.memorySize ?? Size.mebibytes(128);

    const handler = new CfnResource(this, 'Handler', {
      type: 'AWS::Lambda::Function',
      properties: {
        Code: {
          S3Bucket: asset.bucketName,
          S3Key: asset.objectKey,
        },
        Timeout: timeout.toSeconds(),
        MemorySize: memory.toMebibytes(),
        Handler: `${ENTRYPOINT_FILENAME}.handler`,
        Role: role.getAtt('Arn'),
        Runtime: props.runtime,
        Environment: this.renderEnvironmentVariables(props.environment),
        Description: props.description ?? undefined,
      },
    });

    handler.addDependsOn(role);

    this.serviceToken = Token.asString(handler.getAtt('Arn'));
  }

  private renderEnvironmentVariables(env?: { [key: string]: string }) {
    if (!env || Object.keys(env).length === 0) {
      return undefined;
    }

    // Sort environment so the hash of the function used to create
    // `currentVersion` is not affected by key order (this is how lambda does
    // it)
    const variables: { [key: string]: string } = {};
    const keys = Object.keys(env).sort();

    for (const key of keys) {
      variables[key] = env[key];
    }

    return { Variables: variables };
  }
}
