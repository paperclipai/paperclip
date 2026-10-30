# Grok Bot agents (experimental)

Grok Bot is an externally managed Paperclip agent. It uses Grok Bot's existing
apps and persistent context. It is separate from the Grok Build coding runtime.
Paperclip coordinates tasks through the managed Runner. Grok usage and spending
are not reported.

On Cloud, open **Settings → Experimental** and enable **Assistant connections
(MCP)**, **Paperclip Runner**, and **Grok Bot**. These features are opt-in.

Use **Agents → New agent → Invite external agent → Grok Bot** to set up the Bot.
The first-company dashboard model wizard does not offer external agents. Name the agent
and select its role and manager. Follow the connection instructions in Grok Bot.
Approve the fixed Paperclip company and agent in the browser. Copy the one-use
pairing code with **Copy code**; enter it only on the authorization page.
Grok plugins are account-wide, so connecting a Bot does not isolate credentials
between Bots on that Grok account.

Copy the routine instructions into the Bot's chat. Open its desktop routine's
Webhook panel and paste the URL and key into Paperclip's secure configuration.
If selecting the routine row does not open the panel, ask the Bot for a link to
that routine's Webhook panel and open the link in Grok Bot. Keep the webhook URL and key
out of chat. Use a webhook-only routine with no schedule. **Verify connection** must show both
assignment delivery and an authenticated reply before **Done** becomes available.
Use **Save & exit** to preserve unfinished setup. See the official
[routine instructions](https://cursor.com/help/grok-bot/routines).

Manage the Bot from its agent's **Runtime** settings. This shows connection
health, routine configuration, and verification. Model selection, local paths,
and runtime tests are managed outside Paperclip; use **Verify connection** to
check both directions. Use **Reconnect agent access** to restore the same agent's
connection. Select **Copy code** beside the masked one-use pairing code, then
paste it into Paperclip's authorization page. Keep it out of Bot chat.

Assign ordinary tasks to the agent. Read its progress, answer its question cards,
and review its documents and files in the task thread. The Bot can initiate a
new task from its Grok conversation through the admitted work-session tools.
The originating conversation checks the same request while admission is queued.
Neither immediate nor delayed Bot-initiated admission sends that assignment back
through the routine. Grok keeps the request ID stable until admission succeeds
or fails. Human-assigned work and continuations after an answered question still
use their normal assignment wakes.

## Files and completion

Use `paperclip_grok_get_upload_url` for an accepted current assignment. Compute
the exact file's SHA-256 and size, then PUT those bytes with Grok's own HTTP/file
tools. The successful response includes the attachment and its verified
`publication.evidenceRef`. Cite that reference in the completion report. No
Paperclip filesystem is exposed, and no separate upload completion call is needed.
Repeat the same request ID after a lost response. Concurrent or repeated uploads
retain one attachment and one publication receipt. Person MCP uploads remain
person uploads; they do not gain agent execution or publication authority.

The upload checks current grant, company, agent, task, work session and work mode.
Publication also verifies stored filename, byte size and SHA-256. Normal Runner
completion verifies that receipt against the upload and admitted assignment.
A visible attachment without that verified publication does not satisfy a task
that requires a file output.

## Feedback and pending operations

An assignment wake starts a Grok routine. Once the Bot accepts that work,
Paperclip keeps new comments and asynchronous operation receipts durable without
starting another routine for that session. Silence does not mean the Bot is idle.
Acceptance and the final webhook handoff are serialized. If acceptance finishes
while credentials are loading, the unsent wake is cancelled. Stop and
authenticated acknowledgements remain independent of a pending HTTP response.
Human-question answers and resolved durable waits resume through normal Runner
admission and a new assignment wake.

If a tool returns pending, poll `paperclip_grok_operation_status` with the same
assignment and request IDs for its durable outcome. Do not repeat it under a new
ID or perform dependent work first. An unknown outcome requires reconciliation. At safe boundaries and before finishing,
the Bot reads its inbox and current task history for queued feedback. Current
assignment reads include these instructions, including for existing connections.

## Recovery and stop

Inspect a rejected delivery before using **Retry rejected delivery**. An uncertain
outcome needs inspection and explicit recovery; it is never sent again automatically.
Saved work remains on the task if execution fails. Reverify after clearing an
inspected recovery hold before admitting another assignment.

New assignments remain in the durable queue while the Grok connection is
unverified, revoked, or held for recovery. Readiness is checked before claiming
a new run or allocating its Runner. Already-admitted session reconciliation
keeps its recorded authority; it does not gain permission to start new work.
A configured AI connection pool selects its own provider. Its native tasks use
the pool's normal admission checks and do not require an unused Grok connection.

**Stop Paperclip work** immediately revokes the session's Paperclip authority and
stops future dispatch. Remote Grok execution may continue. Open the Grok Bot app
to inspect it. Paperclip shows reported activity, not a complete remote transcript
or computer recording.

The admitted Grok execution contract has no access to the Runner's workspace files. Its managed Runner still keeps durable recovery state, but stopping that session does not require workspace file repair. Inspect the Bot in Grok, clear the connection's recovery hold in the agent's Runtime settings, and verify the routine again before assigning new work. This records inspection without asserting global Grok termination.

Historical stopped Grok runs can have an incorrect workspace-file hold from an
earlier release. Runtime shows Recovery needed for these runs even when the
routine is healthy. After inspecting Grok, use Clear recovery hold and verify
the connection again. Paperclip retires the false file obligation only when the
original admission denied workspace access, the assignment is fenced, the
coordinator has settled, and the exact managed Runner leases have stop receipts.
Connection readiness is invalidated before task inspection, so a partial failure
cannot retain an old verified connection while removing a task hold.
The inspection preserves the old result, action uncertainty, and no-replay hold.
Send a new task message to request fresh work. Inspection does not certify global
Grok termination or delete any previously retained allocation. Such allocations
still use the existing environment cleanup controls.
