# Board Game Agent Templates Design

## Summary

Extend the `paperclip-create-agent` skill to support board game development by adding domain-specific agent templates and reorganizing the folder structure to separate software engineering roles from board game roles.

## Goals

- Add agent templates for a full board game development pipeline (concept to workable prototype)
- Reorganize `references/agents/` into domain subfolders (`software/`, `boardgame/`) for cross-venture reuse
- Prototype deliverables: playable digital prototype, print-and-play PDF, complete rulebook with mathematical balance (excludes manufacturing-ready specs)

## Folder Structure

```
references/agents/
├── software/
│   ├── coder.md
│   ├── qa.md
│   ├── uxdesigner.md
│   └── securityengineer.md
└── boardgame/
    ├── gamedesigner.md
    ├── balancedesigner.md
    ├── playtestcoordinator.md
    ├── graphicdesigner.md
    ├── playtester.md
    └── playtester-archetypes/
        ├── marcus-optimizer.md
        ├── priya-storyteller.md
        ├── derek-casual-dad.md
        ├── yuki-competitive-veteran.md
        ├── elena-social-butterfly.md
        ├── tom-grumpy-purist.md
        ├── aisha-new-gamer.md
        ├── raj-rules-lawyer.md
        ├── camille-artist.md
        ├── ben-collector.md
        ├── fatima-reluctant-player.md
        └── liam-chaos-agent.md
```

## Board Game Role Templates

### Game Designer

- **Charter:** Owns core mechanics, rules, player interactions, win conditions, component definitions, player arc. The creative authority — decides what the game is.
- **Lens density:** High (design lenses: elegant constraint, meaningful choice, arc pacing, information asymmetry, etc.)
- **Pipeline stage:** Concept -> Rules -> Iteration
- **Adapter:** `claude_local` or `codex_local`
- **Output:** Rulebook drafts, component definitions, mechanic specs, iteration notes

### Balance Designer

- **Charter:** Owns mathematical integrity: probability distributions, economy curves, power budgets, dominant strategy detection. Proves balance with data, not intuition.
- **Lens density:** High (analytical lenses: Nash equilibrium, expected value, Pareto efficiency, Markov chains, etc.)
- **Pipeline stage:** Rules -> Simulation -> Tuning
- **Adapter:** `claude_local` or `codex_local`
- **Output:** Simulation results, balance reports with data, tuning recommendations, power curve analysis

### Playtest Coordinator

- **Charter:** Orchestrates structured play sessions, assigns playtester personas, synthesizes feedback into actionable findings, tracks iteration history. Does not play — manages the process.
- **Lens density:** Low (operational)
- **Pipeline stage:** Tuning -> Validation
- **Adapter:** `claude_local`
- **Output:** Session plans, synthesized feedback reports, iteration tracking, archetype assignment rationale

### Graphic Designer

- **Charter:** Produces visual assets: card layouts, board art, iconography, component templates, print-and-play PDFs. Translates game design into tangible artifacts.
- **Lens density:** Medium (visual communication lenses: hierarchy, information density, iconography legibility, color coding, etc.)
- **Pipeline stage:** Rules finalized -> Asset production
- **Adapter:** `claude_local` or `codex_local`
- **Output:** Card templates, board layouts, icon sets, print-and-play PDFs, component specs

### Playtester (Parameterized Base)

- **Charter:** Plays the game from a specific persona's perspective, reports on fun/frustration/confusion/degenerate strategies. Each instance has distinct preferences and blind spots.
- **Lens density:** Low (persona-driven, not lens-driven)
- **Pipeline stage:** Validation -> Feedback
- **Parameters:** Persona name, age/background, loves, dislikes, behavior pattern, feedback signal
- **Output:** Session reports from persona's perspective, specific friction/delight observations

## Playtester Archetypes

Each archetype is a filled instance of the base playtester template, organized by stress-test axis.

### Balance axis

| Archetype | Background | Tests | Signal |
|-----------|-----------|-------|--------|
| Marcus "The Optimizer" | Age 34, software engineer. Loves engine builders, clear decision trees, solo modes. Dislikes luck-heavy outcomes, fiddly setup. | Dominant strategies, decision tree exploitation | If Marcus finds a dominant strategy in session 1, it's a balance emergency |
| Yuki "The Competitive Veteran" | Age 27, semi-pro TCG player. Loves asymmetric factions, deep strategy, head-to-head tension. Dislikes multiplayer solitaire, luck in the final stretch. | Faction balance, comeback mechanics, PvP tension | If Yuki calls a faction "unplayable" or "always pick", asymmetry needs work |

### Accessibility axis

