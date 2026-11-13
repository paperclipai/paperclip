import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertControllerMatchesImage, assertProviderPackMismatch, copyImageToDir, extractFromLayers, prepareDaytonaImageArtifacts, normalizeLayerPath, walkTar, type LayerSource } from "./daytona-image.js";

type Entry =
  | { path: string; type: "file"; content: string; mode?: number }
  | { path: string; type: "dir" }
  | { path: string; type: "symlink" | "hardlink"; target: string };

function header(name: string, typeflag: string, size: number, mode: number, link = ""): Buffer {
  const block = Buffer.alloc(512);
  const field = (value: string, offset: number, length: number) => block.write(value, offset, length, "utf8");
  const octal = (value: number, offset: number, length: number) => field(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  field(name, 0, 100);
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12);
  block.write(typeflag, 156, 1, "latin1");
  field(link, 157, 100);
  block.write("ustar\0", 257, 6, "latin1");
  block.write("00", 263, 2, "latin1");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

const pad = (body: Buffer) => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);

/** Minimal ustar writer; names over 100 bytes use a pax `path` record. */
function tar(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (Buffer.byteLength(entry.path) > 100) {
      const record = (value: string) => {
        let length = value.length + 3;
        while (`${length} ${value}\n`.length !== length) length = `${length} ${value}\n`.length;
        return `${length} ${value}\n`;
      };
      const body = Buffer.from(record(`path=${entry.path}`));
      blocks.push(header("PaxHeader", "x", body.length, 0o644), pad(body));
    }
    const name = Buffer.byteLength(entry.path) > 100 ? "long" : entry.path;
    if (entry.type === "file") {
      const body = Buffer.from(entry.content);
      blocks.push(header(name, "0", body.length, entry.mode ?? 0o644), pad(body));
    } else if (entry.type === "dir") blocks.push(header(name, "5", 0, 0o755));
    else blocks.push(header(name, entry.type === "symlink" ? "2" : "1", 0, 0o777, entry.target));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Chunk the archive oddly to exercise header/body boundaries. */
function layer(digest: string, entries: Entry[]): LayerSource {
  const bytes = tar(entries);
  return { digest, open: async function* () { for (let offset = 0; offset < bytes.length; offset += 333) yield bytes.subarray(offset, offset + 333); } };
}

const RUNNERD = "usr/local/bin/paperclip-runnerd";
const PACK = "opt/paperclip-runner/provider-pack";
const directories: string[] = [];
async function outDir() { const directory = await mkdtemp(path.join(os.tmpdir(), "chaos-layers-")); directories.push(directory); return directory; }
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const read = (root: string, relative: string) => readFile(path.join(root, relative), "utf8");
const exists = (root: string, relative: string) => stat(path.join(root, relative)).then(() => true, () => false);

describe("walkTar", () => {
  it("reads ustar, pax long paths, links and normalizes ./ prefixes", async () => {
    const long = `${PACK}/${"x".repeat(120)}/file.txt`;
    const seen: Array<[string, string, string]> = [];
    await walkTar(layer("l", [
      { path: "./usr/", type: "dir" },
      { path: long, type: "file", content: "deep" },
      { path: "a/link", type: "symlink", target: "../b" },
    ]).open(), async (entry, body) => {
      let content = "";
      if (entry.type === "file") await body.forward(chunk => { content += chunk.toString(); });
      seen.push([entry.path, entry.type, content || entry.linkTarget]);
    });
    expect(seen).toEqual([["usr", "directory", ""], [long, "file", "deep"], ["a/link", "symlink", "../b"]]);
  });

  it("rejects parent-directory traversal", () => {
    expect(() => normalizeLayerPath("opt/../../etc/passwd")).toThrow(/\.\./);
  });
});

describe("extractFromLayers", () => {
  it("takes the topmost version of each file and merges lower-only files", async () => {
    const out = await outDir();
    const report = await extractFromLayers([
      layer("base", [{ path: "usr/local/bin/other", type: "file", content: "x" },
        { path: RUNNERD, type: "file", content: "old", mode: 0o755 },
        { path: `${PACK}/provider-pack.json`, type: "file", content: "{\"v\":1}" },
        { path: `${PACK}/lib/keep.js`, type: "file", content: "keep" }]),
      layer("top", [{ path: RUNNERD, type: "file", content: "new", mode: 0o755 },
        { path: `${PACK}/provider-pack.json`, type: "file", content: "{\"v\":2}" }]),
    ], [RUNNERD, PACK], out);
    expect(await read(out, RUNNERD)).toBe("new");
    expect((await stat(path.join(out, RUNNERD))).mode & 0o111).not.toBe(0);
    expect(await read(out, `${PACK}/provider-pack.json`)).toBe("{\"v\":2}");
    expect(await read(out, `${PACK}/lib/keep.js`)).toBe("keep");
    expect(await exists(out, "usr/local/bin/other")).toBe(false);
    expect(report.layersWithMatches).toEqual(["top", "base"]);
  });

  it("honours .wh.<name> whiteouts for files and whole subtrees", async () => {
    const out = await outDir();
    await extractFromLayers([
      layer("base", [{ path: RUNNERD, type: "file", content: "r" },
        { path: `${PACK}/provider-pack.json`, type: "file", content: "{}" },
        { path: `${PACK}/stale.js`, type: "file", content: "stale" },
        { path: `${PACK}/old-dir/a.js`, type: "file", content: "a" }]),
      layer("top", [{ path: `${PACK}/.wh.stale.js`, type: "file", content: "" },
        { path: `${PACK}/.wh.old-dir`, type: "file", content: "" }]),
    ], [RUNNERD, PACK], out);
    expect(await exists(out, `${PACK}/stale.js`)).toBe(false);
    expect(await exists(out, `${PACK}/old-dir`)).toBe(false);
    expect(await exists(out, `${PACK}/provider-pack.json`)).toBe(true);
  });

  it("honours opaque directories: only the opaque layer and above contribute children", async () => {
    const out = await outDir();
    await extractFromLayers([
      layer("base", [{ path: RUNNERD, type: "file", content: "r" }, { path: `${PACK}/old.js`, type: "file", content: "old" }]),
      layer("middle", [{ path: PACK, type: "dir" }, { path: `${PACK}/.wh..wh..opq`, type: "file", content: "" },
        { path: `${PACK}/provider-pack.json`, type: "file", content: "{}" }]),
      layer("top", [{ path: `${PACK}/added.js`, type: "file", content: "added" }]),
    ], [RUNNERD, PACK], out);
    expect(await exists(out, `${PACK}/old.js`)).toBe(false);
    expect(await read(out, `${PACK}/provider-pack.json`)).toBe("{}");
    expect(await read(out, `${PACK}/added.js`)).toBe("added");
  });

  it("deleting a target in a higher layer means it is missing", async () => {
    const out = await outDir();
    await expect(extractFromLayers([
      layer("base", [{ path: RUNNERD, type: "file", content: "r" }, { path: `${PACK}/provider-pack.json`, type: "file", content: "{}" }]),
      layer("top", [{ path: "usr/local/bin/.wh.paperclip-runnerd", type: "file", content: "" }]),
    ], [RUNNERD, PACK], out)).rejects.toThrow(/paperclip-runnerd was not found/);
  });

  it("a whiteout does not hide entries of its own layer", async () => {
    const out = await outDir();
    await extractFromLayers([
      layer("base", [{ path: RUNNERD, type: "file", content: "old" }, { path: `${PACK}/provider-pack.json`, type: "file", content: "{}" }]),
      layer("top", [{ path: `${PACK}/.wh..wh..opq`, type: "file", content: "" }, { path: `${PACK}/provider-pack.json`, type: "file", content: "{\"top\":1}" }]),
    ], [RUNNERD, PACK], out);
    expect(await read(out, `${PACK}/provider-pack.json`)).toBe("{\"top\":1}");
  });

  it("a higher-layer file replacing a directory hides the lower tree", async () => {
    const out = await outDir();
    await extractFromLayers([
      layer("base", [{ path: RUNNERD, type: "file", content: "r" }, { path: `${PACK}/sub/a.js`, type: "file", content: "a" }]),
      layer("top", [{ path: `${PACK}/sub`, type: "file", content: "now a file" }]),
    ], [RUNNERD, PACK], out);
    expect(await read(out, `${PACK}/sub`)).toBe("now a file");
  });

  it("resolves hard links and keeps symlinks inside the pack", async () => {
    const out = await outDir();
    await extractFromLayers([layer("only", [
      { path: RUNNERD, type: "file", content: "r", mode: 0o755 },
      { path: `${PACK}/node_modules/tool/cli.js`, type: "file", content: "cli", mode: 0o755 },
      { path: `${PACK}/node_modules/tool/cli-copy.js`, type: "hardlink", target: `${PACK}/node_modules/tool/cli.js` },
      { path: `${PACK}/node_modules/.bin/tool`, type: "symlink", target: "../tool/cli.js" },
    ])], [RUNNERD, PACK], out);
    expect(await read(out, `${PACK}/node_modules/tool/cli-copy.js`)).toBe("cli");
    expect(await readlink(path.join(out, PACK, "node_modules/.bin/tool"))).toBe("../tool/cli.js");
    expect(await read(out, `${PACK}/node_modules/.bin/tool`)).toBe("cli");
  });

  it("refuses a parent directory replaced by a symlink", async () => {
    const out = await outDir();
    await expect(extractFromLayers([
      layer("base", [{ path: RUNNERD, type: "file", content: "r" }, { path: `${PACK}/provider-pack.json`, type: "file", content: "{}" }]),
      layer("top", [{ path: "opt/paperclip-runner", type: "symlink", target: "/elsewhere" }]),
    ], [RUNNERD, PACK], out)).rejects.toThrow(/replaces parent directory \/opt\/paperclip-runner/);
  });
});

describe("assertControllerMatchesImage", () => {
  const image = { image: "ghcr.io/x/y@sha256:" + "a".repeat(64), contentId: "c".repeat(64), sourceRevision: "d".repeat(40) };
  it("passes when content IDs match", async () => {
    await expect(assertControllerMatchesImage(image, "/unused", "c".repeat(64))).resolves.toEqual({ localContentId: "c".repeat(64) });
  });
  it("names both content IDs and the image revision when they differ", async () => {
    await expect(assertControllerMatchesImage(image, "/unused", "e".repeat(64))).rejects.toThrow(/does not match the Daytona image[\s\S]*d{40}[\s\S]*e{64}/);
  });
});

describe("assertProviderPackMismatch", () => {
  const controller = { image: "ghcr.io/x/y@sha256:" + "a".repeat(64), providerPackDigest: `sha256:${"1".repeat(64)}` };
  it("accepts a sandbox image whose provider pack differs", () => {
    expect(() => assertProviderPackMismatch(controller,
      { image: "ghcr.io/x/y@sha256:" + "b".repeat(64), providerPackDigest: `sha256:${"2".repeat(64)}` })).not.toThrow();
  });
  it("refuses another image that carries the same provider pack, which would skip the upload path", () => {
    expect(() => assertProviderPackMismatch(controller,
      { image: "ghcr.io/x/y@sha256:" + "b".repeat(64), providerPackDigest: controller.providerPackDigest }))
      .toThrow(/carries the controller's provider pack/);
  });
});

describe("copyImageToDir", () => {
  async function fakeSkopeo(root: string, failures: number): Promise<string> {
    const script = path.join(root, "skopeo");
    await writeFile(script, `#!/bin/sh
dest="\${9#dir:}"
if [ -n "$(ls -A "$dest")" ]; then echo "not a containers image directory, don't want to overwrite" >&2; exit 1; fi
n=$(cat "${root}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${root}/count"
if [ $n -le ${failures} ]; then echo partial > "$dest/blob"; echo "read: operation timed out" >&2; exit 1; fi
echo '{}' > "$dest/manifest.json"
`);
    await chmod(script, 0o755);
    return script;
  }

  it("retries a copy that failed part-way from an empty directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daytona-skopeo-"));
    try {
      const blobs = path.join(root, "blobs");
      await copyImageToDir({ skopeo: await fakeSkopeo(root, 2), image: "ghcr.io/x/y@sha256:" + "a".repeat(64), blobs });
      expect(await readFile(path.join(root, "count"), "utf8")).toBe("3\n");
      expect(await readFile(path.join(blobs, "manifest.json"), "utf8")).toBe("{}\n");
      await expect(stat(path.join(blobs, "blob"))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("kills an attempt that stalls past its time bound and retries from an empty directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daytona-skopeo-"));
    try {
      const script = path.join(root, "skopeo");
      await writeFile(script, `#!/bin/sh
dest="\${9#dir:}"
n=$(cat "${root}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${root}/count"
if [ $n -eq 1 ]; then echo partial > "$dest/blob"; exec sleep 30; fi
if [ -n "$(ls -A "$dest")" ]; then exit 1; fi
echo '{}' > "$dest/manifest.json"
`);
      await chmod(script, 0o755);
      const blobs = path.join(root, "blobs");
      const started = Date.now();
      await copyImageToDir({ skopeo: script, image: "i", blobs, attemptTimeoutMs: 500 });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await readFile(path.join(root, "count"), "utf8")).toBe("2\n");
      expect(await readFile(path.join(blobs, "manifest.json"), "utf8")).toBe("{}\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("gives up after the last attempt with skopeo's error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daytona-skopeo-"));
    try {
      await expect(copyImageToDir({ skopeo: await fakeSkopeo(root, 5), image: "i", blobs: path.join(root, "blobs"), attempts: 2 }))
        .rejects.toThrow(/operation timed out/);
      expect(await readFile(path.join(root, "count"), "utf8")).toBe("2\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("prepareDaytonaImageArtifacts with a shared cache", () => {
  const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const revision = "a".repeat(40);

  async function fakeImage(root: string): Promise<string> {
    const source = path.join(root, "image");
    await mkdir(source, { recursive: true });
    const elf = Buffer.alloc(64); elf.writeUInt32BE(0x7f454c46, 0); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
    const pack = JSON.stringify({ schema: "paperclip-runner/remote-provider-pack/v1", digest: `sha256:${"b".repeat(64)}`,
      payload: { runnerSourceRevision: revision } });
    const layerBytes = tar([
      { path: RUNNERD, type: "file", content: elf.toString("latin1"), mode: 0o755 },
      { path: `${PACK}/provider-pack.json`, type: "file", content: pack },
    ]);
    const config = Buffer.from(JSON.stringify({ os: "linux", architecture: "amd64",
      config: { Labels: { "io.paperclip.runner.content-id": "c".repeat(64), "org.opencontainers.image.revision": revision } } }));
    await writeFile(path.join(source, sha(layerBytes)), layerBytes);
    await writeFile(path.join(source, sha(config)), config);
    await writeFile(path.join(source, "manifest.json"), JSON.stringify({ config: { digest: `sha256:${sha(config)}` },
      layers: [{ digest: `sha256:${sha(layerBytes)}`, mediaType: "application/vnd.oci.image.layer.v1.tar" }] }));
    const barrier = path.join(root, "barrier");
    await mkdir(barrier);
    const script = path.join(root, "skopeo");
    await writeFile(script, `#!/bin/sh
dest="\${9#dir:}"
touch "${barrier}/$$"
while [ "$(ls "${barrier}" | wc -l)" -lt 2 ]; do sleep 0.05; done
cp -R "${source}/." "$dest/"
`);
    await chmod(script, 0o755);
    return script;
  }

  it("lets two runs extract the same image at once; both get a usable receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daytona-cache-"));
    directories.push(root);
    const skopeo = await fakeImage(root);
    const image = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"d".repeat(64)}`;
    const cacheRoot = path.join(root, "cache");
    const [first, second] = await Promise.all([
      prepareDaytonaImageArtifacts({ image, cacheRoot, skopeo }),
      prepareDaytonaImageArtifacts({ image, cacheRoot, skopeo }),
    ]);
    expect(second.runnerdPath).toBe(first.runnerdPath);
    for (const receipt of [first, second]) {
      expect((await stat(receipt.runnerdPath)).isFile()).toBe(true);
      expect(await readFile(path.join(receipt.providerPackPath, "provider-pack.json"), "utf8")).toContain(revision);
    }
  });

  it("leaves a corrupt leftover in place and publishes beside it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daytona-cache-"));
    directories.push(root);
    const skopeo = await fakeImage(root);
    await writeFile(path.join(root, "barrier", "other"), "");
    const image = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"e".repeat(64)}`;
    const cacheRoot = path.join(root, "cache");
    await mkdir(path.join(cacheRoot, "e".repeat(64)), { recursive: true });
    await writeFile(path.join(cacheRoot, "e".repeat(64), "junk"), "partial");
    const receipt = await prepareDaytonaImageArtifacts({ image, cacheRoot, skopeo });
    expect((await stat(receipt.runnerdPath)).isFile()).toBe(true);
    expect(receipt.runnerdPath.startsWith(path.join(cacheRoot, `${"e".repeat(64)}.`))).toBe(true);
    expect(await exists(cacheRoot, `${"e".repeat(64)}/junk`)).toBe(true);
  });

  it("two runs replacing a corrupt leftover at once both keep a usable cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daytona-cache-"));
    directories.push(root);
    const skopeo = await fakeImage(root);
    const image = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"f".repeat(64)}`;
    const cacheRoot = path.join(root, "cache");
    await mkdir(path.join(cacheRoot, "f".repeat(64)), { recursive: true });
    await writeFile(path.join(cacheRoot, "f".repeat(64), "junk"), "partial");
    const receipts = await Promise.all([1, 2].map(() => prepareDaytonaImageArtifacts({ image, cacheRoot, skopeo })));
    for (const receipt of receipts) expect((await stat(receipt.runnerdPath)).isFile()).toBe(true);
    expect(await exists(cacheRoot, `${"f".repeat(64)}/junk`)).toBe(true);
  });
});
