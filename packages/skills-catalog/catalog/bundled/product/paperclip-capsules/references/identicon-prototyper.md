# Identicon Prototyper

Use this reference when generating or reviewing deterministic Paperclip capsule identicons/profile pills. Prototype source paths, when the Paperclip content repository is available:

- `paperclip-content/design/PAP-11825/paperclip-capsule-identicon-prototyper/README.md`
- `paperclip-content/design/PAP-11825/paperclip-capsule-identicon-prototyper/src/identicon.ts`
- `paperclip-content/design/PAP-11825/paperclip-capsule-identicon-prototyper/src/App.tsx`

These are individual agent marks. They do not replace product UI status capsules or the canonical hero capsule bank.

## Determinism Contract

The renderer scopes deterministic output by:

```txt
normalized seed + variant + density + theme
```

Additional options such as color space, color scheme, motion, and manual angle affect the rendered SVG and must still be recorded for reproducibility.

Default app state:

- Seed: `paperclip capsule bank`
- Variant: `gradient-smooth`
- Size control: `48` in the UI; renderer often uses `512` for the primary preview and `256` for samples.
- Density: `56`
- Theme: `charcoal`
- Color space/scheme: `oklch` / `Golden`
- Angle: seeded auto angle unless manually set.
- Motion: on.

Geometry:

- SVG viewBox: `0 0 120 292`
- Capsule body: `x=18`, `y=16`, `w=84`, `h=248`, `rx=42`
- Output width is approximately `size * 0.43`; output height is `size`.
- Capsule SVG includes `data-capsule="individual"` and an agent-oriented aria label.

## Variants

Gradient variants use smooth color only, not dot or stripe patterns:

| Variant id | UI label | Use |
| --- | --- | --- |
| `gradient-smooth` | Smooth | Clean two-tone linear gradient. |
| `gradient-soft` | Sheen | Linear gradient plus a soft radial white highlight near the top. |
| `gradient-mesh` | Mesh | Base gradient plus overlapping seeded radial color blobs. |
| `gradient-aurora` | Aurora | Multi-stop diagonal ribbon using three hues plus a broad soft band. |

Dither variants quantize the gradient ramp and emit one SVG path per tone level:

| Variant id | UI label | Algorithm |
| --- | --- | --- |
| `dither-floyd` | Floyd | Floyd-Steinberg error diffusion; compact classic grain. |
| `dither-atkinson` | Atkinson | Atkinson error diffusion; crisp Mac-era contrast. |
| `dither-jjn` | JJN | Jarvis-Judice-Ninke wide-kernel diffusion; smoother photographic grain. |
| `dither-bayer4` | Bayer 4 | Ordered dithering with a 4x4 Bayer matrix. |
| `dither-bayer8` | Bayer 8 | Ordered dithering with a recursively built 8x8 Bayer matrix. |
| `dither-bluenoise` | Blue Noise | Hash-based void-and-cluster-style threshold mask; avoids visible grid structure. |

## Color Systems

Supported color spaces:

- `hsl`
- `oklch`

HSL color schemes:

- `Triadic`
- `Complement`
- `Analogous`
- `Mono`
- `Split`
- `Tetrad`

OKLCH color schemes:

- `Mono`
- `Triadic`
- `Golden`
- `Complement`
- `Analogous`
- `Split`
- `Tetrad`
- `Warm-Cool`
- `Vivid`
- `Pastel`
- `Cinema`
- `Sunset`
- `Earth`

Scheme behavior:

- HSL defaults to `Triadic`.
- OKLCH defaults to `Golden`.
- OKLCH `Pastel` lowers chroma and raises lightness.
- OKLCH `Earth` uses lower chroma.
- OKLCH `Vivid` uses higher chroma.
- OKLCH `Cinema`, `Sunset`, and `Earth` intentionally bias lightness/hue for more authored looks.
- Manual angle is `0..360`; auto angle is seeded and normally falls in a diagonal range.

## Density And Dither Behavior

UI density presets are `32`, `56`, and `80`, but the renderer accepts numeric density.

Dither tone levels:

- Density `< 45`: 2 tones
- Density `45..67`: 3 tones
- Density `>= 68`: 4 tones

Dither grid:

- Column count is clamped from roughly `size / 8`, with a minimum of `14` and maximum of `34`.
- Row count follows capsule height/cell width so the cells stay proportional.
- Error diffusion kernels:
  - Floyd-Steinberg divisor `16`
  - Atkinson divisor `8`
  - Jarvis-Judice-Ninke divisor `48`
- Ordered dithers shift the target ramp by threshold before rounding to the nearest tone.

Use lower density for bolder two-tone marks, mid density for readable profile icons, and high density for richer dither studies. Avoid using dither algorithms for product status indicators; those are a different capsule family.

## Recommended Combinations

The prototype's study sections provide known-good pairings:

- Smooth gradient + OKLCH `Golden`
- Soft sheen + OKLCH `Sunset`
- Mesh gradient + OKLCH `Vivid`
- Aurora gradient + OKLCH `Cinema`
- Gradient mix + HSL `Triadic`
- Floyd-Steinberg + OKLCH `Golden`
- Atkinson + OKLCH `Sunset`
- JJN + OKLCH `Earth`
- Bayer 4 or Bayer 8 + HSL `Complement`
- Blue noise + OKLCH `Vivid`
- Dither mix + OKLCH `Cinema`

Use these combinations first when a prompt asks for sophisticated capsule marks. Explore other schemes only when the request is explicitly exploratory.

## Themes, Motion, And Randomization

Themes:

- `charcoal`: dark brand lab setting with parchment ink.
- `paper`: white/paper setting with black ink.
- `ink`: near-black setting with white ink.

Motion:

- Motion adds a subtle vertical SVG `animateTransform` translate wave: `0 -3; 0 3; 0 -3` over `4s`, repeating indefinitely.
- Turn motion off for static exports, grid previews, and reduced-motion contexts.
- Keyboard `Space` replays motion in the prototype.

Randomize behavior:

- Randomizes style, color space/scheme, gradient angle, density, motion, and seed.
- Keeps Size and Theme stable.
- Seed words include `atlas`, `budget`, `capsule`, `delta`, `forge`, `governance`, `hermes`, `ledger`, `signal`, and `thread`.

## Export And Share

Supported actions:

- Copy SVG
- Download SVG
- Download PNG
- Copy data URI
- Copy React snippet
- Share standalone card URL
- Restore settings from URL hash

URL hash fields:

- `s`: seed
- `v`: variant id
- `z`: UI size
- `d`: density
- `t`: theme
- `c`: color space
- `p`: color scheme
- `a`: manual angle, omitted for seeded auto angle
- `m`: motion, `1` or `0`

When attaching an identicon artifact, record at least:

```md
Capsule identicon

- Seed:
- Variant id:
- Theme:
- Color space / scheme:
- Density:
- Size / output dimensions:
- Motion:
- Angle: seeded auto | <degrees>
- Export: SVG | PNG | data URI | React snippet | card URL
- Source: PAP-11825 identicon prototyper
```

## Smoke Checks

Before treating an identicon artifact as complete:

- Same seed and settings produce the same SVG.
- Changing the seed changes the SVG.
- All selected variant ids render nonblank SVG.
- SVG and PNG exports are non-empty and inspectable.
- Shared URL hash restores the intended seed, variant, density, theme, color space, color scheme, angle, and motion.
- Motion can be turned off for static/reduced-motion delivery.
