# Design System — ValAdrien OS

> System name: **GLASSHOUSE**. Source of truth for every visual and UI decision in
> `ui/`. Read this before touching styles, tokens, or components. Do not deviate
> without explicit owner approval. Created by `/design-consultation`, 2026-06-04.

---

## Product Context
- **What this is:** A single-instance, multi-tenant control plane for running
  autonomous AI companies. Operators watch AI agents (a CEO agent, an engineer
  agent, etc.) actually run a business — take tasks, execute, post updates, spend
  money, hit blockers.
- **Who it's for:** The operator/founder of an AI-run company; and prospects of
  ValAdrien.DEV, who are shown the OS as live proof that "AI runs the business."
  The UI is a **credibility artifact** — it must look serious, premium, trustworthy.
- **Space:** Agent control planes / ops dashboards. Peers in spirit: Bloomberg
  terminal, Linear, Retool, mission-control software.
- **Project type:** Dark, data-dense web app (control room), React 19 + Vite +
  Tailwind v4 (CSS `@theme`) + shadcn/ui.

## The one memorable thing (every decision serves this)
**"AI actually runs this business, and you can watch it happen live."**
Live agent activity — heartbeats, run streams, status transitions, cost ticking —
is the hero, not a static dashboard. The governing law: **motion is bound 1:1 to a
real control-plane event.** Nothing animates decoratively. If the screen moves, the
company moved. That binding is what makes it *proof*, not theater.

---

## Aesthetic Direction
- **Direction:** Dark-first **instrument minimalism** — a calm, near-black
  institutional control room where static UI recedes to almost nothing and the only
  thing that earns light is a live signal.
- **Decoration level:** Minimal. Light is the entire design budget. Idle = grey;
  alive = glows. **Color is proof of life.**
- **Mood:** Calm, premium, faintly eerie, undeniably alive. A fund's trading floor
  with the quiet of an observatory at night. The operator feels the work is getting
  done without them.
