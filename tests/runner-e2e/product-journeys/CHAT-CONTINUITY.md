# Chat reload and session continuity

`chat-continuity` is a deployment-targeted Product E2E journey. It uses the
ordinary Agent Chat composer on a fresh, campaign-owned native agent. It does
not restart a persistent Cloud instance or alter a shared source agent.

The first exchange contains a random phrase. After leaving the chat, reopening
it and reloading, the next message asks for that phrase without supplying it.
The independently attributed reply must contain the phrase, and both native
turns must retain the same session identity.

The user then sends the ordinary `/new` command. Paperclip preserves the same
backing chat and saved history while advancing `conversationSessionGeneration`
from zero to one. The final request does not reveal the remembered phrase. Its
reply must use the fresh-context marker, with a different native session, no
prior session on admission, and no old phrase in the new native task context.
Saved history is not removed or rewritten by the fixture.

Every reply is read from the actual rendered chat after reload using the
existing run-bound native reply oracle. Board-user messages must each persist
exactly once and bind to exactly one observed run. The original comments remain
unchanged through the final reload. The owned agent must create no extra task,
project or teammate.

The closed accounting contract is **three successful native provider turns
plus one synthetic reset row**, four persisted run IDs in total. The reset must
have its normal reset receipt and must not publish an assistant response.
It is not counted as an additional provider turn. Source model, provider and
managed environment must match all three native turns. The target provider owns
authentication, the disposable agent, pre-send chat ownership, complete run and
usage collection, stopping and evidence-first cleanup. Unknown setup or model
cost remains unknown; a run limit is not proof of an absolute spend limit.

This case covers browser reload/reopen and explicit session reset. Controller
restart remains covered by the separate existing Agent Chat journeys. Local
oracle and catalog checks do not establish a staging pass; daily admission
requires the actual original staging attempt and complete cleanup evidence.
