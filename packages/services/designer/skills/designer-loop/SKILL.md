---
name: designer-loop
description: "Human-participated design iteration loop driven by claude.ai/design via the `designer` MCP. The human is the designer; AI is translation + plumbing. Human states intent, AI reads what exists and relays intent to Claude Design, human tastes the variants Claude produces, AI interprets reactions and iterates. Promotes accepted result with a decision record (the bundle's chat transcript)."
---

# Designer Loop

## Pod mode prologue (only when `CCROTATE_DESIGNER_LEASE_HOST` is set)

If you are running inside a paperclip agent pod (env
`CCROTATE_DESIGNER_LEASE_HOST` is set), you must acquire a Chrome lease
from the ccrotate-auth-bot BEFORE running any designer commands.
Designer's Chrome lives in the bot pod, not the agent pod — the lease
gives you a per-run CDP URL that designer's CLI reads via
`DESIGNER_RUN_DIR`.

1. Create a per-run working directory:
   ```bash
   export DESIGNER_RUN_DIR="$(mktemp -d /tmp/designer-XXXXXXXX)"
   ```

2. Acquire a lease via the MCP server:
   ```
   mcp__ccrotate-designer__designer_lease({ purpose: "designer" })
   ```
   Capture `cdp_url`, `lease_id`, and the bearer token (embedded in
   `cdp_url` as `?token=...`).

3. Write the URL + lease_id to the run dir (designer reads them):
   ```bash
   echo "$LEASE_CDP_URL" > "$DESIGNER_RUN_DIR/cdp-url"
   echo "$LEASE_ID" > "$DESIGNER_RUN_DIR/lease-id"
   ```

4. Proceed with the normal designer-loop steps. Each designer command
   will honor `DESIGNER_RUN_DIR` automatically and renew the lease
   before running (via designer's `maybeRenewLease()` helper).

5. On completion (success OR failure), release:
   ```
   mcp__ccrotate-designer__designer_release({ lease_id: "$LEASE_ID" })
   ```
   And clean up: `rm -rf "$DESIGNER_RUN_DIR"`.

If `CCROTATE_DESIGNER_LEASE_HOST` is unset (desktop developer flow):
skip this prologue entirely. Existing `designer setup` desktop path is
unchanged.

---

The human is the designer. Claude Design has taste. The orchestrating agent is translation + plumbing — not a co-designer.

Three layers, each with its own job:

- **Human**: taste. Describes intent, reacts to variants in their own words.
- **Claude Design** (via the `designer` MCP): aesthetic judgment. Produces variants, names them, wires tweaks.
- **Orchestrator** (this agent): translates intent to a minimal faithful prompt, presents what Claude produced, interprets reactions, promotes the result to code.

Don't muddle the three.

### When NOT to invoke this skill

For trivial mechanical changes — single token, single value, no feeling-shaped question ("set `--border-radius: 12px`", "make the bg darker by 1 stop", "add 8px of padding here") — just make the change directly. Don't boot the MCP. Don't propose variants. Show the diff and move on.

This skill is for **feeling-shaped, exploratory, or multi-dimensional** design work.

## The Loop

```
1. Intent       → Human describes what they want to feel/change (not specific values)
2. Read         → Agent calls designer_session; reads adjacent code/tokens if relevant
3. Relay        → Agent translates intent into a minimal prompt; sends via designer_prompt
4. Taste        → Human reacts to the variants Claude produced (in the tasting harness)
5. Interpret    → Agent translates reaction into next prompt or promotion
6. Repeat 3-5   → Until human says "that's it"
7. Promote      → designer_handoff; bundle's chat transcript is the decision record
```

## Phase 1: Intent

**The human speaks in feelings, not values.**

Good intent: "The sidebar feels heavy — I want it to recede." "I want an intake screen that doesn't feel clinical."

Bad intent (if it appears): `--border-radius: 12px` — already a solution, not this skill's job.

**Interview only when intent is genuinely unclear, and only about scope — never about aesthetics.**

Scope questions (yours to ask): what data is rendered, what the primary user action is, what failure modes must be visible, what the adjacent screens are, what must NOT change.

Aesthetic questions belong to Claude Design, not you: do not ask about palette, type, layout direction, tone, hierarchy, spacing style.

## Phase 2: Read the Room

Orient in the claude.ai/design surface:

1. `designer_session({ key })` — returns stored state + `availableFiles`. If `stored.designUrl` exists, you're resuming; otherwise create one with a sensible default name derived from the intent (don't interview for a project name).
2. For existing projects: `designer_snapshot({ filename })` per file of interest. You get `htmlPath` — read it only if deep inspection is warranted.
3. **Survey capabilities — this is the primary source of design, not an afterthought.** Before relaying any intent, read the target repo for what the system actually DOES: entities and their fields, operations / endpoints, states (loading / empty / error / success), failure modes, hard constraints (auth, rate limits, offline cases), and existing design tokens. The design EXPRESSES these capabilities — the human's feeling-shaped intent only tells you *how*; the codebase tells you *what*. Transfer capability facts into the prompt verbatim; don't filter them down to what you think matters aesthetically. If there's no codebase yet (greenfield intake), say so in the prompt so Claude Design doesn't invent constraints.

