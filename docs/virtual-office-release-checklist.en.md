# Virtual Office Open-Source Release Checklist

Use this checklist before sharing Virtual Office with friends, GitHub readers, or open-source testers. This is not authorization to install Hermes, press Run now, enable schedules, or wake a local model.

## 1. Run Before Publishing

```powershell
pnpm run office:verify
```

A passing run should include:

- UI typecheck passes.
- Virtual Office acceptance sync passes.
- Virtual Office documentation link checks pass.
- Backend OK.
- Frontend OK.
- Render smoke loads the Office page successfully.

If Backend or Frontend is blocked, follow `docs/virtual-office-startup-sop.en.md` first. Do not delete the database, do not manually delete `postmaster.pid`, and do not wake Hermes just because preview health is blocked.

## 2. Public Entry Points

Confirm these entry points exist:

- `README.md` has a `Virtual Office` section.
- `docs/virtual-office-getting-started.zh-TW.md`
- `docs/virtual-office-getting-started.en.md`
- `docs/virtual-office-quick-start.zh-TW.md`
- `docs/virtual-office-quick-start.en.md`
- `docs/virtual-office-open-source-readme.zh-TW.md`
- `docs/virtual-office-open-source-readme.en.md`
- `docs/virtual-office-public-status.zh-TW.md`
- `docs/virtual-office-public-commit-scope.zh-TW.md`
- `docs/virtual-office-public-commit-scope.en.md`
- `docs/virtual-office-pr-submission-plan.zh-TW.md`
- `docs/virtual-office-pr-submission-plan.en.md`
- `docs/virtual-office-pr-screenshot-evidence.zh-TW.md`
- `docs/virtual-office-pr-screenshot-evidence.en.md`
- `docs/virtual-office-pr-final-review.zh-TW.md`
- `docs/virtual-office-pr-final-review.en.md`
- `docs/virtual-office-acceptance-checklist.zh-TW.md`
- `docs/virtual-office-startup-sop.zh-TW.md`
- `docs/virtual-office-startup-sop.en.md`
- `docs/virtual-office-routine-safety.zh-TW.md`
- `docs/virtual-office-routine-safety.en.md`
- `docs/virtual-office-hermes-sop.zh-TW.md`
- `docs/virtual-office-release-decision.zh-TW.md`
- `docs/virtual-office-release-decision.en.md`
- `docs/virtual-office-release-notes-draft.zh-TW.md`
- `docs/virtual-office-release-notes-draft.en.md`
- `docs/virtual-office-feedback-triage.zh-TW.md`
- `docs/virtual-office-feedback-triage.en.md`
- `docs/virtual-office-maintainer-daily.zh-TW.md`
- `docs/virtual-office-maintainer-daily.en.md`
- `docs/virtual-office-feedback-to-work-items.zh-TW.md`
- `docs/virtual-office-feedback-to-work-items.en.md`
- `docs/virtual-office-first-contribution.zh-TW.md`
- `docs/virtual-office-first-contribution.en.md`
- `docs/virtual-office-pr-review.zh-TW.md`
- `docs/virtual-office-pr-review.en.md`

## 3. GitHub Feedback And Contribution Paths

Confirm these files exist and are linked from the public docs:

- `.github/ISSUE_TEMPLATE/virtual-office.yml`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `docs/virtual-office-feedback-triage.en.md`
- `docs/virtual-office-maintainer-daily.en.md`
- `docs/virtual-office-feedback-to-work-items.en.md`
- `docs/virtual-office-first-contribution.en.md`
- `docs/virtual-office-pr-review.en.md`
- `docs/virtual-office-release-decision.en.md`

The issue template should remind users not to paste API keys, tokens, passwords, full `.env` files, full logs, private paths, private repository URLs, intranet URLs, or production data. It should also say that a GitHub issue is not authorization to install Hermes, press Run now, enable schedule triggers, or wake a model.

## 4. Do Not Commit Local Files

Confirm these are not committed:

- `VIRTUAL_OFFICE_PROGRESS.md`
- `docs/virtual-office-current-handoff.zh-TW.md`
- `.paperclip-dev-config.json`
- `.paperclip-dev*.log`
- `paperclip-dev*.log`
- `.virtual-office-preview-status.json`
- `.virtual-office-stability-report.json`
- any `.env`
- any file containing API keys, tokens, passwords, private URLs, intranet URLs, account paths, production customer data, or company data

Use `docs/virtual-office-public-status.zh-TW.md` for public progress status. Do not commit local progress journals or temporary handoff files directly.

## 5. Office Copy Tools To Check

In the Office checklist, confirm these actions are available:

- `Copy open-source safety bundle`
- `Copy delivery decision`
- `Copy trial report`
- `Copy issue report`
- `Copy gate handoff`
- `Copy gate decision`
- `Copy reading prep`
- `Copy beginner self-check`
- `Copy real-reader task`
- `Copy feedback synthesis`
- `Copy evidence log`
- `Copy English review packet`

They do not create issues, press Run now, enable schedule triggers, wake Hermes, or wake another local model. They only copy text for review, reporting, or handoff.

Before publishing, also review `docs/virtual-office-release-notes-draft.en.md` and the Traditional Chinese version. Confirm the notes do not extend the `AI-98530` Sandbox/Test runtime evidence or the `AI-98533` ordinary Sandbox/Test plan evidence into production Hermes, production runtime skill use, or reusable wake-up authorization.

## 6. Do Not Claim These Are Complete Yet

Do not claim these are complete unless you have real evidence:

- Hermes or another local model can reliably take production tasks.
- Runtime skill loading is safe for production employees or production projects.
- English docs have feedback from an English reader or someone comfortable reading English.
- Run now, schedule triggers, or heartbeat scheduler are safe for production data.

Current public evidence can say:

- `AI-98530` proves Sandbox/Test runtime capability-key visibility.
- `AI-98533` proves one ordinary Sandbox/Test plan task can produce a readable Eve / Hermes local comment and return to paused/manual.
- Chinese UI label mapping and safety reminders have user confirmation.
- English wording still needs an English reader before claiming that gate is complete.

Documentation-gate evidence should include:

- Per-reader records created with `Copy evidence log`.
- Whether readers know the first safe step is preview health.
- Whether readers know not to delete the database, paste secrets, press Run now, or wake Hermes.
- The reader's exact stuck points and the doc or UI edits made from them.
- If you want to claim English docs are ready, feedback from an English reader or someone comfortable reading English.

## 7. After Feedback Comes Back

Use `Copy feedback synthesis` in the Office checklist to sort feedback into:

- must fix
- should fix
- can wait
- safety risk

If a reporter pasted sensitive information publicly, ask them to remove it first, then use `SECURITY.md` or another private safety path.
