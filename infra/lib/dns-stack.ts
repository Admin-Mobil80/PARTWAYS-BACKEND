import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { DKIM_RECORDS, HOSTED_ZONE_ID, MAIL_FROM_DOMAIN, MAIL_REGION, ZONE_NAME } from './account';

/**
 * Records in the partways.org zone (PartWays account) for mail sent through
 * the m80 account's SES: DKIM, the custom MAIL FROM domain, and DMARC.
 */
export class DnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const zone = route53.PublicHostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ZONE_NAME,
    });

    DKIM_RECORDS.forEach(({ name, value }, i) => {
      new route53.CnameRecord(this, `Dkim${i + 1}`, {
        zone,
        recordName: name,
        domainName: value,
        ttl: cdk.Duration.hours(1),
      });
    });

    // Bounces and complaints come back through SES; SPF passes for this
    // subdomain, which aligns with partways.org under DMARC.
    new route53.MxRecord(this, 'MailFromMx', {
      zone,
      recordName: MAIL_FROM_DOMAIN,
      values: [{ priority: 10, hostName: `feedback-smtp.${MAIL_REGION}.amazonses.com` }],
      ttl: cdk.Duration.hours(1),
    });
    new route53.TxtRecord(this, 'MailFromSpf', {
      zone,
      recordName: MAIL_FROM_DOMAIN,
      values: ['v=spf1 include:amazonses.com ~all'],
      ttl: cdk.Duration.hours(1),
    });

    // Monitoring only to start with; tighten to quarantine once mail is flowing cleanly.
    new route53.TxtRecord(this, 'Dmarc', {
      zone,
      recordName: `_dmarc.${ZONE_NAME}`,
      values: ['v=DMARC1; p=none'],
      ttl: cdk.Duration.hours(1),
    });
  }
}
