import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { oracleSandboxProfile, runOracleCommand } from "./oracle-sandbox.js";
import { createFixtureRepository } from "./seed.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const temp = async (prefix: string) => { const directory = await mkdtemp(path.join(os.tmpdir(), prefix)); directories.push(directory); return directory; };

describe("oracle sandbox", () => {
  it("denies the protected roots and re-allows the workspace", () => {
    const profile = oracleSandboxProfile({ workspace: "/w", scratch: "/s", protectedRoots: ["/Users/me"] });
    expect(profile).toContain('(deny file-read* (subpath "/Users/me"))');
    expect(profile).toContain("(deny network*)");
    expect(profile.indexOf('(allow file-read* (subpath "/w")')).toBeGreaterThan(profile.indexOf("(deny file-read*"));
  });

  it("refuses to run unsandboxed on other platforms unless allowed", async () => {
    const result = await runOracleCommand(["true"], "/", { platform: "linux" });
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/refused/);
  });

  it.runIf(process.platform === "darwin")("keeps agent code away from protected files but runs the fixture tests", async () => {
    const secretRoot = await temp("restart-chaos-secret-");
    await writeFile(path.join(secretRoot, ".secrets"), "OPENAI_API_KEY=canary-value\n");
    const workspace = await temp("restart-chaos-ws-");
    await createFixtureRepository(workspace, 1);
    const leak = await runOracleCommand(["/bin/cat", path.join(secretRoot, ".secrets")], workspace, { protectedRoots: [secretRoot] });
    expect(leak.exitCode).not.toBe(0);
    expect(leak.stdout).not.toContain("canary-value");
    const greet = await runOracleCommand(["python3", "-m", "chaoscli", "greet", "chaos"], workspace, { protectedRoots: [secretRoot] });
    expect(greet).toMatchObject({ exitCode: 0 });
    expect(greet.stdout.trim()).toBe("hello, chaos");
  }, 60_000);
});
