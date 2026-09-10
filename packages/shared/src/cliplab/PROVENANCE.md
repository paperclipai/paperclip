# ClipLab cap-v1

Source: https://github.com/tonio-alucema/cliplab
Commit: a050f7246738db1d0763e286862747633293e2af
License: MIT (see LICENSE). Three.js is MIT licensed.

Paperclip adaptations: ESM extensions, optional graphics backend for Node SVG
snapshots, region-scoped runtime input (with explicit page scope for onboarding),
suspended frame scheduling, and supersampled live textures/canvases. Live-only
framing leaves the versioned static snapshot geometry unchanged. The Vue
studio and media encoders are not included. Keep this version immutable after
release; new artwork or rasterization changes require a new character version.

Palette source: https://cliptoon-color-library.vercel.app/
The 17 assignable colors and Muted dream are frozen as cap-v1 tokens in
ui/src/index.css. Generated palette data is checked by
scripts/sync-agent-palette-tokens.mjs --check.
