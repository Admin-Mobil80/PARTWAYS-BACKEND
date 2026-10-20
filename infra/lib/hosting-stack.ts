import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CREATE_GITHUB_OIDC_PROVIDER, WEBAPPS_BUCKET_NAME } from './account';

/**
 * Account-wide pieces the web apps share: the hosting bucket (one folder per
 * app) and GitHub's OIDC provider, which the apps' deploy roles trust. The
 * site stacks import the bucket by its fixed name, not through an export, so
 * this stack can change without first untangling them.
 */
export class HostingStack extends cdk.Stack {
  public readonly githubOidcProviderArn: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'WebappsBucket', {
      bucketName: WEBAPPS_BUCKET_NAME,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Any CloudFront distribution in this account may read the bucket; each
    // one sees only its own folder through its originPath. Granting here, not
    // per distribution, keeps the site stacks from editing this policy.
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'CloudFrontReadInThisAccount',
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('*')],
        conditions: { StringEquals: { 'AWS:SourceAccount': this.account } },
      }),
    );

    if (CREATE_GITHUB_OIDC_PROVIDER) {
      const provider = new iam.CfnOIDCProvider(this, 'GithubOidcProvider', {
        url: 'https://token.actions.githubusercontent.com',
        clientIdList: ['sts.amazonaws.com'],
      });
      this.githubOidcProviderArn = provider.attrArn;
    } else {
      this.githubOidcProviderArn = `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;
    }

    new cdk.CfnOutput(this, 'WebappsBucketName', { value: bucket.bucketName });
  }
}
