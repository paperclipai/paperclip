import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import {
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";

const CAPTURE_KEYS = [
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WORKSPACE_CWD",
  "PAPERCLIP_WORKSPACE_SOURCE",
  "PAPERCLIP_WORKSPACE_REPO_REF",
  "PAPERCLIP_WORKSPACE_BRANCH",
  "PAPERCLIP_WORKSPACE_OBSERVED_BRANCH",
  "PAPERCLIP_WORKSPACE_OBSERVED_HEAD",
] as const;

type CaptureKey = (typeof CAPTURE_KEYS)[number];

type CapturePayload = {
  argv: string[];
  prompt: string;
  env: Partial<Record<CaptureKey, string>>;
};

const execFileAsync = promisify(execFile);
const SANITIZED_ENV_KEYS = [
  "AGENT_HOME",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WORKSPACE_CWD",
  "PAPERCLIP_WORKSPACE_SOURCE",
  "PAPERCLIP_WORKSPACE_REPO_REF",
  "PAPERCLIP_WORKSPACE_BRANCH",
  "PAPERCLIP_WORKSPACE_OBSERVED_BRANCH",
  "PAPERCLIP_WORKSPACE_OBSERVED_HEAD",
  "PAPERCLIP_WORKSPACES_JSON",
] as const;

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function gitStdout(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function createGitWorkspace(root: string) {
  const repoRoot = join(root, "project-workspace");
  await mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-tests@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Tests"]);
  await runGit(repoRoot, ["checkout", "-b", "main"]);
  await writeFile(join(repoRoot, "README.md"), "# workspace\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  await runGit(repoRoot, ["checkout", "-b", "feature/live-checkout"]);
  await writeFile(join(repoRoot, "feature.txt"), "live checkout\n", "utf8");
  await runGit(repoRoot, ["add", "feature.txt"]);
  await runGit(repoRoot, ["commit", "-m", "feature"]);

  return {
    repoRoot,
    branchName: "feature/live-checkout",
    headSha: await gitStdout(repoRoot, ["rev-parse", "HEAD"]),
  };
}

async function withSanitizedEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of SANITIZED_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return await run();
  } finally {
    for (const key of SANITIZED_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function writeFakeCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  env: Object.fromEntries(
    [
      "PAPERCLIP_AGENT_ID",
      "PAPERCLIP_API_KEY",
      "PAPERCLIP_API_URL",
      "PAPERCLIP_COMPANY_ID",
      "PAPERCLIP_RUN_ID",
      "PAPERCLIP_TASK_ID",
      "PAPERCLIP_WAKE_COMMENT_ID",
      "PAPERCLIP_WAKE_REASON",
      "PAPERCLIP_WORKSPACE_CWD",
      "PAPERCLIP_WORKSPACE_SOURCE",
      "PAPERCLIP_WORKSPACE_REPO_REF",
      "PAPERCLIP_WORKSPACE_BRANCH",
      "PAPERCLIP_WORKSPACE_OBSERVED_BRANCH",
      "PAPERCLIP_WORKSPACE_OBSERVED_HEAD",
    ]
      .filter((key) => typeof process.env[key] === "string" && process.env[key].length > 0)
      .map((key) => [key, process.env[key]]),
  ),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }));
console.log(
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "codex ok" },
  }),
);
console.log(
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 11, cached_input_tokens: 2, output_tokens: 7 },
  }),
);
`;
  await writeFile(commandPath, script, "utf8");
  await chmod(commandPath, 0o755);
}

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  env: Object.fromEntries(
    [
      "PAPERCLIP_AGENT_ID",
      "PAPERCLIP_API_KEY",
      "PAPERCLIP_API_URL",
      "PAPERCLIP_COMPANY_ID",
      "PAPERCLIP_RUN_ID",
      "PAPERCLIP_TASK_ID",
      "PAPERCLIP_WAKE_COMMENT_ID",
      "PAPERCLIP_WAKE_REASON",
      "PAPERCLIP_WORKSPACE_CWD",
      "PAPERCLIP_WORKSPACE_SOURCE",
      "PAPERCLIP_WORKSPACE_REPO_REF",
      "PAPERCLIP_WORKSPACE_BRANCH",
      "PAPERCLIP_WORKSPACE_OBSERVED_BRANCH",
      "PAPERCLIP_WORKSPACE_OBSERVED_HEAD",
    ]
      .filter((key) => typeof process.env[key] === "string" && process.env[key].length > 0)
      .map((key) => [key, process.env[key]]),
  ),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "claude-session-1",
    model: "sonnet",
  }),
);
console.log(
  JSON.stringify({
    type: "assistant",
    session_id: "claude-session-1",
    message: { content: [{ type: "text", text: "claude ok" }] },
  }),
);
console.log(
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "claude-session-1",
    usage: {
      input_tokens: 13,
      cache_read_input_tokens: 3,
      output_tokens: 5,
    },
    total_cost_usd: 0.01,
    result: "claude ok",
  }),
);
`;
  await writeFile(commandPath, script, "utf8");
  await chmod(commandPath, 0o755);
}

