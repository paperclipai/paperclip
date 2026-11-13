#!/usr/bin/env node
// OCI archives of the Runner image, as `docker buildx build --output type=oci`
// writes them for one platform. doc/runner-image-contract.md is the contract.
//
//   unpack        writes the file tree of the image in an archive: its layers,
//                 in order. The layout check and the smoke matrix then read
//                 the bytes of the archive, not a second export of the build,
//                 so what they accept is what a registry would receive.
//   check-layers  verifies the layers of the two variants: they are split by
//                 how often their content changes, the full image is the slim
//                 image plus the transport layers, and nothing else is in
//                 those.
//
// Usage:
//   node scripts/runner-image-oci.mjs unpack IMAGE.oci.tar --out DIR
//   node scripts/runner-image-oci.mjs check-layers [--slim SLIM.oci.tar] [--full FULL.oci.tar]
//
// The archive and its layers are read here, not with the system's tar, so
// every platform reads them the same way. Each blob is checked against its
// digest as it is read. The image is `FROM scratch` and every layer only adds
// files, so `unpack` refuses a whiteout, a path that is absolute or has `..`,
// a path written twice, an entry behind a link, and every entry that is not a
// file, a directory or a link.
//
// The image build does not run this file, so it is not an input of the image.

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { RUNNER_IMAGE_PATHS, canonicalJson, parseLayoutArguments, summarize } from "./runner-image-layout.mjs";

const BLOCK = 512;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GZIP_LAYER = /^application\/vnd\.(?:oci\.image\.layer\.v1\.tar\+gzip|docker\.image\.rootfs\.diff\.tar\.gzip)$/;
const ENTRY_KINDS = Object.freeze({ 0: "file", "\0": "file", 1: "hardlink", 2: "link", 5: "directory" });

/** One tar header block, or null for the zero block that ends an archive. */
function parseTarHeader(block) {
  if (block.every((byte) => byte === 0)) return null;
  const text = (start, length) => {
    const field = block.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? length : end).toString("utf8");
  };
  const octal = (start, length, label) => {
    const value = text(start, length).trim();
    if (!/^[0-7]*$/.test(value)) throw new Error(`tar header has a ${label} this reader does not support`);
    return value === "" ? 0 : Number.parseInt(value, 8);
  };
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : block[index];
  if (sum !== octal(148, 8, "checksum")) throw new Error("tar header checksum does not match");
  // Only the POSIX format has a name prefix; GNU tar keeps other fields there.
  const prefix = text(257, 6) === "ustar" && block[263] === 48 ? text(345, 155) : "";
  return {
    name: prefix ? `${prefix}/${text(0, 100)}` : text(0, 100),
    mode: octal(100, 8, "mode"),
    size: octal(124, 12, "size"),
    mtime: octal(136, 12, "time"),
    type: String.fromCharCode(block[156]),
    linkname: text(157, 100),
  };
}

/** The records of a pax extended header: `<length> <key>=<value>\n`. */
function parsePaxRecords(data) {
  /** @type {Record<string, string>} */
  const records = {};
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    const length = Number.parseInt(data.subarray(offset, space).toString("latin1"), 10);
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) throw new Error("tar pax header is malformed");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals === -1) throw new Error("tar pax header is malformed");
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** Header types that only describe the next entry: pax (`x`, and `g` for the whole archive) and GNU long names. */
const DESCRIBING = new Set(["x", "g", "L", "K"]);

/** Applies describing headers and returns the entry each other header stands for. */
function tarEntryReader() {
  /** @type {Record<string, string>} */
  let pax = {};
  /** @type {{ name?: string, linkname?: string }} */
  let gnu = {};
  const cString = (data) => data.subarray(0, data.indexOf(0) === -1 ? data.length : data.indexOf(0)).toString("utf8");
  return {
    describe(header, data) {
      if (header.type === "x") pax = parsePaxRecords(data);
      else if (header.type === "L") gnu.name = cString(data);
      else if (header.type === "K") gnu.linkname = cString(data);
    },
    entry(header) {
      const entry = {
        name: pax.path ?? gnu.name ?? header.name,
        linkname: pax.linkpath ?? gnu.linkname ?? header.linkname,
        size: pax.size === undefined ? header.size : Number(pax.size),
        mtime: pax.mtime === undefined ? header.mtime : Number(pax.mtime),
        mode: header.mode & 0o7777,
        type: header.type,
      };
      pax = {};
      gnu = {};
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`tar entry ${entry.name} has no usable size`);
      return entry;
    },
  };
}

