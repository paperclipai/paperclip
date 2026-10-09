import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Company, InstanceExperimentalSettings } from "@paperclipai/shared";
import {
  assertTestDriveDatabaseIsolation,
  bootstrapTestDrive,
  prepareTestDriveEnvironment,
  reconcileTestDriveWorktreeExecution,
  redactTestDriveArgv,
  redactTestDriveText,
  resolveTestDriveBootstrap,
  resolveTestDriveDataDir,
  testDriveCommand,
  type TestDriveApi,
  type TestDriveHarness,
} from "../commands/test-drive.js";
import type { RunOptions, StartedServer } from "../commands/run.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };
const cleanupDirectories: string[] = [];

function company(id = "company-1", name = "Test Company"): Company {
  return { id, name } as Company;
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "CEO",
    role: "ceo",
    adapterType: "claude_local",
    adapterConfig: {},
    ...overrides,
  } as Agent;
}

function settings(overrides: Partial<InstanceExperimentalSettings> = {}): InstanceExperimentalSettings {
  return {
    enableWorktreeRunExecution: false,
    worktreeRunExecutionActivatedAt: null,
    worktreeRunExecutionActivationInstanceId: null,
    ...overrides,
  } as InstanceExperimentalSettings;
}

function freshBootstrapApi(input?: { failAgent?: boolean }) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api = {
    get: vi.fn(async <T>(requestPath: string) => {
      calls.push({ method: "GET", path: requestPath });
      return [] as T;
    }),
    post: vi.fn(async <T>(requestPath: string, body?: unknown) => {
      calls.push({ method: "POST", path: requestPath, body });
      if (requestPath === "/api/companies") return company() as T;
      if (requestPath.endsWith("/agents")) {
        if (input?.failAgent) throw new Error("agent setup failed");
        const payload = body as { name: string; adapterType: Agent["adapterType"]; adapterConfig: Record<string, unknown> };
        return agent({
          name: payload.name,
          adapterType: payload.adapterType,
          adapterConfig: payload.adapterConfig,
        }) as T;
      }
      return { ok: true } as T;
    }),
    patch: vi.fn(async <T>() => ({ ok: true }) as T),
    delete: vi.fn(async <T>(requestPath: string) => {
      calls.push({ method: "DELETE", path: requestPath });
      return { ok: true } as T;
    }),
  } as TestDriveApi;
  return { api, calls };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  while (cleanupDirectories.length > 0) {
    fs.rmSync(cleanupDirectories.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("test-drive data isolation", () => {
  it("creates unique retained OS temporary directories and reports absolute paths", () => {
    const first = resolveTestDriveDataDir();
    const second = resolveTestDriveDataDir();
    cleanupDirectories.push(first, second);

    expect(path.isAbsolute(first)).toBe(true);
    expect(path.dirname(first)).toBe(os.tmpdir());
    expect(first).not.toBe(second);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
  });

  it("resolves an explicit reusable directory without resetting it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-test-drive-explicit-"));
    cleanupDirectories.push(root);
    const marker = path.join(root, "keep.txt");
    fs.writeFileSync(marker, "keep");

    expect(resolveTestDriveDataDir(root)).toBe(path.resolve(root));
    expect(fs.readFileSync(marker, "utf8")).toBe("keep");
  });

  it("discards inherited Paperclip routing while preserving a custom key source", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-test-drive-env-"));
    cleanupDirectories.push(root);
    process.env.PAPERCLIP_HOME = "/normal/home";
    process.env.PAPERCLIP_CONFIG = "/normal/config.json";
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_TEST_PROVIDER_KEY = "secret-value";
    process.env.DATABASE_URL = "postgres://normal-instance";

    const prepared = await prepareTestDriveEnvironment(
      { dataDir: root, apiKeyEnv: "PAPERCLIP_TEST_PROVIDER_KEY" },
      os.tmpdir(),
    );

    expect(prepared.dataDir).toBe(path.resolve(root));
    expect(prepared.linkedWorktree).toBe(false);
    expect(process.env.PAPERCLIP_HOME).toBe(path.resolve(root));
    expect(process.env.PAPERCLIP_CONFIG).toBe(
      path.join(path.resolve(root), "instances", "default", "config.json"),
    );
    expect(process.env.PAPERCLIP_IN_WORKTREE).toBe("false");
    expect(process.env.PAPERCLIP_DISABLE_CWD_ENV_FILE).toBe("true");
    expect(process.env.PAPERCLIP_DEPLOYMENT_MODE).toBe("local_trusted");
    expect(process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE).toBe("private");
    expect(process.env.PAPERCLIP_BIND).toBe("loopback");
    expect(process.env.HOST).toBe("127.0.0.1");
    expect(process.env.PAPERCLIP_TEST_PROVIDER_KEY).toBe("secret-value");
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(Number(process.env.PORT)).toBeGreaterThanOrEqual(3100);
  });

  it.each(["DATABASE_URL", "DATABASE_MIGRATION_URL"])(
    "rejects %s loaded from the isolated directory",
    (variable) => {
      const readConfigFile = vi.fn(() => null);
      expect(() => assertTestDriveDatabaseIsolation(
        undefined,
        { [variable]: "postgres://external-database" },
        readConfigFile,
      )).toThrow(/requires its isolated embedded database/);
      expect(readConfigFile).not.toHaveBeenCalled();
    },
  );

  it("rejects an explicitly reused PostgreSQL configuration", () => {
    const externalConfig = {
      database: { mode: "postgres" },
    } as PaperclipConfig;
    expect(() => assertTestDriveDatabaseIsolation(
      "/tmp/reused/config.json",
      {},
      () => externalConfig,
    )).toThrow(/cannot reuse.*external PostgreSQL database/);
  });

  it("accepts an embedded configuration", () => {
    const embeddedConfig = {
      database: { mode: "embedded-postgres" },
    } as PaperclipConfig;
    expect(() => assertTestDriveDatabaseIsolation(
      "/tmp/reused/config.json",
      {},
      () => embeddedConfig,
    )).not.toThrow();
  });
});

