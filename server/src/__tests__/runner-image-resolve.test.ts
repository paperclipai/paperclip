import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readRunnerImageManifest, runnerImageTags, SLIM_DIGEST_ANNOTATION } from "../../../scripts/runner-image-publish.mjs";
import {
  formatOutputs,
  listRunnerImageRuns,
  parseResolveArguments,
  readRunnerInputs,
  resolveRunnerImage,
  resolveRunnerImageAfterWait,
  RUNNER_IMAGE_WAIT,
  RUNNER_IMAGE_WAIT_MINUTES,
  runResolveCommand,
  waitForRunnerImage,
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
const current = { consumable: true, lock: "current" as const, inputsDigest: INPUTS };
const NOTHING = { image: "", slimImage: "", buildContexts: [], labels: [], buildArgs: [] };
const ASSERTING_DOCKERFILE = "FROM base AS build\nARG PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST=\"\"\n";
function checkout(dockerfile = ASSERTING_DOCKERFILE) {
  const root = directory();
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "Dockerfile"), dockerfile);
  return root;
}

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
      buildArgs: [`PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST=${INPUTS}`],
    });
    expect(Object.keys(resolved).sort()).toEqual(["buildArgs", "buildContexts", "detail", "image", "inputsDigest", "labels", "mode", "reason", "slimImage"]);
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
    expect(await resolveRunnerImage({ consumable: true, lock: "behind", inputsDigest: null }, { read: counting }))
      .toMatchObject({ mode: "inline", reason: "lock-behind", inputsDigest: "", ...NOTHING });
    expect(reads).toBe(0);
  });

  it("is inline, without a lookup, for a tree whose build cannot check the Runner it is given", async () => {
    let reads = 0;
    const counting = async (): Promise<Manifest> => { reads += 1; return full; };
    for (const inputs of [{ ...current, consumable: false }, { lock: "current" as const, inputsDigest: INPUTS } as typeof current]) {
      expect(await resolveRunnerImage(inputs, { read: counting })).toMatchObject({ mode: "inline", reason: "unsupported", ...NOTHING });
    }
    expect(reads).toBe(0);
  });

  it("refuses inputs it cannot name instead of resolving them", async () => {
    const read = registry({ [TAGS.full]: full, [TAGS.slim]: slim });
    await expect(resolveRunnerImage({ consumable: true, lock: "current", inputsDigest: null }, { read })).rejects.toThrow(/needs an inputs digest/);
    await expect(resolveRunnerImage({ consumable: true, lock: "stale" as "current", inputsDigest: INPUTS }, { read })).rejects.toThrow(/current or behind/);
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
    const repo = checkout();
    const checked: string[] = [];
    const inputs = readRunnerInputs({
      repoRoot: repo, directory: out, run: docker(calls),
      lockState: (context: string) => { checked.push(context); return lock("current")(); },
    });
    expect(inputs).toEqual({ consumable: true, lock: "current", detail: "lockfile current", inputsDigest: INPUTS });
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["docker", "buildx", "build", "--target", "runner-artifacts-context", "--output", `type=local,dest=${path.join(out, "context")}`, repo],
      ["docker", "buildx", "build", "--target", "runner-artifacts-identity", "--output", `type=local,dest=${path.join(out, "identity")}`, repo],
    ]);
    expect(checked).toEqual([path.join(out, "context")]);
    expect(JSON.parse(readFileSync(path.join(out, "runner-image-inputs.json"), "utf8"))).toEqual(inputs);
  });

  it("computes no digest for a lockfile that is behind: no image is published for that tree", () => {
    const calls: Call[] = [];
    const inputs = readRunnerInputs({ repoRoot: checkout(), directory: directory(), run: docker(calls), lockState: lock("behind") });
    expect(inputs).toEqual({ consumable: true, lock: "behind", detail: "lockfile behind", inputsDigest: null });
    expect(calls).toHaveLength(1);
  });

  it.each<[string, string]>([
    ["has no such argument", "FROM base AS build\nARG PAPERCLIP_BUILD_COMMIT=\"\"\n"],
    ["only names the argument in other text", "FROM base AS build\nRUN echo ARG PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST\nARG PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST_OLD=1\n"],
  ])("runs no build for a Dockerfile that %s: its build could not refuse another Runner", (_label, dockerfile) => {
    const calls: Call[] = [];
    const out = directory();
    const inputs = readRunnerInputs({ repoRoot: checkout(dockerfile), directory: out, run: docker(calls), lockState: lock("current") });
    expect(inputs).toMatchObject({ consumable: false, lock: null, inputsDigest: null });
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(out, "runner-image-inputs.json"), "utf8"))).toEqual(inputs);
  });

  it("fails, and leaves no result, when a build fails or reports no digest", () => {
    for (const options of [{ fail: "runner-artifacts-context" }, { fail: "runner-artifacts-identity" }, { digest: "latest" }]) {
      const out = directory();
      expect(() => readRunnerInputs({ repoRoot: checkout(), directory: out, run: docker([], options), lockState: lock("current") }))
        .toThrow(/failed \(exit 1\)|no inputs digest/);
      expect(existsSync(path.join(out, "runner-image-inputs.json"))).toBe(false);
    }
  });

  it("refuses a directory that could hold the result of another tree", () => {
    const out = directory();
    mkdirSync(out);
    writeFileSync(path.join(out, "runner-image-inputs.json"), JSON.stringify(current));
    const calls: Call[] = [];
    expect(() => readRunnerInputs({ repoRoot: checkout(), directory: out, run: docker(calls), lockState: lock("current") })).toThrow(/is not empty/);
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
      return { consumable: true, lock: "current" as const, detail: "", inputsDigest: INPUTS };
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
      build_args: `PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST=${INPUTS}`,
    });
    expect(seen).toEqual([{ username: "u", password: "p" }, { username: "u", password: "p" }]);
    expect(readFileSync(summary, "utf8")).toContain(`**published**`);

    const inline = await runResolveCommand(["resolve", "--dir", out], { ...quiet, env: {}, read: registry({}) });
    expect(inline).toEqual({
      mode: "inline", reason: "absent", inputs_digest: INPUTS, image: "", slim_image: "", build_contexts: "", labels: "", build_args: "",
    });
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
    ["a wait for the command that builds", ["inputs", "--dir", "d", "--wait"]],
    ["an extra argument", ["resolve", "--dir", "d", "--wait", "--wait"]],
    ["another flag in place of the wait", ["resolve", "--dir", "d", "--strict"]],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseResolveArguments(argv)).toThrow(/Usage/);
  });
});

