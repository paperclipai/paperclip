import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GUILD_MEMORY_PROJECT_PREFIX,
  GUILD_WORKER_AUTONOMY_FILE,
  GUILD_WORKER_LEARNINGS_FILE,
  GUILD_WORKER_SKILLS_FILE,
  buildGuildWorkerEnv,
} from "../dispatch/guild-worker-env.js";

describe("buildGuildWorkerEnv (Plan 3 Phase E1a)", () => {
  const sandboxDir = "/tmp/paperclip-guild-run-abcd1234-XXXXXX";

  it("returns the full env shape for a guild agent", () => {
    const env = buildGuildWorkerEnv({
      agent: {
        id: "ff5c34cd-b867-42d5-bc00-4e51b24367fa",
        name: "eng-guild",
        kind: "guild",
      },
      sandboxDir,
    });
    expect(env).toEqual({
      GUILD_ID: "ff5c34cd-b867-42d5-bc00-4e51b24367fa",
      GUILD_SLUG: "eng-guild",
      GUILD_AUTONOMY_JSON_PATH: path.join(sandboxDir, GUILD_WORKER_AUTONOMY_FILE),
      GUILD_SKILLS_PATH: path.join(sandboxDir, GUILD_WORKER_SKILLS_FILE),
      WORKER_LEARNINGS_PATH: path.join(sandboxDir, GUILD_WORKER_LEARNINGS_FILE),
      MEMORY_SERVICE_PROJECT: `${GUILD_MEMORY_PROJECT_PREFIX}/eng-guild`,
      AGENT_HOME: sandboxDir,
    });
  });

  it("emits AGENT_HOME=sandboxDir for every guild worker (Task 2.4b)", () => {
    // Verifies the artifact-contract bug fix: workers + sandbox prep +
    // upload hook must all agree that the per-run sandbox dir is the
    // worker's $AGENT_HOME. Before Task 2.4b this var was never set,
    // so workers invented their own paths and the upload hook (reading
    // from resolveDefaultAgentWorkspaceDir) found nothing.
    for (const slug of ["eng-guild", "video-guild", "design-guild"]) {
      const env = buildGuildWorkerEnv({
        agent: { id: `aaaaaaaa-bbbb-cccc-dddd-${slug.padEnd(12, "x")}`, name: slug, kind: "guild" },
        sandboxDir: "/tmp/paperclip-guild-run-some-id-XXXXXX",
      });
      expect(env.AGENT_HOME).toBe("/tmp/paperclip-guild-run-some-id-XXXXXX");
    }
  });

  it("returns an empty object for kind='agent' so callers can spread unconditionally", () => {
    const env = buildGuildWorkerEnv({
      agent: { id: "11111111-1111-1111-1111-111111111111", name: "hermes-pilot", kind: "agent" },
      sandboxDir,
    });
    expect(env).toEqual({});
  });

  it("returns an empty object for kind='orchestrator' or 'worker' (defense in depth)", () => {
    for (const kind of ["orchestrator", "worker"] as const) {
      const env = buildGuildWorkerEnv({
        agent: { id: "22222222-2222-2222-2222-222222222222", name: `some-${kind}`, kind },
        sandboxDir,
      });
      expect(env).toEqual({});
    }
  });

  it("derives MEMORY_SERVICE_PROJECT as farm/<slug>", () => {
    const env = buildGuildWorkerEnv({
      agent: { id: "33333333-3333-3333-3333-333333333333", name: "design-guild", kind: "guild" },
      sandboxDir,
    });
    expect(env.MEMORY_SERVICE_PROJECT).toBe("farm/design-guild");
  });

  it("joins paths with the platform separator so all sidecar files are siblings in the sandbox", () => {
    const env = buildGuildWorkerEnv({
      agent: { id: "44444444-4444-4444-4444-444444444444", name: "eng-guild", kind: "guild" },
      sandboxDir: "/var/tmp/paperclip-guild-run-xyz",
    });
    expect(env.GUILD_AUTONOMY_JSON_PATH).toBe(path.join("/var/tmp/paperclip-guild-run-xyz", "autonomy.json"));
    expect(env.GUILD_SKILLS_PATH).toBe(path.join("/var/tmp/paperclip-guild-run-xyz", "available_skills.json"));
    expect(env.WORKER_LEARNINGS_PATH).toBe(path.join("/var/tmp/paperclip-guild-run-xyz", "learnings.json"));
  });

  it("exposes the sidecar file-name constants for cross-module reuse", () => {
    expect(GUILD_WORKER_AUTONOMY_FILE).toBe("autonomy.json");
    expect(GUILD_WORKER_SKILLS_FILE).toBe("available_skills.json");
    expect(GUILD_WORKER_LEARNINGS_FILE).toBe("learnings.json");
    expect(GUILD_MEMORY_PROJECT_PREFIX).toBe("farm");
  });
});
