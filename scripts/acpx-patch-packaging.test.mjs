import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

import cliEsbuildConfig from "../cli/esbuild.config.mjs";
import { bundledCliNpmDependencies } from "./cli-bundled-npm-dependencies.mjs";
import {
  createBundledInstallManifest,
  configureBundledProviderOverrides,
  materializePublishManifest,
  selectBundledDependencyPatches,
  stageBundledEsbuildOptionalDependencies,
  stageBundledProviderOptionalDependencies,
} from "./prepare-bundled-package.mjs";

const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const profileData = JSON.parse(await readFile(new URL("../packages/paperclip-runner/acpx-profiles.json", import.meta.url), "utf8"));
const nativeTargets = ["linux-x64", "darwin-arm64", "darwin-x64"];
function esbuildFixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-bundled-esbuild-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const graph = join(directory, "node_modules");
  const writePackage = (location, metadata) => {
    mkdirSync(location, { recursive: true });
    writeFileSync(join(location, "package.json"), JSON.stringify(metadata));
    return location;
  };
  const acpx = writePackage(join(graph, "acpx"), { name: "acpx", version: "0.13.1" });
  const esbuild = writePackage(join(acpx, "node_modules/esbuild"), {
    name: "esbuild", version: "0.28.2", scripts: { postinstall: "node install.js" },
    optionalDependencies: Object.fromEntries([...nativeTargets, "win32-x64"].map(target => [`@esbuild/${target}`, "0.28.2"])),
  });
  const producerBinary = writePackage(join(graph, "@esbuild/linux-x64"), {
    name: "@esbuild/linux-x64", version: "0.28.2", os: ["linux"], cpu: ["x64"],
  });
  writePackage(join(graph, "unrelated-linux-x64"), { name: "unrelated-linux-x64", version: "1.0.0" });
  const publish = { name: "@paperclipai/adapter-utils", version: "0.3.1", bundleDependencies: ["acpx"],
    dependencies: { acpx: "0.13.1" }, optionalDependencies: { unrelated: "1.0.0" } };
  return { directory, graph, esbuild, producerBinary, publish, writePackage };
}
const codexTargets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];
const codexOptional = Object.fromEntries(codexTargets.map(target => [`@openai/codex-${target}`, `npm:@openai/codex@0.160.0-${target}`]));
function codexFixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-bundled-codex-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const graph = join(directory, "node_modules");
  const writePackage = (location, metadata) => {
    mkdirSync(location, { recursive: true }); writeFileSync(join(location, "package.json"), JSON.stringify(metadata)); return location;
  };
  const bridge = writePackage(join(graph, "@agentclientprotocol/codex-acp"), { name: "@agentclientprotocol/codex-acp", version: "1.6.2", dependencies: { "@openai/codex": "0.160.0" } });
  writeFileSync(join(bridge, "index.js"), "export {};\n");
  const runtime = writePackage(join(graph, "@openai/codex"), { name: "@openai/codex", version: "0.160.0", bin: { codex: "bin/codex.js" }, optionalDependencies: codexOptional });
  mkdirSync(join(runtime, "bin")); writeFileSync(join(runtime, "bin/codex.js"), "// official JavaScript fixture, never executed\n");
  mkdirSync(join(runtime, "vendor")); writeFileSync(join(runtime, "vendor/codex"), "producer fallback binary fixture, never executed");
  const producer = writePackage(join(graph, "@openai/codex-linux-x64"), { name: "@openai/codex", version: "0.160.0-linux-x64", os: ["linux"], cpu: ["x64"] });
  mkdirSync(join(producer, "vendor")); writeFileSync(join(producer, "vendor/codex"), "producer optional binary fixture, never executed");
  const nested = writePackage(join(bridge, "node_modules/@openai/codex-darwin-arm64"), { name: "@openai/codex", version: "0.160.0-darwin-arm64", os: ["darwin"], cpu: ["arm64"] });
  writePackage(join(graph, "unrelated-linux-x64"), { name: "unrelated-linux-x64", version: "1.0.0" });
  const profiles = [{ agent: "codex", ...profileData.profiles.codex }];
  const publish = { name: "paperclip-codex-pack-fixture", version: "1.0.0", dependencies: { "@agentclientprotocol/codex-acp": "1.6.2" }, bundleDependencies: ["@agentclientprotocol/codex-acp"] };
  return { directory, graph, bridge, runtime, producer, nested, profiles, publish, writePackage };
}
const adapterUtilsPackage = JSON.parse(
  await readFile(new URL("../packages/adapter-utils/package.json", import.meta.url), "utf8"),
);
const runnerPackage = JSON.parse(
  await readFile(new URL("../packages/paperclip-runner/package.json", import.meta.url), "utf8"),
);
const serverPackage = JSON.parse(
  await readFile(new URL("../server/package.json", import.meta.url), "utf8"),
);
const dbPackage = JSON.parse(
  await readFile(new URL("../packages/db/package.json", import.meta.url), "utf8"),
);
const releaseScript = await readFile(new URL("./release.sh", import.meta.url), "utf8");
const releaseLib = await readFile(new URL("./release-lib.sh", import.meta.url), "utf8");
const buildNpmScript = await readFile(new URL("./build-npm.sh", import.meta.url), "utf8");

