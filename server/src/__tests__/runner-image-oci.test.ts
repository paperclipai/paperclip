import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  RUNNER_IMAGE_LAYERS,
  checkRunnerImageLayers,
  listOciLayers,
  readOciArchive,
  unpackOciImage,
} from "../../../scripts/runner-image-oci.mjs";

/**
 * The OCI archives of the Runner image. CI builds each variant as an archive
 * only, unpacks it, and checks the tree that comes out, so the reader must
 * give exactly the files of the image and must not write anything an additive
 * layer of a `FROM scratch` image cannot hold.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ociScript = path.join(repoRoot, "scripts", "runner-image-oci.mjs");
const sha256 = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const scratch = mkdtempSync(path.join(tmpdir(), "runner-image-oci-"));
afterAll(() => {
  spawnSync("chmod", ["-R", "u+rwX", scratch]);
  rmSync(scratch, { recursive: true, force: true });
});
let sequence = 0;
const fresh = () => path.join(scratch, String(sequence += 1));

type Entry = { name: string; type?: string; content?: string | Buffer; linkname?: string; mode?: number };

/** A tar stream of exactly these entries, in the POSIX format. Nothing is added or cleaned. */
function tarOf(entries: Entry[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? (entry.name.endsWith("/") ? "5" : "0");
    const content = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    const field = (value: string, start: number, length: number) => { header.write(value, start, length, "utf8"); };
    const octal = (value: number, start: number, length: number) => field(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length);
    expect(Buffer.byteLength(entry.name)).toBeLessThanOrEqual(100);
    field(entry.name, 0, 100);
    octal(entry.mode ?? (type === "5" ? 0o755 : 0o644), 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(type === "0" ? content.length : 0, 124, 12);
    octal(946684800, 136, 12);
    field("        ", 148, 8);
    field(type, 156, 1);
    field(entry.linkname ?? "", 157, 100);
    field("ustar\0", 257, 6);
    field("00", 263, 2);
    octal(header.reduce((sum, byte) => sum + byte, 0), 148, 7);
    blocks.push(header);
    if (type === "0") blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

/** Entries for a layer that holds these files, with every parent directory first. */
function layerOf(files: Record<string, string>): Entry[] {
  const entries = new Map<string, Entry>();
  for (const [name, content] of Object.entries(files)) {
    const parts = name.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = `${parts.slice(0, depth).join("/")}/`;
      if (!entries.has(directory)) entries.set(directory, { name: directory });
    }
    entries.set(name, { name, content });
  }
  return [...entries.values()];
}

/**
 * What `docker buildx build --output type=oci` writes for one platform, with
 * these layers: tar streams, or the files of a layer. `members` names the
 * members of the archive the way buildx does; a test can name them otherwise.
 */
function ociArchive(layers: (Buffer | Record<string, string>)[], { members = ["blobs", "index.json", "oci-layout"], tamper = (_layout: string) => {} } = {}) {
  const root = fresh();
  const layout = path.join(root, "layout");
  mkdirSync(path.join(layout, "blobs", "sha256"), { recursive: true });
  const blob = (bytes: Buffer) => {
    writeFileSync(path.join(layout, "blobs", "sha256", sha256(bytes).slice(7)), bytes);
    return { digest: sha256(bytes), size: bytes.length };
  };
  const descriptors = layers.map((layer) => ({
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    ...blob(gzipSync(Buffer.isBuffer(layer) ? layer : tarOf(layerOf(layer)))),
  }));
  const manifest = blob(Buffer.from(JSON.stringify({ schemaVersion: 2, config: blob(Buffer.from("{}")), layers: descriptors })));
  writeFileSync(path.join(layout, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", ...manifest }] }));
  writeFileSync(path.join(layout, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  tamper(layout);
  const archive = path.join(root, "image.oci.tar");
  expect(spawnSync("tar", ["-cf", archive, "-C", layout, ...members]).status).toBe(0);
  return { archive, digest: manifest.digest, layers: descriptors };
}

describe("OCI archive reader", () => {
  it("reads the image, its layers and their entries", async () => {
    const image = ociArchive([{ "a/one": "1" }, { "a/two": "22", top: "t" }]);
    const read = readOciArchive(image.archive);
    expect(read.descriptor.digest).toBe(image.digest);
    expect(read.layers.map((layer) => layer.digest)).toEqual(image.layers.map((layer) => layer.digest));
    const listed = await listOciLayers(image.archive);
    expect(listed.digest).toBe(image.digest);
    expect(listed.layers.map((layer) => layer.entries.map((entry) => `${entry.kind} ${entry.name}`))).toEqual([
      ["directory a", "file a/one"],
      ["directory a", "file a/two", "file top"],
    ]);
  });

  it("finds a member only under the name buildx gives it", () => {
    // `tar -cf x -C layout .` names the members ./index.json and ./blobs/...
    // A reader that accepted those would read archives no registry tool reads.
    expect(() => readOciArchive(ociArchive([{ a: "1" }], { members: ["."] }).archive)).toThrow(/has no member index\.json/);
  });

  it("refuses a manifest or a layer that does not have its digest", async () => {
    const swapped = ociArchive([{ a: "1" }], {
      tamper: (layout) => {
        const index = JSON.parse(readFileSync(path.join(layout, "index.json"), "utf8"));
        writeFileSync(path.join(layout, "blobs", "sha256", index.manifests[0].digest.slice(7)), '{"schemaVersion":2,"layers":[]}');
      },
    });
    expect(() => readOciArchive(swapped.archive)).toThrow(/the manifest does not have the digest the index names/);
    const other = gzipSync(tarOf(layerOf({ a: "another file of the same length?" })));
    const changed = ociArchive([{ a: "1" }], {
      tamper: (layout) => {
        const index = JSON.parse(readFileSync(path.join(layout, "index.json"), "utf8"));
        const manifest = JSON.parse(readFileSync(path.join(layout, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"));
        const layer = path.join(layout, "blobs", "sha256", manifest.layers[0].digest.slice(7));
        // Other bytes of the same length, so only the digest can tell.
        writeFileSync(layer, Buffer.concat([other, Buffer.alloc(4096)]).subarray(0, readFileSync(layer).length));
      },
    });
    await expect(listOciLayers(changed.archive)).rejects.toThrow();
    const index = ociArchive([{ a: "1" }], {
      tamper: (layout) => writeFileSync(path.join(layout, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [] })),
    });
    expect(() => readOciArchive(index.archive)).toThrow(/must hold exactly one image manifest/);
  });

  it("reads layers the system's tar wrote, with long names and links", async () => {
    // GNU tar and bsdtar write long names in two different ways. BuildKit uses a third.
    const directory = fresh();
    const deep = `node_modules/.pnpm/${"a".repeat(60)}/node_modules/${"b".repeat(60)}/${"c".repeat(40)}`;
    mkdirSync(path.join(directory, deep), { recursive: true });
    writeFileSync(path.join(directory, deep, "file.bin"), "long");
    symlinkSync(`${deep}/file.bin`, path.join(directory, "link"));
    const tarball = spawnSync("tar", ["-cf", "-", "-C", directory, "."], { maxBuffer: 16 * 1024 * 1024 });
    expect(tarball.status).toBe(0);
    const { archive } = ociArchive([tarball.stdout]);
    const entries = (await listOciLayers(archive)).layers[0].entries;
    expect(entries.find((entry) => entry.name === `${deep}/file.bin`)).toMatchObject({ kind: "file", size: 4 });
    expect(entries.find((entry) => entry.name === "link")).toMatchObject({ kind: "link", target: `${deep}/file.bin` });
    const out = fresh();
    await unpackOciImage(archive, out);
    expect(readFileSync(path.join(out, deep, "file.bin"), "utf8")).toBe("long");
    expect(readFileSync(path.join(out, "link"), "utf8")).toBe("long");
  });
});

describe("unpacking an image", () => {
  it("writes every layer in order: files with their modes, directories, links and hard links", async () => {
    const image = ociArchive([
      tarOf([
        { name: "bin/" },
        { name: "bin/tool", content: "#!/bin/sh\n", mode: 0o755 },
        { name: "bin/again", type: "1", linkname: "bin/tool" },
        { name: "current", type: "2", linkname: "bin/tool" },
        { name: "sealed/", mode: 0o555 },
        { name: "sealed/read-only", content: "ro", mode: 0o444 },
      ]),
      tarOf([{ name: "./" }, { name: "./bin/" }, { name: "./bin/other", content: "x" }, { name: "new/deep/file", content: "made without its directories" }]),
    ]);
    const out = fresh();
    const result = await unpackOciImage(image.archive, out);
    expect(result).toEqual({ digest: image.digest, layers: 2, files: 6 });
    expect(readFileSync(path.join(out, "bin/tool"), "utf8")).toBe("#!/bin/sh\n");
    expect(lstatSync(path.join(out, "bin/tool")).mode & 0o7777).toBe(0o755);
    expect(lstatSync(path.join(out, "bin/again")).ino).toBe(lstatSync(path.join(out, "bin/tool")).ino);
    expect(readlinkSync(path.join(out, "current"))).toBe("bin/tool");
    expect(lstatSync(path.join(out, "sealed")).mode & 0o7777).toBe(0o555);
    expect(lstatSync(path.join(out, "sealed/read-only")).mode & 0o7777).toBe(0o444);
    expect(readFileSync(path.join(out, "bin/other"), "utf8")).toBe("x");
    expect(readFileSync(path.join(out, "new/deep/file"), "utf8")).toBe("made without its directories");
    expect(Math.round(lstatSync(path.join(out, "bin/tool")).mtimeMs / 1000)).toBe(946684800);
  });

  it("writes large files whole", async () => {
    const large = Buffer.alloc(3 * 1024 * 1024 + 17, "n");
    const { archive } = ociArchive([tarOf([{ name: "large.bin", content: large }, { name: "after", content: "still aligned" }])]);
    const out = fresh();
    await unpackOciImage(archive, out);
    expect(sha256(readFileSync(path.join(out, "large.bin")))).toBe(sha256(large));
    expect(readFileSync(path.join(out, "after"), "utf8")).toBe("still aligned");
  });

  it.each<[string, Entry[][], RegExp]>([
    ["a whiteout", [[{ name: "a/" }, { name: "a/.wh.gone" }]], /is a whiteout: the image only adds files/],
    ["an opaque directory marker", [[{ name: "a/" }, { name: "a/.wh..wh..opq" }]], /is a whiteout/],
    ["an absolute path", [[{ name: "/etc/passwd", content: "x" }]], /is absolute/],
    ["a path that leaves the tree", [[{ name: "../outside", content: "x" }]], /is not a plain relative path/],
    ["a path that goes up inside the tree", [[{ name: "a/" }, { name: "a/../b", content: "x" }]], /is not a plain relative path/],
    ["a file behind a link", [[{ name: "link", type: "2", linkname: "/tmp" }, { name: "link/file", content: "x" }]], /is behind link, which is not a directory/],
    ["a file behind a link of an earlier layer", [[{ name: "link", type: "2", linkname: "." }], [{ name: "link/file", content: "x" }]], /is behind link/],
    ["a file behind a file", [[{ name: "a", content: "x" }, { name: "a/b", content: "y" }]], /is behind a, which is not a directory/],
    ["a file a later layer writes again", [[{ name: "a", content: "1" }], [{ name: "a", content: "2" }]], /a layer writes a again: the image only adds files/],
    ["a link over a file", [[{ name: "a", content: "1" }], [{ name: "a", type: "2", linkname: "b" }]], /a layer writes a again/],
    ["a directory over a file", [[{ name: "a", content: "1" }], [{ name: "a/" }]], /a layer writes a again, as a directory/],
    ["a file over a directory", [[{ name: "a/" }], [{ name: "a", content: "1" }]], /a layer writes a again/],
    ["a hard link to a path outside the tree", [[{ name: "a", type: "1", linkname: "../../etc/passwd" }]], /hard link target ..\/..\/etc\/passwd is not a plain relative path/],
    ["a hard link to nothing", [[{ name: "a", type: "1", linkname: "missing" }]], /is a hard link to missing, which is not a file of the image/],
    ["a hard link to a link", [[{ name: "l", type: "2", linkname: "/etc/passwd" }, { name: "a", type: "1", linkname: "l" }]], /which is not a file of the image/],
    ["a device", [[{ name: "dev", type: "3" }]], /not a file, a directory or a link/],
    ["a fifo", [[{ name: "pipe", type: "6" }]], /not a file, a directory or a link/],
    ["a file in place of the root", [[{ name: "./", type: "0", content: "x" }]], /replaces the image root/],
  ])("refuses %s", async (_label, layers, expected) => {
    const out = fresh();
    await expect(unpackOciImage(ociArchive(layers.map(tarOf)).archive, out)).rejects.toThrow(expected);
    // Nothing was written outside the destination.
    expect(existsSync(path.join(path.dirname(out), "outside"))).toBe(false);
  });

  it("writes only into an empty directory", async () => {
    const out = fresh();
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "left-over"), "x");
    await expect(unpackOciImage(ociArchive([{ a: "1" }]).archive, out)).rejects.toThrow(/is not empty/);
  });

  it("is a command that says which image it unpacked", () => {
    const image = ociArchive([{ "a/one": "1" }]);
    const out = fresh();
    const run = (...args: string[]) => spawnSync(process.execPath, [ociScript, "unpack", ...args], { encoding: "utf8" });
    const passed = run(image.archive, "--out", out);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain(`Unpacked 1 files from the 1 layers of ${image.digest}`);
    expect(readFileSync(path.join(out, "a/one"), "utf8")).toBe("1");
    expect(run(image.archive).stderr).toMatch(/unpack takes exactly one OCI archive and --out DIR/);
    expect(run(image.archive, "--out", out).stderr).toMatch(/is not empty/);
    expect(run(image.archive, "--into", out).stderr).toMatch(/unpack does not take --into/);
    expect(spawnSync(process.execPath, [ociScript, "extract", image.archive], { encoding: "utf8" }).stderr).toMatch(/Usage/);
  });
});

describe("image layers", () => {
  // Archive N is file N of the receipt. The last file is the Runner's own output.
  const receipt = JSON.stringify({ files: [{ path: "node_modules/big/big.bin" }, { path: "node_modules/node/bin/node" }, { path: "dist/cli/sidecar.cjs" }] });
  const large = { "provider-pack/node_modules/node/bin/node": "node", "provider-pack/node_modules/big/big.bin": "big" };
  const rest = {
    "runner-image.json": "{}", "paperclip-runnerd": "elf", "pnpm-lock.yaml": "lock",
    "provider-pack/provider-pack.json": "{}", "provider-pack/dist/cli/sidecar.cjs": "sidecar",
  };
  const stable = { "provider-pack.archives/0.tar.zst": "0", "provider-pack.archives/1.tar.zst": "1" };
  const changing = { "provider-pack.archives/2.tar.zst": "2", "provider-pack.archives/overlay.tar.zst": "overlay", "provider-pack.archive.json": receipt };
  type Layers = Record<string, string>[];
  const problemsOf = async (archives: { slim?: Layers; full?: Layers }) => (await checkRunnerImageLayers({
    slim: archives.slim ? ociArchive(archives.slim).archive : null, full: archives.full ? ociArchive(archives.full).archive : null,
  })).problems.join("\n");

  it("accepts a full image that is the slim image plus the two transport layers", async () => {
    const result = await checkRunnerImageLayers({ slim: ociArchive([large, rest]).archive, full: ociArchive([large, rest, stable, changing]).archive });
    expect(result.problems).toEqual([]);
    expect(result.layers.slim.map((layer) => layer.role)).toEqual(RUNNER_IMAGE_LAYERS.slim);
    expect(result.layers.full.map((layer) => layer.role)).toEqual(RUNNER_IMAGE_LAYERS.full);
    expect(RUNNER_IMAGE_LAYERS.full.slice(0, 2)).toEqual(RUNNER_IMAGE_LAYERS.slim);
    // The same blobs, not only the same files.
    expect(result.layers.full.slice(0, 2).map((layer) => layer.digest)).toEqual(result.layers.slim.map((layer) => layer.digest));
  });

  it("checks one variant alone, and needs at least one", async () => {
    expect(await problemsOf({ slim: [large, rest] })).toBe("");
    expect(await problemsOf({ full: [large, rest, stable, changing] })).toBe("");
    await expect(checkRunnerImageLayers({})).rejects.toThrow(/needs --slim, --full or both/);
  });

  it.each<[string, { slim?: Layers; full?: Layers }, RegExp]>([
    ["a full image whose shared layers are not the slim image's blobs",
      { slim: [large, rest], full: [large, { ...rest, "paperclip-runnerd": "another build" }, stable, changing] },
      /the full image does not start with the layers of the slim image/],
    ["a full image with the slim layers in another order",
      { slim: [large, rest], full: [rest, large, stable, changing] }, /the full image does not start with the layers of the slim image/],
    ["a slim image with the transport layers", { slim: [large, rest, stable, changing] }, /the slim image has 4 layers, not 2/],
    ["a slim image that holds a transport archive", { slim: [large, { ...rest, "provider-pack.archives/1.tar.zst": "1" }] },
      /slim: transport content is in the layers both variants share \(2\): provider-pack\.archives, provider-pack\.archives\/1\.tar\.zst/],
    ["a slim image that holds a transport archive under another directory", { slim: [large, { ...rest, "provider-pack/spare/0.tar.zst": "0" }] },
      /slim: transport content is in the layers both variants share \(1\): provider-pack\/spare\/0\.tar\.zst/],
    ["a slim image that holds the archives directory somewhere else", { slim: [large, { ...rest, "backup/provider-pack.archives/overlay.bin": "x" }] },
      /slim: transport content is in the layers both variants share \(2\): backup\/provider-pack\.archives, backup\/provider-pack\.archives\/overlay\.bin/],
    ["a slim image that holds a receipt inside the pack", { slim: [{ ...large, "provider-pack/node_modules/provider-pack.archive.json": "{}" }, rest] },
      /slim: transport content is in the layers both variants share \(1\): provider-pack\/node_modules\/provider-pack\.archive\.json/],
    ["a file that two layers of the slim image write", { slim: [large, { ...rest, "provider-pack/node_modules/node/bin/node": "another node" }] },
      /slim: more than one layer writes \(1\): provider-pack\/node_modules\/node\/bin\/node/],
    ["a file that a transport layer writes over a shared layer", { full: [large, rest, stable, { ...changing, "pnpm-lock.yaml": "another lock" }] },
      /full: more than one layer writes \(1\): pnpm-lock\.yaml/],
    ["an archive that both transport layers write", { full: [large, rest, stable, { ...changing, "provider-pack.archives/1.tar.zst": "another 1" }] },
      /full: more than one layer writes \(1\): provider-pack\.archives\/1\.tar\.zst/],
    ["a full image in a single layer", { full: [{ ...large, ...rest, ...stable, ...changing }] }, /the full image has 1 layers, not 4/],
    ["the receipt in a shared layer", { full: [large, { ...rest, "provider-pack.archive.json": receipt }, stable, changing] },
      /full: transport content is in the layers both variants share/],
    ["a file outside the pack in the first layer", { full: [{ ...large, "paperclip-runnerd": "elf" }, rest, stable, changing] },
      /full: the first layer holds entries outside the pack's dependency files/],
    ["the Runner's own large output in the first layer", { full: [{ ...large, "provider-pack/dist/cli/sidecar.cjs": "sidecar" }, rest, stable, changing] },
      /full: the first layer holds entries outside the pack's dependency files/],
    ["a large dependency file left in the layer that changes with every build",
      { full: [{ "provider-pack/node_modules/node/bin/node": "node" }, { ...rest, "provider-pack/node_modules/big/big.bin": "big" }, stable, changing] },
      /full: the first layer lacks \(1\): provider-pack\/node_modules\/big\/big\.bin/],
    ["the overlay archive in the stable transport layer",
      { full: [large, rest, { ...stable, "provider-pack.archives/overlay.tar.zst": "overlay" }, changing] },
      /full: the third layer holds something other than transport archives/],
    ["a pack file in the last layer", { full: [large, rest, stable, { ...changing, "provider-pack/extra.json": "{}" }] },
      /full: the last layer holds something other than transport content/],
    ["a stable archive in the layer that changes with every build",
      { full: [large, rest, { "provider-pack.archives/0.tar.zst": "0" }, { ...changing, "provider-pack.archives/1.tar.zst": "1" }] },
      /full: the third layer lacks \(1\): provider-pack\.archives\/1\.tar\.zst/],
    ["the archive of the Runner's own output in the stable layer",
      { full: [large, rest, { ...stable, "provider-pack.archives/2.tar.zst": "2" }, { "provider-pack.archives/overlay.tar.zst": "overlay", "provider-pack.archive.json": receipt }] },
      /full: the third layer holds, against the receipt, \(1\): provider-pack\.archives\/2\.tar\.zst/],
    ["an archive the receipt does not list", { full: [large, rest, { ...stable, "provider-pack.archives/3.tar.zst": "3" }, changing] },
      /full: the third layer holds, against the receipt, \(1\): provider-pack\.archives\/3\.tar\.zst/],
    ["no receipt in the last layer",
      { full: [large, rest, stable, { "provider-pack.archives/2.tar.zst": "2", "provider-pack.archives/overlay.tar.zst": "overlay" }] },
      /full: the last layer lacks \(1\): provider-pack\.archive\.json/],
  ])("refuses %s", async (_label, archives, expected) => {
    expect(await problemsOf(archives)).toMatch(expected);
  });

  it("is a command that prints the layer table of each variant", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [ociScript, "check-layers", ...args], { encoding: "utf8" });
    const slim = ociArchive([large, rest]).archive;
    const passed = run("--slim", slim, "--full", ociArchive([large, rest, stable, changing]).archive);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toMatch(/slim layer 2: sha256:[0-9a-f]{64} +\d+ bytes +\d+ entries +everything else/);
    expect(passed.stdout).toMatch(/full layer 4: sha256:[0-9a-f]{64} +\d+ bytes +\d+ entries +the other transport archives, the overlay archive and the receipt/);
    const failed = run("--slim", slim, "--full", ociArchive([large, rest, stable]).archive);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/the full image has 3 layers, not 4/);
    expect(run().stderr).toMatch(/needs --slim, --full or both/);
    expect(run(slim).stderr).toMatch(/takes no positional argument/);
    expect(run("--variant", "slim").stderr).toMatch(/check-layers does not take --variant/);
  });
});
