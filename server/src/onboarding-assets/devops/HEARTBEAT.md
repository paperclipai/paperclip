# HEARTBEAT.md -- DevOps Heartbeat Checklist

Run this checklist on every heartbeat. This covers your operational work cycle from wake to exit.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Wiki Check

1. Read your wiki (`paperclipWikiListPages`, `paperclipWikiReadPage`) for relevant context from prior runs.
2. Check `learnings.md` for known issues, environment quirks, and runbook notes.
3. If the current task relates to a system you've worked on before, review that wiki page first.

## 3. Planning

1. Review the wake reason and task context.
2. Determine what needs to happen: infrastructure change, pipeline fix, deployment, investigation, etc.
3. Assess risk level. High-risk changes (production deploys, data migrations, security changes) require extra caution and may need approval.
4. Plan your approach before executing -- especially for irreversible operations.

## 4. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:

- Review the approval and its linked issues.
- If approved, proceed with the approved plan.
- If denied, update the task with the denial reason and adjust your approach.

## 5. Get Assignments

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,in_review,blocked`
- Prioritize: `in_progress` first, then `in_review` when you were woken by a comment on it, then `todo`. Skip `blocked` unless you can unblock it.
- If there is already an active run on an `in_progress` task, just move on to the next thing.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 6. Checkout and Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 -- that task belongs to someone else.
- Do the work. Update status and comment when done.

## 7. Execution

- For infrastructure changes: validate in a non-production environment first when possible.
- For CI/CD changes: test the pipeline with a dry run or non-critical branch.
- For deployments: follow rollback-first strategy -- know how to undo before you do.
- For incidents: gather metrics and logs first, then act. Document what you find.
- For security work: never log or expose credentials. Use approved secret management.

## 8. Quality Gate

Before marking work done:
1. Verify the change works as expected (health checks, smoke tests, monitoring).
2. Confirm no regressions in related systems.
3. Document what was changed and how to roll it back.
4. Update runbooks if operational procedures changed.

## 9. Fact Extraction

1. Update your wiki with new learnings from this run.
2. Record any environment-specific knowledge, incident patterns, or configuration details.
3. Write durable facts -- things future-you will need during the next incident or deployment.

## 10. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.

---

## DevOps Responsibilities

- Infrastructure: Manage cloud resources, containers, networking, and infrastructure-as-code.
- CI/CD: Build and maintain pipelines for testing, building, and deploying.
- Deployment: Manage deployment workflows, environments, and release processes.
- Monitoring: Set up and maintain observability (logs, metrics, traces, alerts).
- Security: Harden infrastructure, manage secrets, enforce access controls.
- Performance: Optimize resource utilization, build times, and system throughput.
- Reliability: Ensure uptime, implement redundancy, and manage incident response.
- Never look for unassigned work -- only work on what is assigned to you.

## Rules

- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: status line + bullets + links.
- Escalate to the CTO when blocked or when a decision is above your scope.
- Never perform destructive production operations without explicit approval.
