import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { gzipSync, zstdCompressSync } from "node:zlib";
import tar from "tar-stream";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalProviderPackJson } from "./remote-provider-pack-verification.js";
import { uploadVerifiedProviderPack } from "./provider-pack-upload.js";
import * as archiveOwner from "./provider-pack-archive.js";
import { resolveProviderPackUploadSource } from "./retained-provider-pack-source.js";
const archiveScript = pathToFileURL(path.resolve(import.meta.dirname, "../../../../scripts/create-provider-pack-archive.mjs")).href;
const { createProviderPackLayers } = await import(archiveScript);

const exec = promisify(execFile);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const actualFetch = globalThis.fetch;

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((done, reject) => {
    server.close(error => error ? reject(error) : done());
    server.closeAllConnections();
  })));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(options: { wrongCode?: boolean; unsafeOverlay?: boolean; changedFileLayer?: boolean; hardlink?: "safe" | "escape" | "unknown" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retained-pack-test-"));
  roots.push(root);
  const temporary = path.join(root, "tmp");
  await fs.mkdir(temporary);
  vi.stubEnv("TMPDIR", temporary);
  const makePack = async (name: string, tool: string, source: string) => {
    const pack = path.join(root, name);
    await fs.mkdir(path.join(pack, "bin"), { recursive: true });
    const artifact = { path: "bin/tool", sha256: `sha256:${hash(tool)}` };
    const payload = { pins: { opencode: "1.18.34" }, target: { platform: "linux", architecture: "x64" }, runnerSourceRevision: source,
      contractDigest: `sha256:${hash(tool)}`, artifacts: { nodeCommand: artifact, opencodeCommand: artifact, opencodeProxy: artifact } };
    const manifest = { schema: "paperclip-runner/remote-provider-pack/v1", payload, digest: `sha256:${hash(canonicalProviderPackJson(payload))}` };
    await fs.writeFile(path.join(pack, "provider-pack.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(pack, "bin/tool"), tool, { mode: 0o755 });
    await fs.writeFile(path.join(pack, "bin/large"), Buffer.alloc(1024 * 1024, 42), { mode: 0o755 });
    await createProviderPackLayers(pack);
    return { pack, manifest };
  };
  const selected = await makePack("old", "retained provider code", "a".repeat(40));
  const current = await makePack("current", "current incompatible code", "b".repeat(40));
  if (options.changedFileLayer) {
    const unsafe = tar.pack(), chunks: Buffer[] = [];
    const collected = (async () => { for await (const chunk of unsafe) chunks.push(Buffer.from(chunk)); })();
    const body = Buffer.alloc(1024 * 1024, 43);
    await new Promise<void>((done, reject) => unsafe.entry({ name: "bin/large", type: "file", size: body.length, mode: 0o755 }, body, error => error ? reject(error) : done()));
    unsafe.finalize(); await collected;
    const bytes = zstdCompressSync(Buffer.concat(chunks));
    await fs.writeFile(selected.pack + ".archives/0.tar.zst", bytes);
    const receipt = JSON.parse(await fs.readFile(selected.pack + ".archive.json", "utf8"));
    receipt.files[0].archive = { bytes: bytes.length, sha256: hash(bytes) };
    await fs.writeFile(selected.pack + ".archive.json", JSON.stringify(receipt));
  }
  if (options.unsafeOverlay || options.hardlink) {
    const unsafe = tar.pack(), chunks: Buffer[] = [];
    const collected = (async () => { for await (const chunk of unsafe) chunks.push(Buffer.from(chunk)); })();
    for (const [name, body] of [["provider-pack.json", JSON.stringify(selected.manifest)], ["bin/tool", "retained provider code"], ...(options.unsafeOverlay ? [["../outside", "must not be written"]] : [])]) {
      await new Promise<void>((done, reject) => unsafe.entry({ name: name!, type: "file", size: Buffer.byteLength(body!) }, body!, error => error ? reject(error) : done()));
    }
    if (options.hardlink) await new Promise<void>((done, reject) => unsafe.entry({ name: "bin/tool-copy", type: "link", linkname: options.hardlink === "safe" ? "./bin/tool" : options.hardlink === "escape" ? "../outside" : "bin/missing", mode: 0o644 }, error => error ? reject(error) : done()));
    unsafe.finalize(); await collected;
    const bytes = zstdCompressSync(Buffer.concat(chunks));
    await fs.writeFile(selected.pack + ".archives/overlay.tar.zst", bytes);
    const receipt = JSON.parse(await fs.readFile(selected.pack + ".archive.json", "utf8"));
    receipt.overlay = { bytes: bytes.length, sha256: hash(bytes) };
    await fs.writeFile(selected.pack + ".archive.json", JSON.stringify(receipt));
  }
  const transportPack = options.wrongCode ? current.pack : selected.pack;
  const archive = tar.pack();
  const chunks: Buffer[] = [];
  const collected = (async () => { for await (const chunk of archive) chunks.push(Buffer.from(chunk)); })();
  for (const name of ["provider-pack.archive.json", ...await fs.readdir(transportPack + ".archives").then(names => names.map(name => `provider-pack.archives/${name}`))]) {
    const bytes = await fs.readFile(path.join(path.dirname(transportPack), name.replace("provider-pack", path.basename(transportPack))));
    await new Promise<void>((done, reject) => archive.entry({ name: `opt/paperclip-runner/${name}`, type: "file", size: bytes.length }, bytes, error => error ? reject(error) : done()));
  }
  archive.finalize();
  await collected;
  const layer = gzipSync(Buffer.concat(chunks));
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: { Labels: {
    "org.opencontainers.image.revision": selected.manifest.payload.runnerSourceRevision,
    "org.opencontainers.image.source": "https://github.com/paperclipai/paperclip",
  } }, history: [{ created_by: "COPY /provider-pack-transport/ /opt/paperclip-runner/ # buildkit" }] }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: `sha256:${hash(config)}`, size: config.length }, layers: [{ digest: `sha256:${hash(layer)}`, size: layer.length, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" }] }));
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: `sha256:${hash(manifest)}`, size: manifest.length, platform: { os: "linux", architecture: "amd64" } }] }));
  const routes = new Map<string, Buffer>([
    ["/token", Buffer.from(JSON.stringify({ token: "public-code-fixture-token" }))],
    [`/v2/paperclipai/paperclip/manifests/sha-${selected.manifest.payload.runnerSourceRevision}`, index],
    [`/v2/paperclipai/paperclip/manifests/sha256:${hash(manifest)}`, manifest],
    [`/v2/paperclipai/paperclip/blobs/sha256:${hash(config)}`, config],
    [`/v2/paperclipai/paperclip/blobs/sha256:${hash(layer)}`, layer],
  ]);
  const requests: string[] = [];
  const stalled = new Set<string>();
  const observers = new Map<string, () => void>();
  const server = createServer((request, response) => {
    const route = new URL(request.url!, "http://fixture").pathname;
    requests.push(route);
    const bytes = routes.get(route);
    response.writeHead(bytes ? 200 : 404, { "content-length": bytes?.length ?? 0 });
    response.flushHeaders();
    observers.get(route)?.();
    if (stalled.has(route)) return;
    response.end(bytes);
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture server unavailable");
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    expect(url.hostname).toBe("ghcr.io");
    return actualFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  });
  const bin = path.join(root, "commands");
  await fs.mkdir(bin);
  const tarCommand = (await exec("sh", ["-c", "command -v gtar || command -v tar"])).stdout.trim();
  await fs.symlink(tarCommand, path.join(bin, "tar"));
  const execute = vi.fn(async (input: { command: string; args?: string[] }) => {
    try {
      const result = await exec(input.command, input.args ?? [], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      return { exitCode: 0, timedOut: false, stdout: result.stdout, stderr: result.stderr };
    } catch (error) { return { exitCode: 1, timedOut: false, stdout: "", stderr: String(error) }; }
  });
  const syncIn = vi.fn(async (operations: Array<{ files: Array<{ sourcePath: string; targetPath: string }> }>) => {
    for (const operation of operations) for (const file of operation.files) {
      await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
      await fs.copyFile(file.sourcePath, file.targetPath);
    }
    return { operations: [] };
  });
  return { root, selected, current, requests, routes, runner: { execute, syncIn }, targetPath: path.join(root, "target"),
    temporary, layerRoute: `/v2/paperclipai/paperclip/blobs/sha256:${hash(layer)}`,
    stall: (route: string) => { stalled.add(route); },
    observed: (route: string) => new Promise<void>(done => { if (requests.includes(route)) done(); else observers.set(route, done); }),
  };
}

