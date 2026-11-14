import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPaperclipEnvEntries, resolvePaperclipEnvFile } from "../config/env.js";
import { toolActionSigningSecretCheck } from "../checks/tool-action-signing-secret-check.js";

const ORIGINAL_ENV = { ...process.env };

function tempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-signing-check-"));
  const configDir = path.join(dir, "custom");
  fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, "config.json");
}

describe("toolActionSigningSecretCheck", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("passes when the secret is in the environment", () => {
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "env-secret";

    expect(toolActionSigningSecretCheck(tempConfigPath()).status).toBe("pass");
  });

  it("passes when the secret is only in the adjacent .env file", () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(
      resolvePaperclipEnvFile(configPath),
      "PAPERCLIP_AGENT_JWT_SECRET=jwt\nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET=file-secret\n",
      { mode: 0o600 },
    );

    expect(toolActionSigningSecretCheck(configPath).status).toBe("pass");
  });

  it("warns when an instance .env has only the agent JWT secret", () => {
    const configPath = tempConfigPath();
    const envPath = resolvePaperclipEnvFile(configPath);
    fs.writeFileSync(envPath, "PAPERCLIP_AGENT_JWT_SECRET=jwt\n", { mode: 0o600 });

    const result = toolActionSigningSecretCheck(configPath);

    expect(result.status).toBe("warn");
    expect(result.canRepair).toBe(true);
    expect(result.message).toContain("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET");
  });

  it("repair adds a signing secret and keeps the agent JWT secret", () => {
    const configPath = tempConfigPath();
    const envPath = resolvePaperclipEnvFile(configPath);
    fs.writeFileSync(envPath, "PAPERCLIP_AGENT_JWT_SECRET=jwt\n", { mode: 0o600 });

    const result = toolActionSigningSecretCheck(configPath);
    result.repair?.();

    const entries = readPaperclipEnvEntries(envPath);
    expect(entries.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toHaveLength(64);
    expect(entries.PAPERCLIP_AGENT_JWT_SECRET).toBe("jwt");
    expect(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(
      entries.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET,
    );
    expect(toolActionSigningSecretCheck(configPath).status).toBe("pass");
  });
});
