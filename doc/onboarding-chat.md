# Starting in chat

Finishing company onboarding opens the new agent's standing chat. It creates no
execution task or project. Chat uses the existing owner-bound conversation record
and is excluded from task collections. Existing onboarding tasks remain readable.

The wizard prepares the conversation before navigating. After its content paints
in a visible tab, the UI requests a live welcome through the normal agent queue.
Hidden tabs wait for visibility. Unmount cancels an unsent request. A database
advisory lock and durable wake receipts prevent concurrent requests and refreshes
from starting duplicate welcomes; failed attempts can be retried. A user message
or a new conversation session supersedes a welcome that has not started.

The welcome receives the organization, company goals and any Cloud signup idea.
Cloud seeds retain initial task titles/details as context without creating or
editing projects and tasks. Existing seed task references are preserved.

Subsequent chat turns gather a goal and clear exit criteria. The agent offers an
interview and starts one only when requested; ordinary conversation works too.
It proposes scoped work through `suggest_tasks`. Recorded acceptance creates the
selected tasks through the existing atomic handoff. An explicit task-creation
request can create work directly. Project selection, budgets and hiring gates
retain their normal authority. The conversation remains available after handoff.
