# Virtual Office Routine / Schedule Safety

This note is for people using Virtual Office for the first time. Routines can help AI employees summarize progress, remind blockers, and create review records. They can also create work or wake agents later, so the first Virtual Office flow is intentionally conservative.

## Safe Things To Do First

- View the Routine / schedule safety panel on the Office page.
- Copy the schedule preflight checklist and paste it into a note or issue.
- Prefill a Sandbox routine draft and review the title and description.
- Open the existing Routines page to inspect schedule status and recent runs.
- Run one manual test only inside a Sandbox/Test project, after checking the safety confirmation.

## What Office Does Not Do Automatically

- It does not create a routine directly from the Office page.
- It does not add cron, webhook, or API triggers automatically.
- It does not press `Run now` automatically.
- It does not assign Hermes or another local-model employee automatically.
- It does not enable the heartbeat scheduler.

## Before Creating A Draft

Make sure the routine title or description includes Sandbox, Test, or Virtual Office. This lets the UI recognize it as a safe test routine and show the safety gates before adding triggers or running it manually.

Good first routines are low-risk routines such as:

- Daily progress summary
- Weekly review meeting
- Blocker reminder

Do not start by letting a routine modify production data, create production work, or wake production employees.

## Before Adding A Trigger

Adding a trigger means the routine may fire automatically later. Confirm:

- The project is Sandbox/Test.
- The assigned employee is not doing production work.
- The trigger frequency is not too aggressive.
- The description includes clear stop conditions.
- You know where to pause or delete the trigger.

Virtual Office routine detail pages require a Sandbox/Test confirmation before adding a trigger.

## Before Pressing Run Now

`Run now` creates an immediate routine execution. Confirm:

- This run uses test data only.
- The prompt does not include API keys, tokens, passwords, or private data.
- The task asks the agent to report understanding first, not directly modify files or production work.
- You know where to review recent runs and related issues afterward.

Both the Routines list and Routine detail page show a safety confirmation before running a Virtual Office routine.

## After The Test

Leave a short review record with:

- Routine name
- Trigger type
- Assigned employee
- Whether an issue was created
- Whether a recovery issue appeared
- Whether user intervention was needed
- Next step: keep, change, pause, or delete

## When To Connect Hermes

Only connect Hermes or another local model to routines after these are stable:

- Backend and frontend preview are healthy.
- Sandbox/Test projects can be created and reviewed safely.
- Routine trigger and `Run now` safety gates pass acceptance checks.
- Hermes WSL bridge, model name, and API key status are confirmed.
- The first wake-up still targets only a Sandbox/Test issue.

The Virtual Office rule is: help beginners understand, check, and stop safely before moving into automation.
