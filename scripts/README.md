# Verification and build scripts

This directory contains maintained, non-interactive checks and build helpers used by InboxPay.

- `*-check.mjs` files are deterministic regression checks invoked through `npm run test:*`.
- `compile-policy.mjs` compiles the policy contract artifact used by deployment code.

Scripts in this directory must not contain credentials, wallet IDs, private invoice data, one-off production actions, or hard-coded operator accounts. Financial operations belong in authenticated product flows, not ad hoc command-line helpers.
