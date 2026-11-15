# Integration API notes

Small API contracts that integrations and agents rely on.

## Task document bodies

The native `write_document` tool preserves the supplied Markdown body, including
leading whitespace, hard-break spaces, line endings, and final newlines. It still
requires a nonblank body and normalizes key/title fields. `write_task_document`
and REST document PUT also retain surrounding whitespace. Those REST-backed
paths keep their existing escaped-line-break normalization: a body with no real
line breaks can have literal `\n` sequences converted to newlines.

## Starting a prepared task

An integration can create a task in `backlog`, save its initial documents, and
then promote it with `PATCH /api/issues/{id}`. Send exactly
`{ "status": "todo", "expectedStatusVersion": N }`, using the `statusVersion`
from the task whose initialization the integration owns. Capture that version
on a server that already advertises this guard, before preparing the task.
Older servers did not track every assignment path; reconcile older initialization
intents instead of promoting them automatically after an upgrade. The server checks the
version and backlog state under the task row lock. A status or assignment change
returns `409` with `details.code: "issue_status_version_changed"`; mixed mutation
fields return `422`. The guard is optional and applies only to this promotion.
It does not provide a general conditional lifecycle or execution-control API.
Assignment changes advance the revision at the database boundary, including
release, administrative release, and direct service writes. A no-op assignment
keeps the revision. Migration 0358 adds this trigger without rewriting tasks.

Persist the original version with the integration's initialization intent so a
later retry cannot override a person's intervening decision. A caller still needs
the ordinary company, task, assignment and run permissions. Do not retry an
uncertain write until the saved task and initialization state are reconciled.

## Agent Invite Onboarding Endpoints

Agent-oriented invite onboarding now exposes machine-readable API docs:

The board UI generates agent onboarding prompts from the add-agent modal (`+` in the agent sidebar), so agent onboarding sits with the rest of agent creation rather than company member invite settings.

- `GET /api/invites/:token` returns invite summary plus onboarding and skills index links.
- `GET /api/invites/:token/onboarding` returns onboarding manifest details (registration endpoint, claim endpoint template, skill install hints).
- `GET /api/invites/:token/onboarding.txt` returns a plain-text onboarding doc intended for both human operators and agents (llm.txt-style handoff), including optional inviter message and suggested network host candidates.
- `GET /api/skills/index` lists available skill documents.
- `GET /api/skills/paperclip` returns the Paperclip heartbeat skill markdown.

Hermes gateway agents use this same generic agent invite flow with
`adapterType=hermes_gateway` and `agentDefaultsPayload.apiBaseUrl` /
`agentDefaultsPayload.apiKey`. See
[HERMES_GATEWAY_ONBOARDING.md](./HERMES_GATEWAY_ONBOARDING.md) for the full
operator path, including Hermes credentials, invite approval, key claim, and
fresh-state Docker smoke setup.

## Actionable attention projection

The attention feed, summary and task-index APIs accept `actionableOnly=true`.
That projection includes questions, decisions, approvals, access requests,
stalled reviews and recovery requests with supported resolution controls.
Technical recovery requests remain eligible when an operator can resolve them
through those controls. Notifications that only link to an agent or describe an
automatic recovery are left out. The coordinator Inbox does not request this
projection: it also shows failed runs, budget alerts and blocked tasks, which
have their own controls on the Inbox cards but are not part of the actionable
set. Completed and cancelled dependencies are not presented as current blockers.

A recovery card with supported choices resolves in place through the recovery
resolver; other recovery cards keep their link to the recovery. Inbox controls
use the existing domain APIs and retain their company, permission, governance
and execution ownership checks. A rejected action remains visible with the
server's reason; opening an agent page or dismissing a notice does not certify
process cleanup or authorize replay of interrupted work.
