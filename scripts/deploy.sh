#!/usr/bin/env bash
# Deploys the stack, uploads the static site and invalidates CloudFront.
# Usage: SES_FROM=no-reply@example.com [HR_ALLOWED=@example.com] [STACK=partways] scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PORTAL="${PORTAL_DIR:-../PARTWAYS-PORTAL}"
STACK="${STACK:-partways}"
: "${SES_FROM:?Set SES_FROM to an SES-verified sender address}"

npm ci --omit=dev
sam deploy --stack-name "$STACK" --resolve-s3 --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "SesFromAddress=$SES_FROM" "HrAllowedEmails=${HR_ALLOWED:-}" "LlmProvider=${LLM_PROVIDER:-anthropic}"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out SiteBucketName)
DIST=$(out DistributionId)
# A new version id on every deploy makes open pages offer a reload.
echo "{\"version\":\"$(git rev-parse --short HEAD 2>/dev/null || echo build)-$(date +%s)\"}" > "$PORTAL/version.json"
aws s3 sync "$PORTAL" "s3://$BUCKET" --delete --cache-control no-cache
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*' >/dev/null
echo "Deployed: $(out SiteUrl)"
echo "Provider keys go in: $(out ProviderSecretsArn)"
