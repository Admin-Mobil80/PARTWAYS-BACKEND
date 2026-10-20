import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';
import {
  ACCOUNT,
  AUTH_MAILER_ROLE_NAME,
  MAIL_DOMAIN,
  MAIL_FROM_DOMAIN,
  MAIL_SENDER_ROLE_NAME,
  SES_FROM_ADDRESS,
} from './account';

/**
 * Deployed to the m80 account, whose SES is out of the sandbox. It holds only
 * what PartWays needs to send sign-in codes from there: the partways.org
 * identity and a send-only role. The DNS records that verify the identity live
 * in the partways.org zone in the PartWays account (partways-dns).
 *
 * m80 is shared with other products: everything here is named partways-*.
 */
export class MailerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const identity = new ses.EmailIdentity(this, 'Identity', {
      identity: ses.Identity.domain(MAIL_DOMAIN),
      mailFromDomain: MAIL_FROM_DOMAIN,
      // Until the MAIL FROM records resolve, send with SES's own MAIL FROM rather than fail.
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
    });

    // Trusted by account, narrowed to one role by aws:PrincipalArn: naming the
    // role as the principal would fail until it exists in the PartWays account.
    const senderRole = new iam.Role(this, 'SenderRole', {
      roleName: MAIL_SENDER_ROLE_NAME,
      description: `Lets ${AUTH_MAILER_ROLE_NAME} in ${ACCOUNT} send PartWays sign-in codes as ${SES_FROM_ADDRESS}`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.AccountPrincipal(ACCOUNT).withConditions({
        ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${ACCOUNT}:role/${AUTH_MAILER_ROLE_NAME}` },
      }),
    });
    senderRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SendAsPartWaysOnly',
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${MAIL_DOMAIN}`],
        conditions: { StringEquals: { 'ses:FromAddress': SES_FROM_ADDRESS } },
      }),
    );

    identity.dkimRecords.forEach((record, i) => {
      new cdk.CfnOutput(this, `DkimRecord${i + 1}`, {
        value: cdk.Fn.join(' ', [record.name, record.value]),
        description: 'CNAME name and value: copy into DKIM_RECORDS in lib/account.ts',
      });
    });
    new cdk.CfnOutput(this, 'SenderRoleArn', { value: senderRole.roleArn });
  }
}
