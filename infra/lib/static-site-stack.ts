import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { HOSTED_ZONE_ID, PREFIX, ZONE_NAME } from './account';
import { backendFunction } from './functions';

export interface StaticSiteStackProps extends cdk.StackProps {
  /** Short app name, lowercase, used in resource names (`portal`). */
  readonly appName: string;
  /** `owner/repo` of the GitHub repository allowed to deploy this site. */
  readonly githubRepo: string;
  /** Hosting bucket from the hosting stack. */
  readonly bucketName: string;
  /** Folder in the hosting bucket, no leading or trailing slash: `PORTAL`. */
  readonly sitePrefix: string;
  /** GitHub's OIDC provider in this account. */
  readonly githubOidcProviderArn: string;
  /** Public hostnames in the partways.org zone; the first is the canonical one. */
  readonly domainNames: string[];
  /** The app's API, served from this distribution at /api/*. Omitted until the app has one. */
  readonly api?: SiteApiProps;
}

export interface SiteApiProps {
  /** Handler file under src/handlers, without extension. */
  readonly file: string;
  readonly environment: Record<string, string>;
  /** Grant the function what it needs (table, secrets, pool, ...). */
  readonly grant: (fn: NodejsFunction) => void;
}

/**
 * One web app: a CloudFront distribution serving a folder of the hosting
 * bucket at its own hostnames, its streaming API at /api/* on the same origin
 * (once it has one), and the GitHub Actions deploy role for exactly one repo
 * and one folder.
 */
export class StaticSiteStack extends cdk.Stack {
  public readonly apiFunction?: NodejsFunction;

