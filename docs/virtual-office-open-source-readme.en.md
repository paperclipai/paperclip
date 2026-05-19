# Virtual Office Open Source Guide Draft

Virtual Office is a 2.5D beginner-friendly workspace built on top of Paperclip. It helps people who are new to local models and agents manage AI employees, skills, projects, workflows, and meeting records through a more familiar "personal AI company" interface.

It is not a commercial SaaS template, and it is not meant to replace Paperclip's native data model. It is a lighter, visual layer over Paperclip records so beginners do not need to understand every agent, issue, project, and skill relationship before they can start.

## Current Status

The UI, docs, preview recovery flow, open-source feedback paths, Hermes Sandbox/Test runtime capability-key proof, and one ordinary Sandbox/Test plan task are ready for review, but the ideal version still has gated areas:

- Runtime skill loading has `AI-98530` Sandbox/Test evidence; production employees or projects still need separate safe validation.
- An ordinary Sandbox/Test plan task has `AI-98533` evidence: Eve / Hermes local produced a readable design comment, returned to paused/manual, and the user confirmed the direction was OK. This is a beginner safety example, not reusable authorization.
- Chinese UI label mapping and safety reminders have user confirmation. English wording still needs real reader evidence from an English reader or someone comfortable reading English.
- Any next Hermes / local model wake-up still requires a new Sandbox/Test issue and a new verbatim one-time authorization.

## Who It Is For

- People moving from a single AI helper toward a small personal team.
- People experimenting with Hermes, Ollama, vLLM, LM Studio, or other local models.
- People who want AI employees, skills, projects, and meeting notes in one visual control room.
- People who want to share a beginner-friendly open-source workflow rather than build a commercial product.

## What Works Today

- View employees, projects, workflows, meetings, and recent activity in a 2.5D office.
- Use the starter console to create employees, install skills, manage employees, create workflows, and open discussion tasks.
- Apply role presets such as PM, engineering, testing, and design.
- Preview a five-phase workflow before creation, including the project lead, phase owners, and serial or parallel dependencies.
- Keep meeting discussions reviewable with context, decisions, unresolved questions, and next steps.
- Open the in-app acceptance checklist and copy a Markdown version for docs, issues, or progress reports.
- Use `Copy success example` to review the `AI-98533` Sandbox/Test path: edit-only actions do not wake agents, a verbatim one-time authorization is required, Eve/Hermes writes one comment, cleanup returns to paused/manual, and the user confirms the direction.
- View Routine / schedule safety status and start with a Sandbox/Test draft before enabling automation.

## Still Being Improved

- End-to-end validation for skill syncing and starter skill creation.
- End-to-end validation for workflow blockers after creating a project workflow.
- End-to-end validation for user intervention rules in real meeting issues.
- Production Hermes or other local-model task authorization and stability. Sandbox/Test has evidence; production work still needs separate authorization.
- Human review of the English documentation tone and completeness.

## Safety Principles

Virtual Office tries to make the difference between preview-only actions and data-changing actions obvious.

These actions modify local Paperclip data:

- Create workflow
- Create meeting task
- Create starter skill
- Sync skills
- Save employee changes
- Terminate employee
- Create routine
- Add routine trigger
- Run routine now

If you only want to inspect the interface, open dialogs and previews without pressing the final create, sync, save, or terminate buttons.

## Routine / Schedule Safety

Routines can help AI employees summarize progress, remind blockers, or create review records on a schedule. They can also create work or wake agents later, so the first Virtual Office flow is intentionally conservative:

- The Office page shows routine status as read-only; it does not directly create routines.
- A prefilled routine is only a Sandbox/Test draft. The user still has to press `Create routine`.
- Virtual Office routines require a Sandbox/Test confirmation before adding a trigger.
- Virtual Office routines require a Sandbox/Test confirmation before `Run now`.
- Office does not auto-assign Hermes, auto-run routines, or enable heartbeat scheduling.

Recommended order:

1. Draft first: only prefill a Sandbox/Test routine.
2. Pass the safety gate: confirm project, assignee, and purpose before adding a trigger or running now.
3. Review after the test: check runs, active issues, and recovery issues before keeping, changing, pausing, or deleting the routine.

Detailed beginner-facing notes are in:

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

During preview or development, keep heartbeat disabled so unfinished agents do not repeatedly run.

To verify whether synced skills are actually loaded at runtime by a local model, use `Copy runtime skill check` (`複製技能載入驗收`) inside the Office checklist. The template keeps the test inside a Sandbox/Test issue and records adapter support, desired-skill persistence, and evidence from the agent reply.

