import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SLIM_DIGEST_ANNOTATION,
  createLegRecord,
  parsePublishArguments,
  readRunnerImageManifest,
  runPublishCommand,
  runnerImageTags,
  runnerLockState,
  runnerPublicationState,
  verifyLegRecords,
  verifyPublishedIndex,
} from "../../../scripts/runner-image-publish.mjs";
import { readOciArchive } from "../../../scripts/runner-image-oci.mjs";

/**
 * The checks the Runner image workflow runs around publication. The image has
 * two variants under two tags, and consumers verify their attestations. So
 * the bytes published must be the ones the build legs checked, a tag must
 * never be written on a guess, and a publication that stopped half way must
 * neither block its inputs nor leave a full image paired with another run's
 * slim image.
 */

const INPUTS = "1".repeat(64);
const REVISION = "a".repeat(40);
const TAGS = runnerImageTags(INPUTS);
const sha256 = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const scratch = mkdtempSync(path.join(tmpdir(), "runner-image-publish-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;

/** What `docker buildx build --output type=oci --metadata-file` writes for one image with these layers. */
function ociArchive(directory: string, name: string, layers: string[]) {
  const layout = path.join(directory, `${name}-layout`);
  mkdirSync(path.join(layout, "blobs", "sha256"), { recursive: true });
  const blob = (bytes: string) => {
    writeFileSync(path.join(layout, "blobs", "sha256", sha256(bytes).slice(7)), bytes);
    return { digest: sha256(bytes), size: bytes.length };
  };
  const manifest = blob(JSON.stringify({
    schemaVersion: 2, config: blob(`config of ${name}`),
    layers: layers.map((layer) => ({ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", ...blob(layer) })),
  }));
  writeFileSync(path.join(layout, "index.json"), JSON.stringify({
    schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", ...manifest }],
  }));
  writeFileSync(path.join(layout, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  const archive = path.join(directory, `${name}.oci.tar`);
  // The members buildx writes. `tar -C layout .` would name them ./index.json and ./blobs/...
  expect(spawnSync("tar", ["-cf", archive, "-C", layout, "blobs", "index.json", "oci-layout"]).status).toBe(0);
  writeFileSync(path.join(directory, `${name}.metadata.json`), JSON.stringify({ "containerimage.digest": manifest.digest }));
  return manifest.digest;
}

/** What one build leg uploads: one layout with both variants, and the record of what it verified. */
async function leg(directory: string, architecture: string, options: {
  inputsDigest?: string; sourceRevision?: string; publication?: boolean; slim?: string[]; full?: string[];
} = {}) {
  const { inputsDigest = INPUTS, sourceRevision = REVISION, publication = true } = options;
  const slim = options.slim ?? [`large ${architecture}`, `rest ${architecture}`];
  const full = options.full ?? [...slim, `archives ${architecture}`, `overlay ${architecture}`];
  const root = path.join(directory, architecture);
  mkdirSync(path.join(root, "tree"), { recursive: true });
  const images = { slim: ociArchive(root, "slim", slim), full: ociArchive(root, "full", full) };
  writeFileSync(path.join(root, "tree", "runner-image.json"), JSON.stringify({
    inputsDigest: { digest: inputsDigest }, sourceRevision, publication, platform: { os: "linux", architecture },
  }));
  const record = await createLegRecord({
    architecture,
    archives: { slim: path.join(root, "slim.oci.tar"), full: path.join(root, "full.oci.tar") },
    metadataFiles: { slim: path.join(root, "slim.metadata.json"), full: path.join(root, "full.metadata.json") },
    tree: path.join(root, "tree"),
    layout: path.join(root, "images.oci.tar"),
  });
  writeFileSync(path.join(root, "record.json"), JSON.stringify(record));
  return { record, images };
}

async function legs(options: Record<string, object> = {}) {
  const directory = path.join(scratch, String(sequence += 1));
  const images: Record<string, { slim: string; full: string }> = {};
  for (const architecture of ["amd64", "arm64"]) ({ images: images[architecture] } = await leg(directory, architecture, options[architecture]));
  return { directory, images };
}

describe("verified build legs", () => {
  it("accepts both variants of each architecture for this run's inputs and commit", async () => {
    const { directory, images } = await legs();
    await expect(verifyLegRecords({ directory, inputsDigest: INPUTS, sourceRevision: REVISION })).resolves.toEqual({
      slim_amd64: images.amd64.slim, full_amd64: images.amd64.full, slim_arm64: images.arm64.slim, full_arm64: images.arm64.full,
    });
  });

  it("hands over one layout that names both variants and stores their shared layers once", async () => {
    const { directory, images } = await legs();
    const layout = path.join(directory, "amd64", "images.oci.tar");
    const read = (member: string) => spawnSync("tar", ["-xOf", layout, member], { encoding: "utf8" }).stdout;
    expect(JSON.parse(read("index.json")).manifests.map((entry: { digest: string; annotations: Record<string, string> }) =>
      [entry.annotations["org.opencontainers.image.ref.name"], entry.digest])).toEqual([["slim", images.amd64.slim], ["full", images.amd64.full]]);
    const blobs = spawnSync("tar", ["-tf", layout], { encoding: "utf8" }).stdout.split("\n").filter((name) => /^blobs\/sha256\/[0-9a-f]{64}$/.test(name));
    // Two manifests, two configs, and four layers: the two shared ones are not stored twice.
    expect(blobs).toHaveLength(8);
    expect(new Set(blobs).size).toBe(8);
    expect(JSON.parse(read(`blobs/sha256/${images.amd64.full.slice(7)}`)).layers.slice(0, 2))
      .toEqual(JSON.parse(read(`blobs/sha256/${images.amd64.slim.slice(7)}`)).layers);
    // Each image can be read alone by its name, with every blob under its digest: what a push does.
    for (const variant of ["slim", "full"] as const) {
      const image = readOciArchive(layout, { ref: variant });
      expect(image.descriptor.digest).toBe(images.amd64[variant]);
      await expect(image.verifyBlobs()).resolves.toBeUndefined();
    }
    expect(() => readOciArchive(layout)).toThrow(/must hold exactly one image manifest/);
    expect(() => readOciArchive(layout, { ref: "candidate" })).toThrow(/must hold exactly one image named candidate/);
  });

  it("does not record an archive that lacks a blob of its image, or whose members have other names", async () => {
    const directory = path.join(scratch, String(sequence += 1));
    await leg(directory, "amd64");
    const root = path.join(directory, "amd64");
    const input = {
      architecture: "amd64",
      archives: { slim: path.join(root, "slim.oci.tar"), full: path.join(root, "full.oci.tar") },
      metadataFiles: { slim: path.join(root, "slim.metadata.json"), full: path.join(root, "full.metadata.json") },
      tree: path.join(root, "tree"),
      layout: path.join(root, "again.oci.tar"),
    };
    // The full archive without one of its layers.
    const layer = readOciArchive(input.archives.full).layers[3].digest;
    rmSync(path.join(root, "full-layout", "blobs", "sha256", layer.slice(7)));
    expect(spawnSync("tar", ["-cf", input.archives.full, "-C", path.join(root, "full-layout"), "blobs", "index.json", "oci-layout"]).status).toBe(0);
    await expect(createLegRecord(input)).rejects.toThrow(/has no member blobs\/sha256\//);
    // An archive of `.`: the names a registry tool does not find.
    expect(spawnSync("tar", ["-cf", input.archives.slim, "-C", path.join(root, "slim-layout"), "."]).status).toBe(0);
    await expect(createLegRecord(input)).rejects.toThrow(/has no member index\.json/);
  });

  it("refuses a leg that built other inputs or another commit", async () => {
    const otherInputs = await legs({ arm64: { inputsDigest: "2".repeat(64) } });
    await expect(verifyLegRecords({ directory: otherInputs.directory, inputsDigest: INPUTS, sourceRevision: REVISION }))
      .rejects.toThrow(/arm64: the image was built from other inputs/);
    const otherCommit = await legs({ amd64: { sourceRevision: "b".repeat(40) } });
    await expect(verifyLegRecords({ directory: otherCommit.directory, inputsDigest: INPUTS, sourceRevision: REVISION }))
      .rejects.toThrow(/amd64: the image was built at another commit/);
  });

  it("refuses a layout that changed after its leg recorded it, a record without a variant, and a missing leg", async () => {
    const { directory } = await legs();
    appendFileSync(path.join(directory, "amd64", "images.oci.tar"), "tampered");
    await expect(verifyLegRecords({ directory, inputsDigest: INPUTS, sourceRevision: REVISION }))
      .rejects.toThrow(/amd64: the image layout does not match its record/);
    const oneVariant = await legs();
    const recordPath = path.join(oneVariant.directory, "arm64", "record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(recordPath, JSON.stringify({ ...record, images: { full: record.images.full } }));
    await expect(verifyLegRecords({ directory: oneVariant.directory, inputsDigest: INPUTS, sourceRevision: REVISION }))
      .rejects.toThrow(/arm64: the record has no slim image digest/);
    const missing = await legs();
    rmSync(path.join(missing.directory, "arm64"), { recursive: true });
    await expect(verifyLegRecords({ directory: missing.directory, inputsDigest: INPUTS, sourceRevision: REVISION })).rejects.toThrow();
  });

  it.each<[string, object, RegExp]>([
    ["a full image that does not start with the slim image's layers", { full: ["another large", "rest amd64", "archives", "overlay"] }, /does not start with the layers of the slim image/],
    ["a full image with the slim layers in another order", { full: ["rest amd64", "large amd64", "archives", "overlay"] }, /does not start with the layers of the slim image/],
    ["a full image that is the slim image", { full: ["large amd64", "rest amd64"] }, /has no layer of its own/],
    ["a build that is not a publication build", { publication: false }, /Only a publication build can be recorded/],
  ])("does not record %s", async (_label, options, expected) => {
    await expect(leg(path.join(scratch, String(sequence += 1)), "amd64", options)).rejects.toThrow(expected);
  });

  it("does not record a tree that is for another architecture, or an archive that is not the image the build reported", async () => {
    const directory = path.join(scratch, String(sequence += 1));
    await leg(directory, "amd64");
    const root = path.join(directory, "amd64");
    const input = {
      architecture: "amd64",
      archives: { slim: path.join(root, "slim.oci.tar"), full: path.join(root, "full.oci.tar") },
      metadataFiles: { slim: path.join(root, "slim.metadata.json"), full: path.join(root, "full.metadata.json") },
      tree: path.join(root, "tree"),
      layout: path.join(root, "again.oci.tar"),
    };
    await expect(createLegRecord({ ...input, architecture: "arm64" })).rejects.toThrow(/another architecture/);
    await expect(createLegRecord({ ...input, archives: { slim: input.archives.full, full: input.archives.full } }))
      .rejects.toThrow(/The slim archive is not the image its build reported/);
  });
});

describe("registry lookups", () => {
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] }));
  const respond = (status: number, body: Buffer | string = "", headers: Record<string, string> = {}) =>
    new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers });
  function registry(manifest: () => Response, token: () => Response = () => respond(200, JSON.stringify({ token: "t" }))) {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      requests.push({ url, headers: init.headers });
      return url.includes("/token?") ? token() : manifest();
    };
    return { requests, options: { fetchImpl, sleep: async () => {} } };
  }

  it("reports a tag that exists, with the digest of the registry bytes", async () => {
    const { requests, options } = registry(() => respond(200, index, { "docker-content-digest": sha256(index) }));
    const result = await readRunnerImageManifest(`inputs-${INPUTS}`, options);
    expect(result).toMatchObject({ state: "present", digest: sha256(index) });
    expect(requests.map((request) => request.url)).toEqual([
      "https://ghcr.io/token?service=ghcr.io&scope=repository:paperclipai/paperclip-runner:pull",
      `https://ghcr.io/v2/paperclipai/paperclip-runner/manifests/inputs-${INPUTS}`,
    ]);
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(requests[1].headers.authorization).toBe("Bearer t");
  });

  it("reports a missing tag only when the registry says it is missing", async () => {
    await expect(readRunnerImageManifest("inputs-x", registry(() => respond(404)).options)).resolves.toEqual({ state: "absent" });
  });

  it.each<[string, () => Response, (() => Response) | undefined]>([
    ["the token request is refused", () => respond(200, index), () => respond(403)],
    ["the token response has no token", () => respond(200, index), () => respond(200, "{}")],
    ["the manifest request is unauthorized", () => respond(401), undefined],
    ["the manifest request is denied", () => respond(403), undefined],
    ["the registry keeps failing", () => respond(503), undefined],
  ])("does not guess when %s", async (_label, manifest, token) => {
    const result = await readRunnerImageManifest("inputs-x", registry(manifest, token).options);
    expect(result.state).toBe("unknown");
  });

  it("retries a transient registry error", async () => {
    let calls = 0;
    const { options } = registry(() => ((calls += 1) < 3 ? respond(502) : respond(404)));
    await expect(readRunnerImageManifest("inputs-x", options)).resolves.toEqual({ state: "absent" });
    expect(calls).toBe(3);
  });

  it.each<[string, () => Promise<Response>]>([
    ["the registry cannot be reached", async () => { throw new TypeError("fetch failed"); }],
    ["the token response is not JSON", async () => respond(200, "<html>gateway</html>")],
  ])("does not guess, and does not crash, when %s", async (_label, token) => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return token(); };
    const result = await readRunnerImageManifest("inputs-x", { fetchImpl, sleep: async () => {} });
    expect(result.state).toBe("unknown");
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("does not guess when the manifest request cannot be completed", async () => {
    let manifests = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes("/token?")) return respond(200, JSON.stringify({ token: "t" }));
      manifests += 1;
      throw new TypeError("fetch failed");
    };
    await expect(readRunnerImageManifest("inputs-x", { fetchImpl, sleep: async () => {} })).resolves.toMatchObject({ state: "unknown" });
    expect(manifests).toBe(5);
  });

  it("authenticates with the credentials it is given and rejects bytes that do not match their digest", async () => {
    const { requests, options } = registry(() => respond(200, index, { "docker-content-digest": sha256("other") }));
    await expect(readRunnerImageManifest("inputs-x", { ...options, credentials: { username: "u", password: "p" } }))
      .rejects.toThrow(/does not match the manifest bytes/);
    expect(requests[0].headers.authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });
});

describe("published index", () => {
  const legDigests = { amd64: sha256("manifest amd64"), arm64: sha256("manifest arm64") };
  const entry = (architecture: string, digest: string) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json", digest, size: 500, platform: { os: "linux", architecture },
  });
  const bytes = (manifests: object[]) => Buffer.from(JSON.stringify({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests,
  }));

  it("accepts an index of exactly the two verified images and returns its digest", () => {
    const index = bytes([entry("amd64", legDigests.amd64), entry("arm64", legDigests.arm64)]);
    expect(verifyPublishedIndex(index, legDigests)).toBe(sha256(index));
  });

  it("requires the full index, and no other, to name its slim index", () => {
    const slimDigest = sha256("slim index");
    const manifests = [entry("amd64", legDigests.amd64), entry("arm64", legDigests.arm64)];
    const full = Buffer.from(JSON.stringify({
      schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests, annotations: { [SLIM_DIGEST_ANNOTATION]: slimDigest },
    }));
    expect(verifyPublishedIndex(full, legDigests, { slimDigest })).toBe(sha256(full));
    expect(() => verifyPublishedIndex(full, legDigests, { slimDigest: sha256("an earlier run's slim index") }))
      .toThrow(/The full index does not name the slim index published with it/);
    expect(() => verifyPublishedIndex(bytes(manifests), legDigests, { slimDigest })).toThrow(/does not name the slim index/);
    expect(() => verifyPublishedIndex(full, legDigests)).toThrow(/Only the full index may name a slim index/);
  });

  const both = [entry("amd64", legDigests.amd64), entry("arm64", legDigests.arm64)];
  const extra = (platform: object | undefined) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json", digest: sha256("extra"), size: 500, ...(platform ? { platform } : {}),
  });

  it.each<[string, object[]]>([
    ["an image no leg verified", [entry("amd64", legDigests.amd64), entry("arm64", sha256("unverified"))]],
    ["the images under the wrong architectures", [entry("amd64", legDigests.arm64), entry("arm64", legDigests.amd64)]],
    ["one architecture only", [entry("amd64", legDigests.amd64)]],
    ["one architecture twice", [entry("amd64", legDigests.amd64), entry("amd64", legDigests.amd64), entry("arm64", legDigests.arm64)]],
    ["an attestation manifest beside the images", [...both, extra({ os: "unknown", architecture: "unknown" })]],
    ["an entry without a platform", [...both, extra(undefined)]],
    ["an image for another operating system", [...both, extra({ os: "windows", architecture: "amd64" })]],
    ["an image for another architecture", [...both, extra({ os: "linux", architecture: "riscv64" })]],
    ["a variant on the amd64 image", [{ ...entry("amd64", legDigests.amd64), platform: { os: "linux", architecture: "amd64", variant: "v8" } },
      entry("arm64", legDigests.arm64)]],
    ["another arm64 variant", [entry("amd64", legDigests.amd64),
      { ...entry("arm64", legDigests.arm64), platform: { os: "linux", architecture: "arm64", variant: "v7" } }]],
  ])("refuses an index with %s", (_label, manifests) => {
    expect(() => verifyPublishedIndex(bytes(manifests), legDigests)).toThrow();
  });

  it("accepts linux/arm64 with the variant v8, which some BuildKit versions record", () => {
    const index = bytes([entry("amd64", legDigests.amd64),
      { ...entry("arm64", legDigests.arm64), platform: { os: "linux", architecture: "arm64", variant: "v8" } }]);
    expect(verifyPublishedIndex(index, legDigests)).toBe(sha256(index));
  });

  it("needs a recorded image for each architecture, and no other", () => {
    expect(() => verifyPublishedIndex(bytes(both), { amd64: legDigests.amd64 })).toThrow(/one recorded image for each architecture/);
    expect(() => verifyPublishedIndex(bytes(both), { ...legDigests, riscv64: sha256("extra") })).toThrow(/one recorded image for each architecture/);
  });
});

