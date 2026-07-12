import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createDb, dispatchGateState, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { findActiveServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/index.js";
import {
  acquireDispatchGate,
  CLAUDE_LOCAL_DEFAULT_SCOPE,
  releaseDispatchGate,
  setDispatchGateDb,
  withDispatchGate,
} from "../services/dispatch-gate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dispatch gate launch-surface quota tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// board-chat.ts spawns `claude` directly (not through the adapter registry),
// so its own quota-settlement fix can only be proven by driving the real
// spawned-process lifecycle through the real route.
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mockSpawn };
});

const mockGetExperimental = vi.hoisted(() => vi.fn().mockResolvedValue({ enableConferenceRoomChat: true }));
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: "issue-1" }),
  addComment: vi.fn().mockResolvedValue({ id: "comment-1" }),
  listComments: vi.fn().mockResolvedValue([]),
}));

// The login describe block mounts the real agentRoutes(). Only the services
// unrelated to the dispatch gate are stubbed here (agent lookup, authz
// decisions, secret resolution, and everything else the router factory
// constructs eagerly) — the same shape agent-adapter-validation-routes.test.ts
// uses for this router. `../services/dispatch-gate.js` is never mocked in
// this file: gate acquisition, settlement, and the Postgres row are real.
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn().mockResolvedValue({ allowed: true, reason: "allow", explanation: "test grant" }),
}));
const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => ({}),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: (_agent: unknown, config: unknown) => config,
  workspaceOperationService: () => ({}),
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  isTruthyRuntimeEnvValue: () => false,
  resolveWorktreeRunExecutionActivationState: () => "inactive",
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
vi.mock("../routes/authz.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routes/authz.js")>();
  return {
    ...actual,
    getActorInfo: () => ({ actorId: "user-1", agentId: null, runId: null }),
    assertCompanyAccess: () => {},
  };
});

// agents.ts's claude-login route settlement fix is proven end to end through
// the real route + real services + real db — only the underlying `claude
// login` process call is faked, since we don't want to spawn a real CLI.
const mockRunClaudeLogin = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-claude-local/server")>();
  return { ...actual, runClaudeLogin: mockRunClaudeLogin };
});

function makeFakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

