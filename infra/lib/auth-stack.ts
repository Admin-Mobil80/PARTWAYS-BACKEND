import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PREFIX, SES_FROM_ADDRESS } from './account';
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

    const trigger = (name: string, handler: string, sendsMail: boolean) => {
      const fn = backendFunction(this, `${handler[0]!.toUpperCase()}${handler.slice(1)}Fn`, {
        name: `auth-${name}`,
        file: 'auth-triggers',
        handler,
        timeout: cdk.Duration.seconds(10),
        environment: sendsMail ? { SES_FROM_ADDRESS } : undefined,
      });
      if (sendsMail) {
        // Send only as the configured address.
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['ses:SendEmail'],
            resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
            conditions: { StringEquals: { 'ses:FromAddress': SES_FROM_ADDRESS } },
          }),
        );
      }
      return fn;
    };

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${PREFIX}-hr`,
      selfSignUpEnabled: false,
      signInCaseSensitive: false,
      // Recovery is by an administrator only: there are no passwords to reset.
      accountRecovery: cognito.AccountRecovery.NONE,
      lambdaTriggers: {
        defineAuthChallenge: trigger('define', 'defineAuthChallenge', true),
        createAuthChallenge: trigger('create', 'createAuthChallenge', true),
        verifyAuthChallengeResponse: trigger('verify', 'verifyAuthChallenge', false),
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
