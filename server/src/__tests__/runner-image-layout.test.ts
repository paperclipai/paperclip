import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BUILD_INPUTS_SCHEMA,
  buildInputsStampPath,
  collectBuildOutputFiles,
} from "../../../packages/paperclip-runner/scripts/build-inputs.mjs";
import { sha256Tree } from "../../../packages/paperclip-runner/scripts/provider-pack-runtime-tree.mjs";
import { createProviderPackLayers } from "../../../scripts/create-provider-pack-archive.mjs";
import {
  PROVIDER_PACK_ARCHIVE_SCHEMA,
  PROVIDER_PACK_SCHEMA,
  RUNNER_IMAGE_INPUTS_SCHEMA,
  RUNNER_IMAGE_PATHS,
  RUNNER_IMAGE_SCHEMA,
  canonicalJson,
  checkProviderPackArchives,
  checkRunnerImageLayout as checkLayout,
  parseLayoutArguments,
  writeRunnerImageManifest,
} from "../../../scripts/runner-image-layout.mjs";

/** The fixture is a full image, so most tests check it as one. */
const checkRunnerImageLayout = (root: string, options: Omit<Parameters<typeof checkLayout>[1], "variant"> = {}) =>
  checkLayout(root, { variant: "full", ...options });

/**
 * The layout contract of the Runner image. Consumers copy the documented
 * paths out of the image and trust runner-image.json, so a tree that
 * lacks a path, or whose manifest does not describe it, must never pass.
 */

const REVISION = "a".repeat(40);
const INPUTS = "1".repeat(64);
const BUILD_INPUTS = "2".repeat(64);
const identity = { schema: RUNNER_IMAGE_INPUTS_SCHEMA, digest: INPUTS, buildInputs: { schema: BUILD_INPUTS_SCHEMA, digest: BUILD_INPUTS } };
const platform = { os: "linux", architecture: "amd64" };
const libc = { baseline: "debian-bookworm", buildVersion: "2.36", runnerdRequires: "2.34" };
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const layoutScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "runner-image-layout.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "runner-image-layout-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;

