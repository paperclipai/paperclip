import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readRunnerImageManifest, runnerImageTags, SLIM_DIGEST_ANNOTATION } from "../../../scripts/runner-image-publish.mjs";
import {
  formatOutputs,
  parseResolveArguments,
  readRunnerInputs,
  resolveRunnerImage,
  runResolveCommand,
} from "../../../scripts/runner-image-resolve.mjs";

const INPUTS = "1".repeat(64);
const TAGS = runnerImageTags(INPUTS);
const IMAGE = "ghcr.io/paperclipai/paperclip-runner";
const sha256 = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const scratch = mkdtempSync(path.join(tmpdir(), "runner-image-resolve-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;
const directory = () => path.join(scratch, String((sequence += 1)));

type Manifest = Awaited<ReturnType<typeof readRunnerImageManifest>>;
const present = (value: unknown) => {
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return { state: "present" as const, bytes, digest: sha256(bytes) };
};
const platforms = (...architectures: string[]) => architectures.map((architecture) => (
  { digest: sha256(`image ${architecture}`), size: 500, platform: { os: "linux", architecture } }));
const slim = present({ schemaVersion: 2, manifests: platforms("amd64", "arm64") });
const fullIndex = (annotations: Record<string, string>, manifests = platforms("amd64", "arm64")) =>
  present({ schemaVersion: 2, manifests, annotations });
const full = fullIndex({ "io.paperclip.runner.inputs-digest": INPUTS, [SLIM_DIGEST_ANNOTATION]: slim.digest });
const registry = (tags: Record<string, Manifest>) => async (reference: string): Promise<Manifest> => tags[reference] ?? { state: "absent" };
const current = { lock: "current" as const, inputsDigest: INPUTS };
const NOTHING = { image: "", slimImage: "", buildContexts: [], labels: [] };

describe("the Runner an image build uses", () => {
  it("is the published image, pinned by digest, with the slim image its full index names", async () => {
    const resolved = await resolveRunnerImage(current, { read: registry({ [TAGS.full]: full, [TAGS.slim]: slim }) });
    expect(resolved).toMatchObject({
      mode: "published",
      inputsDigest: INPUTS,
      image: `${IMAGE}@${full.digest}`,
      slimImage: `${IMAGE}@${slim.digest}`,
      buildContexts: [
        `runner-artifacts=docker-image://${IMAGE}@${full.digest}`,
        `runner-artifacts-slim=docker-image://${IMAGE}@${slim.digest}`,
      ],
      labels: [`io.paperclip.runner.image=${IMAGE}@${full.digest}`, `io.paperclip.runner.inputs-digest=${INPUTS}`],
    });
    expect(Object.keys(resolved).sort()).toEqual(["buildContexts", "detail", "image", "inputsDigest", "labels", "mode", "reason", "slimImage"]);
  });

  it.each<[string, string, Record<string, Manifest>]>([
    ["neither tag exists", "absent", {}],
    ["a publication stopped before the full tag", "incomplete", { [TAGS.slim]: slim }],
    ["the slim tag is missing", "broken", { [TAGS.full]: full }],
    ["the slim tag names an image the full index does not", "broken", { [TAGS.full]: full, [TAGS.slim]: present({ other: true }) }],
    ["the full tag is not an index", "broken", { [TAGS.full]: present("not JSON"), [TAGS.slim]: slim }],
    ["the registry gives no clear answer", "unknown", { [TAGS.full]: { state: "unknown", detail: "manifest request: HTTP 503" } }],
    ["the full index names other inputs", "mismatch", {
      [TAGS.full]: fullIndex({ "io.paperclip.runner.inputs-digest": "2".repeat(64), [SLIM_DIGEST_ANNOTATION]: slim.digest }), [TAGS.slim]: slim,
    }],
    ["the full index names no inputs", "mismatch", { [TAGS.full]: fullIndex({ [SLIM_DIGEST_ANNOTATION]: slim.digest }), [TAGS.slim]: slim }],
    ["the full index lacks a platform", "mismatch", {
      [TAGS.full]: fullIndex({ "io.paperclip.runner.inputs-digest": INPUTS, [SLIM_DIGEST_ANNOTATION]: slim.digest }, platforms("amd64")), [TAGS.slim]: slim,
    }],
  ])("is inline, with nothing to pass to the build, when %s", async (_label, reason, tags) => {
    expect(await resolveRunnerImage(current, { read: registry(tags) })).toMatchObject({ mode: "inline", reason, ...NOTHING });
  });

  it.each<[string, (url: string) => Promise<Response>]>([
    ["cannot be reached", async () => { throw new TypeError("fetch failed"); }],
    ["refuses the token", async () => new Response("", { status: 403 })],
    ["denies the manifest of a private package", async (url) =>
      (url.includes("/token?") ? new Response(JSON.stringify({ token: "t" })) : new Response("", { status: 401 }))],
    ["keeps failing", async (url) =>
      (url.includes("/token?") ? new Response(JSON.stringify({ token: "t" })) : new Response("", { status: 503 }))],
  ])("is inline when the registry %s", async (_label, fetchImpl) => {
    const read = (reference: string) => readRunnerImageManifest(reference, { fetchImpl, sleep: async () => {} });
    expect(await resolveRunnerImage(current, { read })).toMatchObject({ mode: "inline", reason: "unknown", ...NOTHING });
  });

  it("is inline when the lookup throws, and does not look when the lockfile is behind", async () => {
    const failing = async (): Promise<Manifest> => { throw new Error("Registry digest does not match the manifest bytes"); };
    expect(await resolveRunnerImage(current, { read: failing }))
      .toMatchObject({ mode: "inline", reason: "unknown", detail: expect.stringContaining("does not match the manifest bytes"), ...NOTHING });
    let reads = 0;
    const counting = async (): Promise<Manifest> => { reads += 1; return full; };
    expect(await resolveRunnerImage({ lock: "behind", inputsDigest: null }, { read: counting }))
      .toMatchObject({ mode: "inline", reason: "lock-behind", inputsDigest: "", ...NOTHING });
    expect(reads).toBe(0);
  });

  it("refuses inputs it cannot name instead of resolving them", async () => {
    const read = registry({ [TAGS.full]: full, [TAGS.slim]: slim });
    await expect(resolveRunnerImage({ lock: "current", inputsDigest: null }, { read })).rejects.toThrow(/needs an inputs digest/);
    await expect(resolveRunnerImage({ lock: "stale" as "current", inputsDigest: INPUTS }, { read })).rejects.toThrow(/current or behind/);
  });
});

describe("the inputs of a tree", () => {
  type Call = { command: string; args: string[] };
  function docker(calls: Call[], { digest = INPUTS, fail = "" } = {}) {
    return (command: string, args: string[]) => {
      calls.push({ command, args });
      const target = args[args.indexOf("--target") + 1];
      if (target === fail) return { status: 1 };
      const destination = args[args.indexOf("--output") + 1].replace("type=local,dest=", "");
      mkdirSync(destination, { recursive: true });
      if (target === "runner-artifacts-identity") writeFileSync(path.join(destination, "runner-image-identity.json"), JSON.stringify({ digest }));
      return { status: 0 };
    };
  }
  const lock = (state: "current" | "behind") => () => ({ state, detail: `lockfile ${state}` });

  it("exports the build context, checks its lockfile, then computes the digest in the build", () => {
    const calls: Call[] = [];
    const out = directory();
    const checked: string[] = [];
    const inputs = readRunnerInputs({
      repoRoot: "/repo", directory: out, run: docker(calls),
      lockState: (context: string) => { checked.push(context); return lock("current")(); },
    });
    expect(inputs).toEqual({ lock: "current", detail: "lockfile current", inputsDigest: INPUTS });
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["docker", "buildx", "build", "--target", "runner-artifacts-context", "--output", `type=local,dest=${path.join(out, "context")}`, "/repo"],
      ["docker", "buildx", "build", "--target", "runner-artifacts-identity", "--output", `type=local,dest=${path.join(out, "identity")}`, "/repo"],
    ]);
    expect(checked).toEqual([path.join(out, "context")]);
    expect(JSON.parse(readFileSync(path.join(out, "runner-image-inputs.json"), "utf8"))).toEqual(inputs);
  });

  it("computes no digest for a lockfile that is behind: no image is published for that tree", () => {
    const calls: Call[] = [];
    const inputs = readRunnerInputs({ repoRoot: "/repo", directory: directory(), run: docker(calls), lockState: lock("behind") });
    expect(inputs).toEqual({ lock: "behind", detail: "lockfile behind", inputsDigest: null });
    expect(calls).toHaveLength(1);
  });

  it("fails, and leaves no result, when a build fails or reports no digest", () => {
    for (const options of [{ fail: "runner-artifacts-context" }, { fail: "runner-artifacts-identity" }, { digest: "latest" }]) {
      const out = directory();
      expect(() => readRunnerInputs({ repoRoot: "/repo", directory: out, run: docker([], options), lockState: lock("current") }))
        .toThrow(/failed \(exit 1\)|no inputs digest/);
      expect(existsSync(path.join(out, "runner-image-inputs.json"))).toBe(false);
    }
  });

  it("refuses a directory that could hold the result of another tree", () => {
    const out = directory();
    mkdirSync(out);
    writeFileSync(path.join(out, "runner-image-inputs.json"), JSON.stringify(current));
    const calls: Call[] = [];
    expect(() => readRunnerInputs({ repoRoot: "/repo", directory: out, run: docker(calls), lockState: lock("current") })).toThrow(/is not empty/);
    expect(calls).toEqual([]);
  });
});

