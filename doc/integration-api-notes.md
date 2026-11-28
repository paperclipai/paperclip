# Integration API notes

Small API contracts that integrations and agents rely on.

## Task document bodies

The native `write_document` tool preserves the supplied Markdown body, including
leading whitespace, hard-break spaces, line endings, and final newlines. It still
requires a nonblank body and normalizes key/title fields. `write_task_document`
and REST document PUT also retain surrounding whitespace and share a maximum body
length of 524,288 characters. These paths normalize literal `\n` sequences to
newlines when the body contains no real line breaks. ACPX allows up to 480 KiB
for the encoded cross-task document tool payload, including JSON escaping
and call metadata. For larger bodies within the document limit, use the REST
document PUT endpoint directly.

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
