import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { PREFIX } from './account';

/** PARTWAYS-BACKEND root: the Lambda code, its package.json and lockfile. */
const BACKEND_ROOT = path.join(__dirname, '..', '..');

export interface BackendFunctionProps {
  /** Resource name after the prefix, e.g. `api` -> `partways-api`. */
  readonly name: string;
  /** Handler file under src/handlers, without extension. */
  readonly file: string;
  /** Exported handler name. */
  readonly handler: string;
  readonly timeout: cdk.Duration;
  readonly environment?: Record<string, string>;
}

/**
 * A function built from PARTWAYS-BACKEND/src. The code is ES modules, so it is
 * bundled as ESM with a `require` shim for the CommonJS dependencies.
 * pdfkit reads its font files from disk at runtime, so it is installed into
 * the bundle rather than inlined. The AWS SDK ships with the runtime.
 */
export function backendFunction(scope: Construct, id: string, props: BackendFunctionProps): NodejsFunction {
  return new NodejsFunction(scope, id, {
    functionName: `${PREFIX}-${props.name}`,
    entry: path.join(BACKEND_ROOT, 'src', 'handlers', `${props.file}.js`),
    handler: props.handler,
    projectRoot: BACKEND_ROOT,
    depsLockFilePath: path.join(BACKEND_ROOT, 'package-lock.json'),
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 1024,
    timeout: props.timeout,
    environment: props.environment,
    logGroup: new logs.LogGroup(scope, `${id}Logs`, {
      logGroupName: `/aws/lambda/${PREFIX}-${props.name}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    bundling: {
      format: OutputFormat.ESM,
      target: 'node22',
      mainFields: ['module', 'main'],
      banner: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
      externalModules: ['@aws-sdk/*'],
      nodeModules: ['pdfkit'],
    },
  });
}
