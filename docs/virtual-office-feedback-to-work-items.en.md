# Virtual Office Feedback-To-Work-Items SOP

Use this SOP after feedback has already been routed with `docs/virtual-office-feedback-triage.en.md`. The goal is to turn feedback from friends, GitHub readers, or open-source testers into trackable work items with clear verification. This is not authorization to install Hermes, press Run now, enable schedules, or wake a model.

## Confirm Before Converting

- The report does not include API keys, tokens, passwords, a full `.env`, full logs, private paths, production customer data, or company data.
- The report has already been routed with `docs/virtual-office-feedback-triage.en.md`.
- If the report involves security, credentials, vulnerabilities, or production data, use `SECURITY.md` or a private security advisory instead of a public work item.
- If the report mentions Hermes, Run now, or schedule triggers, create only a readiness-doc or stop-line improvement. Do not create an install or wake-up task.

## Work Item Types

| Feedback | Create | Verification |
| --- | --- | --- |
| Docs are unclear or steps jump too far | Docs edit | Update the doc and record the original sentence plus the replacement in a backfill card |
| Button or UI copy is unclear | UI copy edit | Update the visible text and add a UI acceptance item when needed |
| Preview startup is blocked | Preview SOP or startup check edit | `pnpm run office:verify` passes and the startup SOP is updated |
| Report format is unclear | Issue template or trial-report edit | Update the issue form, copy template, or guide |
| Skills / workflow is uncertain | Sandbox/Test verification task | Check UI persistence and read-only state only; do not claim runtime skill loading is complete |
| Hermes readiness question | Hermes readiness docs edit | Improve readiness checks and stop lines only; do not paste secrets or wake a model |
| Routine / schedule safety question | Routine safety docs edit | Keep Sandbox/Test, Run now, and schedule-trigger stop lines |
| Possible sensitive information | Private security handling | Do not summarize sensitive details publicly; remove sensitive content first |

## Work Item Template

```text
## Virtual Office Feedback-To-Work-Item

- Source: friend / GitHub issue / Discord / reader reply / other
- Original feedback summary:
- Triage type: docs / UI / preview / skills / Hermes readiness / Routine safety / security
- Sensitive information: no / removed / must move to private security path
- Affected reader: beginner / maintainer / English reader / Hermes readiness user / open-source contributor

### Changes To Make
- [ ] Docs:
- [ ] UI copy:
- [ ] Acceptance checklist:
- [ ] Progress notes:
- [ ] Automated checks:

### Verification
- [ ] `pnpm run office:verify` passes.
- [ ] If docs changed, the documentation map or related entry point is updated.
- [ ] If UI changed, the Office checklist or related section shows it.
- [ ] If an acceptance item changed, `docs/virtual-office-acceptance-checklist.zh-TW.md` and the UI summary are in sync.
- [ ] Hermes was not installed, credentials were not filled, no wake-up issue was created, Run now was not pressed, and schedule triggers were not enabled.
```

## Close Or Keep Open

Close when:

- The feedback became a clear change and all verification checks pass.
- If no change is made yet, the reason and missing evidence are recorded.
- If it was security-sensitive, it moved to a private safety path and the public thread keeps only non-sensitive status.

Keep open when:

- The report says something is confusing but does not name the section, button, or step.
- Docs changed but the documentation map, checklist, or progress notes were not updated.
- UI changed but `pnpm run office:verify` has not run.
- The report is actually asking for Hermes install, Run now, schedule enablement, or model wake-up without explicit authorization.

## End-Of-Batch Record

After a batch of reports, record:

- Which reports became work items.
- Which reports need more reader evidence.
- Which reports moved to a private path because of safety or sensitive information.
- Which acceptance items or documentation entry points changed.
- Which Hermes / Run now / schedule-trigger stop lines remain in place.