describe("test-drive bootstrap validation", () => {
  it("uses Claude defaults and the canonical environment credential", () => {
    const resolved = resolveTestDriveBootstrap({}, { ANTHROPIC_API_KEY: "anthropic-secret" });
    expect(resolved).toMatchObject({
      companyName: "Test Company",
      agentName: "CEO",
      adapterType: "claude_local",
      credentialTarget: "ANTHROPIC_API_KEY",
      credential: "anthropic-secret",
    });
    expect(resolved.model).toBeUndefined();
  });

  it("maps all harnesses and leaves Claude/Codex models optional", () => {
    const cases: Array<[TestDriveHarness, string, string]> = [
      ["claude", "claude_local", "ANTHROPIC_API_KEY"],
      ["codex", "codex_local", "OPENAI_API_KEY"],
      ["opencode", "opencode_local", "OPENROUTER_API_KEY"],
    ];
    for (const [harness, adapterType, credentialTarget] of cases) {
      const resolved = resolveTestDriveBootstrap(
        {
          harness,
          ...(harness === "opencode" ? { model: "openrouter/anthropic/claude-sonnet-4.5" } : {}),
        },
        { [credentialTarget]: "provider-secret" },
      );
      expect(resolved.adapterType).toBe(adapterType);
      expect(resolved.credentialTarget).toBe(credentialTarget);
    }
  });

  it("requires an OpenRouter OpenCode model and preserves every model path segment", () => {
    expect(() => resolveTestDriveBootstrap(
      { harness: "opencode" },
      { OPENROUTER_API_KEY: "secret" },
    )).toThrow(/require --model openrouter/);
    for (const model of ["anthropic/claude", "openrouter/", "openrouter//claude", "openrouter/a/"]) {
      expect(() => resolveTestDriveBootstrap(
        { harness: "opencode", model },
        { OPENROUTER_API_KEY: "secret" },
      )).toThrow(/require --model openrouter/);
    }

    const model = "openrouter/publisher/family/model";
    expect(resolveTestDriveBootstrap(
      { harness: "opencode", model },
      { OPENROUTER_API_KEY: "secret" },
    ).model).toBe(model);
  });

  it("supports custom source variables while retaining the canonical target", () => {
    const resolved = resolveTestDriveBootstrap(
      {
        harness: "opencode",
        model: "openrouter/anthropic/claude-sonnet-4.5",
        apiKeyEnv: "MY_OPENROUTER_KEY",
      },
      { MY_OPENROUTER_KEY: "custom-secret" },
    );
    expect(resolved.credential).toBe("custom-secret");
    expect(resolved.credentialSource).toBe("MY_OPENROUTER_KEY");
    expect(resolved.credentialTarget).toBe("OPENROUTER_API_KEY");
  });

  it("accepts a literal key and gives it precedence over canonical environment lookup", () => {
    const resolved = resolveTestDriveBootstrap(
      { apiKey: "literal-secret" },
      { ANTHROPIC_API_KEY: "environment-secret" },
    );
    expect(resolved.credential).toBe("literal-secret");
    expect(resolved.credentialSource).toBe("--api-key");
  });

  it("rejects mutually exclusive key inputs", () => {
    expect(() => resolveTestDriveBootstrap({
      apiKey: "literal-secret",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    }, { ANTHROPIC_API_KEY: "environment-secret" })).toThrow(/mutually exclusive/);
  });

  it("rejects invalid key variable names and redacts credentials", () => {
    expect(() => resolveTestDriveBootstrap({
      apiKeyEnv: "NOT-A-VALID-NAME",
    }, { ANTHROPIC_API_KEY: "env-secret" })).toThrow(/valid environment variable/);
    expect(redactTestDriveText(
      "literal-secret, custom-secret, and env-secret must never appear",
      ["literal-secret", "custom-secret", "env-secret"],
    )).toBe("[REDACTED], [REDACTED], and [REDACTED] must never appear");
  });

  it("removes literal keys from the JavaScript argv view", () => {
    const splitArgv = ["node", "paperclipai", "test-drive", "--api-key", "literal-secret"];
    const joinedArgv = ["node", "paperclipai", "test-drive", "--api-key=literal-secret"];

    redactTestDriveArgv("literal-secret", splitArgv);
    redactTestDriveArgv("literal-secret", joinedArgv);

    expect(splitArgv).toEqual(["node", "paperclipai", "test-drive", "--api-key", "[REDACTED]"]);
    expect(joinedArgv).toEqual(["node", "paperclipai", "test-drive", "--api-key=[REDACTED]"]);
  });
});

