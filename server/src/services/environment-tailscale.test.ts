import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  secrets: { resolveSecretValue: vi.fn(), resolveSecretVersion: vi.fn(), rotate: vi.fn() },
  connect: vi.fn(),
}));
vi.mock("./secrets.js", () => ({ secretService: () => mocks.secrets }));
vi.mock("./tailscale-network.js", () => ({ tailscaleNetworks: { connect: mocks.connect } }));
import { collectEnvironmentSecretRefs, resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";

const db = {} as Db;
const environment = { id: "environment-one", driver: "ssh" as const, config: { network: "tailscale", host: "workstation", username: "developer",
  remoteWorkspacePath: "/workspace", tailscaleAuthKeySecretRef: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" } } };

describe("Tailscale environment credential boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.secrets.resolveSecretVersion.mockResolvedValue(7);
    mocks.secrets.resolveSecretValue.mockResolvedValue("tskey-auth-fixture");
    mocks.secrets.rotate.mockResolvedValue(undefined);
    mocks.connect.mockResolvedValue("/tmp/isolated/socket");
  });

  it("resolves and updates only an authorized company/environment secret", async () => {
    mocks.connect.mockImplementation(async ({ persist }) => {
      await persist("encrypted-provider-stores-node-state");
      await persist("updated-node-state");
      return "/tmp/isolated/socket";
    });
    const result = await resolveEnvironmentDriverConfigForRuntime(db, "company-one", environment);
    expect(mocks.secrets.resolveSecretValue).toHaveBeenCalledWith("company-one", environment.config.tailscaleAuthKeySecretRef.secretId, 7,
      expect.objectContaining({ consumerType: "environment", consumerId: environment.id, configPath: "tailscaleAuthKeySecretRef" }));
    expect(mocks.secrets.rotate).toHaveBeenNthCalledWith(1, environment.config.tailscaleAuthKeySecretRef.secretId,
      { value: "encrypted-provider-stores-node-state", expectedLatestVersion: 7 });
    expect(mocks.secrets.rotate).toHaveBeenNthCalledWith(2, environment.config.tailscaleAuthKeySecretRef.secretId,
      { value: "updated-node-state", expectedLatestVersion: 8 });
    expect(result.config).toMatchObject({ tailscaleSocket: "/tmp/isolated/socket", tailscaleIdentity: "company-one:" + environment.config.tailscaleAuthKeySecretRef.secretId });
    expect(JSON.stringify(result)).not.toContain("tskey-auth-fixture");
    expect(await collectEnvironmentSecretRefs({ db, environment })).toEqual([{ secretId: environment.config.tailscaleAuthKeySecretRef.secretId,
      configPath: "tailscaleAuthKeySecretRef", versionSelector: "latest" }]);
  });

  it("does not start networking when company binding is rejected", async () => {
    mocks.secrets.resolveSecretVersion.mockRejectedValue(new Error("Secret must belong to same company"));
    await expect(resolveEnvironmentDriverConfigForRuntime(db, "other-company", environment)).rejects.toThrow("same company");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.secrets.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("refreshes the credential version after cleanup before storing a replacement identity", async () => {
    mocks.secrets.resolveSecretVersion.mockResolvedValueOnce(7).mockResolvedValueOnce(9);
    mocks.secrets.resolveSecretValue.mockResolvedValueOnce("stale-state").mockResolvedValueOnce("current-state");
    mocks.connect.mockImplementation(async ({ reload, persist }) => {
      expect(await reload()).toBe("current-state");
      await persist("replacement-state");
      return "/tmp/replacement/socket";
    });
    await resolveEnvironmentDriverConfigForRuntime(db, "company-one", environment);
    expect(mocks.secrets.resolveSecretValue).toHaveBeenLastCalledWith("company-one", environment.config.tailscaleAuthKeySecretRef.secretId, 9,
      expect.objectContaining({ consumerType: "environment", consumerId: environment.id, configPath: "tailscaleAuthKeySecretRef" }));
    expect(mocks.secrets.rotate).toHaveBeenCalledWith(environment.config.tailscaleAuthKeySecretRef.secretId,
      { value: "replacement-state", expectedLatestVersion: 9 });
  });

  it("requires company and environment context, and never falls back to direct SSH", async () => {
    await expect(resolveEnvironmentDriverConfigForRuntime(db, null, environment)).rejects.toThrow("company context");
    await expect(resolveEnvironmentDriverConfigForRuntime(db, "company-one", { ...environment, id: undefined })).rejects.toThrow("company context");
    await expect(resolveEnvironmentDriverConfigForRuntime(db, "company-one", { ...environment, config: { ...environment.config, tailscaleAuthKeySecretRef: null } })).rejects.toThrow("Connect Tailscale");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("keeps read-only inspection and direct SSH independent of the Tailscale runtime", async () => {
    await resolveEnvironmentDriverConfigForRuntime(db, "company-one", environment, { readOnlyInspection: true });
    await resolveEnvironmentDriverConfigForRuntime(db, "company-one", { ...environment, config: { ...environment.config, network: "direct" } });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.secrets.resolveSecretValue).not.toHaveBeenCalled();
  });
});
