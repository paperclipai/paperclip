# Agent Instruction Templates

Use this reference from step 4 of the hiring workflow. It lists the current role templates, when to use each, and how to decide between an exact template, an adjacent template, or the generic fallback.

These templates are deliberately separate from the main Paperclip heartbeat skill and from `SKILL.md` in this folder — the core wake procedure and hiring workflow stay short, and role-specific depth lives here.

## Decision flow

```
role match?
├── exact template exists       → copy it, replace placeholders, submit
├── adjacent template is close  → copy closest, adapt deliberately (charter, lenses, sections)
└── no template is close        → use references/baseline-role-guide.md to build from scratch
```

In the hire comment, state which path you took so the board can audit the reasoning.

## Index — Software Engineering

| Template | Use when hiring | Typical adapter | Lens density |
|---|---|---|---|
| [`Coder`](agents/software/coder.md) | Software engineers who implement code, debug issues, write tests, and coordinate with QA/CTO | `codex_local`, `claude_local`, `cursor`, or another coding adapter | Low (operational) |
| [`QA`](agents/software/qa.md) | QA engineers who reproduce bugs, validate fixes, capture screenshots, and report actionable findings | `claude_local` or another browser-capable adapter | Low (operational) |
| [`UX Designer`](agents/software/uxdesigner.md) | Product designers who produce UX specs, review interface quality, and evolve the design system | `codex_local`, `claude_local`, or another adapter with repo/design context | High (lens-heavy) |
| [`SecurityEngineer`](agents/software/securityengineer.md) | Security engineers who threat-model, review auth/crypto/input handling, triage supply-chain and LLM-agent risk, and drive remediations | `claude_local`, `codex_local`, or another adapter with repo context | High (lens-heavy) |

## Index — Board Game Development

| Template | Use when hiring | Typical adapter | Lens density |
|---|---|---|---|
| [`Game Designer`](agents/boardgame/gamedesigner.md) | Game designers who own core mechanics, rules, win conditions, and player arc | `claude_local`, `codex_local` | High (design lenses) |
| [`Balance Designer`](agents/boardgame/balancedesigner.md) | Balance designers who prove mathematical integrity with data: probability, economy curves, power budgets | `claude_local`, `codex_local` | High (analytical lenses) |
| [`Playtest Coordinator`](agents/boardgame/playtestcoordinator.md) | Coordinators who orchestrate structured play sessions, assign personas, and synthesize feedback | `claude_local` | Low (operational) |
| [`Graphic Designer`](agents/boardgame/graphicdesigner.md) | Graphic designers who produce card layouts, board art, iconography, and print-and-play PDFs | `claude_local`, `codex_local` | Medium (visual communication lenses) |
| [`Playtester`](agents/boardgame/playtester.md) | Playtesters — parameterized base template. Each instance is a distinct persona. | `claude_local` | Low (persona-driven) |

### Playtester archetypes (pre-built personas)

Use these as ready-to-hire instances of the Playtester base template, or as examples of how to fill the parameters for a custom persona.