/** Where each member of an uncompressed tar file is, by its exact name. */
function indexTarFile(file) {
  const fd = openSync(file, "r");
  try {
    /** @type {Map<string, { offset: number, size: number }>} */
    const members = new Map();
    const reader = tarEntryReader();
    const block = Buffer.alloc(BLOCK);
    for (let offset = 0; readSync(fd, block, 0, BLOCK, offset) === BLOCK;) {
      const header = parseTarHeader(block);
      if (header === null) break;
      offset += BLOCK;
      if (DESCRIBING.has(header.type)) {
        const data = Buffer.alloc(header.size);
        if (readSync(fd, data, 0, header.size, offset) !== header.size) throw new Error(`${file} ends inside a header`);
        reader.describe(header, data);
        offset += Math.ceil(header.size / BLOCK) * BLOCK;
        continue;
      }
      const entry = reader.entry(header);
      if (members.has(entry.name)) throw new Error(`${file} holds ${entry.name} twice`);
      members.set(entry.name, { offset, size: entry.size });
      offset += Math.ceil(entry.size / BLOCK) * BLOCK;
    }
    return members;
  } finally {
    closeSync(fd);
  }
}

/**
 * Calls `visit(entry, content)` for every entry of a tar stream. `content`
 * yields the entry's bytes; what `visit` leaves unread is skipped.
 * @param {AsyncIterable<Buffer>} source
 * @param {(entry: ReturnType<ReturnType<typeof tarEntryReader>["entry"]>, content: () => AsyncGenerator<Buffer>) => Promise<void> | void} visit
 */
