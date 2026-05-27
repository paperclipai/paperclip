## Wake Pre-flight (do this FIRST when woken)

Read `$PAPERCLIP_WAKE_REASON` from your environment.

If `$PAPERCLIP_WAKE_REASON` is one of these SWEEP_CLASS reasons:
- `issue_blockers_resolved_sweep`
- `issue_dependencies_blocked`

then run the short-circuit protocol below. For ANY other wake reason (`issue_assigned`, `issue_comment_mentioned`, `heartbeat_timer`, `interval_elapsed`, `execution_review_requested`, `execution_approval_requested`, `execution_changes_requested`, `source_scoped_recovery_action`, `issue_continuation_needed`, `missing_issue_comment`, `issue_monitor_recovery`, `issue_monitor_recovery_issue`, `process_lost_retry`), skip this entire section and proceed to "Execution Contract".

### Short-circuit protocol

1. `GET /api/agents/me`. Take `agent.companyId`, `agent.id`, `agent.name`. Compute `agentNameKey = agent.name.trim().toLowerCase()` (matches `normalizeAgentNameKey` at `server/src/services/heartbeat.ts:2516`).

2. `GET /api/issues/{PAPERCLIP_TASK_ID}`. Record:
   - `currentStatus = response.status`
   - `currentActivityAt = response.lastActivityAt`
   - `currentBlockedBy = response.blockedByIssueIds` (sort lexicographically)
   - `issueIdentifier = response.identifier` (e.g. "BLO-6020")
   - `issueId = response.id` (UUID)

3. `GET /api/issues/{issueId}/comments?limit=5&order=desc`. Keep the list.

4. `mcp__gbrain__get_page` with slug `paperclip/decisions/{companyId}/{agent.id}/{issueIdentifier}`.
   - 404 → fall through to "Fall-through write protocol" below, then proceed to Execution Contract.
   - hit → continue.

5. **Schema defense.** If frame missing ANY of `issueLastActivityAt`, `updatedAt`, `status`, `blockedByIssueIds`, OR any field fails to parse, treat as 404 → fall through.

6. **Compare.** Fall through if ANY of:
   - `currentActivityAt > frame.issueLastActivityAt`
   - Any comment in step 3 has `createdAt > frame.updatedAt` AND that comment's body does NOT start with `[gstack-preflight]` (skip your own marker comments — the server's comment-metadata permission gate blocks structured filtering, so body-grep is the signal)
   - `currentStatus != frame.status`
   - `currentBlockedBy != frame.blockedByIssueIds` (sorted-list compare)

7. **CALM path.** Short-circuit:

   a. `POST /api/issues/{issueId}/comments` with body:
      ```json
      {
        "body": "[gstack-preflight] frame stable since <frame.updatedAt verbatim>; sweep wake ignored."
      }
      ```
      Do NOT set `metadata` — the server rejects metadata from non-board-user callers.

   b. Re-read `GET /api/issues/{issueId}` to capture post-comment `lastActivityAt` (the comment you just posted bumped it via the DB trigger at migration `0076_issues_last_activity_at.sql`). Call this `postCommentActivityAt`.

   c. `mcp__gbrain__put_page` with the same slug, REWRITING the page. Update `issueLastActivityAt` to `postCommentActivityAt` AND `updatedAt` to current ISO 8601:
      ```yaml
      ---
      companyId: <unchanged>
      agentId: <unchanged>
      agentName: <unchanged>
      issueIdentifier: <unchanged>
      issueId: <unchanged>
      issueLastActivityAt: <postCommentActivityAt>
      updatedAt: <now ISO 8601>
      status: <unchanged>
      blockedByIssueIds: <unchanged>
      disposition: <unchanged>
      nextRefreshTriggers: <unchanged>
      ---
      <body unchanged>
      ```

   d. Exit cleanly. Do NOT proceed to Execution Contract.

### Fall-through write protocol

If any trigger fired in step 6, OR the frame was missing/malformed, you fall through. BEFORE you start the actual work, write an early frame:

8. `mcp__gbrain__put_page` with slug `paperclip/decisions/{companyId}/{agent.id}/{issueIdentifier}`:
   ```yaml
   ---
   companyId: <agent.companyId>
   agentId: <agent.id>
   agentName: <agent.name>
   issueIdentifier: <issueIdentifier>
   issueId: <issueId>
   issueLastActivityAt: <currentActivityAt>
   updatedAt: <now ISO 8601>
   status: <currentStatus>
   blockedByIssueIds: <currentBlockedBy sorted>
   disposition: pending_substantive_run
   nextRefreshTriggers: []
   ---
   # Work in progress
   Pre-flight fell through; agent is about to execute the normal flow.
   ```

This early-write guarantees the frame exists even if the substantive run dies mid-work.

After your substantive work completes (posted final comment, set final disposition, etc.), write the frame ONE MORE TIME with post-work state. Re-fetch the issue first:

9. `mcp__gbrain__put_page` with the same slug:
   ```yaml
   ---
   companyId: <agent.companyId>
   agentId: <agent.id>
   agentName: <agent.name>
   issueIdentifier: <issueIdentifier>
   issueId: <issueId>
   issueLastActivityAt: <post-work GET .lastActivityAt>
   updatedAt: <now ISO 8601>
   status: <post-work .status>
   blockedByIssueIds: <post-work .blockedByIssueIds sorted>
   disposition: <free-form snake_case, e.g. in_review_waiting_pr_188>
   nextRefreshTriggers:
     - <human-readable list of what should wake you next>
   ---
   # {agentName}'s stable decision on {issueIdentifier}
   <100-200 word prose summary>
   ```

That's the end of the pre-flight section. The Execution Contract below governs what to do once pre-flight falls through.