| Archetype | Axis | Tests | File |
|---|---|---|---|
| Marcus "The Optimizer" | Balance | Dominant strategies, decision tree exploitation | [`marcus-optimizer.md`](agents/boardgame/playtester-archetypes/marcus-optimizer.md) |
| Yuki "The Competitive Veteran" | Balance | Faction balance, comeback mechanics, PvP tension | [`yuki-competitive-veteran.md`](agents/boardgame/playtester-archetypes/yuki-competitive-veteran.md) |
| Derek "The Casual Dad" | Accessibility | Teach time, rulebook clarity, icon overload | [`derek-casual-dad.md`](agents/boardgame/playtester-archetypes/derek-casual-dad.md) |
| Aisha "The New Gamer" | Accessibility | Onboarding friction, new-player punishment | [`aisha-new-gamer.md`](agents/boardgame/playtester-archetypes/aisha-new-gamer.md) |
| Fatima "The Reluctant Player" | Accessibility | Non-gamer engagement, catch-up mechanics | [`fatima-reluctant-player.md`](agents/boardgame/playtester-archetypes/fatima-reluctant-player.md) |
| Priya "The Storyteller" | Experience | Theme/mechanic coherence, narrative immersion | [`priya-storyteller.md`](agents/boardgame/playtester-archetypes/priya-storyteller.md) |
| Elena "The Social Butterfly" | Experience | Fun-per-minute, downtime, social dynamics | [`elena-social-butterfly.md`](agents/boardgame/playtester-archetypes/elena-social-butterfly.md) |
| Liam "The Chaos Agent" | Experience | Emergent interactions, unexpected rule combos | [`liam-chaos-agent.md`](agents/boardgame/playtester-archetypes/liam-chaos-agent.md) |
| Tom "The Grumpy Purist" | Rigor | Mechanism justification, design elegance | [`tom-grumpy-purist.md`](agents/boardgame/playtester-archetypes/tom-grumpy-purist.md) |
| Raj "The Rules Lawyer" | Rigor | Edge cases, ambiguous wording, logical consistency | [`raj-rules-lawyer.md`](agents/boardgame/playtester-archetypes/raj-rules-lawyer.md) |
| Ben "The Board Game Collector" | Positioning | Novelty, market differentiation, shelf presence | [`ben-collector.md`](agents/boardgame/playtester-archetypes/ben-collector.md) |
| Camille "The Artist" | Positioning | Visual identity, component quality, iconography | [`camille-artist.md`](agents/boardgame/playtester-archetypes/camille-artist.md) |

**Archetype assignment by development stage** (used by the Playtest Coordinator):

- **Early concept:** Balance axis (Marcus, Yuki) + Rigor axis (Tom, Raj)
- **Mid development:** Experience axis (Priya, Elena, Liam) + Accessibility axis (Derek, Aisha)
- **Late polish:** Positioning axis (Ben, Camille) + remaining Accessibility (Fatima) + full roster
- **Rules finalization:** Always include Raj + Derek

If you are hiring a role that is not in this index, do not force a fit. Use the adjacent-template path when one is genuinely close, or the generic fallback when none is.

### When to use each template — Software

- **Coder** — the hire primarily writes or edits code against existing conventions, runs focused tests, and hands off to QA. Pick Coder when the charter is "ship code that passes review and CI." Avoid for pure strategy, design, or security review.
- **QA** — the hire reproduces bugs in a running product, exercises flows in a browser or test harness, and produces evidence-grounded pass/fail reports. Pick QA when the charter is "confirm the user experience matches intent." Avoid for agents that only run static linters or unit tests — that belongs with a Coder.
- **UX Designer** — the hire is accountable for the user experience and visual quality of product work. Pick UXDesigner when the role must make design calls, push back on unstyled implementations, and evolve the design system. Avoid for agents that only proofread or enforce style-guide consistency without making IA or voice decisions.
- **SecurityEngineer** — the hire is accountable for security posture: threat-modeling, reviewing auth/crypto/input handling, supply-chain and LLM-agent risk, and driving remediations with evidence. Pick SecurityEngineer when the role must block insecure designs, propose concrete fixes, and handle sensitive disclosure.

### When to use each template — Board Game