describe("test-drive API bootstrap", () => {
  it.each([
    ["claude", "claude_local", "ANTHROPIC_API_KEY", undefined],
    ["codex", "codex_local", "OPENAI_API_KEY", undefined],
    ["opencode", "opencode_local", "OPENROUTER_API_KEY", "openrouter/anthropic/claude-sonnet-4.5"],
  ] as const)("creates exactly one company and one CEO for %s", async (
    harness,
    adapterType,
    credentialTarget,
    model,
  ) => {
    const { api, calls } = freshBootstrapApi();
    const result = await bootstrapTestDrive({
      api,
      options: { harness, ...(model ? { model } : {}) },
      linkedWorktree: false,
      instanceId: "default",
      env: { [credentialTarget]: "secret" },
    });

    expect(result.reused).toBe(false);
    expect(result.agent?.role).toBe("ceo");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/companies",
      "POST /api/companies",
      "POST /api/companies/company-1/user-secret-definitions",
      "POST /api/companies/company-1/me/user-secrets",
      "POST /api/companies/company-1/agents",
    ]);
    const secretValueCall = calls.find((call) => call.path.endsWith("/me/user-secrets"));
    expect(secretValueCall?.body).toEqual({ definitionKey: credentialTarget, value: "secret" });
    const agentCall = calls.find((call) => call.path.endsWith("/agents"));
    expect(agentCall?.body).toEqual({
      name: "CEO",
      role: "ceo",
      adapterType,
      adapterConfig: {
        ...(model ? { model } : {}),
        env: {
          [credentialTarget]: {
            type: "user_secret_ref",
            key: credentialTarget,
            version: "latest",
            required: true,
          },
        },
      },
    });
    expect(calls.some((call) => /issues|projects|goals|tasks|heartbeat/.test(call.path))).toBe(false);
  });

  it("rejects invalid OpenCode configuration before creating a company", async () => {
    const { api, calls } = freshBootstrapApi();
    await expect(bootstrapTestDrive({
      api,
      options: { harness: "opencode" },
      linkedWorktree: false,
      instanceId: "default",
      env: { OPENROUTER_API_KEY: "secret" },
    })).rejects.toThrow(/require --model openrouter/);
    expect(calls).toEqual([{ method: "GET", path: "/api/companies" }]);
  });

  it("preserves seeded data and ignores every bootstrap flag", async () => {
    const get = vi.fn(async <T>(requestPath: string) => {
      if (requestPath === "/api/companies") return [company("existing", "Existing Company")] as T;
      throw new Error(`Unexpected GET ${requestPath}`);
    });
    const api = {
      get,
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as unknown as TestDriveApi;

    const result = await bootstrapTestDrive({
      api,
      options: { harness: "opencode", companyName: "Ignored" },
      linkedWorktree: false,
      instanceId: "default",
      env: {},
    });

    expect(result).toMatchObject({ reused: true, company: { id: "existing" }, agent: null });
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("deletes only the newly-created company when fresh bootstrap fails", async () => {
    const { api, calls } = freshBootstrapApi({ failAgent: true });
    await expect(bootstrapTestDrive({
      api,
      options: {},
      linkedWorktree: false,
      instanceId: "default",
      env: { ANTHROPIC_API_KEY: "secret" },
    })).rejects.toThrow("agent setup failed");
    expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/api/companies/company-1" });
  });
});

describe("test-drive worktree setting reconciliation", () => {
  function worktreeApi(initial: InstanceExperimentalSettings, instanceId = "test-instance") {
    let current = initial;
    const patchBodies: unknown[] = [];
    const api = {
      get: vi.fn(async <T>() => current as T),
      patch: vi.fn(async <T>(_path: string, body?: unknown) => {
        patchBodies.push(body);
        const enabled = (body as { enableWorktreeRunExecution: boolean }).enableWorktreeRunExecution;
        current = settings({
          ...current,
          enableWorktreeRunExecution: enabled,
          worktreeRunExecutionActivatedAt: enabled ? "2026-09-05T12:00:00.000Z" : null,
          worktreeRunExecutionActivationInstanceId: enabled ? instanceId : null,
        });
        return current as T;
      }),
      post: vi.fn(),
      delete: vi.fn(),
    } as unknown as TestDriveApi;
    return { api, patchBodies };
  }

  it("enables a disabled setting", async () => {
    const { api, patchBodies } = worktreeApi(settings());
    await reconcileTestDriveWorktreeExecution(api, "test-instance");
    expect(patchBodies).toEqual([{ enableWorktreeRunExecution: true }]);
  });

  it("leaves a correctly armed setting unchanged", async () => {
    const { api, patchBodies } = worktreeApi(settings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-09-05T11:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "test-instance",
    }));
    await reconcileTestDriveWorktreeExecution(api, "test-instance");
    expect(patchBodies).toEqual([]);
  });

  it.each([
    settings({ enableWorktreeRunExecution: true }),
    settings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-09-05T11:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "another-instance",
    }),
  ])("rearms missing or mismatched activation metadata", async (initial) => {
    const { api, patchBodies } = worktreeApi(initial);
    await reconcileTestDriveWorktreeExecution(api, "test-instance");
    expect(patchBodies).toEqual([
      { enableWorktreeRunExecution: false },
      { enableWorktreeRunExecution: true },
    ]);
  });

  it("fails when the setting cannot be armed for this instance", async () => {
    const api = {
      get: vi.fn(async <T>() => settings() as T),
      patch: vi.fn(async <T>() => settings() as T),
      post: vi.fn(),
      delete: vi.fn(),
    } as unknown as TestDriveApi;
    await expect(reconcileTestDriveWorktreeExecution(api, "test-instance"))
      .rejects.toThrow(/Could not arm/);
  });
});

