# Individual and Status Capsules

Use this reference for product UI, onboarding, org surfaces, and heartbeat status indicators.

## Source Precedence

1. `ui/src/components/AgentCapsule.tsx` - React API, states, sizes, accessibility, gradient wrapping.
2. `ui/src/index.css` - animation timings, reduced-motion behavior, agent gradient token values.
3. `ui/src/lib/status-colors.ts` - heartbeat status color/motion mapping.
4. `ui/src/components/OnboardingWizard.tsx` and `ui/src/pages/DesignGuide.tsx` - accepted usage examples.
5. Website brand guide files under `paperclip-website/src/components/brand/sections/*` - marketing rules and the 12-preset website palette.

## Individual Agent Capsule

One tall capsule represents one agent. Do not use this component for decoration or generic status chips.

States:

| State | Meaning | Rendering |
| --- | --- | --- |
| `slot` | Empty agent slot | Dashed outline, gentle pulse |
| `configured` | Agent named/model picked, not live | Solid stroke, no fill |
| `online` | Agent online | Gradient liquid rise, then breathing pulse |

Implementation rules:

- Keep the same DOM node through lifecycle flows when the story is "this agent comes to life".
- Use stacked layers with opacity transitions for dashed-to-solid; CSS cannot animate `border-style`.
- Online default pulse is green. The blue pulse is a specific onboarding wizard variant, not the default app-wide live state.
- Product sizes are `sm` 24x60, `md` 34x84, `lg` 46x116. Custom sizes should keep height at least twice width.
- The capsule radius is full stadium/pill radius.
- Accessibility label should describe the represented agent or state.

Motion:

| Motion | Timing |
| --- | --- |
| Slot pulse | `1.6s ease-in-out infinite` |
| Liquid rise | `1.4s cubic-bezier(0.16, 1, 0.3, 1) forwards` |
| Online pulse | `1.8s ease-in-out infinite` |
| Layer transition | `opacity 0.5s ease` |

Reduced motion:

- Remove slot pulse and online pulse.
- Remove layer transition.
- Render the online liquid at full height without rise animation.

## App Agent Gradient Tokens

The app component currently exposes 10 gradient pairs. `AgentCapsule` wraps out-of-range gradient indexes back into `1..10`.

| Index | Top token | Top | Bottom token | Bottom |
| --- | --- | --- | --- | --- |
| 1 | `--agent-1a` | `#f7cfdc` | `--agent-1b` | `#1f7a3a` |
| 2 | `--agent-2a` | `#c9a9e8` | `--agent-2b` | `#ee79a1` |
| 3 | `--agent-3a` | `#28164b` | `--agent-3b` | `#7a1530` |
| 4 | `--agent-4a` | `#f3e6c4` | `--agent-4b` | `#e3a21a` |
| 5 | `--agent-5a` | `#1f4dd6` | `--agent-5b` | `#3aa35c` |
| 6 | `--agent-6a` | `#e94b27` | `--agent-6b` | `#5a1122` |
| 7 | `--agent-7a` | `#7eb6e3` | `--agent-7b` | `#ee79a1` |
| 8 | `--agent-8a` | `#9ce8a7` | `--agent-8b` | `#bd7ff0` |
| 9 | `--agent-9a` | `#f3b49e` | `--agent-9b` | `#1f4ed4` |
| 10 | `--agent-10a` | `#f2d95f` | `--agent-10b` | `#4fbcba` |

Do not treat these as the universal Paperclip capsule palette. The website brand guide exposes 12 presets, the video references have a separate 12-gradient palette, and the hero bank has 45 gradients.

## Website Marketing Capsule Palette

The website palette extends the app's first 10 gradients with two more presets:

| Index | Top | Bottom | Description |
| --- | --- | --- | --- |
| 11 | `#C2C2E8` | `#5E3450` | peri -> mauve |
| 12 | `#4DB9B7` | `#3AA35C` | teal -> green |

Marketing capsule rules:

- Capsule visuals are reserved for agent representation: capsule fields, org-chart nodes, status indicators, avatars.
- Never use capsules on chrome, buttons, or generic pills.
- Use a `1 : >= 2` proportion and a top-to-bottom gradient for gradient capsules.
- Flat single-color capsules are allowed only where a solid mark is needed.
- The guide names a semantic `--r-capsule`, but current `brand.css` does not export a concrete `--r-capsule` variable. Do not cite it as a live CSS token without checking.

## Heartbeat Status Capsule

Heartbeat status capsules are small solid pills. They are a different surface from individual gradient capsules.

Status mapping:

| Agent status | Color | Fill | Motion |
| --- | --- | --- | --- |
| `idle` | gray | `#A8AEB2` light, `#6E6960` dark | none |
| `active` | gray | same as idle | none |
| `running` | blue | `#2563EB` | `hb-pulse` |
| `paused` | amber | `#F59E0B` | none |
| `error` | red | `#DC2626` | `hb-blink` |

Motion timings:

- `hb-pulse`: `1.6s ease-in-out infinite`
- `hb-blink`: `1.2s step-end infinite`
- Reduced motion removes both.

Website guide geometry for the heartbeat pill is 8x16 with radius 4. Larger brand-page display examples may use 14x28.

## Common Mistakes

- Using capsule gradients for generic badges or buttons.
- Using a full gradient agent capsule where a small status capsule is required.
- Treating the onboarding blue glow as the default online state.
- Merging the 10 app gradients, 12 website gradients, 12 video gradients, and 45 hero-bank gradients into one palette.
- Animating status or lifecycle motion without reduced-motion fallbacks.