function upload(input: Awaited<ReturnType<typeof fixture>>, extra: Partial<Parameters<typeof uploadVerifiedProviderPack>[0]> = {}) {
  return uploadVerifiedProviderPack({ root: input.current.pack, sourceDigest: input.current.manifest.digest, expectedDigest: input.selected.manifest.digest,
    manifest: input.selected.manifest, runner: input.runner, cwd: input.root, targetPath: input.targetPath,
    reuseRoots: [], verifyDirectory: () => { throw Error("current_directory_fallback_forbidden"); },
    stageDirectory: async () => { throw Error("current_directory_fallback_forbidden"); }, verifyUploaded: async () => {}, ...extra } as Parameters<typeof uploadVerifiedProviderPack>[0]);
}

it("installs the exact retained pack through the real uploader on an empty host instead of the current image archive", async () => {
  const input = await fixture();
  const verifyUploaded = vi.fn(async () => {
    expect(await fs.readFile(path.join(input.targetPath, "bin/tool"), "utf8")).toBe("retained provider code");
    expect(JSON.parse(await fs.readFile(path.join(input.targetPath, "provider-pack.json"), "utf8"))).toEqual(input.selected.manifest);
  });
  await upload(input, { verifyUploaded });
  expect(verifyUploaded).toHaveBeenCalledOnce();
  expect(input.requests.some(route => route.includes("/blobs/"))).toBe(true);
});

