import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { providersWithTests, runProviderTests } from "./test-sandbox-providers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerRoot = "packages/plugins/sandbox-providers";

const harness = (statuses = {}) => {
  const calls = { prepared: 0, ran: [], output: "", active: 0, peak: 0 };
  return {
    calls,
    options: {
      root: "/repo",
      providers: ["p/a", "p/b", "p/c"],
      concurrency: 2,
      grouped: false,
      prepare: () => {
        calls.prepared += 1;
        return 0;
      },
      runOne: async ({ directory }) => {
        calls.ran.push(directory);
        calls.active += 1;
        calls.peak = Math.max(calls.peak, calls.active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.active -= 1;
        return { status: statuses[directory] ?? 0, output: `${directory} output`, seconds: 1.25 };
      },
      write: (text) => {
        calls.output += text;
      },
    },
  };
};

test("every top-level sandbox provider runs its own suite", () => {
  const onDisk = readdirSync(path.join(root, providerRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${providerRoot}/${entry.name}`)
    .filter((directory) => {
      try {
        return Boolean(JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8")).scripts?.test);
      } catch {
        return false;
      }
    });
  assert.ok(onDisk.length > 0);
  assert.deepEqual([...providersWithTests({ root })].sort(), onDisk.sort());
});

test("a provider nested in another provider runs with its parent", () => {
  const providers = providersWithTests({ root });
  assert.ok(providers.includes(`${providerRoot}/cloudflare`));
  assert.ok(!providers.includes(`${providerRoot}/cloudflare/bridge-template`));
  const config = readFileSync(path.join(root, providerRoot, "cloudflare", "vitest.config.ts"), "utf8");
  assert.match(config, /bridge-template\/src\/\*\*\/\*\.test\.ts/, "Cloudflare's config must keep running bridge-template tests");
});

test("all suites run after one install, within the concurrency limit", async () => {
  const { calls, options } = harness();
  assert.equal(await runProviderTests(options), 0);
  assert.equal(calls.prepared, 1);
  assert.deepEqual([...calls.ran].sort(), ["p/a", "p/b", "p/c"]);
  assert.equal(calls.peak, 2);
  assert.match(calls.output, /^--- a: passed in 1\.3s\np\/a output\n/m);
  assert.match(calls.output, /3 of 3 provider suites passed/);
});

test("one failing suite fails the run after the others finish", async () => {
  const { calls, options } = harness({ "p/b": 1 });
  assert.equal(await runProviderTests(options), 1);
  assert.deepEqual([...calls.ran].sort(), ["p/a", "p/b", "p/c"]);
  assert.match(calls.output, /--- b: failed in 1\.3s/);
  assert.match(calls.output, /2 of 3 provider suites passed/);
  assert.match(calls.output, /failed: b\n/);
});

test("a failed install runs no suite", async () => {
  const { calls, options } = harness();
  assert.equal(await runProviderTests({ ...options, prepare: () => 7 }), 7);
  assert.deepEqual(calls.ran, []);
});

test("an empty provider list fails instead of passing silently", async () => {
  const { calls, options } = harness();
  assert.equal(await runProviderTests({ ...options, providers: [] }), 1);
  assert.equal(calls.prepared, 0);
});

test("GitHub Actions output folds each suite and annotates failures", async () => {
  const { calls, options } = harness({ "p/a": 1 });
  await runProviderTests({ ...options, grouped: true, providers: ["p/a"] });
  assert.match(calls.output, /^::group::a: failed in 1\.3s\np\/a output\n::endgroup::\n/);
  assert.match(calls.output, /::error title=Sandbox provider tests::a failed/);
});
