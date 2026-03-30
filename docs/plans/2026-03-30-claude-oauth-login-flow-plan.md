# Claude OAuth Login Flow — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Login with Claude" button to Company Settings and Agent Config that triggers the Claude CLI OAuth flow in-browser, automatically capturing the token as a provider credential.

**Architecture:** Server runs `claude login` in a temp HOME, returns a login URL, and polls the temp dir for credentials. UI opens the URL in a new tab and polls a status endpoint. On success, the token is saved as a standard `claude_oauth` provider credential. The flow reuses existing `runClaudeLogin` from `@paperclipai/adapter-claude-local/server`.

**Tech Stack:** Express routes, `runClaudeLogin` adapter, React (TanStack Query), existing credential service/API.

---

### Task 1: Add Claude login session manager (server service)

**Files:**
- Create: `server/src/services/claude-login-sessions.ts`

**Step 1: Create the login session manager**

This is a stateful in-memory service that manages active `claude login` processes. It starts a `claude login` process in a temp HOME directory, polls for the resulting `.credentials.json` file, and stores the session state.

```typescript
// server/src/services/claude-login-sessions.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { runClaudeLogin } from "@paperclipai/adapter-claude-local/server";
import { credentialService } from "./credentials.js";
import { logActivity } from "./index.js";
import { logger } from "../middleware/logger.js";

export interface ClaudeLoginSession {
  id: string;
  companyId: string;
  userId: string;
  credentialName: string;
  tempHome: string;
  loginUrl: string | null;
  status: "pending" | "complete" | "failed" | "expired";
  credentialId: string | null;
  error: string | null;
  startedAt: number;
}

const sessions = new Map<string, ClaudeLoginSession>();
const POLL_INTERVAL_MS = 2000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS_PER_COMPANY = 3;

function activeSessionCountForCompany(companyId: string): number {
  let count = 0;
  for (const s of sessions.values()) {
    if (s.companyId === companyId && s.status === "pending") count++;
  }
  return count;
}

/**
 * Start a new Claude login session.
 * Runs `claude login` in a temp HOME, captures the login URL, and begins
 * polling for the resulting credentials file.
 */
export async function startClaudeLoginSession(
  db: Db,
  opts: {
    companyId: string;
    userId: string;
    credentialName?: string;
    isDefault?: boolean;
  },
): Promise<{ session: ClaudeLoginSession; error?: string }> {
  if (activeSessionCountForCompany(opts.companyId) >= MAX_SESSIONS_PER_COMPANY) {
    return {
      session: null as unknown as ClaudeLoginSession,
      error: "Too many active login sessions for this company. Please wait for an existing session to complete.",
    };
  }

  const sessionId = randomUUID();
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-login-"));
  const now = Date.now();
  const credentialName =
    opts.credentialName?.trim() ||
    `Claude (${new Date().toLocaleDateString("en-CA")})`;

  const session: ClaudeLoginSession = {
    id: sessionId,
    companyId: opts.companyId,
    userId: opts.userId,
    credentialName,
    tempHome,
    loginUrl: null,
    status: "pending",
    credentialId: null,
    error: null,
    startedAt: now,
  };
  sessions.set(sessionId, session);

  // Run claude login in background
  (async () => {
    try {
      const result = await runClaudeLogin({
        runId: `claude-login-${sessionId}`,
        agent: {
          id: "login-session",
          companyId: opts.companyId,
          name: "login-session",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        config: { command: "claude", env: { HOME: tempHome } },
        onLog: async () => {},
      });

      if (result.loginUrl) {
        session.loginUrl = result.loginUrl;
      }
    } catch (err) {
      logger.warn({ sessionId, err }, "claude login process threw");
    }
  })();

  // Start polling for credentials file
  pollForCredentials(db, session, opts.isDefault ?? false);

  // Give claude login a moment to output the URL
  await new Promise((r) => setTimeout(r, 3000));

  return { session };
}

/**
 * Poll the temp HOME for .claude/.credentials.json.
 */
function pollForCredentials(db: Db, session: ClaudeLoginSession, isDefault: boolean) {
  const credFile = path.join(session.tempHome, ".claude", ".credentials.json");
  const svc = credentialService(db);

  const interval = setInterval(async () => {
    // Check timeout
    if (Date.now() - session.startedAt > SESSION_TIMEOUT_MS) {
      session.status = "expired";
      session.error = "Login session timed out (5 minutes).";
      clearInterval(interval);
      cleanup(session);
      return;
    }

    // Check if session was cancelled
    if (!sessions.has(session.id)) {
      clearInterval(interval);
      cleanup(session);
      return;
    }

    // Check if cred file exists
    try {
      const raw = await fs.readFile(credFile, "utf-8");
      const parsed = JSON.parse(raw);
      const accessToken =
        parsed?.claudeAiOauth?.accessToken ??
        parsed?.accessToken;

      if (!accessToken || typeof accessToken !== "string" || accessToken.trim().length === 0) {
        return; // File exists but token not yet written
      }

      // Token found — create credential
      clearInterval(interval);

      try {
        const created = await svc.create(session.companyId, {
          name: session.credentialName,
          type: "claude_oauth",
          credential: { accessToken },
          isDefault,
        });
        session.status = "complete";
        session.credentialId = created.id;

        await logActivity(db, {
          companyId: session.companyId,
          actorType: "user",
          actorId: session.userId,
          action: "credential.created",
          entityType: "credential",
          entityId: created.id,
          details: { name: session.credentialName, type: "claude_oauth", method: "claude_login" },
        });

        logger.info({ sessionId: session.id, credentialId: created.id }, "claude login session completed");
      } catch (err) {
        session.status = "failed";
        session.error = err instanceof Error ? err.message : "Failed to save credential";
        logger.error({ sessionId: session.id, err }, "failed to create credential from login session");
      }

      cleanup(session);
    } catch {
      // File doesn't exist yet — keep polling
    }
  }, POLL_INTERVAL_MS);
}

async function cleanup(session: ClaudeLoginSession) {
  try {
    await fs.rm(session.tempHome, { recursive: true, force: true });
  } catch {
    // best effort
  }
  // Remove from map after a grace period so status can still be polled
  setTimeout(() => sessions.delete(session.id), 60_000);
}

export function getClaudeLoginSession(sessionId: string): ClaudeLoginSession | null {
  return sessions.get(sessionId) ?? null;
}

export function cancelClaudeLoginSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "pending") return false;
  session.status = "failed";
  session.error = "Cancelled by user";
  sessions.delete(sessionId);
  cleanup(session);
  return true;
}
```

