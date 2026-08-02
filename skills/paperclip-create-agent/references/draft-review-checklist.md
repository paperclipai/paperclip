# Draft-Review Checklist

Walk this checklist before submitting any `agent-hires` request. Fix each item that does not pass — do not submit a draft with open failures.

Use it for every path: exact template, adjacent template, or generic fallback.

---

## A. Identity and framing

- [ ] `name`, `role`, and `title` are set and consistent with each other
- [ ] `AGENTS.md` names the agent, the role, and the company in the first sentence
- [ ] The first paragraph points at the Paperclip skill as the source of truth for the heartbeat procedure
- [ ] The reporting line (`reportsTo`) resolves to a real in-company agent id
- [ ] The `AGENTS.md` states the same reporting line in prose

## B. Role clarity

- [ ] `capabilities` is one concrete sentence about what the agent does — not a vague "assists with X"
- [ ] The role charter in `AGENTS.md` names what the agent owns end-to-end
- [ ] The charter names what the agent should decline, hand off, or escalate
- [ ] A stranger reading `capabilities` plus the role charter can tell in 30 seconds what this agent is for

## C. Operating workflow

- [ ] `AGENTS.md` states the comment-on-every-touch rule
- [ ] `AGENTS.md` states the "leave a clear next action" rule
- [ ] `AGENTS.md` covers how to mark work `blocked` with owner + action
- [ ] `AGENTS.md` covers handoff to reviewer or manager on completion
- [ ] For execution-heavy roles (coders, operators, designers, security, QA), `AGENTS.md` includes the Paperclip execution contract verbatim:
  > Start actionable work in the same heartbeat; do not stop at a plan unless planning was requested. Leave durable progress with a clear next action. Use child issues for long or parallel delegated work instead of polling. Mark blocked work with owner and action. Respect budget, pause/cancel, approval gates, and company boundaries.

## D. Domain lenses and judgment

- [ ] Expert roles list 5–15 named lenses with one-line explanations
- [ ] Lenses are role-specific, not generic productivity advice
- [ ] Simple operational roles do not carry copy-pasted lenses from expert templates

## E. Output / review bar

- [ ] `AGENTS.md` describes what a good deliverable looks like for this role
- [ ] Negative examples are included where useful ("a flow that works but looks unstyled is not done")
- [ ] Evidence expectations are concrete (tests, screenshots, repro steps, spec sections)

## F. Collaboration routing

- [ ] Cross-role handoffs are named only when the role actually touches that domain
- [ ] UX-facing role or change → routes to `[UXDesigner](/PAP/agents/uxdesigner)`
- [ ] Security-sensitive role, permissions, secrets, auth, adapters, tool access → routes to `[SecurityEngineer](/PAP/agents/securityengineer)`
- [ ] Browser validation or user-facing verification → routes to `[QA](/PAP/agents/qa)`
- [ ] Skill architecture / instruction quality changes → routes to the Skill Consultant when present
- [ ] Engineering/runtime changes → routes to CTO and a coder

## G. Governance fields

- [ ] `icon` is set to one of `/llms/agent-icons.txt` and fits the role
- [ ] `sourceIssueId` (or `sourceIssueIds`) is set when the hire was triggered by an issue
- [ ] `desiredSkills` lists only skills that already exist in the company library, or will be installed first via the company-skills workflow
- [ ] Adapter config matches this Paperclip instance (cwd, model, credentials) per `/llms/agent-configuration/<adapter>.txt`
- [ ] Local managed-bundle adapters send custom instructions through top-level `instructionsBundle.files["AGENTS.md"]` and do not set `adapterConfig.promptTemplate` or `bootstrapPromptTemplate`
- [ ] Placeholders like `{{companyName}}`, `{{managerTitle}}`, `{{issuePrefix}}`, and any URL stubs are replaced with real values

## H. Safety and permissions (least privilege)

- [ ] The hire grants only the access the role needs — no "just in case" permissions
- [ ] No secrets are embedded in plain text in `adapterConfig`, `instructionsBundle`, or any legacy prompt field; prefer environment-injected credentials or scoped skills
- [ ] Any `desiredSkills` or adapter settings that expand external-system access, browser/network reach, filesystem scope, or secret-handling capability are individually justified in the hire comment
- [ ] `runtimeConfig.heartbeat.enabled` is `false` unless the role genuinely needs scheduled recurring work AND `intervalSec` is justified in the hire comment
- [ ] `AGENTS.md` explicitly names anything the role must never do (external posts, shared infra changes, destructive ops without approval)
- [ ] If the role may handle private disclosures or security advisories, the hire names a confidential workflow (dedicated skill or documented manual process) instead of relying on normal issue threads
- [ ] No tool, skill, or capability is listed that this environment cannot actually provide

## I. Done criteria

- [ ] `AGENTS.md` states how the agent verifies its work before marking an issue done
- [ ] `AGENTS.md` states who the task goes to on completion (reviewer, manager, or `done`)
- [ ] `AGENTS.md` ends with the "always update your task with a comment" rule

## J. Choice of instruction source was explicit

- [ ] The hire comment states which path was used: exact template, adjacent template, or generic fallback
- [ ] If an adjacent template was used, the comment names what was adapted (charter rewritten, lenses swapped, sections removed)
- [ ] If the generic fallback was used, every section of the baseline role guide is present in the draft

---

## Failure modes to watch for

- **Boilerplate pass-through.** If `AGENTS.md` reads like it could apply to any role, the charter and lenses are too generic — rewrite them.
- **Quiet permission sprawl.** A big `desiredSkills` list or an open-ended adapter config usually means "just in case" access. Trim to what the charter needs.
- **Capability expansion without review.** Browser, external-system, wide-filesystem, or secret-handling access hidden inside adapter config or `desiredSkills` must be called out explicitly in the hire comment.
- **Timer-heartbeat-by-default.** If you enabled a timer heartbeat, the hire comment must state why schedule-based wake is required.
- **No confidential path for sensitive work.** Roles that may receive private advisories or incident details need a private workflow, not normal issue comments.
- **Missing governance fields.** A hire without `sourceIssueId`, `icon`, or a resolvable reporting line is hard to audit later.
- **Unreplaced placeholders.** `{{companyName}}`, `{{managerTitle}}`, and URL stubs in a submitted draft are the most common rejected-hire defect — grep the draft for `{{` before submitting.
