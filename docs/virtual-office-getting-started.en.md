# Virtual Office Getting Started

Virtual Office is a 2.5D beginner-friendly control room built on top of Paperclip. It helps people who are new to local models and agents manage:

- AI employees
- company skills
- projects
- workflows
- meeting discussions and review records
- routine and schedule safety

This is not a commercial SaaS template. It is an open-source interface for personal teams, personal companies, research workflows, and local-model practice.

## Shortest Start

If you only want to open the UI first, read `docs/virtual-office-quick-start.en.md` or double-click:

```text
scripts/open-virtual-office.cmd
```

This launcher only starts or recovers the preview. It keeps the heartbeat scheduler disabled and does not wake Hermes.

## Suggested Flow

1. Create a company

   Finish Paperclip company onboarding first. Virtual Office reads from the currently selected company.

2. Create employees

   Open `Virtual Office` and use the employee creation flow. A small starter team can include:

   - project manager or PM
   - engineering or automation
   - product or requirements
   - testing or review

3. Create starter skills

   Open the skill setup wizard. The current starter skills are:

   - meeting notes and review
   - requirements analysis
   - testing checklist

   Preview a starter skill before creating it. After creation, select it and sync it to the current employee.

4. Create a project workflow

   Open the project workflow form, enter a project name and description, then choose:

   - project lead
   - upstream/downstream sequence or parallel collaboration
   - the employee responsible for each phase

   Submitting the form creates one Paperclip project and five phase issues:

   - requirements
   - design
   - implementation
   - testing
   - review

5. Create a discussion task

   When employees need to discuss or review something, open the discussion task form. You can set:

   - meeting topic
   - agenda
   - related project
   - facilitator
   - participants
   - meeting note template

   The result is a Paperclip issue that keeps the discussion process, decisions, unresolved questions, and next steps reviewable.

## Preview And Safety

Some actions modify local Paperclip data:

- creating a workflow
- creating a meeting task
- creating a starter skill
- syncing skills
- saving employee changes
- terminating an employee
- creating a routine
- adding a routine trigger
- pressing `Run now`

If you only want to inspect the interface, open forms, previews, and checklists without pressing the final create, sync, save, terminate, add-trigger, or run buttons.

## Routine / Schedule Safety

Routines can help AI employees summarize progress, remind blockers, and create review records. They can also create work or wake agents later. For a first run, use this order:

1. Draft first: only prefill a Sandbox/Test routine.
2. Pass the safety gate: confirm project, assignee, and purpose before adding a trigger or pressing `Run now`.
3. Review after the test: check runs, active issues, and recovery issues before keeping, changing, pausing, or deleting the routine.

Office does not create routines automatically, add triggers automatically, press `Run now` automatically, assign Hermes automatically, or enable heartbeat scheduling. Detailed notes are in:

```text
docs/virtual-office-routine-safety.en.md
```

## Local Model Readiness

Before Hermes or another local model takes real work, check that:

1. The local model service is running.
2. The Paperclip adapter points to the correct model and endpoint.
3. A small test task confirms the agent can read work, reply, and leave reviewable records.
4. Any repeated recovery issues are fixed before automation is enabled.
5. Heartbeat or other automatic scheduling is enabled only after the setup is stable.

For Hermes setup, start with:

```text
docs/virtual-office-hermes-sop.zh-TW.md
```

To verify that synced skills are actually loaded at runtime by a local model, open the Office `Checklist` and use `Copy runtime skill check` (`複製技能載入驗收`). The template keeps the test inside a Sandbox/Test issue and asks for adapter support, desired-skill persistence, and evidence from the agent reply.

The Hermes section also includes `技能載入驗收準備度` (`runtime skill loading readiness`). Check the `Adapter skills`, `Starter skills`, `Sandbox/Test`, and `Next step` cards first. They are read-only; do not create an issue or wake the model until the conditions are ready.

If you only need to hand off the current skill-sync state, use `複製技能交接` (`copy skill handoff`) in the Hermes section. It records starter skills, the Hermes Sandbox agent, the Sandbox/Test project, and runtime readiness. It also makes the key distinction explicit: `desired skills saved` does not mean `runtime skill loading verified`. This handoff does not create an issue, run anything now, or wake Hermes.

To verify the skill wizard UI and data sync itself, use `Copy skill sync E2E` (`複製技能同步 E2E`) in the checklist. This task card only checks selecting a Sandbox/Test employee, choosing skills, syncing, and confirming desired skills remain after refresh. It does not prove the model used those skills at runtime.