The Hermes section also has `技能載入驗收準備度` (`runtime skill loading readiness`) for a read-only check of adapter skills, starter-skill sync, Sandbox/Test readiness, and the next step. Do not create an issue or wake the model until those conditions are ready.

To verify the skill wizard UI and data sync itself, use `Copy skill sync E2E` (`複製技能同步 E2E`) in the checklist. This only checks selecting a Sandbox/Test employee, choosing skills, syncing, and confirming desired skills remain after refresh. It does not prove runtime model skill usage.

For a safer follow-up check, use `Copy skill sync recheck` (`複製技能同步復查`). It only reads desired skills on `Sandbox Skills Sync Test`, confirms whether the three starter skills are still saved, and does not sync, create an issue, run anything now, or wake Hermes.

When you are ready to invite a friend or GitHub reader to review the docs, use `Copy open-source review invite` (`複製開源試讀邀請`). It creates a plain-language invitation with the review goal, reading scope, safety boundaries, and reply format.

If that person actually opens the preview and tries it, use `Copy trial report` (`複製試用回報`). It collects their operating system, whether the Office page opens, Backend/Frontend status, stuck step, and a short error summary, while telling them not to paste API keys, a full `.env`, full logs, or private paths.

If the report should become a GitHub issue, use `Copy issue report` (`複製 issue 回報`). It separates startup problems, UI wording, docs, Hermes readiness, and safety concerns, while asking for only a short error summary and no secrets, full logs, private paths, or production data.

The repository also includes `.github/ISSUE_TEMPLATE/virtual-office.yml`, so open-source users can file a structured GitHub issue with the same sensitive-information safety checks.

`.github/ISSUE_TEMPLATE/config.yml` disables blank issues and routes readers to getting started, the release checklist, the contributing guide, or a private security advisory.

`CONTRIBUTING.md` also has a Virtual Office feedback section that explains what a good report should include. If the report looks like a security vulnerability or may include sensitive information, follow `SECURITY.md` instead of opening a public issue.

`.github/PULL_REQUEST_TEMPLATE.md` also includes a Virtual Office verification block. For related PRs, it asks contributors to run `pnpm run office:verify`, manually check the Office page or docs, update the acceptance checklist, and confirm they did not install Hermes, press Run now, enable schedules, or wake a model.

`docs/virtual-office-release-checklist.en.md` and the Traditional Chinese version provide a final open-source release checklist for README, issue form, PR template, CONTRIBUTING, SECURITY, acceptance docs, and stop lines.

`docs/virtual-office-release-decision.en.md` and the Traditional Chinese version provide the final Go / Pause / Internal Only decision before public trial sharing.

`docs/virtual-office-release-notes-draft.en.md` and the Traditional Chinese version provide a first-share release notes draft for friends, GitHub readers, or open-source testers.

`docs/virtual-office-feedback-triage.en.md` and the Traditional Chinese version help route preview, docs, UI, Hermes-readiness, Routine-safety, and security feedback after reports come in.

`docs/virtual-office-maintainer-daily.en.md` and the Traditional Chinese version provide a daily maintainer SOP for opening checks, feedback triage, verification before stopping, and Hermes / Run now stop lines.

`docs/virtual-office-feedback-to-work-items.en.md` and the Traditional Chinese version turn routed feedback into docs, UI, acceptance-checklist, or private-safety work items.

`docs/virtual-office-first-contribution.en.md` and the Traditional Chinese version give first-time contributors a safe path for small docs, UI copy, checklist, or onboarding fixes.

`docs/virtual-office-pr-review.en.md` and the Traditional Chinese version help maintainers review Virtual Office PR scope, verification, docs/UI/checklist sync, and safety stop lines.

After responses come back, use `Copy feedback synthesis` (`複製回饋彙整`). It groups reader feedback into must-fix, should-fix, can-wait, and safety-risk items before you turn it into documentation or UI tasks.

If you need one traceable record per reader, use `Copy evidence log` (`複製證據紀錄`). It records reviewer background, reading scope, exact stuck points, safety misunderstandings, and whether the documentation gate has enough evidence to move beyond `部分完成`.

For English-language review, use `Copy English review packet` (`複製英文試讀包`). It asks reviewers to check the English getting started guide, open-source overview, routine safety notes, Chinese UI label glossary, and Hermes / Run now safety boundaries.

## Acceptance Tracking

Feature completion is tracked in:

```text
docs/virtual-office-acceptance-checklist.zh-TW.md
```

The Office page also has a `Checklist` (`檢查清單`) button that shows verified, partially complete, pending, and human-review items.

