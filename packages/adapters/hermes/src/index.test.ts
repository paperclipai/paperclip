import { afterEach, expect, test } from "vitest";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createHermesGatewayServerAdapter,
  createHermesLocalServerAdapter,
  createServerAdapter,
  hermesGatewayType,
} from "./index.js";
import { createServerAdapter as createGatewayServerAdapterFromSubpath } from "./gateway/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

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
  expect(adapter.getRuntimeCommandSpec?.({ command: "hermes-dev" })).toMatchObject({
    command: "hermes-dev",
    detectCommand: "hermes-dev",
    installCommand: null,
  });
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

test("Hermes snapshot reports a desired source without SKILL.md as missing", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-snapshot-"));
  tempRoots.push(tempRoot);
  const source = path.join(tempRoot, "paperclip");
  await fs.mkdir(source, { recursive: true });
  const adapter = createServerAdapter();

  const snapshot = await adapter.listSkills?.({
    adapterType: "hermes_local",
    agentId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    config: {
      paperclipRuntimeSkills: [
        { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source },
      ],
      paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/paperclip"] },
    },
  });

  expect(snapshot?.entries.find((entry) => entry.key === "paperclipai/paperclip/paperclip")).toMatchObject({
    state: "missing",
  });
  expect(snapshot?.warnings).toContainEqual(expect.stringContaining("missing SKILL.md"));
});