**Step 2: Commit**

```bash
git add server/src/services/claude-login-sessions.ts
git commit -m "feat: add claude login session manager service"
```

---

### Task 2: Add API routes for Claude login flow

**Files:**
- Modify: `server/src/routes/credentials.ts`

**Step 1: Add the three new endpoints to credential routes**

Add after the existing DELETE route in `credentialRoutes`, before `return router`:

```typescript
// At the top of the file, add imports:
import {
  startClaudeLoginSession,
  getClaudeLoginSession,
  cancelClaudeLoginSession,
} from "../services/claude-login-sessions.js";

// --- New routes ---

// Start a Claude login session
router.post("/companies/:companyId/credentials/claude-login", async (req, res) => {
  const companyId = req.params.companyId as string;
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  if (req.actor.type === "board") {
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
      const allowed = await access.canUser(companyId, req.actor.userId, "credentials:manage");
      if (!allowed) throw forbidden("Missing permission: credentials:manage");
    }
  } else {
    throw forbidden("Board access required");
  }

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
  const isDefault = typeof req.body?.isDefault === "boolean" ? req.body.isDefault : false;

  const { session, error } = await startClaudeLoginSession(db, {
    companyId,
    userId: req.actor.userId ?? "board",
    credentialName: name,
    isDefault,
  });

  if (error) {
    res.status(429).json({ error });
    return;
  }

  res.status(202).json({
    loginSessionId: session.id,
    loginUrl: session.loginUrl,
  });
});

// Poll login session status
router.get("/companies/:companyId/credentials/claude-login/:sessionId/status", async (req, res) => {
  const companyId = req.params.companyId as string;
  assertBoard(req);
  assertCompanyAccess(req, companyId);

  const session = getClaudeLoginSession(req.params.sessionId as string);
  if (!session || session.companyId !== companyId) {
    res.status(404).json({ error: "Login session not found" });
    return;
  }

  res.json({
    status: session.status,
    loginUrl: session.loginUrl,
    credentialId: session.credentialId,
    error: session.error,
  });
});

// Cancel a login session
router.delete("/companies/:companyId/credentials/claude-login/:sessionId", async (req, res) => {
  const companyId = req.params.companyId as string;
  assertBoard(req);
  assertCompanyAccess(req, companyId);

  const cancelled = cancelClaudeLoginSession(req.params.sessionId as string);
  res.json({ ok: cancelled });
});
```

