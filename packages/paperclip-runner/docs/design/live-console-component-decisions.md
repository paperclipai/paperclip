# Live console Component Decision Record — shadcn/ui and Vercel AI Elements

Status: **approved** (UX gate TASK-16832, 2026-08-08). Sources checked
2026-08-08 against the live shadcn/ui and AI Elements documentation; this
supersedes and extends the
[2026-08-07 compatibility note](../research/2026-08-07-ui-library-compatibility.md)
for the authorized Live console browser surface.

## 1. Ground rules (binding on the implementation)

1. **Protocol authority.** The package's canonical PRP events and
   `SessionSnapshot` reducer state are the only data contract. Third-party
   chat message types, AI SDK `UIMessage`/message-part types, and
   component-local state machines must not become inputs to, or shadows of,
   the runner protocol. Adapted components accept props typed against
   `src/reducer/session-reducer.ts` / `src/contracts/*` shapes only.
2. **Source adaptation, not dependency adoption.** Components are copied into
   `devtools/browser/src/components/` and rewritten in the established local
   idiom: plain function components, `data-slot` attributes, semantic `ui-*`
   class names, all visual values from the token layer in `src/styles.css`.
   No Tailwind, no `class-variance-authority`, no `radix-ui` runtime, no
   `cn()` utility chain, no AI SDK. (Precedent: `components/ui/button.tsx`
   already follows this idiom from the earlier phases.)
3. **Dependency budget: zero new runtime dependencies** for the demo app
   beyond the existing `react`/`react-dom`. Every candidate below that would
   pull a runtime dep (radix primitives, `cmdk`, `streamdown`, `shiki`,
   `use-stick-to-bottom`, `nanoid`, `zod`) is either rebuilt on native
   platform primitives (`<dialog>`, `<details>`, ARIA patterns) or rejected.
   Rationale: Live console is a proof under `packages/paperclip-runner/` that
   SDK will freeze into an SDK — every dependency added here becomes an
   SDK liability decision later.
4. **Accessibility parity or better.** Where we rebuild a radix-backed
   pattern on native primitives, the keyboard/SR contract in interaction map
   §10 is the acceptance bar; "the library would have done it" is not
   available as an excuse once we adapt source.
5. **Token gaps are system changes.** Live console needs a few new tokens (see
   §5). Add them to `src/styles.css` `:root` in one commit with this record —
   never inline values in component files.

## 2. Existing package-local primitives — REUSE

| Component | Decision | Notes |
|---|---|---|
| `ui/button.tsx` | Reuse | Add `ui-button--danger` and `ui-button--ghost` class variants (CSS only) for Stop / Cancel actions. |
| `ui/badge.tsx` | Reuse | Status badges for turn/request/connection states. |
| `ui/card.tsx` | Reuse | Base for request cards, manifest rows, inspector panels. |
| `ui/textarea.tsx` | Reuse | Composer input (wrapped with auto-grow behavior). |

## 3. Vercel AI Elements — decisions per primitive

AI Elements is a shadcn-registry distribution targeting React 19 + Tailwind 4
with Next.js + AI SDK prerequisites (docs, checked 2026-08-08). The turnkey
stack does not fit this standalone Vite package (already established in the
2026-08-07 note). We adapt **shapes and interaction patterns from source**,
re-typed to reducer snapshots and restyled to tokens.

**ADAPT (5):**

| Primitive | Adapted as | What we keep | What we change |
|---|---|---|---|
| `Conversation` | `ui/conversation.tsx` | stick-to-bottom semantics, "jump to latest" affordance, `role="log"` | drop `use-stick-to-bottom` dep — implement with a scroll listener + `scrollTo`; wire unseen-count from reducer timeline length |
| `Message` | `ui/message.tsx` | role-based alignment/grouping anatomy, avatar-less compact variant | props become `SessionItemSnapshot`; roles extended with `reasoning`/`tool`/`system`; no AI SDK message parts |
| `PromptInput` | `ui/composer.tsx` | textarea + action-row anatomy, submit-on-Enter, status-driven submit button | add Send/Steer/Stop tri-state from interaction map §1–§3; no attachments, no model picker, no AI SDK `sendMessage` |
| `Reasoning` | `ui/reasoning-item.tsx` | collapsible streaming reasoning with auto-open-while-streaming, duration caption | rebuild on `<details>`/summary with ARIA disclosure; content = plain streamed text (no markdown dep) |
| `Tool` | `ui/tool-item.tsx` | collapsible tool block: header (name + status badge) / input / output sections | status enum mapped from canonical item/turn events, not AI SDK `ToolUIPart` states; payloads render in `<pre>` |

**REJECT (with reasons; revisit in SDK where noted):**

