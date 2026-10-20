/**
 * Deployment target and settings.
 *
 * PartWays has its own AWS account, reached through SSO. The account is
 * hardcoded on purpose, so a deploy can never land in whatever account the
 * active credentials happen to point at. Deploy with:
 *   AWS_PROFILE=<partways-sso-profile> npm run deploy
 */
export const ACCOUNT = ''; // TODO: the PartWays account id
export const REGION = ''; // TODO: e.g. ap-south-1

/** Every PartWays resource name starts with this. */
export const PREFIX = 'partways';

/** GitHub organisation holding PARTWAYS-PORTAL, PARTWAYS-BMS and PARTWAYS-BACKEND. */
export const GITHUB_OWNER = 'Admin-Mobil80';

/**
 * IAM allows one GitHub Actions OIDC provider per account. The PartWays
 * account is new, so this app creates it. Set to false only if the account
 * already has one (aws iam list-open-id-connect-providers).
 */
export const CREATE_GITHUB_OIDC_PROVIDER = true;

/**
 * Sender for the 6-digit sign-in codes. Must be a verified SES identity in
 * REGION (in the SES sandbox, recipients must be verified too).
 */
export const SES_FROM_ADDRESS = ''; // TODO: e.g. no-reply@partways.example

/**
 * Optional comma-separated emails or @domains allowed to sign up and sign in.
 * Empty allows free sign-up for anyone.
 */
export const HR_ALLOWED_EMAILS = '';

/**
 * anthropic: ANTHROPIC_API_KEY from the provider secret.
 * bedrock: this account's Amazon Bedrock access, no key needed.
 * offline: rule-based fallbacks only.
 */
export const LLM_PROVIDER: 'anthropic' | 'bedrock' | 'offline' = 'anthropic';

/** Empty uses the code's default (claude-opus-5-5, or its Bedrock id). */
export const LLM_MODEL = '';

/** '1' only if the ElevenLabs plan includes zero-retention mode. */
export const ELEVENLABS_ZERO_RETENTION: '0' | '1' = '0';

/**
 * Hosting bucket for the PartWays web apps, laid out by folder:
 *
 *   partways-webapps-<account>/
 *     PORTAL/   -> the website (home, /hr/, /interview/)
 *     BMS/      -> the back-office, when it exists
 */
export const PORTAL_PREFIX = 'PORTAL';
export const BMS_PREFIX = 'BMS';
