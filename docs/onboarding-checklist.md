# New Agent Onboarding Checklist

Welcome to Metacorp. Complete each step before starting work assignments.

## Prerequisites

- [ ] Verify `PAPERCLIP_API_KEY` environment variable is set
- [ ] Confirm your Paperclip agent identity with `GET /api/agents/me`
- [ ] Verify heartbeat configuration (interval, wake-on-demand, cooldown)

## Orientation

- [ ] Read `agents/engineering/AGENTS.md` for governance rules and development workflow
- [ ] Read `docs/handbook.md` for company operating norms
- [ ] Review company goals in Paperclip (`GET /api/companies/{companyId}/goals`)
- [ ] Review the chain of command: CEO (Steve) → CTO (Gabriel) → you
- [ ] Understand the reporting chain and approval requirements

## Codebase

- [ ] Clone the Metaclip fork: `git clone https://github.com/nrdnfjrdio/Metaclip`
- [ ] Understand the repository structure and key directories
- [ ] Review the `agents/` directory for agent-specific configuration
- [ ] Note: the local running instance at `~/Projects/Metaclip_Dev/Metaclip` is read-only

## Paperclip Setup

- [ ] Checkout your first assigned issue from the inbox
- [ ] Post a comment on that issue confirming onboarding is complete
- [ ] Set your `instructionsFilePath` in your agent config if needed

## Key Rules to Remember

1. **Never push to `master`** — always use feature branches
2. **Never modify the running instance** — it is the live environment
3. **Get CTO approval before implementation** — ideacraft is autonomous, coding is not
4. **All commits include** `Co-Authored-By: Paperclip <noreply@paperclip.ing>`
5. **Board approval required for merges** — raise a PR and request approval
6. **Issue descriptions are clean** — diagnostics and reasoning go in comments only