**Important:** The `claude-login` routes MUST be registered before the existing `credentials/:id` routes to avoid Express matching `claude-login` as an `:id` parameter. Move these to the top of the router, or restructure the route paths. The safest approach: the new routes are under `/companies/:companyId/credentials/claude-login/...` which won't conflict with `/credentials/:id` (the existing PATCH/DELETE routes use `/credentials/:id` without the company prefix).

**Step 2: Commit**

```bash
git add server/src/routes/credentials.ts
git commit -m "feat: add API routes for claude login flow"
```

---

### Task 3: Add UI API client for Claude login

**Files:**
- Modify: `ui/src/api/credentials.ts`

**Step 1: Add the Claude login API methods**

Add to the `credentialsApi` object in `ui/src/api/credentials.ts`:

```typescript
  startClaudeLogin: (
    companyId: string,
    data?: { name?: string; isDefault?: boolean },
  ) =>
    api.post<{ loginSessionId: string; loginUrl: string | null }>(
      `/companies/${companyId}/credentials/claude-login`,
      data ?? {},
    ),

  pollClaudeLogin: (companyId: string, sessionId: string) =>
    api.get<{
      status: "pending" | "complete" | "failed" | "expired";
      loginUrl: string | null;
      credentialId?: string;
      error?: string;
    }>(`/companies/${companyId}/credentials/claude-login/${sessionId}/status`),

  cancelClaudeLogin: (companyId: string, sessionId: string) =>
    api.delete<{ ok: boolean }>(
      `/companies/${companyId}/credentials/claude-login/${sessionId}`,
    ),
```

**Step 2: Commit**

```bash
git add ui/src/api/credentials.ts
git commit -m "feat: add UI API client for claude login flow"
```

---

### Task 4: Add "Login with Claude" button to Company Settings

**Files:**
- Modify: `ui/src/pages/CompanySettings.tsx` — the `CredentialsSection` component

**Step 1: Add the login flow state and logic to `CredentialsSection`**

Inside the `CredentialsSection` component (at `CompanySettings.tsx:972`), add state for the login flow after the existing state declarations (~line 995):

```typescript
  // Claude login flow state
  const [loginSessionId, setLoginSessionId] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginStatus, setLoginStatus] = useState<"idle" | "starting" | "pending" | "complete" | "failed" | "expired">("idle");
  const [loginError, setLoginError] = useState<string | null>(null);

  // Start login mutation
  const startLoginMutation = useMutation({
    mutationFn: () =>
      credentialsApi.startClaudeLogin(companyId, { isDefault: credentials.length === 0 }),
    onSuccess: (data) => {
      setLoginSessionId(data.loginSessionId);
      setLoginUrl(data.loginUrl);
      setLoginStatus("pending");
      setLoginError(null);
      // Open login URL in new tab
      if (data.loginUrl) {
        window.open(data.loginUrl, "_blank", "noopener");
      }
    },
    onError: (err) => {
      setLoginStatus("failed");
      setLoginError(err instanceof Error ? err.message : "Failed to start login");
    },
  });

  // Poll for login completion
  useEffect(() => {
    if (loginStatus !== "pending" || !loginSessionId) return;
    const interval = setInterval(async () => {
      try {
        const result = await credentialsApi.pollClaudeLogin(companyId, loginSessionId);
        // Update loginUrl if it wasn't available initially
        if (result.loginUrl && !loginUrl) {
          setLoginUrl(result.loginUrl);
          window.open(result.loginUrl, "_blank", "noopener");
        }
        if (result.status === "complete") {
          setLoginStatus("complete");
          invalidate();
          clearInterval(interval);
          // Reset after a moment
          setTimeout(() => {
            setLoginSessionId(null);
            setLoginUrl(null);
            setLoginStatus("idle");
          }, 3000);
        } else if (result.status === "failed" || result.status === "expired") {
          setLoginStatus(result.status);
          setLoginError(result.error ?? "Login failed");
          clearInterval(interval);
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 2500);
    return () => clearInterval(interval);
  }, [loginStatus, loginSessionId, companyId, loginUrl]);

  const resetLogin = () => {
    if (loginSessionId) {
      credentialsApi.cancelClaudeLogin(companyId, loginSessionId).catch(() => {});
    }
    setLoginSessionId(null);
    setLoginUrl(null);
    setLoginStatus("idle");
    setLoginError(null);
  };
```

**Step 2: Add the "Login with Claude" button to the JSX**

In the credentials section JSX, after the existing `Add Credential` button (around line 1286), add the login button alongside it:

Replace:
```tsx
        ) : (
          <Button size="sm" variant="outline" onClick={() => setShowAddForm(true)}>
            Add Credential
          </Button>
        )}
```