  constructor(scope: Construct, id: string, props: StaticSiteStackProps) {
    super(scope, id, props);

    const { appName, githubRepo, sitePrefix, domainNames } = props;

    // CloudFront only accepts certificates from us-east-1, which is where
    // PartWays runs, so the certificate lives in this stack.
    if (this.region !== 'us-east-1') {
      throw new Error(`${id}: the certificate must be in us-east-1 for CloudFront; move it to its own stack to deploy elsewhere`);
    }
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ZONE_NAME,
    });
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domainNames[0]!,
      subjectAlternativeNames: domainNames.slice(1),
      certificateName: domainNames[0]!,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // Imported by name: the bucket's policy belongs to the hosting stack and
    // already lets every CloudFront distribution in this account read it.
    const bucket = s3.Bucket.fromBucketAttributes(this, 'WebappsBucket', {
      bucketName: props.bucketName,
      region: this.region,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${PREFIX}-${appName}-security-headers`,
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
      // Voice interviews need the microphone on this origin only.
      customHeadersBehavior: {
        customHeaders: [{ header: 'Permissions-Policy', value: 'microphone=(self), camera=()', override: true }],
      },
    });

    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(bucket, { originPath: `/${sitePrefix}` });
    cdk.Annotations.of(this).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
      'The hosting stack grants read to every CloudFront distribution in this account.',
    );

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: `${PREFIX}-${appName} (${domainNames.join(', ')})`,
      domainNames,
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
        // /hr/ and /interview/ are folders with an index.html.
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, 'IndexRewrite', {
              functionName: `${PREFIX}-${appName}-index`,
              comment: 'Serve index.html for folder paths',
              runtime: cloudfront.FunctionRuntime.JS_2_0,
              code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var r = event.request;
  if (r.uri.endsWith('/')) r.uri += 'index.html';
  else if (r.uri.indexOf('.') === -1) r.uri += '/index.html';
  return r;
}`),
            }),
          },
        ],
      },
      additionalBehaviors: {
        // Open pages poll this to offer a reload after a deploy.
        '/version.json': {
          origin: siteOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: securityHeaders,
        },
      },
    });

    if (props.api) this.apiFunction = this.addApi(distribution, appName, securityHeaders, props.api);

    const aliasTarget = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    domainNames.forEach((recordName, i) => {
      const suffix = i === 0 ? '' : `${i + 1}`;
      new route53.ARecord(this, `AliasRecord${suffix}`, { zone, recordName, target: aliasTarget });
      new route53.AaaaRecord(this, `AliasRecordV6${suffix}`, { zone, recordName, target: aliasTarget });
    });

    // There is one branch and one environment, so the role trusts main only.
    // The second subject form covers an organisation that adds numeric ids to
    // the OIDC subject claim: repo:<owner>@<id>/<repo>@<id>:ref:refs/heads/main
    const [githubOwner, githubRepoName] = githubRepo.split('/');
    if (!githubOwner || !githubRepoName) {
      throw new Error(`githubRepo must be "owner/repo", got "${githubRepo}"`);
    }
    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: `${PREFIX}-${appName}-github-deploy`,
      description: `GitHub Actions deploy role for ${githubRepo}`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(props.githubOidcProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${githubRepo}:ref:refs/heads/main`,
            `repo:${githubOwner}@*/${githubRepoName}@*:ref:refs/heads/main`,
          ],
        },
      }),
    });

    // The bucket holds every PartWays web app, so the role is confined to this
    // app's folder. The s3:prefix condition matters as much as the object ARNs:
    // without it `aws s3 sync --delete` could list a sibling's folder.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListOwnFolderOnly',
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': [`${sitePrefix}/*`, sitePrefix] } },
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteOwnFolderOnly',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [bucket.arnForObjects(`${sitePrefix}/*`)],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvalidateOwnDistributionOnly',
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
      }),
    );

    // Output names match the GitHub repo variables the deploy workflow reads.
    new cdk.CfnOutput(this, 'AwsDeployRoleArn', { value: deployRole.roleArn, description: `Repo variable AWS_DEPLOY_ROLE_ARN in ${githubRepo}` });
    new cdk.CfnOutput(this, 'AwsRegion', { value: this.region, description: `Repo variable AWS_REGION in ${githubRepo}` });
    new cdk.CfnOutput(this, 'S3Bucket', { value: bucket.bucketName, description: `Repo variable S3_BUCKET in ${githubRepo}` });
    new cdk.CfnOutput(this, 'S3Prefix', { value: sitePrefix, description: `Repo variable S3_PREFIX in ${githubRepo}` });
    new cdk.CfnOutput(this, 'CloudfrontDistributionId', {
      value: distribution.distributionId,
      description: `Repo variable CLOUDFRONT_DISTRIBUTION_ID in ${githubRepo}`,
    });
    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${domainNames[0]}` });
    new cdk.CfnOutput(this, 'CloudfrontUrl', { value: `https://${distribution.distributionDomainName}` });
  }

  /**
   * The app's API at /api/* on its own distribution, so the browser calls
   * same-origin. Interview turns stream NDJSON, so the function URL streams
   * its response. Only CloudFront knows the x-origin-verify value, and the
   * function rejects any request without it, so the URL is useless on its own.
   */
  private addApi(
    distribution: cloudfront.Distribution,
    appName: string,
    securityHeaders: cloudfront.IResponseHeadersPolicy,
    config: SiteApiProps,
  ): NodejsFunction {
    const originSecret = new secretsmanager.Secret(this, 'OriginSecret', {
      secretName: `${PREFIX}/${appName}-origin-verify`,
      description: 'Shared header value between CloudFront and the API function URL',
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });
    // A CloudFormation dynamic reference, resolved at deploy time; the value
    // never appears in the template.
    const originVerify = originSecret.secretValue.unsafeUnwrap();

    const fn = backendFunction(this, 'ApiFunction', {
      name: `${appName}-api`,
      file: config.file,
      handler: 'handler',
      timeout: cdk.Duration.seconds(120),
      environment: { ...config.environment, ORIGIN_VERIFY: originVerify },
    });
    config.grant(fn);

    new cloudwatch.Alarm(this, 'ApiErrorsAlarm', {
      alarmName: `${PREFIX}-${appName}-api-errors`,
      alarmDescription: `${PREFIX}-${appName}-api threw unhandled errors`,
      metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const url = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });
    distribution.addBehavior(
      '/api/*',
      new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', url.url)), {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        readTimeout: cdk.Duration.seconds(60),
        customHeaders: { 'x-origin-verify': originVerify },
      }),
      {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Forward the body and headers, but not Host: the function URL's own
        // hostname is what its TLS certificate expects.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: securityHeaders,
      },
    );
    return fn;
  }
}
