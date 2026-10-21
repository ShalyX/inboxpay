# Landing media

The Correspondence landing keeps the product interface in the hero and uses real photographic media for business context below the workflow. The scene shows people doing their work, not a staged InboxPay transaction or a customer testimonial. The people shown must not be presented as users, endorsers, or evidence of traction.

| Local file | Source / creator | Role and treatment |
| --- | --- | --- |
| `public/media/studio-team.jpg` | [Pexels photo 9850411](https://www.pexels.com/photo/a-team-of-fashion-designer-working-inside-the-office-9850411/), Ron Lach | Working-studio context; 1400px CDN rendition; responsive CSS crop. |
| `public/media/studio-film-poster.jpg` | [Pexels video 9850681](https://www.pexels.com/video/people-working-at-a-fashion-studio-9850681/), Ron Lach | Still poster from the same source video; 800px CDN rendition and static playback fallback. |
| `public/media/studio-film.mp4` | Same Pexels video / Ron Lach | Entire source scene, resized to 540px wide, H.264 CRF 27, audio removed, fast-start MP4. No generated people, new narration, or fabricated product activity. |

Source pages and the [Pexels License](https://www.pexels.com/license/) were checked on 2026-10-21. These are third-party licensed assets, not Apache-2.0-owned InboxPay artwork. Retain creator attribution and this provenance record. The license permits website/commercial use but prohibits implying endorsement and redistribution as a stock-photo/video service; consult the linked terms for the full conditions.

The original UHD video stays outside the repository. Only the web rendition is included. Playback is manual, silent, inline, and `preload="none"`; there is no autoplay or unnecessary third-party player. The film pauses when offscreen or when the page is hidden. A static poster remains if playback fails. The photo loads lazily with intrinsic dimensions; its fallback keeps the space and message intact. Text is outside the images for stable contrast.

Before release, inspect the actual crop and playback at desktop and narrow widths. This media pass does not change Gmail access, auth, wallets, payment decisions, or settlement configuration. A real product recording is a separate asset and must use appropriate consent/redaction; do not use the illustrative studio scene as product proof.
