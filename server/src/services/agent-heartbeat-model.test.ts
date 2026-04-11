import { describe, expect, it } from "vitest";
import {
  COO_COORDINATOR_DEFAULT_INTERVAL_SEC,
  normalizeRuntimeConfigForCooHeartbeatModel,
  resolveRoleForCooCoordinatorModel,
  stripCooSeedAdapterConfig,
} from "./agent-heartbeat-model.js";

describe("resolveRoleForCooCoordinatorModel", () => {
  it("promotes title COO to coo role", () => {
    const role = resolveRoleForCooCoordinatorModel({
      role: "pm",
      name: "Coordinator",
      title: "COO",
    });
    expect(role).toBe("coo");
  });

  it("promotes operations leadership titles to coo role", () => {
    const role = resolveRoleForCooCoordinatorModel({
      role: "general",
      name: "OperationsLead",
      title: "Head of Operations",
    });
    expect(role).toBe("coo");
  });
});

describe("normalizeRuntimeConfigForCooHeartbeatModel", () => {
  it("defaults COO to enabled timer heartbeat", () => {
    const runtimeConfig = normalizeRuntimeConfigForCooHeartbeatModel({
      role: "coo",
      runtimeConfig: {},
    });

    expect(runtimeConfig).toEqual({
      heartbeat: {
        enabled: true,
        intervalSec: COO_COORDINATOR_DEFAULT_INTERVAL_SEC,
      },
    });
  });

  it("defaults non-COO agents to disabled timer heartbeat", () => {
    const runtimeConfig = normalizeRuntimeConfigForCooHeartbeatModel({
      role: "engineer",
      runtimeConfig: {},
    });

    expect(runtimeConfig).toEqual({
      heartbeat: {
        enabled: false,
      },
    });
  });

  it("keeps explicit heartbeat enabled for non-COO agents in default mode", () => {
    const runtimeConfig = normalizeRuntimeConfigForCooHeartbeatModel({
      role: "engineer",
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 1200,
        },
      },
    });

    expect(runtimeConfig).toEqual({
      heartbeat: {
        enabled: true,
        intervalSec: 1200,
      },
    });
  });

  it("enforces COO model when requested", () => {
    const runtimeConfig = normalizeRuntimeConfigForCooHeartbeatModel({
      role: "engineer",
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 1200,
        },
      },
      mode: "enforce",
    });

    expect(runtimeConfig).toEqual({
      heartbeat: {
        enabled: false,
        intervalSec: 1200,
      },
    });
  });

  it("forces COO heartbeat enabled and interval when enforcing", () => {
    const runtimeConfig = normalizeRuntimeConfigForCooHeartbeatModel({
      role: "coo",
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          intervalSec: 0,
        },
      },
      mode: "enforce",
    });

    expect(runtimeConfig).toEqual({
      heartbeat: {
        enabled: true,
        intervalSec: COO_COORDINATOR_DEFAULT_INTERVAL_SEC,
      },
    });
  });

  it("treats COO-designated titles as coordinators for heartbeat defaults", () => {
    const runtimeConfig = normalizeRuntimeConfigForCooHeartbeatModel({
      role: "pm",
      title: "COO",
      runtimeConfig: {},
    });

    expect(runtimeConfig).toEqual({
      heartbeat: {
        enabled: true,
        intervalSec: COO_COORDINATOR_DEFAULT_INTERVAL_SEC,
      },
    });
  });
});

describe("stripCooSeedAdapterConfig", () => {
  it("removes managed instructions pointers from inherited COO adapter config", () => {
    const stripped = stripCooSeedAdapterConfig({
      model: "gpt-5.4",
      command: "codex",
      instructionsBundleMode: "managed",
      instructionsRootPath: "/tmp/instructions",
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: "/tmp/instructions/AGENTS.md",
      promptTemplate: "You are the CEO",
      bootstrapPromptTemplate: "legacy",
      paperclipRuntimeSkills: [{ key: "release", required: true }],
    });

    expect(stripped).toEqual({
      model: "gpt-5.4",
      command: "codex",
    });
  });
});
