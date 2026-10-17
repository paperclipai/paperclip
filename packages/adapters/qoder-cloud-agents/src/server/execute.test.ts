import { describe, expect, it, vi } from "vitest";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { buildSessionEnv, execute } from "./execute.js";
import {
  AGENT_ID,
  END_TURN,
  ENV_ID,
  SESSION_ID,
  apiError,
  createContext,
  createFakeQoder,
  hangingSse,
  json,
  noSleep,
  sentPrompt,
  sse,
  stdoutEvents,
  storedSessionParams,
} from "./test-support.js";

describe("qoder_cloud_agents execute", () => {
  it("requires an access token before contacting Qoder", async () => {
    const qoder = createFakeQoder();
    const ctx = createContext({ config: { env: {} } });
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("QODER_ACCESS_TOKEN is required");
    expect(qoder.calls).toHaveLength(0);
  });

  it.each(["http://api.qoder.com", "api.qoder.com", "ftp://api.qoder.com"])(
    "refuses to send the access token to the non-https apiBaseUrl %j",
    async (apiBaseUrl) => {
      const calls: string[] = [];
      const ctx = createContext();
      ctx.config.apiBaseUrl = apiBaseUrl;
      const result = await execute(ctx, { fetchImpl: async (url) => { calls.push(url); return json({}); } });
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("https apiBaseUrl");
      expect(calls).toHaveLength(0);
    },
  );

  it("rejects repository URLs Qoder cannot clone", async () => {
    const qoder = createFakeQoder();
    const ctx = createContext();
    ctx.config.repoUrl = "git@github.com:paperclipai/paperclip.git";
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("http(s) repoUrl");
    expect(qoder.calls).toHaveLength(0);
  });

  it("creates a managed agent and session, runs one turn, and reports the outcome", async () => {
    const qoder = createFakeQoder();
    const ctx = createContext();
    const onDispatch = vi.fn(() => {
      expect(qoder.calls).toHaveLength(0);
    });
    const result = await execute({ ...ctx, onDispatch }, { fetchImpl: qoder.fetchImpl });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(qoder.calls.every((call) => call.headers.Authorization === "Bearer pt-secret")).toBe(true);

    const search = qoder.find("POST", "/agents/search")[0];
    expect(search.headers["x-qoder-beta"]).toBe("search-2026-08-31");
    expect(search.body).toMatchObject({ metadata: { managed_by: "paperclip", paperclip_agent_id: "agent-1" } });

    const createdAgent = qoder.calls.find((call) => call.method === "POST" && call.path === "/agents")?.body as Record<string, any>;
    expect(createdAgent.name).toBe("Paperclip Qoder Agent");
    expect(createdAgent.model).toBe("ultimate");
    expect(createdAgent.metadata).toEqual({
      managed_by: "paperclip",
      paperclip_agent_id: "agent-1",
      paperclip_company_id: "company-1",
    });
    expect(createdAgent.tools[0].configs).toContainEqual({ name: "Bash", permission_policy: { type: "always_allow" } });
    expect(createdAgent.tools[0].configs).toHaveLength(createdAgent.tools[0].enabled_tools.length);

    const createdSession = qoder.calls.find((call) => call.method === "POST" && call.path === "/sessions")?.body as Record<string, any>;
    expect(createdSession).toMatchObject({
      agent: AGENT_ID,
      environment_id: ENV_ID,
      title: "Paperclip Qoder Agent",
      environment_variables: {
        EXTRA_FLAG: "1",
        PAPERCLIP_AGENT_ID: "agent-1",
        PAPERCLIP_COMPANY_ID: "company-1",
      },
      resources: [{
        type: "github_repository",
        url: "https://github.com/paperclipai/paperclip.git",
        mount_path: "/data/workspace/paperclip",
        checkout: { type: "branch", name: "main" },
        authorization_token: "ghp_repo_secret",
      }],
    });
    for (const key of Object.keys(createdSession.environment_variables)) {
      expect(key.startsWith("QODER_")).toBe(false);
    }
    expect(createdSession.environment_variables).not.toHaveProperty("PAPERCLIP_API_KEY");
    expect(createdSession.environment_variables).not.toHaveProperty("PAPERCLIP_API_URL");
    expect(createdSession.environment_variables).not.toHaveProperty("PAPERCLIP_RUN_ID");

    const prompt = sentPrompt(qoder);
    expect(prompt).toContain("Do the work for Qoder Agent");
    expect(prompt).toContain("- PAPERCLIP_RUN_ID=run-heartbeat-1");
    expect(prompt).toContain("- PAPERCLIP_TASK_ID=issue-1");
    expect(prompt).toContain("- PAPERCLIP_WAKE_REASON=issue_commented");
    expect(prompt).toContain("cloned at /data/workspace/paperclip");
    expect(prompt).not.toContain("pt-secret");
    expect(prompt).not.toContain("ghp_repo_secret");

    const stream = qoder.find("GET", `/sessions/${SESSION_ID}/events/stream`);
    expect(stream).toHaveLength(1);
    expect(stream[0].headers["Last-Event-ID"]).toBe("evt_user");

    expect(result).toMatchObject({
      sessionId: SESSION_ID,
      sessionDisplayId: SESSION_ID,
      provider: "qoder",
      biller: "qoder",
      billingType: "api",
      model: "ultimate",
      costUsd: null,
      summary: "Done",
      clearSession: false,
    });
    expect(result.sessionParams).toMatchObject({
      qoderSessionId: SESSION_ID,
      qoderAgentId: AGENT_ID,
      managedAgent: true,
      environmentId: ENV_ID,
      apiBaseUrl: "https://api.qoder.com",
      model: "ultimate",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      repoRef: "main",
      repoMountPath: "/data/workspace/paperclip",
    });
    expect(JSON.stringify(result.sessionParams)).not.toContain("secret");
    expect((result.sessionParams as Record<string, unknown>).repoTokenFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(result.resultJson).toMatchObject({
      status: "finished",
      stopReason: "end_turn",
      result: "Done\nWith detail",
      qoderSessionUsage: { model_credits: 1.5, sandbox_runtime_credits: 0.25, total_credits: 1.75 },
    });

    const events = stdoutEvents(ctx);
    expect(events.map((event) => event.type)).toEqual([
      "qoder_cloud_agents.init",
      "qoder_cloud_agents.status",
      "qoder_cloud_agents.event",
      "qoder_cloud_agents.event",
      "qoder_cloud_agents.event",
      "qoder_cloud_agents.event",
      "qoder_cloud_agents.result",
    ]);
    expect(events[0]).toMatchObject({ sessionId: SESSION_ID, agentId: AGENT_ID, model: "ultimate" });
    expect(events.at(-1)).toMatchObject({ status: "finished", result: "Done\nWith detail" });

    expect(ctx.meta[0]).toMatchObject({ adapterType: "qoder_cloud_agents", prompt });
    expect(JSON.stringify(ctx.meta[0])).not.toContain("secret");
  });

  it("sends assignment context on an ordinary cloud task turn", async () => {
    const qoder = createFakeQoder();
    const ctx = createContext({ context: createPromptContextFixture() });
    delete ctx.config.promptTemplate;
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(0);
    const prompt = sentPrompt(qoder);
    expect(prompt).toContain("## Owned assignment");
    expect(prompt).toContain("You are agent agent-1 (Qoder Agent).");
    expect(prompt).not.toContain("Execution contract:");
  });

  it("creates a default environment when the account has no cloud one and uses git_repository for non-GitHub hosts", async () => {
    const qoder = createFakeQoder({
      "GET /environments": () => json({ data: [{ id: "env_self_hosted", config: { type: "self_hosted" } }] }),
    });
    const ctx = createContext();
    ctx.config.repoUrl = "https://bot@gitlab.com/group/repo.git";
    ctx.config.repoMountPath = "/data/custom";
    delete ctx.config.repoStartingRef;
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(qoder.find("POST", "/environments")[0].body).toEqual({ name: "default" });
    const createdSession = qoder.calls.find((call) => call.method === "POST" && call.path === "/sessions")?.body as Record<string, any>;
    expect(createdSession.environment_id).toBe("env_created");
    expect(createdSession.resources).toEqual([{
      type: "git_repository",
      url: "https://bot@gitlab.com/group/repo.git",
      mount_path: "/data/custom",
      password: "ghp_repo_secret",
    }]);
  });

  it("uses a configured Qoder agent and environment without creating either", async () => {
    const qoder = createFakeQoder();
    const ctx = createContext();
    ctx.config.qoderAgentId = "agent_configured";
    ctx.config.environmentId = "env_configured";
    ctx.config.apiBaseUrl = "https://api.qoder.com.cn/";
    delete ctx.config.repoUrl;
    const fetchImpl = (url: string, init?: RequestInit) =>
      qoder.fetchImpl(url.replace("https://api.qoder.com.cn", "https://api.qoder.com"), init);
    const result = await execute(ctx, { fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(qoder.find("POST", "/agents")).toHaveLength(0);
    expect(qoder.find("GET", "/environments")).toHaveLength(0);
    const createdSession = qoder.calls.find((call) => call.method === "POST" && call.path === "/sessions")?.body as Record<string, any>;
    expect(createdSession).toMatchObject({ agent: "agent_configured", environment_id: "env_configured" });
    expect(createdSession).not.toHaveProperty("resources");
    expect(result.model).toBeNull();
    expect(result.sessionParams).toMatchObject({
      qoderAgentId: "agent_configured",
      managedAgent: false,
      apiBaseUrl: "https://api.qoder.com.cn",
    });
  });

  it("reuses the managed Qoder agent and updates its model when the configured model changed", async () => {
    const qoder = createFakeQoder({
      "POST /agents/search": () => json({ data: [{ id: "agent_existing", version: 4, model: { id: "ultimate" }, archived_at: null }] }),
      "POST /agents/:id": () => json({ id: "agent_existing", version: 5 }),
    });
    const ctx = createContext();
    ctx.config.model = "performance";
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(qoder.calls.filter((call) => call.method === "POST" && call.path === "/agents")).toHaveLength(0);
    expect(qoder.find("POST", "/agents/agent_existing")[0].body).toEqual({ version: 4, model: "performance" });
    expect(result.sessionParams).toMatchObject({ qoderAgentId: "agent_existing", model: "performance" });
  });

  it("falls back to creating a managed agent when the beta search endpoint is unavailable", async () => {
    const qoder = createFakeQoder({ "POST /agents/search": () => apiError(400, "invalid_request_error", "beta disabled") });
    const result = await execute(createContext(), { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(qoder.calls.filter((call) => call.method === "POST" && call.path === "/agents")).toHaveLength(1);
  });

  it("resumes a matching stored session even though Paperclip's injected env changes every run", async () => {
    const base = createContext();
    const sessionParams = await storedSessionParams(base);
    const qoder = createFakeQoder();
    const ctx = createContext({
      runtime: { sessionId: SESSION_ID, sessionParams, sessionDisplayId: SESSION_ID, taskKey: null },
    });
    const saved = structuredClone(ctx.config);
    ctx.agent.adapterConfig = saved;
    ctx.config.env = { ...(ctx.config.env as object), TMPDIR: "/var/folders/xx/T/paperclip-run-2", PAPERCLIP_RUN_SCRATCH_DIR: "/tmp/run-2" };
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(qoder.calls.filter((call) => call.method === "POST" && call.path === "/sessions")).toHaveLength(0);
    expect(qoder.find("POST", "/agents")).toHaveLength(0);
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/events`)).toHaveLength(1);
    expect(result.sessionParams).toEqual(sessionParams);
    expect((ctx.meta[0].commandNotes as string[]).join("\n")).toContain(`Reusing Qoder session ${SESSION_ID}`);
  });

  it.each([
    ["Qoder no longer has it", () => apiError(404, "not_found_error", "Session was not found.")],
    ["it was terminated", () => json({ id: SESSION_ID, status: "terminated" })],
    ["it was archived", () => json({ id: SESSION_ID, status: "idle", archived_at: "2026-01-01T00:00:00Z" })],
  ])("starts a fresh session when the stored one cannot be used because %s", async (_label, probe) => {
    const sessionParams = await storedSessionParams(createContext());
    const usable = () => json({ id: SESSION_ID, status: "idle", archived_at: null });
    const qoder = createFakeQoder({ "GET /sessions/:id": [probe, usable] });
    const ctx = createContext({
      runtime: { sessionId: SESSION_ID, sessionParams, sessionDisplayId: SESSION_ID, taskKey: null },
    });
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(qoder.calls.filter((call) => call.method === "POST" && call.path === "/sessions")).toHaveLength(1);
    expect((ctx.meta[0].commandNotes as string[]).join("\n")).toContain("Creating a new Qoder session");
  });

  it.each([
    ["session env vars", (config: Record<string, any>) => { config.env = { ...config.env, EXTRA_FLAG: "2" }; }],
    ["repository ref", (config: Record<string, any>) => { config.repoStartingRef = "release"; }],
    ["model", (config: Record<string, any>) => { config.model = "performance"; }],
    ["configured agent", (config: Record<string, any>) => { config.qoderAgentId = "agent_other"; }],
    ["configured environment", (config: Record<string, any>) => { config.environmentId = "env_other"; }],
    ["environment setting, cleared back to the default", null],
    ["repository token", (config: Record<string, any>) => { config.env = { ...config.env, QODER_REPO_TOKEN: "ghp_rotated_secret" }; }],
  ])("does not reuse a stored session after the %s changed", async (_label, mutate) => {
    const before = createContext();
    // The cleared-environment case starts from a session pinned to an explicit environment.
    if (!mutate) before.config.environmentId = "env_self_hosted";
    const sessionParams = await storedSessionParams(before);
    const qoder = createFakeQoder();
    const ctx = createContext({
      runtime: { sessionId: SESSION_ID, sessionParams, sessionDisplayId: SESSION_ID, taskKey: null },
    });
    mutate?.(ctx.config);
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(qoder.calls.filter((call) => call.method === "POST" && call.path === "/sessions")).toHaveLength(1);
  });

  it("waits for an in-flight turn before sending the heartbeat", async () => {
    const sessionParams = await storedSessionParams(createContext());
    const running = () => json({ id: SESSION_ID, status: "running", archived_at: null });
    const idle = () => json({ id: SESSION_ID, status: "idle", archived_at: null });
    const qoder = createFakeQoder({ "GET /sessions/:id": [running, running, idle] });
    const sleep = vi.fn(async () => {
      expect(qoder.find("POST", `/sessions/${SESSION_ID}/events`)).toHaveLength(0);
    });
    const ctx = createContext({
      runtime: { sessionId: SESSION_ID, sessionParams, sessionDisplayId: SESSION_ID, taskKey: null },
    });
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl, sleep });
    expect(result.exitCode).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/events`)).toHaveLength(1);
  });

  it("retries the message once after Qoder reports a turn is already in progress", async () => {
    const qoder = createFakeQoder({
      "POST /sessions/:id/events": [
        () => apiError(409, "invalid_request_error", "Session is currently processing a turn."),
        () => json({ data: [{ id: "evt_user_2", type: "user.message" }] }),
      ],
    });
    const result = await execute(createContext(), { fetchImpl: qoder.fetchImpl, sleep: noSleep });
    expect(result.exitCode).toBe(0);
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/events`)).toHaveLength(2);
    expect(qoder.find("GET", `/sessions/${SESSION_ID}/events/stream`)[0].headers["Last-Event-ID"]).toBe("evt_user_2");
  });

  it("cancels a turn that stops for tool confirmation and fails the run", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": () => sse([
        { id: "evt_tool", type: "agent.tool_use", name: "Bash", input: {}, evaluated_permission: "ask" },
        { id: "evt_idle", type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["evt_tool"] } },
      ]),
    });
    const ctx = createContext();
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("always_allow");
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/cancel`)).toHaveLength(1);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.clearSession).toBe(false);
    expect(stdoutEvents(ctx).at(-1)).toMatchObject({ status: "error", stopReason: "requires_action" });
  });

  it("explains an allowed tool call that no worker executed in a self-hosted environment", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": () => sse([
        { id: "evt_tool", type: "agent.tool_use", name: "Bash", input: {}, evaluated_permission: "allow" },
        { id: "evt_idle", type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["evt_tool"] } },
      ]),
    });
    const ctx = createContext();
    ctx.config.environmentId = "env_self_hosted";
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("env_self_hosted appears to be self-hosted");
    expect(result.errorMessage).not.toContain("always_allow");
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/cancel`)).toHaveLength(1);
  });

  it("reports the Qoder session error when retries are exhausted", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": () => sse([
        { id: "evt_err_1", type: "session.error", error: { type: "model_error", message: "transient", retry_status: { type: "retrying" } } },
        { id: "evt_err_2", type: "session.error", error: { type: "model_error", message: "Model overloaded", retry_status: { type: "exhausted" } } },
        { id: "evt_idle", type: "session.status_idle", stop_reason: { type: "retries_exhausted" } },
      ]),
    });
    const result = await execute(createContext(), { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("Model overloaded");
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/cancel`)).toHaveLength(0);
  });

  it("clears the stored session when Qoder terminates it", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": () => sse([{ id: "evt_term", type: "session.status_terminated" }]),
    });
    const result = await execute(createContext(), { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("was terminated");
    expect(result.clearSession).toBe(true);
    expect(result.sessionParams).toBeNull();
    expect(result.sessionId).toBeNull();
  });

  it("reconnects from the last seen event when the stream closes mid-turn", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": [
        () => sse([
          { id: "evt_running", type: "session.status_running" },
          { id: "evt_delta", type: "event_start", event: { id: "evt_delta", type: "agent.message" } },
        ]),
        () => sse([
          { id: "evt_msg", type: "agent.message", content: [{ type: "text", text: "Recovered" }] },
          END_TURN,
        ]),
      ],
    });
    const sleep = vi.fn(async () => {});
    const ctx = createContext();
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl, sleep });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Recovered");
    const streams = qoder.find("GET", `/sessions/${SESSION_ID}/events/stream`);
    expect(streams.map((call) => call.headers["Last-Event-ID"])).toEqual(["evt_user", "evt_delta"]);
    expect(sleep).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    const forwarded = stdoutEvents(ctx)
      .filter((event) => event.type === "qoder_cloud_agents.event")
      .map((event) => (event.event as Record<string, unknown>).type);
    expect(forwarded).toEqual(["session.status_running", "agent.message", "session.status_idle"]);
  });

  it("recovers the outcome from event history when the stream cannot be re-established", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": () => { throw new Error("socket hang up"); },
      "GET /sessions/:id/events": () => json({ data: [END_TURN, { id: "evt_msg", type: "agent.message" }] }),
    });
    const sleep = vi.fn(async () => {});
    const result = await execute(createContext(), { fetchImpl: qoder.fetchImpl, sleep });
    expect(result.exitCode).toBe(0);
    expect(qoder.find("GET", `/sessions/${SESSION_ID}/events/stream`)).toHaveLength(6);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("recovers this turn's final answer from event history, not an earlier turn's", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": [
        () => sse([{ id: "evt_partial", type: "agent.message", content: [{ type: "text", text: "Partial progress" }] }]),
        () => { throw new Error("socket hang up"); },
      ],
      // Newest first, as Qoder returns with order=desc.
      "GET /sessions/:id/events": () => json({
        data: [
          END_TURN,
          { id: "evt_final", type: "agent.message", content: [{ type: "text", text: "Final answer\nwith detail" }] },
          { id: "evt_partial", type: "agent.message", content: [{ type: "text", text: "Partial progress" }] },
          { id: "evt_user", type: "user.message" },
          { id: "evt_old_idle", type: "session.status_idle", stop_reason: { type: "end_turn" } },
          { id: "evt_old", type: "agent.message", content: [{ type: "text", text: "Answer from an older turn" }] },
        ],
      }),
    });
    const ctx = createContext();
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl, sleep: noSleep });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Final answer");
    expect(result.resultJson).toMatchObject({ result: "Final answer\nwith detail" });
    expect(stdoutEvents(ctx).at(-1)).toMatchObject({ status: "finished", result: "Final answer\nwith detail" });
  });

  it("recovers the session error from event history when the turn failed after the stream was lost", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": () => { throw new Error("socket hang up"); },
      "GET /sessions/:id/events": () => json({
        data: [
          { id: "evt_idle", type: "session.status_idle", stop_reason: { type: "retries_exhausted" } },
          { id: "evt_err", type: "session.error", error: { message: "Model overloaded", retry_status: { type: "exhausted" } } },
          { id: "evt_user", type: "user.message" },
        ],
      }),
    });
    const result = await execute(createContext(), { fetchImpl: qoder.fetchImpl, sleep: noSleep });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("Model overloaded");
  });

  it("stops the remote turn before failing a run whose stream was lost mid-turn", async () => {
    const running = () => json({ id: SESSION_ID, status: "running", archived_at: null });
    const idle = () => json({ id: SESSION_ID, status: "idle", archived_at: null });
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": () => { throw new Error("socket hang up"); },
      // Still running when the stream is given up; idle once the cancel lands.
      "GET /sessions/:id": [running, running, idle],
    });
    const result = await execute(createContext(), { fetchImpl: qoder.fetchImpl, sleep: noSleep });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Lost the Qoder event stream");
    expect(result.errorMessage).toContain("socket hang up");
    expect(result.errorMessage).not.toContain("could not confirm");
    expect(result.sessionId).toBe(SESSION_ID);
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/cancel`)).toHaveLength(1);
    expect(result.resultJson).toMatchObject({ qoderTurnStopped: true });
  });

  it("says so when a failed run's remote turn cannot be confirmed stopped", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": () => { throw new Error("socket hang up"); },
      "GET /sessions/:id": () => json({ id: SESSION_ID, status: "running", archived_at: null }),
    });
    const ctx = createContext();
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl, sleep: noSleep });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Lost the Qoder event stream");
    expect(result.errorMessage).toContain("could not confirm");
    expect(result.resultJson).toMatchObject({ qoderTurnStopped: false });
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/cancel`)).toHaveLength(1);
    expect(stdoutEvents(ctx).at(-1)).toMatchObject({ status: "error" });
  });

  it("does not try to cancel when the failure is an auth error it cannot act on", async () => {
    const qoder = createFakeQoder({
      "POST /sessions/:id/events": () => apiError(401, "authentication_error", "Invalid token."),
    });
    const result = await execute(createContext(), { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(1);
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/cancel`)).toHaveLength(0);
    expect(result.resultJson).not.toHaveProperty("qoderTurnStopped");
  });

  it("explains an expired or wrong-region token", async () => {
    const qoder = createFakeQoder({
      "GET /environments": () => apiError(401, "authentication_error", "Invalid token."),
    });
    const ctx = createContext();
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Invalid token.");
    expect(result.errorMessage).toContain("QODER_ACCESS_TOKEN");
    expect(result.errorMessage).not.toContain("pt-secret");
    expect(stdoutEvents(ctx)).toHaveLength(0);
  });

  it("cancels the remote turn when the run is cancelled", async () => {
    const controller = new AbortController();
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": (call) => {
        queueMicrotask(() => controller.abort());
        return hangingSse(call.signal);
      },
    });
    const onCancellationReady = vi.fn(async () => {});
    const ctx = createContext({ signal: controller.signal, onCancellationReady });
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(onCancellationReady).toHaveBeenCalledOnce();
    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("cancelled");
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.resultJson).toMatchObject({ executionCancellation: { state: "acknowledged" } });
    const cancel = qoder.find("POST", `/sessions/${SESSION_ID}/cancel`);
    expect(cancel).toHaveLength(1);
    expect(cancel[0].signal?.aborted).toBe(false);
  });

  it("does not acknowledge cancellation when Qoder rejects the cancel request", async () => {
    const controller = new AbortController();
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": (call) => {
        queueMicrotask(() => controller.abort());
        return hangingSse(call.signal);
      },
      "POST /sessions/:id/cancel": () => apiError(500, "api_error", "cancel failed"),
    });
    const ctx = createContext({ signal: controller.signal });
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.errorCode).toBe("cancelled");
    expect(result.errorMessage).toContain("could not confirm");
    expect(result.resultJson).toMatchObject({ qoderTurnStopped: false });
    expect(result.resultJson).not.toHaveProperty("executionCancellation");
    expect(ctx.logs.some((entry) => entry.stream === "stderr" && entry.chunk.includes("cancel failed"))).toBe(true);
  });

  it("waits for Qoder to report the turn stopped before acknowledging cancellation", async () => {
    const controller = new AbortController();
    const running = () => json({ id: SESSION_ID, status: "running", archived_at: null });
    const idle = () => json({ id: SESSION_ID, status: "idle", archived_at: null });
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": (call) => {
        queueMicrotask(() => controller.abort());
        return hangingSse(call.signal);
      },
      "GET /sessions/:id": [running, running, idle],
    });
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const result = await execute(createContext({ signal: controller.signal }), { fetchImpl: qoder.fetchImpl, sleep });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]?.[1].aborted).toBe(false);
    expect(result.resultJson).toMatchObject({ qoderTurnStopped: true, executionCancellation: { state: "acknowledged" } });
  });

  it("cancels a turn Qoder may have accepted when the run stops before the send response arrives", async () => {
    const controller = new AbortController();
    const qoder = createFakeQoder({
      "POST /sessions/:id/events": (call) => {
        // Qoder has the message; the caller aborts before reading the response.
        controller.abort();
        call.signal?.throwIfAborted();
        return json({ data: [] });
      },
    });
    const ctx = createContext({ signal: controller.signal });
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.errorCode).toBe("cancelled");
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/cancel`)).toHaveLength(1);
    expect(result.resultJson).toMatchObject({ qoderTurnStopped: true, executionCancellation: { state: "acknowledged" } });
    expect(result.sessionId).toBe(SESSION_ID);
  });

  it("does no remote work when the run was cancelled before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const qoder = createFakeQoder();
    const onDispatch = vi.fn();
    const result = await execute(createContext({ signal: controller.signal, onDispatch }), { fetchImpl: qoder.fetchImpl });
    expect(result.errorCode).toBe("cancelled");
    expect(onDispatch).not.toHaveBeenCalled();
    expect(qoder.calls).toHaveLength(0);
  });

  it("cancels the remote turn and reports a timeout when timeoutSec elapses", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": (call) => hangingSse(call.signal),
    });
    const ctx = createContext();
    ctx.config.timeoutSec = 0.05;
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("timed out after 0.05s");
    expect(qoder.find("POST", `/sessions/${SESSION_ID}/cancel`)).toHaveLength(1);
  });

  it("warns about env vars that Qoder session limits reject", async () => {
    const qoder = createFakeQoder();
    const ctx = createContext();
    ctx.config.env = {
      QODER_ACCESS_TOKEN: "pt-secret",
      "BAD-NAME": "x",
      WORK_DIR: "/tmp",
      HUGE: "x".repeat(9 * 1024),
      EMPTY: "",
      CAW_INTERNAL: "y",
      OK: { type: "plain", value: "fine" },
    };
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(0);
    const createdSession = qoder.calls.find((call) => call.method === "POST" && call.path === "/sessions")?.body as Record<string, any>;
    expect(Object.keys(createdSession.environment_variables).sort()).toEqual(["OK", "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID"]);
    const warning = ctx.logs.find((entry) => entry.stream === "stderr")?.chunk ?? "";
    expect(warning).toContain("BAD-NAME");
    expect(warning).toContain("HUGE");
    expect(warning).toContain("WORK_DIR");
    expect(warning).not.toContain("CAW_INTERNAL");
    expect(warning).not.toContain("EMPTY");
  });
});