const acpxRuntimePatch = await readFile(
  new URL("../patches/acpx@0.13.1.patch", import.meta.url),
  "utf8",
);
const claudeAcpPatch = await readFile(
  new URL("../patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch", import.meta.url),
  "utf8",
);

for (const version of ["0.12.0", "0.13.1"]) {
  test(`ACPX ${version} release patch uses portable generated unified hunks`, async () => {
    const patch = await readFile(
      new URL(`../patches/acpx@${version}.patch`, import.meta.url),
      "utf8",
    );
    const lines = patch.split("\n");
    let hunkCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const header = lines[index].match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
      );
      if (!header) continue;
      hunkCount += 1;
      const body = [];
      let oldLines = 0;
      let newLines = 0;
      while (index + 1 < lines.length && (oldLines < Number(header[2] ?? 1) || newLines < Number(header[4] ?? 1))) {
        const line = lines[++index];
        // Unified diff's EOF marker is metadata, not a source/destination
        // line, and may occur between the removed and added final lines.
        if (line === "\\ No newline at end of file") continue;
        // Git accepts an empty context line with its optional space omitted.
        assert.ok(line === "" || /^[ +\-]/.test(line), `invalid unified hunk line: ${line}`);
        const normalized = line === "" ? " " : line;
        body.push(normalized);
        if (!normalized.startsWith("+")) oldLines += 1;
        if (!normalized.startsWith("-")) newLines += 1;
      }
      assert.equal(
        body.filter((line) => !line.startsWith("+")).length,
        Number(header[2] ?? 1),
      );
      assert.equal(
        body.filter((line) => !line.startsWith("-")).length,
        Number(header[4] ?? 1),
      );
      const prefix = body.findIndex((line) => !line.startsWith(" "));
      const suffix = body
        .slice()
        .reverse()
        .findIndex((line) => !line.startsWith(" "));
      // pnpm patch-commit emits three context lines. Hand-added asymmetric
      // context can force GNU patch's locate_hunk() to require EOF even when
      // BSD patch and git apply accept the same source and hunk.
      assert.ok(
        prefix >= 0 && prefix <= 3,
        `regenerate ${version} hunk at old line ${header[1]} with pnpm patch-commit (prefix ${prefix})`,
      );
      assert.ok(
        suffix >= 0 && suffix <= 3,
        `regenerate ${version} hunk at old line ${header[1]} with pnpm patch-commit (suffix ${suffix})`,
      );
    }
    assert.ok(hunkCount > 0);
  });
}

test("published packages preserve the patched ACPX runtime", () => {
  assert.equal(
    rootPackage.pnpm.patchedDependencies["acpx@0.12.0"],
    "patches/acpx@0.12.0.patch",
  );
  assert.equal(
    rootPackage.pnpm.patchedDependencies["acpx@0.13.1"],
    "patches/acpx@0.13.1.patch",
  );
  assert.equal(adapterUtilsPackage.dependencies.acpx, "0.12.0");
  assert.deepEqual(adapterUtilsPackage.bundleDependencies, ["acpx"]);
  assert.equal(serverPackage.dependencies.acpx, "0.13.1");
  assert.ok(serverPackage.bundleDependencies.includes("acpx"));
  assert.equal(bundledCliNpmDependencies.has("acpx"), true);
  assert.equal(cliEsbuildConfig.external.includes("acpx"), false);
});

test("published Codex bridge uses its qualified producer closure without consumer overrides", () => {
  const published = materializePublishManifest(serverPackage);
  const { installManifest, profiles } = configureBundledProviderOverrides(
    createBundledInstallManifest(published, serverPackage.bundleDependencies),
    serverPackage.bundleDependencies, rootPackage, profileData,
  );
  assert.equal(profiles.length, 1);
  for (const profile of profiles) {
    assert.equal(published.dependencies[profile.agentServerPackage], profile.agentServerVersion);
    assert.ok(published.bundleDependencies.includes(profile.agentServerPackage));
    assert.equal(installManifest.overrides[`${profile.agentServerPackage}@${profile.agentServerVersion}`][profile.agentRuntimePackage], profile.agentRuntimeVersion);
  }
  assert.equal(published.overrides, undefined);
  assert.equal(installManifest.overrides.rollup, undefined);
  const bad = structuredClone(rootPackage);
  bad.pnpm.overrides["@agentclientprotocol/codex-acp@1.6.2>@openai/codex"] = "0.156.1";
  assert.throws(() => configureBundledProviderOverrides(installManifest, serverPackage.bundleDependencies, bad, profileData), /runtime override must match/);
  const unpinned = createBundledInstallManifest(published, serverPackage.bundleDependencies);
  unpinned.dependencies["@agentclientprotocol/codex-acp"] = "^1.6.2";
  assert.throws(() => configureBundledProviderOverrides(unpinned, serverPackage.bundleDependencies, rootPackage, profileData), /exact qualified profile/);
  const conflict = createBundledInstallManifest(published, serverPackage.bundleDependencies);
  conflict.overrides = { "@agentclientprotocol/codex-acp@1.6.2": { "@openai/codex": "0.156.1" } };
  assert.throws(() => configureBundledProviderOverrides(conflict, serverPackage.bundleDependencies, rootPackage, profileData), /conflicting producer override/);
});