function streamJsonLine(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

async function boardChatApp() {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use("/api", boardChatRoutes({} as any, { deploymentMode: "local_trusted" }));
  return app;
}

describeEmbeddedPostgres("dispatch gate launch-surface quota settlement", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fakeAdapterExecuteCalls = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dispatch-gate-surfaces-");
    db = createDb(tempDb.connectionString);
    setDispatchGateDb(db);

    // Same fake-adapter registration pattern as dispatch-gate.test.ts: real
    // registry lookup, real withDispatchGate, fake underlying launch — used
    // here only to prove a settled quota block blocks the registered adapter
    // path too, without re-testing execute()'s own classification.
    registerServerAdapter({
      type: "claude_local",
      execute: (ctx) =>
        withDispatchGate(
          CLAUDE_LOCAL_DEFAULT_SCOPE,
          { kind: "adapter", id: ctx.runId },
          async () => {
            fakeAdapterExecuteCalls += 1;
            return { exitCode: 0, signal: null, timedOut: false } as AdapterExecutionResult;
          },
          {
            onBlocked: () => ({ exitCode: null, signal: null, timedOut: false, errorCode: "dispatch_gate_blocked" }),
          },
        ),
      testEnvironment: async () => ({
        adapterType: "claude_local",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.create.mockResolvedValue({ id: "issue-1" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.listComments.mockResolvedValue([]);
    fakeAdapterExecuteCalls = 0;
    await db.delete(dispatchGateState);
  });

  afterAll(async () => {
    unregisterServerAdapter("claude_local");
    await tempDb?.cleanup();
  });

  async function expectEveryOtherSurfaceBlocked() {
    const adapter = findActiveServerAdapter("claude_local")!;
    const callsBefore = fakeAdapterExecuteCalls;
    const executeResult = await adapter.execute({
      runId: randomUUID(),
      agent: { id: "a1", companyId: "c1", name: "Claude", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {},
      context: {},
      onLog: async () => {},
    } as AdapterExecutionContext);
    expect(executeResult.errorCode).toBe("dispatch_gate_blocked");
    expect(fakeAdapterExecuteCalls).toBe(callsBefore);

    for (const ownerKind of ["login", "hello_probe", "board_chat"]) {
      const attempt = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: ownerKind, id: randomUUID() });
      expect(attempt.ok).toBe(false);
    }
  }

  describe("board chat", () => {
    it("persists a confirmed quota block and never leaves an idle window, blocking every other surface", async () => {
      const app = await boardChatApp();
      const fakeProc = makeFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const pending = request(app)
        .post("/api/board/chat/stream")
        .send({ companyId: "company-1", message: "hello" })
        .then(() => undefined, () => undefined);

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      fakeProc.stdout.emit(
        "data",
        Buffer.from(
          streamJsonLine({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "You've hit your session limit - resets at 4pm (America/Chicago).",
          }),
        ),
      );
      fakeProc.exitCode = 1;
      fakeProc.emit("close", 1, null);
      await pending;

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.ownershipState).toBe("idle");
      expect(row?.blockedUntil).not.toBeNull();

      await expectEveryOtherSurfaceBlocked();
    });

    it("releases to idle on a confirmed non-quota exit, without opening a quota block", async () => {
      const app = await boardChatApp();
      const fakeProc = makeFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const pending = request(app)
        .post("/api/board/chat/stream")
        .send({ companyId: "company-1", message: "hello" })
        .then(() => undefined, () => undefined);

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      fakeProc.stdout.emit(
        "data",
        Buffer.from(streamJsonLine({ type: "result", subtype: "success", is_error: false, result: "done" })),
      );
      fakeProc.exitCode = 0;
      fakeProc.emit("close", 0, null);
      await pending;

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.ownershipState).toBe("idle");
      expect(row?.blockedUntil).toBeNull();
      expect(row?.operatorResumeRequired).toBe(false);

      const nextOwner = { kind: "board_chat", id: randomUUID() };
      const nextAcquire = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, nextOwner);
      expect(nextAcquire.ok).toBe(true);
      await releaseDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, nextOwner);
    });

    it("fails closed to unknown on an ambiguous, signal-killed termination with no evidence", async () => {
      const app = await boardChatApp();
      const fakeProc = makeFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const pending = request(app)
        .post("/api/board/chat/stream")
        .send({ companyId: "company-1", message: "hello" })
        .then(() => undefined, () => undefined);

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      // No stdout/stderr at all, killed by an external signal (not our own
      // 120s timeout) — no way to confirm what happened.
      fakeProc.exitCode = null;
      fakeProc.emit("close", null, "SIGKILL");
      await pending;

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.ownershipState).toBe("unknown");

      const nextAcquire = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: "board_chat", id: randomUUID() });
      expect(nextAcquire.ok).toBe(false);
      if (!nextAcquire.ok) expect(nextAcquire.reason).toBe("ownership_unknown");
    });

    it.each([
      {
        name: "generic adapter failure text",
        stderr: "adapter_failed: unexpected internal error",
      },
      {
        name: "ENOENT-style spawn failure text",
        stderr: "Error: spawn claude ENOENT",
      },
      {
        name: "wrapper failure text",
        stderr: "paperclip-claude-wrapper: failed to initialize sandbox",
      },
      {
        name: "generic 'resets' text unrelated to a quota window",
        stderr: "Connection resets intermittently on this network.",
      },
    ])("does not open a quota block on $name", async ({ stderr }) => {
      const app = await boardChatApp();
      const fakeProc = makeFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const pending = request(app)
        .post("/api/board/chat/stream")
        .send({ companyId: "company-1", message: "hello" })
        .then(() => undefined, () => undefined);

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      fakeProc.stderr.emit("data", Buffer.from(stderr));
      fakeProc.exitCode = 1;
      fakeProc.emit("close", 1, null);
      await pending;

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.blockedUntil).toBeNull();
      expect(row?.operatorResumeRequired).toBe(false);
    });

    it("does not classify our own 120s-timeout kill as quota, even with quota-shaped stdout", async () => {
      // Only setTimeout/clearTimeout are faked, and shouldAdvanceTime keeps
      // them running in real wall-clock time until explicitly jumped — so
      // the real Postgres I/O (which never calls setTimeout for a plain
      // query) and supertest's own request handling are undisturbed. The
      // route's 120s timer must be *created* under fake timers to be
      // jump-able, so fake timers are enabled before the request is sent.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        const app = await boardChatApp();
        const fakeProc = makeFakeProc();
        mockSpawn.mockReturnValue(fakeProc);

        const pending = request(app)
          .post("/api/board/chat/stream")
          .send({ companyId: "company-1", message: "hello" })
          .then(() => undefined, () => undefined);

        await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

        vi.advanceTimersByTime(120_001);
        expect(fakeProc.kill).toHaveBeenCalledWith("SIGTERM");

        // Even if quota-shaped text arrived right before the kill, our own
        // timeout classification takes precedence and is never quota.
        fakeProc.stdout.emit(
          "data",
          Buffer.from(streamJsonLine({ type: "result", is_error: true, result: "Claude usage limit reached." })),
        );
        fakeProc.exitCode = null;
        fakeProc.emit("close", null, "SIGTERM");
        await pending;

        const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
        expect(row?.ownershipState).toBe("idle");
        expect(row?.blockedUntil).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("claude login", () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const claudeAgentId = "22222222-2222-4222-8222-222222222222";

    function boardActor(): Express.Request["actor"] {
      return {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        isInstanceAdmin: true,
        source: "local_implicit",
      } as Express.Request["actor"];
    }

    async function loginApp() {
      const { agentRoutes } = await import("../routes/agents.js");
      const { errorHandler } = await import("../middleware/index.js");
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = boardActor();
        next();
      });
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      return app;
    }

    beforeEach(() => {
      mockRunClaudeLogin.mockReset();
      mockAgentService.getById.mockResolvedValue({
        id: claudeAgentId,
        companyId,
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      });
    });

    it("persists a confirmed quota block and blocks every other surface", async () => {
      mockRunClaudeLogin.mockResolvedValue({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "You've hit your session limit - resets at 4pm (America/Chicago).",
        stderr: "",
        loginUrl: null,
      });

      const app = await loginApp();
      const res = await request(app).post(`/api/agents/${claudeAgentId}/claude-login`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.ownershipState).toBe("idle");
      expect(row?.blockedUntil).not.toBeNull();

      await expectEveryOtherSurfaceBlocked();
    });

    it("releases to idle on a confirmed non-quota terminal result", async () => {
      mockRunClaudeLogin.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Login successful",
        stderr: "",
        loginUrl: null,
      });

      const app = await loginApp();
      const res = await request(app).post(`/api/agents/${claudeAgentId}/claude-login`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.ownershipState).toBe("idle");
      expect(row?.blockedUntil).toBeNull();
    });

    it("marks ownership unknown when runClaudeLogin throws (thrown/ambiguous result)", async () => {
      mockRunClaudeLogin.mockRejectedValue(new Error("simulated crash mid-login"));

      const app = await loginApp();
      const res = await request(app).post(`/api/agents/${claudeAgentId}/claude-login`).send({});
      expect(res.status).toBeGreaterThanOrEqual(500);

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.ownershipState).toBe("unknown");

      const nextAcquire = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: "login", id: randomUUID() });
      expect(nextAcquire.ok).toBe(false);
      if (!nextAcquire.ok) expect(nextAcquire.reason).toBe("ownership_unknown");
      // No automatic cleanup — reset by hand so later tests start clean.
      await db
        .update(dispatchGateState)
        .set({ ownershipState: "idle", ownerKind: null, ownerId: null })
        .where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
    });

    it.each([
      { name: "timeout", result: { exitCode: 1, signal: null, timedOut: true, stdout: "", stderr: "" } },
      {
        name: "generic adapter_failed",
        result: { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "adapter_failed: internal error" },
      },
      {
        name: "ENOENT",
        result: { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "spawn claude ENOENT" },
      },
      {
        name: "process loss",
        result: { exitCode: null, signal: "SIGKILL", timedOut: false, stdout: "", stderr: "" },
      },
      {
        name: "generic 'resets' text",
        result: { exitCode: 1, signal: null, timedOut: false, stdout: "The page resets every 30 seconds.", stderr: "" },
      },
    ])("does not open a quota block on $name", async ({ result }) => {
      mockRunClaudeLogin.mockResolvedValue({ ...result, loginUrl: null });

      const app = await loginApp();
      const res = await request(app).post(`/api/agents/${claudeAgentId}/claude-login`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.blockedUntil).toBeNull();
      expect(row?.operatorResumeRequired).toBe(false);
    });
  });
});
