# Claude OAuth Login Flow — Design

**Date:** 2026-03-30
**Status:** Approved

## Problem

Adding Claude OAuth credentials to Paperclip requires manually pasting an access token into the Company Settings credentials form. Users must run `claude login` on the server CLI, find the token in `~/.claude/.credentials.json`, copy it, and paste it into the UI. This is error-prone and unintuitive.

The existing `claude login` button on agent detail pages only appears after a run fails with `claude_auth_required` — it's a recovery mechanism, not a first-class onboarding flow.

## Decision

Add a "Login with Claude" button to both Company Settings (credentials section) and the Agent Config credential picker. The button triggers a server-side `claude login` process, presents the OAuth URL to the user, and automatically captures the resulting token into a `claude_oauth` provider credential once the user completes authentication.

## Approach: Server-side `claude login` + Polling

### Flow

1. User clicks **"Login with Claude"** in Company Settings or Agent Config
2. Server creates a temporary HOME directory and runs `claude login`
3. Server extracts the login URL from `claude login` stdout and returns it along with a session ID
4. UI opens the login URL in a new browser tab
5. UI polls a status endpoint every 2–3 seconds
6. Meanwhile, user authenticates in the browser tab → Claude CLI writes token to `<tempHOME>/.claude/.credentials.json`
7. Server detects the credentials file, reads the access token, creates a `claude_oauth` provider credential, cleans up the temp directory
8. Status endpoint returns `complete` with the new credential ID
9. UI shows success, refreshes the credential list

### Why this approach

- Reuses existing `runClaudeLogin` infrastructure
- No need to reverse-engineer Anthropic's OAuth client ID or endpoints
- Token captured server-side, never exposed to browser
- Agnostic to changes in Claude CLI's auth flow

## API

### Start login

```
POST /api/companies/:companyId/credentials/claude-login
Body: { name?: string }
Response: { loginSessionId: string, loginUrl: string | null }
```

- Requires `credentials:manage` permission
- `name` is optional; defaults to "Claude (YYYY-MM-DD)"
- Starts `claude login` in a temp HOME directory
- Stores session state in an in-memory map (keyed by `loginSessionId`)

### Poll status

```
GET /api/companies/:companyId/credentials/claude-login/:sessionId/status
Response: { status: "pending" | "complete" | "failed" | "expired", credentialId?: string, error?: string }
```

- `pending`: login process still running, user hasn't completed auth yet
- `complete`: token captured, credential created — `credentialId` is set
- `failed`: `claude login` process exited with error
- `expired`: timed out (5 minutes)

### Cancel login

```
DELETE /api/companies/:companyId/credentials/claude-login/:sessionId
Response: { ok: true }
```

- Kills the `claude login` process and cleans up temp dir

## Server Implementation

### Login session manager

An in-memory map of active login sessions:

```typescript
interface ClaudeLoginSession {
  id: string;
  companyId: string;
  credentialName: string;
  tempHome: string;
  loginUrl: string | null;
  status: "pending" | "complete" | "failed" | "expired";
  credentialId: string | null;
  error: string | null;
  startedAt: number;
  process: ChildProcess | null;
}
```

- On start: create temp dir, run `claude login` with `HOME=<tempDir>`, parse stdout for login URL
- Background: poll `<tempDir>/.claude/.credentials.json` every 2s
- On token found: read `accessToken` from credentials file, call `credentialService.create()` to save as `claude_oauth` credential, set status to `complete`
- On process exit (non-zero): set status to `failed`
- On timeout (5 min): kill process, set status to `expired`
- Cleanup: remove temp dir on complete/failed/expired/cancel

### Integration with existing credential system

The created credential is a standard `claude_oauth` provider credential, identical to one created by manually pasting a token. No schema changes needed.

If `isDefault` is true and no other `claude_oauth` default exists for the company, it's auto-set as default.

## UI — Company Settings

### Credentials section changes

- Add a **"Login with Claude"** button next to the existing "Add Credential" button
- Button has the Claude logo/icon and distinct styling (branded)
- On click:
  1. Call `POST /credentials/claude-login` with optional name
  2. Show inline status: "Waiting for login..." with a spinner
  3. Open `loginUrl` in new tab
  4. Poll status every 2.5s
  5. On `complete`: show success toast, refresh credential list
  6. On `failed`/`expired`: show error message with retry option
- A "Cancel" button stops the flow and calls DELETE

### Existing manual flow preserved

The existing "Add Credential" form with type selector and manual token input remains unchanged — power users or automation can still paste tokens directly.

## UI — Agent Config

### Credential dropdown changes

- Add a **"Login with Claude"** option at the bottom of the credential dropdown (separated by a divider)
- On click: same flow as company settings, but after credential is created, auto-select it for the agent
- Alternatively, if the user lacks `credentials:manage` permission, show "Ask an admin to add Claude credentials" instead

## Security

- Login sessions are ephemeral (in-memory, not persisted)
- Temp directories are cleaned up on completion/failure/expiry
- Token is only ever stored in the `provider_credentials` table (encrypted at rest per existing design)
- All endpoints gated by `credentials:manage` RBAC permission
- Login sessions auto-expire after 5 minutes
- Maximum concurrent login sessions per company: 3 (prevent abuse)

## Migration & Backward Compatibility

- No database schema changes
- No changes to existing credential types or agent behavior
- Existing manual token paste flow unchanged
- The per-agent `claude login` button on agent detail page remains as a fallback for auth recovery

## Future Extensions

- Refresh token support (if Claude CLI supports it)
- Credential health checks (test token validity before use)
- Token rotation reminders (notify when approaching expiry)