test("Codex bundles retain pinned JavaScript and delegate official consumer platform aliases without native payloads", (t) => {
  const { directory, graph, bridge, runtime, producer, nested, profiles, publish } = codexFixture(t);
  const before = [bridge, runtime].map(path => readFileSync(join(path, "package.json"), "utf8"));
  const staged = stageBundledProviderOptionalDependencies(directory, publish, profiles);
  assert.deepEqual(staged.optionalDependencies, codexOptional);
  assert.deepEqual(staged.bundleDependencies, publish.bundleDependencies);
  assert.equal(staged.paperclipProviderArtifacts, undefined);
  assert.equal(existsSync(producer), false);
  assert.equal(existsSync(nested), false, "Transitive producer platform packages must also be removed");
  assert.equal(existsSync(join(runtime, "vendor")), false, "Wrapper fallback native payload must be removed");
  assert.equal(existsSync(join(graph, "unrelated-linux-x64")), true);
  assert.equal(readFileSync(join(bridge, "package.json"), "utf8"), before[0], "The patched bridge metadata is unchanged");
  const originalRuntime = JSON.parse(before[1]); delete originalRuntime.optionalDependencies;
  assert.deepEqual(JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")), originalRuntime,
    "Only the wrapper platform declarations move to the published authority root");
  assert.equal(readFileSync(join(runtime, "bin/codex.js"), "utf8"), "// official JavaScript fixture, never executed\n");
  assert.deepEqual(stageBundledProviderOptionalDependencies(directory, staged, profiles), staged);
  writeFileSync(join(directory, "package.json"), JSON.stringify(staged));
  const packs = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--offline", "--json"], {
    cwd: directory, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: directory, npm_config_cache: join(directory, "cache"), npm_config_update_notifier: "false" },
  }));
  const paths = packs[0].files.map(file => file.path);
  assert.ok(paths.some(path => path.endsWith("@openai/codex/bin/codex.js")), "The actual npm tarball retains its pinned JS runtime");
  assert.equal(paths.some(path => /@openai\/codex-(?:linux|darwin|win32)-|@openai\/codex\/vendor\//.test(path)), false,
    "Actual npm pack must contain no native Codex payload on any platform");
});

test("Codex bundle validation fails before deleting producer binaries for altered pins or optional declarations", (t) => {
  const { directory, runtime, producer, profiles, publish } = codexFixture(t);
  const file = join(runtime, "package.json"), original = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...original, version: "0.156.1" }));
  assert.throws(() => stageBundledProviderOptionalDependencies(directory, publish, profiles), /runtime version mismatch/);
  writeFileSync(file, JSON.stringify({ ...original, optionalDependencies: { ...codexOptional, "@openai/codex-untrusted": "0.160.0" } }));
  assert.throws(() => stageBundledProviderOptionalDependencies(directory, publish, profiles), /not qualified/);
  writeFileSync(file, JSON.stringify(original));
  const missing = { ...original }; delete missing.optionalDependencies;
  writeFileSync(file, JSON.stringify(missing));
  assert.throws(() => stageBundledProviderOptionalDependencies(directory, publish, profiles), /not qualified/,
    "Missing wrapper declarations require the exact published-root delegation mapping");
  writeFileSync(file, JSON.stringify(original));
  assert.throws(() => stageBundledProviderOptionalDependencies(directory, { ...publish,
    optionalDependencies: { "@openai/codex-darwin-arm64": "npm:@openai/codex@0.156.1-darwin-arm64" } }, profiles), /conflicts with published/);
  assert.equal(existsSync(producer), true);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(original), "Conflicting root declarations must not normalize metadata");
});

