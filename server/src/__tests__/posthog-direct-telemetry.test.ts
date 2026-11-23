import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackAgentTaskRun, trackCompanyImported, trackRoutineCreated, trackRoutineRun, trackPlanApproved, trackTaskBlocked, trackTaskCompleted, trackTaskCreated } from "@paperclipai/shared/telemetry";

const hoisted = vi.hoisted(() => ({ instanceRoot: "", posthogNodeLoads: 0 }));

vi.mock("../home-paths.js", () => ({
  resolvePaperclipInstanceRoot: () => hoisted.instanceRoot,
}));

// Counts real loads of the package. Self-hosted servers must never load it.
vi.mock("posthog-node", () => {
  hoisted.posthogNodeLoads += 1;
  return { PostHog: class {} };
});

import {
  getTelemetryClient,
  initTelemetry,
  isPostHogDirectTelemetryActive,
  resetTelemetryForTests,
  shutdownTelemetry,
} from "../telemetry.js";
import type { PostHogNodeClient } from "../services/posthog-direct/index.js";
import {
  capturePostHogEventContext,
  postHogRequestContextMiddlewareForEnv,
} from "../services/posthog-direct/request-context.js";
import { resolveTelemetryPerson, withTelemetryActor, withTelemetryCompany } from "../telemetry-company-scope.js";
import { serverVersion } from "../version.js";

const COLLECTOR = "http://collector.test/ingest";
const CLOUD_ENV = {
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-token",
  PAPERCLIP_CLOUD_STACK_ID: "stack-123",
  PAPERCLIP_STACK_SLUG: "acme",
  PAPERCLIP_PRIMARY_HOST: "acme.paperclip.app",
  PAPERCLIP_POSTHOG_PROJECT_TOKEN: "phc_test",
  PAPERCLIP_POSTHOG_ENVIRONMENT: "staging",
};

function fakePostHog() {
  const captured: Array<Parameters<PostHogNodeClient["capture"]>[0]> = [];
  const groups: Array<Parameters<PostHogNodeClient["groupIdentify"]>[0]> = [];
  const client: PostHogNodeClient & { shutdownCalls: number } = {
    shutdownCalls: 0,
    capture: (message) => void captured.push(message),
    groupIdentify: (message) => void groups.push(message),
    flush: async () => {},
    shutdown: async () => {
      client.shutdownCalls += 1;
    },
  };
  const factory = vi.fn(async () => client);
  return { client, captured, groups, factory };
}

function readState() {
  return JSON.parse(readFileSync(path.join(hoisted.instanceRoot, "telemetry", "state.json"), "utf-8")) as {
    installId: string;
    salt: string;
  };
}

