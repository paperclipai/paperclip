# Chat reload and session continuity

`chat-continuity` is a deployment-targeted Product E2E journey. It uses the
ordinary Agent Chat composer on a fresh, campaign-owned native agent. It does
not restart a persistent Cloud instance or alter a shared source agent.
The agent-filtered heartbeat history must be empty before the first send.
An agent with earlier completed, failed, queued or active work is unsupported;
the fixture does not subtract or hide those runs. A target that reuses one
agent across several journeys must supply a separate fresh agent for this case.

The first exchange contains a random phrase. After leaving the chat, reopening
it and reloading, the next message asks for that phrase without supplying it.
The independently attributed reply must contain the phrase, and both native
turns must retain the same session identity.

The user then sends the ordinary `/new` command. Paperclip preserves the same
backing chat and saved history while advancing `conversationSessionGeneration`
from zero to one. The final request does not reveal the remembered phrase. Its
reply must use the fresh-context marker, with a different native session, no
prior session on admission, and no old phrase in the new native task context.
The independent run detail must include its `sessionIdBefore` column explicitly
set to `null`; a missing or empty field is not session-boundary evidence.
Saved history is not removed or rewritten by the fixture.

Every reply is read from the actual rendered chat after reload using the
existing run-bound native reply oracle. Board-user messages must each persist
exactly once and bind to exactly one observed run. The original comments remain
unchanged through the final reload. The owned agent must create no extra task,
project or teammate.

The closed accounting contract is **three successful native provider turns
plus one synthetic reset row**, four persisted run IDs in total. The reset must
have its normal reset context and a matching original `/issues/:id/runs`
summary receipt and must not publish an assistant response. That receipt binds
the request's company and issue to the same successful summary run, agent,
context issue and wake comment as the independently read detail. The raw run
detail is not rewritten. Its optional `resultJson` can be absent or compact;
an explicit contradictory reset flag is rejected. Real provider turns require
the authoritative committed `nativePhase`, not an optional duplicate result
field. Their output still requires a bound native-final event or the selected
attributed completion comment and an actual reloaded rendered reply.
The reset is not counted as an additional provider turn. Source model, provider and
managed environment must match all three native turns. The target provider owns
authentication, the disposable agent, pre-send chat ownership, complete run and
usage collection, stopping and evidence-first cleanup. Unknown setup or model
cost remains unknown; a run limit is not proof of an absolute spend limit.

The company activity request includes the exact owned agent filter before the
server's 500-row limit. Every returned row must match that company and agent,
have its canonical activity identity, and leave the response below that limit.
Mixed or truncated results fail; the client never filters a global response
into an apparent pass. Unrelated company history therefore does not limit this
fresh agent's proof, while any owned task, project or teammate creation fails.
Activity identifies the acting agent, not the created entity. Board provisioning
therefore has no agent actor even when its `entityId` is this new agent. Creation
attributed to the owned agent is rejected, including activity before the first
chat message; the fresh-agent contract does not grandfather that work.

This case covers browser reload/reopen and explicit session reset. Controller
restart remains covered by the separate existing Agent Chat journeys. Local
oracle and catalog checks do not establish a staging pass; daily admission
requires the actual original staging attempt and complete cleanup evidence.