describe("lockfile state", () => {
  function context() {
    const directory = path.join(scratch, String(sequence += 1));
    mkdirSync(path.join(directory, "packages", "paperclip-runner"), { recursive: true });
    writeFileSync(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(path.join(directory, "packages", "paperclip-runner", "package.json"), "{}\n");
    return directory;
  }
  const answer = (status: number | null, stderr = "", extra: object = {}) => {
    const calls: { command: string; args: string[]; options: { cwd?: string } }[] = [];
    const run = (command: string, args: string[], options: object) => {
      calls.push({ command, args, options });
      return { status, stdout: "", stderr, ...extra };
    };
    return { calls, run };
  };

  it("asks pnpm the image build's own question, offline and without installing", () => {
    const directory = context();
    const { calls, run } = answer(0);
    expect(runnerLockState(directory, { run }).state).toBe("current");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("pnpm");
    expect(calls[0].options.cwd).toBe(directory);
    expect(calls[0].args).toEqual(["install", "--frozen-lockfile", "--lockfile-only", "--offline", "--ignore-scripts",
      "--filter", "@paperclipai/paperclip-runner..."]);
  });

  it.each([
    [" ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with <ROOT>/packages/paperclip-runner/package.json"],
    [" ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation. The current \"patchedDependencies\" configuration doesn't match the value found in the lockfile"],
  ])("reports a lockfile the manifests have moved past as behind: %s", (stderr) => {
    const result = runnerLockState(context(), { run: answer(1, stderr).run });
    expect(result.state).toBe("behind");
    expect(result.detail).toContain("ERR_PNPM_");
  });

  it.each<[string, number | null, string, object]>([
    ["a broken lockfile", 1, " ERR_PNPM_BROKEN_LOCKFILE  The lockfile is broken", {}],
    ["a failure pnpm does not name", 1, "Killed", {}],
    ["a pnpm that was killed", null, "", {}],
    ["a pnpm that cannot be started", null, "", { error: new Error("spawn pnpm ENOENT") }],
  ])("fails for %s instead of calling it behind", (_label, status, stderr, extra) => {
    expect(() => runnerLockState(context(), { run: answer(status, stderr, extra).run })).toThrow();
  });

  it("fails for a directory that is not a Runner build context", () => {
    const directory = context();
    rmSync(path.join(directory, "pnpm-lock.yaml"));
    expect(() => runnerLockState(directory, { run: answer(0).run })).toThrow(/no pnpm-lock\.yaml/);
  });

  it("refuses a checkout, whose lockfile pnpm could rewrite, and does not start pnpm there", () => {
    const directory = context();
    mkdirSync(path.join(directory, ".git"));
    const { calls, run } = answer(0);
    expect(() => runnerLockState(directory, { run })).toThrow(/is a checkout: pnpm can rewrite its pnpm-lock\.yaml/);
    expect(calls).toEqual([]);
  });
});

describe("publication state", () => {
  type Manifest = Awaited<ReturnType<typeof readRunnerImageManifest>>;
  const index = (label: string, slimDigest?: string) => {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, label, ...(slimDigest ? { annotations: { [SLIM_DIGEST_ANNOTATION]: slimDigest } } : {}) }));
    return { state: "present" as const, bytes, digest: sha256(bytes) };
  };
  const registry = (tags: Record<string, Manifest>) => async (reference: string): Promise<Manifest> => tags[reference] ?? { state: "absent" };
  const slim = index("slim of this run");
  const full = index("full of this run", slim.digest);
  const unknown = { state: "unknown" as const, detail: "manifest request: HTTP 503" };

  it("is published only when the full tag exists and names the image the slim tag points at", async () => {
    await expect(runnerPublicationState(INPUTS, registry({ [TAGS.slim]: slim, [TAGS.full]: full })))
      .resolves.toMatchObject({ state: "published", slim: slim.digest, full: full.digest });
    await expect(runnerPublicationState(INPUTS, registry({}))).resolves.toMatchObject({ state: "absent" });
  });

  it("treats a slim tag without the full tag as a publication that did not finish", async () => {
    // A run stopped between the two tags. The inputs are not published, so
    // the next run builds, and its publish job replaces the slim tag.
    const orphan = index("slim of the run that stopped");
    await expect(runnerPublicationState(INPUTS, registry({ [TAGS.slim]: orphan })))
      .resolves.toMatchObject({ state: "incomplete", slim: orphan.digest });
    await expect(runPublishCommand(["publication-state", "--inputs-digest", INPUTS, "--strict"], { env: {}, read: registry({ [TAGS.slim]: orphan }), log: () => {} }))
      .resolves.toEqual({ state: "incomplete", exists: false, publish: true });
  });

  it.each<[string, Record<string, Manifest>]>([
    ["the slim tag is missing", { [TAGS.full]: full }],
    ["the slim tag points at another run's image", { [TAGS.full]: full, [TAGS.slim]: index("slim of another run") }],
    ["the full index names no slim image", { [TAGS.full]: index("full without the annotation"), [TAGS.slim]: slim }],
    ["the full tag is not an index", { [TAGS.full]: { state: "present", bytes: Buffer.from("not JSON"), digest: sha256("not JSON") }, [TAGS.slim]: slim }],
  ])("is broken, and fails every run, when the full tag exists but %s", async (_label, tags) => {
    await expect(runnerPublicationState(INPUTS, registry(tags))).resolves.toMatchObject({ state: "broken" });
    // Also without --strict: no run can repair it, and the message says what an operator must do.
    await expect(runPublishCommand(["publication-state", "--inputs-digest", INPUTS], { env: {}, read: registry(tags), log: () => {} }))
      .rejects.toThrow(/No run can repair this.*Delete the package versions tagged inputs-1{64} and inputs-1{64}-slim, then re-run/);
  });

  it.each<[string, Record<string, Manifest>]>([
    ["the full tag", { [TAGS.full]: unknown }],
    ["the slim tag, with the full tag absent", { [TAGS.slim]: unknown }],
    ["the slim tag, with the full tag present", { [TAGS.full]: full, [TAGS.slim]: unknown }],
  ])("does not guess when the registry gives no clear answer for %s", async (_label, tags) => {
    await expect(runnerPublicationState(INPUTS, registry(tags))).resolves.toMatchObject({ state: "unknown" });
  });

  it("lets a run whose own slim tag is already written finish, and never pairs a full image with another run's slim", async () => {
    // What the publish job does, against a registry a stopped run left behind.
    const tags: Record<string, Manifest> = { [TAGS.slim]: index("slim of the run that stopped") };
    const read = registry(tags);
    const gate = await runPublishCommand(["publication-state", "--inputs-digest", INPUTS, "--strict"], { env: {}, read, log: () => {} });
    expect(gate.publish).toBe(true);
    // It writes its own slim tag over the orphan, then the full tag that names that slim.
    tags[TAGS.slim] = slim;
    tags[TAGS.full] = full;
    await expect(runPublishCommand(["publication-state", "--inputs-digest", INPUTS, "--strict"], { env: {}, read, log: () => {} }))
      .resolves.toEqual({ state: "published", exists: true, publish: false });
    // Had it kept the orphan, the pair would not hold.
    tags[TAGS.slim] = index("slim of the run that stopped");
    await expect(runPublishCommand(["publication-state", "--inputs-digest", INPUTS, "--strict"], { env: {}, read, log: () => {} })).rejects.toThrow(/No run can repair this/);
  });
});

