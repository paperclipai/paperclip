import { describe, expect, it } from "vitest";
import { classifyCopilotFailure, composeCopilotSystemInstructions, COPILOT_TASK_ORIENTATION_INSTRUCTIONS, copilotConfiguration, copilotSandboxEnvironment, COPILOT_LAUNCH_ARGUMENTS } from "./copilot-profile.js";

describe("Copilot admission policy", () => {
  it("bounds the complete native instruction file without retaining prior instructions", () => {
    const suffix = `\n\n# Paperclip task orientation\n${COPILOT_TASK_ORIENTATION_INSTRUCTIONS}`;
    expect(composeCopilotSystemInstructions("Current instructions.")).toBe(`Current instructions.${suffix}`);
    expect(composeCopilotSystemInstructions("")).toBe(suffix);
    const remaining = 32 * 1024 - Buffer.byteLength(`${suffix}\n`);
    expect(Buffer.byteLength(`${composeCopilotSystemInstructions("x".repeat(remaining))}\n`)).toBe(32 * 1024);
    expect(() => composeCopilotSystemInstructions("x".repeat(remaining + 1))).toThrow("bounded size");
    expect(() => composeCopilotSystemInstructions("é".repeat(Math.floor(remaining / 2) + 1))).toThrow("bounded size");
    expect(() => composeCopilotSystemInstructions("embedded\0instruction")).toThrow("bounded size");
  });
  it("uses ACP directly without disabling questions or bypassing permissions", () => {
    expect(COPILOT_LAUNCH_ARGUMENTS.slice(0, 2)).toEqual(["--acp", "--stdio"]);
    expect(COPILOT_LAUNCH_ARGUMENTS).toContain("--no-auto-update");
    expect(COPILOT_LAUNCH_ARGUMENTS).toContain("--secret-env-vars=COPILOT_GITHUB_TOKEN");
    expect(COPILOT_LAUNCH_ARGUMENTS).not.toContain("--no-ask-user");
    expect(COPILOT_LAUNCH_ARGUMENTS).not.toContain("--allow-all");
    expect(COPILOT_LAUNCH_ARGUMENTS).not.toContain("--allow-all-tools");
  });
  it("uses private config and extracted runtime cache without ambient authority", () => {
    const env = copilotSandboxEnvironment({ homeDirectory: "/private/home", configDirectory: "/private/config", dataDirectory: "/private/data", cacheDirectory: "/private/cache", agentHomeDirectory: "/private/copilot" });
    expect(env).toMatchObject({ COPILOT_HOME: "/private/copilot", COPILOT_CACHE_HOME: "/private/cache", COPILOT_PKG_CACHE_HOME: "/private/cache", COPILOT_AUTO_UPDATE: "false", COPILOT_ALLOW_ALL: "false" });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(copilotConfiguration()).toMatchObject({ trustedFolders: [], disableAllHooks: true, ide: { autoConnect: false } });
    expect(() => copilotSandboxEnvironment({ homeDirectory: "relative", configDirectory: "/c", dataDirectory: "/d", cacheDirectory: "/c", agentHomeDirectory: "/a" })).toThrow(/absolute/);
  });
  it.each([
    ["Authentication required ghp_private", "COPILOT_AUTH_REQUIRED"],
    ["Organization policy denied this model", "COPILOT_ENTITLEMENT_DENIED"],
    ["Model gpt-private is unavailable", "COPILOT_MODEL_UNAVAILABLE"],
    ["transport failed ghp_private", "COPILOT_REQUEST_FAILED"],
  ])("classifies provider errors without leaking raw messages", (message, code) => {
    expect(classifyCopilotFailure({ message }).code).toBe(code);
    expect(classifyCopilotFailure(new Error(message)).message).not.toContain("private");
  });
});
