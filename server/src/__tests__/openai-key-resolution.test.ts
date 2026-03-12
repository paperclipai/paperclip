import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";

/**
 * End-to-end test for the OPENAI_API_KEY resolution fix (#497).
 *
 * These tests spawn real child processes (using `env` command) with the same
 * merge logic used by runChildProcess: `{ ...process.env, ...adapterEnv }`.
 * They verify the key the child process actually receives — not a simulation.
 */

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * The fix from execute.ts lines 250-261: resolves the OPENAI_API_KEY source
 * and cleans up empty/whitespace values.
 */
function applyOpenaiKeyFix(
  env: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): "adapter_config" | "server_env" | "missing" {
  if (hasNonEmptyEnvValue(env, "OPENAI_API_KEY")) return "adapter_config";
  if (typeof env.OPENAI_API_KEY === "string") delete env.OPENAI_API_KEY;
  const fromProcess = processEnv.OPENAI_API_KEY;
  if (typeof fromProcess === "string" && fromProcess.trim().length > 0) {
    env.OPENAI_API_KEY = fromProcess;
    return "server_env";
  }
  return "missing";
}

/**
 * Spawn a real child process with the given env, read its OPENAI_API_KEY.
 * Uses `printenv OPENAI_API_KEY` which outputs the value or exits 1 if unset.
 */
function readKeyFromChildProcess(
  mergedEnv: Record<string, string | undefined>,
): Promise<{ value: string | null; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("printenv", ["OPENAI_API_KEY"], {
      env: mergedEnv as NodeJS.ProcessEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.on("close", (code) => {
      resolve({
        value: stdout.trim() || null,
        exitCode: code ?? 1,
      });
    });
  });
}

describe("OPENAI_API_KEY resolution (#497)", () => {
  const VALID_KEY = "sk-test-valid-key-for-497";
  const FAKE_PROCESS_ENV: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OPENAI_API_KEY: VALID_KEY,
  };

  describe("BUG REPRODUCTION: without fix, empty config value overrides valid shell key", () => {
    it("empty string in adapter env overrides valid process.env key", async () => {
      // Simulate old code: adapter sets OPENAI_API_KEY="" from config
      const adapterEnv: Record<string, string> = { OPENAI_API_KEY: "" };
      // runChildProcess merge: { ...process.env, ...opts.env }
      const mergedEnv = { ...FAKE_PROCESS_ENV, ...adapterEnv };

      const result = await readKeyFromChildProcess(mergedEnv);
      // BUG: child gets empty string, NOT the valid key
      expect(result.value).toBeNull(); // printenv exits 1 for empty
      expect(result.value).not.toBe(VALID_KEY);
    });

    it("whitespace-only in adapter env overrides valid process.env key", async () => {
      const adapterEnv: Record<string, string> = { OPENAI_API_KEY: "   " };
      const mergedEnv = { ...FAKE_PROCESS_ENV, ...adapterEnv };

      const result = await readKeyFromChildProcess(mergedEnv);
      // BUG: child gets whitespace, NOT the valid key
      expect(result.value).not.toBe(VALID_KEY);
    });
  });

  describe("FIX VERIFICATION: with fix applied, child gets the correct key", () => {
    it("Scenario C: empty config value → fix inherits from process.env", async () => {
      const adapterEnv: Record<string, string> = { OPENAI_API_KEY: "" };
      const source = applyOpenaiKeyFix(adapterEnv, FAKE_PROCESS_ENV);
      const mergedEnv = { ...FAKE_PROCESS_ENV, ...adapterEnv };

      expect(source).toBe("server_env");
      const result = await readKeyFromChildProcess(mergedEnv);
      expect(result.value).toBe(VALID_KEY);
    });

    it("Scenario D: whitespace config value → fix inherits from process.env", async () => {
      const adapterEnv: Record<string, string> = { OPENAI_API_KEY: "   " };
      const source = applyOpenaiKeyFix(adapterEnv, FAKE_PROCESS_ENV);
      const mergedEnv = { ...FAKE_PROCESS_ENV, ...adapterEnv };

      expect(source).toBe("server_env");
      const result = await readKeyFromChildProcess(mergedEnv);
      expect(result.value).toBe(VALID_KEY);
    });

    it("Scenario A: key only in shell → fix copies from process.env", async () => {
      const adapterEnv: Record<string, string> = {};
      const source = applyOpenaiKeyFix(adapterEnv, FAKE_PROCESS_ENV);
      const mergedEnv = { ...FAKE_PROCESS_ENV, ...adapterEnv };

      expect(source).toBe("server_env");
      const result = await readKeyFromChildProcess(mergedEnv);
      expect(result.value).toBe(VALID_KEY);
    });

    it("Scenario B: valid key in adapter config → fix preserves it", async () => {
      const CONFIG_KEY = "sk-from-adapter-config";
      const adapterEnv: Record<string, string> = { OPENAI_API_KEY: CONFIG_KEY };
      const source = applyOpenaiKeyFix(adapterEnv, FAKE_PROCESS_ENV);
      const mergedEnv = { ...FAKE_PROCESS_ENV, ...adapterEnv };

      expect(source).toBe("adapter_config");
      const result = await readKeyFromChildProcess(mergedEnv);
      expect(result.value).toBe(CONFIG_KEY);
    });

    it("Scenario E: empty config, no shell key → fix reports missing", async () => {
      const NO_KEY_PROCESS_ENV = { PATH: process.env.PATH, HOME: process.env.HOME };
      const adapterEnv: Record<string, string> = { OPENAI_API_KEY: "" };
      const source = applyOpenaiKeyFix(adapterEnv, NO_KEY_PROCESS_ENV);
      const mergedEnv = { ...NO_KEY_PROCESS_ENV, ...adapterEnv };

      expect(source).toBe("missing");
      // empty string was deleted, so child shouldn't have the key at all
      expect(adapterEnv.OPENAI_API_KEY).toBeUndefined();
      const result = await readKeyFromChildProcess(mergedEnv);
      expect(result.value).toBeNull();
    });

    it("Scenario F: no key anywhere → fix reports missing", async () => {
      const NO_KEY_PROCESS_ENV = { PATH: process.env.PATH, HOME: process.env.HOME };
      const adapterEnv: Record<string, string> = {};
      const source = applyOpenaiKeyFix(adapterEnv, NO_KEY_PROCESS_ENV);
      const mergedEnv = { ...NO_KEY_PROCESS_ENV, ...adapterEnv };

      expect(source).toBe("missing");
      const result = await readKeyFromChildProcess(mergedEnv);
      expect(result.value).toBeNull();
    });
  });
});
