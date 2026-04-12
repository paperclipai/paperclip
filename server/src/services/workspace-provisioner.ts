/**
 * Phase 4: leader CLI workspace provisioner.
 *
 * Owns the file system layout under ~/.cos-v2/leaders/<slug>/.
 * Called by leaderProcessService.start() just before the process
 * backend spawn. Idempotent — safe to call on every start.
 *
 * Responsibilities:
 *   1. Ensure the workspace directory exists with 0700 perms.
 *   2. Issue a fresh agent API key (old keys remain valid until the
 *      agent is destroyed; leader_processes.agent_key_id tracks the
 *      currently-active one).
 *   3. Write a fresh .mcp.json that launches channel-bridge-cos via
 *      tsx with the correct env (COS_API_URL, COS_AGENT_*, etc).
 *   4. Return a WorkspaceSpec describing everything the
 *      ProcessBackend needs to spawn the claude CLI.
 *
 * No CLAUDE.md / instructions.md files — the bridge's MCP
 * `instructions:` field fetches /team-instructions at runtime.
 * One source of truth.
 *
 * @see docs/cos-v2/phase4-cli-design.md §12
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { rebaseHomePath } from "./path-utils.js";
import fsSync from "node:fs";
import type { Db } from "@paperclipai/db";
import type {
  LeaderWorkspaceProvisioner,
  WorkspaceSpec,
} from "./leader-processes.js";
import type { AgentSessionRecord } from "./agent-sessions.js";

export interface WorkspaceProvisionerDeps {
  db: Db;
  /**
   * Resolves the COS v2 repo root so .mcp.json can reference the
   * channel-bridge-cos package path. Default is `../../..` from this
   * source file (i.e. server/src/services/ → repo root).
   */
  repoRoot?: string;
  /**
   * Path to the COS v2 HTTP API. Bridge uses this for SSE + POST.
   * Default: http://127.0.0.1:3101
   */
  apiUrl?: string;
  /**
   * Override agent key issuer — accepts (agentId, label) and returns
   * { token, keyId }. Default implementation uses agentService.
   */
  issueAgentKey?: (
    agentId: string,
    label: string,
  ) => Promise<{ token: string; keyId: string }>;
  /** Tsx binary path override (for tests). */
  tsxBin?: string;
}

function defaultRepoRoot(): string {
  // This file at runtime: <repo>/server/dist/services/workspace-provisioner.js
  // Or dev: <repo>/server/src/services/workspace-provisioner.ts (via tsx)
  // Walk up until we find pnpm-workspace.yaml.
  // Fallback: env var or cwd.
  const fromEnv = process.env.COS_V2_REPO_ROOT;
  if (fromEnv) return fromEnv;
  // Best-effort resolution: src/services/ is 2 up, dist/services/ is 2 up too.
  // Resolve via the server package.json location.
  const cwd = process.cwd();
  return cwd.includes("/server") ? path.resolve(cwd, "..") : cwd;
}

function defaultTsxBin(repoRoot: string): string {
  // pnpm does not hoist dev deps to the workspace root by default;
  // tsx is installed locally in server/node_modules. Fall back to the
  // hoisted location for bare npm/yarn layouts.
  const candidates = [
    path.join(repoRoot, "server", "node_modules", ".bin", "tsx"),
    path.join(repoRoot, "node_modules", ".bin", "tsx"),
  ];
  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return candidates[0]; // last resort, will fail visibly
}

function bridgeEntryPath(repoRoot: string): string {
  return path.join(repoRoot, "packages", "channel-bridge-cos", "src", "index.ts");
}

function resolveClaudeBinary(): string {
  // Explicit override always wins.
  const override = process.env.COS_V2_CLAUDE_BIN;
  if (override) return override;

  // Walk PATH manually so we get an absolute path to hand to pty-runner
  // (shell aliases are NOT in PATH, and node-pty's posix_spawnp does not
  // resolve them; an absolute path sidesteps the problem).
  const PATH = process.env.PATH ?? "";
  const candidates: string[] = [];
  for (const dir of PATH.split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "claude"));
  }
  // Common locations that may be missing from PATH under a daemon.
  const home = process.env.HOME ?? "";
  if (home) {
    candidates.push(path.join(home, ".local", "bin", "claude"));
    candidates.push(path.join(home, ".claude", "local", "claude"));
  }
  candidates.push("/usr/local/bin/claude");
  candidates.push("/opt/homebrew/bin/claude");

  // First existing + executable match wins.
  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }

  // Last resort — "claude" and hope PATH has it.
  return "claude";
}

