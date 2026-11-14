import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpxPackageJsonResolver } from "./installation-integrity.js";
import { resolveInstalledProviderAuthority } from "./installed-provider-authority.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(name = "@paperclipai/server") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "installed-acpx-authority-")));
  roots.push(root);
  const directory = join(root, "dist/vendor/paperclip-runner/drivers/acpx");
  await mkdir(directory, { recursive: true });
  const module = join(directory, "installation-integrity.js");
  await writeFile(module, "export {};\n");
  const manifest = join(root, "package.json");
  await writeFile(manifest, JSON.stringify({ name }));
  return { root, module, manifest };
}
async function workspaceFixture(workspaceManifest: object, selfRooted: boolean) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "installed-acpx-workspace-")));
  roots.push(workspace);
  const server = join(workspace, "server");
  const directory = join(server, "dist/vendor/paperclip-runner/drivers/acpx");
  const bridge = join(workspace, "node_modules/.pnpm/@agentclientprotocol+claude-agent-acp@0.73.0/node_modules/@agentclientprotocol/claude-agent-acp");
  const scope = join(server, "node_modules/@agentclientprotocol");
  await Promise.all([directory, bridge, scope, ...(selfRooted ? [join(server, "node_modules/.pnpm")] : [])].map(path => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(join(directory, "installation-integrity.js"), "export {};\n"),
    writeFile(join(server, "package.json"), JSON.stringify({ name: "@paperclipai/server" })),
    writeFile(join(workspace, "package.json"), JSON.stringify(workspaceManifest)),
    writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - server\n"),
    writeFile(join(bridge, "package.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.73.0" })),
  ]);
  await symlink(bridge, join(scope, "claude-agent-acp"));
  return { workspace, server, module: join(directory, "installation-integrity.js"), manifest: join(server, "package.json"), bridge };
}

describe("installed provider authority", () => {
  it("derives the owning server only from the normal installed verifier layout", async () => {
    const f = await fixture();
    expect(resolveInstalledProviderAuthority(pathToFileURL(f.module).href)).toEqual({ root: f.root, manifest: f.manifest });
    expect(resolveInstalledProviderAuthority(pathToFileURL(join(f.root, "src/drivers/acpx/installation-integrity.ts")).href)).toBeUndefined();
    expect(resolveInstalledProviderAuthority(pathToFileURL(join(f.root, "dist/drivers/acpx/installation-integrity.js")).href)).toBeUndefined();
  });

  it("binds a source-built server to its pnpm workspace store", async () => {
    const f = await workspaceFixture({ name: "paperclip", private: true }, false);
    const authority = resolveInstalledProviderAuthority(pathToFileURL(f.module).href);
    expect(authority).toEqual({ root: f.workspace, manifest: f.manifest });
    expect(createAcpxPackageJsonResolver(authority!.root, authority!.manifest)("@agentclientprotocol/claude-agent-acp"))
      .toBe(join(f.bridge, "package.json"));
  });

  it.each([
    [{ name: "paperclip", private: true }, true],
    [{ name: "paperclip" }, false],
    [{ name: "other-workspace", private: true }, false],
  ])("keeps the server authority outside a Paperclip source workspace (%j, self-rooted: %s)", async (workspaceManifest, selfRooted) => {
    const f = await workspaceFixture(workspaceManifest, selfRooted);
    const authority = resolveInstalledProviderAuthority(pathToFileURL(f.module).href);
    expect(authority).toEqual({ root: f.server, manifest: f.manifest });
    expect(() => createAcpxPackageJsonResolver(authority!.root, authority!.manifest)("@agentclientprotocol/claude-agent-acp"))
      .toThrow("outside the selected provider root");
  });

  it("rejects a substituted package owner", async () => {
    const f = await fixture("unrelated-package");
    expect(() => resolveInstalledProviderAuthority(pathToFileURL(f.module).href)).toThrow("owning server package");
  });

  it("rejects a symlinked manifest before adopting its declarations", async () => {
    const f = await fixture();
    const other = join(f.root, "other.json");
    await writeFile(other, JSON.stringify({ name: "@paperclipai/server" }));
    await rm(f.manifest);
    await symlink(other, f.manifest);
    expect(() => resolveInstalledProviderAuthority(pathToFileURL(f.module).href)).toThrow();
  });

  it("rejects a redirected verifier directory", async () => {
    const f = await fixture();
    const old = join(f.root, "dist/vendor/paperclip-runner/drivers/acpx");
    const other = join(f.root, "other");
    await mkdir(other);
    await writeFile(join(other, "installation-integrity.js"), "export {};\n");
    await rm(old, { recursive: true });
    await symlink(other, old);
    expect(() => resolveInstalledProviderAuthority(pathToFileURL(f.module).href)).toThrow("package layout");
  });

  it.each(["", " ".repeat(256 * 1024 + 1)])("rejects unbounded or empty owner metadata", async contents => {
    const f = await fixture();
    await writeFile(f.manifest, contents);
    expect(() => resolveInstalledProviderAuthority(pathToFileURL(f.module).href)).toThrow("bounded regular file");
  });
});
