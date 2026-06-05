# Virtual Office First Contribution SOP

Use this SOP when making your first small Virtual Office contribution: docs, UI copy, checklist, or open-source onboarding updates. The goal is to keep first contributions safe and focused while preserving the Hermes, Run now, schedule, and production-data stop lines.

## Good First Changes

- Fix typos, broken links, or unclear sentences in docs.
- Add one missing beginner example.
- Improve a Virtual Office button label, helper text, or safety note.
- Turn routed feedback into a docs, UI, acceptance-checklist, or progress-note work item.
- Update `docs/virtual-office-acceptance-checklist.zh-TW.md` and the UI summary so checklist status stays in sync.

## Do Not Start Here

- Do not install Hermes or another local model.
- Do not fill API keys, tokens, passwords, or a full `.env`.
- Do not create wake-up issues, press Run now, or enable schedule triggers.
- Do not modify production data or real company/customer data.
- Do not treat UI skill sync as runtime skill loading completion.
- Do not treat documentation templates as completed human review.

## Suggested Flow

1. Read `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`.
2. If the change came from reader feedback, route it with `docs/virtual-office-feedback-triage.en.md`.
3. Use `docs/virtual-office-feedback-to-work-items.en.md` to turn the feedback into one small work item.
4. Change only the docs or UI directly related to that work item.
5. If a documentation entry point changed, update the open-source guide or documentation map.
6. If an acceptance item changed, update both the UI summary and `docs/virtual-office-acceptance-checklist.zh-TW.md`.
7. Before stopping, run:

```powershell
pnpm run office:verify
```

## PR Description Should Include

- The feedback or problem this PR addresses.
- Which docs, UI copy, or checklist items changed.
- The `pnpm run office:verify` result.
- Which page or docs you checked manually.
- Whether the acceptance checklist changed.
- A clear confirmation that you did not install Hermes, fill credentials, press Run now, enable schedules, wake a model, or include secrets/private data.

## If You Are Stuck

If you are unsure whether the change is safe, ask for maintainer review first:

```text
I want to handle this Virtual Office report:
- Feedback summary:
- I plan to change only:
- I will not touch: Hermes / Run now / schedule triggers / API keys / .env / production data
- I need confirmation: is this suitable as a first contribution?
```

Do not delete the database, delete lock files, paste full logs, fill credentials, or wake a local model because you are stuck.
