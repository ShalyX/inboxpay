# API reference

## Conventions

The browser calls same-origin Vercel Functions under `/api`. Except for configuration and OAuth entry/callback endpoints, routes require:

```http
Authorization: Bearer <Supabase access token>
Content-Type: application/json
```

The server reloads business ownership and active network state for every protected operation. Clients must send the network they reviewed for financial or configuration mutations. A `409` commonly means explicit confirmation, stale environment state, or an unmet safety gate. A `202` means the request is durably processing, not settled.

## Endpoints

| Endpoint | Method | Authentication | Purpose |
| --- | --- | --- | --- |
| `/api/config` | `GET` | Public | Returns the public Supabase URL and publishable key required by the browser. |
| `/api/session` | `GET` | User | Returns the authenticated user, active business/network projection, and Gmail integration metadata. |
| `/api/session` | `POST` | User | `{action:"disconnect_gmail",confirm:true}` clears stored Gmail tokens and account metadata for the authenticated owner's business across networks. Retains the integration row and invoice references. Does not revoke Google's grant or alter payment authority. Preview writes are rejected. |
| `/api/onboarding` | `POST` | User | `approve` loads an existing business. For a new owner, it returns `business: null` and `onboarding.businessNameRequired: true` until an explicit `businessName` is supplied. It then creates the owner-scoped business, network account and draft policy. Other actions are `rename_business`, `select_network`, and `provision_wallet`. Mainnet selection and wallet creation require `confirmMainnet: true`. |
| `/api/gmail/start` | `GET` | User | Starts Gmail OAuth with signed, expiring state bound to the user and business. |
| `/api/gmail/callback` | `GET` | OAuth state | Exchanges the Google code, encrypts tokens, binds the Gmail identity, and redirects to the product. |
| `/api/invoices` | `GET` | User | Runs bounded Gmail discovery, persists/evaluates invoice evidence, advances recovery, and returns the active network's queue. |
| `/api/invoices` | `PATCH` | User | `schedule`, `reschedule`, or `cancel_schedule` for one invoice. This changes queue state and does not itself move funds. |
| `/api/invoices` | `POST` | User | `review_due` advances due review schedules for the active network. |
| `/api/invoices` | `POST` | Worker | `autonomy_tick` claims and runs bounded execution jobs. Requires the dedicated worker bearer secret rather than a user session. |
| `/api/preflight?invoice=<number>` | `GET` | User | Returns live payment readiness and each deterministic/onchain gate. No financial write. |
| `/api/pay` | `POST` | User | Settles one eligible invoice through the business policy. Requires `invoiceNumber`, active `network`, and `confirmMainnet: true` on Arc Mainnet. |
| `/api/vendors` | `GET` | User | Lists vendors for the active network and reads onchain registration status where available. |
| `/api/vendors` | `POST` | User | Creates a review-state vendor with name, EVM recipient, USDC currency, sender emails, and active network. |
| `/api/vendors` | `PATCH` | User | Changes vendor status or verified sender emails. Mainnet policy/sender changes require confirmation. |
| `/api/policy` | `GET` | User | Returns stored policy, deployment state, allowance, and live onchain policy state. |
| `/api/policy` | `PATCH` | User | Updates policy limits or autonomy configuration for the active environment. |
| `/api/policy` | `POST` | User | Runs policy actions such as `deploy`, `migrate`, `approve`, `revoke`, pause/resume, or autonomy changes as accepted by the handler. Mainnet mutations require confirmation and the server write gate. |
| `/api/wallet` | `GET` | User | Returns the dedicated wallet, USDC balance, cash floor, reserved/withdrawable funds, policy address, and withdrawal history. |
| `/api/wallet` | `POST` | User | `fund_testnet` or `withdraw`. Withdrawals require `confirmWithdrawal: true`; Mainnet also requires `confirmMainnet: true`. |
| `/api/activity?view=payments` | `GET` | User | Returns up to 100 payment records for the active business/network. |
| `/api/activity?view=audit` | `GET` | User | Returns up to 100 business/network audit events. |
| `/api/activity?view=notifications` | `GET`, `POST` | User | Reads or manages the active business's encrypted Telegram destination. POST actions are `begin_telegram_link`, `send_test`, and `disconnect`. Linked chats receive queued payment-state alerts from the existing authenticated worker; this route does not submit payments. |
| `/api/config?telegram=webhook` | `POST` | Telegram secret header | Consumes a short-lived one-time `/start` code and links the Telegram chat to exactly one business. |

## Financial response states

Business-name setup accepts 2–80 characters, collapses repeated whitespace and rejects control characters. A name is not a legal-entity verification or payment authorization. Repeated `approve` requests never rename an existing business. Preview deployments reject named creation and profile changes; they permit only ordinary unnamed sign-in bootstrap and read-only records.

- `200 OK`: read succeeded, mutation completed, or a prior idempotent result was restored.
- `201 Created`: a new durable schedule or resource was created.
- `202 Accepted`: Circle/Arc work is submitted or queued and reconciliation remains in progress.
- `400 Bad Request`: malformed or unsupported input.
- `401 Unauthorized`: missing/expired user token or invalid worker secret.
- `404 Not Found`: the requested business-scoped invoice/vendor does not exist.
- `409 Conflict`: stale network, missing explicit confirmation, incomplete setup, policy block, uncertain recovery state, or another safety conflict.
- `500/503`: provider or server failure. Financial clients must not interpret this as permission to resubmit with a new idempotency key.

## Idempotency and retries

Gmail disconnection is repeatable. A successful response includes `storedTokensRemoved: true`, `googleGrantRevoked: false`, `recordsDeleted: false`, and `paymentAuthorityChanged: false`. `auditRecorded: false` means credential removal succeeded but the separate audit write failed. A 503 or lost response does not confirm removal: retry the same disconnect action. No tokens are returned. Refresh writes and OAuth callbacks use conditional updates so an older request cannot silently restore removed credentials. An already-started provider request can finish; this is not cancellation of in-flight scans or payments. Removing Google consent is a separate user action.

Payment and withdrawal retries reuse their original business-scoped request identity. A client should refresh the invoice, payment, or withdrawal record after a timeout. It must not create a replacement operation merely because the HTTP response was lost.

## API stability

This is an internal product API, not a versioned public developer API. Request and response shapes may change with the web application. A future external API should use a versioned prefix, scoped credentials, rate limits, webhook signing, and a published OpenAPI contract.
