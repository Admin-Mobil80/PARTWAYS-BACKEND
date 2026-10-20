/**
 * Deployment target and settings.
 *
 * PartWays has its own AWS account, reached through SSO. The account is
 * hardcoded on purpose, so a deploy can never land in whatever account the
 * active credentials happen to point at. See README for the deploy commands.
 */
export const ACCOUNT = '720771544607'; // Stellrtek, via SSO profile 'stellrtek'
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
 * Sign-in codes are sent through the m80 account's SES, which is out of the
 * sandbox; everything else runs in the PartWays account above. m80 holds only
 * the partways-mailer stack: the partways.org SES identity and a send-only
 * role that the code-sending function assumes. Deploy that stack with the
 * m80 SSO profile (wingtheidea), everything else with 'stellrtek'.
 */
export const SES_FROM_ADDRESS = 'no-reply@partways.org';
export const MAIL_DOMAIN = 'partways.org';
/** Custom MAIL FROM, so SPF aligns with partways.org. */
export const MAIL_FROM_DOMAIN = `bounce.${MAIL_DOMAIN}`;
export const MAIL_ACCOUNT = '231427841372'; // m80
export const MAIL_REGION = 'us-east-1';
/** The send-only role in m80, and the only role in this account allowed to assume it. */
export const MAIL_SENDER_ROLE_NAME = 'partways-ses-sender';
export const AUTH_MAILER_ROLE_NAME = 'partways-auth-mailer';

/**
 * The partways.org public hosted zone, in the PartWays account. Route 53 is
 * global; the DNS stack sits in us-east-1, where CloudFront certificates for
 * a custom domain will also have to live.
 */
export const ZONE_NAME = MAIL_DOMAIN;
export const HOSTED_ZONE_ID = 'Z0321348257M6WKBR7WB8';
export const DNS_REGION = 'us-east-1';

/**
 * SES issues the DKIM records only once partways-mailer has created the
 * identity in m80. Copy its DkimRecord outputs here, then deploy partways-dns.
 */
export const DKIM_RECORDS: ReadonlyArray<{ readonly name: string; readonly value: string }> = [];

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