async function readTarStream(source, visit) {
  const iterator = source[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  /** Some bytes, at most `limit`: what is buffered, or the next chunk. Empty at the end of the stream. */
  const some = async (limit) => {
    while (buffered.length === 0) {
      const next = await iterator.next();
      if (next.done) return buffered;
      buffered = next.value;
    }
    const taken = buffered.subarray(0, limit);
    buffered = buffered.subarray(taken.length);
    return taken;
  };
  /** Exactly `length` bytes, or fewer at the end of the stream. */
  const take = async (length) => {
    const parts = [];
    for (let missing = length; missing > 0;) {
      const part = await some(missing);
      if (part.length === 0) break;
      parts.push(part);
      missing -= part.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  };
  const exactly = async (length) => {
    const taken = await take(length);
    if (taken.length !== length) throw new Error("tar stream ends inside an entry");
    return taken;
  };
  const reader = tarEntryReader();
  for (;;) {
    const block = await take(BLOCK);
    if (block.length === 0) break;
    if (block.length !== BLOCK) throw new Error("tar stream ends inside a header");
    const header = parseTarHeader(block);
    if (header === null) break;
    if (DESCRIBING.has(header.type)) {
      reader.describe(header, (await exactly(Math.ceil(header.size / BLOCK) * BLOCK)).subarray(0, header.size));
      continue;
    }
    const entry = reader.entry(header);
    let remaining = entry.size;
    const content = async function* () {
      while (remaining > 0) {
        const chunk = await some(remaining);
        if (chunk.length === 0) throw new Error("tar stream ends inside an entry");
        remaining -= chunk.length;
        yield chunk;
      }
    };
    await visit(entry, content);
    for await (const _unread of content()) { /* skip what the visitor left */ }
    await exactly((BLOCK - (entry.size % BLOCK)) % BLOCK);
  }
  // Read to the end, so the caller's digest covers the whole blob.
  while (!(await iterator.next()).done) { /* trailing zero blocks */ }
}

/**
 * One image in an OCI archive: its manifest descriptor and its layers. A
 * member is found by its exact name (`index.json`, `blobs/sha256/<hex>`), as
 * buildx writes them. The manifest is checked against its digest here, and
 * each layer when `readLayer` or `verifyBlobs` reads it.
 *
 * An archive from buildx holds one image. A layout that holds several names
 * each with the annotation `org.opencontainers.image.ref.name`; `ref` then
 * says which one to read.
 * @param {string} archive
 * @param {{ ref?: string | null }} [options]
 */
export function readOciArchive(archive, { ref = null } = {}) {
  const members = indexTarFile(archive);
  const located = (name) => {
    const member = members.get(name);
    if (!member) throw new Error(`${archive} has no member ${name}`);
    return member;
  };
  const bytes = (name) => {
    const { offset, size } = located(name);
    const data = Buffer.alloc(size);
    const fd = openSync(archive, "r");
    try {
      if (readSync(fd, data, 0, size, offset) !== size) throw new Error(`${archive} ends inside ${name}`);
    } finally {
      closeSync(fd);
    }
    return data;
  };
  const blobName = (digest) => {
    if (!DIGEST.test(digest ?? "")) throw new Error(`${archive} names a blob by something other than a sha256 digest`);
    return `blobs/sha256/${digest.slice(7)}`;
  };
  const sha256 = (data) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
  const index = JSON.parse(bytes("index.json").toString("utf8"));
  if (!Array.isArray(index.manifests)) throw new Error(`${archive} has no list of manifests`);
  const named = ref === null ? index.manifests : index.manifests.filter((entry) => entry.annotations?.["org.opencontainers.image.ref.name"] === ref);
  if (named.length !== 1) {
    throw new Error(ref === null ? `${archive} must hold exactly one image manifest` : `${archive} must hold exactly one image named ${ref}`);
  }
  const { mediaType, digest, size } = named[0];
  const manifestBytes = bytes(blobName(digest));
  if (sha256(manifestBytes) !== digest) throw new Error(`${archive}: the manifest does not have the digest the index names`);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!Array.isArray(manifest.layers)) throw new Error(`${archive} holds an index, not one platform's image; build without attestations`);
  /** The digest of a blob's bytes as the archive holds them. */
  const blobDigest = async (name) => {
    const { offset, size: length } = located(name);
    const hash = createHash("sha256");
    if (length > 0) for await (const chunk of createReadStream(archive, { start: offset, end: offset + length - 1 })) hash.update(chunk);
    return `sha256:${hash.digest("hex")}`;
  };
  for (const layer of manifest.layers) {
    if (!GZIP_LAYER.test(layer.mediaType ?? "")) throw new Error(`${archive}: layer ${layer.digest} is ${layer.mediaType}, not a gzip tar`);
    located(blobName(layer.digest));
  }
  return {
    archive,
    descriptor: { mediaType, digest, size },
    /** @type {{ mediaType: string, digest: string, size: number }[]} */
    layers: manifest.layers.map((layer) => ({ mediaType: layer.mediaType, digest: layer.digest, size: layer.size })),
    /** Fails unless the config and every layer of the image are in the archive with their digests. */
    async verifyBlobs() {
      for (const blob of [manifest.config, ...manifest.layers]) {
        if (await blobDigest(blobName(blob?.digest)) !== blob.digest) throw new Error(`${archive}: blob ${blob.digest} does not have its digest`);
      }
    },
    /** Visits every entry of one layer and fails when the blob does not have its digest. */
    async readLayer(layer, visit) {
      const { offset, size: bytesInArchive } = located(blobName(layer.digest));
      if (bytesInArchive !== layer.size || bytesInArchive === 0) {
        throw new Error(`${archive}: layer ${layer.digest} is ${bytesInArchive} bytes, the manifest says ${layer.size}`);
      }
      const hash = createHash("sha256");
      const hashing = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } });
      const gunzip = createGunzip({ chunkSize: 1024 * 1024 });
      const feeding = pipeline(createReadStream(archive, { start: offset, end: offset + bytesInArchive - 1 }), hashing, gunzip);
      // A failure below destroys the streams; that rejection is not the cause.
      feeding.catch(() => {});
      try {
        await readTarStream(gunzip, visit);
      } catch (error) {
        gunzip.destroy();
        throw error;
      }
      await feeding;
      if (`sha256:${hash.digest("hex")}` !== layer.digest) throw new Error(`${archive}: layer ${layer.digest} does not have its digest`);
    },
  };
}

/**
 * The path of a layer entry relative to the image root, and its kind. Throws
 * for an entry an additive layer of a `FROM scratch` image cannot have.
 * Returns null for the root directory itself.
 */
