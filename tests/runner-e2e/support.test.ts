import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packageEvidence } from "./evidence.js";
import { RunnerApi } from "./api.js";
import { FixtureRegistry } from "./fixture-registry.js";
import { classifyFailure, shouldRetryFailure } from "./failure-classifier.js";
import {
  assertIsolatedServerEnvironment,
  buildPaperclipServerEnvironment,
  buildRunnerE2EProcessEnvironment,
  resolvePaperclipRemoteRunnerBinaryForHarness,
  resolvePaperclipRunnerBinaryForHarness,
  runnerE2EServerControlPaths,
} from "./harness-env.js";
import { runnerExecutionById, runnerMatrix } from "./catalog.js";
import { assertEmbeddedDatabaseIsolation } from "./instance-isolation.js";
import { evaluateMatchers } from "./matchers.js";
import {
  assertSecretFree,
  findSecretLeak,
  findSecretLeakInJsonValues,
  findSecretLeakInDirectory,
  isEphemeralCodexRuntimeAuthFile,
  redactText,
  sanitizeJson,
} from "./redaction.js";
import { parseDarwinSharedMemory } from "./shared-memory.js";
import {
  reserveRunnerE2EServerPort,
  runnerE2EServerPortConflictsWithDatabase,
  type LoopbackPortReservation,
} from "./ports.js";
import {
  acceptedPlanSessionResetFailures,
  hasTerminalMalformedPlanConfirmation,
  isControlPlaneGovernedResponseWait,
  isNonExecutingReviewFenceRun,
  isOpenRouterDeepSeekHelloTerminalVariance,
  numberedPlanStepCount,
  providerSessionContinuityFailures,
} from "./run-observations.js";
import { runnerE2EWebServerCommand } from "./web-server-command.js";

const cleanupDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runner E2E local binary resolution", () => {
  const localNativeExecution = runnerExecutionById(
    "core-compatibility.runner-codex.local.message-marker",
  );
  const remoteNativeExecution = runnerExecutionById(
    "core-compatibility.runner-acpx-claude.daytona.message-marker",
  );

  it("uses the debug runner binary built by the E2E workflow", () => {
    expect(
      resolvePaperclipRunnerBinaryForHarness(
        [localNativeExecution],
        "/repository",
        undefined,
        "linux",
      ),
    ).toBe(
      path.join(
        "/repository",
        "packages/paperclip-runner/runner/target/debug/paperclip-runnerd",
      ),
    );
  });

  it("preserves an explicit runner binary override", () => {
    expect(
      resolvePaperclipRunnerBinaryForHarness(
        [localNativeExecution],
        "/repository",
        "/custom/paperclip-runnerd",
        "linux",
      ),
    ).toBe("/custom/paperclip-runnerd");
  });

  it("uses and stages the same build-once binary for remote native cells", () => {
    const runnerBinary = resolvePaperclipRunnerBinaryForHarness(
      [remoteNativeExecution],
      "/repository",
      undefined,
      "linux",
    );
    expect(runnerBinary).toBe(
      path.join(
        "/repository",
        "packages/paperclip-runner/runner/target/debug/paperclip-runnerd",
      ),
    );
    expect(
      resolvePaperclipRemoteRunnerBinaryForHarness(
        [remoteNativeExecution],
        runnerBinary,
      ),
    ).toBe(runnerBinary);
    expect(
      resolvePaperclipRemoteRunnerBinaryForHarness(
        [localNativeExecution],
        runnerBinary,
      ),
    ).toBeUndefined();
  });
});

describe("runner E2E provider environment", () => {
  const legacyLocal = runnerExecutionById(
    "core-compatibility.legacy-opencode.local.message-marker",
  );
  const legacyDaytona = runnerExecutionById(
    "core-compatibility.legacy-opencode.daytona.message-marker",
  );
  const nativeOpenCode = runnerExecutionById(
    "core-compatibility.runner-opencode.local.message-marker",
  );
  const breadthOpenCode = runnerMatrix.find(
    (execution) => execution.suite.id === "openrouter-model-breadth",
  )!;

  it("allows the pinned model only for isolated legacy OpenCode harnesses", () => {
    for (const execution of [legacyLocal, legacyDaytona]) {
      expect(
        buildRunnerE2EProcessEnvironment(
          { KEEP_ME: "yes", OPENCODE_ALLOW_ALL_MODELS: "ambient" },
          [execution],
        ),
      ).toEqual({ KEEP_ME: "yes", OPENCODE_ALLOW_ALL_MODELS: "true" });
    }

    for (const execution of [nativeOpenCode, breadthOpenCode]) {
      expect(
        buildRunnerE2EProcessEnvironment(
          { KEEP_ME: "yes", OPENCODE_ALLOW_ALL_MODELS: "ambient" },
          [execution],
        ),
      ).toEqual({ KEEP_ME: "yes" });
    }
  });
});