With:
```tsx
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            {loginStatus === "idle" ? (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  setLoginStatus("starting");
                  startLoginMutation.mutate();
                }}
                disabled={startLoginMutation.isPending}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Login with Claude
              </Button>
            ) : loginStatus === "starting" ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                Starting login...
              </div>
            ) : loginStatus === "pending" ? (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                  Waiting for login...
                </div>
                {loginUrl && (
                  <a
                    href={loginUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-blue-600 dark:text-blue-400 underline underline-offset-2"
                  >
                    Open login page
                  </a>
                )}
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={resetLogin}>
                  Cancel
                </Button>
              </div>
            ) : loginStatus === "complete" ? (
              <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                <Check className="h-3.5 w-3.5" />
                Claude login successful!
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-destructive">
                  {loginError ?? "Login failed"}
                </span>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={resetLogin}>
                  Retry
                </Button>
              </div>
            )}
            <Button size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={() => setShowAddForm(true)}>
              Add manually
            </Button>
          </div>
        )}
```

**Step 3: Commit**

```bash
git add ui/src/pages/CompanySettings.tsx
git commit -m "feat: add Login with Claude button to company settings credentials"
```

---

### Task 5: Add "Login with Claude" option to Agent Config credential dropdown

**Files:**
- Modify: `ui/src/components/AgentConfigForm.tsx` — the `CredentialDropdown` component

**Step 1: Extend CredentialDropdown with a login option**

Update the `CredentialDropdown` component to accept an `onLoginClick` callback and `loginStatus`:

Change the component signature and add the login option at the bottom of the dropdown:

```typescript
function CredentialDropdown({
  credentials,
  value,
  onChange,
  open,
  onOpenChange,
  onLoginClick,
  loginStatus,
  loginUrl,
}: {
  credentials: ProviderCredential[];
  value: string | null;
  onChange: (id: string | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoginClick?: () => void;
  loginStatus?: "idle" | "starting" | "pending" | "complete" | "failed" | "expired";
  loginUrl?: string | null;
}) {
```

Add inside the popover content, after the credentials list and the "No credentials configured" message, but before the closing `</div>` of the max-h container:

```tsx
            {/* Login with Claude option */}
            {onLoginClick && (
              <>
                <div className="border-t border-border my-1" />
                {loginStatus === "pending" ? (
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                    <span className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                    Waiting for login...
                    {loginUrl && (
                      <a
                        href={loginUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 dark:text-blue-400 underline underline-offset-2 ml-auto"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Open
                      </a>
                    )}
                  </div>
                ) : loginStatus === "complete" ? (
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-green-600 dark:text-green-400">
                    <Check className="h-3 w-3" />
                    Logged in!
                  </div>
                ) : (
                  <button
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50 text-blue-600 dark:text-blue-400"
                    onClick={(e) => {
                      e.preventDefault();
                      onLoginClick();
                    }}
                    disabled={loginStatus === "starting"}
                  >
                    Login with Claude...
                  </button>
                )}
              </>
            )}
```

**Step 2: Add login flow state to the parent AgentConfigForm**

Near the credential dropdown usage (around line 563), add the login flow state management. Add these state variables near the existing credential state:

```typescript
  // Claude login from agent config
  const [agentLoginSessionId, setAgentLoginSessionId] = useState<string | null>(null);
  const [agentLoginUrl, setAgentLoginUrl] = useState<string | null>(null);
  const [agentLoginStatus, setAgentLoginStatus] = useState<"idle" | "starting" | "pending" | "complete" | "failed" | "expired">("idle");

  const startAgentLogin = useMutation({
    mutationFn: () =>
      credentialsApi.startClaudeLogin(selectedCompanyId!, {
        isDefault: !credentials?.length,
      }),
    onSuccess: (data) => {
      setAgentLoginSessionId(data.loginSessionId);
      setAgentLoginUrl(data.loginUrl);
      setAgentLoginStatus("pending");
      if (data.loginUrl) window.open(data.loginUrl, "_blank", "noopener");
    },
    onError: () => setAgentLoginStatus("failed"),
  });

  // Poll for agent login completion
  useEffect(() => {
    if (agentLoginStatus !== "pending" || !agentLoginSessionId || !selectedCompanyId) return;
    const interval = setInterval(async () => {
      try {
        const result = await credentialsApi.pollClaudeLogin(selectedCompanyId, agentLoginSessionId);
        if (result.loginUrl && !agentLoginUrl) {
          setAgentLoginUrl(result.loginUrl);
          window.open(result.loginUrl, "_blank", "noopener");
        }
        if (result.status === "complete" && result.credentialId) {
          setAgentLoginStatus("complete");
          // Auto-select the new credential
          if (isCreate) {
            set!({ credentialId: result.credentialId });
          } else {
            setOverlay((prev) => ({ ...prev, credentialId: result.credentialId! }));
          }
          // Refresh credentials list
          queryClient.invalidateQueries({ queryKey: ["credentials", selectedCompanyId] });
          clearInterval(interval);
          setTimeout(() => setAgentLoginStatus("idle"), 3000);
        } else if (result.status === "failed" || result.status === "expired") {
          setAgentLoginStatus(result.status);
          clearInterval(interval);
          setTimeout(() => setAgentLoginStatus("idle"), 5000);
        }
      } catch {}
    }, 2500);
    return () => clearInterval(interval);
  }, [agentLoginStatus, agentLoginSessionId, selectedCompanyId, agentLoginUrl]);
```

