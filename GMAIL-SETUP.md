# Gmail integration setup

InboxPay uses Gmail as the invoice intake and receipt surface for a real connected business inbox.

## Production setup

The hosted product handles Gmail OAuth itself. Users **do not** upload credential files, enter client secrets, or run the local scanner.

In Google Cloud, create or use a **Web application** OAuth client with the Gmail API enabled.

The InboxPay Gmail callback is:

`https://tameion-ap-agent-live.vercel.app/api/gmail/callback`

The production origin is:

`https://tameion-ap-agent-live.vercel.app`

The same Web OAuth client may also be used for Supabase Google sign-in, provided its authorized origins and redirect URIs include both Google flows. Keeping separate clients is also valid.

## Vercel configuration

Set these server-side environment variables in the production Vercel project:

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
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

The repository still contains local Gmail scanner utilities for development and investigation, including:

`npm run scan:gmail`

Those scripts are separate from the production OAuth connector and should not be represented as the hosted user onboarding flow.
