# MCP connector brand assets

Retrieved 2026-09-21 from the providers’ own sites for the independent connector
design review. Brand-library membership does not publish a catalog connector.
The four connectors are available for setup by default. No experimental flag is required.
Zapier and Composio reuse the existing reviewed local marks.

| File | Source | SHA-256 |
| --- | --- | --- |
| `ui/public/brands/apps/arcade.png` | [Arcade site touch icon](https://www.arcade.dev/_astro/webclip.BYnZsC5R.png), linked from [arcade.dev](https://www.arcade.dev/) | `5b3704e210b6dc70fffab260d5416624f37db19108399a6d2c18c848d33465ad` |
| `ui/public/brands/apps/executor.png` | [Executor site icon](https://executor.sh/favicon-192.png), linked from [executor.sh](https://executor.sh/) | `e5fd761a0cd80d51d451cc06e9e6d0236dcc39317248a13ac5db5fcf4d52d0ca` |
| `ui/public/brands/apps/telem.svg` | [Telem.AI mark](https://telem.ai/logos/telem-icon.svg), published on [telem.ai](https://telem.ai/) (retrieved 2026-10-06) | `c65ebca449f1c5ceef874ac912ea43c919315f465304a2f9e63f5d04ac0d769d` |
| `ui/public/brands/apps/telem-dark.svg` | [Telem.AI dark mark](https://telem.ai/logos/telem-icon-dark.svg), published on [telem.ai](https://telem.ai/) (retrieved 2026-10-06) | `a2735231c47371c9247ffb9168ab0c2e684403d7c4d94a6ba9f48a71bbd14145` |
| `ui/public/brands/apps/keenable.svg` | Keenable brand kit symbol (`symbol-color-primary.svg`), supplied by Keenable, the brand owner (2026-10-22). The MCP host publishes the same artwork at [api.keenable.ai/favicon.svg](https://api.keenable.ai/favicon.svg); that file differs only by the final newline. | `30e694688d505cce69fa5c3456049be6ad68209f21271c81be07ac0f07c30297` |

Both files preserve provider artwork without recoloring. Both Telem.AI files are byte-identical to the published files: `telem-dark.svg` is Telem.AI's own published dark variant, not a recolor. The shared AppLogo
provides the standard gray frame and contained padding. Arcade’s SVG favicon
wrapped embedded raster content; the 180px touch icon linked by the same official
page was used to satisfy the repository’s artwork safety checks.
