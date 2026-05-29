import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareEphemeralGeminiHome } from "./execute.js";

describe("prepareEphemeralGeminiHome", () => {
  let sharedHome: string;
  let registryRoot: string;

  beforeEach(async () => {
    sharedHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-shared-"));
    const sharedGemini = path.join(sharedHome, ".gemini");
    await fs.mkdir(sharedGemini, { recursive: true });
    await fs.writeFile(
      path.join(sharedGemini, "settings.json"),
      JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }),
    );
    await fs.writeFile(path.join(sharedGemini, "oauth_creds.json"), '{"token":"shared"}');

    registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-reg-"));
    await fs.mkdir(path.join(registryRoot, "manifests"), { recursive: true });
    await fs.writeFile(
      path.join(registryRoot, "registry.json"),
      JSON.stringify({
        servers: [
          { id: "jira-ibm", status: "validated", manifest: "manifests/jira-ibm.json" },
          { id: "box", status: "blocked-runtime-mismatch", manifest: "manifests/box.json" },
        ],
      }),
    );
    await fs.writeFile(
      path.join(registryRoot, "manifests", "jira-ibm.json"),
      JSON.stringify({ id: "jira-ibm" }),
    );
    await fs.writeFile(
      path.join(registryRoot, "manifests", "box.json"),
      JSON.stringify({ id: "box" }),
    );
  });

  afterEach(async () => {
    await fs.rm(sharedHome, { recursive: true, force: true });
    await fs.rm(registryRoot, { recursive: true, force: true });
  });

  it("returns null when MCP_LIST is unset", async () => {
    const result = await prepareEphemeralGeminiHome({
      env: {},
      sharedHomeDir: sharedHome,
      skillsEntries: [],
    });
    expect(result).toBeNull();
  });

  it("creates an ephemeral home with mcpServers settings", async () => {
    const prepared = await prepareEphemeralGeminiHome({
      env: {
        MCP_LIST: "jira-ibm",
        PAPERCLIP_MCP_REGISTRY_ROOT: registryRoot,
        PAPERCLIP_MCP_RUN_SCRIPT: "/run-mcp.sh",
      },
      sharedHomeDir: sharedHome,
      skillsEntries: [],
    });
    expect(prepared).not.toBeNull();
    try {
      const settings = JSON.parse(
        await fs.readFile(
          path.join(prepared!.ephemeralHomeDir, ".gemini", "settings.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(settings).toMatchObject({
        security: { auth: { selectedType: "oauth-personal" } },
        mcpServers: {
          "jira-ibm": { command: "bash", args: ["/run-mcp.sh", "jira-ibm"] },
        },
      });
      // Credentials are symlinked to the shared home.
      const oauthLink = path.join(prepared!.ephemeralHomeDir, ".gemini", "oauth_creds.json");
      expect((await fs.lstat(oauthLink)).isSymbolicLink()).toBe(true);
    } finally {
      await prepared!.cleanup();
    }
  });

  it("symlinks selected skills into the ephemeral skills dir", async () => {
    const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-skills-src-"));
    try {
      const skillSrc = path.join(skillsRoot, "skill-a");
      await fs.mkdir(skillSrc, { recursive: true });
      const prepared = await prepareEphemeralGeminiHome({
        env: {
          MCP_LIST: "jira-ibm",
          PAPERCLIP_MCP_REGISTRY_ROOT: registryRoot,
        },
        sharedHomeDir: sharedHome,
        skillsEntries: [
          { key: "skill-a", runtimeName: "skill-a", source: skillSrc },
          { key: "skill-b", runtimeName: "skill-b", source: path.join(skillsRoot, "skill-b-missing") },
        ],
        desiredSkillNames: ["skill-a"],
      });
      try {
        const linked = path.join(prepared!.ephemeralHomeDir, ".gemini", "skills", "skill-a");
        expect((await fs.lstat(linked)).isSymbolicLink()).toBe(true);
        // skill-b was not desired
        await expect(
          fs.lstat(path.join(prepared!.ephemeralHomeDir, ".gemini", "skills", "skill-b")),
        ).rejects.toThrow();
      } finally {
        await prepared!.cleanup();
      }
    } finally {
      await fs.rm(skillsRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on blocked status and cleans up", async () => {
    await expect(
      prepareEphemeralGeminiHome({
        env: {
          MCP_LIST: "box",
          PAPERCLIP_MCP_REGISTRY_ROOT: registryRoot,
        },
        sharedHomeDir: sharedHome,
        skillsEntries: [],
      }),
    ).rejects.toThrow(/blocked_status/);
  });
});