For a safer follow-up check, use `Copy skill sync recheck` (`複製技能同步復查`). It only reads the desired skills on `Sandbox Skills Sync Test`, lists whether the three starter skills are still saved, and does not sync, create an issue, run anything now, or wake Hermes.

When you are ready to ask a friend or GitHub reader to review the docs, use `Copy open-source review invite` (`複製開源試讀邀請`) in the checklist. It creates a plain-language invitation with the review goal, reading scope, safety boundaries, and reply format.

If that person actually opens the preview and tries it, use `Copy trial report` (`複製試用回報`). It collects their operating system, whether the Office page opens, Backend/Frontend status, stuck step, and a short error summary, while telling them not to paste API keys, a full `.env`, full logs, or private paths.

If the report should become a GitHub issue, use `Copy issue report` (`複製 issue 回報`). It separates startup problems, UI wording, docs, Hermes readiness, and safety concerns, and asks for only a short error summary, not secrets, full logs, private paths, or production data.

For open-source use, the repository also includes `.github/ISSUE_TEMPLATE/virtual-office.yml`. It collects the same information in a structured GitHub issue form and asks the reporter to confirm that no sensitive information is included.

For documentation contributions or fixes, read the Virtual Office feedback section in `CONTRIBUTING.md`. If the report may include a security vulnerability or sensitive information, follow `SECURITY.md` instead of opening a public issue.

For Virtual Office pull requests, use the Virtual Office verification block in `.github/PULL_REQUEST_TEMPLATE.md`. It reminds contributors to run `pnpm run office:verify`, manually check the Office page or docs, update the acceptance checklist, and confirm they did not install Hermes, press Run now, enable schedules, or wake a model.

After responses come back, use `Copy feedback synthesis` (`複製回饋彙整`). It groups reader feedback into must-fix, should-fix, can-wait, and safety-risk items so the feedback can become documentation or UI tasks.

After synthesis, use `Copy backfill card` (`複製回填卡`). It reminds you that sending an invite is not the same as passing the documentation gate; reader feedback still needs to be backfilled into doc edits, UI copy, safety reminders, and checklist status updates.

If you want one record per reader, use `Copy evidence log` (`複製證據紀錄`). It records the reader background, reading scope, whether they understood the first safe step and stop lines, their exact stuck points, and whether the documentation gate can move beyond `部分完成`.

For English-language review, use `Copy English review packet` (`複製英文試讀包`). It asks reviewers to check the English getting started guide, open-source overview, routine safety notes, Chinese UI label glossary, and Hermes / Run now safety boundaries.

To decide whether the English documentation gate can move forward, use `Copy English completion decision` (`複製英文完成判斷`). It separates automated checks from human reader feedback, so passing readability checks is not mistaken for real beginner comprehension.

During preview or development, keep heartbeat disabled so unfinished agents do not repeatedly run.

## Acceptance Checklist

The project keeps a design acceptance checklist at:

```text
docs/virtual-office-acceptance-checklist.zh-TW.md
```

The checklist tracks whether each feature matches the intended design. It covers beginner onboarding, employees and skills, project workflows, meetings and review, local models, Hermes, routine safety, and open-source documentation.

If you only need to hand off what remains before the ideal version is complete, open the Office `Checklist` and use `Copy remaining roadmap` (`複製剩餘路線`). It copies only the runtime skill-loading, human documentation review, and Hermes sandbox wake-up gates instead of the full checklist.

If you are preparing to open-source the project or hand it to someone else for trial use, use `Copy delivery decision` (`複製交付判斷`) first. It separates the current state into deliverable, still needs evidence, and do-not-cross boundaries, so "ready to try" is not confused with Hermes wake-up, runtime skill loading, or human document review being complete.

Before publishing, also use `Copy open-source safety bundle` (`複製開源安全包`) to confirm local config and logs will not be committed, the document map is complete, `pnpm run office:verify` works, and Hermes install, credentials, Run now, scheduling, and wake-up remain behind explicit authorization.

For a final open-source release pass, read `docs/virtual-office-release-checklist.en.md`. It checks README, issue form, PR template, CONTRIBUTING, SECURITY, acceptance docs, local files, and Hermes stop lines.

If you are handing the work to another collaborator, use `Copy Gate handoff` (`複製 Gate 交接`). It lists the final gate completion conditions and the actions that must not be crossed yet: do not treat skill UI sync as runtime verification, do not treat document templates as human review, and do not install or wake Hermes without explicit authorization.

