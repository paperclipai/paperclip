# Plan: Distinct Instruction Bundles for Chief of Staff & CTO

**Status:** Deferred (post-onboarding launch)
**Owner:** Platform / Agent Authoring
**Created:** 2026-05-28

## Context

As of `feat: expand founding-agent roles + bundle Onboarding Specialist as system skill`,
the three founding roles (`ceo`, `chief_of_staff`, `cto`) share equal platform
capabilities (manage company settings, create agents, assign tasks, approve work,
generate invites). All three currently load the **`ceo` instruction bundle**
(`AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`, `TOOLS.md` under `server/src/onboarding-assets/ceo/`).

This is intentional — the goal was to unblock onboarding without forking three
parallel bundle trees on day one. But it means a CTO and a Chief of Staff currently
introduce themselves and reason about their role through CEO-shaped prompts.

## Goal

Give Chief of Staff and CTO their own first-class instruction bundles that
preserve full platform capability but reframe role identity, default cadence,
and tool emphasis.

## Scope

1. **New bundle directories:**
   - `server/src/onboarding-assets/chief_of_staff/{AGENTS.md,HEARTBEAT.md,SOUL.md,TOOLS.md}`
   - `server/src/onboarding-assets/cto/{AGENTS.md,HEARTBEAT.md,SOUL.md,TOOLS.md}`

2. **Authoring guidelines per role:**
   - **Chief of Staff** — bias toward orchestration, status synthesis, cross-agent
     coordination, executive briefings, and unblocking. Default to delegating
     implementation to subordinate agents rather than executing directly.
   - **CTO** — bias toward architecture decisions, code review, hiring engineers,
     tech debt triage, and infrastructure approvals. Default to directly engaging
     with code and design docs.
   - Both retain the same SOUL principles (truthfulness, evidence-first, no fake
     work) as CEO. Only HEARTBEAT cadence and TOOLS emphasis differ.

3. **Wire up `DEFAULT_AGENT_BUNDLE_FILES`:**
   ```ts
   const DEFAULT_AGENT_BUNDLE_FILES = {
     default: ["AGENTS.md"],
     ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
     chief_of_staff: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
     cto: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
     onboarding: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
   } as const;
   ```

4. **Update `resolveDefaultAgentInstructionsBundleRole`:**
   ```ts
   if (role === "ceo") return "ceo";
   if (role === "chief_of_staff") return "chief_of_staff";
   if (role === "cto") return "cto";
   if (role === "onboarding") return "onboarding";
   return "default";
   ```
   (Drop the `isFoundingAgentRole` shortcut once all three bundles exist.)

## Non-Goals

- Different **permissions** for the three roles. They remain equal founding
  agents. This plan only changes prompt/cadence/tooling defaults.
- Renaming the `taskAssignSource: "ceo_role"` wire literal. Keep it stable.

## Acceptance

- A newly created Chief of Staff or CTO agent loads its own bundle (verifiable
  via `agent.instructions.files` showing role-specific markdown).
- Existing agents are unaffected (this only changes *default* bundle resolution
  for newly-created agents; existing instructions remain in DB).
- Unit test covers `resolveDefaultAgentInstructionsBundleRole` for all five
  cases.

## Open Questions

- Should the Onboarding Specialist *skill* (now a platform system skill) be
  auto-listed in the CoS bundle's `TOOLS.md` as the preferred way to bootstrap
  a new company from a repo? (Probably yes — CoS is the most natural caller.)
- Do we need a `vp_engineering` or `founding_engineer` role too? Defer until
  someone asks.
