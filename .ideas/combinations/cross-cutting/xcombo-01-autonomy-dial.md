# Cross-Cut 01 — The Autonomy Dial

**A different cut:** the 13 thematic combos group ideas by *mechanism* (concurrency, approvals,
hiring…). This one groups by a single *operator abstraction* that sits **on top of** several
mechanisms at once — one control the operator actually reasons about, instead of a dozen knobs.

**Synthesizes:** 009 Agent Probation & Trust Ramp · 001 Fleet Concurrency Governor ·
002 Predictive Budget Breaker · 016 Approval Triage & Auto-Approve · 035 Adaptive Heartbeat ·
024 Per-Run Resource Caps · 014 Emergency Stop/Drain
*(pulls one lever each from thematic combos 01, 05, 07)*

## The unified idea

Operators don't think in "max concurrent runs = 12, auto-approve threshold = $0.50, heartbeat floor =
5m, trust stage = probation." They think in **"how much leash does this company/agent get?"** Today
that single mental model is scattered across seven unrelated settings, so tuning autonomy means hand-
editing a dozen knobs that interact in non-obvious ways (raise concurrency but forget to raise the
breaker horizon and you just trip it faster).

The Autonomy Dial collapses all of it into **one ordinal control per company (and per agent), e.g.
Level 0–5**, where each level is a *named, coherent preset* across every underlying mechanism:

| Level | Concurrency (001) | Auto-approve (016) | Spend breaker (002) | Run caps (024) | Heartbeat (035) | Trust (009) |
|------|------|------|------|------|------|------|
| 0 Observe | 1 | none — all reviewed | tight | tight | slow | n/a |
| 2 Assisted | low | low-risk only | medium | medium | adaptive | probation |
| 4 Trusted | high | low+medium | loose | loose | adaptive-fast | trusted |
| 5 Autonomous | fleet-cap | all but high-risk | loose + auto-Drain on extreme | high | fast | senior |

- **One write target, many enforcers.** The dial sets the *effective* values that combo 01's control
  plane, the approval cockpit (combo 05), and the trust resolver (combo 07) already read. It doesn't
  add a new enforcement path — it's a **preset compiler** over the seams those combos build.
- **Earned movement, not just set.** The dial can *auto-advance* as the trust ramp (009) graduates an
  agent on a clean record, and *auto-retreat* on a budget trip (002), reliability burn (combo 03), or
  a security flag (combo 08) — so the leash tightens automatically when things go wrong and loosens as
  the company proves itself. The operator sets a *ceiling* ("never exceed Level 4"); the system moves
  within it.
- **One legible story.** The dashboard shows "Marketing-co: Level 3 (Trusted), auto-retreated from 4
  two hours ago after a budget trip" instead of seven disconnected settings. Emergency Stop (014) is
  simply "slam to Level 0."

## Why this is a *better* idea than the parts

The underlying mechanisms (001/002/009/016/024/035) are each valuable but each adds operator burden;
their *interactions* are where misconfiguration lives. A dial turns N independent footguns into one
coherent, monotonic control with sane couplings baked in — and makes autonomy **adaptive** (auto-
advance/retreat) rather than static. It's also the natural home for the trust ramp's promotion/
demotion (009), which otherwise has no single surface to move.

## Phasing

1. Define the level→settings mapping as a pure preset compiler over existing effective-value seams
   (needs combo 01's control plane + combo 05's risk score to exist or be stubbed). Read-only display
   first: "you are effectively at Level 3."
2. Make the dial the *write* surface (set level → apply preset atomically, audited).
3. Auto-retreat on trips (002/combo 03/combo 08 signals) within the operator's ceiling.
4. Auto-advance via the trust ramp (009); per-agent dials beneath the company dial.

## Ratings

- **Difficulty:** Medium — little new machinery; it's an abstraction/UX layer plus a couplings model
  *over* mechanisms built elsewhere. The real design work is choosing level presets that are genuinely
  coherent (no level that's powerful in one axis and crippled in another) and the auto-advance/retreat
  hysteresis so the dial doesn't flap. Hard dependency on combos 01 + 05 existing underneath.
- **Estimated time to complete:** ~2–4 engineer-weeks *on top of* combos 01/05/07.
- **Importance:** 8/10 — this is the single most operator-facing lever in the whole set; it's what makes
  all the underlying safety/economics machinery *usable* by a human who just wants to say "give this
  company more rope." High leverage, but only after the mechanisms it presets exist.
