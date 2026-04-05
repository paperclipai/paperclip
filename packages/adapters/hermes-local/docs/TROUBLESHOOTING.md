# Troubleshooting

This document is written for both humans and autonomous repair agents.

## Fast triage checklist

1. run the adapter test suite
2. run the adapter environment test in the Paperclip host
3. verify Hermes CLI works directly
4. verify model detection from `~/.hermes/config.yaml`
5. verify the child environment contains `PAPERCLIP_API_KEY`
6. inspect whether the run was resumed against an invalid session
7. inspect whether the host passed wake context in `ctx.context`

## Symptom: Hermes starts but cannot call Paperclip API

Check:

- `ctx.authToken` exists in the host
- `buildExecutionEnv()` is actually being used
- the child env has `PAPERCLIP_API_KEY`
- the prompt examples include `Authorization: Bearer $PAPERCLIP_API_KEY`

## Symptom: agent ignores assigned task and behaves like heartbeat scan

Check:

- `taskId`, `taskTitle`, `taskBody`, `wakeCommentId`, `approvalId` exist in `ctx.context`
- the host is not incorrectly storing wake data in raw adapter config
- the prompt rendered by `buildPrompt()` includes the task block

## Symptom: resume causes repeated failure

Check:

- saved `sessionParams.cwd` versus current cwd
- Hermes session ID validity
- whether Hermes reported an unknown/missing session
- whether the adapter retried without `--resume`

The adapter intentionally retries once on stale sessions.

## Symptom: model list is empty in Paperclip UI

Check:

- `listHermesModels()` works when called directly
- the host registry actually wires `listModels`
- `~/.hermes/config.yaml` exists and contains `model.default` or configured model entries
- `HERMES_HOME` is not pointing at the wrong profile

## Symptom: bundled skills never appear in Hermes

Check:

- `syncHermesSkills()` was called by the host
- `HERMES_HOME` / resolved Hermes home is correct
- filesystem permissions for `~/.hermes/skills`
- bundled skill source files exist in the package under `skills/`

## Symptom: native Hermes skills disappeared after Paperclip sync

Check:

- whether a Paperclip-managed skill collided with the same friendly runtime name
- whether the adapter fell back to a hashed runtime name instead of overwriting the native skill
- whether `listHermesSkills()` still shows the native skill entry as `user_installed`

## Symptom: hired manager cannot create a worker issue

Check:

- the rendered prompt shows `POST /api/companies/{companyId}/issues`
- the payload uses `description`, not only `body`
- the server returned a helpful error instead of a silent `404` when `/api/issues` was guessed

## Symptom: Hermes says it updated the task but the host shows `/issues/None`

Check:

- whether the run used `execute_code` instead of terminal + `curl` for the Paperclip API mutation
- whether the relevant prompt/skill text still says Paperclip mutations are terminal-only
- whether the run log contains `POST /api/issues/None/comments` or `PATCH /api/issues/None`

In real Hermes runs, `execute_code` can resolve `PAPERCLIP_*` vars as missing or `None`
even when the terminal has the correct values. The fix is to reroute those mutations
through terminal + `curl`, not to normalize `None` server-side.

## Symptom: Hermes-native skill finished but the issue is still open

Check:

- whether the loaded Hermes skill told the agent to "report", "wait", or ask for feedback
- whether the issue required an exact comment token or final `done` status that was never sent
- whether the run summary comment came from Paperclip fallback rather than the required task workflow

In Paperclip child runs, a skill's own checkpoint wording does not replace the required
issue comment and final status update steps.

## Symptom: approved worker exists but has no manager

Check:

- the approval payload still contains `reportsTo`
- `approvalService.approve()` reconciles the approved hire payload back into the pending agent row
- the live agent record after approval still has the expected `reportsTo`

## Symptom: approval wake submits a duplicate hire for an already approved agent

Check:

- the approval wake context includes `approvalType`, `approvalPayloadName`, `approvalPayloadAgentId`, and `approvalPayloadReportsTo`
- the rendered prompt shows the approved-hire reuse rule instead of only generic approval instructions
- the requester run log does not contain a second `POST /companies/{companyId}/agent-hires` after the approval wake

If these fields are missing, Hermes will often follow the original issue text
literally and recreate the hire request instead of reusing the approved agent.

## Symptom: hire request issue is marked done before board approval arrives

Check:

- the task text explicitly said to wait for approval/review after submitting the request
- the rendered prompt includes the "post progress comment but do not mark the issue done" rule
- `paperclip-create-agent` and `paperclip-runtime` skill text still carries the same waiting-state guidance

## Symptom: cronjob tool exists but schedules never fire

Check:

- `hermes cron status`
- Hermes gateway/service installation state
- whether the current Hermes home/profile is the same one used by the scheduled job
- whether the child env includes `HERMES_EXEC_ASK=1` so Hermes exposes the cronjob tool in non-interactive runs

Paperclip does not own the Hermes scheduler. If the Hermes gateway is down, background cron execution will not happen.

## Symptom: agent was told to create a native Hermes skill but cannot use it

Check:

- the skill was written under the active Hermes home, usually `$HERMES_HOME/skills/<category>/<name>/SKILL.md`
- the frontmatter `name:` matches the name the agent later passes to `skill_view`
- the agent was asked to create a new skill, not modify an existing managed Paperclip skill
- the task uses a unique skill name so Hermes does not resolve a different preexisting skill

## Symptom: transcript rendering is noisy or raw

Check:

- the host uses `parseHermesStdoutLine()`
- quiet mode choice matches actual Hermes stdout behavior
- stderr is being reclassified rather than painted as fatal errors

## Repair procedure for autonomous agents

When debugging this adapter, preferred order:

1. run unit tests
2. inspect `createHermesExecutionPlan()` output
3. inspect rendered prompt
4. inspect generated child env
5. run Hermes manually with the same CLI args
6. compare raw stdout/stderr to parser expectations
7. only then change parser/runtime logic
