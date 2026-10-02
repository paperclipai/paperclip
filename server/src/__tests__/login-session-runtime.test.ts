import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AgentAdapterType } from "@paperclipai/shared";

// The production runtime resolves the environment through `environmentService`.
// These tests replace it with a fake, so the runtime runs with no database. The
// fake returns a fixed environment and records the lease-metadata tag write.
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  updateLeaseMetadata: vi.fn(),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

import {
  createWorkerBoundLoginPtyOpener,
  createProductionLoginSessionRuntime,
  sessionLoginHomePath,
  DEVICE_LOGIN_PROVIDER_UNSUPPORTED,
  type LoginPtySessionBinding,
} from "../services/device-login-service.js";

// A fake worker pseudo-terminal session. It satisfies the shared transport
// contract, so the opener can return it.
function fakeWorkerSession() {
  return {
    onData() {},
    write() {},
    async wait() {
      return { exitCode: 0 };
    },
    kill() {},
    async close() {},
  };
}

// A verified binding for one login session. The runtime builds it after it
// acquires the lease. The tests set the server-controlled session home.
function makeBinding(overrides: Partial<LoginPtySessionBinding> = {}): LoginPtySessionBinding {
  return {
    companyId: "company-1",
    environmentId: "env-1",
    adapterType: "codex_local" as AgentAdapterType,
    providerLeaseId: "provider-lease-9",
    sessionHome: sessionLoginHomePath(randomUUID()),
    environment: { id: "env-1", driver: "sandbox" } as never,
    lease: {
      id: "lease-1",
      metadata: { pluginId: "paperclip.daytona", provider: "daytona" },
    } as never,
    ...overrides,
  };
}

describe("createWorkerBoundLoginPtyOpener", () => {
  it("passes the binding's server-controlled session home to the worker route", async () => {
    const sessionHome = sessionLoginHomePath(randomUUID());
    const session = fakeWorkerSession();
    const openLoginPtySession = vi.fn(
      async (_pluginId: string, _input: Record<string, unknown>) => session,
    );
    const openLivePtySession = createWorkerBoundLoginPtyOpener({
      workerManager: { openLoginPtySession },
    });

    const opener = await openLivePtySession(makeBinding({ sessionHome }));
    // The opener ignores the incoming command argument. It resolves the closed
    // command key from the trusted adapter type.
    const opened = await opener("caller-supplied-ignored");

    expect(openLoginPtySession).toHaveBeenCalledTimes(1);
    const [pluginId, input] = openLoginPtySession.mock.calls[0];
    expect(pluginId).toBe("paperclip.daytona");
    expect(input).toMatchObject({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "provider-lease-9",
      loginCommandKey: "codex",
      // The opener passes the binding's server-controlled home, not a fresh UUID
      // home. This home is the one the descriptor-bound credential read opens, so
      // the sandbox `CODEX_HOME` and the read target match.
      sessionHome,
    });
    expect(input).not.toHaveProperty("command");
    expect(opened).toBe(session);
  });

  it("fails closed when the lease carries no sandbox worker binding", async () => {
    const openLoginPtySession = vi.fn();
    const openLivePtySession = createWorkerBoundLoginPtyOpener({
      workerManager: { openLoginPtySession },
    });

    await expect(
      openLivePtySession(makeBinding({ lease: { id: "lease-1", metadata: {} } as never })),
    ).rejects.toThrow();
    expect(openLoginPtySession).not.toHaveBeenCalled();
  });

  it("fails closed when the adapter type has no login command key", async () => {
    const openLoginPtySession = vi.fn();
    const openLivePtySession = createWorkerBoundLoginPtyOpener({
      workerManager: { openLoginPtySession },
    });

    await expect(
      openLivePtySession(makeBinding({ adapterType: "gemini_local" as AgentAdapterType })),
    ).rejects.toThrow();
    expect(openLoginPtySession).not.toHaveBeenCalled();
  });
});

describe("createProductionLoginSessionRuntime lease-acquisition gate", () => {
  const acquireInput = {
    companyId: "company-1",
    environmentId: "env-1",
    adapterType: "codex_local" as AgentAdapterType,
    startedByUserId: "user-a",
  };

  it("re-checks the provider capability and fails before the provider lease when it is unsupported", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: "env-1",
      driver: "sandbox",
      config: { provider: "daytona" },
    });
    const acquireRunLease = vi.fn();
    // The capability flipped to unsupported after the route gate. The lease gate
    // reads the current capability and fails closed.
    const assertProviderSupportsLoginPty = vi.fn(async () => {
      throw new Error(DEVICE_LOGIN_PROVIDER_UNSUPPORTED);
    });
    const runtime = createProductionLoginSessionRuntime({
      db: {} as never,
      environmentRuntime: { acquireRunLease, getDriver: vi.fn() } as never,
      assertProviderSupportsLoginPty,
    });

    await expect(
      runtime.acquireLoginLease({ ...acquireInput, sessionId: randomUUID() }),
    ).rejects.toThrow(DEVICE_LOGIN_PROVIDER_UNSUPPORTED);
    // The runtime re-checked the current capability from the environment id.
    expect(assertProviderSupportsLoginPty).toHaveBeenCalledWith("env-1");
    // The gate failed before the provider lease, so no lease was acquired.
    expect(acquireRunLease).not.toHaveBeenCalled();
  });

  it("acquires the provider lease after the capability check passes", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: "env-1",
      driver: "sandbox",
      config: { provider: "daytona" },
    });
    mockEnvironmentService.updateLeaseMetadata.mockResolvedValue(undefined);
    const lease = { id: "lease-1", providerLeaseId: "provider-lease-1", metadata: {} };
    const acquireRunLease = vi.fn(async () => ({
      lease,
      environment: { id: "env-1", driver: "sandbox" },
    }));
    const assertProviderSupportsLoginPty = vi.fn(async () => {});
    const runtime = createProductionLoginSessionRuntime({
      db: {} as never,
      environmentRuntime: { acquireRunLease, getDriver: vi.fn() } as never,
      assertProviderSupportsLoginPty,
    });

    const acquired = await runtime.acquireLoginLease({ ...acquireInput, sessionId: randomUUID() });

    expect(assertProviderSupportsLoginPty).toHaveBeenCalledWith("env-1");
    // The gate passed, so the runtime acquired the provider lease after it.
    expect(acquireRunLease).toHaveBeenCalledTimes(1);
    expect(acquired.providerLeaseId).toBe("provider-lease-1");
  });
});
