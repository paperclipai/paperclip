# Virtual Office Open-Source Feedback Triage SOP

Use this SOP after receiving feedback from friends, GitHub readers, or open-source testers. The goal is to route feedback safely before deciding whether to update docs, UI copy, preview recovery, Hermes readiness notes, or private security handling.

## Do These Three Things First

1. Confirm the report does not include API keys, tokens, passwords, a full `.env`, full logs, private paths, production customer data, or company data.
2. If sensitive information appears, ask the reporter to remove it from public places first, then move to `SECURITY.md` or a private security advisory.
3. Do not treat a report that mentions Hermes, Run now, or schedule triggers as authorization to install, configure, or wake a model.

## Triage Types

| Type | What To Check | Next Step |
| --- | --- | --- |
| Preview startup blocked | Backend / Frontend, `office:check`, status report summary | Follow the startup SOP; do not delete the database or lock files |
| Docs unclear | Stuck section, exact sentence, suggested wording | Record evidence and backfill doc changes |
| UI label or button unclear | Page location, button name, expected vs actual behavior | Create a UI copy or tutorial follow-up |
| Skills / workflow question | Sandbox/Test employee, desired skills, runtime proof | Do not treat UI sync as runtime skill loading completion |
| Hermes / local model readiness | bridge, provider/model status, non-sensitive Test environment summary | Only inspect readiness; do not paste secrets or wake the model |
| Routine / schedule safety | trigger, Run now, Sandbox/Test scope | Check Routine safety notes before touching production data |
| Security or sensitive data | credentials, vulnerability, private data, production data | Stop public discussion and move to a private safety path |

## Useful Office Tools

- `Copy issue report` (`複製 issue 回報`): format a GitHub issue safely.
- `Copy trial report` (`複製試用回報`): capture preview trial status.
- `Copy evidence log` (`複製證據紀錄`): keep one record per reader.
- `Copy feedback synthesis` (`複製回饋彙整`): group reports into must-fix, should-fix, can-wait, and safety-risk items.
- `Copy backfill card` (`複製回填卡`): turn feedback into doc edits, UI copy, safety reminders, and checklist updates.

## After Triage

- Fix now: typo, broken doc link, UI label, missing example.
- Need more evidence: reader says something is confusing but does not identify the sentence or step.
- Pause immediately: secrets, database deletion, Run now, schedule triggers, Hermes wake-up, or production data.
- Requires explicit authorization: installing Hermes, filling credentials, creating a wake-up issue, pressing Run now, or enabling schedules.

## Minimal Reply Template

```text
Thanks for the report. I am routing it as:
- Type:
- Sensitive information: no / needs removal
- Next step: docs edit / UI copy edit / preview SOP / Hermes readiness check / private security path

I will not treat this report as authorization to install Hermes, press Run now, enable schedules, or wake a model.
```
