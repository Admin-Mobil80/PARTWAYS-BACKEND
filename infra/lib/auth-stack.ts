import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  AUTH_MAILER_ROLE_NAME,
  MAIL_ACCOUNT,
  MAIL_REGION,
  MAIL_SENDER_ROLE_NAME,
  PREFIX,
  SES_FROM_ADDRESS,
} from './account';
import { backendFunction } from './functions';

/**
 * Sign-in for both apps: Cognito custom auth with a 6-digit code sent by SES.
 * The website (HR) and the BMS (PartWays team) have separate user pools, so an
 * account in one can never sign in to the other. Accounts are created by each
 * API, never by self sign-up.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly client: cognito.UserPoolClient;
  public readonly bmsUserPool: cognito.UserPool;
  public readonly bmsClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const trigger = (name: string, handler: string, role?: iam.IRole, environment?: Record<string, string>, id?: string) =>
      backendFunction(this, id ?? `${handler[0]!.toUpperCase()}${handler.slice(1)}Fn`, {
        name: `auth-${name}`,
        file: 'auth-triggers',
        handler,
        timeout: cdk.Duration.seconds(10),
        role,
        environment,
      });

    // The code email goes out through the m80 account's SES, by assuming its
    // send-only role. That role trusts this one by name, so the name is fixed.
    const senderRoleArn = `arn:aws:iam::${MAIL_ACCOUNT}:role/${MAIL_SENDER_ROLE_NAME}`;
    const mailerRole = new iam.Role(this, 'MailerRole', {
      roleName: AUTH_MAILER_ROLE_NAME,
      description: 'createAuthChallenge: sends sign-in codes through the m80 account SES',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    mailerRole.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [senderRoleArn] }));

    const mail = { SES_FROM_ADDRESS, SES_ROLE_ARN: senderRoleArn, SES_REGION: MAIL_REGION };
    // define and verify hold no settings, so both pools share them. Each pool
    // has its own create function, so the email names the right product.
    const define = trigger('define', 'defineAuthChallenge');
    const verify = trigger('verify', 'verifyAuthChallenge');

    const pool = (id: string, name: string, create: cognito.UserPoolTriggers['createAuthChallenge']) =>
      new cognito.UserPool(this, id, {
        userPoolName: `${PREFIX}-${name}`,
        selfSignUpEnabled: false,
        signInCaseSensitive: false,
        // Recovery is by an administrator only: there are no passwords to reset.
        accountRecovery: cognito.AccountRecovery.NONE,
        lambdaTriggers: { defineAuthChallenge: define, createAuthChallenge: create, verifyAuthChallengeResponse: verify },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    const client = (p: cognito.UserPool, name: string) =>
      p.addClient('Client', {
        userPoolClientName: `${PREFIX}-${name}`,
        generateSecret: false,
        authFlows: { custom: true },
        idTokenValidity: cdk.Duration.hours(8),
        preventUserExistenceErrors: true,
      });

    this.userPool = pool('UserPool', 'hr', trigger('create', 'createAuthChallenge', mailerRole, { ...mail, MAIL_PRODUCT: 'PartWays' }));
    this.client = client(this.userPool, 'hr');

    this.bmsUserPool = pool('BmsUserPool', 'bms',
      trigger('bms-create', 'createAuthChallenge', mailerRole, { ...mail, MAIL_PRODUCT: 'PartWays BMS' }, 'BmsCreateAuthChallengeFn'));
    this.bmsClient = client(this.bmsUserPool, 'bms');

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.client.userPoolClientId });
    new cdk.CfnOutput(this, 'BmsUserPoolId', { value: this.bmsUserPool.userPoolId });
    new cdk.CfnOutput(this, 'BmsUserPoolClientId', { value: this.bmsClient.userPoolClientId });
  }
}