| Archetype | Background | Tests | Signal |
|-----------|-----------|-------|--------|
| Derek "The Casual Dad" | Age 44, high school teacher. Loves games explainable in 5 min, social deduction, party games. Dislikes games over 90 min, too many icons. | Teach time, rulebook clarity, icon overload | If Derek won't read the rulebook, your teach flow is broken |
| Aisha "The New Gamer" | Age 22, college student, plays Catan occasionally. Loves cooperative games, clear goals, beginner paths. Dislikes feeling lost, information overload. | Onboarding friction, new-player punishment | Where Aisha gets confused = where your tutorial fails |
| Fatima "The Reluctant Player" | Age 35, spouse dragged to game night. Loves short games, clear endpoints, cooperative feel. Dislikes being left behind strategically, runaway leaders. | Non-gamer engagement, catch-up mechanics | Her engagement level = your accessibility ceiling for non-gamers |

### Experience axis

| Archetype | Background | Tests | Signal |
|-----------|-----------|-------|--------|
| Priya "The Storyteller" | Age 29, UX designer. Loves thematic immersion, roleplay, beautiful artwork. Dislikes abstract games, pasted-on theme. | Theme/mechanic coherence, narrative immersion | If Priya says "this doesn't feel like [theme]", your abstraction leaks |
| Elena "The Social Butterfly" | Age 31, event coordinator. Loves games that generate conversation, traitor mechanics, pausable games. Dislikes analysis paralysis, long downtime. | Fun-per-minute, downtime, social dynamics | She measures fun-per-minute — if energy drops at her table, you have a pacing problem |
| Liam "The Chaos Agent" | Age 19, streams games online. Loves chaotic interactions, meme potential, funny stories. Dislikes "boring" optimal play, no social element. | Emergent interactions, unexpected rule combos | Surfaces unexpected rule interactions and emergent chaos moments |

### Rigor axis

| Archetype | Background | Tests | Signal |
|-----------|-----------|-------|--------|
| Tom "The Grumpy Purist" | Age 52, retired electrical engineer. Loves Eurogames (Agricola, Brass), clean mechanisms, zero luck. Dislikes dice, plastic miniatures, gimmicks. | Mechanism justification, design elegance | If Tom says "this mechanism isn't justified", it probably isn't |
| Raj "The Rules Lawyer" | Age 38, actual lawyer. Loves watertight rules, no ambiguity, logical consistency. Dislikes vague wording, "spirit of the rule" arguments. | Edge cases, ambiguous wording, logical consistency | Will find every edge case — invaluable for rules editing |

### Positioning axis

| Archetype | Background | Tests | Signal |
|-----------|-----------|-------|--------|
| Ben "The Board Game Collector" | Age 41, runs a local game meetup. Loves novelty, unique mechanics, shelf presence. Dislikes derivative designs, bloated component counts. | Novelty, market differentiation, shelf presence | Will compare to 50 other games — valuable for market positioning |
| Camille "The Artist" | Age 26, freelance illustrator. Loves distinctive visual identity, thoughtful component design, handcrafted feel. Dislikes generic fantasy art, cluttered layouts. | Visual identity, component quality, iconography | Gives unprompted aesthetic feedback; notices component quality issues others miss |

## Pipeline and Collaboration

```
Game Designer ─────► Balance Designer ─────��� Playtest Coordinator ─────► Playtester agents
     ▲                                              │                           │
     │                                              │                           │
     └──────────────── feedback ────────────────────┴───────────────────────────┘

Game Designer ─────► Graphic Designer (after rules finalized)
```

- Game Designer hands off mechanics to Balance Designer for mathematical validation
- Balance Designer hands off tuned rules to Playtest Coordinator for empirical testing
- Playtest Coordinator assigns playtester personas based on development stage:
  - Early concept: Balance + Rigor testers (Marcus, Yuki, Tom, Raj)
  - Mid development: Experience + Accessibility testers (Priya, Elena, Derek, Aisha)
  - Late polish: Positioning + full roster (Ben, Camille, Fatima, Liam + all others)
- Playtest Coordinator synthesizes feedback and routes back to Game Designer
- Game Designer hands off finalized components to Graphic Designer for visual production

## Files to Update

- `references/agent-instruction-templates.md` — add board game section to index table, update all paths to `software/` or `boardgame/` prefix, add when-to-use guidance for new templates, add archetype selection guidance
- `SKILL.md` — update path references in step 4 and References section

## Files Unchanged

- `references/baseline-role-guide.md` — still the generic fallback
- `references/draft-review-checklist.md` — already role-agnostic
- `references/api-reference.md` — payload shapes unchanged
