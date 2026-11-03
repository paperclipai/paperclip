# Motion spec - the V1 MVP hover motion every lab carries over

Single source for the hover motion a directions lab ships: curve, timing, what moves, what fades, how it
is gated, and the hooks a component must carry. Worked example: the artifact lab (`ui/src/artifact-directions/`)
and its product port (`ui/src/components/artifacts/v1/`, `ui/src/index.css`). Line numbers were opened and
confirmed on branch `claude/directions-lab-skill` on 2026-10-24. Short paths (`tokens.css`, `Stack.tsx`,
`Tile.tsx`, `Front.tsx`, `MediaPrint.tsx`, `PanelRow.tsx`) are under `ui/src/artifact-directions/directions/d5-v1-mvp/`;
`Artifact*.tsx` and `geometry.ts` are under `ui/src/components/artifacts/v1/`.

Legend: **GENERIC** = reuse for any feature, verbatim. **ARTIFACT-SPECIFIC** = belongs to the
artifact lab; redraw per feature (targets, magnitudes, angles, colours).

## Contents

1. The one curve and its token names
2. What transitions (transform) and what fades (Tailwind `transition-colors`)
3. The movement: 6px rise, 5° fan, resting angles, transform-origin
4. Gating: lab double gate vs product single gate (paste-ready CSS)
5. Hover fills: tile, pill, row per theme
6. What does not animate
7. Hooks a component must carry, and the bare-print lesson
8. Lab plumbing for the Animation toggle
9. `ui/src/motion-tokens.css` and how the lab curve relates
10. Operational notes: the board and `shot.cjs` never show motion
11. Checklist for a new direction's `tokens.css`

## 1. The one curve and its token names

**GENERIC.** One curve for every hover movement: `300ms cubic-bezier(0.3, 0, 0.1, 1)`. Brisk start,
long settle (more ease-out than ease-in). Never add a second curve or duration for movement.

| Form | Token | Declared at |
| --- | --- | --- |
| Lab | `--v1-hover-ease` | `tokens.css:80-82`, in a second `[data-direction="d5-v1-mvp"]` block |
| Product | `--artifact-hover-ease` | `ui/src/index.css:531`, in `:root`; not re-declared in `.dark` |