A one-line brief is fine ("I see X; here's the prompt I'm about to send"). Don't turn it into design-by-interview.

## Phase 3: Relay

Claude Design has taste. **Your job is to translate the human's intent into a minimal faithful prompt and let Claude's taste work.**

Guide, don't constrain. The prompt gives Claude enough to make good decisions, not pre-makes them:

| Guide (include) | Constrain (omit) |
|---|---|
| **Capability context**: what the product does, entities + fields, operations, states, failure modes | Color palette (unless it's a hard brand token) |
| User's situation / primary action | Type treatment, font feel |
| Entities, field names, copy that must appear verbatim | Layout direction, whitespace rules |
| Adjacent surfaces / what must NOT change | Tone adjectives ("contemplative", "trustworthy") unless paired with a concrete lever |
| Hard brand tokens (palette, type, existing component names) as non-negotiables | Visual hierarchy choices |
| Quantity + shape of variants ("3 full-page files", "20 on a wrapping grid") | Variant names (let Claude pick) |

Do not:

- Workshop aesthetic direction in chat before sending.
- Propose variants of your own to the human. Claude Design proposes; you relay.
- Interview about taste. Scope questions only — see Phase 1.

### Prompt discipline

- **Short and concrete over long and tasteful.** Not a hard ceiling, but over-specification is the most common failure mode.
- **Avoid ungrounded vibe adjectives.** Vibe words without a concrete surface fight Claude's style coherence. Vibe word + concrete lever is fine; vibe essay ahead of the brief is not.
- **Lock brand explicitly.** Palette, type, component names — say them. Don't hope Claude guesses.
- **Ask for tweaks** on the dimensions you expect to iterate (type, spacing, palette). Claude wires live sliders.
- **Quantities help.** "N variations", "N loaders on a grid", "N-screen onboarding."
- **Flat file layout for multi-file variants.** Tell Claude "all files at project root, no subfolders." Claude tends to organize variants under a folder (`directions/`, `variants/`) which the current MCP's file list doesn't see through — use the handoff bundle if you need nested layouts.

### Picking the right artifact shape

The split is not canvas-vs-files. The split is **what's the unit of critique?** — pick generation AND evaluation from that.

| Unit of critique | What to generate | How to evaluate |
|---|---|---|
| Alternative treatments of one view | Canvas grid OR separate full-page files, based on scale (see below) | Canvas works for ≤300×300 cells; otherwise full-viewport with a switcher |
| A journey across screens | One routed prototype with the sequence in context | Storyboard canvas — each frame is a screen in the flow |
| Named interactive states (empty / loading / error / success) | One interactive prototype with the states as toggles | Tweak system or state buttons |
| Scroll rhythm / long-form pacing | One scrollable artifact. Don't multiply it | Scroll at real width |
| A system / shipped artifact | Routed prototype, zip, or handoff to code | `designer_handoff` |

Heuristic threshold: once **screens × meaningful states × breakpoints > ~8–10**, stop multiplying variants. Converge to one routed prototype or structured handoff.

### Canvas at what scale

Two sub-modes:

- **Grid canvas** — many small cells, each ≤300×300. For widgets where variants read at thumbnail scale.
- **Storyboard canvas** — a few frames at real device size, arranged as a sequence. For flows.

Variants of a full-viewport surface are neither. Grid canvas mangles them (type scale, whitespace, hierarchy only read at real size). Storyboard doesn't apply. Right shape: separate full-page HTML files viewed at real size — usually via Claude's own `index.html` gallery opened at `currentUrl`. Fall back to `designer tasting --key <name>` (local full-viewport switcher) only if the IDE chrome is distracting judgment.

### Naming variants vs locking brand

- **Brand tokens** (palette, type, component names, product language) — specify explicitly.
- **Variant names** (what each disposable exploratory branch is called) — let Claude name them from the problem domain. Exception: if the human already has review-friendly labels in mind ("single-page / wizard / dense ops"), use those.

### Tool sequence

Common loop for any variant shape:

1. `designer_session({ key, action: 'create', name, fidelity: 'highfi' })`.
2. `designer_prompt({ prompt })` — terse, let-Claude-name. The MCP auto-appends a flat-file-layout instruction; if you want subfolders you must explicitly override in your prompt.
3. **Hand the human the URL** — `designer_session({ key, action: 'status' }).currentUrl`, or the URL echoed in the prompt result. The URL is the live design in Claude's IDE: all tweak sliders work, variant switcher works, fully interactive. This is the default taste path.
4. Repeat 2-3 as they react.
5. When they say "that's it": `designer_handoff({ key })` — tar.gz bundle with all variants + README + chat transcript. This is non-optional; it's what the implementing agent needs to build the real thing.

### When `designer_list({ scope: 'files' })` says `authoritative: false`

Claude Design sometimes organizes generated files under folders (`directions/`, `variants/`, `shared/`). The live file-list scrape only sees top-level files + folder names, never contents. When the result includes `folders: […]` and `authoritative: false`, the list is incomplete. Fall back to `designer_handoff` — the tar.gz bundle is always folder-aware.

### When the URL isn't enough — full-viewport tasting

The URL shows Claude's IDE (chat panel + project tree + toolbar eating space). That's fine for most taste judgments, but breaks down when:

- You're comparing multiple screen-level variants and the IDE chrome is stealing viewport space the designs need.
- Claude didn't build an index.html switcher, so the URL only lets you see one variant at a time (navigating via `?file=`).
- You need to judge the design at real app scale with no "is this just Claude wrapping?" distraction.

In those cases, after a handoff: `designer tasting --key <name>` — builds a local full-viewport switcher over the bundle, serves on `127.0.0.1`, opens the browser. Keyboard 1/N switches. Notes field persists in localStorage.

Don't default to tasting. Reach for it when the URL framing is getting in the way.

### Canvas-variant shape (compact widgets)

When the prompt is for a grid of small things ("20 loaders on a wrapping grid"), Claude generates one HTML file with everything on a canvas. The URL shows this perfectly — no tasting harness needed. `designer_handoff` at the end for code promotion.

## Phase 4: Taste

Show the human the URL first. Only reach for the tasting harness when full-viewport matters more than interactivity.

**The human reacts in their own language.** Don't ask "accept or reject?" — ask "what do you think?"

Messy reactions are the point:
- "A is closer but still too stark"
- "B feels right but the gap is too much"
- "Neither — what if we kept the border but made it almost invisible?"
- "Yes. That's it."

The human can tune live via the tweak sliders Claude wired into the canvas. Those tweak positions are themselves a reaction — capture them.

## Phase 5: Interpret

Translate reaction into the next move:

- **"Too X"** → prompt for variants that move away from X.
- **"Almost"** → narrow range, smaller adjustments.
- **"What if..."** → human is designing now — execute their idea as the next prompt.
- **"Yes"** → promote (Phase 7).
- **Silence / uncertainty** → open the tasting harness, ask what's bothering them.
- **Ambiguous** → before re-prompting, consider `designer_ask({ prompt })` to *consult* Claude: "given the human said X, what small change would address that?" — cheap (~15-30s text reply) and often surfaces the right adjustment.

Never override with "but best practice says..." — capture the tension in the decision record instead.

## Phase 6: Promote

1. `designer_handoff({ key, openFile: <chosen variant> })` — downloads the tar.gz bundle under `./artifacts/{key}/handoff-{ts}/`. The bundle is the decision record:
   - `README.md` — handoff protocol for the implementing agent
   - `chats/chat1.md` — full transcript (every prompt + reply, verbatim)
   - `project/*.html`, `*.jsx`, `*.css` — all design files including the chosen variant
2. If this is a frontend for an existing codebase, the implementing agent (this one, or Claude Code downstream) reads the bundle's README + chat transcript first, then translates the chosen variant into real code in the target repo.
3. Append to the codebase's design decision log with a short entry citing the bundle path + the human's final reaction verbatim.

## Guardrails

- **Read before relaying** (Phase 2). Call `designer_session` first — it returns `availableFiles`.
- **Transfer capabilities, don't summarize them.** When the codebase has real endpoints / entities / states, drop them into the prompt unabridged. Summarizing is filtering — you're quietly making design decisions Claude Design should make.
- **Guide, don't constrain.** Scope + data + hard brand tokens in; aesthetic choices out.
- **Lock brand explicitly.** Claude won't guess your palette.
- **Let Claude name variants** from the problem domain.
- **Capture feedback verbatim.** The bundle's chat transcript is the record — don't sanitize.
- **Direct values execute.** If the human says `--border-radius: 12px` mid-loop, just do it (don't even invoke Claude Design for that). Still note the intent.
- **Promote only after explicit "yes"** — "almost" is not "yes."

## Anti-Patterns

- **Designing before reading capabilities.** Booting the loop without surveying the target repo produces designs that look good and don't fit the system. Phase 2 step 3 is load-bearing.
- **Interviewing about aesthetics.** Scope questions are fine when intent is genuinely unclear; taste questions aren't yours to ask.
- **Proposing variants of your own.** Claude Design proposes. You relay.
- **Constraining where Claude should have room.** Brand tokens are constraints; palette feelings and layout hunches aren't.
- **Ungrounded vibe essays.** Vibe words without a concrete surface to attach to fight Claude's style coherence.
- **Variant grid for full-screen experiences.** Shrinking an intake/onboarding/dashboard into a 400px cell loses hierarchy, type scale, whitespace. Screen-level variants → separate files + tasting harness.
- **Separate files for compact widgets.** 20 loading indicators don't each need their own file. Grid canvas.
- **Variant grid for journeys/states/systems.** Multiplying screens by variants blows up fast. Converge to one routed prototype.
- **Auto-handoff.** Don't promote on every iteration. Handoff is Phase 7, not a sub-verb of `designer_prompt`.
- **Invoking this skill for mechanical changes.** Single-token, single-value, no-feeling changes don't need the loop. Just edit.

## When the MCP is not available

Check first: `designer_*` tools should appear in the tool list. If they don't:

1. Ask the human whether they've installed the `designer` package. If yes, the MCP may have disconnected — `claude mcp list` will show the status.
2. If they haven't set it up: `cd ~/Development/_projs/designer && ./bin/designer setup` (or after publish: `npm i -g @pro-vi/designer && designer setup`).
3. If setup isn't possible in this session, tell the human the skill can't run and fall back to making the change directly (no variant exploration).

The MCP auto-launches debug Chrome on first tool call if the dedicated profile exists. Re-runs of `designer setup` are idempotent.
