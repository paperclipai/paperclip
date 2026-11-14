# Paperclip MCP Server

Model Context Protocol server for Paperclip.

This package is a thin MCP wrapper over the existing Paperclip REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `PAPERCLIP_API_URL` - Paperclip base URL, for example `http://localhost:3100`
- `PAPERCLIP_API_KEY` - bearer token used for `/api` requests
- `PAPERCLIP_COMPANY_ID` - optional default company for company-scoped tools
- `PAPERCLIP_AGENT_ID` - optional default agent for checkout helpers
- `PAPERCLIP_RUN_ID` - legacy startup metadata; not a write-header fallback

Inside an active heartbeat, Paperclip also injects `PAPERCLIP_RUNTIME_TOOLS_*` variables. They enable the run-scoped `connections_search` and `connection_request` tools and expire with the run.

## Usage

```sh
npx -y @paperclipai/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @paperclipai/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Run-scoped connection tools:

- `connections_search`
- `connection_request`

Read tools:

- `paperclipMe`
- `paperclipInboxLite`
- `paperclipListAgents`
- `paperclipGetAgent`
- `paperclipListIssues`
- `paperclipGetIssue`
- `paperclipGetHeartbeatContext`
- `paperclipListComments`
- `paperclipGetComment`
- `paperclipListIssueApprovals`
- `paperclipListDocuments`
- `paperclipGetDocument`
- `paperclipListDocumentRevisions`
- `paperclipListProjects`
- `paperclipGetProject`
- `paperclipGetIssueWorkspaceRuntime`
- `paperclipWaitForIssueWorkspaceService`
- `paperclipListGoals`
- `paperclipGetGoal`
- `paperclipListApprovals`
- `paperclipGetApproval`
- `paperclipGetApprovalIssues`
- `paperclipListApprovalComments`

Write tools:

- `paperclipCreateIssue`
- `paperclipUpdateIssue`
- `paperclipCheckoutIssue`
- `paperclipReleaseIssue`
- `paperclipAddComment`
- `paperclipSuggestTasks`
- `paperclipAskUserQuestions`
- `paperclipRequestConfirmation`
- `paperclipUpsertIssueDocument`
- `paperclipRestoreIssueDocumentRevision`
- `paperclipControlIssueWorkspaceServices`
- `paperclipCreateApproval`
- `paperclipLinkIssueApproval`
- `paperclipUnlinkIssueApproval`
- `paperclipApprovalDecision`
- `paperclipAddApprovalComment`

Escape hatch:

- `paperclipApiRequest`

`paperclipApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.

## Per-call run context

A long-lived stdio server can handle multiple Paperclip runs. Pass the current
Paperclip heartbeat run UUID as `paperclipRunId` on each tool call; do not reuse
a startup run ID for later runs. For example:

```json
{
  "name": "paperclipUpdateIssue",
  "arguments": {
    "issueId": "EXAMPLE-1",
    "status": "done",
    "paperclipRunId": "11111111-1111-4111-8111-111111111111"
  }
}
```

`paperclipCreateIssue`, `paperclipUpdateIssue`, `paperclipAddComment`, and
`paperclipCheckoutIssue` require this argument in their schemas. Other tools
accept it as an optional argument, but any underlying HTTP write still requires
it and fails locally if absent. Reads remain usable without it. The control
argument is removed before API request bodies are built and is forwarded only
as `X-Paperclip-Run-Id`. Parallel calls keep independent async contexts; the
startup client configuration is never mutated. Backend authentication and
checkout/run ownership checks remain authoritative.

**Migration:** callers that previously relied on `PAPERCLIP_RUN_ID` at server
startup must pass the current run UUID explicitly on every write. The startup
value is no longer used as a header fallback. This is an intentional breaking
change for write callers; API authentication and read calls are unchanged.

Task-watchdog mutation grants require a signed agent JWT whose `run_id` matches
the request header. An agent API key with a caller-selected run ID cannot
activate that grant. Ordinary run context does not authenticate a caller or
prove that a run is still active; normal server authorization remains required.
