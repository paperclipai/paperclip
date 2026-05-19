# Virtual Office Open-Source Trial Release Go / Pause SOP

Use this SOP as the final decision before sharing Virtual Office publicly. It is not proof that the ideal version is complete, and it is not authorization to install Hermes, press Run now, enable schedules, or wake a model. It only answers whether Virtual Office is ready for friends, GitHub readers, or open-source testers to try.

## Go: Ready For Trial Use

When all conditions are true, you may use `docs/virtual-office-release-notes-draft.en.md` to publish a trial-use note:

- `pnpm run office:verify` passes.
- Backend OK and Frontend OK.
- README, getting started docs, open-source guide, release checklist, issue form, PR template, CONTRIBUTING, and SECURITY entry points exist.
- `docs/virtual-office-release-checklist.en.md` has been reviewed.
- `docs/virtual-office-pr-review.en.md` and `docs/virtual-office-first-contribution.en.md` are linked from the contribution flow.
- Runtime skill loading has `AI-98530` Sandbox/Test evidence. The ordinary Sandbox/Test plan task has `AI-98533` evidence. Chinese UI label mapping and safety reminders have user confirmation, the 60-minute stability run and 3/3 reboot validation have passed, and English documentation reader evidence plus production Hermes/local model wake-up are still clearly disclosed as remaining gates.
- No `.env`, local preview status, logs, secrets, private paths, or production data are committed.

Go only means "ready to try and report feedback." It does not mean the ideal version is complete.

## Pause: Do Not Share Publicly Yet

Pause if any condition is true:

- Backend or Frontend is blocked and no safe startup SOP record exists.
- `pnpm run office:verify` does not pass.
- Documentation links are missing, English readability checks fail, or the README entry point is incomplete.
- The issue form, PR template, CONTRIBUTING, SECURITY, or release checklist is missing safety stop lines.
- `.env`, API keys, tokens, passwords, full logs, private paths, production customer data, or company data may be committed.
- Hermes, Run now, schedule triggers, or model wake-up are presented as normal trial steps.
- Release notes imply production runtime skill use, production Hermes wake-up, or English documentation review is complete without evidence.

## Internal Only: Keep Working Privately

These states are fine for internal work, but not public trial invitations:

- Docs are drafted but `pnpm run office:verify` has not run.
- UI or checklist items changed, but the Markdown ledger is not synced.
- Feedback is vague and does not name the stuck sentence or step.
- Hermes readiness is still being organized and does not have explicit user authorization.
- Preview opens, but startup is still unstable and needs more startup records.

## Final Decision Record

```text
## Virtual Office Open-Source Trial Release Decision

- Date:
- Decision: Go / Pause / Internal Only
- `pnpm run office:verify`: pass / fail / not run
- Backend / Frontend: OK / blocked
- Documentation entry points: complete / needs updates
- GitHub feedback and PR paths: complete / needs updates
- Local files and sensitive data: clean / needs cleanup
- Evidence: AI-98530 runtime proof / AI-98533 ordinary Sandbox plan / Chinese safety reminder confirmation
- Remaining gates: English docs review / production Hermes-local model wake-up
- Stop-line confirmation: no Hermes install, no Run now, no schedules, no model wake-up
- Next step:
```

## Keep Saying This After Release

- "Virtual Office is ready for trial use and feedback."
- "Runtime skill loading has AI-98530 Sandbox/Test evidence, and one ordinary Sandbox/Test plan task has AI-98533 evidence; English documentation review and production Hermes/local model wake-up still remain gated."
- "Issues, PRs, doc feedback, and reader feedback are not Hermes install or wake-up authorization."
- "First contributions should start with small docs, UI copy, checklist, or open-source guide fixes."
