# Gmail integration setup

The AP Agent uses Gmail as the invoice intake and receipt surface.

## 1. Create Google OAuth credentials

In Google Cloud, enable the Gmail API and create an OAuth 2.0 Client ID with application type **Desktop app**. Google documents this local OAuth flow for Node.js testing. See:
https://developers.google.com/workspace/gmail/api/quickstart/nodejs

Download the credential JSON and save it as:

\`C:\Users\USER\tameion-ap-agent-live\credentials.json\`

Do not commit or paste this file anywhere.

## 2. Run the scanner

Open a terminal and run:

\`C:\Users\USER\tameion-ap-agent-live\SCAN-GMAIL-INVOICES.cmd\`

The first run opens Google's authorization flow. After authorization, the scanner searches:

\`in:anywhere has:attachment filename:pdf newer_than:30d\`

It downloads PDF invoice attachments into \`gmail-inbox\`, extracts their text, and writes normalized metadata to \`gmail-scan-result.json\`.

## 3. What is wired today

The scanner captures the Gmail message ID, thread ID, RFC Message-ID, sender, subject, date, PDF filename, invoice number, amount, currency, and due date.

The parser is intentionally deterministic and conservative. Missing key fields lower confidence instead of inventing values.

The payment path remains separately policy-gated. Gmail ingestion does not by itself move funds.

## 4. Next integration

The next runner will consume the normalized invoice, resolve the vendor against the allowlist, apply the agent policy, execute the Arc payment when allowed, reconcile the onchain result, and reply in the original Gmail thread with the transaction receipt.