describe("command line", () => {
  const unknown = async () => ({ state: "unknown" as const, detail: "token request: HTTP 403" });
  const absent = async () => ({ state: "absent" as const });
  const quiet = { env: {}, log: () => {} };
  const state = ["publication-state", "--inputs-digest", INPUTS];

  it("builds on an inconclusive lookup and fails on one when it is strict", async () => {
    const lines: string[] = [];
    await expect(runPublishCommand(state, { env: {}, read: unknown, log: (line) => lines.push(line) }))
      .resolves.toEqual({ state: "unknown", exists: false, publish: false });
    expect(lines.join("\n")).toMatch(/::notice title=Runner image lookup inconclusive::/);
    await expect(runPublishCommand([...state, "--strict"], { ...quiet, read: unknown }))
      .rejects.toThrow(/Could not determine whether .*paperclip-runner:inputs-1{64} is published \(inputs-1{64}: token request: HTTP 403\)/);
    await expect(runPublishCommand([...state, "--strict"], { ...quiet, read: absent }))
      .resolves.toEqual({ state: "absent", exists: false, publish: true });
  });

  it("stays inconclusive, not failed, when the registry cannot be reached", async () => {
    const offline = (reference: string) => readRunnerImageManifest(reference, {
      fetchImpl: async () => { throw new TypeError("fetch failed"); }, sleep: async () => {},
    });
    await expect(runPublishCommand(state, { ...quiet, read: offline })).resolves.toEqual({ state: "unknown", exists: false, publish: false });
    await expect(runPublishCommand([...state, "--strict"], { ...quiet, read: offline })).rejects.toThrow(/Could not determine/);
  });

  it("passes the registry credentials from the environment, and none when one is missing", async () => {
    const seen: unknown[] = [];
    const read = async (_reference: string, options?: { credentials?: unknown }) => { seen.push(options?.credentials); return { state: "absent" as const }; };
    await runPublishCommand(state, { env: { RUNNER_IMAGE_REGISTRY_USERNAME: "u", RUNNER_IMAGE_REGISTRY_PASSWORD: "p" }, read, log: () => {} });
    await runPublishCommand(state, { env: { RUNNER_IMAGE_REGISTRY_USERNAME: "u" }, read, log: () => {} });
    expect(new Set(seen.map((credentials) => JSON.stringify(credentials)))).toEqual(new Set(['{"username":"u","password":"p"}', "null"]));
  });

  it("verifies the index of each variant against the recorded legs and against the expected digest", async () => {
    const { directory, images } = await legs();
    const indexOf = (variant: "slim" | "full", annotations?: Record<string, string>) => Buffer.from(JSON.stringify({
      schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: ["amd64", "arm64"].map((architecture) => ({
        mediaType: "application/vnd.oci.image.manifest.v1+json", digest: images[architecture][variant], size: 500,
        platform: { os: "linux", architecture },
      })),
      ...(annotations ? { annotations } : {}),
    }));
    const slim = indexOf("slim");
    const full = indexOf("full", { [SLIM_DIGEST_ANNOTATION]: sha256(slim) });
    const serve = (bytes: Buffer) => async () => ({ state: "present" as const, bytes, digest: sha256(bytes) });
    const verify = (...args: string[]) => ["verify-index", ...args, "--dir", directory];
    await expect(runPublishCommand(verify("candidate-x-slim", "--variant", "slim"), { ...quiet, read: serve(slim) })).resolves.toEqual({ digest: sha256(slim) });
    await expect(runPublishCommand(verify("candidate-x", "--variant", "full", "--slim-digest", sha256(slim), "--expect", sha256(full)), { ...quiet, read: serve(full) }))
      .resolves.toEqual({ digest: sha256(full) });
    // The slim index is not the full one, and the other way round.
    await expect(runPublishCommand(verify("inputs-x", "--variant", "full", "--slim-digest", sha256(slim)), { ...quiet, read: serve(slim) })).rejects.toThrow();
    await expect(runPublishCommand(verify("inputs-x-slim", "--variant", "slim"), { ...quiet, read: serve(full) })).rejects.toThrow();
    await expect(runPublishCommand(verify("inputs-x", "--variant", "full"), { ...quiet, read: serve(full) }))
      .rejects.toThrow(/--slim-digest is given for the full index, and only for it/);
    await expect(runPublishCommand(verify("inputs-x-slim", "--variant", "slim", "--slim-digest", sha256(slim)), { ...quiet, read: serve(slim) }))
      .rejects.toThrow(/--slim-digest is given for the full index, and only for it/);
    await expect(runPublishCommand(verify("inputs-x-slim", "--variant", "slim", "--expect", sha256("another index")), { ...quiet, read: serve(slim) }))
      .rejects.toThrow(/inputs-x-slim resolves to sha256:[0-9a-f]{64}, expected sha256:[0-9a-f]{64}/);
    await expect(runPublishCommand(verify("inputs-x-slim", "--variant", "slim", "--expect", "latest"), { ...quiet, read: serve(slim) }))
      .rejects.toThrow(/--expect must be a sha256 digest/);
    await expect(runPublishCommand(verify("inputs-x-slim", "--variant", "both"), { ...quiet, read: serve(slim) })).rejects.toThrow(/--variant must be slim or full/);
    await expect(runPublishCommand(verify("inputs-x-slim", "--variant", "slim"), { ...quiet, read: absent })).rejects.toThrow(/is absent/);
  });

  it("reports the lockfile state and fails when the check itself fails", async () => {
    await expect(runPublishCommand(["lock-state", "--context", "/context"], { ...quiet, lockState: () => ({ state: "behind", detail: "ERR_PNPM_OUTDATED_LOCKFILE" }) }))
      .resolves.toEqual({ state: "behind" });
    await expect(runPublishCommand(["lock-state", "--context", "/context"], { ...quiet, lockState: () => { throw new Error("broken"); } }))
      .rejects.toThrow("broken");
  });

  it.each<[string, string[], RegExp]>([
    ["an empty --expect", ["verify-index", "inputs-x", "--dir", "d", "--variant", "slim", "--expect", ""], /--expect needs a value/],
    ["an --expect with no value", ["verify-index", "inputs-x", "--dir", "d", "--variant", "slim", "--expect"], /--expect needs a value/],
    ["an index check without a variant", ["verify-index", "inputs-x", "--dir", "d"], /verify-index needs --variant/],
    ["a misspelt flag", [...state, "--strikt"], /publication-state does not take --strikt/],
    ["a flag of another command", [...state, "--expect", "sha256:x"], /publication-state does not take --expect/],
    ["a repeated flag", ["verify-index", "inputs-x", "--dir", "a", "--dir", "b"], /--dir is given twice/],
    ["a missing required flag", ["verify-legs", "--dir", "d", "--inputs-digest", INPUTS], /verify-legs needs --source-revision/],
    ["an empty required value", ["verify-legs", "--dir", "d", "--inputs-digest", "", "--source-revision", REVISION], /--inputs-digest needs a value/],
    ["a lookup without the inputs digest", ["publication-state", "--strict"], /publication-state needs --inputs-digest/],
    ["a lookup by tag", ["publication-state", "inputs-x", "--inputs-digest", INPUTS], /takes no positional argument/],
    ["a missing tag", ["verify-index", "--dir", "d", "--variant", "slim"], /takes exactly one tag or digest/],
    ["an empty tag", ["verify-index", "", "--dir", "d", "--variant", "slim"], /not a tag or digest/],
    ["a record of one variant", ["record", "--arch", "amd64", "--full-archive", "f", "--full-metadata", "m", "--tree", "t", "--layout", "l", "--out", "o"], /record needs --slim-archive/],
    ["an unknown command", ["tag-state", "inputs-x"], /Usage/],
    ["no command", [], /Usage/],
  ])("rejects %s", (_label, argv, expected) => {
    expect(() => parsePublishArguments(argv[0], argv.slice(1))).toThrow(expected);
  });
});
