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
 * HR sign-in: Cognito custom auth with a 6-digit code sent by SES. Accounts
 * are created by the API (sign-up on the home page), never by self sign-up.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly client: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const trigger = (name: string, handler: string, role?: iam.IRole, environment?: Record<string, string>) =>
      backendFunction(this, `${handler[0]!.toUpperCase()}${handler.slice(1)}Fn`, {
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

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${PREFIX}-hr`,
      selfSignUpEnabled: false,
      signInCaseSensitive: false,
      // Recovery is by an administrator only: there are no passwords to reset.
      accountRecovery: cognito.AccountRecovery.NONE,
      lambdaTriggers: {
        defineAuthChallenge: trigger('define', 'defineAuthChallenge'),
        createAuthChallenge: trigger('create', 'createAuthChallenge', mailerRole, {
          SES_FROM_ADDRESS,
          SES_ROLE_ARN: senderRoleArn,
          SES_REGION: MAIL_REGION,
        }),
        verifyAuthChallengeResponse: trigger('verify', 'verifyAuthChallenge'),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.client = this.userPool.addClient('Client', {
      userPoolClientName: `${PREFIX}-hr`,
      generateSecret: false,
      authFlows: { custom: true },
      idTokenValidity: cdk.Duration.hours(8),
      preventUserExistenceErrors: true,
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.client.userPoolClientId });
  }
}
