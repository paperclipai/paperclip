import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stripEmptyStringEnvVars } from "../config.js";

describe("stripEmptyStringEnvVars", () => {
  it("removes empty-string values from the passed env", () => {
    const env: NodeJS.ProcessEnv = {
      REAL: "value",
      EMPTY: "",
      ALSO_REAL: "x",
      ALSO_EMPTY: "",
    };
    stripEmptyStringEnvVars(env);
    expect(env).toEqual({ REAL: "value", ALSO_REAL: "x" });
  });

  it("leaves undefined entries alone (already unset)", () => {
    const env: NodeJS.ProcessEnv = { A: "1", B: undefined };
    stripEmptyStringEnvVars(env);
    expect(env).toEqual({ A: "1", B: undefined });
  });

  it("is a no-op when nothing is empty", () => {
    const env: NodeJS.ProcessEnv = { A: "1", B: "2" };
    stripEmptyStringEnvVars(env);
    expect(env).toEqual({ A: "1", B: "2" });
  });

  it("defaults to process.env when no argument given", () => {
    const PROBE_KEY = "PAPERCLIP_CONFIG_ENV_LOAD_PROBE__";
    process.env[PROBE_KEY] = "";
    try {
      stripEmptyStringEnvVars();
      expect(process.env[PROBE_KEY]).toBeUndefined();
    } finally {
      delete process.env[PROBE_KEY];
    }
  });
});

/**
 * End-to-end verification: spawn a fresh node process with an empty-string
 * ANTHROPIC_API_KEY in the inherited env, point it at a .env file containing
 * a real value, import config.ts, and assert process.env now has the real
 * value. This is the exact scenario that caused production 401s: a polluted
 * shell env blocking dotenv's real value.
 */
describe("config.ts module-level env load", () => {
  it("lets .env override a polluted empty-string parent env var", () => {
    const tmp = mkdtempSync(join(tmpdir(), "paperclip-env-load-"));
    try {
      writeFileSync(
        join(tmp, ".env"),
        "ANTHROPIC_API_KEY=real-value-from-dotenv\n",
      );

      // Write the probe as a script file (top-level await in `-e` isn't
      // supported with esbuild's CJS transform). The script imports config.ts
      // to trigger the module-level strip/load, then prints the resolved key.
      const probePath = join(tmp, "probe.mjs");
      const configUrl = new URL("../config.ts", import.meta.url).toString();
      writeFileSync(
        probePath,
        [
          `process.chdir(${JSON.stringify(tmp)});`,
          `import(${JSON.stringify(configUrl)}).then(() => {`,
          `  console.log("RESULT:" + (process.env.ANTHROPIC_API_KEY ?? "<unset>"));`,
          `}).catch((e) => { console.error("IMPORT_FAIL:" + e.message); process.exit(2); });`,
        ].join("\n"),
      );

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          new URL(
            "../../node_modules/tsx/dist/loader.mjs",
            import.meta.url,
          ).pathname,
          probePath,
        ],
        {
          cwd: tmp,
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: "",
            HOME: tmp,
            PAPERCLIP_HOME: tmp,
          },
          encoding: "utf8",
        },
      );

      if (result.status !== 0) {
        throw new Error(
          `subprocess failed (status=${result.status}):\n` +
            `stdout=${result.stdout}\nstderr=${result.stderr}`,
        );
      }
      const match = (result.stdout ?? "").match(/RESULT:(.*)/);
      expect(match, `no RESULT in output: ${result.stdout}`).toBeTruthy();
      expect(match![1].trim()).toBe("real-value-from-dotenv");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
