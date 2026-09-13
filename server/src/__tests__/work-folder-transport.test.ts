import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { workFolderTransport } from "../services/work-folder-transport.js";
import { localTestWorkFolderRunner } from "./helpers/work-folder-runner.js";

const exec = promisify(execFile);
describe("sandbox work folder transport with real Node and Git", () => {
  const roots: string[] = [];
  const transport = workFolderTransport(localTestWorkFolderRunner);
  async function root() {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "work-folder-io-")));
    roots.push(dir); return dir;
  }
  afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
  it("streams and atomically publishes files larger than a transfer chunk", async () => {
    const dir = await root();
    const staging = await root();
    const body = Buffer.alloc(700_000, "x");
    const entry = { path: "nested/file", kind: "file" as const, byteSize: body.length,
      sha256: createHash("sha256").update(body).digest("hex"), executable: true };
    const boundedTransport = workFolderTransport({ async execute(input) {
      // macOS permits larger argv entries than Linux; enforce the deployment
      // bound here as well so this regression is caught on developer machines.
      expect(Buffer.byteLength([input.command, ...(input.args ?? [])].join(" "))).toBeLessThan(120 * 1024);
      return localTestWorkFolderRunner.execute(input);
    } });
    await boundedTransport.write(dir, staging, entry, Readable.from([body]));
    expect(await readFile(path.join(dir, entry.path))).toEqual(body);
    const files = await transport.scan(dir);
    expect(files.find((file) => file.path === entry.path)).toEqual(entry);
  });
  it("rejects links out of a work folder on scan and download", async () => {
    const dir = await root();
    const outside = await root();
    await writeFile(path.join(outside, "credential"), "private");
    await symlink(path.join(outside, "credential"), path.join(dir, "link"));
    await expect(transport.scan(dir)).rejects.toThrow("symlink_not_allowed");
    const stream = transport.read(dir, "link", 7);
    await expect((async () => { for await (const _chunk of stream) { /* consume */ } })()).rejects.toThrow("symlink_not_allowed");
  });
  it("includes uncommitted tracked and nonignored files plus Git state, excluding credentials and caches", async () => {
    const dir = await root();
    await exec("git", ["init", dir]);
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(dir, "tracked"), "initial");
    await exec("git", ["-C", dir, "add", "."]);
    await exec("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
    await writeFile(path.join(dir, "tracked"), "unstaged");
    await writeFile(path.join(dir, "untracked"), "new");
    await mkdir(path.join(dir, "node_modules"));
    await writeFile(path.join(dir, "node_modules/cache"), "ignored");
    const paths = (await transport.scan(dir, true)).map((entry) => entry.path);
    expect(paths).toContain("tracked");
    expect(paths).toContain("untracked");
    expect(paths).toContain(".git/index");
    expect(paths).toContain(".git/HEAD");
    expect(paths).not.toContain(".git/config");
    expect(paths.some((entry) => entry.startsWith("node_modules/"))).toBe(false);
  });
});