- **Theme posture:** **Dark is canonical.** Light is a supported secondary theme,
  not co-equal (control rooms are dark — status colors pop, eyes don't fatigue).
- **Reference feel:** Bloomberg terminal × Linear, observing a living organism.

---

## Typography
Three voices, each doing exactly one job. The pairing — *literary serif over Swiss
grotesque over terminal mono* — is the typographic signature: "a terminal owned by
someone who reads." All three are free and Google/Bunny-served; licensed upgrades noted.

- **Display / masthead / entity names:** **Newsreader** (high-contrast literary
  serif). Rationed to large headings, the company masthead, and agent/entity names.
  Upgrade path: GT Sectra Fine. — *Why: nobody in AI-dashboard land uses a serif;
  it reads like a fund's quarterly letter. Instant differentiation + gravitas.*
- **UI / body / labels:** **Hanken Grotesk** (warm Swiss grotesque). Buttons, nav,
  tables, prose, metadata. Upgrade path: Söhne. — *Why: the grown-up alternative to
  Inter without the startup-template fingerprint.*
- **Data / cost tape / logs / IDs:** **JetBrains Mono**, `font-variant-numeric:
  tabular-nums` always on. Upgrade path: Berkeley Mono / Commit Mono. — *Why:
  ticking numbers must never reflow; the tape effect dies if digits jitter.*

**Never use** Inter, Roboto, system-ui/-apple-system, or Space Grotesk anywhere.

**Loading:** Google Fonts —
`Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400`,
`Hanken+Grotesk:wght@400;500;600;700`, `JetBrains+Mono:wght@400;500;700`.
Self-host for production if the font CDN is a latency/privacy concern.

**Type scale (rem):**
| Role | Font | Size | Weight | Notes |
|---|---|---|---|---|
| Masthead | Newsreader | 2.5rem / 40px | 500 | company name; `letter-spacing:-0.01em` |
| Display | Newsreader | 2.125rem / 34px | 500 | hero headings |
| Entity name | Newsreader | 1rem / 16px | 500 | agent/issue/project names |
| Mast status | Newsreader italic | 1rem / 16px | 400 | the live status line |
| Body | Hanken Grotesk | 0.875rem / 14px | 400 | default UI text |
| Small | Hanken Grotesk | 0.8125rem / 13px | 400 | task lines, secondary |
| Eyebrow / label | JetBrains Mono | 0.6875rem / 11px | 500 | UPPERCASE, `letter-spacing:0.18em` |
| Data / mono | JetBrains Mono | 0.8125–0.875rem | 400/500 | tabular-nums |
| Run stream / log | JetBrains Mono | 0.72rem / 11.5px | 400 | dense terminal lines |

---

## Color
All values OKLCH. **Color = state, never decoration.** A hue on screen means a
machine is in that state. Idle agents recede into grey. The accent is rationed to
~3% of any screen.

### Dark theme (canonical)
| Token | OKLCH | ~Hex | Use |
|---|---|---|---|
| `canvas` (`--background`) | `oklch(0.16 0.004 250)` | `#0A0B0D` | app background |
| `surface` (`--card`,`--popover`) | `oklch(0.19 0.005 250)` | `#101216` | cards, panels, rows on hover |
| `raised` | `oklch(0.23 0.006 250)` | `#16191E` | raised/hover, secondary fills |
| `hairline` (`--border`,`--input`) | `oklch(0.27 0.006 250)` | `#1E2228` | 1px structural borders |
| `bone` (`--foreground`) | `oklch(0.92 0.006 75)` | `#E8E6E1` | primary text (warm, not pure white) |
| `muted` (`--muted-foreground`) | `oklch(0.66 0.006 75)` | `#9A9893` | secondary text |
| `faint` | `oklch(0.48 0.006 250)` | `#5C5F66` | tertiary text, timestamps |

### Signature accent — "Sodium"
| Token | OKLCH | ~Hex | Use |
|---|---|---|---|
| `sodium` (`--primary`,`--ring`) | `oklch(0.76 0.14 65)` | `#F0A23C` | brand mark, active selection, primary CTA, the live cost tape |
| `sodium-fg` (`--primary-foreground`) | `oklch(0.18 0.02 65)` | near-black | text on amber |

Amber-gold (Bloomberg-CRT / ledger-gold). Chosen **against** the blue/cyan/purple
every AI product defaults to, and it does not collide with green/red status
semantics. Ration it: brand mark, active selection, primary CTA, cost tape. Never a
fill for whole regions.

### Status palette (each is a STATE)
| State | Token | OKLCH | ~Hex |
|---|---|---|---|
| Running / active | `status-running` | `oklch(0.72 0.09 185)` | `#4FB8A8` (teal — the heartbeat color) |
| Success / done | `status-success` | `oklch(0.68 0.11 150)` | `#5FA86B` (muted forest, not neon) |
| Warning / attention | `status-warning` | `oklch(0.78 0.11 85)` | `#D9A441` (muted yellow, shifted off amber) |
| Error / blocked | `status-error` (`--destructive`) | `oklch(0.66 0.15 30)` | `#D96B5C` (clay, never fire-engine) |
| Idle / paused | `status-idle` | `oklch(0.48 0.006 250)` | `#5C5F66` (same grey as faint text) |
| Info / neutral signal | `status-info` | `oklch(0.64 0.07 250)` | `#6C8BB0` (slate-blue; chrome only, never competes with running-teal) |

Warning stays **more muted and yellow-shifted** than Sodium so a warning never
reads as "brand." A screen full of idle agents is a screen of grey.

### Light theme (secondary)
Raise lightness, drop accent/status chroma ~10–20%, keep hue. Canonical values:
`canvas 0.97 / surface 0.99 / raised 1.0 / hairline 0.89 / bone 0.24 / muted 0.48 /
faint 0.62`; `sodium 0.60 0.15 58`, `running 0.55 0.10 185`, `success 0.52 0.12 150`,
`warning 0.62 0.13 75`, `error 0.55 0.18 28`, `idle 0.62`, `info 0.52 0.09 250`.

---

## Spacing
- **Base unit:** 4px.
- **Density:** comfortable-dense (data-dense ops software, not a marketing page).
- **Scale:** 2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48) 4xl(64).
- Agent/entity rows: ~15px vertical padding, hairline divider, no card chrome.

