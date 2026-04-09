import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Paperclip repo fallback heartbeat test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type CapturePayload = {
  cwd: string;
  env: {
    PAPERCLIP_WORKSPACE_CWD?: string;
    PAPERCLIP_WORKSPACE_SOURCE?: string;
    PAPERCLIP_TASK_ID?: string;
    PAPERCLIP_WAKE_REASON?: string;
  };
};

async function writeFakeCodexCommand(commandPath: string) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({
    cwd: process.cwd(),
    env: {
      PAPERCLIP_WORKSPACE_CWD: process.env.PAPERCLIP_WORKSPACE_CWD,
      PAPERCLIP_WORKSPACE_SOURCE: process.env.PAPERCLIP_WORKSPACE_SOURCE,
      PAPERCLIP_TASK_ID: process.env.PAPERCLIP_TASK_ID,
      PAPERCLIP_WAKE_REASON: process.env.PAPERCLIP_WAKE_REASON,
    },
  }), "utf8");
}
fs.readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }));
console.log(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "codex ok" },
}));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 11, cached_input_tokens: 2, output_tokens: 7 },
}));
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

describeEmbeddedPostgres("heartbeat Paperclip repo fallback", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousCodexHome = process.env.CODEX_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-repo-fallback-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await tempDb?.cleanup();
  });

  it("routes no-project issue wakes into the local Paperclip repo instead of agent home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-repo-fallback-"));
    const configuredWorkspace = path.join(root, "configured-workspace");
    const capturePath = path.join(root, "capture.json");
    const commandPath = path.join(root, "codex");
    const expectedRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

    await mkdir(configuredWorkspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    process.env.CODEX_HOME = path.join(root, "codex-home");

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Repo Fallback Test Company",
      issuePrefix: "PRF",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Repo Fallback Engineer",
      role: "platform",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        command: commandPath,
        cwd: configuredWorkspace,
        env: {
          PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
        },
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Validate Paperclip repo fallback",
      status: "todo",
      priority: "high",
      projectId: null,
      projectWorkspaceId: null,
      assigneeAgentId: agentId,
      createdByAgentId: agentId,
      issueNumber: 1,
      identifier: "PRF-1",
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Wake this issue through the normal local heartbeat path.",
    });

    const heartbeat = heartbeatService(db);
    const wakeup = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId },
      contextSnapshot: {
        issueId,
        commentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    try {
      expect(wakeup).not.toBeNull();
      const run = await waitForRun(heartbeat, wakeup!.id);
      expect(run.status).toBe("succeeded");

      const capture = JSON.parse(await readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.cwd).toBe(expectedRepoRoot);
      expect(capture.env.PAPERCLIP_WORKSPACE_CWD).toBe(expectedRepoRoot);
      expect(capture.env.PAPERCLIP_WORKSPACE_SOURCE).toBe("agent_home");
      expect(capture.env.PAPERCLIP_TASK_ID).toBe(issueId);
      expect(capture.env.PAPERCLIP_WAKE_REASON).toBe("issue_commented");

      const persistedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wakeup!.id))
        .then((rows) => rows[0] ?? null);
      const contextSnapshot =
        persistedRun && typeof persistedRun.contextSnapshot === "object" && persistedRun.contextSnapshot !== null
          ? persistedRun.contextSnapshot as Record<string, unknown>
          : null;
      const paperclipWorkspace =
        contextSnapshot &&
          typeof contextSnapshot.paperclipWorkspace === "object" &&
          contextSnapshot.paperclipWorkspace !== null
          ? contextSnapshot.paperclipWorkspace as Record<string, unknown>
          : null;

      expect(paperclipWorkspace).toMatchObject({
        cwd: expectedRepoRoot,
        source: "agent_home",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
