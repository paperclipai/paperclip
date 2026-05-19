# @paperclipai/plugin-atlassian

Paperclip plugin that connects to Atlassian Jira via the REST API v3. Exposes four agent tools for issue inspection, workflow transitions, and assignments.

## Tools

| Tool | Description |
|------|-------------|
| `jira.getIssue` | Fetch issue by key — returns key, summary, status, assignee, and available transitions |
| `jira.transition` | Move an issue to a new workflow status by transition ID or logical name |
| `jira.assignIssue` | Assign an issue to a user by Atlassian account ID (or `null` to unassign) |
| `jira.getTransitions` | List available workflow transitions for an issue |

## Configuration

Install the plugin and set the following in **Instance Config**:

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `jiraBaseUrl` | string | ✅ | Your Atlassian base URL, e.g. `https://yourorg.atlassian.net` |
| `jiraUserEmail` | string | ✅ | Email of the Jira user for API auth |
| `jiraApiTokenRef` | string | ✅ | Secret reference for the Jira API token |
| `transitionMapping` | object | ❌ | Map logical names → transition IDs, e.g. `{ "done": "21" }` |

### Creating the Jira API Token

1. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Store the token value in a Paperclip secret
4. Set `jiraApiTokenRef` to that secret's reference key

### transitionMapping

Use `jira.getTransitions` to discover the numeric transition IDs for your workflow. Then configure the mapping so agents can use readable names:

```json
{
  "transitionMapping": {
    "done": "21",
    "ready-for-release": "31",
    "in-review": "41"
  }
}
```

Agents can then call:
```
jira.transition({ key: "PD-123", transition: "done" })
```

Or use the numeric ID directly:
```
jira.transition({ key: "PD-123", transition: "21" })
```

## Development

```bash
pnpm test        # run unit tests
pnpm typecheck   # type-check without building
pnpm build       # compile to dist/
```

## Architecture

- **`src/manifest.ts`** — `pluginManifestV1` declaration: capabilities, config schema, tool declarations
- **`src/jira-client.ts`** — HTTP client wrapping Jira REST API v3 (Basic Auth)
- **`src/tools/`** — one file per tool; each exports a `register*Tool(ctx)` function
- **`src/tools/shared.ts`** — shared helpers: `resolveJiraClient`, `resolveTransitionId`
- **`src/plugin.ts`** — `definePlugin` that calls all register functions in `setup()`
- **`src/worker.ts`** — worker entrypoint: exports plugin and calls `runWorker()`