function write(root: string, relative: string, content: Buffer | string) {
  const file = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** The first bytes of a little-endian ELF executable for the given machine. */
function elf(machine: number) {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(machine, 18);
  return header;
}

/** A Runner package as its build leaves it: build output and the stamp that describes it. */
function workspace(root: string, { machine = 62, arch = "x64", digest = BUILD_INPUTS } = {}) {
  const runner = "packages/paperclip-runner";
  write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(root, `${runner}/package.json`, '{"name":"@paperclipai/paperclip-runner","type":"module"}\n');
  write(root, `${runner}/scripts/provision-grok.mjs`, "// provisions Grok\n");
  write(root, `${runner}/src/providers/grok/platforms.json`, '{"version":"1.0.13"}\n');
  write(root, `${runner}/src/live/runnerd-codex-transport.ts`, 'const RUNNER_CLIENT_VERSION = "0.3.0";\n');
  for (const file of ["index.js", "live/index.js", "testing.js"]) write(root, `${runner}/dist/${file}`, `// ${file}\n`);
  chmodSync(write(root, `${runner}/dist/bin/paperclip-runnerd`, elf(machine)), 0o755);
  const packageRoot = path.join(root, ...runner.split("/"));
  const outputs = collectBuildOutputFiles(packageRoot);
  write(packageRoot, path.relative(packageRoot, buildInputsStampPath(packageRoot)).split(path.sep).join("/"), JSON.stringify({
    schema: BUILD_INPUTS_SCHEMA, digest, platform: "linux", arch, outputCount: outputs.length, outputs,
  }));
}

// The archive writer puts each file of 1 MiB or more in an archive of its own.
const LARGE = Buffer.alloc(1024 * 1024 + 16, "n");

/**
 * The files the image build produces before it writes runner-image.json: a
 * provider pack, and its transport archives written by the script the image
 * build runs. The build grants a+rX after it writes the archives, so the pack
 * manifest is 0600 inside the archives and 0644 in the image.
 */
async function providerPack(out: string, { revision = REVISION, inputsDigest = INPUTS as string | null, arch = "x64", lock = "lockfileVersion: '9.0'\n" } = {}) {
  const pack = path.join(out, "provider-pack");
  const files: Record<string, [string, Buffer | string]> = {
    nodeCommand: ["node_modules/node/bin/node", LARGE],
    productionLock: ["pnpm-lock.yaml", lock],
    opencodeProxy: ["dist/cli/opencode-app-server-proxy.cjs", "opencodeProxy\n"],
  };
  const artifacts: Record<string, { path: string; sha256: string }> = {};
  for (const [name, [relative, content]] of Object.entries(files)) {
    write(pack, relative, content);
    artifacts[name] = { path: relative, sha256: `sha256:${sha256(content)}` };
  }
  chmodSync(path.join(pack, "node_modules/node/bin/node"), 0o755);
  mkdirSync(path.join(pack, "node_modules/.bin"), { recursive: true });
  symlinkSync("../node/bin/node", path.join(pack, "node_modules/.bin/node"));
  write(pack, "dist/index.js", "// pack dist\n");
  write(pack, "provider-assets/pi/linux-x64/pi.js", "// pi\n");
  const payload = {
    target: { platform: "linux", architecture: arch },
    runnerSourceRevision: revision,
    ...(inputsDigest === null ? {} : { runnerInputsDigest: inputsDigest }),
    distDigest: sha256Tree(path.join(pack, "dist")),
    providers: { pi: { path: "provider-assets/pi/linux-x64", sha256: sha256Tree(path.join(pack, "provider-assets/pi/linux-x64")) } },
    artifacts,
  };
  const manifest = { schema: PROVIDER_PACK_SCHEMA, digest: `sha256:${sha256(canonicalJson(payload))}`, payload };
  chmodSync(write(pack, "provider-pack.json", `${JSON.stringify(manifest, null, 2)}\n`), 0o600);
  const receipt = await createProviderPackLayers(pack);
  expect(receipt.files.map((file: { path: string }) => file.path)).toEqual(["node_modules/node/bin/node"]);
  chmodSync(path.join(pack, "provider-pack.json"), 0o644);
  write(out, "bundles/runnerd-codex-transport.mjs", "export function createCapabilityRunnerdCodexTransport() {}\n");
}

/** One built tree for each distinct set of options; every test gets its own copy. */
const templates = new Map<string, Promise<string>>();
async function image(options: { stamped?: boolean; publication?: boolean; pack?: object; source?: object } = {}) {
  const key = JSON.stringify(options);
  if (!templates.has(key)) {
    templates.set(key, (async () => {
      const { stamped = true, publication = stamped, pack = {}, source = {} } = options;
      const root = path.join(scratch, `template-${templates.size}`);
      const out = path.join(root, "out");
      workspace(path.join(root, "workspace"), source);
      // Only a publication build's pack names the published image.
      if (stamped) await providerPack(out, { ...(publication ? {} : { inputsDigest: null }), ...pack });
      writeRunnerImageManifest({
        outRoot: out, workspaceRoot: path.join(root, "workspace"), identity, platform, libc, sourceRevision: stamped ? REVISION : null, publication,
      });
      return out;
    })());
  }
  const copy = path.join(scratch, String(sequence += 1), "out");
  cpSync(await templates.get(key)!, copy, { recursive: true, verbatimSymlinks: true });
  return copy;
}

const manifestOf = (out: string) => JSON.parse(readFileSync(path.join(out, "runner-image.json"), "utf8"));
function rewriteManifest(out: string, change: (manifest: Record<string, any>) => void) {
  const manifest = manifestOf(out);
  change(manifest);
  writeFileSync(path.join(out, "runner-image.json"), JSON.stringify(manifest));
}

describe("Runner image layout contract", () => {
  let out: string;
  beforeEach(async () => {
    out = await image();
  });

  it("accepts the tree the image build writes", () => {
    expect(checkRunnerImageLayout(out)).toEqual([]);
    expect(checkRunnerImageLayout(out, { expectInputsDigest: INPUTS, expectSourceRevision: REVISION, expectArchitecture: "amd64" })).toEqual([]);
    const manifest = manifestOf(out);
    expect(manifest).toMatchObject({
      schema: RUNNER_IMAGE_SCHEMA,
      inputsDigest: { schema: "paperclip.runner-image-inputs.v1", digest: INPUTS },
      buildInputsDigest: { schema: "paperclip.runner-build-inputs.v2", digest: BUILD_INPUTS },
      sourceRevision: REVISION,
      publication: true,
      platform: { os: "linux", architecture: "amd64" },
      libc: { family: "glibc", baseline: "debian-bookworm", buildVersion: "2.36", runnerdRequires: "2.34" },
      paths: RUNNER_IMAGE_PATHS,
      fullImageOnly: ["providerPackArchiveReceipt", "providerPackArchives"],
    });
    // One daemon, at the root for sandbox images and inside the build output
    // for a build that vendors the Runner.
    expect(manifest.sha256.runnerd).toBe(manifest.sha256.runnerDistRunnerd);
  });

  it.each(Object.entries(RUNNER_IMAGE_PATHS))("fails when the documented path %s is missing", (name, relative) => {
    rmSync(path.join(out, ...(relative as string).split("/")), { recursive: true, force: true });
    const problems = checkRunnerImageLayout(out);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain(name === "manifest" ? "runner-image.json is missing" : (relative as string));
  });

  it.each([
    ["is not JSON", (file: string) => writeFileSync(file, "{")],
    ["is not an object", (file: string) => writeFileSync(file, "[]")],
  ])("fails when runner-image.json %s", (_label, corrupt) => {
    corrupt(path.join(out, "runner-image.json"));
    expect(checkRunnerImageLayout(out)).toHaveLength(1);
  });

  it.each<[string, (manifest: Record<string, any>) => void, RegExp]>([
    ["another schema", (m) => { m.schema = "paperclip.runner-image.v0"; }, /schema/],
    ["no inputs digest", (m) => { delete m.inputsDigest; }, /inputsDigest must be/],
    ["a short inputs digest", (m) => { m.inputsDigest.digest = "abc"; }, /inputsDigest must be/],
    ["another build-inputs schema", (m) => { m.buildInputsDigest.schema = "paperclip.runner-build-inputs.v1"; }, /buildInputsDigest must be/],
    ["an abbreviated source revision", (m) => { m.sourceRevision = "abc1234"; }, /sourceRevision/],
    ["transport paths claimed for both variants", (m) => { m.fullImageOnly = []; }, /fullImageOnly does not name the paths only the full image has/],
    ["no word on whether it is a publication build", (m) => { delete m.publication; }, /publication must say/],
    ["a publication build without a source revision", (m) => { m.sourceRevision = null; }, /publication build must have a source revision/],
    ["an unsupported platform", (m) => { m.platform = { os: "linux", architecture: "riscv64" }; }, /platform must be/],
    ["no libc baseline", (m) => { delete m.libc.baseline; }, /libc must record/],
    ["a daemon newer than its baseline", (m) => { m.libc.runnerdRequires = "2.38"; }, /requires glibc 2\.38/],
    ["an undocumented path", (m) => { m.paths.extra = "extra"; }, /paths does not match/],
    ["a moved path", (m) => { m.paths.runnerd = "bin/paperclip-runnerd"; }, /paths does not match/],
    ["no digests", (m) => { delete m.sha256; }, /sha256 must map/],
  ])("fails when runner-image.json has %s", (_label, change, expected) => {
    rewriteManifest(out, change);
    expect(checkRunnerImageLayout(out).join("\n")).toMatch(expected);
  });

  it("fails when a file differs from the digest runner-image.json records", () => {
    appendFileSync(path.join(out, "runner-package/scripts/provision-grok.mjs"), "// changed\n");
    expect(checkRunnerImageLayout(out).join("\n")).toMatch(/provision-grok\.mjs \(grokProvisioner\) does not match the digest/);
  });

  it("fails when the image is for other inputs, another commit or another architecture than expected", () => {
    const problems = checkRunnerImageLayout(out, {
      expectInputsDigest: "f".repeat(64), expectSourceRevision: "b".repeat(40), expectArchitecture: "arm64",
    }).join("\n");
    expect(problems).toMatch(/inputs digest is 1{64}, expected f{64}/);
    expect(problems).toMatch(/source revision is a{40}, expected b{40}/);
    expect(problems).toMatch(/architecture is amd64, expected arm64/);
  });

  it("fails when the daemon is built for another architecture", async () => {
    const arm = await image({ source: { machine: 183 } });
    expect(checkRunnerImageLayout(arm).join("\n")).toMatch(/paperclip-runnerd is not a linux\/amd64 executable/);
  });

  it("fails when the daemon is not executable or a file is not readable by every user", () => {
    chmodSync(path.join(out, "paperclip-runnerd"), 0o644);
    chmodSync(path.join(out, "provider-pack/provider-pack.json"), 0o600);
    const problems = checkRunnerImageLayout(out).join("\n");
    expect(problems).toMatch(/paperclip-runnerd is not executable by every user/);
    expect(problems).toMatch(/not readable by every user: provider-pack\/provider-pack\.json/);
  });

  describe("Runner build stamp", () => {
    it("fails when a build output changed size after the stamp was recorded", () => {
      appendFileSync(path.join(out, "runner-package/dist/index.js"), "// later edit\n");
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/build output dist\/index\.js is changed size/);
    });

    it("fails when a recorded build output is gone", () => {
      rmSync(path.join(out, "runner-package/dist/testing.js"));
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/dist\/testing\.js is missing/);
    });

    it("fails when the stamp was recorded on another architecture", async () => {
      const other = await image({ source: { arch: "arm64" } });
      expect(checkRunnerImageLayout(other).join("\n")).toMatch(/stamp was recorded on linux\/arm64, not linux\/x64/);
    });

    it("refuses to describe a build whose stamp names other inputs, and never writes a stamp itself", () => {
      const root = path.join(scratch, String(sequence += 1));
      workspace(path.join(root, "workspace"), { digest: "9".repeat(64) });
      const write = () => writeRunnerImageManifest({
        outRoot: path.join(root, "out"), workspaceRoot: path.join(root, "workspace"), identity, platform, libc, sourceRevision: null,
      });
      expect(write).toThrow(/built from inputs 9{64}, but the image identity was computed from 2{64}/);
      rmSync(buildInputsStampPath(path.join(root, "workspace/packages/paperclip-runner")));
      expect(write).toThrow(/recorded no build stamp/);
    });
  });

  describe("provider pack integrity", () => {
    it("fails when an artifact differs from its digest in provider-pack.json", () => {
      appendFileSync(path.join(out, "provider-pack/dist/cli/opencode-app-server-proxy.cjs"), "// changed\n");
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/artifact opencodeProxy does not match its digest/);
    });

    it("fails when an artifact is missing", () => {
      rmSync(path.join(out, "provider-pack/dist/cli/opencode-app-server-proxy.cjs"));
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/artifact opencodeProxy is missing/);
    });

    it("fails when provider assets the manifest names are missing", () => {
      rmSync(path.join(out, "provider-pack/provider-assets"), { recursive: true });
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/the provider pack asset tree of pi is missing/);
    });

    it("recomputes the tree digests the manifest records", async () => {
      // A file that is not a listed artifact is bound only by its tree digest.
      appendFileSync(path.join(out, "provider-pack/provider-assets/pi/linux-x64/pi.js"), "// changed\n");
      expect(checkRunnerImageLayout(out)).toEqual(["the provider pack asset tree of pi does not match its tree digest"]);
      const other = await image();
      write(path.join(other, "provider-pack"), "dist/extra.js", "// not built\n");
      expect(checkRunnerImageLayout(other)).toEqual(["the provider pack dist tree does not match its tree digest"]);
      const third = await image();
      rmSync(path.join(third, "provider-pack/dist/index.js"));
      expect(checkRunnerImageLayout(third).join("\n")).toMatch(/the provider pack dist tree does not match its tree digest/);
    });

    it("fails when the manifest was edited after it was sealed", () => {
      const file = path.join(out, "provider-pack/provider-pack.json");
      const pack = JSON.parse(readFileSync(file, "utf8"));
      pack.payload.runnerSourceRevision = "c".repeat(40);
      writeFileSync(file, JSON.stringify(pack));
      rewriteManifest(out, (m) => { m.sha256.providerPackManifest = `sha256:${sha256(readFileSync(file))}`; });
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/provider-pack\.json digest does not match its payload/);
    });

    it.each<[string, object, RegExp]>([
      ["another commit", { revision: "c".repeat(40) }, /provider pack was built from c{40}, but the image source revision is a{40}/],
      ["other inputs", { inputsDigest: "d".repeat(64) }, /runnerInputsDigest does not match/],
      ["another architecture", { arch: "arm64" }, /provider pack targets/],
      ["another lockfile", { lock: "lockfileVersion: '6.0'\n" }, /lockfile at the image root is not the one the provider pack was installed from/],
    ])("fails when the pack was built for %s", async (_label, pack, expected) => {
      expect(checkRunnerImageLayout(await image({ pack })).join("\n")).toMatch(expected);
    });

    it("fails when a transport archive or an archived file differs from the receipt", async () => {
      appendFileSync(path.join(out, "provider-pack.archives/0.tar.zst"), "x");
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/transport archive 0\.tar\.zst does not match its receipt/);
      const other = await image();
      const receipt = path.join(other, "provider-pack.archive.json");
      const parsed = JSON.parse(readFileSync(receipt, "utf8"));
      parsed.providerPackDigest = `sha256:${"e".repeat(64)}`;
      parsed.files[0].sha256 = "e".repeat(64);
      writeFileSync(receipt, JSON.stringify(parsed));
      rewriteManifest(other, (m) => { m.sha256.providerPackArchiveReceipt = `sha256:${sha256(readFileSync(receipt))}`; });
      const problems = checkRunnerImageLayout(other).join("\n");
      expect(problems).toMatch(/transport archives belong to another provider pack/);
      expect(problems).toMatch(/archived file node_modules\/node\/bin\/node does not match the provider pack/);
    });
  });

  describe("publication build", () => {
    // Another image build can run the same stage inline. That Runner has the
    // same inputs, but it is not the published image and must not say it is.
    it("is the only build whose pack names the published image", async () => {
      expect(JSON.parse(readFileSync(path.join(out, "provider-pack/provider-pack.json"), "utf8")).payload.runnerInputsDigest).toBe(INPUTS);
      const inline = await image({ publication: false });
      expect(manifestOf(inline).publication).toBe(false);
      expect(manifestOf(inline).sourceRevision).toBe(REVISION);
      expect(JSON.parse(readFileSync(path.join(inline, "provider-pack/provider-pack.json"), "utf8")).payload).not.toHaveProperty("runnerInputsDigest");
      expect(checkRunnerImageLayout(inline)).toEqual([]);
      expect((await checkProviderPackArchives(inline)).problems).toEqual([]);
    });

    it("refuses a pack that names an image when the build is not a publication build", async () => {
      const claiming = await image({ publication: false, pack: { inputsDigest: INPUTS } });
      expect(checkRunnerImageLayout(claiming)).toEqual(["the provider pack records runnerInputsDigest, but this is not a publication build"]);
    });

    it("refuses a publication build whose pack does not name the image", async () => {
      const silent = await image({ pack: { inputsDigest: null } });
      expect(checkRunnerImageLayout(silent)).toEqual(["the provider pack runnerInputsDigest does not match the image inputs digest"]);
    });

    it("is required whenever an inputs digest is expected", async () => {
      const inline = await image({ publication: false });
      expect(checkRunnerImageLayout(inline, { expectInputsDigest: INPUTS }))
        .toEqual(["an inputs digest is expected, but this is not a publication build"]);
      expect(checkRunnerImageLayout(out, { expectInputsDigest: INPUTS })).toEqual([]);
    });

    it("cannot be written without a source revision", () => {
      const root = path.join(scratch, String(sequence += 1));
      workspace(path.join(root, "workspace"));
      expect(() => writeRunnerImageManifest({
        outRoot: path.join(root, "out"), workspaceRoot: path.join(root, "workspace"), identity, platform, libc, sourceRevision: null, publication: true,
      })).toThrow(/publication build needs a source revision/);
    });
  });

  describe("variants", () => {
    /** A slim tree: the full fixture without its transport archives and receipt. */
    function slim(tree: string) {
      rmSync(path.join(tree, "provider-pack.archives"), { recursive: true });
      rmSync(path.join(tree, "provider-pack.archive.json"));
      return tree;
    }

    it("accepts a slim tree only as slim, and a full tree only as full", () => {
      expect(checkLayout(out, { variant: "full" })).toEqual([]);
      expect(checkLayout(out, { variant: "slim" })).toEqual([
        "provider-pack.archive.json (providerPackArchiveReceipt) is in a slim image; only the full image has the transport archives",
        "provider-pack.archives (providerPackArchives) is in a slim image; only the full image has the transport archives",
      ]);
      slim(out);
      expect(checkLayout(out, { variant: "slim", expectInputsDigest: INPUTS, expectSourceRevision: REVISION, expectArchitecture: "amd64" })).toEqual([]);
      expect(checkLayout(out, { variant: "full" })).toEqual(expect.arrayContaining([
        "documented path provider-pack.archive.json (providerPackArchiveReceipt) is missing",
        "documented path provider-pack.archives (providerPackArchives) is missing",
      ]));
    });

    it("refuses a slim tree that holds only one of the two transport paths", () => {
      rmSync(path.join(out, "provider-pack.archive.json"));
      expect(checkLayout(out, { variant: "slim" }).join("\n")).toMatch(/provider-pack\.archives \(providerPackArchives\) is in a slim image/);
    });

    it("still checks everything else in a slim tree", () => {
      appendFileSync(path.join(slim(out), "provider-pack/dist/cli/opencode-app-server-proxy.js"), "// later edit\n");
      expect(checkLayout(out, { variant: "slim" }).join("\n")).toMatch(/the provider pack dist tree does not match its tree digest/);
    });

    it("has no default: the variant is always given", () => {
      // @ts-expect-error the variant is required
      expect(() => checkLayout(out, {})).toThrow(/must be told the variant: slim or full/);
      expect(() => checkLayout(out, { variant: "both" })).toThrow(/must be told the variant/);
      const check = (...args: string[]) => spawnSync(process.execPath, [layoutScript, "check", out, ...args], { encoding: "utf8" });
      expect(check().stderr).toMatch(/check needs --variant slim or --variant full/);
      expect(check("--variant", "both").stderr).toMatch(/check needs --variant slim or --variant full/);
      expect(check("--variant", "slim").stderr).toMatch(/is in a slim image/);
      const passed = spawnSync(process.execPath, [layoutScript, "check", slim(out), "--variant", "slim"], { encoding: "utf8" });
      expect(passed.status).toBe(0);
      expect(passed.stdout).toMatch(/A slim image has no transport archives/);
    });

    it("writes one runner-image.json for both, which names the paths only the full image has", () => {
      const manifest = manifestOf(out);
      expect(manifest.fullImageOnly.map((name: keyof typeof RUNNER_IMAGE_PATHS) => RUNNER_IMAGE_PATHS[name]))
        .toEqual(["provider-pack.archive.json", "provider-pack.archives"]);
      expect(manifest.paths).toEqual(RUNNER_IMAGE_PATHS);
    });
  });

  describe("transport archive round trip", () => {
    // The archives' bytes can match the receipt while the archives do not
    // hold the pack. Only extracting them, the way a sandbox does, shows it.
    const roundTrip = async (tree: string) => (await checkProviderPackArchives(tree)).problems;
    const pack = (...parts: string[]) => path.join(out, "provider-pack", ...parts);
    const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("paperclip-runner-image-archives-")).length;

    /** Replaces one archive and makes the receipt and runner-image.json agree with its bytes. */
    function replaceArchive(tree: string, name: string, bytes: Buffer) {
      writeFileSync(path.join(tree, "provider-pack.archives", name), bytes);
      const file = path.join(tree, "provider-pack.archive.json");
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      const entry = name === "overlay.tar.zst" ? receipt.overlay : receipt.files[Number.parseInt(name, 10)].archive;
      entry.sha256 = sha256(bytes);
      entry.bytes = bytes.length;
      writeFileSync(file, JSON.stringify(receipt));
      rewriteManifest(tree, (m) => { m.sha256.providerPackArchiveReceipt = `sha256:${sha256(readFileSync(file))}`; });
    }

    /** A tar stream with the given members, written by hand so that a member can have a name no tar would write. */
    function tarOf(members: { name: string; type?: "0" | "2" | "5"; mode?: number; content?: string; linkname?: string }[]) {
      const blocks: Buffer[] = [];
      for (const member of members) {
        const body = Buffer.from(member.content ?? "");
        const header = Buffer.alloc(512);
        header.write(member.name, 0, 100);
        header.write(`${(member.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
        header.write("0000000\0", 108);
        header.write("0000000\0", 116);
        header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
        header.write("00000000000\0", 136);
        header.fill(" ", 148, 156);
        header.write(member.type ?? "0", 156);
        header.write(member.linkname ?? "", 157, 100);
        header.write("ustar\u000000", 257);
        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
        blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
      }
      blocks.push(Buffer.alloc(1024));
      return Buffer.concat(blocks);
    }

    it("passes for the archives the image build's own script writes", async () => {
      const before = leftovers();
      const result = await checkProviderPackArchives(out);
      expect(result.problems).toEqual([]);
      expect(["GNU tar", "bsdtar"]).toContain(result.tar);
      // The archives carry the manifest as the builder wrote it, 0600. The
      // image has it 0644: that difference is the build's a+rX grant.
      expect(leftovers()).toBe(before);
    });

    it("fails for archives that have the recorded bytes but are not archives", async () => {
      // This is what the byte comparison alone accepted.
      replaceArchive(out, "overlay.tar.zst", Buffer.from("overlay archive"));
      expect(checkRunnerImageLayout(out)).toEqual([]);
      const before = leftovers();
      expect((await roundTrip(out)).join("\n")).toMatch(/transport archive overlay\.tar\.zst is not a zstd archive/);
      expect(leftovers()).toBe(before);
      const numbered = await image();
      replaceArchive(numbered, "0.tar.zst", Buffer.from("node archive"));
      expect(checkRunnerImageLayout(numbered)).toEqual([]);
      expect((await roundTrip(numbered)).join("\n")).toMatch(/transport archive 0\.tar\.zst is not a zstd archive/);
    });

    it("fails for a zstd stream that is not a tar archive", async () => {
      replaceArchive(out, "overlay.tar.zst", zstdCompressSync(Buffer.from("this is not a tar archive\n".repeat(400))));
      expect(checkRunnerImageLayout(out)).toEqual([]);
      expect((await roundTrip(out)).join("\n")).toMatch(/could not extract the transport archives/);
    });

    it("fails when the archives lack a file or a directory the pack has", async () => {
      write(pack(), "dist/late.js", "// written after the archives\n");
      mkdirSync(pack("node_modules/empty"));
      expect(await roundTrip(out)).toEqual([
        "the transport archives do not carry these provider pack entries (2): dist/late.js, node_modules/empty",
      ]);
    });

    it("fails when the archives carry a file the pack does not have", async () => {
      rmSync(pack("provider-assets/pi/linux-x64/pi.js"));
      expect(await roundTrip(out)).toEqual([
        "the transport archives carry entries the provider pack does not have (1): provider-assets/pi/linux-x64/pi.js",
      ]);
    });

    it("fails when a file's content differs, in the overlay or in an archive of its own", async () => {
      appendFileSync(pack("dist/index.js"), "// changed\n");
      const changed = Buffer.from(LARGE);
      changed[changed.length - 1] = 0;
      writeFileSync(pack("node_modules/node/bin/node"), changed);
      expect(await roundTrip(out)).toEqual([
        "the transport archives carry other content (2): dist/index.js, node_modules/node/bin/node",
      ]);
    });

    it("fails when a link points elsewhere, or is not a link", async () => {
      rmSync(pack("node_modules/.bin/node"));
      symlinkSync("../node/bin/other", pack("node_modules/.bin/node"));
      expect(await roundTrip(out)).toEqual([
        "the transport archives carry another link target (1): node_modules/.bin/node (-> ../node/bin/node, the pack has -> ../node/bin/other)",
      ]);
      const other = await image();
      rmSync(path.join(other, "provider-pack/node_modules/.bin/node"));
      writeFileSync(path.join(other, "provider-pack/node_modules/.bin/node"), "#!/bin/sh\n");
      expect((await roundTrip(other)).join("\n")).toMatch(/another kind of entry \(1\): node_modules\/\.bin\/node \(link, the pack has a file\)/);
    });

    it.each<[string, string, number, string]>([
      ["a file that gained the executable bit", "dist/index.js", 0o755, "dist/index.js (archived 0644, the pack has 0755)"],
      ["a file that lost the executable bit", "node_modules/node/bin/node", 0o644, "node_modules/node/bin/node (archived 0755, the pack has 0644)"],
      ["a file that became writable by everyone", "dist/index.js", 0o666, "dist/index.js (archived 0644, the pack has 0666)"],
      ["a directory that became private", "dist/cli", 0o700, "dist/cli (archived 0755, the pack has 0700)"],
      ["a file the image build's grant was not applied to", "provider-pack.json", 0o600, "provider-pack.json (archived 0600, the pack has 0600)"],
    ])("fails for %s", async (_label, relative, mode, expected) => {
      chmodSync(pack(...relative.split("/")), mode);
      expect(await roundTrip(out)).toEqual([`the transport archives carry other permissions (1): ${expected}`]);
    });

    it("fails when the receipt records another mode than the archive carries", async () => {
      const file = path.join(out, "provider-pack.archive.json");
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      expect(receipt.files[0].mode).toBe(0o755);
      receipt.files[0].mode = 0o644;
      writeFileSync(file, JSON.stringify(receipt));
      expect(await roundTrip(out)).toEqual([
        "the receipt records other permissions than the transport archives carry (1): node_modules/node/bin/node (receipt 0644, archived 0755)",
      ]);
    });

    it("fails when the archive directory and the receipt disagree, before it extracts anything", async () => {
      writeFileSync(path.join(out, "provider-pack.archives/9.tar.zst"), "stray");
      rmSync(path.join(out, "provider-pack.archives/0.tar.zst"));
      const result = await checkProviderPackArchives(out);
      expect(result.tar).toBeNull();
      expect(result.problems).toEqual([
        "the receipt lists transport archives that are missing (1): 0.tar.zst",
        "provider-pack.archives holds files the receipt does not list (1): 9.tar.zst",
      ]);
    });

    describe("refuses a member that would be written outside the destination", () => {
      const outsideFile = () => path.join(scratch, `escaped-${sequence += 1}.txt`);

      it("by a name that climbs out of it", async () => {
        const name = `escaped-${sequence += 1}.txt`;
        replaceArchive(out, "overlay.tar.zst", zstdCompressSync(tarOf([{ name: `../${name}`, content: "escaped\n" }])));
        const before = leftovers();
        const problems = await roundTrip(out);
        expect(problems.join("\n")).toMatch(/could not extract the transport archives/);
        // The destination is a directory directly under the temporary directory.
        expect(readdirSync(tmpdir())).not.toContain(name);
        expect(leftovers()).toBe(before);
      });

      it("by an absolute name", async () => {
        const target = outsideFile();
        replaceArchive(out, "overlay.tar.zst", zstdCompressSync(tarOf([{ name: target, content: "escaped\n" }])));
        expect((await roundTrip(out)).length).toBeGreaterThan(0);
        expect(readdirSync(scratch)).not.toContain(path.basename(target));
      });

      it("through a link that points out of it", async () => {
        const directory = path.join(scratch, `outside-${sequence += 1}`);
        mkdirSync(directory);
        replaceArchive(out, "overlay.tar.zst", zstdCompressSync(tarOf([
          { name: "exit", type: "2", linkname: directory },
          { name: "exit/escaped.txt", content: "escaped\n" },
        ])));
        expect((await roundTrip(out)).length).toBeGreaterThan(0);
        expect(readdirSync(directory)).toEqual([]);
      });
    });

    it("is part of the check command, which says which tar extracted the archives", async () => {
      const check = (tree: string) => spawnSync(process.execPath, [layoutScript, "check", tree, "--variant", "full"], { encoding: "utf8" });
      const passed = check(out);
      expect(passed.status).toBe(0);
      expect(passed.stdout).toMatch(/The transport archives were extracted with (GNU tar, as a sandbox extracts them,|bsdtar) and match the provider pack/);
      // A tree the layout check alone accepts.
      replaceArchive(out, "overlay.tar.zst", Buffer.from("overlay archive"));
      expect(checkRunnerImageLayout(out)).toEqual([]);
      const failed = check(out);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toMatch(/transport archive overlay\.tar\.zst is not a zstd archive/);
      expect(failed.stdout).not.toMatch(/passed/);
      // A tree without a pack has nothing to extract, and the command says so.
      const unstamped = spawnSync(process.execPath, [layoutScript, "check", await image({ stamped: false }), "--variant", "full", "--allow-unstamped"], { encoding: "utf8" });
      expect(unstamped.status).toBe(0);
      expect(unstamped.stdout).toMatch(/no provider pack, so there are no transport archives to extract/);
    });
  });

  describe("paths that resolve outside the tree", () => {
    // A link to a file with the right bytes somewhere else on the machine
    // must not vouch for a file the image does not contain.
    const outside = () => {
      const directory = path.join(scratch, String(sequence += 1));
      mkdirSync(directory, { recursive: true });
      return directory;
    };

    it("refuses a pack artifact that is a link out of the pack", () => {
      const artifact = path.join(out, "provider-pack/dist/cli/opencode-app-server-proxy.cjs");
      const elsewhere = path.join(outside(), "proxy.cjs");
      renameSync(artifact, elsewhere);
      symlinkSync(elsewhere, artifact);
      expect(readFileSync(artifact, "utf8")).toBe("opencodeProxy\n");
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/artifact opencodeProxy resolves outside the pack/);
    });

    it("refuses an artifact path that climbs out of the pack", () => {
      const file = path.join(out, "provider-pack/provider-pack.json");
      const pack = JSON.parse(readFileSync(file, "utf8"));
      pack.payload.artifacts.nodeCommand.path = "../paperclip-runnerd";
      pack.digest = `sha256:${sha256(canonicalJson(pack.payload))}`;
      writeFileSync(file, JSON.stringify(pack));
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/artifact nodeCommand resolves outside the pack/);
    });

    it("refuses an archived file and a transport archive that are links out of the tree", () => {
      const archived = path.join(out, "provider-pack/node_modules/node/bin/node");
      const elsewhere = outside();
      renameSync(archived, path.join(elsewhere, "node"));
      symlinkSync(path.join(elsewhere, "node"), archived);
      const archive = path.join(out, "provider-pack.archives/overlay.tar.zst");
      renameSync(archive, path.join(elsewhere, "overlay.tar.zst"));
      symlinkSync(path.join(elsewhere, "overlay.tar.zst"), archive);
      const problems = checkRunnerImageLayout(out).join("\n");
      expect(problems).toMatch(/archived file node_modules\/node\/bin\/node resolves outside the pack/);
      expect(problems).toMatch(/transport archive overlay\.tar\.zst resolves outside the image/);
    });

    it("refuses a documented path reached through a linked directory", () => {
      const source = path.join(out, "runner-package/src");
      const elsewhere = path.join(outside(), "src");
      cpSync(source, elsewhere, { recursive: true });
      rmSync(source, { recursive: true });
      symlinkSync(elsewhere, source);
      const problems = checkRunnerImageLayout(out).join("\n");
      expect(problems).toMatch(/documented path runner-package\/src\/providers\/grok\/platforms\.json \(grokPlatforms\) resolves outside the image/);
    });

    it("accepts a link that stays inside the pack, as pnpm's layout has them", () => {
      const pack = path.join(out, "provider-pack");
      const real = path.join(pack, "node_modules/.pnpm/node@24/node_modules/node");
      mkdirSync(path.dirname(real), { recursive: true });
      renameSync(path.join(pack, "node_modules/node"), real);
      symlinkSync(path.relative(path.join(pack, "node_modules"), real), path.join(pack, "node_modules/node"));
      expect(checkRunnerImageLayout(out)).toEqual([]);
    });
  });

  describe("command line", () => {
    const check = (...args: string[]) => spawnSync(process.execPath, [layoutScript, "check", ...args, "--variant", "full"], { encoding: "utf8" });

    it("passes for a valid tree and fails for a wrong expectation", () => {
      expect(check(out, "--expect-inputs-digest", INPUTS, "--expect-source-revision", REVISION, "--expect-architecture", "amd64").status).toBe(0);
      const wrong = check(out, "--expect-architecture", "arm64");
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toMatch(/architecture is amd64, expected arm64/);
    });

    it.each<[string, string[], RegExp]>([
      ["an empty inputs digest", ["--expect-inputs-digest", ""], /--expect-inputs-digest needs a value/],
      ["an empty source revision", ["--expect-source-revision", ""], /--expect-source-revision needs a value/],
      ["an empty architecture", ["--expect-architecture", ""], /--expect-architecture needs a value/],
      ["a flag with no value", ["--expect-inputs-digest"], /--expect-inputs-digest needs a value/],
      ["a flag whose value is another flag", ["--expect-inputs-digest", "--allow-unstamped"], /--expect-inputs-digest needs a value/],
      ["a misspelt flag", ["--expect-input-digest", INPUTS], /check does not take --expect-input-digest/],
      ["a flag of the other command", ["--identity", "x"], /check does not take --identity/],
      ["a repeated flag", ["--expect-architecture", "amd64", "--expect-architecture", "amd64"], /given twice/],
      ["a malformed inputs digest", ["--expect-inputs-digest", "abc"], /must be 64 hexadecimal characters/],
      ["an abbreviated source revision", ["--expect-source-revision", "abc1234"], /must be a full Git SHA/],
      ["an unknown architecture", ["--expect-architecture", "x64"], /must be amd64 or arm64/],
    ])("rejects %s instead of treating the expectation as not given", (_label, args, expected) => {
      const result = check(out, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(expected);
      expect(result.stdout).not.toMatch(/passed/);
    });

    it("needs exactly one directory, and a known command", () => {
      expect(check().status).toBe(1);
      expect(check(out, out).status).toBe(1);
      expect(spawnSync(process.execPath, [layoutScript, "verify", out], { encoding: "utf8" }).status).toBe(1);
    });

    it("parses the flags each command knows", () => {
      expect(parseLayoutArguments("check", ["tree", "--allow-unstamped", "--expect-architecture", "arm64"])).toEqual({
        positional: ["tree"], flags: { "allow-unstamped": true, "expect-architecture": "arm64" },
      });
      expect(() => parseLayoutArguments("write", ["--out", "o", "--source-revision", ""])).toThrow(/--source-revision needs a value/);
      expect(parseLayoutArguments("write", ["--out", "o", "--publication"]).flags).toEqual({ out: "o", publication: true });
      expect(() => parseLayoutArguments("check", ["tree", "--publication"])).toThrow(/check does not take --publication/);
      // Another script can give the same parser its own flags.
      expect(parseLayoutArguments("unpack", ["a.tar", "--out", "d"], { out: "value" })).toEqual({ positional: ["a.tar"], flags: { out: "d" } });
      expect(() => parseLayoutArguments("unpack", ["--variant", "slim"], { out: "value" })).toThrow(/unpack does not take --variant/);
      expect(() => parseLayoutArguments("write", ["--expect-architecture", "arm64"])).toThrow(/write does not take/);
    });
  });

  describe("a build without a source revision", () => {
    it("has the daemon and the Runner build but no pack, and is not a complete image", async () => {
      const unstamped = await image({ stamped: false });
      const manifest = manifestOf(unstamped);
      expect(manifest.sourceRevision).toBeNull();
      expect(manifest.providerPack).toBeNull();
      expect(manifest.inputsDigest.digest).toBe(INPUTS);
      expect(checkRunnerImageLayout(unstamped).join("\n")).toMatch(/has no source revision/);
      expect(checkRunnerImageLayout(unstamped, { allowUnstamped: true })).toEqual([]);
      // It is still checked: the daemon and the stamp must hold.
      appendFileSync(path.join(unstamped, "runner-package/dist/index.js"), "// later edit\n");
      expect(checkRunnerImageLayout(unstamped, { allowUnstamped: true }).join("\n")).toMatch(/changed size/);
    });
  });

  it("writes nothing at the image root that the documented layout does not list", () => {
    const documented = new Set(Object.values(RUNNER_IMAGE_PATHS).map((relative) => (relative as string).split("/")[0]));
    expect(new Set(readdirSync(out))).toEqual(documented);
    expect([...documented].sort()).toEqual(["bundles", "paperclip-runnerd", "pnpm-lock.yaml", "provider-pack",
      "provider-pack.archive.json", "provider-pack.archives", "runner-image.json", "runner-package"]);
  });
});
