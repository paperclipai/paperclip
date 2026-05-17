import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DAYTONA_SANDBOX_PROVIDER_KEY,
  E2B_SANDBOX_PROVIDER_KEY,
  DaytonaSandboxProvider,
  E2BSandboxProvider,
  createManagedSandboxFakeHttpServer,
  isManagedSandboxLiveAllowed,
  type ManagedSandboxProviderConfig,
  type ManagedSandboxProviderFailureMode,
} from "./managed-provider-spikes.js";
import {
  DOCKER_SANDBOX_PROVIDER_KEY,
  DockerSandboxProvider,
} from "./docker-provider.js";
import { NULL_SANDBOX_PROVIDER_KEY, NullSandboxProvider } from "./null-provider.js";
import type { SandboxProvider } from "./provider-contract.js";

const originalLiveFlag = process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
const originalDockerFlag = process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED;

const e2bConfig: ManagedSandboxProviderConfig = {
  provider: E2B_SANDBOX_PROVIDER_KEY,
  image: "e2b/code-interpreter:latest",
  template: "base",
  reuseLease: true,
  timeoutMs: 45_000,
  env: { PAPERCLIP_SANDBOX_MODE: "sensitive-test-env-value" },
  network: { egress: "deny" },
};

const daytonaConfig: ManagedSandboxProviderConfig = {
  provider: DAYTONA_SANDBOX_PROVIDER_KEY,
  image: "ubuntu:24.04",
  template: "default",
  reuseLease: true,
  timeoutMs: 45_000,
  env: { PAPERCLIP_SANDBOX_MODE: "sensitive-test-env-value" },
  network: { egress: "deny" },
  region: "us",
};

function restoreEnv() {
  if (originalLiveFlag === undefined) {
    delete process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
  } else {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = originalLiveFlag;
  }
  if (originalDockerFlag === undefined) {
    delete process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED;
  } else {
    process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED = originalDockerFlag;
  }
}

