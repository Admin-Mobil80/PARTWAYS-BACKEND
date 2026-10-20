#!/usr/bin/env bash
# Deploys the backend stack. The website is not uploaded here: PARTWAYS-PORTAL
# releases it through GitHub Actions on push to main.
# Commit and push PARTWAYS-BACKEND before running this.
# Usage: AWS_PROFILE=<sso-profile> SES_FROM=no-reply@example.com [HR_ALLOWED=@example.com] [STACK=partways] scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
STACK="${STACK:-partways}"
: "${AWS_PROFILE:?Set AWS_PROFILE to the PartWays SSO profile}"
: "${SES_FROM:?Set SES_FROM to an SES-verified sender address}"

npm ci --omit=dev
sam deploy --stack-name "$STACK" --resolve-s3 --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "SesFromAddress=$SES_FROM" "HrAllowedEmails=${HR_ALLOWED:-}" "LlmProvider=${LLM_PROVIDER:-anthropic}" \
    "CreateGithubOidcProvider=${CREATE_GITHUB_OIDC_PROVIDER:-true}"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
echo "Deployed: $(out SiteUrl)"
echo "Provider keys go in: $(out ProviderSecretsArn)"
echo
echo "PARTWAYS-PORTAL repository variables (Settings > Secrets and variables > Actions > Variables):"
for k in AwsDeployRoleArn AwsRegion S3Bucket CloudfrontDistributionId; do
  case $k in
    AwsDeployRoleArn) n=AWS_DEPLOY_ROLE_ARN ;; AwsRegion) n=AWS_REGION ;;
    S3Bucket) n=S3_BUCKET ;; CloudfrontDistributionId) n=CLOUDFRONT_DISTRIBUTION_ID ;;
  esac
  printf '  %-28s %s\n' "$n" "$(out $k)"
done
