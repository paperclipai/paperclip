import { beforeEach, describe, expect, it, vi } from "vitest";

const driverFor = vi.hoisted(() => vi.fn());
vi.mock("./plugin-runner-ai-connection.js", () => ({ pluginEnvironmentRunnerTaskDriver: driverFor }));
const instanceDefault = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("./instance-settings.js", () => ({ instanceSettingsService: () => ({ get: async () => ({ defaultEnvironmentId: instanceDefault.value }) }) }));

const {
  assertEnvironmentVariablesNotProtected,
  checkAgentProtectedEnvironmentKeys,
  assertNoProtectedEnvironmentKeys,
  listProtectedEnvironmentKeyHolders,
  protectedEnvironmentKeyWarnings,
} = await import("./protected-environment-keys.js");

const holders = [
  { environmentId: "computer-a", environmentName: "Computer A", keys: new Set(["DESKTOP_SESSION"]) },
  { environmentId: "computer-b", environmentName: "Computer B", keys: new Set(["DESKTOP_SESSION", "DESKTOP_DISPLAY"]) },
];

function fakeDb(...results: unknown[][]) {
  const selects = { count: 0 };
  const db = { select: () => ({ from: () => ({ where: async () => results[selects.count++] ?? [] }) }) };
  return Object.assign(db, { selects }) as never as { selects: { count: number } } & Parameters<typeof listProtectedEnvironmentKeyHolders>[0];
}

beforeEach(() => { driverFor.mockReset(); instanceDefault.value = null; });

describe("protected environment keys", () => {
  it("rejects a key that the selected environment sets itself", () => {
    expect(() => assertNoProtectedEnvironmentKeys(holders, "computer-a", { DESKTOP_SESSION: "mine", OTHER: "ok" }))
      .toThrow(expect.objectContaining({ status: 422, message: expect.stringContaining("DESKTOP_SESSION is set by Computer A on its tasks"),
        details: { code: "protected_environment_variable", keys: ["DESKTOP_SESSION"], environmentId: "computer-a" } }));
  });

  it("allows the key on another environment, or with none selected", () => {
    expect(() => assertNoProtectedEnvironmentKeys(holders, "local", { DESKTOP_SESSION: "mine" })).not.toThrow();
    expect(() => assertNoProtectedEnvironmentKeys(holders, null, { DESKTOP_SESSION: "mine" })).not.toThrow();
    expect(() => assertNoProtectedEnvironmentKeys(holders, "computer-a", { OTHER: "ok" })).not.toThrow();
  });

  it("names every environment that protects a key in a friendly notice", () => {
    expect(protectedEnvironmentKeyWarnings(holders, { DESKTOP_DISPLAY: ":1", DESKTOP_SESSION: "x", OTHER: "ok" }, "env")).toEqual([
      { code: "protected_environment_variable", field: "env.DESKTOP_DISPLAY",
        message: "DESKTOP_DISPLAY is set by Computer B on its tasks. Agents running there may see the platform's value instead of this one." },
      { code: "protected_environment_variable", field: "env.DESKTOP_SESSION",
        message: "DESKTOP_SESSION is set by Computer A, Computer B on their tasks. Agents running there may see the platform's value instead of this one." },
    ]);
    expect(protectedEnvironmentKeyWarnings(holders, null, "env")).toEqual([]);
  });

  it("lists only plugin environments whose task driver declares keys, reading the registry once", async () => {
    const drivers = [
      { driverKey: "computer", supportsTasks: true, protectedEnvironmentKeys: ["DESKTOP_SESSION"] },
      { driverKey: "plain", supportsTasks: true },
      { driverKey: "storage", protectedEnvironmentKeys: ["IGNORED"] },
    ];
    const db = fakeDb([
      { id: "a", name: "Computer", config: { pluginKey: "p", driverKey: "computer" } },
      { id: "b", name: "Plain", config: { pluginKey: "p", driverKey: "plain" } },
      { id: "c", name: "Second computer", config: { pluginKey: "p", driverKey: "computer" } },
      { id: "d", name: "Storage", config: { pluginKey: "p", driverKey: "storage" } },
      { id: "e", name: "Unregistered", config: { pluginKey: "unregistered", driverKey: "computer" } },
      { id: "f", name: "Missing", config: { pluginKey: "missing", driverKey: "computer" } },
    ], [
      { pluginKey: "p", manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: drivers } },
      { pluginKey: "unregistered", manifestJson: { capabilities: [], environmentDrivers: drivers } },
    ]);
    expect(await listProtectedEnvironmentKeyHolders(db)).toEqual([
      { environmentId: "a", environmentName: "Computer", keys: new Set(["DESKTOP_SESSION"]) },
      { environmentId: "c", environmentName: "Second computer", keys: new Set(["DESKTOP_SESSION"]) },
    ]);
    expect(db.selects.count).toBe(2);
    const empty = fakeDb([{ id: "x", name: "No plugin key", config: {} }]);
    expect(await listProtectedEnvironmentKeyHolders(empty)).toEqual([]);
    expect(empty.selects.count).toBe(1);
  });

  it("rejects an environment's own variable when its driver protects it", async () => {
    driverFor.mockResolvedValue({ protectedEnvironmentKeys: ["DESKTOP_SESSION"] });
    await expect(assertEnvironmentVariablesNotProtected(fakeDb([]), { id: "a", name: "Computer", driver: "plugin",
      config: { pluginKey: "p", driverKey: "computer" } }, { DESKTOP_SESSION: "x" }))
      .rejects.toMatchObject({ status: 422, details: { code: "protected_environment_variable", keys: ["DESKTOP_SESSION"] } });
    await expect(assertEnvironmentVariablesNotProtected(fakeDb([]), { name: "Local", driver: "local", config: {} }, { DESKTOP_SESSION: "x" }))
      .resolves.toBeUndefined();
    expect(driverFor).toHaveBeenCalledTimes(1);
  });

  it("checks an agent without its own environment against the instance default", async () => {
    const environmentRows = [{ id: "computer-env", name: "Team Computer", config: { pluginKey: "p", driverKey: "computer" } }];
    const pluginRows = [{ pluginKey: "p", manifestJson: { capabilities: ["environment.drivers.register"],
      environmentDrivers: [{ driverKey: "computer", supportsTasks: true, protectedEnvironmentKeys: ["DESKTOP_SESSION"] }] } }];
    const db = () => fakeDb(environmentRows, pluginRows);
    const config = { env: { DESKTOP_SESSION: { type: "plain", value: "mine" } } };
    instanceDefault.value = "computer-env";
    await expect(checkAgentProtectedEnvironmentKeys(db(), config, null))
      .rejects.toMatchObject({ status: 422, details: { code: "protected_environment_variable", environmentId: "computer-env" } });
    await expect(checkAgentProtectedEnvironmentKeys(db(), config, "computer-env")).rejects.toMatchObject({ status: 422 });
    expect(await checkAgentProtectedEnvironmentKeys(db(), config, "local-env"))
      .toEqual([expect.objectContaining({ field: "adapterConfig.env.DESKTOP_SESSION" })]);
    instanceDefault.value = "local-env";
    expect(await checkAgentProtectedEnvironmentKeys(db(), config, undefined)).toHaveLength(1);
    expect(await checkAgentProtectedEnvironmentKeys(db(), { env: {} }, null)).toEqual([]);
  });
});