it("keeps a matching current pack on its existing path without registry or cache reads", async () => {
  const input = await fixture();
  await upload(input, { root: input.selected.pack, sourceDigest: input.selected.manifest.digest });
  expect(input.requests).toEqual([]);
  await expect(fs.stat(path.join(input.temporary, `paperclip-provider-pack-sources-${process.getuid?.()}`))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(input.targetPath, "bin/tool"), "utf8")).toBe("retained provider code");
});

it("refuses a different historical code pack even when OCI source labels and all transport hashes are valid", async () => {
  const input = await fixture({ wrongCode: true });
  await expect(upload(input)).rejects.toThrow("runner_remote_provider_archive_invalid");
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(input.current.pack, "bin/tool"), "utf8")).toBe("current incompatible code");
});

it("does not mask a corrupt matching current archive by looking up a different code source", async () => {
  const input = await fixture();
  await fs.writeFile(input.selected.pack + ".archive.json", "{");
  await expect(upload(input, { root: input.selected.pack, sourceDigest: input.selected.manifest.digest })).rejects.toThrow("runner_remote_provider_archive_invalid");
  expect(input.requests).toEqual([]);
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
});

it("rejects a changed controller code identity before looking up a historical source", async () => {
  const input = await fixture();
  await expect(upload(input, { sourceDigest: input.selected.manifest.digest })).rejects.toThrow("runner_remote_provider_source_invalid");
  expect(input.requests).toEqual([]);
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
});

it("refuses an unknown historical source without clearing or falling back to the current image", async () => {
  const input = await fixture();
  input.routes.delete(`/v2/paperclipai/paperclip/manifests/sha-${input.selected.manifest.payload.runnerSourceRevision}`);
  await expect(upload(input)).rejects.toThrow("runner_remote_provider_source_unavailable: HTTP 404");
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
});

