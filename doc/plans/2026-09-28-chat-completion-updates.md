# Return completed work to its originating chat

## Summary

When an agent hands off work from Agent Chat, Paperclip will bring the finished result back to that conversation automatically. The original agent will write the update using the task’s recorded status and saved output.

Report tasks as they finish. Combine completions already waiting for the same reply. A `/new` reset suppresses updates from the previous conversation session.

The merged completion-update evals are the baseline. This change should turn the missing-update cases green and address the stale onboarding replies.

This behavior applies to Agent Chat handoffs and the onboarding completion-update fix below, not all agent handoffs in general. It uses the existing Agent Chat availability setting and adds no separate experimental flag.

## Implementation

**Record the handoff automatically.**

- Add a durable, company-scoped handoff record linking the created task to the source conversation, its session generation, and its agent.
- Capture it inside task creation using the authenticated creating run. Both native `create_task` and HTTP task creation already supply that context. Do not rely on the model to provide a source ID.
- Keep execution tasks as ordinary project tasks. Do not turn the conversation into their parent or block it on their completion.
- Preserve existing creation idempotency: replaying task creation must not create another handoff.

**Queue completion durably.**

- Create a completion-delivery record in the same transaction that moves a linked task into Done. Cover both ordinary issue updates and native status-decision commits.
- Identify each event by the handoff and committed completion transition. Repeating the same transition must not create duplicate deliveries.
- Use a small database-backed outbox, following the existing delivery-service pattern. Process it immediately after commit and through startup and periodic recovery.
- Reopening a task before delivery supersedes its pending completion. Completing it again creates a new event.
- Start with newly created handoffs. Do not backfill historical tasks or emit old completion notices.

**Run an agent-authored follow-up.**

- Add a dedicated completion wake reason in `server/src/services/agent-conversations.ts` and `server/src/services/heartbeat.ts`.
- Wake an idle conversation. If a reply is underway, queue a subsequent turn; never treat an update to the running turn’s stored context as delivery.
- At turn start, collect pending completions for that conversation session. Completions arriving after that point wait for another turn.
- Supply current task status, task links, saved deliverable references, and bounded result content. Keep task output separate from trusted instructions.
- Tell the agent to explain what finished and provide access to the result. Do not prescribe canned wording or authorize additional execution.
- Use the existing conversation response path. Record delivery against the persisted agent reply, not merely an enqueued or successful run.

**Handle recovery and onboarding.**

- Carry delivery IDs through wakeups, retries, and response persistence. Before retrying, check for an already-published reply; make publication and delivery acknowledgement atomic.
- Use leased claims and bounded retries following existing delivery conventions. Retain exhausted failures for diagnosis.
- Check the conversation’s session generation before scheduling and publishing. Suppress old-session deliveries after `/new`.
- Add `issue_children_completed` to the existing follow-up scheduling rule so onboarding completion cannot disappear into an active parent run. Refresh completion facts when that follow-up starts. Apply this scheduling change to onboarding flows; preserve existing scheduling for other handoffs.
- Preserve company access, agent permissions, budgets, and pause controls. Result delivery must not broaden general access to other tasks.

No new user-facing tool, notification settings, onboarding option, or UI component is required. Add the database migration and synchronized internal types; preserve existing public task-creation inputs.

## Tests and evals

**Deterministic service and integration tests**

Cover both task-creation paths and both completion paths, including:

- Idle versus actively replying conversations.
- Multiple pending completions combined without losing task identities.
- Duplicate events, concurrent dispatchers, and restart recovery.
- Crashes before dispatch and after reply persistence.
- `/new`, task reopening, cross-company inputs, and paused agents.
- Onboarding child completion during an active parent turn.
- Existing Agent Chat availability controls and unaffected behavior for other agent handoffs.

**Product E2E evals**

Extend the explicit `completion-updates` suite for native Claude and Codex:

- Retain the existing onboarding and idle-handoff stories.
- Add completion during an active chat reply, multiple-task completion, and interrupted completion-reply recovery.
- Establish each timing boundary with observable run state and bounded fixture gates. Use real browser/API actions; do not inject completion messages or edit database state.
- Require durable Done status, saved output, an unsolicited source reply, working result access, and no duplicate completion update.

Add a separate completion-accuracy grader using the existing pinned judge infrastructure. It must cite recorded evidence and reject stale promises such as “the work will run next” after completion. Calibrate it against accurate replies, stale replies, unsupported claims, and later corrections. Missing judge evidence leaves accuracy unqualified; it cannot override a mechanical failure.

Run the selected cells in GitHub Actions. Preserve source revisions, grader versions, attempts, timing, cleanup, and cost coverage. Require two consecutive complete campaigns to pass delivery, access, and accuracy before calling this scope qualified.

## Rollout and defaults

- Enable completion follow-ups wherever Agent Chat is already enabled; leave native-runner onboarding selection unchanged.
- Report Done transitions only. Progress, blocked, failed, and cancelled notifications remain outside this change.
- Report each task as it finishes, combining already-pending completions without an artificial batching delay.
- Suppress old-session updates after `/new`; keep tasks and results intact.
- Record pending, delivered, superseded, and exhausted events in instance-local diagnostics.
- Submit a separate product PR with unit/integration coverage, live eval reports, and passing merge checks. The previously merged eval baseline remains the red reference.

## Implementation security refinement

Completion input carries server-recorded task identifiers, Done status, timestamps,
and result links. Worker-authored titles, document bodies, and comments are not
copied into the source agent's prompt; the result remains on the linked task.
Tool authority and provider permissions retain their normal configured defaults.
The original agent writes the completion reply from these facts and its existing
conversation context. Evals independently read the saved output and grade the
reply's truthfulness and result access.