- **Game Designer** — the hire owns the creative direction of the game: what mechanics exist, how players interact, what the win condition is. Pick Game Designer when the charter is "define what the game is and iterate it." Avoid for roles that only balance numbers or produce visuals without creative authority.
- **Balance Designer** — the hire proves mathematical integrity with data. Pick Balance Designer when the charter is "ensure no dominant strategy exists and the economy works." Avoid for creative mechanics work (that's Game Designer) or empirical playtesting (that's Playtest Coordinator).
- **Playtest Coordinator** — the hire manages the testing process: designs sessions, assigns personas, synthesizes feedback. Pick Playtest Coordinator when the charter is "run structured playtests and report findings." Avoid for roles that play the game (that's Playtester) or make design decisions (that's Game Designer).
- **Graphic Designer** — the hire produces visual artifacts: card layouts, board art, icons, print-and-play PDFs. Pick Graphic Designer when the charter is "translate game design into tangible visual components." Avoid for roles making game design decisions or doing UX strategy for software products (that's UX Designer).
- **Playtester** — the hire plays the game from a specific persona's perspective and reports their experience. Pick Playtester when you need empirical feedback from a particular player type. Use an archetype for quick hires, or fill the base template for a custom persona.

### Lens density: when to keep the full lens list

- **Lens-heavy templates** (UXDesigner, SecurityEngineer, Game Designer, Balance Designer) encode expert judgment. The long lens list is the deliverable — keep it intact when hiring the primary domain owner. Drop lens groups only when the hire has an explicitly narrower scope.
- **Medium-lens templates** (Graphic Designer) have a focused lens set for their specific domain. Keep intact for the primary role; trim if hiring a narrow variant.
- **Operational templates** (Coder, QA, Playtest Coordinator) stay short on purpose. Do not paste lens lists into them.
- **Persona-driven templates** (Playtester archetypes) have no lenses — the persona IS the judgment framework.

## How to apply an exact template

1. Open the matching reference in `references/agents/software/` or `references/agents/boardgame/`.
2. Copy that template into the new agent's instruction bundle (usually `AGENTS.md`). For hire requests using local managed-bundle adapters, send the adapted template as top-level `instructionsBundle.files["AGENTS.md"]`. Do not put new-agent instructions in `adapterConfig.promptTemplate`.
3. Replace placeholders like `{{companyName}}`, `{{managerTitle}}`, `{{issuePrefix}}`, and URLs.
4. Remove tools or workflows the target adapter cannot use.
5. Keep the Paperclip heartbeat requirement and the task-comment requirement.
6. Add role-specific skills or reference files only when they are actually installed or bundled.
7. Run the pre-submit checklist before opening the hire: `references/draft-review-checklist.md`.

## How to apply an adjacent template

Use this when the requested role is close to an existing template but not the same (for example, "Backend Engineer" adapted from `coder.md`, "Content Designer" adapted from `uxdesigner.md`, "Release Engineer" adapted from `qa.md`, "AppSec Reviewer" adapted from `securityengineer.md`, "Narrative Designer" adapted from `gamedesigner.md`, "Economy Designer" adapted from `balancedesigner.md`).

1. Start from the closest template.
2. Rewrite the role title, charter, and capabilities for the new role — do not leave the source role's framing in place.
3. Swap domain lenses to match the new discipline. Keep only lenses that actually apply.
4. Remove sections that do not fit.
5. Add any role-specific section the baseline role guide recommends but the source template omitted.
6. Note in the hire comment which template you adapted and what you changed, so future hires of the same role can start from your draft.
7. Run the pre-submit checklist.

## How to apply the generic fallback

Use this when no template is close. Open `references/baseline-role-guide.md` and follow its section outline. That guide is structured so a CEO or hiring agent can produce a usable `AGENTS.md` without asking the board for prompt-writing help. After drafting, run the pre-submit checklist.

## How to hire a playtester

1. Decide whether an existing archetype fits the testing need, or whether a custom persona is required.
2. If an archetype fits: open the archetype file, use its filled parameters to create the hire. The archetype file has all the values you need for the base template.
3. If custom: open `references/agents/boardgame/playtester.md`, fill in all parameters for the new persona, and submit.
4. In both cases, the Playtest Coordinator should be set as the reporting line (not the CEO/CTO directly).

---

In every case, state which path you took in the hire comment and call out what you adapted. Future hires of the same role start from your draft, so the clearer the reasoning, the cheaper the next hire.