describe("test-drive foreground lifecycle", () => {
  const server: StartedServer = {
    apiUrl: "http://127.0.0.1:3100/api",
    databaseUrl: "postgres://embedded",
    host: "127.0.0.1",
    listenPort: 3100,
  };

  it("skips service-manager integration for an auto-created directory and opens after initialization", async () => {
    process.env.PAPERCLIP_HOME = "/tmp/test-drive-lifecycle";
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_IN_WORKTREE = "false";
    process.env.ANTHROPIC_API_KEY = "secret";
    const events: string[] = [];
    let runOptions: RunOptions | undefined;
    const api = {
      get: vi.fn(async <T>() => {
        events.push("initialized");
        return [company("existing", "Existing")] as T;
      }),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as unknown as TestDriveApi;

    await testDriveCommand({}, {
      run: async (options) => {
        runOptions = options;
        events.push("listening");
        await options.afterStart?.(server);
      },
      createApi: () => api,
      openBrowser: async () => {
        events.push("browser");
        return true;
      },
    });

    expect(runOptions).toMatchObject({
      yes: true,
      bind: "loopback",
      installService: false,
      skipServiceManagerCheck: true,
      introLabel: "paperclipai test-drive",
    });
    expect(events).toEqual(["listening", "initialized", "browser"]);
  });

  it("retains the managed-instance collision guard for an explicitly reused directory", async () => {
    process.env.PAPERCLIP_HOME = "/tmp/test-drive-reused";
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_IN_WORKTREE = "false";
    let runOptions: RunOptions | undefined;
    const api = {
      get: vi.fn(async <T>() => [company("existing", "Existing")] as T),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as unknown as TestDriveApi;

    await testDriveCommand({ dataDir: "/tmp/test-drive-reused", browser: false }, {
      run: async (options) => {
        runOptions = options;
        await options.afterStart?.(server);
      },
      createApi: () => api,
      openBrowser: vi.fn(async () => true),
    });

    expect(runOptions?.skipServiceManagerCheck).toBe(false);
  });

  it("uses the credential snapshot captured before downstream server initialization", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-test-drive-credential-"));
    cleanupDirectories.push(root);
    process.env.PAPERCLIP_HOME = root;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_IN_WORKTREE = "false";
    process.env.ANTHROPIC_API_KEY = "upstream-secret";
    const { api, calls } = freshBootstrapApi();

    await testDriveCommand({ browser: false }, {
      run: async (options) => {
        delete process.env.ANTHROPIC_API_KEY;
        await options.afterStart?.(server);
      },
      createApi: () => api,
      openBrowser: vi.fn(async () => true),
    });

    const secretValueCall = calls.find((call) => call.path.endsWith("/me/user-secrets"));
    expect(secretValueCall?.body).toEqual({
      definitionKey: "ANTHROPIC_API_KEY",
      value: "upstream-secret",
    });
  });

  it("redacts a literal key from downstream errors", async () => {
    process.env.PAPERCLIP_HOME = "/tmp/test-drive-redaction";
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_IN_WORKTREE = "false";

    await expect(testDriveCommand({
      apiKey: "literal-secret",
      browser: false,
    }, {
      run: async () => {
        throw new Error("downstream rejected literal-secret");
      },
      createApi: () => freshBootstrapApi().api,
      openBrowser: vi.fn(async () => true),
    })).rejects.toThrow("downstream rejected [REDACTED]");
  });

  it("redacts a custom environment key when its option name has whitespace", async () => {
    process.env.PAPERCLIP_HOME = "/tmp/test-drive-custom-env-redaction";
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_IN_WORKTREE = "false";
    process.env.CUSTOM_TEST_DRIVE_KEY = "custom-secret";

    await expect(testDriveCommand({
      apiKeyEnv: " CUSTOM_TEST_DRIVE_KEY ",
      browser: false,
    }, {
      run: async () => {
        throw new Error("downstream rejected custom-secret");
      },
      createApi: () => freshBootstrapApi().api,
      openBrowser: vi.fn(async () => true),
    })).rejects.toThrow("downstream rejected [REDACTED]");
  });

  it("honors --no-browser after successful initialization", async () => {
    process.env.PAPERCLIP_HOME = "/tmp/test-drive-no-browser";
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_IN_WORKTREE = "false";
    const api = {
      get: vi.fn(async <T>() => [company("existing", "Existing")] as T),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as unknown as TestDriveApi;
    const openBrowser = vi.fn(async () => true);

    await testDriveCommand({ browser: false }, {
      run: async (options) => options.afterStart?.(server),
      createApi: () => api,
      openBrowser,
    });

    expect(openBrowser).not.toHaveBeenCalled();
  });
});
