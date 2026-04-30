import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import {
  DEFAULT_SANDBOX_REMOTE_CWD,
  resolveEnvironmentExecutionTarget,
} from "../services/environment-execution-target.js";

describe("resolveEnvironmentExecutionTarget", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
  });

  it("uses a bounded default cwd for sandbox targets when lease metadata omits remoteCwd", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: DEFAULT_SANDBOX_REMOTE_CWD,
      leaseId: "lease-1",
      environmentId: "env-1",
      paperclipTransport: "bridge",
      timeoutMs: 30_000,
    });
  });

  it("prefers an explicit Paperclip API URL from lease metadata for sandbox targets", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://paperclip.example.test:3200";
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        paperclipApiUrl: "https://paperclip.example.test",
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      paperclipApiUrl: "https://paperclip.example.test",
      paperclipTransport: "direct",
    });
  });
});