async function waitForRun(
  svc: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await svc.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for heartbeat run ${runId}`);
}

describe("local agent PAPERCLIP_API_KEY injection", () => {
  let databaseDir = "";
  let databaseUrl = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;
  let companyId = "";
  let issueNumber = 1;
  const heartbeat = () => heartbeatService(db);
  const originalJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "paperclip-test-local-agent-jwt-secret";
    delete process.env.BETTER_AUTH_SECRET;

    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-heartbeat-auth-"));
    const port = await detectPort(55433);
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });

    await embeddedPostgres.initialise();
    await embeddedPostgres.start();

    const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "paperclip");

    databaseUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Heartbeat Auth Test Company",
      issuePrefix: "HBT",
    });
  }, 120_000);

  afterAll(async () => {
    if (originalJwtSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = originalJwtSecret;
    }
    if (originalBetterAuthSecret === undefined) {
      delete process.env.BETTER_AUTH_SECRET;
    } else {
      process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
    }
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120_000);

  async function seedIssue(
    agentId: string,
    opts?: { projectId?: string | null; projectWorkspaceId?: string | null },
  ) {
    const issueId = randomUUID();
    const currentIssueNumber = issueNumber;
    issueNumber += 1;

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Wake Issue ${currentIssueNumber}`,
      status: "todo",
      priority: "high",
      projectId: opts?.projectId ?? null,
      projectWorkspaceId: opts?.projectWorkspaceId ?? null,
      assigneeAgentId: agentId,
      createdByAgentId: agentId,
      issueNumber: currentIssueNumber,
      identifier: `HBT-${currentIssueNumber}`,
    });

    return issueId;
  }

  async function runWakeCase(input: {
    adapterType: "claude_local" | "codex_local";
    wake:
      | { source: "timer"; triggerDetail: "system" }
      | {
          source: "assignment";
          triggerDetail: "system";
          reason: "issue_assigned";
        }
      | {
          source: "automation";
          triggerDetail: "system";
          reason: "issue_comment_mentioned";
        };
    projectWorkspace?: {
      cwd: string;
      repoRef?: string | null;
    };
  }) {
    const root = await mkdtemp(join(tmpdir(), `paperclip-${input.adapterType}-wake-`));
    const workspace = join(root, "workspace");
    const commandPath = join(root, "agent");
    const capturePath = join(root, "capture.json");
    await mkdir(workspace, { recursive: true });

    const previousCodexHome = process.env.CODEX_HOME;
    if (input.adapterType === "codex_local") {
      process.env.CODEX_HOME = join(root, "codex-home");
      await writeFakeCodexCommand(commandPath);
    } else {
      await writeFakeClaudeCommand(commandPath);
    }

    const agentId = randomUUID();
    const agentName =
      input.adapterType === "codex_local" ? "Codex Platform Engineer" : "Claude Platform Engineer";

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: agentName,
      role: "platform",
      status: "active",
      adapterType: input.adapterType,
      adapterConfig: {
        command: commandPath,
        cwd: workspace,
        env: {
          PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
        },
      },
    });

    let issueId: string | null = null;
    let projectId: string | null = null;
    let projectWorkspaceId: string | null = null;
    if (input.projectWorkspace) {
      projectId = randomUUID();
      projectWorkspaceId = randomUUID();
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: `Workspace Project ${projectId.slice(0, 8)}`,
        status: "active",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Primary Workspace",
        sourceType: "local_path",
        cwd: input.projectWorkspace.cwd,
        repoRef: input.projectWorkspace.repoRef ?? null,
        isPrimary: true,
      });
    }
    if (input.wake.source !== "timer") {
      issueId = await seedIssue(agentId, {
        projectId,
        projectWorkspaceId,
      });
    }

    try {
      return await withSanitizedEnv(async () => {
        const wakeup =
          input.wake.source === "timer"
            ? await heartbeat().wakeup(agentId, {
                source: "timer",
                triggerDetail: "system",
              })
            : input.wake.reason === "issue_assigned"
              ? await heartbeat().wakeup(agentId, {
                  source: "assignment",
                  triggerDetail: "system",
                  reason: "issue_assigned",
                  payload: { issueId, mutation: "create" },
                  contextSnapshot: { issueId, source: "issue.create" },
                })
              : await heartbeat().wakeup(agentId, {
                  source: "automation",
                  triggerDetail: "system",
                  reason: "issue_comment_mentioned",
                  payload: { issueId, commentId: "comment-1" },
                  contextSnapshot: { issueId, source: "comment.mention" },
                });

        expect(wakeup).not.toBeNull();
        const run = await waitForRun(heartbeat(), wakeup!.id);
        const capture = JSON.parse(await readFile(capturePath, "utf8")) as CapturePayload;
        return { capture, run, issueId };
      });
    } finally {
      if (input.adapterType === "codex_local") {
        if (previousCodexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previousCodexHome;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }

  for (const adapterType of ["codex_local", "claude_local"] as const) {
    describe(adapterType, () => {
      it("injects PAPERCLIP_API_KEY on timer wakes without issue context", async () => {
        const { capture, run } = await runWakeCase({
          adapterType,
          wake: { source: "timer", triggerDetail: "system" },
        });

        expect(run.status).toBe("succeeded");
        expect(capture.env.PAPERCLIP_API_KEY).toMatch(/\S+/);
        expect(capture.env.PAPERCLIP_RUN_ID).toMatch(/\S+/);
        expect(capture.env.PAPERCLIP_AGENT_ID).toMatch(/\S+/);
        expect(capture.env.PAPERCLIP_COMPANY_ID).toBe(companyId);
        expect(capture.env.PAPERCLIP_TASK_ID).toBeUndefined();
        expect(capture.env.PAPERCLIP_WAKE_COMMENT_ID).toBeUndefined();
      });

      it("injects PAPERCLIP_API_KEY and task wake context on assignment wakes", async () => {
        const { capture, run, issueId } = await runWakeCase({
          adapterType,
          wake: {
            source: "assignment",
            triggerDetail: "system",
            reason: "issue_assigned",
          },
        });

        expect(run.status).toBe("succeeded");
        expect(capture.env.PAPERCLIP_API_KEY).toMatch(/\S+/);
        expect(capture.env.PAPERCLIP_TASK_ID).toBe(issueId);
        expect(capture.env.PAPERCLIP_WAKE_REASON).toBe("issue_assigned");
      });

      it("injects PAPERCLIP_API_KEY and comment wake context on mention wakes", async () => {
        const { capture, run, issueId } = await runWakeCase({
          adapterType,
          wake: {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
          },
        });

        expect(run.status).toBe("succeeded");
        expect(capture.env.PAPERCLIP_API_KEY).toMatch(/\S+/);
        expect(capture.env.PAPERCLIP_TASK_ID).toBe(issueId);
        expect(capture.env.PAPERCLIP_WAKE_REASON).toBe("issue_comment_mentioned");
        expect(capture.env.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-1");
      });

      it("captures observed git provenance for shared project workspaces", async () => {
        const root = await mkdtemp(join(tmpdir(), `paperclip-${adapterType}-workspace-provenance-`));
        try {
          const workspaceRepo = await createGitWorkspace(root);
          const { capture, run } = await runWakeCase({
            adapterType,
            wake: {
              source: "assignment",
              triggerDetail: "system",
              reason: "issue_assigned",
            },
            projectWorkspace: {
              cwd: workspaceRepo.repoRoot,
              repoRef: "main",
            },
          });

          expect(run.status).toBe("succeeded");
          expect(capture.env.PAPERCLIP_WORKSPACE_CWD).toBe(workspaceRepo.repoRoot);
          expect(capture.env.PAPERCLIP_WORKSPACE_SOURCE).toBe("project_primary");
          expect(capture.env.PAPERCLIP_WORKSPACE_REPO_REF).toBe("main");
          expect(capture.env.PAPERCLIP_WORKSPACE_BRANCH).toBeUndefined();
          expect(capture.env.PAPERCLIP_WORKSPACE_OBSERVED_BRANCH).toBe(workspaceRepo.branchName);
          expect(capture.env.PAPERCLIP_WORKSPACE_OBSERVED_HEAD).toBe(workspaceRepo.headSha);

          const contextSnapshot =
            typeof run.contextSnapshot === "object" && run.contextSnapshot !== null
              ? run.contextSnapshot as Record<string, unknown>
              : null;
          const paperclipWorkspace =
            contextSnapshot && typeof contextSnapshot.paperclipWorkspace === "object" && contextSnapshot.paperclipWorkspace !== null
              ? contextSnapshot.paperclipWorkspace as Record<string, unknown>
              : null;

          expect(paperclipWorkspace).toMatchObject({
            cwd: workspaceRepo.repoRoot,
            source: "project_primary",
            repoRef: "main",
            branchName: null,
            observedBranchName: workspaceRepo.branchName,
            observedHeadSha: workspaceRepo.headSha,
          });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    });
  }
});