Name it `--<p>-hover-ease` in a lab (`<p>` = the direction's token prefix) and
`--<feature>-hover-ease` in product.

## 2. What transitions and what fades

**GENERIC.** Two timings on one hover, by design:

- Movement: exactly `transition: transform var(--…-hover-ease);` on the fanning backings and the
  front (`tokens.css:85-87`; `index.css:4812-4814`). Nothing else (`filter`, `box-shadow`,
  `opacity`, `scale`) transitions with this curve.
- Colour: Tailwind `transition-colors` in the markup, never in the token CSS (`Tile.tsx:30,53`;
  `PanelRow.tsx:91`; product `ArtifactTile.tsx:27,45`, `ArtifactRow.tsx:93`). Tailwind 4.3.3
  (`ui/node_modules/tailwindcss` -> `.pnpm/tailwindcss@4.3.3`) sets `transition-property: color,
  background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from,
  --tw-gradient-via, --tw-gradient-to` at the theme defaults `--default-transition-duration: 150ms;
  --default-transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1)`
  (`ui/node_modules/tailwindcss/theme.css:492-493`). Nothing under `ui/src` overrides them.

Colour fades are never gated (not on the lab toggle, not on reduced motion). A scaffold that moves
everything into CSS must add `transition-colors` (or an explicit `background-color` transition) to
the tile, pill and row, or the fills snap.

## 3. The movement

**ARTIFACT-SPECIFIC magnitudes, GENERIC pattern.**

### 3.1 The 6px rise

While the tile is hovered the artwork root `[data-front]` gets `transform: translateY(-6px)`
(`tokens.css:88-90`; product `[data-artifact-front]`, `index.css:4815-4817`). There is no rest rule
for the front: rest is the identity transform. The front only translates, so its `transform-origin`
is irrelevant.

### 3.2 The 5° fan of the two backing pages

Each backing carries `data-rotate` (rest) and `data-spread="left"|"right"` (hover side). The rest
rule is ungated: `[data-direction="d5-v1-mvp"] [data-rotate] { transform: rotate(var(--v1-base, 0deg)); }`
(`tokens.css:68-70`, under the comment at 67; product `[data-artifact-rotate]`, `index.css:4808-4810`). On hover: left
`rotate(calc(var(--v1-base, 0deg) + 5deg))`, right `rotate(calc(var(--v1-base, 0deg) - 5deg))`
(`tokens.css:91-96`; `index.css:4818-4823`). The `0deg` fallback means an element with `data-rotate`
but no inline base rests flat and still turns 5°.

State the directions as the code does: **left page +5deg, right page −5deg** (`Stack.tsx:36`). CSS positive
rotate is clockwise, so `tokens.css:76-77` reads "the left page clockwise and the right page counter-clockwise".
Do not describe this as the pages fanning "apart": a left page turning clockwise about its centre moves its top
edge right and its bottom edge left; a right page turning counter-clockwise moves its top edge left and its
bottom edge right, so the tops converge and the bottoms diverge. The media right page crosses upright (4° -> −1°).

### 3.3 Resting angles (lab `Stack.tsx`, product `geometry.ts`)

| Backing | Element | Rest | `spread` | Hover | Source |
| --- | --- | --- | --- | --- | --- |
| Sheet (text, documents) | `backing-short.svg` img, file 240.409×247.814 | −14° | left | −9° | `Stack.tsx:58-61`; `geometry.ts:53` |
| Sheet | plain landscape div 239.509×179.632, 12px radius | −5° | right | −10° | `Stack.tsx:63, 102-117`; `geometry.ts:56` |
| Media (image, video, audio) | `backing-tall-a.svg` img, 240.409×276.151, painted first (behind), centre y +2 | 4° | right | −1° | `Stack.tsx:69-71`; `geometry.ts:61` |
| Media | `backing-tall-b.svg` img, painted second | −7.64° | left | −2.64° | `Stack.tsx:72`; `geometry.ts:62` |

Sheet composition 254.253×241.044, front at left 37.13, top 25.04 (`Stack.tsx:98, 118`; `geometry.ts:51, 57`).
Media composition `max(55.73 + 195.048, left + print width)` × 240.337, front anchored by `MEDIA_ANCHOR`
(`Stack.tsx:74-79, 87-89`). The angle reaches CSS as an inline custom property per element, cast
`as CSSProperties`: `` "--v1-base": `${rotate}deg` `` (`Stack.tsx:50, 115`; product `ArtifactStack.tsx:33, 85`).

### 3.4 transform-origin rule

**GENERIC** for any rotated padded asset. Rotate about the visible shape's own centre
(`Stack.tsx:41-51`; product `ArtifactStack.tsx:25-34`, filter moved to `.artifact-backing`,
`index.css:4797-4799`):

```tsx
const originX = sheet.left + sheet.width / 2;
const originY = sheet.top + sheet.height / 2;
const style = {
  left: centre.x - originX,
  top: centre.y - originY,
  width,
  height,
  transformOrigin: `${originX}px ${originY}px`,
  filter: "var(--v1-shadow-sheet)",
  "--v1-base": `${rotate}deg`,
} as CSSProperties;
```

Short sheet origin (120.2045, 120.507); tall sheet origin (120.2045, 134.6755). Measure `sheet.top`
from the file: the sheets sit 30px from the left and right edges but 26.6px from the top and 33.4px
from the bottom (`Stack.tsx:58, 69`), the shadow's 3.406px y-offset. The comment at `Stack.tsx:17-18`
("30px larger than the sheet on every side") is inexact; deriving the origin from it puts it 3.4px
low. The landscape div sets no origin: it is sized to the sheet, so the default `50% 50%` is its
centre (`Stack.tsx:102-117`).

## 4. Gating

**GENERIC.** Keep three rule groups apart:

1. Rest rules (`[data-rotate]` angle) and every colour rule: outside both gates.
2. The `transition: transform` rule: inside the reduced-motion query, beside the hover transforms
   (hygiene: under `reduce` nothing changes `transform`, so an ungated transition has nothing to animate).
3. The hover transforms: inside the query and, in the lab, behind the Animation toggle.

Movement is `:hover` only. Fills and the pill step also fire on `:focus-visible` (`tokens.css:104`;
`index.css:4805`), so keyboard focus colours but never moves. By design in both forms.

### 4.1 Lab form: double gate (`html[data-lab-anim="1"]` AND reduced motion)

Paste into `ui/src/<lab>/directions/<id>/tokens.css`; replace `<id>` and `<p>`; keep the curve, the
gates, `-6px` and `±5deg` verbatim. Source: `tokens.css:68-97`; 67 is the comment above the block.

```css
[data-direction="<id>"] [data-rotate] {
  transform: rotate(var(--<p>-base, 0deg));
}

[data-direction="<id>"] {
  --<p>-hover-ease: 300ms cubic-bezier(0.3, 0, 0.1, 1);
}
@media (prefers-reduced-motion: no-preference) {
  html[data-lab-anim="1"] [data-direction="<id>"] :is([data-rotate][data-spread], [data-front]) {
    transition: transform var(--<p>-hover-ease);
  }
  html[data-lab-anim="1"] [data-direction="<id>"] button:hover [data-front] {
    transform: translateY(-6px);
  }
  html[data-lab-anim="1"] [data-direction="<id>"] button:hover [data-spread="left"] {
    transform: rotate(calc(var(--<p>-base, 0deg) + 5deg));
  }
  html[data-lab-anim="1"] [data-direction="<id>"] button:hover [data-spread="right"] {
    transform: rotate(calc(var(--<p>-base, 0deg) - 5deg));
  }
}
```

`button:hover` assumes the lab tile is a `<button>` (`Tile.tsx:49-54`). If a lab's tiles are anchors,
key on a class instead, as product does. Only `d5-v1-mvp/tokens.css` has rules keyed on `data-lab-anim`
(repo grep; `main.tsx:36` and `lab-state.ts:15` name it only in comments); a direction that wants the
toolbar toggle to do anything must prefix its movement rules this way, or the toggle is a no-op for it.

### 4.2 Product form: single gate (reduced motion only)

Paste into `ui/src/index.css` after the feature's component rules; replace `<feature>`. Source:
`index.css:4808-4824` (the file's last block).

```css
[data-<feature>-rotate] {
  transform: rotate(var(--<feature>-base, 0deg));
}
@media (prefers-reduced-motion: no-preference) {
  .<feature>-tile :is([data-<feature>-rotate][data-<feature>-spread], [data-<feature>-front]) {
    transition: transform var(--<feature>-hover-ease);
  }
  .<feature>-tile:hover [data-<feature>-front] {
    transform: translateY(-6px);
  }
  .<feature>-tile:hover [data-<feature>-spread="left"] {
    transform: rotate(calc(var(--<feature>-base, 0deg) + 5deg));
  }
  .<feature>-tile:hover [data-<feature>-spread="right"] {
    transform: rotate(calc(var(--<feature>-base, 0deg) - 5deg));
  }
}
```

Product drops the lab gate and keys on the class `artifact-tile`, which sits on a `<Link>` or a
`<button>` (`ArtifactTile.tsx:44-45` TILE; `59-61` Link; `63-65` button). The product contract is
written at `doc/plans/2026-10-22-artifacts-mvp-v1.md:37-38`.

### 4.3 Theme scoping (both forms)

Lab: dark values are the base inside `[data-direction="d5-v1-mvp"] { … }` (`tokens.css:5-52`); light overrides
live under `html:not(.dark) [data-direction="d5-v1-mvp"]` (`tokens.css:56-65`), which matches only because the
lab toggles `dark` on `document.documentElement` (`main.tsx:30-34`); the kit contract also allows
`.dark [data-direction="<id>"]` (`ui/src/artifact-directions/kit.ts:11-13`). Product inverts it: light in `:root`
(`index.css:495-531`), dark in `.dark` (`index.css:591-600`, right after `--background`/`--foreground`). Copying
a block between forms without flipping swaps every fill; keep the dark/light value pairs identical.

## 5. Hover fills

**ARTIFACT-SPECIFIC values, GENERIC shape** (rest token + hover token per surface, applied through
Tailwind arbitrary-variable utilities that resolve only under the `[data-direction]` wrapper).

| Surface | Theme | Rest | Hover | Lab | Product |
| --- | --- | --- | --- | --- | --- |
| Tile (370px cell, 12px radius) | dark | transparent | `#202020` (mock, on the `#171717` canvas) | `tokens.css:38-41` | `index.css:516-519, 596` |
| Tile | light | transparent | `var(--accent)` | `tokens.css:60` | `index.css:519` |
| Pill | dark | `#333333` | `#333333` (unchanged) | `tokens.css:16-18` | `index.css:597-598` |
| Pill | light | `var(--muted)` | `var(--border)` | `tokens.css:61-62` | `index.css:520-522` |
| Panel row (6.4px radius, 12px gap) | dark | `#262626` | `#2c2c2c` | `tokens.css:46-49` | `index.css:599-600` |
| Panel row | light | `var(--muted)` | `#eeeeee` | `tokens.css:63-64` | `index.css:523-526` |

Markup: tile `rounded-(--v1-tile-radius) … transition-colors hover:bg-(--v1-tile-hover)
focus-visible:bg-(--v1-tile-hover)` (`Tile.tsx:53`); pill `<span data-pill className="v1-pill rounded-full px-3
py-1 text-xs font-normal leading-4 transition-colors">` (`Tile.tsx:30`), fills from `tokens.css:99-106`; row
`rounded-(--v1-row-radius) bg-(--v1-row) … transition-colors hover:bg-(--v1-row-hover)` (`PanelRow.tsx:91`).
Product: `ArtifactTile.tsx:27, 45`; `index.css:4800-4807`; `ArtifactRow.tsx:93` (fill on an outer
`<div data-artifact-row>`, `:177`; focus ring on the inner control, `:94`).

Why light needs an explicit pill step: the light tile hover fill `--accent` has `--muted`'s value, so
a `--muted` pill would vanish into the hovered tile; `--v1-pill-hover: var(--border)` is one token
shade under it (`tokens.css:62`; `index.css:521`). Dark keeps the pill unchanged. If a new feature's
hover fill differs from the pill's rest colour, drop the step. The row hover step is not in the mock
(`tokens.css:43-47`); light `#eeeeee` is one step under `#f5f5f5` as dark steps `#262626` up to
`#2c2c2c` (`tokens.css:64`).

## 6. What does not animate

**GENERIC rule, ARTIFACT-SPECIFIC values.**

- Shadows: static `filter: var(--v1-shadow-sheet)` on `.v1-sheet` (`tokens.css:116-121`) and inline on
  backing imgs (`Stack.tsx:49`); static `box-shadow: var(--v1-shadow-print)` on `.v1-print` (`tokens.css:108-114`)
  and, with the inset stroke prepended, on the landscape div (`Stack.tsx:114`). No transition, no hover rule;
  they ride with the transformed element. Dark alpha 0.18, light 0.0924 (`tokens.css:24-25, 58-59`;
  `index.css:507-508, 594-595`). Porting: box-shadow blur 20px = drop-shadow blur 10px = SVG stdDeviation 10.
- Stroke: the 1px inner hairline is a `::after` overlay on sheets (`tokens.css:123-131`;
  `index.css:4782-4789`) and is baked into the three backing SVGs (`stroke="#1A1A1A"
  stroke-opacity="0.1" stroke-width="2"` under a clip path; none contains a `<filter>`). The
  `tokens.css:22-23` comment about a baked-in filter is stale.
- Scale and opacity: nothing scales or fades on hover in either form. Nothing moves on `:focus-visible`.

## 7. Hooks a component must carry

**GENERIC names-with-prefix, ARTIFACT-SPECIFIC placement.**

| Role | Lab | Product |
| --- | --- | --- |
| Hover trigger | `<button>` (`Tile.tsx:49-54`) | class `artifact-tile` on Link or button (`ArtifactTile.tsx:44-45, 59, 63`) |
| Artwork root (rises) | `data-front` on the wrapper div (`Front.tsx:17, 25, 31`); the media print carries it itself via `data-front={front ? "" : undefined}` (`MediaPrint.tsx:41`, signature `:38`) | `data-artifact-front` on the wrapper div (`ArtifactFront.tsx:26, 34, 40`) |
| Backing (rests, fans) | `data-rotate data-spread={spread}` on the img (`Stack.tsx:52`) and the landscape div (`Stack.tsx:103-104`) | `data-artifact-rotate data-artifact-spread={spread}` plus class `artifact-backing` (`ArtifactStack.tsx:37-38, 44`) |
| Resting angle | inline `--v1-base` (`Stack.tsx:50, 115`) | inline `--artifact-base` (`ArtifactStack.tsx:33, 85`) |
| Pill | `data-pill` + class `v1-pill` (`Tile.tsx:30`) | `data-artifact-pill` + class `artifact-pill` (`ArtifactTile.tsx:27`) |

The bare-print lesson: a print rendered without the front hook stands still while the backings
turn. In this checkout and on `master`, `ArtifactFront.tsx:30-31` returns a bare `<ArtifactPrint …>`
for the media treatment, so a picture or poster-less video front does not rise. Commit `95fb3e219`
on branch `claude/artifacts-v1-picture-front-rise` wraps it in `<div data-artifact-front
className="shrink-0" style={style}>` and adds the test "gives a single picture the same hover-lift
hook as a sheet". Put the hook on every treatment branch and assert it: here
`ArtifactTile.test.tsx:50` checks `querySelectorAll("[data-artifact-spread]")` has length 2 and `:97`
that `[data-artifact-front]` exists; on the fix branch, `[data-artifact-front]` contains the print.

Tailwind `h-(--v1-tile-h)`, `rounded-(--v1-tile-radius)`, `bg-(--v1-row)` resolve only under an ancestor
that defines them; outside `Slot.tsx` (`ui/src/artifact-directions/frames/Slot.tsx:8-14`) a kit collapses.

## 8. Lab plumbing for the Animation toggle

**GENERIC.** Lab-level, not direction-level. Copy unchanged; only the toolbar hint names the direction.

`ui/src/artifact-directions/main.tsx:36-41`, then `useEffect(() => applyAnim(state.anim), [state.anim]);`
at `:151`:

```tsx
function applyAnim(anim: boolean) {
  if (anim) document.documentElement.dataset.labAnim = "1";
  else delete document.documentElement.dataset.labAnim;
}
applyAnim(initial.anim);
```

Keyboard: bare `a` toggles (`main.tsx:157`), ignored with meta/ctrl/alt or while typing in
INPUT/TEXTAREA/SELECT/contentEditable (`main.tsx:52-54, 155`). URL state in
`ui/src/artifact-directions/lab-state.ts`: default on, read as `anim: params.get("anim") !== "0",`
(`:45`); written only when off, `if (!state.anim) params.set("anim", "0");` (`:52`).

Toolbar (`ui/src/artifact-directions/frames/LabToolbar.tsx:68-71`): `ANIM_OPTIONS` Segmented `off`/`on`,
hints "Hover animations off (toggle with a)" / "Hover animations on: MVP V1 artwork rises, stack pages
turn (toggle with a)"; rendered at `:91-94` with an inline `<span>animation</span>` label to the LEFT of
the Segmented, in the right-aligned `ml-auto flex items-center gap-4` group with Theme (`:89`); legend
"0–5 kit · t theme · a animation" (`:100`). The entry `ui/artifact-directions.html:2` is `<html lang="en"
class="dark" style="color-scheme: dark">` with no `data-lab-anim`; the attribute exists only after `main.tsx:41`.

## 9. `ui/src/motion-tokens.css` and the lab curve

`ui/src/motion-tokens.css` (imported at `index.css:1`) defines `--motion-ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1)`,
`--motion-ease-standard: cubic-bezier(0.4, 0, 0.2, 1)`, `--motion-duration-instant: 80ms`,
`--motion-duration-fast: 160ms` (`:4-7`); the rest are `--onboarding-motion-*`. None equals the hover curve.
`--motion-ease-standard` is Tailwind's default and so is the colour-fade curve; `0.3, 0, 0.1, 1` starts brisker
and settles longer than it, and is gentler than out-expo. No `--motion-duration-*` token is 300ms (only onboarding's
`--onboarding-motion-card-enter`, `:17`). The artifact port kept
`--artifact-hover-ease` in `index.css:531` beside its feature tokens and added nothing to `motion-tokens.css`.
A new feature either does the same or promotes the curve to a named motion token; decide once and record it.

## 10. Operational notes

**GENERIC.** Neither capture path shows the motion; verify hover by hand.

- The overview board (`ui/src/artifact-directions/frames/Board.tsx`) renders every tile as this same page in a
  same-origin `<iframe src={labSearch({ direction, view, theme, chrome: false, anim })}>` (`:54, 64-72`) at
  `FRAME_WIDTH = 1440`, `FRAME_MIN_HEIGHT = 900` (`:12-13`) scaled down, with `pointer-events-none` on the
  iframe (`:70`): a pointer never reaches a tile's `button:hover`. `anim` reaches each iframe only through the
  URL param, which that document's own `main.tsx:27, 41` applies to its own `<html>`; keep it in `labSearch`.
- `ui/src/artifact-directions/shot.cjs:121-125` captures with `browser.newContext({ viewport: { width:
  1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" })`, so the `no-preference` block
  does not exist in a capture, and nothing hovers anyway (`lab-state.ts:13-15`). Captures show the
  rest state in every kit.
- To verify: open a single surface, e.g. `?d=d5-v1-mvp&s=gallery&theme=dark` (Animation defaults on),
  confirm `document.documentElement.dataset.labAnim === "1"`, hover a tile and watch the rise and fan;
  press `a`: the fill still steps, nothing moves. Same under the OS reduced-motion preference.

## 11. Checklist for a new direction's `tokens.css`

- [ ] Declares `--<p>-hover-ease: 300ms cubic-bezier(0.3, 0, 0.1, 1)` under `[data-direction="<id>"]`; no other curve.
- [ ] `transition: transform var(--<p>-hover-ease)` is the file's only transition; target `:is([data-rotate][data-spread], [data-front])`.
- [ ] Rest rule `[data-rotate] { transform: rotate(var(--<p>-base, 0deg)); }` sits outside both gates.
- [ ] Transition rule and the three hover transforms sit inside `@media (prefers-reduced-motion:
      no-preference)`, each prefixed `html[data-lab-anim="1"] [data-direction="<id>"]`.
- [ ] Front rises `translateY(-6px)`; left page `+ 5deg`; right page `- 5deg`, in `calc()` on the inline base.
- [ ] Hover selectors key on the real trigger element (`button:hover`, or a class when tiles are
      anchors); movement is `:hover` only; fills and the pill step use `:is(:hover, :focus-visible)`.
- [ ] Every colour change rides Tailwind `transition-colors` in the markup, outside both gates.
- [ ] Rest and hover tokens for tile, pill and row in both themes; a pill step only where the hover fill equals the pill's rest.
- [ ] Shadows and strokes are static tokens with no transition and no hover rule; no scale or opacity change.
- [ ] Light values sit in the base `[data-direction="<id>"]` block and dark overrides under
      `.dark [data-direction="<id>"]` (the `index.css` idiom; d5's `html:not(.dark)` form is the copy
      hazard in 4.3); dark/light pairs match the product form's `:root`/`.dark` pairs exactly.
- [ ] Components carry `data-front`, `data-rotate`, `data-spread`, inline `--<p>-base` and a
      geometry-derived `transform-origin`; every front treatment branch carries `data-front`, with a
      test that asserts it.
- [ ] Verified by hovering in a single-surface view with Animation on, not from the board or a `shot.cjs` capture.
