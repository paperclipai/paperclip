# Virtual Office Maintainer Daily SOP

Use this SOP at the start of a maintainer or collaborator work session. The goal is to check preview health, docs, and feedback before editing issues or docs. It is not authorization to install Hermes, press Run now, enable schedules, or wake a model.

## Run First

```powershell
pnpm run office:verify
```

A healthy run should include:

- UI typecheck passes.
- Acceptance sync passes.
- Documentation link checks pass.
- Backend OK.
- Frontend OK.

If the preview is blocked, follow `docs/virtual-office-startup-sop.en.md` or the Traditional Chinese version first. Do not delete the database, manually delete lock files, or wake Hermes.

## Feedback Review Order

1. Check for new Virtual Office issues or trial reports.
2. Check for sensitive information first; if present, move to `SECURITY.md` or a private security advisory.
3. Use `docs/virtual-office-feedback-triage.en.md` to route reports: preview, docs, UI, Hermes readiness, Routine safety, or security.
4. Use `docs/virtual-office-feedback-to-work-items.en.md` to turn routed reports into docs, UI, acceptance-checklist, progress-note, or private-safety work items.
5. For documentation feedback, use `Copy evidence log` and `Copy backfill card` to preserve the basis for changes.
6. For runtime skills or Hermes reports, stay in Sandbox/Test or read-only checks. Do not treat feedback as install or wake-up authorization.

## Safe Daily Work

- Fix typos, broken links, UI copy, or missing examples.
- Guide first-time contributors through `docs/virtual-office-first-contribution.en.md` for small scoped fixes.
- Review PRs with `docs/virtual-office-pr-review.en.md` before merge to confirm verification, sync, and stop lines.
- Before public sharing, use `docs/virtual-office-release-decision.en.md` for the Go / Pause / Internal Only decision.
- Improve release notes draft, open-source guide, or getting started docs.
- Organize reader evidence and feedback synthesis.
- Update the acceptance checklist and progress notes.
- If public progress status is needed, update `docs/virtual-office-public-status.zh-TW.md`; do not commit `VIRTUAL_OFFICE_PROGRESS.md` or temporary handoff files.
- Read preview status, issue status, and Sandbox/Test data without changing production data.

## Pause These

- Do not install Hermes or another local model.
- Do not fill API keys, tokens, passwords, or a full `.env`.
- Do not create wake-up issues, press Run now, or enable schedule triggers.
- Do not treat skill UI sync as runtime skill loading completion.
- Do not treat documentation templates as completed human review.

## Before Stopping

- Run `pnpm run office:verify` again.
- Record new acceptance items, docs, and remaining gates in `VIRTUAL_OFFICE_PROGRESS.md`.
- If status needs to be shared publicly, write only the sanitized summary to `docs/virtual-office-public-status.zh-TW.md`.
- If Backend / Frontend is blocked, record a `.virtual-office-preview-status.json` summary without deleting the database.
- Confirm no `.env`, local preview status, logs, secrets, or private paths are committed.