test("Codex stripping rejects linked native payloads and wrapper fallback directories without touching external files", (t) => {
  const { directory, runtime, producer, profiles, publish, writePackage } = codexFixture(t);
  const outside = writePackage(join(directory, "outside"), { name: "@openai/codex", version: "0.160.0-linux-x64", os: ["linux"], cpu: ["x64"] });
  rmSync(producer, { recursive: true }); symlinkSync(outside, producer, "dir");
  assert.throws(() => stageBundledProviderOptionalDependencies(directory, publish, profiles), /escapes its producer graph/);
  rmSync(producer); rmSync(join(runtime, "vendor"), { recursive: true }); symlinkSync(outside, join(runtime, "vendor"), "dir");
  assert.throws(() => stageBundledProviderOptionalDependencies(directory, publish, profiles), /escapes its producer graph/);
  assert.equal(existsSync(join(outside, "package.json")), true);
});

test("Linux-produced esbuild bundles publish exact consumer platform dependencies and retain their hooks", (t) => {
  const { directory, graph, esbuild, producerBinary, publish, writePackage } = esbuildFixture(t);
  const original = readFileSync(join(esbuild, "package.json"), "utf8");
  const issuer = createRequire(join(esbuild, "package.json"));
  // The original producer-only topology cannot resolve a Mac binary. The
  // public optional declaration lets npm obtain it before offline hooks run.
  assert.throws(() => issuer.resolve("@esbuild/darwin-arm64/bin/esbuild"), /Cannot find module/);
  const staged = stageBundledEsbuildOptionalDependencies(directory, publish);
  for (const target of [...nativeTargets, "win32-x64"]) assert.equal(staged.optionalDependencies[`@esbuild/${target}`], "0.28.2");
  assert.equal(staged.optionalDependencies.unrelated, "1.0.0");
  assert.deepEqual(staged.bundleDependencies, ["acpx"]);
  assert.deepEqual(staged.dependencies, publish.dependencies);
  assert.equal(publish.optionalDependencies["@esbuild/darwin-arm64"], undefined);
  assert.equal(existsSync(producerBinary), false);
  assert.equal(existsSync(join(graph, "unrelated-linux-x64")), true);
  assert.equal(readFileSync(join(esbuild, "package.json"), "utf8"), original);
  assert.deepEqual(stageBundledEsbuildOptionalDependencies(directory, staged), staged);
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const artifact = writePackage(join(graph, `@esbuild/${target}`), {
      name: `@esbuild/${target}`, version: staged.optionalDependencies[`@esbuild/${target}`], os: ["darwin"], cpu: [target.slice(7)],
    });
    mkdirSync(join(artifact, "bin")); writeFileSync(join(artifact, "bin/esbuild"), "consumer-selected fixture; never executed");
    assert.equal(issuer.resolve(`@esbuild/${target}/bin/esbuild`), join(artifact, "bin/esbuild"));
  }
});

test("bundled esbuild rejects conflicting published or nested platform versions without removing the producer", (t) => {
  const { directory, graph, producerBinary, publish, writePackage } = esbuildFixture(t);
  assert.throws(() => stageBundledEsbuildOptionalDependencies(directory, {
    ...publish, optionalDependencies: { "@esbuild/darwin-arm64": "0.27.0" },
  }), /platform version conflicts/);
  assert.equal(existsSync(producerBinary), true);
  writePackage(join(graph, "esbuild"), { name: "esbuild", version: "0.27.0",
    optionalDependencies: Object.fromEntries(nativeTargets.map(target => [`@esbuild/${target}`, "0.27.0"])) });
  assert.throws(() => stageBundledEsbuildOptionalDependencies(directory, publish), /platform version conflicts|installed platform identity mismatch/);
  assert.equal(existsSync(producerBinary), true);
});

test("bundled esbuild rejects missing targets, altered declarations and incorrect platform identity", (t) => {
  const { directory, esbuild, producerBinary, publish } = esbuildFixture(t);
  const path = join(esbuild, "package.json"), metadata = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...metadata, optionalDependencies: { "@esbuild/linux-x64": "0.28.2" } }));
  assert.throws(() => stageBundledEsbuildOptionalDependencies(directory, publish), /omitted a supported platform/);
  writeFileSync(path, JSON.stringify({ ...metadata, optionalDependencies: { ...metadata.optionalDependencies, "@esbuild/win32-x64": "^0.28.2" } }));
  assert.throws(() => stageBundledEsbuildOptionalDependencies(directory, publish), /exact package version/);
  writeFileSync(path, JSON.stringify(metadata));
  writeFileSync(join(producerBinary, "package.json"), JSON.stringify({ name: "@esbuild/linux-x64", version: "0.27.0" }));
  assert.throws(() => stageBundledEsbuildOptionalDependencies(directory, publish), /installed platform identity mismatch/);
  assert.equal(existsSync(producerBinary), true);
});