Then pass the new props to CredentialDropdown:

```tsx
            <CredentialDropdown
              credentials={credentials ?? []}
              value={currentCredentialId}
              onChange={(id) => {
                if (isCreate) {
                  set!({ credentialId: id });
                } else {
                  setOverlay((prev) => ({ ...prev, credentialId: id }));
                }
              }}
              open={credentialOpen}
              onOpenChange={setCredentialOpen}
              onLoginClick={() => {
                setAgentLoginStatus("starting");
                startAgentLogin.mutate();
              }}
              loginStatus={agentLoginStatus}
              loginUrl={agentLoginUrl}
            />
```

Note: you need to add `Check` to the lucide-react imports in `AgentConfigForm.tsx` if not already imported, and add `credentialsApi` import and `useQueryClient` usage.

**Step 3: Commit**

```bash
git add ui/src/components/AgentConfigForm.tsx
git commit -m "feat: add Login with Claude option to agent credential dropdown"
```

---

### Task 6: Handle delayed loginUrl (poll for URL on status endpoint)

**Files:**
- Modify: `server/src/services/claude-login-sessions.ts`

**Step 1: Fix the race condition with loginUrl**

The `claude login` process may take a moment to output the login URL. The `startClaudeLoginSession` function waits 3 seconds, but the URL might still not be available. The status endpoint already returns `loginUrl`, so the UI poll will pick it up. However, we should also try to extract the URL from the `claude login` process output more actively.

Update the `startClaudeLoginSession` function to capture stdout and parse the URL from it:

In the `runClaudeLogin` call, add an `onLog` handler that watches for the URL:

```typescript
      const result = await runClaudeLogin({
        runId: `claude-login-${sessionId}`,
        agent: {
          id: "login-session",
          companyId: opts.companyId,
          name: "login-session",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        config: { command: "claude", env: { HOME: tempHome } },
        onLog: async (_stream, chunk) => {
          // Try to extract login URL from output as it streams
          if (!session.loginUrl && chunk) {
            const urlMatch = chunk.match(/(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi);
            if (urlMatch) {
              for (const raw of urlMatch) {
                const cleaned = raw.replace(/[\])}.!,?;:'\"]+$/g, "");
                if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
                  session.loginUrl = cleaned;
                  break;
                }
              }
            }
          }
        },
      });
```

This way, the loginUrl is captured as soon as `claude login` outputs it, before the process even finishes.

**Step 2: Commit**

```bash
git add server/src/services/claude-login-sessions.ts
git commit -m "fix: capture login URL from claude login stdout stream"
```

---

### Task 7: Build and verify

**Step 1: Build the server**

```bash
cd /workspace/paperclip && pnpm build
```

Expected: no TypeScript errors.

**Step 2: Build the UI**

```bash
cd /workspace/paperclip && pnpm --filter @paperclipai/ui build
```

Expected: no build errors.

**Step 3: Verify no regressions in existing credential flow**

The existing manual credential creation flow in Company Settings should still work unchanged. The existing per-agent `claude login` button on agent detail pages is untouched.

**Step 4: Commit any fixes**

If build revealed issues, fix them and commit.

---

### Task 8: Final cleanup and commit

**Step 1: Review all changes**

```bash
git diff --stat HEAD~7
```

Verify:
- `server/src/services/claude-login-sessions.ts` — new file (session manager)
- `server/src/routes/credentials.ts` — 3 new routes added
- `ui/src/api/credentials.ts` — 3 new API methods
- `ui/src/pages/CompanySettings.tsx` — Login with Claude button in credentials section
- `ui/src/components/AgentConfigForm.tsx` — Login option in credential dropdown

**Step 2: Final commit if any cleanup needed**

```bash
git add -A && git commit -m "feat: claude oauth login flow - final cleanup"
```