If you only need the remaining gates before the ideal version is complete, use `Copy remaining roadmap` (`複製剩餘路線`) inside the checklist. It lists the current state for runtime skills, human documentation review, Hermes sandbox wake-up, and open-source stability instead of copying the full acceptance checklist.

If you are preparing to open-source the project or hand it to someone else for trial use, use `Copy delivery decision` (`複製交付判斷`) first. It separates the current state into deliverable, still needs evidence, and do-not-cross boundaries, so "ready to try" is not confused with production Hermes work, production runtime skill use, or human document review being complete.

Before publishing, also use `Copy open-source safety bundle` (`複製開源安全包`). It reminds you not to commit `.paperclip-dev-config.json`, `.paperclip-dev*.log`, `paperclip-dev*.log`, `.virtual-office-preview-status.json`, or any `.env`, and to confirm the document map, `pnpm run office:verify`, and Hermes stop lines.

If you are handing the work to another collaborator, use `Copy Gate handoff` (`複製 Gate 交接`). It lists the final gate completion conditions, current blockers, and actions that must not be crossed yet. This helps avoid treating UI readiness tools as human review or a real model wake-up.

If you only need the next safe daily decision, use `Copy Gate decision` (`複製 Gate 決策`). It sorts the remaining gates into safe today, pause for evidence, and explicit-authorization-only actions so beginners do not treat Hermes install, Run now, or schedule triggers as routine checks.

If you want to know which Hermes level you are currently at, use `Copy authorization control` (`複製授權總控`). It summarizes read-only prep, command preview, guided install, configuration check, sandbox wake-up, and post-wake-up review as a status card. It is not install or wake-up authorization.

If Hermes provider / model / API key has already been filled in Hermes' own settings location, use `Copy configuration check` (`複製設定檢查`). It only collects non-sensitive status and a Test environment summary; do not paste API keys, tokens, passwords, a full `.env`, or credential-bearing logs, and do not treat it as model wake-up authorization.

If you are preparing for the first Sandbox/Test wake-up, use `Copy wake-up preflight` (`複製喚醒前檢查`). It only confirms the environment, Hermes Sandbox/Test employee, Sandbox/Test project, and user confirmation. Office may at most prefill an issue draft; it must not create it automatically, press Run now, or enable scheduling.

After a future Sandbox/Test wake-up actually finishes, use `Copy post-wake-up review` (`複製喚醒後覆盤`). It records the Hermes reply, employee state, live runs, recovery issues, and next-step decision in a fixed format. If any signal is not clean, stop before moving to a real project.

If a beginner gets stuck while following the docs, use `Copy document feedback` (`複製文件回饋`) inside the checklist. It gives them a fixed format for reporting which doc they read, where they got stuck, which sentences felt too technical, and whether the safety reminders were clear.

If you ask another beginner to review the docs, use `Copy reading prep` (`複製閱讀準備`) first. It groups the reading into first startup, open-source trial, and Hermes-before-use checks so feedback can be reviewed step by step.

If the reviewer does not write code, use `Copy beginner self-check` (`複製新手自評`). It only asks whether they can follow the steps, where they got stuck, and whether the safety stop lines are clear. They should not paste API keys, tokens, passwords, or a full `.env`, and they do not need to create an issue, run anything now, or wake Hermes.

For a quick human document review, use `Copy human review task` (`複製真人試讀任務`). It creates a 30-45 minute task card with the reading scope, safe boundaries, and a fixed feedback format.

Common UI labels for English readers:

- `檢查清單`: checklist
- `複製剩餘路線`: copy remaining roadmap
- `複製 Gate 交接`: copy Gate handoff
- `複製技能載入驗收`: copy runtime skill check
- `複製技能同步 E2E`: copy skill sync E2E
- `複製技能交接`: copy skill handoff
- `複製文件回饋`: copy document feedback
- `複製閱讀準備`: copy reading prep
- `複製真人試讀任務`: copy human review task
- `複製新手自評`: copy beginner self-check
- `複製開工檢查`: copy daily start check
- `複製預覽求助`: copy preview help
- `複製啟動安全包`: copy startup safety bundle

## Documentation Map

Open these files by purpose:

