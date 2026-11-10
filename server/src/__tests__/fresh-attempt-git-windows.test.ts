import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { materializeFreshWorkspaceSeed } from "../services/fresh-workspace-seed.js";
import { materializeManagedProjectWorkspace } from "../services/managed-repository-checkout.js";

const execFile = promisify(execFileCallback);
let home: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (home) {
    if (path.dirname(home) !== path.parse(tmpdir()).root || !path.basename(home).startsWith("pc-")) throw new Error("Unexpected test directory");
    await rm(home, { recursive: true, force: true });
  }
});
it.skipIf(process.platform !== "win32")("clones and fetches a nested repository inside a fresh isolated attempt", async () => {
  home = await mkdtemp(path.join(path.parse(tmpdir()).root, "pc-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  const source = path.join(home, "source");
  await mkdir(source);
  await execFile("git", ["init", "--initial-branch=main", source]);
  await writeFile(path.join(source, "marker.txt"), "preserve files\n");
  const longFile = path.join("components-".repeat(5), "nested-component-".repeat(5), "long".repeat(40));
  await mkdir(path.dirname(path.join(source, longFile)), { recursive: true });
  await writeFile(path.join(source, longFile), "long tracked file\n");
  await execFile("git", ["-C", source, "config", "core.longpaths", "true"]);
  await execFile("git", ["-C", source, "add", "."]);
  await execFile("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
  await execFile("git", ["-C", source, "update-server-info"]);
  const gitRoot = path.join(source, ".git");
  const server = createServer(async (req, res) => {
    const file = path.resolve(gitRoot, `.${new URL(req.url!, "http://localhost").pathname}`);
    if (!file.startsWith(`${gitRoot}${path.sep}`)) { res.writeHead(403).end(); return; }
    try { res.end(await readFile(file)); } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const cwd = await materializeFreshWorkspaceSeed({ companyId: "10000000-0000-4000-8000-000000000001",
      issueId: "20000000-0000-4000-8000-000000000002", runId: "30000000-0000-4000-8000-000000000003", sourceCwd: source });
    const target = path.join(cwd, ".paperclip-repositories", "example-dataimport-microservice-with-a-long-name-fabaac24eddb");
    const port = (server.address() as { port: number }).port;
    await materializeManagedProjectWorkspace(target, { repoUrl: `http://127.0.0.1:${port}` });
    await execFile("git", ["-C", target, "fetch", "--no-tags", "origin"]);
    expect(await readFile(path.join(target, "marker.txt"), "utf8")).toBe("preserve files\n");
    expect(await readFile(path.join(cwd, longFile), "utf8")).toBe("long tracked file\n");
    expect(await readFile(path.join(target, longFile), "utf8")).toBe("long tracked file\n");
    expect(await materializeFreshWorkspaceSeed({ companyId: "10000000-0000-4000-8000-000000000001",
      issueId: "20000000-0000-4000-8000-000000000002", runId: "30000000-0000-4000-8000-000000000003", sourceCwd: source })).toBe(cwd);
    expect(await readFile(path.join(source, "marker.txt"), "utf8")).toBe("preserve files\n");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 60000);