describe("managed sandbox provider spikes", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("keeps managed provider live dialing disabled by default", async () => {
    delete process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
    expect(isManagedSandboxLiveAllowed()).toBe(false);

    for (const [provider, config] of [
      [new E2BSandboxProvider(), e2bConfig],
      [new DaytonaSandboxProvider(), daytonaConfig],
    ] as const) {
      expect(provider.status()).toMatchObject({
        enabled: false,
        previewOnly: true,
        secretInjection: expect.objectContaining({ acceptsRawSecrets: false }),
      });
      await expect(
        provider.acquireLease({
          config,
          environmentId: "env-live-off",
          heartbeatRunId: "run-live-off",
          issueId: "issue-live-off",
        }),
      ).rejects.toMatchObject({
        code: "PROVIDER_DISABLED",
        details: expect.objectContaining({ liveEnv: "SANDBOX_PROVIDER_ALLOW_LIVE", mockedTransportsOnly: true }),
      });
    }
  });

  it("does not dial provider endpoints even when the future live flag is set", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    expect(isManagedSandboxLiveAllowed()).toBe(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected live fetch"));
    try {
      for (const [provider, config] of [
        [new E2BSandboxProvider(), e2bConfig],
        [new DaytonaSandboxProvider(), daytonaConfig],
      ] as const) {
        expect(provider.status()).toMatchObject({ enabled: false, previewOnly: true });
        await expect(
          provider.acquireLease({
            config,
            environmentId: "env-live-flag",
            heartbeatRunId: "run-live-flag",
            issueId: "issue-live-flag",
          }),
        ).rejects.toMatchObject({
          code: "PROVIDER_DISABLED",
          details: expect.objectContaining({ mockedTransportsOnly: true }),
        });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    [E2B_SANDBOX_PROVIDER_KEY, () => createManagedSandboxFakeHttpServer({ provider: E2B_SANDBOX_PROVIDER_KEY }), (server: ReturnType<typeof createManagedSandboxFakeHttpServer>) => new E2BSandboxProvider({ transport: server.transport }), e2bConfig],
    [DAYTONA_SANDBOX_PROVIDER_KEY, () => createManagedSandboxFakeHttpServer({ provider: DAYTONA_SANDBOX_PROVIDER_KEY }), (server: ReturnType<typeof createManagedSandboxFakeHttpServer>) => new DaytonaSandboxProvider({ transport: server.transport }), daytonaConfig],
  ])("maps %s happy-path lease, exec, logs, events, and cleanup through a fake HTTP transport", async (_key, makeServer, makeProvider, config) => {
    const server = makeServer();
    const provider = makeProvider(server);

    await expect(provider.validateConfig(config)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        details: expect.objectContaining({
          provider: config.provider,
          transport: "mock-http",
          previewOnly: true,
        }),
      }),
    );

    const lease = await provider.acquireLease({
      config,
      environmentId: "env-1",
      heartbeatRunId: "run-1",
      issueId: "issue-1",
    });
    expect(lease.providerLeaseId).toMatch(new RegExp(`^sandbox://${config.provider}/`));
    expect(lease.metadata).toMatchObject({
      provider: config.provider,
      sandboxState: "created",
      previewOnly: true,
      transport: "mock-http",
    });

    const started = await provider.start({ lease });
    expect(started).toMatchObject({ providerLeaseId: lease.providerLeaseId });

    await expect(
      provider.exec({
        config,
        providerLeaseId: lease.providerLeaseId,
        command: "python",
        args: ["-c", "print('ok')"],
        env: { SAFE_TEST_ENV: "sensitive-test-exec-env" },
        stdin: "sensitive-test-stdin",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        exitCode: 0,
        stdout: expect.stringContaining("python -c print('ok')"),
      }),
    );

    await expect(provider.readLogs({ providerLeaseId: lease.providerLeaseId })).resolves.toEqual(
      expect.objectContaining({
        truncated: false,
        lines: expect.arrayContaining([
          expect.objectContaining({ stream: "system", message: expect.stringContaining("created") }),
        ]),
      }),
    );

    const events: unknown[] = [];
    for await (const event of provider.streamEvents({ providerLeaseId: lease.providerLeaseId })) {
      events.push(event);
    }
    expect(events).toEqual([
      expect.objectContaining({ type: "sandbox.created" }),
      expect.objectContaining({ type: "sandbox.started" }),
    ]);

    await expect(provider.releaseLease({
      config,
      providerLeaseId: lease.providerLeaseId,
      status: "released",
    })).resolves.toBeUndefined();
    await expect(provider.destroy({ providerLeaseId: lease.providerLeaseId })).resolves.toBeUndefined();

    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual(
      server.expectedHappyPath(),
    );
    const recordedBodies = JSON.stringify(server.requests.map((request) => request.body));
    expect(recordedBodies).toContain("SAFE_TEST_ENV");
    expect(recordedBodies).not.toContain("sensitive-test-env-value");
    expect(recordedBodies).not.toContain("sensitive-test-exec-env");
    expect(recordedBodies).not.toContain("sensitive-test-stdin");
  });

  it.each([
    ["auth_failure", "CONFIG_INVALID", false],
    ["rate_limit", "PROVIDER_FAILURE", true],
    ["lease_not_found", "LEASE_NOT_FOUND", false],
    ["exec_timeout", "TIMEOUT", true],
    ["network_egress_denied", "PROVIDER_FAILURE", false],
  ] as Array<[ManagedSandboxProviderFailureMode, string, boolean]>)
  ("normalizes fake transport failure mode %s for both managed providers", async (failureMode, expectedCode, expectedRetryable) => {
    for (const [providerKey, makeProvider, config] of [
      [E2B_SANDBOX_PROVIDER_KEY, (server: ReturnType<typeof createManagedSandboxFakeHttpServer>) => new E2BSandboxProvider({ transport: server.transport }), e2bConfig],
      [DAYTONA_SANDBOX_PROVIDER_KEY, (server: ReturnType<typeof createManagedSandboxFakeHttpServer>) => new DaytonaSandboxProvider({ transport: server.transport }), daytonaConfig],
    ] as const) {
      const server = createManagedSandboxFakeHttpServer({ provider: providerKey, failureMode });
      const provider = makeProvider(server);
      const operation = failureMode === "auth_failure" || failureMode === "rate_limit"
        ? provider.acquireLease({ config, environmentId: "env-failure", heartbeatRunId: "run-failure", issueId: null })
        : provider.exec({
            config,
            providerLeaseId: `sandbox://${providerKey}/missing`,
            command: failureMode === "network_egress_denied" ? "curl" : "python",
            args: failureMode === "network_egress_denied" ? ["https://example.com"] : ["-c", "print('x')"],
          });

      await expect(operation).rejects.toMatchObject({
        code: expectedCode,
        retryable: expectedRetryable,
        details: expect.objectContaining({
          provider: providerKey,
          failureMode,
        }),
      });
    }
  });

  it("runs a shared conformance contract over Docker, Null, E2B, and Daytona providers", async () => {
    process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED = "1";
    const e2bServer = createManagedSandboxFakeHttpServer({ provider: E2B_SANDBOX_PROVIDER_KEY });
    const daytonaServer = createManagedSandboxFakeHttpServer({ provider: DAYTONA_SANDBOX_PROVIDER_KEY });
    const cases: Array<{ name: string; provider: SandboxProvider; config: ManagedSandboxProviderConfig }> = [
      {
        name: NULL_SANDBOX_PROVIDER_KEY,
        provider: new NullSandboxProvider(),
        config: { provider: NULL_SANDBOX_PROVIDER_KEY, reuseLease: true },
      },
      {
        name: DOCKER_SANDBOX_PROVIDER_KEY,
        provider: new DockerSandboxProvider(),
        config: { provider: DOCKER_SANDBOX_PROVIDER_KEY, image: "ubuntu:24.04", reuseLease: true },
      },
      {
        name: E2B_SANDBOX_PROVIDER_KEY,
        provider: new E2BSandboxProvider({ transport: e2bServer.transport }),
        config: e2bConfig,
      },
      {
        name: DAYTONA_SANDBOX_PROVIDER_KEY,
        provider: new DaytonaSandboxProvider({ transport: daytonaServer.transport }),
        config: daytonaConfig,
      },
    ];

    for (const testCase of cases) {
      await expect(testCase.provider.validateConfig(testCase.config)).resolves.toMatchObject({ ok: true });
      const lease = await testCase.provider.acquireLease({
        config: testCase.config,
        environmentId: `env-${testCase.name}`,
        heartbeatRunId: `run-${testCase.name}`,
        issueId: "issue-conformance",
      });
      expect(lease.providerLeaseId).toMatch(/^sandbox:\/\//);
      await expect(testCase.provider.start({ lease })).resolves.toMatchObject({
        providerLeaseId: lease.providerLeaseId,
      });
      await expect(testCase.provider.readLogs({ providerLeaseId: lease.providerLeaseId })).resolves.toMatchObject({
        lines: expect.any(Array),
        nextCursor: null,
        truncated: false,
      });
      const events: unknown[] = [];
      for await (const event of testCase.provider.streamEvents({ providerLeaseId: lease.providerLeaseId })) {
        events.push(event);
      }
      expect(Array.isArray(events)).toBe(true);
      if (testCase.provider.capabilities.exec) {
        await expect(testCase.provider.exec({
          config: testCase.config,
          providerLeaseId: lease.providerLeaseId,
          command: "echo",
          args: ["ok"],
        })).resolves.toMatchObject({ exitCode: 0 });
      } else {
        await expect(testCase.provider.exec({
          config: testCase.config,
          providerLeaseId: lease.providerLeaseId,
          command: "echo",
          args: ["ok"],
        })).rejects.toBeInstanceOf(Error);
      }
      await expect(testCase.provider.stop({ providerLeaseId: lease.providerLeaseId })).resolves.toBeUndefined();
      await expect(testCase.provider.destroy({ providerLeaseId: lease.providerLeaseId })).resolves.toBeUndefined();
    }
  });
});
