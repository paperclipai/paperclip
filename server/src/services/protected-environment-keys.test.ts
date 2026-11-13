import { beforeEach, describe, expect, it, vi } from "vitest";

const driverFor = vi.hoisted(() => vi.fn());
vi.mock("./plugin-runner-ai-connection.js", () => ({ pluginEnvironmentRunnerTaskDriver: driverFor }));

const {
  assertEnvironmentVariablesNotProtected,
  assertNoProtectedEnvironmentKeys,
  listProtectedEnvironmentKeyHolders,
  protectedEnvironmentKeyWarnings,
} = await import("./protected-environment-keys.js");

const holders = [
  { environmentId: "computer-a", environmentName: "Computer A", keys: new Set(["DESKTOP_SESSION"]) },
  { environmentId: "computer-b", environmentName: "Computer B", keys: new Set(["DESKTOP_SESSION", "DESKTOP_DISPLAY"]) },
];

function fakeDb(rows: unknown[]) {
  return { select: () => ({ from: () => ({ where: async () => rows }) }) } as never;
}

beforeEach(() => { driverFor.mockReset(); });

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

  it("lists only plugin environments whose task driver declares keys", async () => {
    driverFor.mockImplementation(async (_db: unknown, environment: { config: { driverKey: string } }) =>
      environment.config.driverKey === "computer" ? { protectedEnvironmentKeys: ["DESKTOP_SESSION"] } : { supportsTasks: true });
    const db = fakeDb([
      { id: "a", name: "Computer", driver: "plugin", config: { pluginKey: "p", driverKey: "computer" } },
      { id: "b", name: "Plain", driver: "plugin", config: { pluginKey: "p", driverKey: "plain" } },
    ]);
    expect(await listProtectedEnvironmentKeyHolders(db)).toEqual([
      { environmentId: "a", environmentName: "Computer", keys: new Set(["DESKTOP_SESSION"]) },
    ]);
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
});
