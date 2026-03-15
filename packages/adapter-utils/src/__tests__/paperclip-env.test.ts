import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { applyLocalAgentFilesystemEnv } from "../server-utils.js";

describe("applyLocalAgentFilesystemEnv", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and set controlled env for deterministic paths
    savedEnv.PAPERCLIP_HOME = process.env.PAPERCLIP_HOME;
    savedEnv.PAPERCLIP_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = "/test/paperclip";
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
  });

  afterEach(() => {
    // Restore
    if (savedEnv.PAPERCLIP_HOME === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = savedEnv.PAPERCLIP_HOME;
    if (savedEnv.PAPERCLIP_INSTANCE_ID === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = savedEnv.PAPERCLIP_INSTANCE_ID;
  });

  const INSTANCE_ROOT = "/test/paperclip/instances/test-instance";
  const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("sets HOME and AGENT_HOME to the agent workspace dir", () => {
    const env: Record<string, string> = {};
    applyLocalAgentFilesystemEnv(env, { agentId: AGENT_ID });

    const expected = path.join(INSTANCE_ROOT, "workspaces", AGENT_ID);
    expect(env.HOME).toBe(expected);
    expect(env.AGENT_HOME).toBe(expected);
  });

  it("sets TMPDIR, TMP, and TEMP to the agent tmp dir", () => {
    const env: Record<string, string> = {};
    applyLocalAgentFilesystemEnv(env, { agentId: AGENT_ID });

    const expected = path.join(INSTANCE_ROOT, "tmp", AGENT_ID);
    expect(env.TMPDIR).toBe(expected);
    expect(env.TMP).toBe(expected);
    expect(env.TEMP).toBe(expected);
  });

  it("sets a tool-specific home var when toolHome is provided", () => {
    const env: Record<string, string> = {};
    applyLocalAgentFilesystemEnv(env, {
      agentId: AGENT_ID,
      toolHome: { envVar: "CODEX_HOME", dirName: ".codex" },
    });

    const agentHome = path.join(INSTANCE_ROOT, "workspaces", AGENT_ID);
    expect(env.CODEX_HOME).toBe(path.join(agentHome, ".codex"));
  });

  it("does not override existing HOME if already set", () => {
    const env: Record<string, string> = { HOME: "/custom/home" };
    applyLocalAgentFilesystemEnv(env, { agentId: AGENT_ID });

    expect(env.HOME).toBe("/custom/home");
    // AGENT_HOME should still be set to the standard location
    expect(env.AGENT_HOME).toBe(path.join(INSTANCE_ROOT, "workspaces", AGENT_ID));
  });

  it("does not override existing AGENT_HOME if already set", () => {
    const env: Record<string, string> = { AGENT_HOME: "/custom/agent-home" };
    applyLocalAgentFilesystemEnv(env, { agentId: AGENT_ID });

    expect(env.AGENT_HOME).toBe("/custom/agent-home");
  });

  it("does not override existing TMPDIR if already set", () => {
    const env: Record<string, string> = { TMPDIR: "/custom/tmp" };
    applyLocalAgentFilesystemEnv(env, { agentId: AGENT_ID });

    expect(env.TMPDIR).toBe("/custom/tmp");
    // TMP and TEMP should still be set
    expect(env.TMP).toBe(path.join(INSTANCE_ROOT, "tmp", AGENT_ID));
    expect(env.TEMP).toBe(path.join(INSTANCE_ROOT, "tmp", AGENT_ID));
  });

  it("does not override existing tool home if already set", () => {
    const env: Record<string, string> = { CODEX_HOME: "/custom/codex" };
    applyLocalAgentFilesystemEnv(env, {
      agentId: AGENT_ID,
      toolHome: { envVar: "CODEX_HOME", dirName: ".codex" },
    });

    expect(env.CODEX_HOME).toBe("/custom/codex");
  });

  it("derives tool home from the resolved HOME, not from the standard agent home", () => {
    const env: Record<string, string> = { HOME: "/custom/home" };
    applyLocalAgentFilesystemEnv(env, {
      agentId: AGENT_ID,
      toolHome: { envVar: "CLAUDE_HOME", dirName: ".claude" },
    });

    expect(env.CLAUDE_HOME).toBe("/custom/home/.claude");
  });

  it("uses default instance id when PAPERCLIP_INSTANCE_ID is not set", () => {
    delete process.env.PAPERCLIP_INSTANCE_ID;
    const env: Record<string, string> = {};
    applyLocalAgentFilesystemEnv(env, { agentId: AGENT_ID });

    expect(env.HOME).toBe(path.join("/test/paperclip/instances/default/workspaces", AGENT_ID));
    expect(env.TMPDIR).toBe(path.join("/test/paperclip/instances/default/tmp", AGENT_ID));
  });

  it("returns the same env object (mutated in place)", () => {
    const env: Record<string, string> = {};
    const result = applyLocalAgentFilesystemEnv(env, { agentId: AGENT_ID });
    expect(result).toBe(env);
  });
});
