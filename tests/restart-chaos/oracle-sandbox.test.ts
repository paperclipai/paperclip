import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("re-allows only the named files, such as the node executable, never a directory under a protected root", () => {
    const profile = oracleSandboxProfile({ workspace: "/w", scratch: "/s", protectedRoots: ["/Users/me"], readableFiles: ["/Users/me/bin/node"] });
    expect(profile.indexOf('(allow file-read* (literal "/Users/me/bin/node"))')).toBeGreaterThan(profile.indexOf('(deny file-read* (subpath "/Users/me"))'));
    expect(profile).not.toContain('(allow file-read* (subpath "/Users/me")');
    expect(profile).not.toContain('(allow file-read* (subpath "/Users/me/bin")');
  });

  it("refuses to run unsandboxed on other platforms unless allowed", async () => {
    const result = await runOracleCommand(["true"], "/", { platform: "linux" });
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/refused/);
  });

  it.runIf(process.platform === "darwin")("protects an instance root that contains the workspace, except the workspace itself", async () => {
    const instanceRoot = await temp("restart-chaos-instance-");
    await writeFile(path.join(instanceRoot, "master.key"), "canary-master-key\n");
    const workspace = path.join(instanceRoot, "fixtures", "chaos-sandbox");
    await createFixtureRepository(workspace, 1);
    const leak = await runOracleCommand(["/bin/cat", path.join(instanceRoot, "master.key")], workspace, { protectedRoots: [instanceRoot] });
    expect(leak.stdout).not.toContain("canary-master-key");
    const greet = await runOracleCommand(["python3", "-m", "chaoscli", "greet", "chaos"], workspace, { protectedRoots: [instanceRoot] });
    expect(greet.stdout.trim()).toBe("hello, chaos");
  }, 60_000);

  it.runIf(process.platform === "darwin")("lets node resolve modules in a workspace inside a protected root without exposing its contents", async () => {
    const instanceRoot = await temp("restart-chaos-instance-");
    await writeFile(path.join(instanceRoot, "master.key"), "canary-master-key\n");
    const workspace = path.join(instanceRoot, "fixtures", "workspace-repo");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "slug.ts"), "export const slug = (value: string): string => value.toLowerCase();\n");
    const run = await runOracleCommand([process.execPath, "--input-type=module", "-e", "import { slug } from \"./slug.ts\"; console.log(slug(\"OK\"));"],
      workspace, { protectedRoots: [instanceRoot], readableFiles: [process.execPath] });
    expect(run).toMatchObject({ exitCode: 0 });
    expect(run.stdout.trim()).toBe("ok");
    const leak = await runOracleCommand([process.execPath, "-e", `console.log(require("node:fs").readFileSync(${JSON.stringify(path.join(instanceRoot, "master.key"))}, "utf8"))`],
      workspace, { protectedRoots: [instanceRoot], readableFiles: [process.execPath] });
    expect(leak.stdout).not.toContain("canary-master-key");
    const listing = await runOracleCommand(["/bin/ls", instanceRoot], workspace, { protectedRoots: [instanceRoot] });
    expect(listing.stdout).not.toContain("master.key");
  }, 60_000);

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
