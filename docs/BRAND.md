# InboxPay brand assets

## Identity idea

InboxPay handles invoices and USDC payments from a business's Gmail. Lead with that job, not with the safeguards supporting it.

The current frontend direction is Correspondence: blue and white, a restrained lemon accent, Manrope typography, and a folded-letter mark. It pairs a familiar invoice inbox with a right-hand detail sheet. The founder selected the direction; the mark remains subject to final refinement and collision review. No trademark clearance is claimed.

`public/brand/inboxpay-mark.svg` and the favicon reflect this direction. The older lockup, monochrome, and social exports below are legacy assets and must not be described as the approved Correspondence brand kit or used for new material until regenerated. The app uses a text wordmark with the new mark rather than the legacy lockup.

## Asset inventory

| Asset | Use |
| --- | --- |
| `public/brand/correspondence-og.svg` and `.png` | Current product-first social preview; exact vector export. |
| `public/brand/correspondence-mark.png` | Current 512px mark export for review and application branding. |
| `public/brand/inboxpay-mark.svg` | Primary app icon on light or dark surrounding surfaces. |
| `public/brand/inboxpay-mark-mono.svg` | Single-color reproduction and documents. |
| `public/brand/inboxpay-lockup.svg` | Horizontal product lockup. |
| `public/brand/inboxpay-og.svg` | Editable 1200×630 social source. |
| `public/brand/inboxpay-og.png` | Open Graph and X sharing image. |
| `public/brand/inboxpay-x-avatar.png` | X profile avatar, exported at 800×800. |
| `public/brand/inboxpay-x-header.svg` | Editable X header source. |
| `public/brand/inboxpay-x-header.png` | X header, exported at 1500×500. |
| `public/favicon.svg` | Browser favicon. |

## Core colors

- Blue: `#194CD9`
- Lemon: `#DFEF9A`
- Ink: `#182A49`
- Paper: `#FFFFFF`
- Canvas: `#F8F9FC`
- Muted text: `#607089`

Blue marks navigation and primary actions. Lemon adds warmth to selected storytelling and setup surfaces. Green and amber convey status with explicit text; brand color never implies a payment passed its checks. Manrope is self-hosted with its OFL license in `public/brand/fonts/`.

## Usage

Regenerate current PNG exports with `node scripts/development/export-correspondence-assets.mjs`. The older `inboxpay-og` and X assets are retained as legacy files, not automatically changed on external profiles.

- Preserve the clear space of at least one quarter of the mark's width.
- Do not redraw the mark as a wallet, coin, lock, or shield.
- Do not add glow, gradients, or blockchain decoration.
- Keep the blue mark legible on white or a sufficiently light surface.
- Use the monochrome mark where color reproduction is unreliable.
- Payment, confirmation, and blocked states must remain explicit in text; brand color is never the only status signal.
