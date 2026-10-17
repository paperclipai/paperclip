import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as envFiles from "@paperclipai/shared/env-file";
import { ensureLocalTrustedAgentJwtSecret } from "../agent-jwt-bootstrap.js";

describe("local agent JWT bootstrap", () => {
  let directory: string;
  let envFilePath: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "paperclip-agent-jwt-"));
    envFilePath = path.join(directory, "instance", ".env");
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it.each(["PAPERCLIP_AGENT_JWT_SECRET", "BETTER_AUTH_SECRET"])("reuses %s without touching the filesystem", async key => {
    const env = { [key]: "existing-signing-secret" };
    expect(await ensureLocalTrustedAgentJwtSecret(envFilePath, env)).toMatchObject({ source: "process_env" });
    expect(env[key]).toBe("existing-signing-secret");
    expect(() => statSync(path.dirname(envFilePath))).toThrow();
  });

  it("persists a private secret before using it and reuses it after restart", async () => {
    const first: NodeJS.ProcessEnv = {};
    expect(await ensureLocalTrustedAgentJwtSecret(envFilePath, first)).toMatchObject({ source: "generated" });
    expect(first.PAPERCLIP_AGENT_JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    const contents = readFileSync(envFilePath, "utf8");
    expect(contents).toContain(first.PAPERCLIP_AGENT_JWT_SECRET);
    if (process.platform !== "win32") expect(statSync(envFilePath).mode & 0o777).toBe(0o600);
    const second: NodeJS.ProcessEnv = {};
    expect(await ensureLocalTrustedAgentJwtSecret(envFilePath, second)).toMatchObject({ source: "env_file" });
    expect(second).toEqual(first);
    expect(readFileSync(envFilePath, "utf8")).toBe(contents);
  });

  it("preserves operator entries, comments and CRLF when adding a secret", async () => {
    mkdirSync(path.dirname(envFilePath));
    const original = "# operator settings\r\nDATABASE_URL='postgres://example/db'\r\nUNKNOWN=keep\r\n";
    writeFileSync(envFilePath, original);
    await ensureLocalTrustedAgentJwtSecret(envFilePath, {});
    const contents = readFileSync(envFilePath, "utf8");
    expect(contents).toContain(original);
    expect(contents.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it.each(["PAPERCLIP_AGENT_JWT_SECRET", "BETTER_AUTH_SECRET"])("loads existing %s from the instance env file", async key => {
    mkdirSync(path.dirname(envFilePath));
    const original = `export ${key} = 'existing-file-secret' # keep this\n`;
    writeFileSync(envFilePath, original);
    const env: NodeJS.ProcessEnv = {};
    expect(await ensureLocalTrustedAgentJwtSecret(envFilePath, env)).toMatchObject({ source: "env_file" });
    expect(env[key]).toBe("existing-file-secret");
    expect(readFileSync(envFilePath, "utf8")).toBe(original);
  });

  it("makes concurrent initializers use the same persisted secret", async () => {
    const environments: NodeJS.ProcessEnv[] = Array.from({ length: 4 }, () => ({}));
    await Promise.all(environments.map(env => ensureLocalTrustedAgentJwtSecret(envFilePath, env)));
    expect(new Set(environments.map(env => env.PAPERCLIP_AGENT_JWT_SECRET)).size).toBe(1);
    expect(readFileSync(envFilePath, "utf8").match(/^PAPERCLIP_AGENT_JWT_SECRET=/gm)).toHaveLength(1);
    expect(() => statSync(`${envFilePath}.agent-jwt-bootstrap`)).toThrow();
  });

  it("shares one secret across concurrent server processes", async () => {
    const bootstrapUrl = new URL("../agent-jwt-bootstrap.ts", import.meta.url).href;
    const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const script = `import { createHash } from 'node:crypto';
      const { ensureLocalTrustedAgentJwtSecret } = await import(${JSON.stringify(bootstrapUrl)});
      const env = {}; await ensureLocalTrustedAgentJwtSecret(process.argv[1], env);
      console.log(createHash('sha256').update(env.PAPERCLIP_AGENT_JWT_SECRET).digest('hex'));`;
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", script, envFilePath]),
    ));
    expect(new Set(results.map(result => result.stdout.trim())).size).toBe(1);
    expect(readFileSync(envFilePath, "utf8").match(/^PAPERCLIP_AGENT_JWT_SECRET=/gm)).toHaveLength(1);
  });

  it("does not enable an ephemeral secret when persistence fails", async () => {
    mkdirSync(envFilePath, { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    await expect(ensureLocalTrustedAgentJwtSecret(envFilePath, env)).rejects.toThrow(/agent JWT signing secret/i);
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
  });

  it("retries a failed env write without enabling or replacing the pending secret", async () => {
    const write = vi.spyOn(envFiles, "writeEnvFileAtomicallyIfChanged").mockImplementationOnce(() => {
      throw new Error("fixture read-only filesystem");
    });
    const env: NodeJS.ProcessEnv = {};
    try {
      await expect(ensureLocalTrustedAgentJwtSecret(envFilePath, env)).rejects.toThrow("Cannot initialize");
      expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
      expect(() => statSync(envFilePath)).toThrow();
    } finally { write.mockRestore(); }
    const pending = readFileSync(`${envFilePath}.agent-jwt-bootstrap`, "utf8");
    await ensureLocalTrustedAgentJwtSecret(envFilePath, env);
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBe(pending);
  });

  it("reuses a complete candidate left by an interrupted initializer", async () => {
    mkdirSync(path.dirname(envFilePath));
    const interruptedSecret = "ab".repeat(32);
    writeFileSync(`${envFilePath}.agent-jwt-bootstrap`, interruptedSecret, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    await ensureLocalTrustedAgentJwtSecret(envFilePath, env);
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBe(interruptedSecret);
  });
});