test("bundled esbuild cannot follow a platform payload or package namespace outside its producer graph", (t) => {
  const { directory, graph, producerBinary, publish, writePackage } = esbuildFixture(t);
  const external = writePackage(join(directory, "outside"), { name: "@esbuild/linux-x64", version: "0.28.2" });
  rmSync(producerBinary, { recursive: true }); symlinkSync(external, producerBinary, "dir");
  assert.throws(() => stageBundledEsbuildOptionalDependencies(directory, publish), /escapes its producer graph/);
  assert.equal(readFileSync(join(external, "package.json"), "utf8").includes("0.28.2"), true);
  rmSync(join(graph, "@esbuild"), { recursive: true }); symlinkSync(external, join(graph, "@esbuild"), "dir");
  assert.throws(() => stageBundledEsbuildOptionalDependencies(directory, publish), /escapes its producer graph/);
});

test("Paperclip Runner pins the qualified ACPX host callbacks", () => {
  assert.equal(rootPackage.pnpm.patchedDependencies["acpx@0.13.1"], "patches/acpx@0.13.1.patch");
  assert.equal(
    rootPackage.pnpm.patchedDependencies["@agentclientprotocol/claude-agent-acp@0.73.0"],
    "patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch",
  );
  assert.equal(runnerPackage.dependencies.acpx, "0.13.1");
  assert.equal(runnerPackage.dependencies["@agentclientprotocol/claude-agent-acp"], "0.73.0");
  assert.equal(runnerPackage.dependencies["@agentclientprotocol/codex-acp"], "1.6.2");
  for (const callback of [
    "spawnEnvironment", "spawnCwd", "spawnAgent", "isPlainStringEnvironment",
    "onAgentSpawn", "onAgentStderr", "onAgentExit",
    "onSessionNotification", "onClientOperation",
  ]) assert.match(acpxRuntimePatch, new RegExp(callback));
  assert.match(claudeAcpPatch, /usage: \{/);
  assert.match(claudeAcpPatch, /cache_creation_input_tokens/);
});

test("published packages preserve the patched embedded-postgres runtime", () => {
  assert.equal(
    rootPackage.pnpm.patchedDependencies["embedded-postgres@18.1.0-beta.16"],
    "patches/embedded-postgres@18.1.0-beta.16.patch",
  );
  assert.deepEqual(dbPackage.bundleDependencies, ["embedded-postgres"]);
  assert.equal(bundledCliNpmDependencies.has("embedded-postgres"), true);
  assert.equal(cliEsbuildConfig.external.includes("embedded-postgres"), false);
});

test("bundled package staging materializes publishConfig entrypoints", () => {
  const staged = materializePublishManifest(adapterUtilsPackage);

  assert.equal(staged.publishConfig, undefined);
  assert.equal(staged.main, "./dist/index.js");
  assert.equal(staged.types, "./dist/index.d.ts");
  assert.deepEqual(staged.exports, adapterUtilsPackage.publishConfig.exports);
});

test("bundled package staging materializes workspace dependency versions", () => {
  const staged = materializePublishManifest({
    name: "@paperclipai/example",
    version: "2026.723.0",
    dependencies: { exact: "workspace:*", caret: "workspace:^", tilde: "workspace:~" },
  });

  assert.deepEqual(staged.dependencies, {
    exact: "2026.723.0",
    caret: "^2026.723.0",
    tilde: "~2026.723.0",
  });
});

test("bundled package staging installs only dependencies included in the tarball", () => {
  const publishManifest = {
    name: "@paperclipai/db",
    version: "2026.723.0-canary.8",
    dependencies: {
      "@paperclipai/shared": "2026.723.0-canary.8",
      "drizzle-orm": "^0.45.2",
      "embedded-postgres": "^18.1.0-beta.16",
    },
    devDependencies: {
      "@paperclipai/paperclip-runner": "2026.723.0-canary.8",
    },
    bundleDependencies: ["embedded-postgres"],
  };
  const installManifest = createBundledInstallManifest(publishManifest, ["embedded-postgres"]);

  assert.deepEqual(installManifest.dependencies, {
    "embedded-postgres": "^18.1.0-beta.16",
  });
  assert.equal(installManifest.devDependencies, undefined);
  assert.deepEqual(publishManifest.devDependencies, {
    "@paperclipai/paperclip-runner": "2026.723.0-canary.8",
  });
  assert.deepEqual(installManifest.bundleDependencies, ["embedded-postgres"]);
});

test("bundled package staging selects only the installed dependency version's patch", (t) => {
  const destinationDir = mkdtempSync(join(tmpdir(), "paperclip-bundled-patch-selection-"));
  const installedPackageDir = join(destinationDir, "node_modules", "acpx");
  mkdirSync(installedPackageDir, { recursive: true });
  writeFileSync(
    join(installedPackageDir, "package.json"),
    JSON.stringify({ name: "acpx", version: "0.12.0" }),
  );
  t.after(() => rmSync(destinationDir, { recursive: true, force: true }));

  assert.deepEqual(
    selectBundledDependencyPatches(destinationDir, ["acpx"], {
      "acpx@0.12.0": "patches/acpx@0.12.0.patch",
      "acpx@0.13.1": "patches/acpx@0.13.1.patch",
    }),
    [
      {
        packageName: "acpx",
        specifier: "acpx@0.12.0",
        patchPath: "patches/acpx@0.12.0.patch",
      },
    ],
  );
});

test("bundled package patch selection handles scoped package names", (t) => {
  const destinationDir = mkdtempSync(join(tmpdir(), "paperclip-scoped-patch-selection-"));
  const installedPackageDir = join(destinationDir, "node_modules", "@example", "runtime");
  mkdirSync(installedPackageDir, { recursive: true });
  writeFileSync(
    join(installedPackageDir, "package.json"),
    JSON.stringify({ name: "@example/runtime", version: "1.2.3" }),
  );
  t.after(() => rmSync(destinationDir, { recursive: true, force: true }));

  assert.deepEqual(
    selectBundledDependencyPatches(destinationDir, ["@example/runtime"], {
      "@example/runtime@1.2.3": "patches/runtime@1.2.3.patch",
      "@example/runtime@2.0.0": "patches/runtime@2.0.0.patch",
    }),
    [
      {
        packageName: "@example/runtime",
        specifier: "@example/runtime@1.2.3",
        patchPath: "patches/runtime@1.2.3.patch",
      },
    ],
  );
});

test("bundled package patch selection reports missing installed metadata", (t) => {
  const destinationDir = mkdtempSync(join(tmpdir(), "paperclip-missing-patch-metadata-"));
  t.after(() => rmSync(destinationDir, { recursive: true, force: true }));

  assert.throws(
    () =>
      selectBundledDependencyPatches(destinationDir, ["acpx"], {
        "acpx@0.12.0": "patches/acpx@0.12.0.patch",
      }),
    /Cannot select a patch for bundled dependency acpx: failed to read/,
  );
});

test("bundled package patch selection rejects an unpatched installed version", (t) => {
  const destinationDir = mkdtempSync(join(tmpdir(), "paperclip-unmatched-patch-version-"));
  const installedPackageDir = join(destinationDir, "node_modules", "acpx");
  mkdirSync(installedPackageDir, { recursive: true });
  writeFileSync(
    join(installedPackageDir, "package.json"),
    JSON.stringify({ name: "acpx", version: "0.14.0" }),
  );
  t.after(() => rmSync(destinationDir, { recursive: true, force: true }));

  assert.throws(
    () =>
      selectBundledDependencyPatches(destinationDir, ["acpx"], {
        "acpx@0.12.0": "patches/acpx@0.12.0.patch",
        "acpx@0.13.1": "patches/acpx@0.13.1.patch",
      }),
    /installed acpx@0\.14\.0, but configured patches are acpx@0\.12\.0, acpx@0\.13\.1/,
  );
});

test("server package staging applies every bundled runtime patch and preserves the vendored runner", (t) => {
  const fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-bundled-stage-")));
  const sourceDir = join(fixtureDir, "source");
  const destinationDir = join(fixtureDir, "destination");
  const binDir = join(fixtureDir, "bin");
  const callLog = join(fixtureDir, "calls.log");
  const fixtureSourceRoot = join(fixtureDir, "repo");
  const fixtureArtifacts = join(fixtureDir, "native-artifacts");
  mkdirSync(sourceDir);
  mkdirSync(join(sourceDir, "dist"));
  writeFileSync(join(sourceDir, "dist", "index.js"), "export {};\n");
  mkdirSync(destinationDir);
  mkdirSync(binDir);
  writeFileSync(
    join(sourceDir, "package.json"),
    JSON.stringify({ ...serverPackage, files: ["dist"] }),
  );
  writeFileSync(callLog, "");
  mkdirSync(fixtureArtifacts);
  const nativePackage = join(fixtureArtifacts, "@openai/codex-linux-x64");
  mkdirSync(join(nativePackage, "vendor"), { recursive: true });
  writeFileSync(join(nativePackage, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.160.0-linux-x64", os: ["linux"], cpu: ["x64"] }));
  writeFileSync(join(nativePackage, "vendor/codex"), "producer host fixture; never executed");
  mkdirSync(join(fixtureSourceRoot, "packages/paperclip-runner/src/drivers/acpx"), { recursive: true });
  writeFileSync(join(fixtureSourceRoot, "package.json"), JSON.stringify(rootPackage));
  writeFileSync(join(fixtureSourceRoot, "packages/paperclip-runner/acpx-profiles.json"), JSON.stringify(profileData));
  mkdirSync(join(fixtureSourceRoot, "patches"));
  for (const patchPath of Object.values(rootPackage.pnpm.patchedDependencies)) {
    writeFileSync(join(fixtureSourceRoot, patchPath), readFileSync(new URL(`../${patchPath}`, import.meta.url)));
  }
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  const writeExecutable = (name, body) => {
    writeFileSync(join(binDir, name), body, { mode: 0o755 });
  };
  writeExecutable(
    "pnpm",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$FAKE_CALL_LOG"
destination="\${!#}"
cp "$FAKE_SOURCE_PACKAGE" "$destination/package.json"
mkdir -p "$destination/node_modules/.pnpm"
`,
  );
  writeExecutable(
    "npm",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$FAKE_CALL_LOG"
[ "$*" = "install --omit=dev --ignore-scripts --no-audit --no-fund" ]
node -e 'const fs = require("node:fs"); const pkg = require("./package.json"); if ("devDependencies" in pkg) process.exit(1); for (const [name, version] of Object.entries(pkg.dependencies)) { const dir = "node_modules/" + name; fs.mkdirSync(dir + "/dist", { recursive: true }); fs.writeFileSync(dir + "/package.json", JSON.stringify({ name, version })); } for (const [bridge, runtimes] of Object.entries(pkg.overrides ?? {})) { for (const [name, version] of Object.entries(runtimes)) { const dir = "node_modules/" + name; fs.mkdirSync(dir, { recursive: true }); const native = name === "@openai/codex"; const optionalDependencies = native ? Object.fromEntries(["linux-x64","linux-arm64","darwin-x64","darwin-arm64","win32-x64","win32-arm64"].map(target => [name+"-"+target,"npm:"+name+"@"+version+"-"+target])) : undefined; fs.writeFileSync(dir + "/package.json", JSON.stringify({ name, version, optionalDependencies })); } }'
node -e 'const fs=require("node:fs");fs.cpSync(process.env.FAKE_NATIVE_ARTIFACTS+"/@openai/codex-linux-x64","node_modules/@openai/codex-linux-x64",{recursive:true});fs.mkdirSync("node_modules/@openai/codex/vendor",{recursive:true});fs.writeFileSync("node_modules/@openai/codex/vendor/codex","producer fallback fixture");'
mkdir -p node_modules/acpx/dist
node -e 'const fs=require("node:fs");fs.mkdirSync("node_modules/esbuild",{recursive:true});fs.writeFileSync("node_modules/esbuild/package.json",JSON.stringify({name:"esbuild",version:"0.28.2",scripts:{postinstall:"node install.js"},optionalDependencies:Object.fromEntries(["linux-x64","darwin-arm64","darwin-x64"].map(target=>["@esbuild/"+target,"0.28.2"]))}));fs.mkdirSync("node_modules/@esbuild/linux-x64",{recursive:true});fs.writeFileSync("node_modules/@esbuild/linux-x64/package.json",JSON.stringify({name:"@esbuild/linux-x64",version:"0.28.2",os:["linux"],cpu:["x64"]}));'
printf 'unpatched runtime\\n' > node_modules/acpx/dist/runtime.js
printf '{"name":"acpx","version":"0.13.1"}\\n' > node_modules/acpx/package.json
`,
  );
  writeExecutable(
    "patch",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'patch %s\\n' "$*" >> "$FAKE_CALL_LOG"
target=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    target="$2"
    shift 2
  else
    shift
  fi
done
patch_input="$(cat)"
printf '%s\\n' "$patch_input" > "$target/applied.patch"
if [[ "$target" != */acpx ]]; then
  exit 0
fi
grep -q spawnEnvironment <<< "$patch_input"
grep -q spawnAgent <<< "$patch_input"
grep -q onAgentStderr <<< "$patch_input"
printf 'patched spawnEnvironment runtime\\n' > "$target/dist/runtime.js"
`,
  );

  execFileSync(
    process.execPath,
    [
      "--input-type=module", "-e",
      `import { prepareBundledPackage } from ${JSON.stringify(new URL("./prepare-bundled-package.mjs", import.meta.url).href)}; prepareBundledPackage(process.argv[1], process.argv[2], { sourceRoot: process.argv[3] });`,
      sourceDir,
      destinationDir,
      fixtureSourceRoot,
    ],
    {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_CALL_LOG: callLog,
        FAKE_SOURCE_PACKAGE: join(sourceDir, "package.json"),
        FAKE_NATIVE_ARTIFACTS: fixtureArtifacts,
      },
      stdio: "pipe",
    },
  );

  const stagedAcpxDir = join(destinationDir, "node_modules/acpx");
  assert.equal(lstatSync(stagedAcpxDir).isDirectory(), true);
  assert.equal(lstatSync(stagedAcpxDir).isSymbolicLink(), false);
  assert.equal(existsSync(join(destinationDir, "node_modules/.pnpm")), false);
  const stagedManifest = JSON.parse(readFileSync(join(destinationDir, "package.json"), "utf8"));
  for (const [name, version] of Object.entries(codexOptional)) {
    assert.equal(stagedManifest.optionalDependencies[name], version);
    assert.equal(existsSync(join(destinationDir, "node_modules", name)), false);
    assert.equal(stagedManifest.bundleDependencies.includes(name), false);
  }
  assert.equal(existsSync(join(destinationDir, "node_modules/@openai/codex/vendor")), false);
  assert.equal(stagedManifest.paperclipProviderArtifacts, undefined);
  assert.equal(JSON.parse(readFileSync(join(destinationDir, "node_modules/@openai/codex/package.json"), "utf8")).optionalDependencies, undefined);
  assert.equal(stagedManifest.optionalDependencies["@esbuild/darwin-arm64"], "0.28.2");
  assert.equal(stagedManifest.optionalDependencies["@esbuild/darwin-x64"], "0.28.2");
  assert.equal(existsSync(join(destinationDir, "node_modules/@esbuild/linux-x64")), false);
  assert.equal(JSON.parse(readFileSync(join(destinationDir, "node_modules/esbuild/package.json"))).scripts.postinstall, "node install.js");
  assert.match(
    readFileSync(join(stagedAcpxDir, "dist/runtime.js"), "utf8"),
    /spawnEnvironment/,
  );
  assert.match(
    readFileSync(callLog, "utf8"),
    /patch -p1 --forward -d .*node_modules\/acpx/,
  );
  const patchedBundledDependencies = serverPackage.bundleDependencies.filter(name => rootPackage.pnpm.patchedDependencies[`${name}@${serverPackage.dependencies[name]}`]);
  assert.equal(
    readFileSync(callLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("patch ")).length,
    patchedBundledDependencies.length,
  );
  for (const name of patchedBundledDependencies) {
    const specifier = `${name}@${serverPackage.dependencies[name]}`;
    const patchPath = rootPackage.pnpm.patchedDependencies[specifier];
    assert.equal(
      readFileSync(
        join(destinationDir, "node_modules", name, "applied.patch"),
        "utf8",
      ),
      `${readFileSync(new URL(`../${patchPath}`, import.meta.url), "utf8").trimEnd()}\n`,
      `${specifier} receives its own full configured patch`,
    );
  }
});

test("bundled package dry runs preview without querying published versions", () => {
  assert.match(releaseScript, /run_bundled_npm_pack pack --pack-destination "\$publish_dir"/);
  assert.match(releaseLib, /BUNDLED_NPM_PACK_VERSION="10\.9\.7"/);
  assert.match(releaseLib, /BUNDLED_NPM_PUBLISH_VERSION="11\.18\.0"/);
  assert.match(
    releaseLib,
    /npx --yes "npm@\$BUNDLED_NPM_PACK_VERSION" "\$@" --ignore-scripts/,
  );
  assert.match(
    releaseLib,
    /npx --yes "npm@\$BUNDLED_NPM_PUBLISH_VERSION" "\$@" --ignore-scripts/,
  );
  assert.match(releaseLib, /"\$@" --ignore-scripts --loglevel verbose/);
  assert.match(releaseLib, /run_bundled_npm_publish publish --tag "\$dist_tag"/);
  assert.doesNotMatch(releaseLib, /run_bundled_npm_publish publish "\.\/\$tarball"/);
});

test("npm builds use corepack instead of requiring a global pnpm", () => {
  assert.match(buildNpmScript, /corepack pnpm -r typecheck/);
  assert.doesNotMatch(buildNpmScript, /^\s*pnpm -r typecheck/m);
});


test("installed ACPX runtime persists and restores optional goal capabilities", () => {
  const requireRunner = createRequire(new URL("../packages/paperclip-runner/package.json", import.meta.url));
  const runtimeSource = readFileSync(requireRunner.resolve("acpx/runtime"), "utf8");
  const start = runtimeSource.indexOf("function persistedGoalCapability(");
  const end = runtimeSource.indexOf("function planUpdateEvent(", start);
  assert.ok(start >= 0 && end > start, "the installed patch must define both goal helpers");
  const helpers = runInNewContext(runtimeSource.slice(start, end) + ";({ persistedGoalCapability, restoredGoalCapability })", {
    isRecord: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  });
  assert.equal(helpers.persistedGoalCapability(undefined), undefined);
  assert.equal(helpers.restoredGoalCapability(undefined), undefined);
  const goal = { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "clear"] };
  const saved = JSON.parse(JSON.stringify(helpers.persistedGoalCapability(goal)));
  assert.equal(saved.control_method, "_session/goal");
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.restoredGoalCapability(saved))), goal);
  assert.equal(helpers.persistedGoalCapability({ ...goal, version: 2 }), undefined);
  assert.equal(helpers.persistedGoalCapability({ ...goal, actions: ["set"] }), undefined);
});
