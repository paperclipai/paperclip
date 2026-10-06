import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("Hermes keeps the operational Paperclip skill linked after an empty replacement", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-core-skill-"));
  try {
    const source = path.join(home, "runtime-skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");
    const adapter = createServerAdapter();
    const snapshot = await adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      config: {
        env: { HOME: home, HERMES_HOME: path.join(home, "hermes-home") },
        paperclipRuntimeSkills: [{
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source,
        }],
        paperclipSkillSync: { desiredSkills: [] },
      },
    }, []);

    expect(snapshot?.desiredSkills).toContain("paperclipai/paperclip/paperclip");
    expect(
      (await fs.lstat(path.join(home, "hermes-home", "skills", "paperclip"))).isSymbolicLink(),
    ).toBe(true);
    // Regression: $HOME/.hermes must NOT be created — it is not the Hermes skills dir.
    await expect(
      fs.lstat(path.join(home, ".hermes", "skills", "paperclip")),
    ).rejects.toThrow();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Hermes rejects a conflicting operational skill target", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-core-conflict-"));
  const hermesHome = path.join(home, "hermes-home");
  try {
    const source = path.join(home, "runtime-skills", "paperclip");
    const target = path.join(hermesHome, "skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "SKILL.md"), "# Conflicting skill\n", "utf8");
    const adapter = createServerAdapter();

    await expect(adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      config: {
        env: { HOME: home, HERMES_HOME: hermesHome },
        paperclipRuntimeSkills: [{
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source,
        }],
      },
    }, [])).rejects.toThrow("occupied by another installation");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Hermes rejects a live symlink owned by another operational skill", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-core-link-conflict-"));
  const hermesHome = path.join(home, "hermes-home");
  try {
    const source = path.join(home, "runtime-skills", "paperclip");
    const conflictingSource = path.join(home, "external-skills", "paperclip");
    const target = path.join(hermesHome, "skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");
    await fs.mkdir(conflictingSource, { recursive: true });
    await fs.writeFile(path.join(conflictingSource, "SKILL.md"), "# External skill\n", "utf8");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(conflictingSource, target);
    const adapter = createServerAdapter();

    await expect(adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      config: {
        env: { HOME: home, HERMES_HOME: hermesHome },
        paperclipRuntimeSkills: [{
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source,
        }],
      },
    }, [])).rejects.toThrow("occupied by another installation");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("HERMES_HOME takes precedence over HOME for the Hermes skills dir", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-home-precedence-"));
  const previousHermesHome = process.env.HERMES_HOME;
  try {
    const source = path.join(home, "runtime-skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");
    const hermesHome = path.join(home, "custom-hermes-home");
    const adapter = createServerAdapter();
    const config = {
      env: { HOME: home },
      paperclipRuntimeSkills: [{
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source,
      }],
      paperclipSkillSync: { desiredSkills: [] },
    };
    const withProcessEnv = async () => {
      await adapter.syncSkills?.({
        adapterType: "hermes_local",
        agentId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-4222-4222-8222-222222222222",
        config,
      }, []);
    };
    process.env.HERMES_HOME = hermesHome;
    await withProcessEnv();
    expect((await fs.lstat(path.join(hermesHome, "skills", "paperclip"))).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(home, ".hermes", "skills", "paperclip"))).rejects.toThrow();
    // An explicit adapter config wins over the process environment.
    process.env.HERMES_HOME = path.join(home, "ignored-process-home");
    const configHome = path.join(home, "config-home");
    await adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-4222-4222-8222-222222222222",
      config: { ...config, env: { HOME: home, HERMES_HOME: configHome } },
    }, []);
    expect((await fs.lstat(path.join(configHome, "skills", "paperclip"))).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(home, "ignored-process-home", "skills", "paperclip"))).rejects.toThrow();
  } finally {
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});
