# Virtual Office Open-Source Release Notes Draft

Use this draft when sharing Virtual Office with friends, GitHub readers, or open-source testers for the first time. This is a trial-use announcement, not a claim that the ideal version is complete, and not authorization to install Hermes, press Run now, enable schedules, or wake a model.

## One-Liner

Virtual Office is a 2.5D beginner-friendly workbench on top of Paperclip that helps people understand and manage AI agents as employees, skills, projects, workflows, meetings, and schedule-safety states.

## Ready For Trial Use

- 2.5D office overview: employees, projects, workflows, meetings, and recent activity.
- Starter console: create employees, install skills, create workflows, open discussion tasks, and view the checklist.
- Project and workflow drafts: plan phases, owners, upstream/downstream dependencies, or parallel work.
- Meeting and review records: keep context, decisions, unresolved questions, and next steps.
- Routine / schedule safety notes: start with Sandbox/Test drafts and do not auto-run.
- Startup and preview recovery SOP: check Backend / Frontend after reboot with a repeatable flow.
- Hermes Sandbox/Test runtime capability key proof: `AI-98530` proved the model can see and return 7 exact Paperclip runtime capability keys.
- Ordinary Sandbox/Test plan task: `AI-98533` proved Eve / Hermes local can produce a readable design comment, return to paused/manual, and leave no active/live run.
- Open-source feedback paths: issue form, PR checklist, CONTRIBUTING, SECURITY, and document-review templates.

## Still Gated

- Production runtime skill use: `AI-98530` provides Sandbox/Test evidence, but production employees or projects still need separate safe validation.
- Production Hermes / local model work: `AI-98533` provides Sandbox/Test evidence, but production work still needs a specific issue, specific agent, and new verbatim one-time authorization.
- Human documentation review: Chinese UI label mapping and safety reminders have user confirmation; English docs still need feedback from an English reader or someone comfortable reading English.
- Any next Hermes / local model wake-up: still requires a specific issue, specific agent, and new verbatim one-time authorization.

## Safety Stop Lines

- Do not paste API keys, tokens, passwords, a full `.env`, full logs, private paths, or production data.
- Do not delete the database, manually delete lock files, or remove local files you do not understand.
- Do not treat issues, PRs, doc checks, or review feedback as Hermes install or wake-up authorization.
- Do not press Run now, enable schedule triggers, or wake a model before Sandbox/Test boundaries are clear.

## Suggested Trial Flow

1. Run `pnpm run office:verify`.
2. Open `http://localhost:5173/AI/office`.
3. Read the checklist and open-source guide before pressing data-changing buttons.
4. If you get stuck, use `.github/ISSUE_TEMPLATE/virtual-office.yml` or `Copy issue report` inside Office.
5. If you are only reviewing docs, use `Copy evidence log` to record whether each reader understood the first safe step and stop lines.

## Helpful Feedback

- Operating system and whether this is your first time using Paperclip / agents / local models.
- Backend / Frontend status.
- Stuck step and short error summary.
- Sentence, button, or flow that was unclear.
- Any place that made you think you should paste secrets, delete the database, press Run now, enable schedules, or wake Hermes.