function layerEntry(entry) {
  const kind = ENTRY_KINDS[entry.type];
  if (!kind) throw new Error(`layer entry ${entry.name} is of type ${JSON.stringify(entry.type)}, not a file, a directory or a link`);
  const clean = (name, label) => {
    if (name.startsWith("/")) throw new Error(`layer ${label} ${name} is absolute`);
    const relative = name.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (relative === "" || relative === ".") return null;
    const parts = relative.split("/");
    if (relative.includes("\0") || parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`layer ${label} ${name} is not a plain relative path`);
    }
    if (parts.some((part) => part.startsWith(".wh."))) throw new Error(`layer ${label} ${name} is a whiteout: the image only adds files`);
    return relative;
  };
  const name = clean(entry.name, "entry");
  if (name === null) {
    if (kind !== "directory") throw new Error(`layer entry ${entry.name} replaces the image root`);
    return null;
  }
  // A link's target is text and is never followed here. A hard link names a file of the image.
  const target = kind === "hardlink" ? clean(entry.linkname, "hard link target") : kind === "link" ? entry.linkname : null;
  if (kind === "hardlink" && target === null) throw new Error(`layer entry ${entry.name} is a hard link to the image root`);
  return { name, kind, target, mode: entry.mode, size: entry.size, mtime: entry.mtime };
}

/**
 * The entries of every layer of the image in an archive, in order.
 * @param {string} archive
 */
export async function listOciLayers(archive) {
  const image = readOciArchive(archive);
  const layers = [];
  for (const layer of image.layers) {
    /** @type {NonNullable<ReturnType<typeof layerEntry>>[]} */
    const entries = [];
    await image.readLayer(layer, (raw) => {
      const entry = layerEntry(raw);
      if (entry) entries.push(entry);
    });
    layers.push({ digest: layer.digest, bytes: layer.size, entries });
  }
  return { digest: image.descriptor.digest, layers };
}

/**
 * Writes the file tree of the image in an archive to `destination`, which
 * must be empty or absent: every layer in order. Returns the image digest.
 * @param {string} archive
 * @param {string} destination
 */
export async function unpackOciImage(archive, destination) {
  const image = readOciArchive(archive);
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length > 0) throw new Error(`${destination} is not empty`);
  const stat = (file) => {
    try {
      return lstatSync(file);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
      throw error;
    }
  };
  /** The place of an entry, after its parents are known to be real directories. */
  const place = (name) => {
    let current = destination;
    const parts = name.split("/");
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const parent = stat(current);
      if (parent === null) mkdirSync(current, { mode: 0o755 });
      else if (!parent.isDirectory()) throw new Error(`layer entry ${name} is behind ${path.relative(destination, current)}, which is not a directory`);
    }
    return path.join(current, parts.at(-1));
  };
  /** @type {Map<string, number>} */
  const directoryModes = new Map();
  let files = 0;
  for (const layer of image.layers) {
    await image.readLayer(layer, async (raw, content) => {
      const entry = layerEntry(raw);
      if (entry === null) return;
      const target = place(entry.name);
      const existing = stat(target);
      if (entry.kind === "directory") {
        if (existing === null) mkdirSync(target, { mode: 0o755 });
        else if (!existing.isDirectory()) throw new Error(`a layer writes ${entry.name} again, as a directory`);
        directoryModes.set(target, entry.mode);
        return;
      }
      if (existing !== null) throw new Error(`a layer writes ${entry.name} again: the image only adds files`);
      files += 1;
      if (entry.kind === "link") {
        symlinkSync(/** @type {string} */ (entry.target), target);
      } else if (entry.kind === "hardlink") {
        const source = place(/** @type {string} */ (entry.target));
        if (!stat(source)?.isFile()) throw new Error(`layer entry ${entry.name} is a hard link to ${entry.target}, which is not a file of the image`);
        linkSync(source, target);
      } else {
        const fd = openSync(target, "wx", 0o600);
        try {
          for await (const chunk of content()) writeSync(fd, chunk);
        } finally {
          closeSync(fd);
        }
        chmodSync(target, entry.mode);
        utimesSync(target, entry.mtime, entry.mtime);
      }
    });
  }
  // Last, and children first: a directory may not be writable by its owner.
  for (const [directory, mode] of [...directoryModes].sort(([left], [right]) => right.length - left.length)) chmodSync(directory, mode);
  return { digest: image.descriptor.digest, layers: image.layers.length, files };
}