If you only need the daily decision of what is safe to do next, use `Copy Gate decision` (`複製 Gate 決策`). It splits the remaining gates into safe today, pause for evidence, and explicit-authorization-only actions, including Hermes install, Run now, and schedule trigger stop lines.

If you are close to the Hermes install line but do not want to authorize everything at once, use `Copy authorization ladder` (`複製授權階梯`) in the Hermes section. It splits read-only prep, command preview, guided install, configuration check, and sandbox wake-up into levels 0 through 4. Without an explicit level, stay at level 0.

If you only want to know which level you are currently at, use `Copy authorization control` (`複製授權總控`). It summarizes levels 0 through 4, the post-wake-up review, and the next smallest safe action. It is not install, credential, Run now, scheduling, or model wake-up authorization.

If you only want to enter level 1, use `Copy command form` (`複製命令表單`) and paste it to Codex. The form only allows Codex to list commands, not execute them. Anything that writes files, downloads packages, changes settings, touches credentials, presses Run now, enables a schedule trigger, or wakes a model must be marked PAUSE.

If the level 1 command table is clear and you want Codex to run one command, use `Copy per-command approval` (`複製逐條同意`) first. It requires each command to be approved and recorded separately; one broad approval must not cover every command.

If Hermes provider / model / API key has already been filled in Hermes' own settings location, use `Copy configuration check` (`複製設定檢查`). This is level 3: it only reports non-sensitive configuration status and a Test environment summary. Do not paste API keys, tokens, passwords, a full `.env`, or credential-bearing logs, and do not treat this as wake-up authorization.

If level 3 passes and you are preparing for the first Sandbox/Test wake-up, use `Copy wake-up preflight` (`複製喚醒前檢查`). This is the level 4 preflight: it only confirms the environment, Sandbox employee, Sandbox/Test project, and user confirmation. Office may only prefill an issue draft; it must not create it automatically, press Run now, or enable scheduling.

After a future Sandbox/Test wake-up actually finishes, use `Copy post-wake-up review` (`複製喚醒後覆盤`). It records whether the Hermes reply is readable, whether the employee is stuck, whether live runs and recovery issues are clean, and whether it is safe to continue with another Sandbox/Test task. If the signals are not clean, stop before moving to any real project.

If you get stuck while following the docs, open the Office `Checklist` and use `Copy document feedback` (`複製文件回饋`). It gives you a fixed format for reporting which doc you read, where you got stuck, which sentences felt too technical, and whether the safety reminders were clear.

If you want another beginner to review the docs, use `Copy reading prep` (`複製閱讀準備`) first. It splits the reading into first startup, open-source trial, and Hermes-before-use groups, each with concrete review questions.

If the reviewer does not write code, use `Copy beginner self-check` (`複製新手自評`). It asks only whether they can follow the steps, where they got stuck, and whether the safety stop lines are clear. They should not paste API keys, tokens, passwords, or a full `.env`, and they do not need to create an issue, run anything now, or wake Hermes.

For a quick human document review, use `Copy human review task` (`複製真人試讀任務`). It creates a 30-45 minute task card with the reading scope, safe boundaries, and a fixed feedback format.

To decide whether the skill wizard itself is complete, use `Copy skill completion decision` (`複製技能完成判斷`). It separates "UI/data sync is verified" from "runtime skill loading is still unverified", so saved desired skills are not mistaken for proof that the model loaded skills while running.

Status meanings:

- `已驗證`: verified
- `部分完成`: partially complete
- `待開發`: not implemented yet
- `需人工驗收`: needs human usability review

Common UI labels:

- `檢查清單`: checklist
- `複製剩餘路線`: copy remaining roadmap
- `複製 Gate 交接`: copy Gate handoff
- `複製技能載入驗收`: copy runtime skill check
- `複製技能同步 E2E`: copy skill sync E2E
- `複製技能完成判斷`: copy skill completion decision
- `複製技能交接`: copy skill handoff
- `複製文件回饋`: copy document feedback
- `複製閱讀準備`: copy reading prep
- `複製真人試讀任務`: copy human review task
- `複製英文完成判斷`: copy English completion decision
- `複製新手自評`: copy beginner self-check
- `複製開工檢查`: copy daily start check
- `複製預覽求助`: copy preview help
- `複製啟動安全包`: copy startup safety bundle

## Local Preview

For local development, disable the heartbeat scheduler first so unfinished local agents do not run unexpectedly:

```powershell
$env:PATH='C:\path\to\.tools;' + $env:PATH
$env:HEARTBEAT_SCHEDULER_ENABLED='false'
cd C:\path\to\paperclip
pnpm dev:once
```

Then open:

```text
http://127.0.0.1:3100/AI/office
```

## Daily Start Check

The first time you open Virtual Office each day, use this order:

1. Run `pnpm run office:check` and confirm Backend OK and Frontend OK.
2. Open `http://localhost:5173/AI/office`.
3. Check the starter console and preview service status first.
4. Confirm heartbeat is still disabled.
5. Confirm there are no unexpected running/error employees or recovery issues.
6. Before touching routines, Hermes, employee termination, or production data, copy the matching checklist.

If `office:check` fails, do not create workflows, sync skills, save employees, press `Run now`, or wake Hermes yet. Recover the preview first with `docs/virtual-office-startup-sop.en.md`.

The Office starter console also has a `Copy startup safety bundle` action in the `Preview service` section. Use it after a reboot if the preview is still stuck; it bundles the daily start check, preview help prompt, status report review template, and preview failure decision table so you can paste one safe package back into Codex.

If `office:verify` or `office:check` reports Backend OK but Frontend blocked, follow the `Frontend blocked but backend OK` flow in `docs/virtual-office-startup-sop.en.md`. That usually means the preview page needs a restart; it does not mean the database is broken, and it is not a reason to wake Hermes.

If the preview is already using the helper scripts, these are the safer maintenance commands:

```powershell
pnpm run office:check
pnpm run office:start
pnpm run office:restart
```

To run UI typecheck, acceptance sync, documentation checks, and preview health together, use:

```powershell
pnpm run office:verify
```

## Documentation Map

Open these files by purpose:

- `docs/virtual-office-getting-started.zh-TW.md`: Chinese beginner guide.
- `docs/virtual-office-getting-started.en.md`: this English beginner guide.
- `docs/virtual-office-quick-start.zh-TW.md`: short Traditional Chinese launcher guide.
- `docs/virtual-office-quick-start.en.md`: short English launcher guide.
- `docs/virtual-office-open-source-readme.zh-TW.md`: Chinese open-source overview.
- `docs/virtual-office-open-source-readme.en.md`: English open-source overview.
- `docs/virtual-office-acceptance-checklist.zh-TW.md`: feature acceptance and design-fit tracking.
- `docs/virtual-office-startup-sop.zh-TW.md`: startup and preview recovery flow.
- `docs/virtual-office-startup-sop.en.md`: English startup and preview recovery flow.
- `docs/virtual-office-hermes-sop.zh-TW.md`: Hermes local model setup, environment checks, and sandbox wake-up flow.
- `docs/virtual-office-routine-safety.zh-TW.md`: Chinese Routine / schedule safety notes.
- `docs/virtual-office-routine-safety.en.md`: English Routine / schedule safety notes.

## Help Prompts For Codex

If you are not a programmer, copy one of these prompts into Codex:

```text
Please follow docs/virtual-office-startup-sop.en.md and check my Virtual Office preview. Start with health checks only. Do not delete the database, do not create or modify data, and do not wake Hermes.
```

```text
Please follow docs/virtual-office-acceptance-checklist.zh-TW.md and summarize the current Virtual Office progress. Tell me what is verified, what is still partial, and what should not touch production data yet.
```

```text
Please follow docs/virtual-office-routine-safety.en.md and check my Routine / schedule setup. Confirm Sandbox/Test scope, safety gates, and review records first. Do not add triggers, do not press Run now, and do not assign Hermes.
```

```text
Please follow docs/virtual-office-hermes-sop.zh-TW.md and check my Hermes setup status. Only inspect environment and safety gates. Do not wake any agent, and do not write API keys, tokens, or passwords.
```

## Contributor Principles

- Help beginners understand the next step.
- Avoid requiring users to understand the full Paperclip data model first.
- Keep actions grounded in Paperclip's native company, agent, project, issue, skill, and routine records.
- Make data-changing actions clear before submission.
- Keep Hermes and other local-model automation behind explicit setup and sandbox checks.
- Preserve discussion and decision history so humans can review what happened later.

## English Documentation Review Notes

Before publishing this guide for open-source users, review it with these beginner checks:

- The first successful path should be clear before advanced options.
- Data-changing actions should be named before the user is asked to press them.
- Local model setup should stay optional until the adapter flow is stable.
- Any Chinese UI label that remains in screenshots or the app should be paired with an English explanation.
- A beginner should be able to stop safely without creating extra projects, skills, routines, or meeting tasks.
