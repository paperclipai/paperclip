import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ mkdir: undefined as undefined | ((path: string) => void), rename: undefined as undefined | ((source: string, destination: string) => void), open: undefined as undefined | ((path: string) => void), read: undefined as undefined | ((path: string, bytes: number) => void) }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => { hooks.mkdir?.(String(args[0])); return fs.mkdir(...args); },
    rename: async (...args: Parameters<typeof fs.rename>) => { hooks.rename?.(String(args[0]), String(args[1])); return fs.rename(...args); },
    open: async (...args: Parameters<typeof fs.open>) => { hooks.open?.(String(args[0])); const file = await fs.open(...args); const read = file.read.bind(file); file.read = (async (...readArgs: any[]) => { const result = await (read as any)(...readArgs); hooks.read?.(String(args[0]), result.bytesRead); return result; }) as typeof file.read; return file; },
  };
});
vi.mock("../vendor/paperclip-runner/index.js", async () => await import("../../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js"));
import { QUALIFIED_ACPX_PROFILES } from "../../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { createRemotePiCompanionManifest, importRemotePiCompanion, inventoryRemoteCompanion, resolveRemotePiCompanion, selectRemotePiCompanion } from "../services/native-runtime/remote-pi-companion.js";
const roots: string[] = [];
afterEach(() => { hooks.mkdir = undefined; hooks.rename = undefined; hooks.open = undefined; hooks.read = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-companion-"))); roots.push(root);
  const source = "a".repeat(40); const serverRoot = join(root, "server"); const directory = join(root, "release");
  mkdirSync(join(serverRoot, "dist"), { recursive: true }); writeFileSync(join(serverRoot, "package.json"), '{"name":"@paperclipai/server"}'); writeFileSync(join(serverRoot, "dist/build-info.json"), JSON.stringify({ commit: source }));
  mkdirSync(join(directory, "bin"), { recursive: true }); mkdirSync(join(directory, "provider-pack"));
  // Synthetic ELF header; these tests never launch it or claim native qualification.
  const elf = Buffer.alloc(128); Buffer.from([127, 69, 76, 70, 2, 1]).copy(elf); elf.writeUInt16LE(62, 18); writeFileSync(join(directory, "bin/paperclip-runnerd"), elf, { mode: 0o755 });
  const payload = { runnerSourceRevision: source, target: { platform: "linux", architecture: "x64" }, candidateProviders: { pi: { qualification: "qualified", profileDigest: QUALIFIED_ACPX_PROFILES.pi.commandDigest, path: "provider-assets/pi/linux-x64" } } };
  writeFileSync(join(directory, "provider-pack/provider-pack.json"), JSON.stringify({ schema: "paperclip-runner/remote-provider-pack/v1", digest: `sha256:${hash(canonical(payload))}`, payload }));
  const manifest = await createRemotePiCompanionManifest(directory, source); const bytes = JSON.stringify(manifest); writeFileSync(join(directory, "companion.json"), bytes); return { root, directory, serverRoot, sha256: hash(bytes), manifest, source };
}
it("imports the release-generated closure and resolves target bytes without environment overrides", async () => {
  const f = await fixture(); const result = await importRemotePiCompanion(f); expect(result.status).toBe("imported_verified");
  expect(result.runnerBinary).toBe(join(f.serverRoot, "remote-companions/linux-x64/bin/paperclip-runnerd"));
  expect(readFileSync(result.runnerBinary!)).toEqual(readFileSync(join(f.directory, "bin/paperclip-runnerd")));
  expect((await importRemotePiCompanion(f)).status).toBe("verified_existing"); expect((await resolveRemotePiCompanion({ serverRoot: f.serverRoot }))?.manifestSha256).toBe(f.sha256);
  expect(readdirSync(join(f.serverRoot, "remote-companions"))).toEqual(["linux-x64"]);
});
it.each(["sha", "source", "profile", "target", "daemon", "extra", "mode", "outside-link", "outside-hardlink", "pack"])("rejects %s before publishing", async kind => {
  const f = await fixture();
  if (kind === "sha") f.sha256 = "b".repeat(64);
  if (kind === "source") writeFileSync(join(f.serverRoot, "dist/build-info.json"), JSON.stringify({ commit: "b".repeat(40) }));
  if (kind === "profile" || kind === "target") { Object.assign(f.manifest, kind === "profile" ? { profileDigest: "sha256:" + "b".repeat(64) } : { target: "darwin-arm64" }); const bytes = JSON.stringify(f.manifest); writeFileSync(join(f.directory, "companion.json"), bytes); f.sha256 = hash(bytes); }
  if (kind === "daemon") writeFileSync(join(f.directory, "bin/paperclip-runnerd"), "changed");
  if (kind === "extra") writeFileSync(join(f.directory, "extra"), "unlisted");
  if (kind === "mode") chmodSync(join(f.directory, "bin/paperclip-runnerd"), 0o777);
  if (kind === "outside-link") symlinkSync("../../server/package.json", join(f.directory, "provider-pack/escape"));
  if (kind === "outside-hardlink") linkSync(join(f.directory, "bin/paperclip-runnerd"), join(f.root, "alias"));
  if (kind === "pack") writeFileSync(join(f.directory, "provider-pack/provider-pack.json"), "{}");
  await expect(importRemotePiCompanion(f)).rejects.toThrow(); expect(() => readdirSync(join(f.serverRoot, "remote-companions/linux-x64"))).toThrow();
});
it("copies contained symlinks and breaks only fully owned internal hardlinks", async () => {
  const f = await fixture(); linkSync(join(f.directory, "bin/paperclip-runnerd"), join(f.directory, "bin/alias")); symlinkSync("paperclip-runnerd", join(f.directory, "bin/link"));
  f.manifest = await createRemotePiCompanionManifest(f.directory, f.source); const bytes = JSON.stringify(f.manifest); writeFileSync(join(f.directory, "companion.json"), bytes); f.sha256 = hash(bytes);
  expect((await importRemotePiCompanion(f)).status).toBe("imported_verified");
});
it("fails closed on cache corruption, foreign authority and workspace-contained cache", async () => {
  const f = await fixture(); const result = await importRemotePiCompanion(f);
  await expect(resolveRemotePiCompanion({ serverRoot: f.serverRoot, workspaceRoot: f.root })).rejects.toThrow("workspace");
  await expect(resolveRemotePiCompanion({ serverRoot: f.serverRoot, workspaceRoot: join(result.root!, "provider-pack") })).rejects.toThrow("workspace");
  writeFileSync(result.runnerBinary!, "corrupted"); await expect(resolveRemotePiCompanion({ serverRoot: f.serverRoot })).rejects.toThrow("inventory");
  await expect(importRemotePiCompanion(f)).rejects.toThrow();
});
it("preserves an existing empty destination and releases only its import lock", async () => {
  const f = await fixture(); mkdirSync(join(f.serverRoot, "remote-companions/linux-x64"), { recursive: true, mode: 0o700 }); chmodSync(join(f.serverRoot, "remote-companions"), 0o700);
  await expect(importRemotePiCompanion(f)).rejects.toThrow(); expect(readdirSync(join(f.serverRoot, "remote-companions/linux-x64"))).toEqual([]); expect(readdirSync(join(f.serverRoot, "remote-companions"))).toEqual(["linux-x64"]);
});
it("rejects an unsafe cache parent and leaves it intact", async () => {
  const f = await fixture(); const outside = join(f.root, "outside"); mkdirSync(outside); symlinkSync(outside, join(f.serverRoot, "remote-companions"));
  await expect(importRemotePiCompanion(f)).rejects.toThrow(); expect(readdirSync(outside)).toEqual([]);
});
it("reports missing installation without manufacturing a companion", async () => { const f = await fixture(); expect(await resolveRemotePiCompanion({ serverRoot: f.serverRoot })).toBeNull(); });

it("selects only normal remote Pi, preserving explicit overrides and C/C admission", async () => {
  const f = await fixture(); await importRemotePiCompanion(f); const workspaceRoot = join(f.root, "workspace"); mkdirSync(workspaceRoot);
  const input = { serverRoot: f.serverRoot, workspaceRoot, remote: true, provider: { kind: "acpx", agent: "pi" } };
  expect((await selectRemotePiCompanion(input))?.target).toBe("linux-x64");
  for (const patch of [{ remote: false }, { provider: { kind: "acpx", agent: "cursor" } }, { provider: { kind: "acpx", agent: "copilot" } }, { provider: { kind: "codex" } }, { binaryOverride: "/operator/runnerd" }, { packOverride: "/operator/pack" }]) expect(await selectRemotePiCompanion({ ...input, ...patch })).toBeNull();
});

it("rejects an appeared empty destination without replacing it", async () => {
  const f = await fixture(); const output = join(f.serverRoot, "remote-companions/linux-x64");
  hooks.mkdir = path => { if (path !== output) return; hooks.mkdir = undefined; mkdirSync(output, { mode: 0o700 }); };
  await expect(importRemotePiCompanion(f)).rejects.toThrow(); expect(readdirSync(output)).toEqual([]);
  expect(readdirSync(join(f.serverRoot, "remote-companions"))).toEqual(["linux-x64"]);
});
it("drains owned output, staging and lock cleanup after publication failure", async () => {
  const f = await fixture(); hooks.rename = () => { hooks.rename = undefined; throw new Error("injected publication failure"); };
  await expect(importRemotePiCompanion(f)).rejects.toThrow("injected publication failure");
  expect(readdirSync(join(f.serverRoot, "remote-companions"))).toEqual([]);
});
it("preserves a replaced staging root while draining the other owned cleanup", async () => {
  const f = await fixture(); let replaced = "";
  hooks.rename = source => {
    hooks.rename = undefined; replaced = source.slice(0, source.lastIndexOf("/"));
    renameSync(replaced, replaced + "-original"); mkdirSync(replaced, { mode: 0o700 }); writeFileSync(join(replaced, "foreign"), "preserve");
    throw new Error("replaced staging");
  };
  await expect(importRemotePiCompanion(f)).rejects.toThrow("cleanup incomplete"); expect(readFileSync(join(replaced, "foreign"), "utf8")).toBe("preserve");
  expect(readdirSync(join(f.serverRoot, "remote-companions"))).not.toContain(".import-linux-x64.lock");
  expect(readdirSync(join(f.serverRoot, "remote-companions"))).not.toContain("linux-x64");
});
it.each(["new", "existing"])("defers actual SIGTERM on the %s import path and drains owned cleanup", async (mode) => {
  const f = await fixture(); if (mode === "existing") await importRemotePiCompanion(f);
  const { build } = await import("esbuild");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const bundle = join(f.root, "companion.mjs");
  await build({ entryPoints: [new URL("../services/native-runtime/remote-pi-companion.ts", import.meta.url).pathname], outfile: bundle,
    platform: "node", format: "esm", target: "node24", bundle: true, logLevel: "silent",
    plugins: [{ name: "source-owned-profile-only", setup(builder) {
      builder.onResolve({ filter: /vendor\/paperclip-runner\/index\.js$/ }, () => ({ path: new URL("../../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.ts", import.meta.url).pathname }));
    } }],
  });
  const script = join(f.root, "cancel.mjs");
  writeFileSync(script, `import {importRemotePiCompanion} from './companion.mjs';
import {readdirSync,existsSync} from 'node:fs';
let cancelled=false, checkpoints=0,sent=false; const cancel=()=>{cancelled=true}; process.on('SIGTERM',cancel);
try { await importRemotePiCompanion({...JSON.parse(process.argv[2]),checkCancelled(){ checkpoints++; if(!sent&&existsSync(process.argv[3]+'/.import-linux-x64.lock')){sent=true;process.kill(process.pid,'SIGTERM');} if(cancelled)throw Error('owned cancellation'); }}); throw Error('unexpected success'); }
catch(error){ if(error.message!=='owned cancellation')throw error; console.log(JSON.stringify({cancelled,checkpoints,remaining:readdirSync(process.argv[3])})); }
finally {process.off('SIGTERM',cancel);}
`);
  const { stdout } = await promisify(execFile)(process.execPath, [script, JSON.stringify({ directory: f.directory, sha256: f.sha256, serverRoot: f.serverRoot }), join(f.serverRoot, "remote-companions")], { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, timeout: 10_000, maxBuffer: 65536 });
  expect(JSON.parse(stdout)).toMatchObject({ cancelled: true, remaining: mode === "existing" ? ["linux-x64"] : [] });
});

it("honors deadline expiry after re-verifying an existing cache without deleting it", async () => {
  const f = await fixture(); await importRemotePiCompanion(f); let expired = false;
  hooks.open = path => { if(path === join(f.serverRoot, "remote-companions/linux-x64/companion.json")) expired = true; };
  vi.spyOn(Date, "now").mockImplementation(() => expired ? 600_001 : 0);
  await expect(importRemotePiCompanion(f)).rejects.toThrow("deadline exceeded");
  expect(readdirSync(join(f.serverRoot, "remote-companions"))).toEqual(["linux-x64"]);
});

async function largeFixture() {
  const f = await fixture(); writeFileSync(join(f.directory, "provider-pack/large"), Buffer.alloc(8 * 1024 ** 2, 0x61));
  f.manifest = await createRemotePiCompanionManifest(f.directory, f.source);
  const bytes = JSON.stringify(f.manifest); writeFileSync(join(f.directory, "companion.json"), bytes); f.sha256 = hash(bytes); return f;
}
it("yields to unrelated event-loop work between chunks of a real cache file", async () => {
  const f = await largeFixture(); await importRemotePiCompanion(f);
  const file = join(f.serverRoot, "remote-companions/linux-x64/provider-pack/large");
  let reads = 0; let serviced = false; let servicedBeforeNextRead = false;
  hooks.read = (path, bytes) => { if(path !== file || !bytes) return; reads++; if(reads === 1) setImmediate(() => { serviced = true; }); else servicedBeforeNextRead ||= serviced; };
  expect((await resolveRemotePiCompanion({serverRoot:f.serverRoot}))?.manifestSha256).toBe(f.sha256);
  expect(reads).toBeGreaterThanOrEqual(8); expect(servicedBeforeNextRead).toBe(true);
});
it("cancels during a large existing-cache file before reading the whole file and preserves it", async () => {
  const f = await largeFixture(); await importRemotePiCompanion(f);
  const file = join(f.serverRoot, "remote-companions/linux-x64/provider-pack/large"); let readBytes = 0;
  hooks.read = (path, bytes) => { if(path === file) readBytes += bytes; };
  await expect(importRemotePiCompanion({...f, checkCancelled(){ if(readBytes) throw Error("cancel during cache bytes"); }})).rejects.toThrow("cancel during cache bytes");
  expect(readBytes).toBeGreaterThan(0); expect(readBytes).toBeLessThan(8 * 1024 ** 2);
  expect(readdirSync(join(f.serverRoot, "remote-companions"))).toEqual(["linux-x64"]);
});
it("rejects read-only directory modes before claiming a staging or output path", async () => {
  const f = await fixture(); const dir = join(f.directory, "provider-pack"); chmodSync(dir, 0o500);
  try {
    await expect(importRemotePiCompanion({...f, checkCancelled(){}})).rejects.toThrow("owner read/write/search");
    expect(() => readdirSync(join(f.serverRoot, "remote-companions"))).toThrow();
  } finally { chmodSync(dir, 0o755); }
});
