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
  resolvePaperclipRunnerBinaryForHarness,
} from "./harness-env.js";
import { runnerExecutionById } from "./catalog.js";
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
  isNonExecutingReviewFenceRun,
  numberedPlanStepCount,
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

  it("recognizes both managed and durable-session Codex runtime auth files", () => {
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
