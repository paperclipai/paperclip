# Virtual Office PR Review SOP

Use this SOP when reviewing Virtual Office pull requests. The goal is to confirm the contribution is small, verifiable, and synchronized across docs and UI checklists, while ensuring the PR did not install Hermes, fill credentials, press Run now, enable schedules, wake a model, or commit sensitive data.

## Check Scope First

- The PR handles one clear problem or one small related group of changes.
- It maps to the work-item format in `docs/virtual-office-feedback-to-work-items.en.md`, or clearly explains the feedback source.
- If this is a first contribution, it fits `docs/virtual-office-first-contribution.en.md`.
- If the PR touches Hermes, Run now, schedule triggers, credentials, `.env`, production data, or database recovery, pause and do not treat it as a normal merge.

## Required Checks

- The PR description fills the Virtual Office verification block from `.github/PULL_REQUEST_TEMPLATE.md`.
- The PR includes a `pnpm run office:verify` result; if not, ask the author to add it.
- If UI changed, the author checked `http://localhost:5173/AI/office` manually or provided visual notes.
- If docs changed, related documentation maps or README / open-source guide entry points are updated.
- If feature status changed, `docs/virtual-office-acceptance-checklist.zh-TW.md` and the UI summary are in sync.
- If open-source process changed, the release checklist, maintainer daily SOP, or related SOPs are updated.

## Safety Stop Lines

Confirm the PR did not:

- Install Hermes or another local model.
- Fill API keys, tokens, passwords, or a full `.env`.
- Create wake-up issues, press Run now, enable schedule triggers, or turn on the heartbeat scheduler.
- Claim UI skill sync proves runtime skill loading is complete.
- Claim documentation templates prove human review is complete.
- Commit `.paperclip-dev-config.json`, `.virtual-office-preview-status.json`, logs, private paths, production customer data, or company data.

## Reply Templates

Before approving:

```text
Virtual Office PR review:
- Scope: small and focused / needs narrowing
- Verification: `pnpm run office:verify` pass / needs author update
- Docs/UI/checklist sync: pass / needs update
- Safety stop lines: no Hermes install, no Run now, no schedules, no secrets
- Decision: approve / request changes
```

When requesting changes:

```text
Thanks, this is close. Before merge, please update:
- [ ] Verification result for `pnpm run office:verify`
- [ ] Acceptance checklist or UI summary
- [ ] Related docs map / README / open-source guide
- [ ] Explicit confirmation that this PR did not install Hermes, press Run now, enable schedules, wake a model, or include secrets
```

## Final Merge Check

- `pnpm run office:verify` passes.
- Backend / Frontend is OK, or a blocked state is recorded through the startup SOP without data-changing recovery.
- New docs are covered by the documentation link check.
- The Office checklist shows any added or changed acceptance item.
- The PR did not move the Hermes/local model wake-up gate from `待開發` to complete.
