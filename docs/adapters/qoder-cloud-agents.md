---
title: Qoder Cloud Agents
summary: Qoder Cloud Agents remote adapter setup and configuration
---

The `qoder_cloud_agents` adapter runs agents on [Qoder Cloud Agents](https://docs.qoder.com) through the Qoder Managed API. Paperclip starts no local process: each heartbeat sends one `user.message` turn to a durable Qoder session and reads the result from the session's event stream. Paperclip stays the source of truth for task state; Qoder provides the remote execution surface.

## Prerequisites

- A Qoder account with Cloud Agents access
- A Qoder personal access token (PAT, `pt-...`) or a service account token (SAT)
- For private repositories or pushing: a token for the Git host (for GitHub, a fine-grained PAT with `Contents: Read & Write`)

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `env.QODER_ACCESS_TOKEN` | Yes | Qoder PAT or SAT. Never forwarded into the session. |
| `apiBaseUrl` | No | Defaults to `https://api.qoder.com`. Use `https://api.qoder.com.cn` for the China region. Must match the token's region. Must be an `https` URL: Paperclip does not send the token over an unencrypted connection. |
| `qoderAgentId` | No | Existing Qoder agent (`agent_...`). When omitted, Paperclip creates one managed Qoder agent per Paperclip agent and reuses it. |
| `environmentId` | No | Qoder environment (`env_...`). When omitted, Paperclip uses the account's first Qoder-hosted (`cloud`) environment and creates `default` if there is none. A `self_hosted` environment only works when your own worker returns tool results. |
| `model` | No | Model for the managed Qoder agent. Defaults to `ultimate`. Ignored when `qoderAgentId` is set. |
| `repoUrl` | No | http(s) Git repository cloned into the session. GitHub URLs mount as `github_repository`; other hosts mount as `git_repository`. |
| `repoStartingRef` | No | Branch to check out. |
| `repoMountPath` | No | Clone path in the container. Defaults to `/data/workspace/<repo>`. |
| `env.QODER_REPO_TOKEN` | No | Token Qoder uses to clone or push the repository. For non-GitHub hosts the repository URL must include the username. |
| `timeoutSec` | No | Cancel the Qoder turn after this many seconds. `0` (default) disables the limit. |
| `env.*` | No | Other variables are injected into the session shell. |

## Behavior

- **Sessions.** Paperclip reuses the Qoder session across heartbeats while the Qoder agent, environment, repository, repository token and forwarded env vars are unchanged. Changing any of them, including clearing `environmentId`, starts a new session. Qoder takes the repository token only when it creates the session, so replace an expired `QODER_REPO_TOKEN` and the next run starts a fresh session with the new token.
- **Environment variables.** Qoder fixes session env vars at session creation. Only stable values (`PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, and the `env.*` entries saved on the agent) are set in the shell; variables Paperclip injects for local processes, such as `TMPDIR` or scratch directories, are not forwarded. Run-scoped values such as `PAPERCLIP_RUN_ID` and `PAPERCLIP_TASK_ID` are written into the prompt instead. Qoder rejects names starting with `QODER_` or `CAW_`, the names `SERVER_ENDPOINT`, `USER_ID` and `WORK_DIR`, values over 8 KiB, and more than 64 entries; Paperclip omits those and logs a warning.
- **No Paperclip API callback.** The adapter does not issue a Paperclip run token to the remote agent, so the Qoder agent cannot call the Paperclip API. Results come back through the event stream and appear as the run result and a task comment. The agent cannot mark its own task done or blocked: after a run ends without a recorded outcome, Paperclip wakes the agent up to two more times to record one and then marks the task as needing attention, so a board user closes the task.
- **Connection tools.** Paperclip mints a run-scoped token for its `connections_search` and `connection_request` tools. Because the session env is fixed, the adapter writes the tool URLs and the token into each turn's prompt and redacts the token in the Paperclip run log. It does not send them when the Paperclip API URL is a loopback address, which Qoder cannot reach.
- **Instructions bundle.** The remote container cannot read the Paperclip host. The adapter puts the entry instructions file in the prompt, plus the text files that the instructions reference by relative path (up to 50 files and 120,000 bytes). It reads a file only when the instructions name it and it is inside the entry file's directory, so other files in that directory are never sent. It lists any referenced file that is too large to include.
- **Tool permissions.** The managed Qoder agent allows every built-in tool. If you supply your own `qoderAgentId`, set its tool permission policies to `always_allow`: a turn that stops for tool confirmation is cancelled and reported as a failed run.
- **Persistence.** Qoder container storage is temporary and may be reclaimed after 24 hours of inactivity. The agent must commit and push work it needs to keep. This adapter does not sync the remote workspace back into the local execution workspace.
- **Cost.** Qoder bills in credits. Paperclip records no USD cost for these runs; the session's cumulative credit usage is stored in the run result as `qoderSessionUsage`.
- **Cancellation.** Stopping a run in Paperclip cancels the in-flight Qoder turn; the session stays usable. Paperclip acknowledges the stop only after Qoder reports that the turn is no longer running. If Qoder does not confirm within 30 seconds, the run result says so and records `qoderTurnStopped: false`. A run that fails while a turn may still be running, such as after the event stream is lost, cancels the turn the same way.

## Service account tokens

A SAT is valid for at most 12 hours and cannot be refreshed. This adapter does not exchange a service account key for a SAT, so a long-lived deployment should use a PAT or rotate `QODER_ACCESS_TOKEN` externally.
