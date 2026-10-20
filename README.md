# PartWays

Independent AI exit interviews, by voice or text. Organisations sign up free, run 3 interviews, then buy credits. Departing employees are invited by WhatsApp, review their own summary before anything is shared, and are known to the organisation only by a PartWays Interview Id.

- **Home page** (`/`): the solution, pricing and free sign-up.
- **Employee experience** (`/interview/`): WhatsApp invitation link, AI voice or AI text, three lengths, focus topics, English, German and French. The conversation is followed by a review where the employee corrects, removes or adds points, confirms their own reasons for leaving, and chooses whether to submit. They can correct or withdraw afterwards.
- **HR workspace** (`/hr/`): free sign-up and 6-digit email code sign-in, programmes with objectives-first guide editing and free previews, participants and WhatsApp invitations, credits and billing, follow-up requests, insights with theme pages, the insight assistant, reports (PDF, CSV, presentation) and actions. Every organisation also gets a private demo workspace (fictional Calder & Finch Logistics data), reached with the switch in the sidebar.

## Workspaces, credits and identity

- **Workspaces.** Each organisation's data lives in its own namespace (`PK=NS#<orgId>`); its demo copy is `NS#<orgId>~demo`, created on first visit. Accounts, sign-in codes and lookup indexes live in `NS#global`. Every API request runs inside exactly one workspace (`src/lib/context.js`).
- **Credits.** Sign-up grants 3 free credits. One credit is used when an invitation is sent; reminders and previews are free. Packs: 10 for $100, 25 for $200, 50 for $300, 100 for $500 (`src/domain/workspaces.js`). Purchases go through Stripe Checkout; the webhook (`/api/stripe/webhook`) and the return page both grant credits, idempotently. With no `STRIPE_SECRET_KEY`, purchases are simulated and labelled as test purchases.
- **PartWays Interview Id.** Every invitation gets a unique `PW-XXXX-XXXX` Id (Crockford base32), checked against a global index. It appears in the WhatsApp message, the employee's screens and the HR workspace.
- **Sign-up and team.** The home page form asks for organisation name, country and email, then a 6-digit code. The person who signs up is the owner and can add team members from the Team page as owner, analyst or leader. Roles are enforced by the API in an organisation's own workspace; each email belongs to one workspace.
- **New versions.** `/version.json` changes on every deploy (locally, whenever a frontend file changes). Open pages check it every minute and offer a reload.
- **De-identification.** Names are not collected. The HR workspace shows the Interview Id and a masked mobile number; the full number is only shown if the person asks to be contacted. Email addresses and phone numbers are removed from what employees say before it is stored, and the interviewer and summariser are instructed to leave out names. There is no human interviewer option.

## Run locally

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env      # optional: add keys, or leave empty for offline developer mode
npm run seed              # creates data/store.json with the demonstration data
npm run dev               # http://localhost:8787
npm test
```

Open http://localhost:8787 and create an organisation with the form on the home page, using any email. Locally the code is printed in the server console (or shown in the browser with `DEV_SHOW_OTP=1`). `npm run seed` clears local data. Without an `ANTHROPIC_API_KEY` the interviewer, summariser, plan proposals and assistant use rule-based fallbacks, and the UI says so.

## Architecture

| Piece | Local | AWS |
|---|---|---|
| Static frontend (plain HTML, CSS, ES modules) | `scripts/dev-server.js` | S3 + CloudFront |
| API (`src/handlers/api.js`, one Node.js function, NDJSON streaming for interview turns) | same handler in-process | Lambda function URL with response streaming, only reachable through CloudFront |
| Data (single-table: `PK=NS#<workspace>`, `SK=<type>#<id>`) | `data/store.json` | DynamoDB, TTL on sign-in codes |
| HR sign-in (6-digit email code) | HMAC token, code in console | Cognito custom auth, codes sent with SES |
| Interviewer, summaries, plan proposals, assistant | Claude via the Anthropic API, or offline | Claude via the Anthropic API or Amazon Bedrock |
| Speech | Browser speech recognition and synthesis | Optional Deepgram (STT) and ElevenLabs (TTS) |
| Payments | Simulated without a key | Stripe Checkout (test or live key) and webhook |
| Provider keys | `.env` | Secrets Manager, loaded at cold start |

All dashboard numbers, assistant answers, reports and exports come from one function (`src/domain/analytics.js` → `computeInsights`), so they always agree.

## Deploy to AWS

Prerequisites: AWS SAM CLI, an SSO profile for the PartWays AWS account, and an SES-verified sender (in the SES sandbox, recipients must be verified too).

The backend is deployed by hand, after committing and pushing this repository:

```bash
AWS_PROFILE=<partways-sso-profile> SES_FROM=no-reply@yourdomain.com HR_ALLOWED=@yourdomain.com scripts/deploy.sh
```

The stack also creates the GitHub deploy role for PARTWAYS-PORTAL (and GitHub's OIDC provider; pass `CREATE_GITHUB_OIDC_PROVIDER=false` if the account already has one). The script prints the four repository variables to set in PARTWAYS-PORTAL. The website itself is released only by PARTWAYS-PORTAL's GitHub Actions workflow on push to `main`. For local development, `npm run dev` serves `../PARTWAYS-PORTAL`.

Then put provider keys into the secret named in the `ProviderSecretsArn` output, as JSON:

```json
{ "ANTHROPIC_API_KEY": "…", "DEEPGRAM_API_KEY": "…", "ELEVENLABS_API_KEY": "…", "STRIPE_SECRET_KEY": "sk_test_…", "STRIPE_WEBHOOK_SECRET": "whsec_…" }
```

In Stripe, add a webhook endpoint at `https://<site>/api/stripe/webhook` for `checkout.session.completed`.

Deepgram and ElevenLabs are optional; without them the browser’s own speech services are used. With `LlmProvider=bedrock`, no Anthropic key is needed but the account needs Bedrock access to the Claude model. Each organisation's demo workspace is created the first time it is opened.

## Notes for evaluators

**Simulated, and labelled as such in the product**
- WhatsApp invitations and reminders are recorded as sent but not delivered. The message preview shows exactly what would be sent.
- Without a Stripe key, credit purchases are simulated test purchases.
- “View as” in the demo workspace switches between programme owner, people analyst and leader. It is a demonstration control, not access control.

**Audio and provider retention**
- PartWays does not record or store audio. Transcripts are stored as text.
- Browser speech recognition in Chrome sends audio to Google’s speech service; PartWays does not control its retention. The interview preparation screen says this.
- Deepgram is called with `mip_opt_out=true` (excluded from model improvement). Deepgram may still keep audio briefly for operations under its own policy.
- ElevenLabs request logging is only disabled when `ELEVENLABS_ZERO_RETENTION=1`, which requires a plan that supports it.
- With the Anthropic API or Bedrock, transcripts are processed under that provider’s data terms.

**Not verified in this environment**
- Live voice (microphone capture, Deepgram streaming, ElevenLabs playback) needs a real browser with a microphone and keys. The text path, the streaming protocol and barge-in logic are exercised; the provider connections are not.
- The AWS stack passes `cfn-lint` but has not been deployed.
- Stripe Checkout and the webhook have not been run against a Stripe account; simulated purchases are tested.
- The interviewer and assistant were tested in offline mode; quality with Claude needs a key.
