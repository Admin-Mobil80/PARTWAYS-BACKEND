import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { PREFIX } from './account';

/**
 * The single PartWays table (PK=NS#<workspace>, SK=<type>#<id>) and the
 * provider keys. Both hold customer data or credentials, so both are retained
 * if the stack is ever deleted.
 */
export class DataStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly providerSecrets: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `${PREFIX}-core`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Sign-in codes expire through TTL.
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Provider keys as one JSON object, e.g. {"OPENAI_API_KEY":"sk-…","DEEPGRAM_API_KEY":"…",
    // "ELEVENLABS_API_KEY":"…","STRIPE_SECRET_KEY":"sk_test_…","STRIPE_WEBHOOK_SECRET":"whsec_…"}.
    // Created with only AUTH_SECRET; add the rest in the console or with
    // `aws secretsmanager put-secret-value`, keeping AUTH_SECRET.
    this.providerSecrets = new secretsmanager.Secret(this, 'ProviderSecrets', {
      secretName: `${PREFIX}/provider-keys`,
      description: 'PartWays provider API keys',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'AUTH_SECRET',
        passwordLength: 48,
        excludePunctuation: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'ProviderSecretsArn', {
      value: this.providerSecrets.secretArn,
      description: 'Put provider keys here as JSON, keeping AUTH_SECRET',
    });
  }
}