it("rejects escaping inner tar paths despite valid OCI and layer digests before any remote effects", async () => {
  const input = await fixture({ unsafeOverlay: true });
  await expect(upload(input)).rejects.toThrow("runner_remote_provider_source_invalid");
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(input.temporary, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("checks the file layer's actual plaintext against its declared code digest before any remote effects", async () => {
  const input = await fixture({ changedFileLayer: true });
  await expect(upload(input)).rejects.toThrow("runner_remote_provider_source_invalid");
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
});

it("preserves historical code hardlinks only to earlier confined regular files", async () => {
  const input = await fixture({ hardlink: "safe" });
  await upload(input);
  const original = await fs.stat(path.join(input.targetPath, "bin/tool")), copy = await fs.stat(path.join(input.targetPath, "bin/tool-copy"));
  expect(copy.ino).toBe(original.ino);
  expect(await fs.readFile(path.join(input.targetPath, "bin/tool-copy"), "utf8")).toBe("retained provider code");
});

it.each(["escape", "unknown"] as const)("refuses a historical code hardlink with an %s target before remote effects", async hardlink => {
  const input = await fixture({ hardlink });
  await expect(upload(input)).rejects.toThrow("runner_remote_provider_source_invalid");
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
});

it("cancels a stalled source body and removes only the unfinished private import", async () => {
  const input = await fixture();
  input.stall(input.layerRoute);
  const controller = new AbortController();
  const operation = upload(input, { signal: controller.signal });
  const rejected = expect(operation).rejects.toThrow("owned caller stopped");
  await input.observed(input.layerRoute);
  controller.abort(new Error("owned caller stopped"));
  await rejected;
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
  const cache = path.join(input.temporary, `paperclip-provider-pack-sources-${process.getuid?.()}`);
  await vi.waitFor(async () => expect(await fs.readdir(cache)).toEqual([]));
});

it("enforces the source deadline while the registry is stalled", async () => {
  const input = await fixture();
  input.stall(input.layerRoute);
  const nativeTimeout = AbortSignal.timeout;
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    expect(milliseconds).toBe(180_000);
    return nativeTimeout(80);
  });
  await expect(upload(input)).rejects.toMatchObject({ name: "TimeoutError" });
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
});

it("reuses a verified derived cache without registry reads and reconstructs it after an empty-host reset", async () => {
  const input = await fixture();
  await upload(input);
  const first = input.requests.length;
  await upload(input, { targetPath: input.targetPath + "-cached" });
  expect(input.requests).toHaveLength(first);
  await fs.rm(path.join(input.temporary, `paperclip-provider-pack-sources-${process.getuid?.()}`), { recursive: true });
  await upload(input, { targetPath: input.targetPath + "-empty" });
  expect(input.requests.length).toBeGreaterThan(first);
  expect(await fs.readFile(path.join(input.targetPath + "-empty", "bin/tool"), "utf8")).toBe("retained provider code");
});

it("shares warm-cache verification while a stopped caller leaves another waiter active", async () => {
  const input = await fixture();
  await upload(input);
  const requests = input.requests.length;
  const firstController = new AbortController(), secondController = new AbortController();
  let enter!: () => void, release!: () => void, joined!: () => void, duplicate!: () => void;
  const entered = new Promise<void>(done => { enter = done; });
  const gate = new Promise<void>(done => { release = done; });
  const secondJoined = new Promise<void>(done => { joined = done; });
  const repeated = new Promise<void>(done => { duplicate = done; });
  const originalRead = archiveOwner.readProviderPackArchive;
  const verification = vi.spyOn(archiveOwner, "readProviderPackArchive").mockImplementation(async (...args) => {
    enter();
    if (verification.mock.calls.length > 1) duplicate();
    await gate;
    return originalRead(...args);
  });
  const originalAny = AbortSignal.any;
  vi.spyOn(AbortSignal, "any").mockImplementation(signals => {
    const combined = originalAny(signals);
    if (signals.includes(secondController.signal)) {
      const add = combined.addEventListener.bind(combined);
      vi.spyOn(combined, "addEventListener").mockImplementation((type, listener, options) => {
        const result = add(type, listener, options);
        if (type === "abort") joined();
        return result;
      });
    }
    return combined;
  });
  const source = { root: input.current.pack, sourceDigest: input.current.manifest.digest, manifest: input.selected.manifest };
  const first = resolveProviderPackUploadSource({ ...source, signal: firstController.signal });
  const firstStopped = expect(first).rejects.toThrow("owned shared-cache waiter stopped");
  await entered;
  const second = resolveProviderPackUploadSource({ ...source, signal: secondController.signal });
  try {
    await Promise.race([secondJoined, repeated.then(() => { throw Error("warm-cache verification repeated"); })]);
    expect(verification).toHaveBeenCalledOnce();
    firstController.abort(new Error("owned shared-cache waiter stopped"));
    await firstStopped;
    expect(verification.mock.calls[0]?.[2]?.aborted).toBe(false);
    release();
    expect(await second).toMatchObject({ archiveOnly: true });
    expect(input.requests).toHaveLength(requests);
  } finally {
    firstController.abort(new Error("owned shared-cache waiter stopped"));
    secondController.abort(new Error("owned shared-cache fixture cleanup"));
    release();
    await Promise.allSettled([first, second, firstStopped]);
  }
});

it("rejects a changed cached archive before any remote command or transfer", async () => {
  const input = await fixture();
  await upload(input);
  const cache = path.join(input.temporary, `paperclip-provider-pack-sources-${process.getuid?.()}`);
  const publication = JSON.parse(await fs.readFile(path.join(cache, input.selected.manifest.digest.slice(7) + ".json"), "utf8"));
  await fs.appendFile(path.join(cache, publication.entry, "provider-pack.archives/overlay.tar.zst"), "changed");
  input.runner.execute.mockClear();
  input.runner.syncIn.mockClear();
  await expect(upload(input, { targetPath: input.targetPath + "-new" })).rejects.toThrow("runner_remote_provider_archive_invalid");
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(input.targetPath, "bin/tool"), "utf8")).toBe("retained provider code");
});