describe("the wait for the Runner image of a master push", () => {
  const SHA = "a".repeat(40);
  const CANONICAL = { id: 1170821064 };
  type Run = Record<string, unknown>;
  const run = (overrides: Run = {}): Run => ({
    id: 7, head_sha: SHA, event: "push", head_branch: "master", path: ".github/workflows/runner-image.yml",
    repository: CANONICAL, head_repository: CANONICAL, status: "in_progress", conclusion: null,
    created_at: new Date(0).toISOString(), html_url: "https://github.com/paperclipai/paperclip/actions/runs/7", ...overrides,
  });
  const completed = (conclusion: string, overrides: Run = {}) => run({ status: "completed", conclusion, ...overrides });
  const absent = { mode: "inline", reason: "absent", detail: "the tag does not exist" };
  const published = { mode: "published", reason: "published", detail: "both tags exist" };
  const MINUTE = 60_000;
  const { limitMs, listingMs, pollMs } = RUNNER_IMAGE_WAIT;

  function scenario({ lists, answers = [absent], startedAt = 0 }: { lists: Array<Run[] | Error>, answers?: object[], startedAt?: number }) {
    let time = startedAt;
    const sleeps: number[] = [];
    let listed = 0;
    let resolved = 0;
    const next = <T,>(values: T[], index: number) => values[Math.min(index, values.length - 1)];
    return {
      sleeps,
      counts: () => ({ listed, resolved }),
      elapsed: () => time - startedAt,
      options: {
        sha: SHA,
        now: () => time,
        sleep: async (ms: number) => { time += ms; sleeps.push(ms); },
        listRuns: async () => {
          const answer = next(lists, listed);
          listed += 1;
          if (answer instanceof Error) throw answer;
          return answer;
        },
        resolve: async () => {
          resolved += 1;
          return next(answers, resolved - 1);
        },
      },
    };
  }

  it("has one limit, in minutes, that every duration of the wait is read from", () => {
    expect(RUNNER_IMAGE_WAIT_MINUTES).toBe(40);
    expect(limitMs).toBe(RUNNER_IMAGE_WAIT_MINUTES * MINUTE);
    expect(listingMs).toBeLessThan(limitMs);
    expect(pollMs).toBeLessThan(listingMs);
  });

  it("ends as soon as the image is published, while the run that published it is still working", async () => {
    const wait = scenario({ lists: [[run()]], answers: [absent, absent, published] });
    const result = await waitForRunnerImage(wait.options);
    expect(result).toMatchObject({ outcome: "published", resolved: published });
    expect(wait.sleeps).toEqual([pollMs, pollMs]);
    expect(wait.counts()).toEqual({ listed: 3, resolved: 3 });
  });

  it.each(["success", "failure", "cancelled", "skipped", "timed_out"])("ends when the run completes with %s, and leaves the answer to the next lookup", async (conclusion) => {
    const wait = scenario({ lists: [[run()], [run()], [completed(conclusion)]] });
    const result = await waitForRunnerImage(wait.options);
    expect(result.outcome).toBe("completed");
    expect(result).not.toHaveProperty("resolved");
    expect(result.detail).toContain(`actions/runs/7 (${conclusion})`);
    expect(result.detail).toContain("waited 1 min");
    expect(wait.counts()).toEqual({ listed: 3, resolved: 2 });
  });

  it("retries while the run is not listed yet, and gives up when none is listed in time", async () => {
    const late = scenario({ lists: [[], [], [run()], [completed("success")]] });
    expect((await waitForRunnerImage(late.options)).outcome).toBe("completed");
    expect(late.sleeps).toHaveLength(3);

    const never = scenario({ lists: [[]] });
    const result = await waitForRunnerImage(never.options);
    expect(result.outcome).toBe("not-listed");
    expect(never.elapsed()).toBe(listingMs);
    expect(never.counts().resolved).toBe(0);
  });

  it("waits for every run of the commit, not for the first one that completes", async () => {
    const second = { id: 9, html_url: "https://github.com/paperclipai/paperclip/actions/runs/9" };
    const wait = scenario({ lists: [[completed("failure"), run(second)], [completed("failure"), run(second)], [completed("failure"), completed("success", second)]] });
    const result = await waitForRunnerImage(wait.options);
    expect(result.outcome).toBe("completed");
    expect(result.detail).toContain("actions/runs/7 (failure)");
    expect(result.detail).toContain("actions/runs/9 (success)");
    expect(wait.sleeps).toHaveLength(2);
  });

  it.each<[string, Run]>([
    ["of another commit", { head_sha: "b".repeat(40) }],
    ["of a pull request", { event: "pull_request" }],
    ["of the weekly schedule", { event: "schedule" }],
    ["started by hand", { event: "workflow_dispatch" }],
    ["of another branch", { head_branch: "release" }],
    ["of another workflow", { path: ".github/workflows/docker.yml" }],
    ["in another repository", { repository: { id: 1 } }],
    ["from a fork", { head_repository: { id: 1 } }],
  ])("does not wait for a run %s", async (_label, overrides) => {
    const wait = scenario({ lists: [[completed("success", overrides), run(overrides)]] });
    expect((await waitForRunnerImage(wait.options)).outcome).toBe("not-listed");
    expect(wait.counts().resolved).toBe(0);
  });

  it("measures the limit from the push, so a build that started late waits less or not at all", async () => {
    const late = scenario({ lists: [[run()]], startedAt: limitMs - MINUTE });
    const result = await waitForRunnerImage(late.options);
    expect(result.outcome).toBe("limit");
    expect(late.elapsed()).toBe(MINUTE);
    expect(result.detail).toContain(`within ${RUNNER_IMAGE_WAIT_MINUTES} min of the push`);

    const expired = scenario({ lists: [[run()]], startedAt: limitMs + 10 * MINUTE });
    expect((await waitForRunnerImage(expired.options)).outcome).toBe("limit");
    expect(expired.sleeps).toEqual([]);
    expect(expired.counts()).toEqual({ listed: 1, resolved: 1 });

    const onTime = scenario({ lists: [[run()]], startedAt: MINUTE });
    expect((await waitForRunnerImage(onTime.options)).outcome).toBe("limit");
    expect(onTime.elapsed()).toBe(limitMs - MINUTE);
  });

  it("measures the limit from the oldest run of the commit, and from its own start when no run names a time", async () => {
    const rerun = scenario({ lists: [[completed("failure"), run({ id: 9, created_at: new Date(30 * MINUTE).toISOString() })]], startedAt: 39 * MINUTE });
    expect((await waitForRunnerImage(rerun.options)).outcome).toBe("limit");
    expect(rerun.elapsed()).toBe(MINUTE);

    const undated = scenario({ lists: [[run({ created_at: "soon" })]], startedAt: 5 * limitMs });
    expect((await waitForRunnerImage(undated.options)).outcome).toBe("limit");
    expect(undated.elapsed()).toBe(limitMs);
  });

  it("stops when the Actions API keeps failing, and goes on when it recovers", async () => {
    const down = scenario({ lists: [new Error("GitHub API: HTTP 502")] });
    const result = await waitForRunnerImage(down.options);
    expect(result).toMatchObject({ outcome: "unknown", detail: expect.stringContaining("HTTP 502") });
    expect(down.counts()).toEqual({ listed: RUNNER_IMAGE_WAIT.failures, resolved: 0 });

    const flaky = scenario({ lists: [new Error("fetch failed"), new Error("fetch failed"), [run()], new Error("fetch failed"), new Error("fetch failed"), [completed("success")]] });
    expect((await waitForRunnerImage(flaky.options)).outcome).toBe("completed");
    expect(flaky.counts().listed).toBe(6);
  });

  it.each(["absent", "incomplete"])("waits when the image is %s, then looks once more", async (reason) => {
    const answers = [{ mode: "inline", reason, detail: "not published" }, published];
    let lookups = 0;
    let waits = 0;
    const resolved = await resolveRunnerImageAfterWait({
      resolve: async () => answers[lookups++],
      wait: async () => { waits += 1; return { outcome: "completed", detail: "waited 12 min" }; },
    });
    expect(resolved).toEqual({ ...published, detail: "both tags exist; waited 12 min" });
    expect({ lookups, waits }).toEqual({ lookups: 2, waits: 1 });
  });

  it.each(["published", "lock-behind", "unsupported", "broken", "mismatch", "unknown"])("does not wait when the first answer is %s", async (reason) => {
    const first = { mode: reason === "published" ? "published" : "inline", reason, detail: "first" };
    let waits = 0;
    const resolved = await resolveRunnerImageAfterWait({ resolve: async () => first, wait: async () => { waits += 1; return { outcome: "completed", detail: "" }; } });
    expect(resolved).toBe(first);
    expect(waits).toBe(0);
  });

  it.each(["completed", "not-listed", "limit", "unknown"])("is inline, with the reason of the last lookup, when the wait ends as %s without an image", async (outcome) => {
    let lookups = 0;
    const resolved = await resolveRunnerImageAfterWait({
      resolve: async () => { lookups += 1; return absent; },
      wait: async () => ({ outcome, detail: `the wait ended: ${outcome}` }),
    });
    expect(resolved).toEqual({ ...absent, detail: `the tag does not exist; the wait ended: ${outcome}` });
    expect(lookups).toBe(2);
  });

  it("uses the image the wait found without another lookup", async () => {
    let lookups = 0;
    const resolved = await resolveRunnerImageAfterWait({
      resolve: async () => { lookups += 1; return absent; },
      wait: async () => ({ outcome: "published", resolved: published, detail: "waited 3 min" }),
    });
    expect(resolved).toMatchObject({ mode: "published", detail: "both tags exist; waited 3 min" });
    expect(lookups).toBe(1);
  });

  describe("on the command line", () => {
    const TOKEN = "token-for-the-test";
    type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
    function prepared() {
      const out = directory();
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "runner-image-inputs.json"), JSON.stringify(current));
      return out;
    }
    const instant: typeof waitForRunnerImage = (options) => {
      let time = 0;
      return waitForRunnerImage({ ...options, now: () => time, sleep: async (ms: number) => { time += ms; } });
    };
    const actions = (pages: Run[][], seen: Array<{ url: string, authorization: string }> = []): Fetch => async (url, init) => {
      seen.push({ url, authorization: init.headers.authorization });
      return new Response(JSON.stringify({ workflow_runs: pages[Math.min(seen.length - 1, pages.length - 1)] }));
    };

    it("waits for the run of GITHUB_SHA with the token of the environment, then reports the image it published", async () => {
      const out = prepared();
      const seen: Array<{ url: string, authorization: string }> = [];
      const tags: Record<string, Manifest> = {};
      const fetchImpl = actions([[run()], [completed("success")]], seen);
      const lines: string[] = [];
      const read = async (reference: string) => {
        if (seen.length === 2) Object.assign(tags, { [TAGS.full]: full, [TAGS.slim]: slim });
        return registry(tags)(reference);
      };
      const values = await runResolveCommand(["resolve", "--dir", out, "--wait"], {
        env: { GITHUB_SHA: SHA, GITHUB_TOKEN: TOKEN }, read, fetchImpl: fetchImpl as typeof fetch, waitFor: instant, log: (line) => lines.push(line),
      });
      expect(values).toMatchObject({ mode: "published", image: `${IMAGE}@${full.digest}`, build_args: `PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST=${INPUTS}` });
      expect(seen).toHaveLength(2);
      for (const request of seen) {
        expect(request.url).toBe(`https://api.github.com/repos/paperclipai/paperclip/actions/workflows/runner-image.yml/runs?head_sha=${SHA}&event=push&branch=master&per_page=30`);
        expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      }
      expect(lines.join("\n")).toContain("actions/runs/7 (success)");
      expect(lines.join("\n")).not.toContain("::notice");
      expect(lines.join("\n")).not.toContain(TOKEN);
    });

    it.each<[string, Run[][], RegExp]>([
      ["fails", [[run()], [completed("failure")]], /actions\/runs\/7 \(failure\)/],
      ["is cancelled", [[completed("cancelled")]], /actions\/runs\/7 \(cancelled\)/],
      ["publishes nothing because the lockfile is behind", [[completed("success")]], /actions\/runs\/7 \(success\)/],
      ["is never listed", [[]], /no Runner image run of a master push/],
    ])("is inline, says why in a notice and does not fail when the run %s", async (_label, pages, detail) => {
      const lines: string[] = [];
      const values = await runResolveCommand(["resolve", "--dir", prepared(), "--wait"], {
        env: { GITHUB_SHA: SHA, GITHUB_TOKEN: TOKEN }, read: registry({}), fetchImpl: actions(pages) as typeof fetch, waitFor: instant, log: (line) => lines.push(line),
      });
      expect(values).toMatchObject({ mode: "inline", reason: "absent", image: "", build_contexts: "", labels: "", build_args: "" });
      const notice = lines.filter((line) => line.startsWith("::notice title=Runner built inline::"));
      expect(notice).toHaveLength(1);
      expect(notice[0]).toMatch(detail);
    });

    it.each<[string, NodeJS.ProcessEnv, Fetch]>([
      ["there is no token", { GITHUB_SHA: SHA }, async () => { throw new Error("no request is expected"); }],
      ["the commit is not a full SHA", { GITHUB_SHA: "master", GITHUB_TOKEN: TOKEN }, async () => { throw new Error("no request is expected"); }],
      ["the Actions API refuses", { GITHUB_SHA: SHA, GITHUB_TOKEN: TOKEN }, async () => new Response("", { status: 403 })],
      ["the Actions API cannot be reached", { GITHUB_SHA: SHA, GITHUB_TOKEN: TOKEN }, async () => { throw new TypeError("fetch failed"); }],
      ["the Actions API answers with something else", { GITHUB_SHA: SHA, GITHUB_TOKEN: TOKEN }, async () => new Response(JSON.stringify({ message: "moved" }))],
    ])("is inline without waiting when %s", async (_label, env, fetchImpl) => {
      const values = await runResolveCommand(["resolve", "--dir", prepared(), "--wait"], {
        env, read: registry({}), fetchImpl: fetchImpl as typeof fetch, waitFor: instant, log: () => {},
      });
      expect(values).toMatchObject({ mode: "inline", reason: "absent" });
    });

    it("is inline when the wait itself throws, and asks the Actions API nothing when the image exists or no wait is asked for", async () => {
      const failing = async (): Promise<never> => { throw new Error("clock failure"); };
      const refusing: Fetch = async () => { throw new Error("no request is expected"); };
      const env = { GITHUB_SHA: SHA, GITHUB_TOKEN: TOKEN };
      const lines: string[] = [];
      await expect(runResolveCommand(["resolve", "--dir", prepared(), "--wait"], { env, read: registry({}), waitFor: failing, log: (line) => lines.push(line) }))
        .resolves.toMatchObject({ mode: "inline", reason: "absent" });
      expect(lines.join("\n")).toContain("the wait failed: clock failure");
      const exists = registry({ [TAGS.full]: full, [TAGS.slim]: slim });
      await expect(runResolveCommand(["resolve", "--dir", prepared(), "--wait"], { env, read: exists, fetchImpl: refusing as typeof fetch, waitFor: failing, log: () => {} }))
        .resolves.toMatchObject({ mode: "published" });
      await expect(runResolveCommand(["resolve", "--dir", prepared()], { env, read: registry({}), fetchImpl: refusing as typeof fetch, waitFor: failing, log: () => {} }))
        .resolves.toMatchObject({ mode: "inline", reason: "absent" });
    });

    it("refuses to list runs without a token or a full commit, and an answer that is not a list of runs", async () => {
      const ok: Fetch = async () => new Response(JSON.stringify({ workflow_runs: [run()] }));
      await expect(listRunnerImageRuns(SHA, { token: TOKEN, fetchImpl: ok as typeof fetch })).resolves.toHaveLength(1);
      await expect(listRunnerImageRuns(SHA, { fetchImpl: ok as typeof fetch })).rejects.toThrow(/token/);
      await expect(listRunnerImageRuns("a".repeat(7), { token: TOKEN, fetchImpl: ok as typeof fetch })).rejects.toThrow(/full SHA/);
      await expect(listRunnerImageRuns(SHA, { token: TOKEN, fetchImpl: (async () => new Response("", { status: 500 })) as typeof fetch })).rejects.toThrow(/HTTP 500/);
      await expect(listRunnerImageRuns(SHA, { token: TOKEN, fetchImpl: (async () => new Response("{}")) as typeof fetch })).rejects.toThrow(/no list of workflow runs/);
    });
  });
});