- `docs/virtual-office-getting-started.zh-TW.md`: Chinese beginner guide for the first walkthrough.
- `docs/virtual-office-getting-started.en.md`: English beginner guide.
- `docs/virtual-office-quick-start.zh-TW.md`: short Traditional Chinese launcher guide.
- `docs/virtual-office-quick-start.en.md`: short English launcher guide.
- `docs/virtual-office-open-source-readme.zh-TW.md`: Chinese open-source overview.
- `docs/virtual-office-open-source-readme.en.md`: English open-source overview.
- `docs/virtual-office-public-status.zh-TW.md`: public progress status, separated from local journals and private handoff notes.
- `docs/virtual-office-public-commit-scope.zh-TW.md`: Traditional Chinese public commit scope and local-only exclusion list.
- `docs/virtual-office-public-commit-scope.en.md`: English public commit scope and local-only exclusion list.
- `docs/virtual-office-pr-submission-plan.zh-TW.md`: Traditional Chinese PR submission package draft with file scope, PR text, and final checks.
- `docs/virtual-office-pr-submission-plan.en.md`: English PR submission package draft.
- `docs/virtual-office-pr-screenshot-evidence.zh-TW.md`: Traditional Chinese PR screenshot evidence SOP.
- `docs/virtual-office-pr-screenshot-evidence.en.md`: English PR screenshot evidence SOP.
- `docs/virtual-office-pr-final-review.zh-TW.md`: Traditional Chinese final PR review for commit scope, local-only exclusions, and human-review items.
- `docs/virtual-office-pr-final-review.en.md`: English final PR review.
- `docs/virtual-office-acceptance-checklist.zh-TW.md`: feature acceptance and design-fit tracking.
- `docs/virtual-office-startup-sop.zh-TW.md`: Traditional Chinese startup and preview recovery flow.
- `docs/virtual-office-startup-sop.en.md`: English startup and preview recovery flow.
- `docs/virtual-office-hermes-sop.zh-TW.md`: Hermes local model setup, environment checks, and sandbox wake-up flow.
- `docs/virtual-office-routine-safety.zh-TW.md`: Chinese Routine / schedule safety notes.
- `docs/virtual-office-routine-safety.en.md`: English Routine / schedule safety notes.
- `docs/virtual-office-release-decision.zh-TW.md`: Traditional Chinese open-source trial release Go / Pause SOP.
- `docs/virtual-office-release-decision.en.md`: English open-source trial release Go / Pause SOP.
- `docs/virtual-office-release-notes-draft.zh-TW.md`: Traditional Chinese open-source release notes draft.
- `docs/virtual-office-release-notes-draft.en.md`: English open-source release notes draft.
- `docs/virtual-office-feedback-triage.zh-TW.md`: Traditional Chinese open-source feedback triage SOP.
- `docs/virtual-office-feedback-triage.en.md`: English open-source feedback triage SOP.
- `docs/virtual-office-maintainer-daily.zh-TW.md`: Traditional Chinese maintainer daily SOP.
- `docs/virtual-office-maintainer-daily.en.md`: English maintainer daily SOP.
- `docs/virtual-office-feedback-to-work-items.zh-TW.md`: Traditional Chinese feedback-to-work-items SOP.
- `docs/virtual-office-feedback-to-work-items.en.md`: English feedback-to-work-items SOP.
- `docs/virtual-office-first-contribution.zh-TW.md`: Traditional Chinese first contribution SOP.
- `docs/virtual-office-first-contribution.en.md`: English first contribution SOP.
- `docs/virtual-office-pr-review.zh-TW.md`: Traditional Chinese PR review SOP.
- `docs/virtual-office-pr-review.en.md`: English PR review SOP.

## Recommended Preview Command

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

For daily safety checks, prefer:

```powershell
pnpm run office:check
```

Continue only after Backend OK and Frontend OK are both shown.

To run UI typecheck, acceptance sync, documentation checks, and preview health together, use:

```powershell
pnpm run office:verify
```

If the preview is stuck after a reboot, open the Office starter console and use `Copy startup safety bundle` in the `Preview service` section. It bundles the daily start check, preview help prompt, status report review template, and preview failure decision table for Codex.

## Before A Beginner Installs

For a first open-source trial, check:

- Required: Node.js and pnpm work, the Paperclip repository is downloaded, frontend/backend preview can open, and heartbeat is disabled first.
- Safe to skip at first: actually waking Hermes, creating production workflows, syncing skills to production employees, and terminating or cleaning production data.
- If stuck: run the startup preview SOP, check whether health is OK, confirm there are no stale backend processes, and paste the screen plus error into the acceptance record.

Beginner-safe prompt to paste into Codex:

```text
Please follow docs/virtual-office-getting-started.en.md and docs/virtual-office-startup-sop.en.md to check Virtual Office. Start with health checks and safety explanation only. Do not delete the database, do not create or modify data, and do not wake Hermes.
```
