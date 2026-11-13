import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeEnvironmentConfigForPersistence, resolveEnvironmentDriverConfigForRuntime } from "../services/environment-config.js";

const fixture = vi.hoisted(() => ({
  get: vi.fn(), binding: vi.fn(), connect: vi.fn(),
  secrets: { resolveSecretValue: vi.fn(), resolveSecretVersion: vi.fn(), rotate: vi.fn() },
}));
vi.mock("../services/tailscale-connections.js", () => ({ tailscaleConnectionService: () => ({ get: fixture.get, environmentBinding: fixture.binding }) }));
vi.mock("../services/tailscale-network.js", () => ({ tailscaleNetworks: { connect: fixture.connect } }));
vi.mock("../services/secrets.js", () => ({ secretService: () => fixture.secrets }));

const companyId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const secretId = "33333333-3333-4333-8333-333333333333";
const config = {
  network: "tailscale", tailscaleConnectionId: connectionId, tailscaleDeviceId: "stable-machine-id",
  host: "100.64.0.1", port: 22, username: "developer", remoteWorkspacePath: "/workspace",
  tailscaleAuthKeySecretRef: { type: "secret_ref", secretId, version: "latest" },
};
const environment = { id: "44444444-4444-4444-8444-444444444444", driver: "ssh" as const, config };

describe("SSH environments using the Tailscale connector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.get.mockResolvedValue({ id: connectionId, companyId, secretId, status: "connected" });
    fixture.binding.mockResolvedValue({ host: "100.64.0.2", secretId, socket: "/tmp/private-tailscale/socket" });
    fixture.connect.mockResolvedValue("/tmp/private-tailscale/socket");
    fixture.secrets.resolveSecretValue.mockResolvedValue("fixture-encrypted-node-state");
    fixture.secrets.resolveSecretVersion.mockResolvedValue(2);
  });

  it("uses the connector's company-scoped address and secret instead of client-supplied values", async () => {
    const stored = await normalizeEnvironmentConfigForPersistence({ db: {} as never, companyId, environmentName: "Workstation", driver: "ssh", secretProvider: "local_encrypted",
      config: { ...config, host: "untrusted.invalid", tailscaleAuthKeySecretRef: { ...config.tailscaleAuthKeySecretRef, secretId: "55555555-5555-4555-8555-555555555555" } } });
    expect(fixture.binding).toHaveBeenCalledWith(companyId, connectionId, "stable-machine-id");
    expect(stored).toMatchObject({ host: "100.64.0.2", tailscaleAuthKeySecretRef: { secretId } });
  });

  it("refreshes the selected machine address at execution and uses only the connector's private socket", async () => {
    const resolved = await resolveEnvironmentDriverConfigForRuntime({} as never, companyId, environment);
    expect(fixture.get).toHaveBeenCalledWith(companyId, connectionId);
    expect(fixture.binding).toHaveBeenCalledWith(companyId, connectionId, "stable-machine-id");
    expect(resolved).toMatchObject({ driver: "ssh", config: { host: "100.64.0.2", tailscaleSocket: "/tmp/private-tailscale/socket", tailscaleIdentity: `${companyId}:${secretId}` } });
  });

  it.each(["pending", "connecting", "disconnected"])("rejects a %s connector before reading any runtime credentials", async status => {
    fixture.get.mockResolvedValue({ id: connectionId, companyId, secretId, status });
    await expect(resolveEnvironmentDriverConfigForRuntime({} as never, companyId, environment)).rejects.toMatchObject({ status: 422 });
    expect(fixture.secrets.resolveSecretValue).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("never falls back to a caller's host or the system tailnet when company access or device lookup fails", async () => {
    fixture.binding.mockRejectedValue(new Error("machine unavailable in this company"));
    await expect(resolveEnvironmentDriverConfigForRuntime({} as never, companyId, environment)).rejects.toThrow("machine unavailable");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("keeps read-only inspection free of network and daemon activity", async () => {
    const resolved = await resolveEnvironmentDriverConfigForRuntime({} as never, companyId, environment, { readOnlyInspection: true });
    expect(resolved.driver).toBe("ssh");
    expect(fixture.binding).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
  });
});
