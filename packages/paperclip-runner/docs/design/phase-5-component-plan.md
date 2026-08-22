# Phase 5 Component and SDK Surface Plan — Reference Console and Reusable Contracts

Status: **approved** (UX gate PAP-16842, 2026-08-08). This is the binding
UX/component plan for the Phase 5 implementation (PAP-16843). It extends the
approved [Phase 4b interaction map](phase-4b-interaction-map.md) and
[Phase 4b component decision record](phase-4b-component-decisions.md); where
this document is silent, those documents govern.

Inputs reviewed for this gate: the accepted Phase 4b live console
(`devtools/browser/`, shipped `96092b832d`, corrected `cda1fb03ab`, QA
evidence `09b91b63f7` — 23 accepted screenshots in
`knowledge/evidence/phase-04b/` at 1440×900 and 390×844), the Phase 4b
reducer/protocol contracts (`src/reducer/session-reducer.ts`,
`src/protocol/`), and the live client layer
(`devtools/browser/src/live/{client,protocol,transcript-model,use-live-console}.ts`).

## 0. Scope and boundary

- Everything lands under `packages/paperclip-runner/` on branch
  `PAP-16679-paperclip-runner`. **Do not modify or import production
  `server/`, `ui/`, `packages/db/`, routes, persistence, or legacy
  adapters.**
- Extraction is **copy-and-freeze, not move**: the Phase 4b demo console at
  `devtools/browser/` and its Phase 1–3 surfaces stay untouched — their
  screenshots are frozen QA evidence. The SDK is a new, versioned copy with
  stable names.
- The canonical PRP event stream and `SessionSnapshot` reducer remain the
  only UI data contract (Phase 4b ground rule §1.1 carries forward
  unchanged).

## 1. Public package surface

Add subpath exports to `@paperclipai/paperclip-runner`:

| Subpath | Contents | Dependencies |
|---|---|---|
| `.` | existing node/driver contracts (unchanged) | none |
| `./browser` | framework-free session client: HTTP + SSE transport functions (today's `live/client.ts`), wire types (today's `live/protocol.ts`), transcript model, re-exported reducer | none |
| `./react` | hooks + components (today's `use-live-console.ts` + `components/ui/*` + `live/*` views) | `react`/`react-dom` as **peer** deps only |
| `./styles.css` | token sheet + component styles, scoped under `.pcr-root` | none |

Rules:

1. **Zero new runtime dependencies** (carried from Phase 4b §1.3). `react`
   and `react-dom` become declared peer dependencies of the `./react`
   subpath; nothing else is added. No Tailwind, radix, cva, AI SDK, zod,
   shiki, streamdown — same ban list as Phase 4b §6.
2. **Public naming drops `live`/`phase4b`.** Renames (shape unchanged):
   `useLiveConsole` → `useRunnerConsole`, `LiveConsole` (interface) →
   `RunnerConsole`, `LiveSessionState` → `RunnerSessionState`,
   `LiveConnectionStatus` → `ConnectionStatus`, `LiveManifestSummary` →
   `ManifestSummary`, `LiveConsoleError` → `RunnerClientError`.
   `SessionSnapshot`, `SessionItemSnapshot`, `SessionRequestSnapshot`,
   `SequenceGap`, `PrpEvent` are already canonical and keep their names.
3. **The hook contract is frozen as shipped.** `useRunnerConsole` keeps the
   accepted `RunnerConsole` shape: `manifests`, `snapshot`, `transcript`,
   `connection`, `reconnectAttempt`, `replayParity`, `composer`,
   `steeringChips`, `announcement`, `error`, `busy`, thread selection, the
   `replay` control group, and the verbs `start/send/steer/interrupt/
   resolve/goal/dropConnection/retryNow/reset/dismissSteeringChip`. The
   `announcement` string is a load-bearing accessibility channel (map §10
   A-criteria) and must remain in the public contract.
4. **Semver discipline.** Any change to an exported prop shape, class name,
   token name, or keyboard behavior after extraction requires a decision
   recorded in this document's follow-ups, not a silent edit.

## 2. Component contracts

All components: plain function components, `data-slot` attributes, semantic
class names, every visual value from the token layer. SDK class names and
tokens use the **`pcr-` prefix** (see §4) so they cannot collide in consumer
apps; the frozen `ui-*` demo classes stay behind in `devtools/browser/`.

Promoted primitives (from Phase 4b REUSE/ADAPT, contracts unchanged):

| Component | Props typed against | Keyboard contract |
|---|---|---|
| `Button` (default/danger/ghost) | native button props | native |
| `Badge` | tone + children | n/a |
| `Card` | native section props | n/a |
| `Textarea` | native | native |
| `Tabs` | items + selected + onSelect | WAI-ARIA tabs, roving tabindex, arrow keys (map K) |
| `Menu` (menu-button) | fixed item list + onSelect | menu-button pattern: arrows, Home/End, Escape |
| `Dialog` | open/onClose/title/children | native `<dialog>` `showModal()`: focus trap + Escape |
| `Tooltip` | content mirrored to `aria-describedby` | focus-visible trigger; never the only channel (A5) |
| `Banner` | tone (info/warning/danger/success) + actions | actions are real buttons in tab order |

Promoted console components:

| Component | Props typed against | Notes |
|---|---|---|
| `Conversation` | `TranscriptEntry[]` + unseen count | `role="log"`, stick-to-bottom + "jump to latest" as accepted |
| `Message` | `SessionItemSnapshot` | roles: user/assistant/reasoning/tool/system |
| `Composer` | `ComposerState` + submit/steer/stop verbs | Enter submits, Shift+Enter newline; Send/Steer/Stop tri-state per map §1–§3 |
| `ReasoningItem` | `SessionItemSnapshot` | `<details>` disclosure, auto-open while streaming |
| `ToolItem` | `SessionItemSnapshot` | header/input/output sections, status from canonical events |
| `RequestCard` | `SessionRequestSnapshot` + resolve verb | one card per pending request kind; terminal states preserved (PAP-16839 semantics) |
| `SessionTimeline` (today's `SessionPanel`) | `SessionSnapshot` | timeline, lineage tree, goal state |
| `Inspector` | `SessionSnapshot` + `PrpEvent[]` | Events/Session tabs; copy affordance stays local |
| `ReplayControls` | `RunnerConsole["replay"]` | scrub/step/play; arrow-key step |
| `ConnectionBanner` | `ConnectionStatus` + retry verb | reconnect/backoff states as accepted |

Layout components (`.pcr-root` shell, three-pane grid, mobile segments) are
exported as the **reference console** (`RunnerConsoleApp`) — see §8. Grid
tracks that hold identifiers must use `minmax(0, 1fr)` with `min-width: 0`
at every level (measured Phase 4b regression; do not rely on CSS reasoning —
verify with `getBoundingClientRect` in the browser tests).

## 3. Extension points (exactly these five)

1. **Item body renderer.** `Conversation`/`Message`/`ReasoningItem`/
   `ToolItem` accept optional `renderItemBody?(item: SessionItemSnapshot) =>
   ReactNode`. Default remains exact plain text. This is where consumers add
   markdown or syntax highlighting — which is why `Response` and `CodeBlock`
   stay out of the core (§9).
2. **Request detail renderer.** `RequestCard` accepts optional
   `renderRequestDetail?(request: SessionRequestSnapshot) => ReactNode` for
   the payload section only. Status header, resolution controls, and
   terminal-state behavior are not overridable.
3. **Composer slots.** Optional `leadingActions`/`trailingActions`
   ReactNode slots in the action row. Submit semantics, tri-state button,
   and keyboard behavior are fixed.
4. **Token theming.** Consumers restyle exclusively by overriding `--pcr-*`
   custom properties on `.pcr-root` (or a descendant scope). Class names and
   DOM structure are not a supported theming API.
5. **Transport injection.** The `./browser` client accepts `{ baseUrl,
   fetchImpl?, eventSourceFactory? }` so consumers can add auth headers,
   proxies, or test doubles without forking the client.

Anything not listed is **not** an extension point. No render-prop shells, no
headless mode, no component-swap registry in Phase 5.

## 4. Design-token rules

1. The Phase 4b token inventory (color/status pairs, accent, surfaces, type
   scale, spacing, radii, shadow, motion, z-index, layout, touch-target)
   carries over verbatim, renamed `--background` → `--pcr-background` etc.,
   declared on `.pcr-root` (not `:root`) in the shipped `./styles.css`.
2. `color-scheme: light` is declared on `.pcr-root`. **Dark mode is a
   non-goal** for Phase 5 and is recorded as such (§9).
3. No inline visual values in any SDK component — extend
   `check:browser-tokens` to cover the SDK source directories.
4. New tokens are a system change: add to the sheet and record the addition
   in this document in the same commit (Phase 4b §5 rule).
5. Motion tokens stay gated by `prefers-reduced-motion`.
6. Shipped default pairs must keep ≥ 4.5:1 contrast (map V1). The package
   docs must list the foreground/surface pairs so a consumer who overrides
   tokens knows exactly which combinations to re-verify; contrast for
   overridden values is the consumer's responsibility and the docs say so.

## 5. Responsive states

- Reference console: three-pane (rail / transcript / inspector) at desktop,
  single-pane with segment tabs at mobile, exactly as accepted in Phase 4b
  (map §0). Canonical review viewports stay 1440×900 and 390×844.
- **Single-tree rule (binding):** one rendered layout selected via a
  `matchMedia` hook (breakpoint constant 900px). Never render both layouts
  and hide one with CSS — it duplicates every `data-testid`, control, and
  ARIA landmark (Phase 4b lesson, recorded in the 4b journal).
- Component minimum widths (document in package docs): `Conversation` and
  `Inspector` ≥ 320px, `RequestCard` ≥ 280px, `Composer` ≥ 320px. Components
  must not overflow their container at these widths with realistic long
  identifiers (verify in-browser, not by CSS inspection).
- Touch targets ≥ `--pcr-touch-target` (2.75rem) for all mobile controls.

## 6. Keyboard behavior

Map §10 K1–K9 carry forward as SDK acceptance criteria, owned per component:

- `Composer`: Enter submits (Send or Steer per state), Shift+Enter inserts
  newline, disabled states never trap focus.
- `Tabs`: arrow-key roving tabindex, Home/End.
- `Menu`: menu-button pattern — Enter/Space/ArrowDown opens, arrows cycle,
  Escape closes and restores focus to the trigger.
- `Dialog`: native `showModal()` focus trap, Escape closes, focus returns to
  the invoking control.
- `ReasoningItem`/`ToolItem`: `<details>` summary toggles with Enter/Space.
- `ReplayControls`: Left/Right step one event, Space toggles play when the
  scrubber has focus.
- Banners: focus is moved to a banner only when it blocks the primary action
  (reconnect-failed); informational banners never steal focus.

## 7. Accessibility acceptance criteria

Map §10 A1–A7 and V1–V5 are the SDK acceptance bar, verified on the
reference console **and** the mini consumer:

1. Transcript is `role="log"`; state changes surface through the hook's
   `announcement` channel into a single `aria-live="polite"` region.
2. Every interactive control has an accessible name; tooltips mirror to
   `aria-describedby` and are never the only channel (A5).
3. Status is never color-only — badge text/icon carries the distinction
   (V-criteria).
4. Rebuilt-on-native patterns (dialog, menu, tabs, disclosure) meet the
   WAI-ARIA pattern they replace; "the library would have done it" remains
   unavailable as an excuse (Phase 4b §1.4).
5. Components keep their ARIA and keyboard contracts under any token
   override — theming can never remove semantics.
6. `prefers-reduced-motion` disables all non-essential motion.

## 8. Reference console and the second SDK consumer

**Reference console** (`RunnerConsoleApp`): a standalone app entry that
composes only public SDK exports and reproduces the accepted Phase 4b
lifecycle. It is the first consumer and the visual-truth surface for review
screenshots. It must not import from `devtools/browser/` demo internals.

**Mini consumer** (the tracer-bullet gate): a deliberately minimal second
app (suggested location `examples/mini-consumer/`) that proves the SDK
surface is sufficient and the extension points are real:

- Imports **only** `@paperclipai/paperclip-runner/browser`, `/react`, and
  `/styles.css` — extend `check:forbidden-imports` to fail on any deep or
  demo-internal import from either consumer.
- Single-column layout using only `Conversation`, `Composer`, `RequestCard`,
  `ConnectionBanner`, and `ReplayControls`. It is intentionally not a second
  console: no rail, no inspector, no goal menu.
- Scripted flow (against the fake scripted driver and the real Codex
  driver): list manifests → create session → send a turn → steer mid-turn →
  interrupt → resolve one command request → set and clear a goal via the
  hook verb → drop connection → automatic reconnect with gap recovery →
  enter replay and scrub → show `replayParity`.
- Exercises extension points: a custom `renderItemBody` (e.g. wraps assistant
  text with a visible marker) and at least one `--pcr-*` token override,
  both visible in screenshots.

## 9. Component decision record — Phase 5

Carried ground rules: protocol authority (§1.1), source adaptation over
dependency adoption (§1.2), zero new runtime deps (§1.3), accessibility
parity (§1.4), token gaps are system changes (§1.5).

**PROMOTE to SDK (copy from accepted Phase 4b, rename classes/tokens to
`pcr-`):** Button, Badge, Card, Textarea, Tabs, Menu, Dialog, Tooltip,
Banner, Conversation, Message, Composer, ReasoningItem, ToolItem,
RequestCard, SessionTimeline, Inspector, ReplayControls, ConnectionBanner,
plus the `useRunnerConsole` hook, transcript model, and browser client.

**Phase 4b "Phase 5 candidates" — re-decided for Phase 5:**

| Candidate | Decision | Reason |
|---|---|---|
| `Response` (streamed markdown) | **REJECT in core** | markdown pipelines pull deps and can hide protocol truth; served by the `renderItemBody` extension point instead |
| `CodeBlock` (shiki) | **REJECT in core** | same; `<pre>` + mono token remains the default, consumers plug highlighters via `renderItemBody` |
| `Context` (token/cost meter) | **REJECT as persistent meter** | usage stays plain data in the Inspector Session tab; a meter overweights cost in a protocol surface |
| `Command` palette | **REJECT** | goal vocabulary is still five fixed verbs; plain menu wins on Hick's law and zero deps |

**NEW REJECT (Phase 5):**

| Proposal | Reason |
|---|---|
| Headless/unstyled distribution | doubles the API surface and QA matrix before there is a second real consumer; token theming covers stated needs |
| Dark theme | no consuming surface requires it yet; a second palette doubles every V-criterion — record as explicit non-goal, revisit at product integration (Phase 6) |
| Tailwind/radix port | contradicts the zero-dep rule and the accepted idiom |
| Toast/notification layer | failures must live in the transcript record, not ephemeral toasts (map §1.5) |
| Virtualized transcript | no evidence of need at accepted session sizes; adds focus/scroll a11y risk. Revisit with data if real sessions exceed ~2k items |

## 10. Review evidence requirements (binding on PAP-16843)

1. Implementation handoff must attach screenshots at **1440×900 and
   390×844**: reference console in idle/empty, streaming turn, steering
   acknowledged, interrupt, request pending, request resolved, goal set,
   reconnect banner, replay mode, and failed turn; mini consumer in idle,
   streaming, request pending, reconnect, replay — including one shot each
   proving the custom `renderItemBody` and the token override.
2. Real-driver evidence: at least one reference-console screenshot from a
   live Codex session (Phase 4b QA recipe applies).
3. The implementer creates a **UX re-review child issue assigned to
   UXDesigner** with those screenshots before the Phase 5 contract review
   (PAP-16845) is asked to approve. Code inspection alone is not a UX pass.

## 11. Acceptance criteria for PAP-16843 (UX gate)

- AC1 Subpath exports `.`, `./browser`, `./react`, `./styles.css` exist with
  the dependency rules of §1; public names per §1.2; hook contract per §1.3.
- AC2 All §2 components exported with props typed against reducer/protocol
  shapes; `data-slot` attributes and `pcr-` classes throughout.
- AC3 Exactly the five §3 extension points, demonstrated in the mini
  consumer.
- AC4 Token sheet scoped to `.pcr-root`, `pcr-`-prefixed, light-only,
  lint-enforced; contrast pairs documented.
- AC5 Responsive rules of §5 hold, verified by in-browser measurement at
  both canonical viewports.
- AC6 Keyboard contracts of §6 and accessibility criteria of §7 pass on both
  consumers (component + browser tests reference K/A/V ids).
- AC7 Mini consumer runs the full §8 flow against fake and real drivers with
  no demo-internal imports (lint-enforced).
- AC8 Reference console reproduces the accepted Phase 4b lifecycle from
  public APIs only; Phase 4b demo and Phase 1–3 surfaces are byte-untouched.
- AC9 Evidence per §10 attached; UX re-review issue created.

## 12. Non-goals

Production `ui/` integration (Phase 6, gated on board acceptance + CTO
design approval), dark mode, i18n, SSR support (document client-only), npm
publishing/registry work, and any second event model or client-side session
cache (map §7.2 stands).