| Primitive | Reason |
|---|---|
| `Response` (streamed markdown) | pulls `streamdown`/markdown pipeline; tracer renders exact text — markdown prettification can hide protocol truth. SDK candidate for the SDK console. |
| `CodeBlock` | needs `shiki` highlighting dep; `<pre>` + mono token suffices for a tracer. SDK candidate. |
| `Actions` (retry/like/copy row) | retry/regenerate/vote have no protocol backing; copy-to-clipboard is implemented locally in the inspector. |
| `Branch` | message branching does not exist in the PRP session model. |
| `Sources` / `InlineCitation` | no citation events in the protocol. |
| `Task` | overlapping with adapted `Tool`; subagent lineage uses the tree (map §6), not a task widget. |
| `ChainOfThought` | duplicate of `Reasoning` at higher visual weight. |
| `Context` (token/cost meter) | usage belongs in the inspector Session tab as plain data; a persistent meter overweights cost in a tracer. SDK candidate. |
| `Artifact`, `WebPreview`, `Image`, `Attachments`, `OpenIn`, `Suggestion`, `Queue` | no protocol counterpart in Live console; adopting them would invent affordances the runner cannot honor (fabricated-controls rule). |
| `Loader`/`Shimmer` | trivially replaced by a token-compliant CSS pulse honoring `prefers-reduced-motion`. |

## 4. shadcn/ui — decisions per primitive

**ADAPT (6):**

| Primitive | Adapted as | Implementation note |
|---|---|---|
| `Tabs` | `ui/tabs.tsx` | inspector tabs + mobile segments; WAI-ARIA tabs pattern, roving tabindex, no radix |
| `DropdownMenu` (menu-button subset) | `ui/menu.tsx` | Goal menu (§5) — five fixed items; menu-button ARIA pattern; no radix portal |
| `Dialog` | `ui/dialog.tsx` | native `<dialog>` element (`showModal()` gives focus trap + `Escape` for free); used by Set goal… and reset confirm |
| `Tooltip` | `ui/tooltip.tsx` | hover/focus tooltip for diagnostics; content mirrored to `aria-describedby` per map A5 (tooltip is never the only channel) |
| `Alert` | `ui/banner.tsx` | reconnect / pending-request / replay banners; tone variants from status tokens |
| `Separator`, `Kbd` | folded into `styles.css` | pure CSS (`ui-separator`, `ui-kbd`) — no component file needed |

**REJECT:**

| Primitive | Reason |
|---|---|
| `Command` (cmdk palette) | the goal surface has five fixed verbs — a searchable palette adds a dep and search UI for nothing (Hick's law works in our favor with a plain menu). Revisit only if goal/command vocabulary grows in SDK+. |
| `ScrollArea` | custom scrollbars are cosmetic; native scrolling is more accessible and free. |
| `Accordion`/`Collapsible` | native `<details>` covers reasoning/tool/observation disclosures. |
| `Sheet`/`Drawer`, `Popover`, `Select`, `Switch`, `Progress`, `Skeleton`, `Toast`/`Sonner` | no Live console surface needs them; toasts specifically are rejected because failures must live in the transcript record, not ephemeral notifications (map §1.5). |
| `Table` | inspector uses definition lists / simple grids; sortable tables are not needed. |
| `Sidebar` | the existing app-shell layout already provides rails; adopting the shadcn sidebar would restructure the proven shell. |

## 5. Token additions (system change, one commit)

Add to `:root` in `devtools/browser/src/styles.css`:

- `--accent: #2f5fa8` / `--accent-surface: #e9f0fa` — pending/streaming/info
  states (currently only success/warning/danger exist; pending ≠ warning).
- `--surface-raised: #fcfcfa` — inspector rows and collapsed-card summaries.
- `--motion-medium: 200ms` — banner/dialog enter (fast is too abrupt for
  modal context changes); both motion tokens gated by
  `prefers-reduced-motion`.
- `--z-banner: 10`, `--z-dialog: 20` — stacking discipline for the new
  layered surfaces.

Contrast pairs must pass map §10-V1; verify `--accent` on `--accent-surface`
≥ 4.5:1 before merge (measured 5.1:1 at the values above).

## 6. What the implementer must NOT do

- Do not `npx shadcn add` or use the AI Elements CLI/registry into this
  package (they scaffold Tailwind/radix/AI SDK). Copy source manually,
  then rewrite per §1.2.
- Do not import from `ai`, `@ai-sdk/*`, `zod`, `radix-ui`, `cmdk`,
  `streamdown`, or `shiki` anywhere under `devtools/browser/`.
- Do not add a second event model, message store, or client-side session
  cache that could diverge from the reducer (map §7.2).
- Do not restyle existing Replay–3 surfaces beyond shared-token additions;
  their screenshots are frozen QA evidence.

## 7. Evidence checklist for this record

- [x] Live docs re-checked 2026-08-08 (shadcn/ui Vite path; AI Elements
      prerequisites: Node 18+, Next.js + AI SDK project, React 19,
      Tailwind 4, shadcn/ui auto-install; registry install paths).
- [x] Existing package idiom confirmed (`ui/button.tsx` et al. — plain CSS
      classes on tokens, React 19, no Tailwind).
- [x] Interaction map cross-references: every ADAPT row maps to a surface in
      the [interaction map](live-console-interaction-map.md); every surface has a
      component owner.