describe("command line", () => {
  const quiet = { log: () => {} };

  it("reports the inputs, then resolves them with the registry credentials of the environment", async () => {
    const out = directory();
    const stub = ({ directory: target }: { directory: string }) => {
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "runner-image-inputs.json"), JSON.stringify(current));
      return { lock: "current" as const, detail: "", inputsDigest: INPUTS };
    };
    await expect(runResolveCommand(["inputs", "--dir", out], { ...quiet, env: {}, readInputs: stub })).resolves.toEqual({ lock: "current", inputs_digest: INPUTS });

    const summary = path.join(out, "summary.md");
    const seen: unknown[] = [];
    const read = async (reference: string, options?: { credentials?: unknown }) => {
      seen.push(options?.credentials);
      return registry({ [TAGS.full]: full, [TAGS.slim]: slim })(reference);
    };
    const env = { RUNNER_IMAGE_REGISTRY_USERNAME: "u", RUNNER_IMAGE_REGISTRY_PASSWORD: "p", GITHUB_STEP_SUMMARY: summary };
    const values = await runResolveCommand(["resolve", "--dir", out], { ...quiet, env, read });
    expect(values).toEqual({
      mode: "published",
      reason: "published",
      inputs_digest: INPUTS,
      image: `${IMAGE}@${full.digest}`,
      slim_image: `${IMAGE}@${slim.digest}`,
      build_contexts: `runner-artifacts=docker-image://${IMAGE}@${full.digest}\nrunner-artifacts-slim=docker-image://${IMAGE}@${slim.digest}`,
      labels: `io.paperclip.runner.image=${IMAGE}@${full.digest}\nio.paperclip.runner.inputs-digest=${INPUTS}`,
    });
    expect(seen).toEqual([{ username: "u", password: "p" }, { username: "u", password: "p" }]);
    expect(readFileSync(summary, "utf8")).toContain(`**published**`);

    const inline = await runResolveCommand(["resolve", "--dir", out], { ...quiet, env: {}, read: registry({}) });
    expect(inline).toEqual({ mode: "inline", reason: "absent", inputs_digest: INPUTS, image: "", slim_image: "", build_contexts: "", labels: "" });
  });

  it("writes a value of several lines in the form a workflow output takes", () => {
    const text = formatOutputs({ mode: "published", labels: "a=1\nb=2", image: "" });
    expect(text).toMatch(/^mode=published\nlabels<<(end-[0-9a-f-]{36})\na=1\nb=2\n\1\nimage=$/);
  });

  it.each<[string, string[]]>([
    ["no command", []],
    ["an unknown command", ["wait", "--dir", "d"]],
    ["a missing directory", ["resolve", "--dir"]],
    ["another flag", ["resolve", "--inputs-digest", INPUTS]],
    ["an extra argument", ["inputs", "--dir", "d", "--wait"]],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseResolveArguments(argv)).toThrow(/Usage/);
  });
});
