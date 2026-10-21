import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';
import {
  ACCOUNT,
  AUTH_MAILER_ROLE_NAME,
  MAIL_DOMAIN,
  MAIL_FROM_DOMAIN,
  MAIL_SENDER_ROLE_NAME,
  PREFIX,
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

    // Delivery tracking: what happened to each email (sent, delivered with the
    // receiving server's reply, bounced, delayed, complained), in a log group.
    // It is the identity's default configuration set, so every send is tracked
    // without the sender naming it.
    const configurationSet = new ses.ConfigurationSet(this, 'ConfigurationSet', {
      configurationSetName: `${PREFIX}-mail`,
    });
    const defaultBus = events.EventBus.fromEventBusName(this, 'DefaultBus', 'default');
    configurationSet.addEventDestination('ToEventBridge', {
      configurationSetEventDestinationName: `${PREFIX}-mail-events`,
      destination: ses.EventDestination.eventBus(defaultBus),
      events: [
        ses.EmailSendingEvent.SEND,
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.DELIVERY_DELAY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.RENDERING_FAILURE,
      ],
    });
    const mailLog = new logs.LogGroup(this, 'MailEvents', {
      logGroupName: `/aws/events/${PREFIX}-mail`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new events.Rule(this, 'MailEventsRule', {
      ruleName: `${PREFIX}-mail-events`,
      description: 'PartWays email delivery events to CloudWatch Logs',
      eventBus: defaultBus,
      // m80 sends for other products too; keep only PartWays' mail.
      eventPattern: {
        source: ['aws.ses'],
        detail: { mail: { tags: { 'ses:configuration-set': [configurationSet.configurationSetName] } } },
      },
      targets: [new targets.CloudWatchLogGroup(mailLog)],
    });

    const identity = new ses.EmailIdentity(this, 'Identity', {
      identity: ses.Identity.domain(MAIL_DOMAIN),
      configurationSet,
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
        // SES also authorises the send against the identity's default configuration set.
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/${MAIL_DOMAIN}`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/${configurationSet.configurationSetName}`,
        ],
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
    new cdk.CfnOutput(this, 'MailEventsLogGroup', { value: mailLog.logGroupName });
  }
}