describe("buildSessionEnv", () => {
  it("forwards only env vars the operator saved on the agent, not ones Paperclip injects per run", () => {
    const ctx = createContext();
    ctx.agent.adapterConfig = { env: { EXTRA_FLAG: { type: "plain", value: "1" }, SECRET: { type: "secret_ref", secretId: "s" } } };
    const { env, dropped } = buildSessionEnv(ctx, {
      EXTRA_FLAG: "1",
      SECRET: "resolved-secret",
      TMPDIR: "/var/folders/xx/T/paperclip-run-1",
      PAPERCLIP_RUN_SCRATCH_DIR: "/var/folders/xx/T/paperclip-run-1",
      SSH_AUTH_SOCK: "/var/run/launchd/Listeners",
      GH_CONFIG_DIR: "/Users/someone/.config/gh",
    });
    expect(env).toEqual({
      EXTRA_FLAG: "1",
      SECRET: "resolved-secret",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-1",
    });
    expect(dropped).toEqual([]);
  });

  it("caps the forwarded env at Qoder's 64-entry limit", () => {
    const configEnv: Record<string, string> = {};
    for (let index = 0; index < 70; index += 1) configEnv[`VAR_${String(index).padStart(2, "0")}`] = "v";
    const ctx = createContext();
    ctx.agent.adapterConfig = { env: configEnv };
    const { env, dropped } = buildSessionEnv(ctx, configEnv);
    expect(Object.keys(env)).toHaveLength(64);
    expect(dropped).toHaveLength(70 + 2 - 64);
  });

  it("never forwards the Paperclip API key even when one is configured", () => {
    const { env } = buildSessionEnv(createContext({ authToken: "paperclip-run-jwt" }), { PAPERCLIP_API_KEY: "configured" });
    expect(env).not.toHaveProperty("PAPERCLIP_API_KEY");
    expect(env).not.toHaveProperty("PAPERCLIP_API_URL");
    expect(JSON.stringify(env)).not.toContain("paperclip-run-jwt");
  });
});
