import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeEnvironmentConfigForPersistence, resolveEnvironmentDriverConfigForRuntime } from "../services/environment-config.js";
import { unprocessable } from "../errors.js";

const fixture = vi.hoisted(() => ({
  get: vi.fn(), binding: vi.fn(), connect: vi.fn(),
  secrets: { resolveSecretValue: vi.fn(), resolveSecretVersion: vi.fn(), rotate: vi.fn() },
}));
vi.mock("../services/connectors/tailscale/connections.js", () => ({ tailscaleConnectionService: () => ({ get: fixture.get, environmentBinding: fixture.binding }) }));
vi.mock("../services/connectors/tailscale/network.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/connectors/tailscale/network.js")>(),
  tailscaleNetworks: { connect: fixture.connect },
}));
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
    vi.resetAllMocks();
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
    expect(fixture.binding).toHaveBeenCalledWith(companyId, connectionId, "stable-machine-id", secretId);
    expect(resolved).toMatchObject({ driver: "ssh", config: { host: "100.64.0.2", tailscaleSocket: "/tmp/private-tailscale/socket", tailscaleIdentity: `${companyId}:${secretId}` } });
    expect(fixture.connect).not.toHaveBeenCalled();
    expect(fixture.secrets.resolveSecretValue).not.toHaveBeenCalled();
  });

  it.each(["disconnected", "replaced"])("rejects a connector %s while the SSH key is loading", async state => {
    let entered!: () => void, release!: () => void;
    const loading = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    fixture.secrets.resolveSecretValue.mockImplementationOnce(async () => { entered(); await paused; return "fixture-ssh-key"; });
    const resolving = resolveEnvironmentDriverConfigForRuntime({} as never, companyId, { ...environment, config: { ...config,
      privateKeySecretRef: { type: "secret_ref", secretId: "55555555-5555-4555-8555-555555555555", version: "latest" },
    } });
    const outcome = resolving.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await Promise.race([loading, resolving.then(() => { throw new Error("Runtime resolved before loading the SSH key"); })]);
      fixture.get.mockResolvedValue({ id: connectionId, companyId, secretId: state === "replaced" ? "new-secret" : secretId, status: state === "replaced" ? "connected" : state });
      fixture.binding.mockRejectedValue(unprocessable("Reconnect Tailscale and save this environment again.", { code: "tailscale_reauthorization_required" }));
    } finally { release(); }
    expect((await outcome).error).toMatchObject({ status: 422, details: { code: "tailscale_reauthorization_required" } });
    expect(fixture.connect).not.toHaveBeenCalled();
    expect(fixture.binding).toHaveBeenCalledWith(companyId, connectionId, "stable-machine-id", secretId);
    expect(fixture.binding.mock.invocationCallOrder[0]).toBeGreaterThan(fixture.secrets.resolveSecretValue.mock.invocationCallOrder[0]!);
  });

  it.each(["pending", "connecting", "disconnected"])("rejects a %s connector before reading any runtime credentials", async status => {
    fixture.get.mockResolvedValue({ id: connectionId, companyId, secretId, status });
    await expect(resolveEnvironmentDriverConfigForRuntime({} as never, companyId, environment)).rejects.toMatchObject({ status: 422 });
    expect(fixture.secrets.resolveSecretValue).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("rejects a saved network credential without its connector instead of starting a standalone daemon", async () => {
    const configWithoutConnection = { ...config, tailscaleConnectionId: undefined, tailscaleDeviceId: undefined };
    await expect(resolveEnvironmentDriverConfigForRuntime({} as never, companyId, { ...environment, config: configWithoutConnection })).rejects.toMatchObject({ status: 422 });
    await expect(normalizeEnvironmentConfigForPersistence({ db: {} as never, companyId, environmentName: "Workstation", driver: "ssh",
      secretProvider: "local_encrypted", config: configWithoutConnection })).rejects.toMatchObject({ status: 422 });
    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.secrets.resolveSecretValue).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("clears a saved tailnet when Direct is explicitly merged into an SSH environment", async () => {
    const stored = await normalizeEnvironmentConfigForPersistence({ db: {} as never, companyId, environmentName: "Workstation", driver: "ssh",
      secretProvider: "local_encrypted", config: { ...config, network: "direct", host: "direct.example.test" } });
    expect(stored).toMatchObject({ network: "direct", host: "direct.example.test" });
    for (const key of ["tailscaleConnectionId", "tailscaleDeviceId", "tailscaleAuthKeySecretRef", "tailscaleAuthKey"]) {
      expect(stored).not.toHaveProperty(key);
    }
    expect(fixture.binding).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("requires company and environment context before opening a runtime binding", async () => {
    await expect(resolveEnvironmentDriverConfigForRuntime({} as never, null, environment)).rejects.toMatchObject({ status: 422 });
    await expect(resolveEnvironmentDriverConfigForRuntime({} as never, companyId, { ...environment, id: undefined })).rejects.toMatchObject({ status: 422 });
    expect(fixture.binding).not.toHaveBeenCalled();
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