describe("server telemetry sender selection", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hoisted.instanceRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-posthog-direct-"));
    hoisted.posthogNodeLoads = 0;
    for (const name of ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI", "DO_NOT_TRACK", "PAPERCLIP_TELEMETRY_DISABLED"]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("PAPERCLIP_TELEMETRY_ENDPOINT", COLLECTOR);
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetTelemetryForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(hoisted.instanceRoot, { recursive: true, force: true });
  });

  it("self-hosted: posts the unchanged hashed envelope to the collector and never loads posthog-node", async () => {
    const client = initTelemetry({ enabled: true }, { env: {} })!;
    expect(isPostHogDirectTelemetryActive()).toBe(false);
    trackAgentTaskRun(client, { agentId: "agent-1", state: "succeeded", taskId: "task-raw-id" });
    await shutdownTelemetry();

    expect(hoisted.posthogNodeLoads).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(COLLECTOR);
    const body = String((fetchMock.mock.calls[0]![1] as RequestInit).body);
    const parsed = JSON.parse(body);
    const state = readState();
    const hashedTaskId = createHash("sha256").update(state.salt + "task-raw-id").digest("hex").slice(0, 16);
    // Byte-identical to the envelope the collector path has always sent.
    expect(body).toBe(
      JSON.stringify({
        app: "paperclip",
        schemaVersion: "1",
        installId: state.installId,
        version: serverVersion,
        events: [
          { name: "server.started", occurredAt: parsed.events[0].occurredAt, dimensions: { os_platform: process.platform } },
          {
            name: "agent.task_run",
            occurredAt: parsed.events[1].occurredAt,
            dimensions: { agent_id: "agent-1", state: "succeeded", task_id: hashedTaskId },
          },
        ],
        batchId: parsed.batchId,
      }),
    );
  });

  it("self-hosted: a background company scope leaves the collector envelope byte-identical", async () => {
    const client = initTelemetry({ enabled: true }, { env: {} })!;
    await withTelemetryCompany("company-bg", async () => {
      await Promise.resolve();
      trackAgentTaskRun(client, { agentId: "agent-1", state: "succeeded" });
      trackRoutineRun(client, { source: "schedule", status: "issue_created" });
    });
    await shutdownTelemetry();

    expect(hoisted.posthogNodeLoads).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String((fetchMock.mock.calls[0]![1] as RequestInit).body);
    const parsed = JSON.parse(body);
    expect(body).toBe(
      JSON.stringify({
        app: "paperclip",
        schemaVersion: "1",
        installId: readState().installId,
        version: serverVersion,
        events: [
          { name: "server.started", occurredAt: parsed.events[0].occurredAt, dimensions: { os_platform: process.platform } },
          {
            name: "agent.task_run",
            occurredAt: parsed.events[1].occurredAt,
            dimensions: { agent_id: "agent-1", state: "succeeded" },
          },
          {
            name: "routine.run",
            occurredAt: parsed.events[2].occurredAt,
            dimensions: { source: "schedule", status: "issue_created" },
          },
        ],
        batchId: parsed.batchId,
      }),
    );
    expect(body).not.toContain("company");
  });

  it("self-hosted: a background person scope leaves the collector envelope byte-identical", async () => {
    const client = initTelemetry({ enabled: true }, { env: {} })!;
    const person = resolveTelemetryPerson({ taskCreatedByUserId: "user-creator" });
    await withTelemetryActor({ companyId: "company-bg", person }, async () => {
      await Promise.resolve();
      trackAgentTaskRun(client, { agentId: "agent-1", state: "succeeded" });
    });
    await shutdownTelemetry();

    expect(hoisted.posthogNodeLoads).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String((fetchMock.mock.calls[0]![1] as RequestInit).body);
    const parsed = JSON.parse(body);
    expect(body).toBe(
      JSON.stringify({
        app: "paperclip",
        schemaVersion: "1",
        installId: readState().installId,
        version: serverVersion,
        events: [
          { name: "server.started", occurredAt: parsed.events[0].occurredAt, dimensions: { os_platform: process.platform } },
          {
            name: "agent.task_run",
            occurredAt: parsed.events[1].occurredAt,
            dimensions: { agent_id: "agent-1", state: "succeeded" },
          },
        ],
        batchId: parsed.batchId,
      }),
    );
    expect(body).not.toContain("user-creator");
    expect(body).not.toContain("attributed_via");
  });

  it("self-hosted: a person scope leaves product lifecycle collector events unchanged", async () => {
    const client = initTelemetry({ enabled: true }, { env: {} })!;
    const person = resolveTelemetryPerson({ taskCreatedByUserId: "user-creator" });
    withTelemetryActor({ companyId: "company-bg", person }, () => {
      trackTaskCompleted(client, { completedByKind: "agent", isSubtask: false });
      trackTaskCreated(client, { createdByKind: "onboarding", isSubtask: false });
    });
    await shutdownTelemetry();

    const body = String((fetchMock.mock.calls[0]![1] as RequestInit).body);
    const events = JSON.parse(body).events.filter((event: { name: string }) => event.name !== "server.started");
    expect(events.map((event: { name: string; dimensions: unknown }) => [event.name, event.dimensions])).toEqual([
      ["task.completed", { completed_by_kind: "agent", is_subtask: false }],
      ["task.created", { created_by_kind: "onboarding", is_subtask: false }],
    ]);
    expect(body).not.toContain("user-creator");
    expect(body).not.toContain("attributed_via");
    expect(body).not.toContain("company-bg");
  });

  it("self-hosted: ignores posthog-js tracing headers", async () => {
    expect(postHogRequestContextMiddlewareForEnv({})).toBeNull();
    expect(postHogRequestContextMiddlewareForEnv({ PAPERCLIP_POSTHOG_PROJECT_TOKEN: "phc_test" })).toBeNull();
    const app = express();
    let context: unknown = "unset";
    app.get("/probe", (_req, res) => {
      context = capturePostHogEventContext();
      res.json({});
    });
    await request(app).get("/probe").set("X-POSTHOG-SESSION-ID", "sess-1").expect(200);
    expect(context).toBeUndefined();
  });

  it("Cloud: sends each batch only to PostHog with real ids, and identifies the workspace group", async () => {
    const posthog = fakePostHog();
    const client = initTelemetry({ enabled: true }, { env: CLOUD_ENV, postHogFactory: posthog.factory })!;
    expect(isPostHogDirectTelemetryActive()).toBe(true);
    trackAgentTaskRun(client, { agentId: "agent-1", state: "succeeded", taskId: "task-raw-id" });
    trackCompanyImported(client, { sourceType: "github", sourceRef: "acme/private-repo", isPrivate: true });
    await shutdownTelemetry();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(posthog.captured.map((message) => message.event).sort()).toEqual([
      "agent.task_run",
      "cloud.workspace_started",
      "company.imported",
      "server.started",
    ]);
    // A private source ref is customer content: it stays hashed on Cloud too.
    const imported = posthog.captured.find((message) => message.event === "company.imported")!;
    const salt = readState().salt;
    expect(imported.properties).toMatchObject({
      source_ref: createHash("sha256").update(salt + "acme/private-repo").digest("hex").slice(0, 16),
      source_ref_hashed: true,
    });
    expect(JSON.stringify(imported)).not.toContain("acme/private-repo");
    const run = posthog.captured.find((message) => message.event === "agent.task_run")!;
    expect(run.distinctId).toBe("workspace:stack-123");
    expect(run.groups).toEqual({ workspace: "stack-123" });
    expect(run.disableGeoip).toBe(true);
    expect(run.properties).toMatchObject({
      agent_id: "agent-1",
      task_id: "task-raw-id",
      stack_id: "stack-123",
      environment: "staging",
      deployment_source: "cloud",
      $groups: { workspace: "stack-123" },
      $process_person_profile: false,
    });
    expect(run.properties).not.toHaveProperty("install_hash");

    const installHash = createHash("sha256").update(readState().installId).digest("hex");
    const started = posthog.captured.find((message) => message.event === "cloud.workspace_started")!;
    expect(started.distinctId).toBe("workspace:stack-123");
    expect(started.groups).toEqual({ workspace: "stack-123" });
    expect(started.properties).toMatchObject({
      app: "paperclip",
      schema_version: "1",
      source: "client",
      deployment_source: "cloud",
      version: serverVersion,
      stack_id: "stack-123",
      install_hash: installHash,
      attributed_via: "none",
      environment: "staging",
      distinct_id: "workspace:stack-123",
      $process_person_profile: false,
    });
    for (const message of posthog.captured) {
      expect(message.properties?.environment, message.event).toBe("staging");
      if (message.event !== "$groupidentify") expect(message.properties?.attributed_via, message.event).toBe("none");
      if (message.event !== "cloud.workspace_started") expect(message.properties).not.toHaveProperty("install_hash");
    }
    expect(posthog.groups).toEqual([
      {
        groupType: "workspace",
        groupKey: "stack-123",
        disableGeoip: true,
        properties: { stack_slug: "acme", primary_host: "acme.paperclip.app", environment: "staging" },
      },
    ]);
    expect(posthog.client.shutdownCalls).toBe(1);
  });

  it("Cloud: stays on the collector when PAPERCLIP_POSTHOG_ENVIRONMENT is unset", async () => {
    const posthog = fakePostHog();
    const { PAPERCLIP_POSTHOG_ENVIRONMENT: _omit, ...noEnvironment } = CLOUD_ENV;
    const client = initTelemetry({ enabled: true }, { env: noEnvironment, postHogFactory: posthog.factory })!;
    expect(isPostHogDirectTelemetryActive()).toBe(false);
    trackRoutineCreated(client);
    await shutdownTelemetry();

    expect(posthog.factory).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(COLLECTOR);
    expect(postHogRequestContextMiddlewareForEnv(noEnvironment)).toBeNull();
  });

  it("Cloud: the kill switch falls back to the collector", async () => {
    const posthog = fakePostHog();
    const client = initTelemetry(
      { enabled: true },
      { env: { ...CLOUD_ENV, PAPERCLIP_POSTHOG_DIRECT: "0" }, postHogFactory: posthog.factory },
    )!;
    expect(isPostHogDirectTelemetryActive()).toBe(false);
    trackRoutineCreated(client);
    await shutdownTelemetry();

    expect(posthog.factory).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postHogRequestContextMiddlewareForEnv({ ...CLOUD_ENV, PAPERCLIP_POSTHOG_DIRECT: "0" })).toBeNull();
  });

  it("Cloud: links request events to the acting user and browser session", async () => {
    const posthog = fakePostHog();
    initTelemetry({ enabled: true }, { env: CLOUD_ENV, postHogFactory: posthog.factory });
    const middleware = postHogRequestContextMiddlewareForEnv(CLOUD_ENV);
    expect(middleware).not.toBeNull();

    const app = express();
    app.use(middleware!);
    app.use((req, _res, next) => {
      const as = req.header("x-test-actor");
      req.actor =
        as === "user"
          ? { type: "board", userId: "user-1", source: "session" }
          : as === "agent"
            ? { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" }
            : { type: "none", source: "none" };
      next();
    });
    app.post("/companies/:companyId/routines", (_req, res) => {
      trackRoutineCreated(getTelemetryClient()!);
      res.json({});
    });

    await request(app)
      .post("/companies/company-9/routines")
      .set("x-test-actor", "user")
      .set("X-POSTHOG-SESSION-ID", "0190f6b2-7c1d-7a3e-9f00-123456789abc")
      .set("X-POSTHOG-WINDOW-ID", "0190f6b2-7c1d-7a3e-9f00-abcdefabcdef")
      // Never used for identity.
      .set("X-POSTHOG-DISTINCT-ID", "spoofed-person")
      .expect(200);
    await request(app).post("/companies/company-9/routines").set("x-test-actor", "agent").expect(200);
    await request(app)
      .post("/companies/company-9/routines")
      .set("X-POSTHOG-SESSION-ID", "bad id with spaces")
      // An anonymous request cannot claim a person through the header either.
      .set("X-POSTHOG-DISTINCT-ID", "spoofed-person")
      .expect(200);
    await shutdownTelemetry();

    const routines = posthog.captured.filter((message) => message.event === "routine.created");
    expect(routines).toHaveLength(3);
    expect(routines[0]!.distinctId).toBe("user-1");
    expect(routines[0]!.properties).toMatchObject({
      user_id: "user-1",
      company_id: "company-9",
      $session_id: "0190f6b2-7c1d-7a3e-9f00-123456789abc",
      $window_id: "0190f6b2-7c1d-7a3e-9f00-abcdefabcdef",
    });
    expect(routines[0]!.properties).not.toHaveProperty("$process_person_profile");
    expect(JSON.stringify(routines)).not.toContain("spoofed-person");

    expect(routines[1]!.distinctId).toBe("workspace:stack-123");
    expect(routines[1]!.properties).toMatchObject({ company_id: "company-1", $process_person_profile: false });
    expect(routines[1]!.properties).not.toHaveProperty("user_id");

    expect(routines[2]!.distinctId).toBe("workspace:stack-123");
    expect(routines[2]!.properties).not.toHaveProperty("$session_id");
    expect(routines[2]!.properties).not.toHaveProperty("user_id");
    expect(routines[2]!.properties).toMatchObject({ distinct_id: "workspace:stack-123", $process_person_profile: false });
  });

  it("Cloud: uses a board user's only company on routes without a company id", async () => {
    const posthog = fakePostHog();
    initTelemetry({ enabled: true }, { env: CLOUD_ENV, postHogFactory: posthog.factory });
    const app = express();
    app.use(postHogRequestContextMiddlewareForEnv(CLOUD_ENV)!);
    app.use((req, _res, next) => {
      const companyIds = req.header("x-test-companies")!.split(",");
      req.actor = { type: "board", userId: "user-1", companyIds, source: "cloud_tenant" };
      next();
    });
    app.post("/issues/:id/interactions/:interactionId/reject", (_req, res) => {
      trackRoutineCreated(getTelemetryClient()!);
      res.json({});
    });
    await request(app).post("/issues/i-1/interactions/x-1/reject").set("x-test-companies", "company-1").expect(200);
    await request(app)
      .post("/issues/i-1/interactions/x-1/reject")
      .set("x-test-companies", "company-1,company-2")
      .expect(200);
    await shutdownTelemetry();

    const routines = posthog.captured.filter((message) => message.event === "routine.created");
    expect(routines[0]!.properties).toMatchObject({ company_id: "company-1", user_id: "user-1" });
    expect(routines[1]!.properties).not.toHaveProperty("company_id");
  });

  it("Cloud: work that outlives its request does not inherit the request's user", async () => {
    const posthog = fakePostHog();
    initTelemetry({ enabled: true }, { env: CLOUD_ENV, postHogFactory: posthog.factory });
    const app = express();
    app.use(postHogRequestContextMiddlewareForEnv(CLOUD_ENV)!);
    let later: Promise<void> | null = null;
    app.post("/start", (req, res) => {
      req.actor = { type: "board", userId: "user-1", source: "session" };
      later = new Promise((resolve) => {
        res.on("finish", () =>
          setTimeout(() => {
            trackRoutineCreated(getTelemetryClient()!);
            resolve();
          }, 5),
        );
      });
      res.json({});
    });
    await request(app).post("/start").set("X-POSTHOG-SESSION-ID", "sess-1").expect(200);
    await later;
    await shutdownTelemetry();

    const routine = posthog.captured.find((message) => message.event === "routine.created")!;
    expect(routine.distinctId).toBe("workspace:stack-123");
    expect(routine.properties).not.toHaveProperty("$session_id");
  });

  it("Cloud: background events carry the company in scope", async () => {
    const posthog = fakePostHog();
    const client = initTelemetry({ enabled: true }, { env: CLOUD_ENV, postHogFactory: posthog.factory })!;
    await withTelemetryCompany("company-bg", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      trackAgentTaskRun(client, { agentId: "agent-1", state: "succeeded" });
    });
    withTelemetryCompany("company-bg", () => trackRoutineRun(client, { source: "schedule", status: "issue_created" }));
    trackRoutineCreated(client);
    await shutdownTelemetry();

    const run = posthog.captured.find((message) => message.event === "agent.task_run")!;
    expect(run.distinctId).toBe("workspace:stack-123");
    expect(run.properties).toMatchObject({ company_id: "company-bg", stack_id: "stack-123", $process_person_profile: false });
    expect(run.properties).not.toHaveProperty("user_id");
    const routineRun = posthog.captured.find((message) => message.event === "routine.run")!;
    expect(routineRun.properties).toMatchObject({ company_id: "company-bg", stack_id: "stack-123" });
    const unscoped = posthog.captured.find((message) => message.event === "routine.created")!;
    expect(unscoped.properties).not.toHaveProperty("company_id");
  });

  it("Cloud: background product lifecycle events carry the company in scope", async () => {
    const posthog = fakePostHog();
    const client = initTelemetry({ enabled: true }, { env: CLOUD_ENV, postHogFactory: posthog.factory })!;
    const person = resolveTelemetryPerson({ taskCreatedByUserId: "user-creator" });
    withTelemetryActor({ companyId: "company-bg", person }, () => {
      trackTaskCreated(client, { createdByKind: "routine", isSubtask: false });
      trackTaskCompleted(client, { completedByKind: "agent", isSubtask: true });
      trackTaskBlocked(client, { blockedReason: "waiting_on_task", blockedByKind: "system" });
      trackAgentTaskRun(client, { agentId: "agent-1", state: "failed", failureCause: "provider_limit" });
    });
    withTelemetryCompany("company-bg", () => trackPlanApproved(client, { approvedByKind: "system", startsExecution: false }));
    await shutdownTelemetry();

    for (const event of ["task.created", "task.completed", "task.blocked", "agent.task_run"]) {
      const message = posthog.captured.find((captured) => captured.event === event)!;
      expect(message.distinctId).toBe("user-creator");
      expect(message.properties).toMatchObject({ company_id: "company-bg", stack_id: "stack-123",
        user_id: "user-creator", attributed_via: "task_creator" });
    }
    const unattributed = posthog.captured.find((captured) => captured.event === "plan.approved")!;
    expect(unattributed.distinctId).toBe("workspace:stack-123");
    expect(unattributed.properties).toMatchObject({ company_id: "company-bg", attributed_via: "none", $process_person_profile: false });
    expect(posthog.captured.find((captured) => captured.event === "agent.task_run")!.properties)
      .toMatchObject({ failure_cause: "provider_limit", normalized_properties: [] });
  });

  it("Cloud: a live request's company wins over a background company scope", async () => {
    const posthog = fakePostHog();
    initTelemetry({ enabled: true }, { env: CLOUD_ENV, postHogFactory: posthog.factory });
    const app = express();
    app.use(postHogRequestContextMiddlewareForEnv(CLOUD_ENV)!);
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "user-1", source: "session" };
      next();
    });
    app.post("/companies/:companyId/routines", (_req, res) => {
      withTelemetryCompany("company-bg", () => trackRoutineCreated(getTelemetryClient()!));
      res.json({});
    });
    app.post("/runs", (_req, res) => {
      withTelemetryCompany("company-bg", () => trackRoutineCreated(getTelemetryClient()!));
      res.json({});
    });
    await request(app).post("/companies/company-9/routines").expect(200);
    await request(app).post("/runs").expect(200);
    await shutdownTelemetry();

    const routines = posthog.captured.filter((message) => message.event === "routine.created");
    expect(routines).toHaveLength(2);
    expect(routines[0]!.properties).toMatchObject({ company_id: "company-9", user_id: "user-1" });
    expect(routines[1]!.properties).toMatchObject({ company_id: "company-bg", user_id: "user-1" });
  });

  it("Cloud: resolves the person responsible for agent work in priority order", () => {
    expect(resolveTelemetryPerson({
      taskCreatedByUserId: "user-creator",
      taskAssignedByUserId: "user-assigner",
      runOwnerUserId: "user-owner",
    })).toEqual({ userId: "user-creator", attributedVia: "task_creator" });
    expect(resolveTelemetryPerson({ taskAssignedByUserId: "user-assigner", runOwnerUserId: "user-owner" }))
      .toEqual({ userId: "user-assigner", attributedVia: "task_assigner" });
    expect(resolveTelemetryPerson({ taskCreatedByUserId: " ", runOwnerUserId: "user-owner" }))
      .toEqual({ userId: "user-owner", attributedVia: "run_owner" });
    expect(resolveTelemetryPerson({ taskCreatedByUserId: "local-board", runOwnerUserId: null })).toBeNull();
    expect(resolveTelemetryPerson({})).toBeNull();
  });

  it.each([
    { name: "task creator", input: { taskCreatedByUserId: "paperclip-id:creator", taskAssignedByUserId: "paperclip-id:assigner" }, distinctId: "paperclip-id:creator", via: "task_creator" },
    { name: "task assigner", input: { taskAssignedByUserId: "paperclip-id:assigner", runOwnerUserId: "paperclip-id:owner" }, distinctId: "paperclip-id:assigner", via: "task_assigner" },
    { name: "run owner", input: { runOwnerUserId: "paperclip-id:owner" }, distinctId: "paperclip-id:owner", via: "run_owner" },
  ])("Cloud: background agent work is attributed to the $name", async ({ input, distinctId, via }) => {
    const posthog = fakePostHog();
    const client = initTelemetry({ enabled: true }, { env: CLOUD_ENV, postHogFactory: posthog.factory })!;
    await withTelemetryActor({ companyId: "company-bg", person: resolveTelemetryPerson(input) }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      trackAgentTaskRun(client, { agentId: "agent-1", state: "succeeded" });
    });
    await shutdownTelemetry();

    const run = posthog.captured.find((message) => message.event === "agent.task_run")!;
    expect(run.distinctId).toBe(distinctId);
    expect(run.groups).toEqual({ workspace: "stack-123" });
    expect(run.properties).toMatchObject({
      company_id: "company-bg",
      user_id: distinctId,
      attributed_via: via,
      distinct_id: distinctId,
    });
    expect(run.properties).not.toHaveProperty("$process_person_profile");
  });

  it("Cloud: background agent work with no person stays on the workspace", async () => {
    const posthog = fakePostHog();
    const client = initTelemetry({ enabled: true }, { env: CLOUD_ENV, postHogFactory: posthog.factory })!;
    withTelemetryActor({ companyId: "company-bg", person: resolveTelemetryPerson({}) }, () =>
      trackAgentTaskRun(client, { agentId: "agent-1", state: "succeeded" }));
    await shutdownTelemetry();

    const run = posthog.captured.find((message) => message.event === "agent.task_run")!;
    expect(run.distinctId).toBe("workspace:stack-123");
    expect(run.properties).toMatchObject({ attributed_via: "none", $process_person_profile: false });
    expect(run.properties).not.toHaveProperty("user_id");
  });

  it("Cloud: the signed-in request user wins over a background person scope", async () => {
    const posthog = fakePostHog();
    initTelemetry({ enabled: true }, { env: CLOUD_ENV, postHogFactory: posthog.factory });
    const app = express();
    app.use(postHogRequestContextMiddlewareForEnv(CLOUD_ENV)!);
    app.use((req, _res, next) => {
      if (req.path === "/agent") req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_jwt" };
      else req.actor = { type: "board", userId: "paperclip-id:request-user", source: "session" };
      next();
    });
    const person = resolveTelemetryPerson({ taskCreatedByUserId: "paperclip-id:creator" });
    app.post("/board", (_req, res) => {
      withTelemetryActor({ companyId: "company-1", person }, () =>
        trackAgentTaskRun(getTelemetryClient()!, { agentId: "agent-1", state: "cancelled" }));
      res.json({});
    });
    app.post("/agent", (_req, res) => {
      withTelemetryActor({ companyId: "company-1", person }, () =>
        trackAgentTaskRun(getTelemetryClient()!, { agentId: "agent-1", state: "succeeded" }));
      res.json({});
    });
    await request(app).post("/board").expect(200);
    await request(app).post("/agent").expect(200);
    await shutdownTelemetry();

    const runs = posthog.captured.filter((message) => message.event === "agent.task_run");
    const byState = Object.fromEntries(runs.map((message) => [message.properties?.state, message]));
    expect(byState.cancelled!.distinctId).toBe("paperclip-id:request-user");
    expect(byState.cancelled!.properties).toMatchObject({ attributed_via: "request" });
    expect(byState.succeeded!.distinctId).toBe("paperclip-id:creator");
    expect(byState.succeeded!.properties).toMatchObject({ attributed_via: "task_creator", company_id: "company-1" });
  });
});