## Layout
- **Approach:** grid-disciplined app with one editorial flourish (the masthead).
- **The tape / blotter (departure #1):** the primary surface is a single dense
  vertical ledger — entities stacked as **flush hairline-separated rows, edge to
  edge, no rounded cards, no drop shadows**. Reads like a Bloomberg blotter or
  `tail -f` of the whole company. This is what makes the product unmistakable from
  across a room.
- **The masthead (departure #2):** open with a restrained editorial masthead — the
  company name large and quiet in Newsreader serif, an italic live status line
  beneath ("4 agents working · $2,318.40 spent today · last action 3s ago"), a
  hairline rule under it like the head of a financial broadsheet. Frames the OS as a
  *publication reporting on a living company*, not a tool you operate.
- **Max content width:** ~1080px for reading surfaces; full-bleed for the tape.
- **Border radius:** containers/cards/rows = **0** (square). Interactive controls
  (buttons, inputs, badges, the agent face) = **2px** max. Never bubbly.

---

## Signature components

### The agent face — the living icon (one glyph, five states)
The agent's avatar **is** its status icon: a tiny instrument screen (≈36×28px,
square-ish, 3px radius, `canvas` bg, hairline border) with two "eyes." Inspired by
the Perplexity working-character, dialed to institutional restraint — no mascot
cuteness.
- **Running:** teal eyes (5×10px, 2.5px radius, soft glow) **scan side to side**
  (wider gaze ±4.5px) with a periodic **glance down** at its own work, plus a single
  mid-blink and a quick **double-blink** near cycle end; a faint scanline sweeps the
  screen. Per-agent timings vary (`--look` ≈ 2.0–3.6s, `--scan` ≈ 1.6–3.1s) so a
  roster never blinks in unison.
- **Thinking (fast):** same as running with shorter `--look` for a busier feel.
- **Done:** eyes settle into **content green arcs** (upward `border-radius`), steady,
  no motion.
- **Blocked:** **two flat clay-red dashes, dead still** (flatlined), border tinted
  red, faint red wash over the screen.
- **Idle:** **eyes shut** — flat grey dashes, asleep, no motion.

### The heartbeat spine — the hero "alive" moment
A 2px vertical line on the left edge of every working entity row (and full-height in
detail views) — a cardiac monitor turned 90°.
- **Working baseline:** spine holds a clear teal tint (`color-mix(running 40%, idle)`)
  so it visibly lives between beats.
- **Beat:** a sharp **white-hot spike with a comet trail** travels top→bottom over
  the agent's `--beat` interval (≈2.0–3.2s, varied/arrhythmic), `cubic-bezier(.45,0,.2,1)`,
  with a `scaleY` spike at ~10%; simultaneously the **whole spine flashes brighter**
  (`spineflash`, peak ~10% of cycle) — the EKG blip. Each agent beats on its own
  cadence → the tape shimmers like a living organism.
- **State change:** the new state color floods **up** the spine over ~600ms, then holds.
- **Blocked = flatline:** spine goes still and clay-red, pulse stops. The absence of
  motion is the point — viscerally legible as "this one is stuck." Recovery: red
  drains, teal pulse resumes from the top.

### The cost tape
Total spend in JetBrains Mono tabular figures. When an agent spends, the changed
**digit flashes Sodium-amber ~420ms** and the number rolls odometer-style (not a
count-up). Money spent feels like a struck match, one charge at a time.

### Thinking cursor
A working entity's run-stream line ends with a live **blinking terminal block
cursor** (`1.05s` steps) in running-teal — you watch the agent actively composing.

### Standard components (shadcn, re-skinned)
- **Buttons:** primary = solid Sodium amber, `sodium-fg` text, 2px radius. Secondary =
  transparent + hairline border. Ghost = muted text, no border. Destructive =
  transparent + clay-red border/text.
- **Badges:** mono, UPPERCASE, the status color at low-chroma fill + border, a leading
  status dot. 2px radius.
- **Inputs:** `canvas` bg, hairline border, focus border = Sodium.
- **KPI tiles:** square, hairline border, `surface` bg, mono tabular value; the spend
  tile's value is amber.
- **Status dots:** 7px, status color; running adds a soft `ping`.

---

## Motion
- **Approach:** event-bound only. **No ambient/decorative loops.** Every animation is
  triggered by a real control-plane event (the demo's loops stand in for live events).
- **Easing:** enter `ease-out`; exit `ease-in`; signal-travel `cubic-bezier(.45,0,.2,1)`.
- **Duration:** micro 50–100ms; state transitions 150–250ms; spine flood-up ~600ms;
  heartbeat travel 2.0–3.2s; cost-digit flash ~420ms; thinking cursor 1.05s.
- **Reduced motion:** `prefers-reduced-motion: reduce` freezes pulses, eyes, scanlines,
  and the cursor (cursor stays visible, static); the spine shows its solid state color.
  This is mandatory — never ship motion without the reduced-motion fallback.

---

## Voice
- **Serif** for names and the masthead (editorial gravity); **grotesque** for plain
  language; **mono** for anything a machine emitted (logs, IDs, numbers, timestamps).
- Log/run lines are lowercase, terse, factual: `composing review`, `aggregated 1,204 rows`.
- Status words are terse UPPERCASE mono tokens: `RUNNING`, `BLOCKED`, `DONE`, `IDLE`.
- Numbers are always tabular. No exclamation marks. Calm, instrument-grade, never hype.

---

## Implementation notes (for the runtime/UI session)
- Tokens live in `ui/src/index.css`. Map the GLASSHOUSE values onto the existing
  shadcn CSS variables under `.dark` (canonical) and `:root` (light secondary):
  `--background→canvas`, `--card/--popover→surface`, `--border/--input→hairline`,
  `--foreground→bone`, `--muted-foreground→muted`, `--primary/--ring→sodium`,
  `--primary-foreground→sodium-fg`, `--destructive→status-error`. Add new status
  tokens (`--status-running/-success/-warning/-error/-idle/-info`) and expose them via
  the `@theme inline` block so Tailwind utilities (`text-status-running`, etc.) resolve.
- Keep `--radius` at 0 for containers; use a `--radius-control: 2px` for interactive elements.
- Add the three font `@import`/`<link>` and set `--font-sans: "Hanken Grotesk"`,
  `--font-serif: "Newsreader"`, `--font-mono: "JetBrains Mono"`; default `body` to sans.
- Build the agent face + heartbeat spine as dedicated components; both must honor
  `prefers-reduced-motion`. Live reference: the GLASSHOUSE preview (see Decisions Log).
- Replace the catppuccin code-block colors only if they clash; otherwise leave the
  MDXEditor theme block as-is for now (out of scope for the token swap).

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-04 | Initial design system **GLASSHOUSE** created | `/design-consultation`. Memorable thing = "AI actually runs this, watch it live." Peer scan (Linear/Vercel/Retool) + Claude design subagent; Codex unavailable (ChatGPT-auth model block) so single-model. |
| 2026-06-04 | Dark-first; Sodium amber accent over blue; serif masthead; tape/blotter over card grid | Owner-approved via animated HTML preview (3 rounds). |
| 2026-06-04 | Agent face (5-state living icon) + EKG heartbeat spine + thinking cursor | Owner asked to push the "alive" animation (Perplexity moving-eyes reference); approved at v3. |