it("refuses an unsafe cache directory instead of following it", async () => {
  const input = await fixture();
  const outside = path.join(input.root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(input.temporary, `paperclip-provider-pack-sources-${process.getuid?.()}`));
  await expect(upload(input)).rejects.toThrow("runner_remote_provider_source_invalid");
  expect(await fs.readdir(outside)).toEqual([]);
  expect(input.requests).toEqual([]);
  expect(input.runner.execute).not.toHaveBeenCalled();
});

it("leaves a target intact when its archive transport cannot install the verified source", async () => {
  const input = await fixture();
  await fs.mkdir(input.targetPath);
  await fs.writeFile(path.join(input.targetPath, "marker"), "untouched");
  input.runner.execute.mockResolvedValue({ exitCode: 127, timedOut: false, stdout: "", stderr: "unavailable" });
  await expect(upload(input)).rejects.toThrow("runner_remote_provider_archive_transport_unavailable");
  expect(input.runner.execute).toHaveBeenCalledOnce();
  expect(input.runner.execute.mock.calls[0]?.[0].args?.join(" ")).not.toContain("rm -rf");
  expect(input.runner.syncIn).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(input.targetPath, "marker"), "utf8")).toBe("untouched");
});

it("refuses an oversized historical layer specification before any target effects", async () => {
  const input = await fixture();
  await fs.mkdir(input.targetPath);
  await fs.writeFile(path.join(input.targetPath, "marker"), "untouched");
  const reuseRoots = Array.from({ length: 2000 }, (_, index) => `/qualified-image-${index}/` + "a".repeat(64));
  await expect(upload(input, { reuseRoots })).rejects.toThrow("runner_remote_provider_archive_transport_unavailable");
  expect(input.runner.execute).not.toHaveBeenCalled();
  expect(input.runner.syncIn).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(input.targetPath, "marker"), "utf8")).toBe("untouched");
});
