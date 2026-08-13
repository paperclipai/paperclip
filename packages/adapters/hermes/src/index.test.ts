import { expect, test } from "vitest";

import {
  createHermesGatewayServerAdapter,
  createHermesLocalServerAdapter,
  createServerAdapter,
  hermesGatewayType,
} from "./index.js";
import { createServerAdapter as createGatewayServerAdapterFromSubpath } from "./gateway/index.js";

test("root package export exposes Paperclip external adapter entrypoint", () => {
  const adapter = createServerAdapter();

  expect(adapter.type).toBe("hermes_local");
  expect(typeof adapter.execute).toBe("function");
  expect(typeof adapter.testEnvironment).toBe("function");
  expect(typeof adapter.sessionCodec?.deserialize).toBe("function");
  expect(adapter.sessionManagement?.nativeContextManagement).toBe("confirmed");
  expect(adapter.supportsLocalAgentJwt).toBe(true);
  expect(adapter.supportsInstructionsBundle).toBe(true);
  expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
  expect(adapter.getRuntimeCommandSpec?.({})).toMatchObject({
    command: "hermes",
    detectCommand: "hermes",
    installCommand: null,
  });
  expect(adapter.getRuntimeCommandSpec?.({ command: "hermes" })).toMatchObject({
    command: "hermes",
    detectCommand: "hermes",
    installCommand: null,
  });
  expect(() => adapter.getRuntimeCommandSpec?.({ command: "hermes-dev" })).toThrow(/command/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ command: 1 })).toThrow(/command/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ command: true })).toThrow(/command/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ command: { value: "hermes" } })).toThrow(/command/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ command: ["hermes"] })).toThrow(/command/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ hermesCommand: 1 })).toThrow(/hermesCommand/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ hermesCommand: false })).toThrow(/hermesCommand/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ hermesCommand: { value: "hermes" } })).toThrow(/hermesCommand/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ hermesCommand: ["hermes"] })).toThrow(/hermesCommand/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ profile: "Agent" })).toThrow(/profile/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ profile: "root" })).toThrow(/reserved/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ extraArgs: ["--profile", "other"] })).toThrow(/extraArgs/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ extraArgs: [1] })).toThrow(/extraArgs/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ extraArgs: "--profile other" })).toThrow(/extraArgs/i);
  expect(() => adapter.getRuntimeCommandSpec?.({ extraArgs: { value: "--profile other" } })).toThrow(/extraArgs/i);
  expect(typeof adapter.detectModel).toBe("function");
  expect(typeof adapter.getConfigSchema).toBe("function");
});

test("root package export keeps explicit local and gateway adapter factories", () => {
  const localAdapter = createHermesLocalServerAdapter();
  const gatewayAdapter = createHermesGatewayServerAdapter();

  expect(localAdapter.type).toBe("hermes_local");
  expect(gatewayAdapter.type).toBe("hermes_gateway");
  expect(hermesGatewayType).toBe("hermes_gateway");
  expect(gatewayAdapter.supportsLocalAgentJwt).toBe(false);
  expect(gatewayAdapter.supportsInstructionsBundle).toBe(false);
});

test("gateway subpath export exposes the Hermes Gateway adapter entrypoint", () => {
  const adapter = createGatewayServerAdapterFromSubpath();

  expect(adapter.type).toBe("hermes_gateway");
  expect(typeof adapter.execute).toBe("function");
  expect(typeof adapter.testEnvironment).toBe("function");
  expect(typeof adapter.sessionCodec?.deserialize).toBe("function");
  expect(adapter.sessionManagement?.nativeContextManagement).toBe("confirmed");
  expect(typeof adapter.getConfigSchema).toBe("function");
});

test("Hermes adapter exposes bundled Paperclip task bridge skill", async () => {
  const adapter = createServerAdapter();
  const snapshot = await adapter.listSkills?.({
    adapterType: "hermes_local",
    agentId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    config: {},
  });

  expect(snapshot?.entries.some((entry) => entry.runtimeName === "paperclip-task-bridge")).toBe(true);
});
