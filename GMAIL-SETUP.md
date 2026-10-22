# Gmail integration setup

InboxPay uses Gmail as the invoice intake and receipt surface for a real connected business inbox.

## Production setup

The hosted product handles Gmail OAuth itself. Users **do not** upload credential files, enter client secrets, or run the local scanner.

In Google Cloud, create or use a **Web application** OAuth client with the Gmail API enabled.

Register both current production callbacks on the Gmail Web OAuth client **before deploying the same-origin callback change**:

- `https://inboxpay.vercel.app/api/gmail/callback`
- `https://tameion-ap-agent-live.vercel.app/api/gmail/callback`

The application chooses the callback for the explicitly allowed host where the user starts the connection. It encrypts that exact URI and client ID into its ten-minute state cookie, validates them on callback, and uses the same URI for Google's code exchange. Redirects stay on that origin. A host-only cookie from the canonical domain cannot be read on the legacy domain.

`GMAIL_OAUTH_ALLOWED_ORIGINS` optionally replaces the built-in canonical and legacy origins with a comma-separated list of exact HTTPS origins. Register each origin's `/api/gmail/callback` with Google first. No wildcard previews, arbitrary Host values, or forwarded-host headers can add an origin. Keep the old origin while in-flight consent finishes; old-release cookies without a bound URI are accepted only at the legacy callback. Preview deployments still block Gmail OAuth.

For the new dedicated InboxPay Google project, keep identity-only Supabase sign-in and restricted Gmail access as separate clients. Supabase uses its own `/auth/v1/callback` URL; the Gmail connector uses the two app callbacks above. Do not confuse the Supabase return-URL allowlist with Google's authorized Gmail redirect URIs. Changing Gmail client credentials requires a controlled migration/reconnect of grants bound to the old client; this patch does not replace credentials or migrate refresh tokens.

## Vercel configuration

Set these server-side environment variables in the production Vercel project:

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_OAUTH_ALLOWED_ORIGINS` (optional; see the exact-origin rules above)
- the InboxPay token-encryption secret used by the Gmail integration

Never expose or commit these values.

## Connect a business inbox

1. Sign into InboxPay.
2. Click **Connect Gmail**.
3. Complete Google consent for the Gmail account that actually receives the business's invoices.
4. InboxPay binds the Google connection to the authenticated InboxPay user and business.
5. The server stores the provider tokens encrypted and uses them server-side to read invoice evidence.

The production connector requests Gmail read access only. It does not require the business user to paste tokens into InboxPay.

## Invoice evaluation

After Gmail is connected, **Refresh inbox** runs the live Gmail invoice path. InboxPay evaluates the real email/PDF evidence, checks required fields, duplicate state, currency, vendor registry, and business policy, then produces a bounded decision such as `PAY_NOW`, `HOLD`, `ESCALATE`, or `SCHEDULE`.

Gmail ingestion alone never moves funds. Settlement requires the business wallet, policy guard, verified vendor, and payment checks to pass.

## Local development

### Disconnecting Gmail

In Business account, choose **Disconnect Gmail** and confirm. InboxPay clears stored access/refresh tokens, expiry, scopes, and Google account identifier; it keeps the integration row and saved invoice/payment records. The connection is shared across the owner's business environments. It does not revoke Google's grant, cancel queued payments, disable autonomy, or remove vault authority. A scan already in progress may finish. To remove the Google grant too, use Google Account third-party connections; related access in the same Google project may be affected. To stop financial execution, manage autonomy/pause/allowance separately in Payment settings.

Token removal applies to the active database; encrypted historical backups may still contain earlier records. Backup retention and restore-time deletion handling remain unapproved. Do not promise deletion from backups or complete account deletion.

Run `npm run test:gmail-disconnect` for synthetic owner-scoped removal, failure, preview and stale-refresh checks. Production acceptance requires a controlled account and explicit authority to disconnect it. No live account has been disconnected by this implementation test.

Local development uses the same API handlers as Production. Configure the environment names in `.env.example` and start the local server with `npm start`. A plain-HTTP localhost Gmail flow is not supported by the Secure cookie/exact-HTTPS-origin boundary. For live consent QA, use a controlled HTTPS host registered with Google and explicitly allowlisted in server configuration; ordinary Vercel visual previews remain read-only. Do not upload downloaded tokens or commit credential files.

Run `npm run test:gmail-oauth` for deterministic route tests covering same-origin consent/code exchange, hostile hosts, cross-host callbacks, expired/tampered state, client mismatch and old-release cookies. These tests use synthetic provider responses and do not establish real Google consent acceptance. After registering the callbacks and deploying, separately verify the full canonical-host consent and reconnect flow with a controlled account. Never mark live acceptance complete from unit tests alone.