const SLIM_LAYERS = Object.freeze([
  "provider pack dependency files of 1 MiB or more",
  "everything else",
]);
/**
 * The layers of each variant, in order. Content that changes rarely is apart
 * from content that changes with every Runner source change, so a new image
 * shares its large layers with the one before it. The full image is the slim
 * image plus two layers that hold the transport archives and their receipt
 * and nothing else, so a reader can fetch all of them without the pack.
 *
 * "Dependency files" are the pack's files outside `dist`, which the Runner's
 * own build writes. A large file under `dist` changes with the Runner's
 * source, so it and its transport archive are with the content that does.
 */
export const RUNNER_IMAGE_LAYERS = Object.freeze({
  slim: SLIM_LAYERS,
  full: Object.freeze([
    ...SLIM_LAYERS,
    "transport archives of the files in layer 1",
    "the other transport archives, the overlay archive and the receipt",
  ]),
});

/**
 * Verifies the layer rule on OCI archives of one platform's image. With both
 * variants it also verifies that the full image starts with the slim image's
 * layers.
 * @param {{ slim?: string | null, full?: string | null }} archives
 * @returns {Promise<{ problems: string[], layers: Record<string, { role: string, digest: string, bytes: number, entries: number }[]> }>}
 */
export async function checkRunnerImageLayers({ slim = null, full = null }) {
  if (slim === null && full === null) throw new Error("check-layers needs --slim, --full or both");
  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, { role: string, digest: string, bytes: number, entries: number }[]>} */
  const layers = {};
  const pack = RUNNER_IMAGE_PATHS.providerPack;
  const archivesDirectory = RUNNER_IMAGE_PATHS.providerPackArchives;
  const receiptPath = RUNNER_IMAGE_PATHS.providerPackArchiveReceipt;
  const transport = (name) => name === receiptPath || name === archivesDirectory || name.startsWith(`${archivesDirectory}/`);
  // Transport content anywhere else: under another directory, or under another name.
  const transportLike = (name) => name.split("/").some((part) => part === receiptPath || part === archivesDirectory || part.endsWith(".tar.zst"));
  /** @type {Record<string, { digest: string, names: string[], files: string[] }[]>} */
  const images = {};
  for (const [variant, archive] of Object.entries({ slim, full })) {
    if (archive === null) continue;
    const image = await listOciLayers(archive);
    const roles = RUNNER_IMAGE_LAYERS[variant];
    layers[variant] = image.layers.map((layer, position) => ({
      role: roles[position] ?? "unexpected layer", digest: layer.digest, bytes: layer.bytes, entries: layer.entries.length,
    }));
    if (image.layers.length !== roles.length) {
      problems.push(`the ${variant} image has ${image.layers.length} layers, not ${roles.length}`);
      continue;
    }
    const listed = image.layers.map((layer) => ({
      digest: layer.digest,
      names: [...new Set(layer.entries.map((entry) => entry.name))],
      files: [...new Set(layer.entries.filter((entry) => entry.kind !== "directory").map((entry) => entry.name))],
    }));
    images[variant] = listed;
    const [large, rest] = listed;
    // Each layer only adds. A directory may be in several layers; a file or a link is in one.
    /** @type {Map<string, { layers: number, file: boolean }>} */
    const written = new Map();
    for (const layer of listed) {
      const files = new Set(layer.files);
      for (const name of layer.names) {
        const entry = written.get(name) ?? { layers: 0, file: false };
        written.set(name, { layers: entry.layers + 1, file: entry.file || files.has(name) });
      }
    }
    summarize(problems, `${variant}: more than one layer writes`, [...written].filter(([, entry]) => entry.file && entry.layers > 1).map(([name]) => name));
    summarize(problems, `${variant}: the first layer holds entries outside the pack's dependency files`,
      large.names.filter((name) => name !== pack && (!name.startsWith(`${pack}/`) || name === `${pack}/dist` || name.startsWith(`${pack}/dist/`))));
    summarize(problems, `${variant}: transport content is in the layers both variants share`,
      [...large.names, ...rest.names].filter((name) => transport(name) || transportLike(name)));
    if (!rest.files.includes(RUNNER_IMAGE_PATHS.manifest)) problems.push(`${variant}: the second layer does not hold ${RUNNER_IMAGE_PATHS.manifest}`);
  }
  if (images.full) {
    const [large, , stable, changing] = images.full;
    const numbered = (layer) => layer.files.filter((name) => name !== `${archivesDirectory}/overlay.tar.zst` && name !== receiptPath);
    summarize(problems, "full: the third layer holds something other than transport archives",
      stable.names.filter((name) => name !== archivesDirectory && !numbered(stable).includes(name)));
    summarize(problems, "full: the last layer holds something other than transport content", changing.names.filter((name) => !transport(name)));
    summarize(problems, "full: the last layer lacks", [receiptPath, `${archivesDirectory}/overlay.tar.zst`].filter((name) => !changing.files.includes(name)));
    /** @type {{ path: string }[] | null} */
    let files = null;
    if (changing.files.includes(receiptPath)) {
      try {
        files = JSON.parse(await readLayerFile(/** @type {string} */ (full), 3, receiptPath)).files;
      } catch {
        problems.push("full: the receipt in the last layer is not readable");
      }
    }
    if (Array.isArray(files)) {
      // Archive N holds file N of the receipt. The receipt decides the layer.
      const own = (file) => file.path === "dist" || file.path.startsWith("dist/");
      const archiveOf = (file) => `${archivesDirectory}/${files.indexOf(file)}.tar.zst`;
      const expect = (label, actual, expected) => {
        summarize(problems, `full: ${label} lacks`, expected.filter((name) => !actual.includes(name)));
        summarize(problems, `full: ${label} holds, against the receipt,`, actual.filter((name) => !expected.includes(name)));
      };
      expect("the first layer", large.files, files.filter((file) => !own(file)).map((file) => `${pack}/${file.path}`));
      expect("the third layer", numbered(stable), files.filter((file) => !own(file)).map(archiveOf));
      expect("the last layer", numbered(changing), files.filter(own).map(archiveOf));
    }
  }
  if (images.slim && images.full) {
    // The same blobs in the same order, not only the same files.
    const shared = images.slim.map((layer) => layer.digest);
    if (canonicalJson(images.full.slice(0, shared.length).map((layer) => layer.digest)) !== canonicalJson(shared)) {
      problems.push("the full image does not start with the layers of the slim image");
    }
  }
  return { problems, layers };
}