export function createWorkspaceProvisioner(
  deps: WorkspaceProvisionerDeps,
): LeaderWorkspaceProvisioner {
  const repoRoot = deps.repoRoot ?? defaultRepoRoot();
  const apiUrl = deps.apiUrl ?? "http://127.0.0.1:3101";
  const tsxBin = deps.tsxBin ?? defaultTsxBin(repoRoot);

  async function defaultIssueAgentKey(
    agentId: string,
    label: string,
  ): Promise<{ token: string; keyId: string }> {
    // Lazy import to avoid circular dep with agents service.
    const { agentService } = await import("./agents.js");
    const svc = agentService(deps.db);
    // We always mint a new token here because the plaintext token is
    // only available at creation time (DB stores hash). Previous
    // leader keys from this agent should be revoked so they cannot
    // be used from a stale bridge — but we do NOT revoke on the path
    // of a failing provision (revoke happens in caller on success).
    const result = await svc.createApiKey(agentId, label);
    return { token: result.token, keyId: result.id };
  }

  const issueAgentKey = deps.issueAgentKey ?? defaultIssueAgentKey;

  return {
    async provision({
      companyId,
      agentId,
      session,
    }: {
      companyId: string;
      agentId: string;
      session: AgentSessionRecord;
    }): Promise<WorkspaceSpec & { agentKeyId: string | null }> {
      const cwd = rebaseHomePath(session.workspacePath);
      // MCP config lives in a session-specific directory so multiple agents
      // sharing the same project repo cwd don't collide on .mcp.json.
      // CLAUDE_PROJECT_DIR = cwd so the CLI reads the repo's CLAUDE.md,
      // .claude/agents/, .claude/skills/, etc.
      const agentShort = agentId.slice(0, 8);
      const sessionShort = session.id.slice(0, 8);
      const mcpConfigDir = path.join(
        os.homedir(), ".cos-v2", "leaders", `${agentShort}-${sessionShort}`,
      );

      // 1. Ensure mcp config dir + logs dir exists with restrictive perms
      await fs.mkdir(path.join(mcpConfigDir, "logs"), { recursive: true });
      try {
        await fs.chmod(mcpConfigDir, 0o700);
      } catch {
        // Some file systems (e.g. network FS) don't support chmod.
        // Log-worthy but not fatal.
      }

      // 2. Issue a fresh agent API key
      const { token: agentKeyToken, keyId: agentKeyId } = await issueAgentKey(
        agentId,
        `leader-cli (${session.id.slice(0, 8)})`,
      );

      // 3. Write .mcp.json pointing at channel-bridge-cos via tsx
      const bridgeEntry = bridgeEntryPath(repoRoot);
      const mcpConfig = {
        mcpServers: {
          "channel-bridge": {
            command: tsxBin,
            args: [bridgeEntry],
            env: {
              COS_API_URL: apiUrl,
              COS_COMPANY_ID: companyId,
              COS_AGENT_ID: agentId,
              COS_AGENT_KEY: agentKeyToken,
              COS_WORKSPACE: cwd,
              COS_SESSION_ID: session.id,
            },
          },
        },
      };
      const mcpJsonPath = path.join(mcpConfigDir, "mcp-bridge.json");
      await fs.writeFile(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), {
        mode: 0o600,
      });

      // 4. Build the WorkspaceSpec for the process backend.
      const binary = resolveClaudeBinary();
      const args = [
        "--dangerously-skip-permissions",
        "--dangerously-load-development-channels",
        "server:channel-bridge",
        "--mcp-config",
        mcpJsonPath,
      ];
      // Env allowlist — never spread `...process.env`. Leaking the
      // server's full environment (DB URLs, secrets, other agent keys
      // from prior runs) into every leader process is a privilege
      // escalation path. Only pass what claude needs to boot + locate
      // its own project history. The plaintext COS_AGENT_KEY stays
      // in .mcp.json (mode 0600) — NOT in the process env — so it is
      // not visible via `pm2 env <id>` or /proc/<pid>/environ.
      const env: Record<string, string> = {};
      if (process.env.PATH) env.PATH = process.env.PATH;
      if (process.env.HOME) env.HOME = process.env.HOME;
      if (process.env.LANG) env.LANG = process.env.LANG;
      if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
      if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
      env.CLAUDE_PROJECT_DIR = cwd;
      env.COS_API_URL = apiUrl;
      env.COS_COMPANY_ID = companyId;
      env.COS_AGENT_ID = agentId;
      env.COS_SESSION_ID = session.id;

      return {
        root: cwd,
        binary,
        args,
        env,
        agentKeyId,
      };
    },

    async destroy({ sessionId }: { sessionId: string }): Promise<void> {
      // Reuse the same stable path computed by agent-sessions from
      // the agentId + sessionId — but we don't have agentId here, so
      // load the session row to find workspace_path.
      const { agentSessions } = await import("@paperclipai/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await deps.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1);
      if (!row) return;
      // Best-effort recursive remove. Missing dir is fine.
      try {
        await fs.rm(row.workspacePath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