describe("runner E2E server port allocation", () => {
  it("rejects direct and derived embedded-Postgres collisions", () => {
    expect(runnerE2EServerPortConflictsWithDatabase(44_329)).toBe(true);
    expect(runnerE2EServerPortConflictsWithDatabase(54_329)).toBe(true);
    expect(runnerE2EServerPortConflictsWithDatabase(64_329)).toBe(true);
    expect(runnerE2EServerPortConflictsWithDatabase(43_123)).toBe(false);
  });

  it("retries a derived collision while closing every reservation", async () => {
    const closed: number[] = [];
    const ports = [44_329, 43_123, 53_123];
    const openPort = vi.fn(async (requestedPort: number) => {
      const port = requestedPort === 0 ? ports.shift() : requestedPort;
      if (port === undefined) throw new Error("Missing fake port");
      return {
        port,
        close: async () => {
          closed.push(port);
        },
      } satisfies LoopbackPortReservation;
    });

    await expect(reserveRunnerE2EServerPort({ openPort })).resolves.toBe(
      43_123,
    );
    expect(openPort.mock.calls.map(([port]) => port)).toEqual([0, 0, 53_123]);
    expect(closed).toEqual([44_329, 53_123, 43_123]);
  });
});

describe("runner E2E sensitive API boundary", () => {
  it("keeps secret request bodies out of Playwright API tracing", async () => {
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "43123");
    const playwrightPost = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "secret-id" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new RunnerApi({ post: playwrightPost } as never);

    await expect(
      api.postSensitive("/api/companies/company-id/secrets", {
        value: "fixture-secret-value",
      }),
    ).resolves.toEqual({ id: "secret-id" });
    expect(playwrightPost).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:43123/api/companies/company-id/secrets"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("runner E2E structured evidence scanning", () => {
  it("does not invent a secret shape across JSON syntax boundaries", () => {
    const value = {
      OPENROUTER_API_KEY: "generated-secret-reference-id",
    };
    expect(findSecretLeak(JSON.stringify(value), [])).toBe(
      "secret-shaped value",
    );
    expect(findSecretLeakInJsonValues(value, [])).toBeNull();
  });

  it("still rejects exact and provider-shaped values in nested JSON", () => {
    expect(
      findSecretLeakInJsonValues(
        { nested: ["safe", "campaign-secret-value"] },
        ["campaign-secret-value"],
      ),
    ).toBe("exact secret value");
    expect(
      findSecretLeakInJsonValues({ nested: "sk-proj-abcdefghijklmnop" }, []),
    ).toBe("secret-shaped value");
  });
});

describe("runner E2E fixture registry", () => {
  it("sets up in dependency order and tears down in reverse", async () => {
    const events: string[] = [];
    const registry = new FixtureRegistry()
      .register({
        id: "company",
        setup: async () => {
          events.push("setup-company");
          return "c";
        },
        teardown: async () => {
          events.push("teardown-company");
        },
      })
      .register({
        id: "agent",
        dependencies: ["company"],
        setup: async () => {
          events.push("setup-agent");
          return "a";
        },
        teardown: async () => {
          events.push("teardown-agent");
        },
      });
    const active = await registry.setupAll();
    await active.teardown();
    expect(events).toEqual([
      "setup-company",
      "setup-agent",
      "teardown-agent",
      "teardown-company",
    ]);
  });

  it("tears down partial setup after a failure", async () => {
    const cleanup = vi.fn();
    const registry = new FixtureRegistry()
      .register({ id: "company", setup: async () => "c", teardown: cleanup })
      .register({
        id: "agent",
        dependencies: ["company"],
        setup: async () => {
          throw new Error("boom");
        },
      });
    await expect(registry.setupAll()).rejects.toThrow("boom");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves setup and partial-cleanup failures", async () => {
    const registry = new FixtureRegistry()
      .register({
        id: "company",
        setup: async () => "c",
        teardown: async () => {
          throw new Error("cleanup transport returned 503");
        },
      })
      .register({
        id: "agent",
        dependencies: ["company"],
        setup: async () => {
          throw new Error("agent setup failed");
        },
      });
    await expect(registry.setupAll()).rejects.toMatchObject({
      name: "AggregateError",
      message: expect.stringContaining("cleanup failed"),
      errors: expect.arrayContaining([
        expect.objectContaining({ message: "agent setup failed" }),
        expect.objectContaining({ message: "Fixture teardown failed" }),
      ]),
    });
  });
});

describe("runner E2E matchers", () => {
  it("normalizes message text and evaluates state invariants", async () => {
    const results = await evaluateMatchers(
      [
        { kind: "message_contains", expected: "PAPERCLIP_E2E_OK_nonce" },
        {
          kind: "message_occurrences",
          expected: "PAPERCLIP_E2E_OK_nonce",
          count: 1,
        },
        { kind: "issue_status", expected: "done" },
        { kind: "runtime_mode", expected: "native" },
      ],
      {
        message: "  complete   PAPERCLIP\\_E2E\\_OK\\_nonce  ",
        issueStatus: "done",
        runtimeMode: "native",
      },
    );
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it("requires an exact number of complete visible markers", async () => {
    const [result] = await evaluateMatchers(
      [{ kind: "message_occurrences", expected: "FINAL_marker", count: 1 }],
      { message: "FINAL\\_marker\nFINAL_marker" },
    );
    expect(result).toMatchObject({ passed: false });
    expect(result?.detail).toContain("observed 2");
  });

  it("normalizes ordered fragments and evaluates nested JSON Schema", async () => {
    const results = await evaluateMatchers(
      [
        {
          kind: "message_ordered",
          expected: ["first   marker", "second marker"],
        },
        {
          kind: "json_schema",
          schema: {
            type: "object",
            required: ["run"],
            additionalProperties: false,
            properties: {
              run: {
                type: "object",
                required: ["status"],
                properties: { status: { const: "succeeded" } },
              },
            },
          },
        },
      ],
      {
        message: "first     marker\nsecond marker",
        json: { run: { status: "succeeded" } },
      },
    );
    expect(results.every((result) => result.passed)).toBe(true);
  });
});

describe("runner E2E run observations", () => {
  it("retries only terminal Plan confirmations missing a revision-bound target", () => {
    const observation = {
      runs: [{ status: "succeeded" }],
      interactions: [
        {
          kind: "request_confirmation",
          status: "pending",
          payload: { version: 1, prompt: "Approve the Plan?" },
        },
      ],
      minimumRunCount: 1,
    };

    expect(hasTerminalMalformedPlanConfirmation(observation)).toBe(true);
    expect(
      hasTerminalMalformedPlanConfirmation({
        ...observation,
        runs: [{ status: "running" }],
      }),
    ).toBe(false);
    expect(
      hasTerminalMalformedPlanConfirmation({
        ...observation,
        interactions: [
          {
            ...observation.interactions[0],
            payload: {
              target: {
                type: "issue_document",
                key: "plan",
                revisionId: "revision-1",
              },
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("retries only the zero-marker DeepSeek hello terminal emission variance", () => {
    const expectedMarker = "PC_H_nonce-1";
    const observation = {
      suiteId: "openrouter-model-breadth",
      profileId: "openrouter-deepseek-deepseek-v4-flash-0731",
      taskId: "hello-complete",
      expectedMarker,
      finalRunMessage:
        "I'll complete this deterministic hello task by calling paperclip_finish once.",
      allAgentMessages:
        "I'll complete this deterministic hello task by calling paperclip_finish once.",
      semanticSummary: expectedMarker,
      issueStatus: "done",
      runStatuses: ["succeeded"],
      matcherResults: [
        {
          matcher: { kind: "message_exact", expected: expectedMarker },
          passed: false,
        },
        {
          matcher: {
            kind: "message_occurrences",
            expected: expectedMarker,
            count: 1,
          },
          passed: false,
        },
        { matcher: { kind: "issue_status", expected: "done" }, passed: true },
      ],
      invariantFailures: [],
    };

    expect(isOpenRouterDeepSeekHelloTerminalVariance(observation)).toBe(true);
    expect(
      isOpenRouterDeepSeekHelloTerminalVariance({
        ...observation,
        allAgentMessages: `${expectedMarker}\n${expectedMarker}`,
      }),
    ).toBe(false);
    expect(
      isOpenRouterDeepSeekHelloTerminalVariance({
        ...observation,
        semanticSummary: "different-summary",
      }),
    ).toBe(false);
    expect(
      isOpenRouterDeepSeekHelloTerminalVariance({
        ...observation,
        invariantFailures: ["missing native terminal event"],
      }),
    ).toBe(false);
    expect(
      isOpenRouterDeepSeekHelloTerminalVariance({
        ...observation,
        matcherResults: [
          ...observation.matcherResults,
          {
            matcher: { kind: "environment", expected: "local" },
            passed: false,
          },
        ],
      }),
    ).toBe(false);
  });

  it("counts provider-equivalent numbered Plan step formats", () => {
    expect(numberedPlanStepCount("1. First\n2) Second")).toBe(2);
    expect(
      numberedPlanStepCount(
        "# Plan\n\nStep 1 — First\n\nStep 2 — Second\n\nStep 3: Verify",
      ),
    ).toBe(3);
    expect(
      numberedPlanStepCount("## **Step 1** — First\n- **2.** Second"),
    ).toBe(2);
  });

  it("excludes only queued continuations fenced while awaiting review", () => {
    expect(
      isNonExecutingReviewFenceRun({
        status: "cancelled",
        errorCode: "issue_continuation_waiting_on_review",
      }),
    ).toBe(true);
    expect(
      isNonExecutingReviewFenceRun({
        status: "failed",
        errorCode: "issue_continuation_waiting_on_review",
      }),
    ).toBe(false);
    expect(
      isNonExecutingReviewFenceRun({
        status: "cancelled",
        errorCode: "provider_failure",
      }),
    ).toBe(false);
  });

  it("recognizes only authoritative control-plane governed response waits", () => {
    const event = {
      eventType: "run.result.accepted",
      payload: {
        prpEvent: {
          schema: "paperclip.prp.event.v1",
          eventType: "run.result.accepted",
          sourceKind: "control_plane",
          payload: {
            result: {
              schema: "paperclip.run_result.v1",
              reportedWorkDisposition: "yielded",
              evidence: [{ ref: "interaction:pending" }],
              artifacts: [
                {
                  kind: "issue_thread_interaction",
                  ref: "interaction:pending",
                },
              ],
              continuation: {
                kind: "response_wake",
                idempotencyKey: "interaction-response:pending",
              },
            },
          },
        },
      },
    };
    expect(isControlPlaneGovernedResponseWait([event])).toBe(true);
    expect(
      isControlPlaneGovernedResponseWait([
        {
          ...event,
          payload: {
            prpEvent: {
              ...event.payload.prpEvent,
              sourceKind: "runner",
            },
          },
        },
      ]),
    ).toBe(false);
    expect(
      isControlPlaneGovernedResponseWait([
        {
          ...event,
          payload: {
            prpEvent: {
              ...event.payload.prpEvent,
              payload: {
                result: {
                  ...event.payload.prpEvent.payload.result,
                  artifacts: [],
                },
              },
            },
          },
        },
      ]),
    ).toBe(false);
    expect(
      isControlPlaneGovernedResponseWait([
        event,
        { ...event, payload: structuredClone(event.payload) },
      ]),
    ).toBe(false);
  });

  it("requires continuity except for an explicit accepted-Plan reset", () => {
    const initial = {
      id: "initial",
      sessionIdBefore: null,
      sessionIdAfter: "session-one",
    };
    const resumed = {
      id: "resumed",
      sessionIdBefore: "session-one",
      sessionIdAfter: "session-one",
    };
    const acceptedPlan = {
      id: "accepted-plan",
      sessionIdBefore: null,
      sessionIdAfter: "session-two",
      contextSnapshot: {
        forceFreshSession: true,
        workspaceRefreshReason: "accepted_plan_confirmation",
        source: "issue.interaction.accept",
        interactionStatus: "accepted",
      },
    };
    expect(
      providerSessionContinuityFailures("codex", [
        initial,
        resumed,
        acceptedPlan,
      ]),
    ).toEqual([]);
    expect(
      providerSessionContinuityFailures("codex", [
        initial,
        { ...acceptedPlan, sessionIdAfter: "session-one" },
      ]),
    ).toEqual([
      "expected accepted Plan run accepted-plan to rotate the codex provider session",
    ]);
    expect(
      providerSessionContinuityFailures("codex", [
        initial,
        { ...resumed, sessionIdAfter: "session-two" },
      ]),
    ).toEqual([
      "expected codex to preserve its provider session for run resumed",
    ]);
    expect(
      acceptedPlanSessionResetFailures(
        "acpx",
        initial.sessionIdAfter,
        acceptedPlan,
      ),
    ).toEqual([]);
    expect(
      acceptedPlanSessionResetFailures("acpx", initial.sessionIdAfter, {
        ...acceptedPlan,
        sessionIdBefore: initial.sessionIdAfter,
      }),
    ).toEqual([
      "expected accepted Plan run accepted-plan to start without a prior provider session",
    ]);
    expect(
      acceptedPlanSessionResetFailures("acpx", initial.sessionIdAfter, resumed),
    ).toBeNull();
  });
});

describe("runner E2E failure policy", () => {
  it("retries only transient infrastructure failures", () => {
    expect(
      classifyFailure(new Error("Daytona preview connection timed out")),
    ).toBe("transient_infrastructure");
    expect(
      classifyFailure(
        new Error(
          "Browser bootstrap failed before task creation: New Task button timed out after a Vite 504",
        ),
      ),
    ).toBe("transient_infrastructure");
    expect(
      shouldRetryFailure(
        classifyFailure(new Error("Daytona preview connection timed out")),
      ),
    ).toBe(true);
    expect(
      shouldRetryFailure(classifyFailure(new Error("marker matcher failed"))),
    ).toBe(false);
    expect(shouldRetryFailure("provider_variance")).toBe(true);
    expect(
      classifyFailure(
        new Error(
          "Timed out waiting for issue abc and heartbeat run terminal state",
        ),
      ),
    ).toBe("candidate_failure");
    expect(
      classifyFailure(
        new Error("Provider request timed out during generation"),
      ),
    ).toBe("transient_infrastructure");
    expect(
      classifyFailure(
        new Error(
          "runner_ingress_unavailable: paperclip-runnerd: cumulative ACK cannot move beyond the produced source cursor",
        ),
      ),
    ).toBe("transient_infrastructure");
    expect(
      shouldRetryFailure(classifyFailure(new Error("invalid API key"))),
    ).toBe(false);
    expect(
      classifyFailure(
        new Error("Daytona lease cleanup failed: provider returned 503"),
      ),
    ).toBe("transient_infrastructure");
    expect(classifyFailure(new Error("cleanup invariant failure"))).toBe(
      "cleanup_failure",
    );
  });
});

describe("runner E2E server isolation", () => {
  it("shares restart control files beneath the isolated temporary root", () => {
    expect(runnerE2EServerControlPaths("/tmp/cell")).toEqual({
      controlDirectory: path.join("/tmp/cell", "control"),
      restartRequestPath: path.join(
        "/tmp/cell",
        "control",
        "server-restart.request.json",
      ),
      restartAcknowledgementPath: path.join(
        "/tmp/cell",
        "control",
        "server-restart.ack.json",
      ),
    });
  });

  it("strips database and paid-provider credentials from the Paperclip process", () => {
    const env = buildPaperclipServerEnvironment(
      {
        PATH: "/bin",
        DATABASE_URL: "postgres://existing",
        DATABASE_MIGRATION_URL: "postgres://migration",
        OPENAI_API_KEY: "openai",
        ANTHROPIC_API_KEY: "anthropic",
        OPENROUTER_API_KEY: "openrouter",
        DAYTONA_API_KEY: "daytona",
        OPENAI_ORG_ID: "also-provider-sensitive",
        PAPERCLIP_API_KEY: "ambient-board-key",
        PAPERCLIP_AGENT_API_KEY: "ambient-agent-key",
        PAPERCLIP_TASK_BRIDGE_TOKEN: "ambient-task-token",
        PAPERCLIP_SETUP_TOKEN: "ambient-setup-token",
        PAPERCLIP_SECRETS_MASTER_KEY: "ambient-master-key",
        PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/outside/master.key",
        PAPERCLIP_STORAGE_S3_BUCKET: "production-bucket",
      },
      {
        PAPERCLIP_HOME: "/tmp/cell/paperclip-home",
        PAPERCLIP_CONFIG: "/tmp/cell/paperclip-home/instances/e2e/config.json",
        XDG_CACHE_HOME: "/tmp/cell/xdg-cache",
        PAPERCLIP_AGENT_JWT_SECRET: "generated-agent-jwt",
        PAPERCLIP_DECISION_SIGNING_SECRET: "generated-decision-key",
        PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "generated-tool-key",
        BETTER_AUTH_SECRET: "generated-auth-key",
      },
    );
    expect(env.PATH).toBe("/bin");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_ORG_ID).toBeUndefined();
    expect(env.PAPERCLIP_API_KEY).toBeUndefined();
    expect(env.PAPERCLIP_AGENT_API_KEY).toBeUndefined();
    expect(env.XDG_CACHE_HOME).toBe("/tmp/cell/xdg-cache");
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBe("generated-agent-jwt");
    expect(env.PAPERCLIP_TASK_BRIDGE_TOKEN).toBeUndefined();
    expect(env.PAPERCLIP_SETUP_TOKEN).toBeUndefined();
    expect(env.PAPERCLIP_SECRETS_MASTER_KEY).toBeUndefined();
    expect(env.PAPERCLIP_SECRETS_MASTER_KEY_FILE).toBeUndefined();
    expect(env.PAPERCLIP_STORAGE_S3_BUCKET).toBeUndefined();
    expect(() =>
      assertIsolatedServerEnvironment(env, {
        temporaryRoot: "/tmp/cell",
        paperclipHome: "/tmp/cell/paperclip-home",
        configPath: "/tmp/cell/paperclip-home/instances/e2e/config.json",
      }),
    ).not.toThrow();
  });

  it("uses absolute repository paths for the Playwright web server", () => {
    const command = runnerE2EWebServerCommand("/workspace/paperclip");
    expect(command).toContain(
      "'/workspace/paperclip/cli/node_modules/tsx/dist/cli.mjs'",
    );
    expect(command).toContain(
      "'/workspace/paperclip/tests/runner-e2e/server.ts'",
    );
  });

  it("accepts only embedded state paths beneath the temporary root", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-instance-isolation-test-"),
    );
    cleanupDirectories.push(root);
    const database = path.join(root, "paperclip-home", "db");
    const secretsKey = path.join(
      root,
      "paperclip-home",
      "secrets",
      "master.key",
    );
    const configPath = path.join(root, "paperclip-home", "config.json");
    await mkdir(database, { recursive: true });
    await mkdir(path.dirname(secretsKey), { recursive: true });
    await writeFile(secretsKey, "generated-master-key");
    const config = {
      database: {
        mode: "embedded-postgres",
        embeddedPostgresDataDir: database,
        backup: { dir: path.join(root, "backups") },
      },
      logging: { logDir: path.join(root, "logs") },
      storage: {
        provider: "local_disk",
        localDisk: { baseDir: path.join(root, "storage") },
      },
      secrets: {
        provider: "local_encrypted",
        strictMode: true,
        localEncrypted: { keyFilePath: secretsKey },
      },
    };
    await writeFile(configPath, JSON.stringify(config));
    await expect(
      assertEmbeddedDatabaseIsolation(configPath, root),
    ).resolves.toBeUndefined();

    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        storage: {
          ...config.storage,
          localDisk: { baseDir: "/outside/storage" },
        },
      }),
    );
    await expect(
      assertEmbeddedDatabaseIsolation(configPath, root),
    ).rejects.toThrow("storage path escaped");
  });
});

describe("runner E2E evidence redaction", () => {
  const secret = "sk-proj-supersecretvalue123456";

  it("redacts exact and shaped credentials recursively", () => {
    expect(redactText(`token=${secret}`, [secret])).toBe("token=[REDACTED]");
    expect(sanitizeJson({ nested: [secret] }, [secret])).toEqual({
      nested: ["[REDACTED]"],
    });
    expect(sanitizeJson("paperclip.runner-e2e.evidence/v1", [secret])).toBe(
      "paperclip.runner-e2e.evidence/v1",
    );
  });

  it("detects leaks and accepts sanitized evidence", () => {
    expect(findSecretLeak(Buffer.from(secret), [secret])).toBeTruthy();
    expect(() => assertSecretFree("safe", [secret], "fixture")).not.toThrow();
    expect(() =>
      assertSecretFree(
        "sk-proj-documentationfixture123456",
        [secret],
        "API source",
        { includeShapes: false },
      ),
    ).not.toThrow();
  });

  it("finds exact credentials across streamed persisted-state chunks", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-secret-scan-test-"),
    );
    cleanupDirectories.push(root);
    await writeFile(
      path.join(root, "database.bin"),
      Buffer.concat([
        Buffer.alloc(65_530, "x"),
        Buffer.from(secret),
        Buffer.alloc(32, "y"),
      ]),
    );
    await expect(
      findSecretLeakInDirectory(root, [secret]),
    ).resolves.toMatchObject({ reason: "exact secret value" });
  });

  it("can ignore fake key shapes while scanning persisted package state", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-secret-shape-test-"),
    );
    cleanupDirectories.push(root);
    await writeFile(
      path.join(root, "provider-fixture.test.ts"),
      'const fake = "sk-proj-documentationfixture123456";\n',
    );
    await expect(
      findSecretLeakInDirectory(root, [secret], { includeShapes: false }),
    ).resolves.toBeNull();
  });

  it("can narrowly exclude a verified ephemeral runtime credential file", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-ephemeral-auth-test-"),
    );
    cleanupDirectories.push(root);
    const runtimeAuth = path.join(root, "codex-home", "auth.json");
    const forbiddenConfig = path.join(root, "config.json");
    await mkdir(path.dirname(runtimeAuth), { recursive: true });
    await writeFile(runtimeAuth, secret, { mode: 0o600 });
    await writeFile(forbiddenConfig, secret);
    await expect(
      findSecretLeakInDirectory(root, [secret], {
        includeShapes: false,
        ignoreFile: (file) => file === runtimeAuth,
      }),
    ).resolves.toMatchObject({ file: forbiddenConfig });
  });

  it("recognizes managed and durable Codex runtime auth files", () => {
    const root = path.join(os.tmpdir(), "paperclip-home");
    expect(
      isEphemeralCodexRuntimeAuthFile(
        root,
        path.join(
          root,
          "instances/instance-1/companies/company-1/agents/agent-1/codex-home/auth.json",
        ),
      ),
    ).toBe(true);
    expect(
      isEphemeralCodexRuntimeAuthFile(
        root,
        path.join(
          root,
          "instances/instance-1/runtime/paperclip-runner/acpx/acpx/session-1/codex-home/auth.json",
        ),
      ),
    ).toBe(true);
    expect(
      isEphemeralCodexRuntimeAuthFile(
        root,
        path.join(
          root,
          "instances/instance-1/runtime/paperclip-runner/durable-sessions/session-1/codex-home/auth.json",
        ),
      ),
    ).toBe(true);
    expect(
      isEphemeralCodexRuntimeAuthFile(
        root,
        path.join(root, "instances/instance-1/runtime/auth.json"),
      ),
    ).toBe(false);
    expect(
      isEphemeralCodexRuntimeAuthFile(
        root,
        path.join(
          root,
          "instances/instance-1/runtime/paperclip-runner/durable-sessions/session-1/codex-home/config.toml",
        ),
      ),
    ).toBe(false);
  });

  it("publishes only allowlisted sanitized files and reports source leaks", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-evidence-test-"),
    );
    cleanupDirectories.push(root);
    const privateDir = path.join(root, "private");
    const uploadDir = path.join(root, "upload");
    await mkdir(privateDir, { recursive: true });
    await writeFile(
      path.join(privateDir, "result.json"),
      JSON.stringify({ error: secret }),
    );
    await writeFile(path.join(privateDir, "database.sqlite"), secret);
    const packaged = await packageEvidence({
      privateDir,
      uploadDir,
      secrets: [secret],
      expectPassScreenshot: false,
    });
    expect(packaged.leaks).toEqual([
      { file: "result.json", reason: "exact secret value" },
    ]);
    expect(
      await readFile(path.join(uploadDir, "result.json"), "utf8"),
    ).toContain("[REDACTED]");
    await expect(
      readFile(path.join(uploadDir, "database.sqlite")),
    ).rejects.toThrow();
  });

  it("keeps raster evidence private to CI and rejects active SVG content", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-visual-evidence-test-"),
    );
    cleanupDirectories.push(root);
    const privateDir = path.join(root, "private");
    const uploadDir = path.join(root, "upload");
    const playwrightOutput = path.join(privateDir, "playwright-output");
    await mkdir(playwrightOutput, { recursive: true });
    await writeFile(path.join(privateDir, "final-state.png"), "png");
    await writeFile(path.join(playwrightOutput, "failure.webm"), "webm");
    await writeFile(
      path.join(playwrightOutput, "active.svg"),
      "<svg onload='alert(1)' />",
    );

    const packaged = await packageEvidence({
      privateDir,
      uploadDir,
      secrets: [secret],
      expectPassScreenshot: false,
    });

    expect(packaged.files).toEqual(
      expect.arrayContaining([
        "final-state.png",
        path.join("playwright-output", "failure.webm"),
      ]),
    );
    expect(packaged.files).not.toContain(
      path.join("playwright-output", "active.svg"),
    );
    await expect(
      readFile(path.join(playwrightOutput, "active.svg"), "utf8"),
    ).resolves.toContain("onload");
    await expect(
      readFile(path.join(uploadDir, "playwright-output", "active.svg")),
    ).rejects.toThrow();
  });

  it("preserves valid JSON while redacting escaped command diagnostics", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-json-evidence-test-"),
    );
    cleanupDirectories.push(root);
    const privateDir = path.join(root, "private");
    const uploadDir = path.join(root, "upload");
    await mkdir(path.join(privateDir, "snapshots"), { recursive: true });
    await writeFile(
      path.join(privateDir, "snapshots", "api-state.json"),
      JSON.stringify({
        log: String.raw`curl -H \"Authorization: Bearer temporary-run-token\" \\\n+  \"$PAPERCLIP_API_URL/api/issues\"`,
      }),
    );
    await packageEvidence({
      privateDir,
      uploadDir,
      secrets: [secret],
      expectPassScreenshot: false,
    });
    const uploaded = await readFile(
      path.join(uploadDir, "snapshots", "api-state.json"),
      "utf8",
    );
    expect(() => JSON.parse(uploaded)).not.toThrow();
    expect(uploaded).toContain("[REDACTED]");
  });

  it("streams large ZIP evidence and detects exact secrets", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-zip-evidence-test-"),
    );
    cleanupDirectories.push(root);
    const privateDir = path.join(root, "private");
    const uploadDir = path.join(root, "upload");
    const blobDir = path.join(privateDir, "blob-report");
    await mkdir(blobDir, { recursive: true });
    await writeFile(
      path.join(blobDir, "trace.txt"),
      Buffer.concat([Buffer.alloc(2 * 1024 * 1024, "x"), Buffer.from(secret)]),
    );
    execFileSync("zip", ["-q", "report.zip", "trace.txt"], {
      cwd: blobDir,
    });
    await rm(path.join(blobDir, "trace.txt"));

    const packaged = await packageEvidence({
      privateDir,
      uploadDir,
      secrets: [secret],
      expectPassScreenshot: false,
    });

    expect(packaged.leaks).toEqual([
      {
        file: path.join("blob-report", "report.zip"),
        reason: "exact secret value",
      },
    ]);
    await expect(
      readFile(path.join(uploadDir, "blob-report", "report.zip")),
    ).rejects.toThrow();
  });
});

describe("runner E2E macOS shared-memory cleanup", () => {
  it("parses only shared-memory rows from ipcs output", () => {
    expect(
      parseDarwinSharedMemory(
        `IPC status from <running system>\nT ID KEY MODE OWNER GROUP CREATOR CGROUP NATTCH SEGSZ CPID LPID\nm 327709 0x028ed0ab --rw------- dotta staff dotta staff 0 56 52172 52172\ns 123 0x0 --ra------- dotta staff\n`,
      ),
    ).toEqual([
      {
        id: "327709",
        owner: "dotta",
        attachments: 0,
        creatorPid: 52172,
      },
    ]);
  });
});
