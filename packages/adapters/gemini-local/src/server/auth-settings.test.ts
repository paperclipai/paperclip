import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildGeminiAuthSelectorCommand } from "./auth-settings.js";

const execFileAsync = promisify(execFile);

async function runInShell(command: string, env: Record<string, string>) {
  // `env: {...}` only, never merged with process.env: that is the point of the
  // command, and a leaked host key would silently invalidate these tests.
  return await execFileAsync("/bin/sh", ["-c", command], { env });
}

async function makeHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "gemini-auth-selector-"));
}

async function readSettings(home: string): Promise<string | null> {
  return await fs
    .readFile(path.join(home, ".gemini", "settings.json"), "utf8")
    .catch(() => null);
}

describe("buildGeminiAuthSelectorCommand", () => {
  it("writes the selector when GEMINI_API_KEY is set in the target environment", async () => {
    const home = await makeHome();
    await runInShell(buildGeminiAuthSelectorCommand(home), { GEMINI_API_KEY: "AIza-in-target" });

    const raw = await readSettings(home);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      selectedAuthType: "gemini-api-key",
      security: { auth: { selectedType: "gemini-api-key" } },
    });
  });

  it("writes the selector when only GOOGLE_API_KEY is set", async () => {
    const home = await makeHome();
    await runInShell(buildGeminiAuthSelectorCommand(home), { GOOGLE_API_KEY: "AIza-in-target" });

    expect(await readSettings(home)).not.toBeNull();
  });

  it("writes no selector when neither key is set in the target environment", async () => {
    const home = await makeHome();
    await runInShell(buildGeminiAuthSelectorCommand(home), {});

    expect(await readSettings(home)).toBeNull();
  });

  it("writes no selector when the keys are set but empty", async () => {
    const home = await makeHome();
    await runInShell(buildGeminiAuthSelectorCommand(home), {
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
    });

    expect(await readSettings(home)).toBeNull();
  });

  it("never writes key bytes into the settings file", async () => {
    const home = await makeHome();
    const secret = "AIza-secret-value-SENTINEL";
    await runInShell(buildGeminiAuthSelectorCommand(home), { GEMINI_API_KEY: secret });

    expect(await readSettings(home)).not.toContain(secret);
  });

  it("leaves an existing settings.json untouched", async () => {
    const home = await makeHome();
    await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
    const userSettings = '{"selectedAuthType":"oauth-personal"}';
    await fs.writeFile(path.join(home, ".gemini", "settings.json"), userSettings, "utf8");

    await runInShell(buildGeminiAuthSelectorCommand(home), { GEMINI_API_KEY: "AIza-in-target" });

    expect(await readSettings(home)).toBe(userSettings);
  });

  it("succeeds rather than failing the run when no credential is present", async () => {
    const home = await makeHome();
    await expect(runInShell(buildGeminiAuthSelectorCommand(home), {})).resolves.toBeDefined();
  });

  it("creates the .gemini directory when the managed home is empty", async () => {
    const home = await makeHome();
    await runInShell(buildGeminiAuthSelectorCommand(home), { GEMINI_API_KEY: "AIza-in-target" });

    await expect(fs.stat(path.join(home, ".gemini"))).resolves.toBeDefined();
  });
});
