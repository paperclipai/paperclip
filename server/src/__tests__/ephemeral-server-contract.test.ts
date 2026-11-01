import { afterEach, expect, it, vi } from "vitest";
import { assertEphemeralServerConfig } from "../services/ephemeral-server-contract.js";
import { assertEphemeralWorkspaceExecution, assertEphemeralNativeLifecycle } from "../services/remote-workspaces.js";
import { assertEphemeralAgentInstructions } from "../services/agent-instructions.js";

const config = { databaseUrl: "postgresql://runtime:fixture@ep-example-pooler.neon.test/tenant", storageProvider: "s3" as const };
const env = { PAPERCLIP_EPHEMERAL_SERVER: "true", PAPERCLIP_DURABLE_AGENT_FILES: "true", PAPERCLIP_SHARED_UI_ASSETS: "true",
  PAPERCLIP_DECISION_SIGNING_SECRET: "synthetic-decision-key-for-deployment-tests",
  PAPERCLIP_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), // 32-byte fixture, never an operator key
  PAPERCLIP_DATABASE_LISTEN_URL: "postgresql://runtime:fixture@ep-example.neon.test/tenant" };
afterEach(() => vi.unstubAllEnvs());
it("requires shared storage and stable secrets without changing volume-backed startup", () => {
  expect(assertEphemeralServerConfig(config, env)).toBe(env.PAPERCLIP_DATABASE_LISTEN_URL);
  expect(assertEphemeralServerConfig({ storageProvider: "local_disk", databaseUrl: undefined }, {})).toBeNull();
  for (const key of ["PAPERCLIP_DURABLE_AGENT_FILES", "PAPERCLIP_SHARED_UI_ASSETS", "PAPERCLIP_SECRETS_MASTER_KEY", "PAPERCLIP_DECISION_SIGNING_SECRET", "PAPERCLIP_DATABASE_LISTEN_URL"]) {
    expect(() => assertEphemeralServerConfig(config, { ...env, [key]: "" })).toThrow("Volume-free server configuration");
  }
  expect(() => assertEphemeralServerConfig({ ...config, storageProvider: "local_disk" }, env)).toThrow("shared S3");
});
it("never connects the listener with migration privileges, another tenant, or through a transaction pooler", () => {
  for (const url of [env.PAPERCLIP_DATABASE_LISTEN_URL.replace("runtime:", "migration:"),
    env.PAPERCLIP_DATABASE_LISTEN_URL.replace("/tenant", "/neighbor"), config.databaseUrl,
    env.PAPERCLIP_DATABASE_LISTEN_URL.replace("ep-example.", "ep-neighbor.")]) {
    expect(() => assertEphemeralServerConfig(config, { ...env, PAPERCLIP_DATABASE_LISTEN_URL: url })).toThrow("runtime role");
  }
});
it("rejects disk-dependent execution and instructions while retaining remote warm execution", () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
  const remote = { externalConversation: false, native: true, adapterType: "paperclip_runner", pluginTaskWorkspace: false, remoteAuthority: true };
  expect(() => assertEphemeralWorkspaceExecution(remote)).not.toThrow();
  expect(() => assertEphemeralWorkspaceExecution({ ...remote, remoteAuthority: false, pluginTaskWorkspace: true })).not.toThrow();
  for (const patch of [{ native: false }, { remoteAuthority: false }, { adapterType: "process" }]) {
    expect(() => assertEphemeralWorkspaceExecution({ ...remote, ...patch })).toThrow("warm Paperclip Runner");
  }
  expect(() => assertEphemeralNativeLifecycle("warm")).not.toThrow();
  expect(() => assertEphemeralNativeLifecycle("per_turn")).toThrow("warm Paperclip Runner");
  const agent = { id: "agent", companyId: "company", name: "Agent", adapterConfig: {} };
  expect(() => assertEphemeralAgentInstructions(agent)).not.toThrow();
  expect(() => assertEphemeralAgentInstructions({ ...agent, adapterConfig: { instructionsBundleMode: "external", instructionsRootPath: "/old-volume" } })).toThrow("managed agent instructions");
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "false");
  expect(() => assertEphemeralWorkspaceExecution({ ...remote, remoteAuthority: false })).not.toThrow();
});