/** The text of one file in one layer of an archive. */
async function readLayerFile(archive, position, name) {
  const image = readOciArchive(archive);
  /** @type {Buffer[] | null} */
  let chunks = null;
  await image.readLayer(image.layers[position], async (raw, content) => {
    if (layerEntry(raw)?.name !== name) return;
    chunks = [];
    for await (const chunk of content()) chunks.push(chunk);
  });
  if (chunks === null) throw new Error(`${name} is not in layer ${position + 1}`);
  return Buffer.concat(chunks).toString("utf8");
}

const COMMAND_FLAGS = Object.freeze({
  unpack: { out: "value" },
  "check-layers": { slim: "value", full: "value" },
});

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command !== "unpack" && command !== "check-layers") {
      throw new Error("Usage: runner-image-oci.mjs unpack IMAGE.oci.tar --out DIR | check-layers [--slim TAR] [--full TAR]");
    }
    const { positional, flags } = parseLayoutArguments(command, rest, COMMAND_FLAGS[command]);
    if (command === "unpack") {
      if (positional.length !== 1 || typeof flags.out !== "string") throw new Error("unpack takes exactly one OCI archive and --out DIR");
      const result = await unpackOciImage(path.resolve(positional[0]), path.resolve(flags.out));
      process.stdout.write(`Unpacked ${result.files} files from the ${result.layers} layers of ${result.digest} into ${path.resolve(flags.out)}.\n`);
    } else {
      if (positional.length > 0) throw new Error(`check-layers takes no positional argument: ${positional[0]}`);
      const archive = (name) => (flags[name] === undefined ? null : path.resolve(String(flags[name])));
      const { problems, layers } = await checkRunnerImageLayers({ slim: archive("slim"), full: archive("full") });
      for (const [variant, rows] of Object.entries(layers)) {
        for (const [position, layer] of rows.entries()) {
          process.stdout.write(`${variant} layer ${position + 1}: ${layer.digest} ${String(layer.bytes).padStart(11)} bytes ${String(layer.entries).padStart(6)} entries  ${layer.role}\n`);
        }
      }
      if (problems.length > 0) {
        process.stderr.write(`Runner image layer check failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
        process.exit(1);
      }
      process.stdout.write("Runner image layer check passed.\n");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
