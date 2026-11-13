import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { bundleVerifiedProviderEntrypoints } from "./build-verified-provider-entrypoints.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("Kimi metadata CLI is self-contained and rejects incomplete assets without inheriting credentials or making requests", { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-kimi-metadata-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundles = await bundleVerifiedProviderEntrypoints({ write: false });
  const bundle = bundles.find(value => value.entrypoint.name === "kimi-metadata-probe");
  assert.ok(bundle, "The ordinary provider pack build must include the metadata CLI");
  const bytes = bundle.verifiedResult.outputFiles[0].contents;
  const relocatedBuild = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createHash } from "node:crypto";
    import { bundleVerifiedProviderEntrypoints } from ${JSON.stringify(new URL("./build-verified-provider-entrypoints.mjs", import.meta.url).href)};
    const bundles = await bundleVerifiedProviderEntrypoints({ write: false });
    const bytes = bundles.find(value => value.entrypoint.name === "kimi-metadata-probe").verifiedResult.outputFiles[0].contents;
    process.stdout.write("sha256:" + createHash("sha256").update(bytes).digest("hex"));
  `], { cwd: root, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10_000 });
  assert.ifError(relocatedBuild.error);
  assert.equal(relocatedBuild.status, 0, relocatedBuild.stderr);
  assert.equal(relocatedBuild.stdout, sha(bytes), "Metadata CLI admission bytes must be independent of the build cwd");
  const entry = join(root, "kimi-metadata-probe.cjs");
  await writeFile(entry, bytes);
  assert.doesNotMatch(Buffer.from(bytes).toString(), /\bimport\.meta\b/);
  for (const output of Object.values(bundle.verifiedResult.metafile.outputs)) {
    for (const dependency of output.imports) assert.match(dependency.path, /^node:/);
  }
  const manifest = join(root, "package.json");
  await writeFile(manifest, '{"name":"@paperclipai/paperclip-runner","type":"module"}');
  const preload = join(root, "deny-external-work.cjs");
  await writeFile(preload, `
    const assert = require("node:assert/strict");
    process.nextTick(() => {
      for (const name of ["KIMI_API_KEY", "PAPERCLIP_KIMI_PROBE_MODEL", "KIMI_MODEL_DEFAULT", "HOME", "HTTPS_PROXY", "NODE_OPTIONS", "NODE_PATH", "ANTHROPIC_API_KEY", "PAPERCLIP_ACPX_CANDIDATE_ADMISSION"]) {
        assert.equal(process.env[name], undefined, name);
      }
      assert.equal(process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT, ${JSON.stringify(root)});
    });
    const fail = () => { throw Error("UNEXPECTED_NETWORK_OR_CHILD"); };
    globalThis.fetch = fail;
    for (const name of ["node:net", "node:tls", "node:http", "node:https"]) {
      const dependency = require(name);
      for (const key of ["connect", "createConnection", "request", "get"]) if (key in dependency) dependency[key] = fail;
    }
    const child = require("node:child_process");
    for (const key of ["spawn", "exec", "execFile"]) child[key] = fail;
  `);
  const pinnedNode = join(packageRoot, "provider-assets/kimi", `${process.platform}-${process.arch}`, "runtime/node/bin/node");
  const node = await stat(pinnedNode).then(() => pinnedNode, () => process.execPath);
  const profile = JSON.parse(await readFile(join(packageRoot, "acpx-profiles.json"), "utf8")).profiles.kimi;
  const { KIMI_DISTRIBUTION_CLOSURE_SHA256 } = await import(new URL("../src/drivers/acpx/kimi-closure-pins.ts", import.meta.url));
  const admission = { schema: "paperclip.acpx-candidate-admission.v1", companyId: "metadata-cli-company", agent: "kimi", model: "selected-model",
    profileDigest: profile.commandDigest, nativeClosureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[`${process.platform}-${process.arch}`]}`,
    platform: process.platform, architecture: process.arch, expiresAt: Date.now() + 60_000,
    runId: "metadata-operation", normalizedSessionId: "metadata-session" };
  const child = spawnSync(node, ["--require", preload, entry], {
    env: { KIMI_API_KEY: "selected-secret-canary", PAPERCLIP_KIMI_PROBE_MODEL: "selected-model",
      ...(profile.qualificationStatus === "pending" ? { PAPERCLIP_ACPX_CANDIDATE_ADMISSION: JSON.stringify(admission) } : {}),
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: root, PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST: manifest,
      KIMI_MODEL_DEFAULT: "unselected-model", HOME: "/private/unselected-home", HTTPS_PROXY: "http://127.0.0.1:9",
      ANTHROPIC_API_KEY: "unselected-secret-canary", NODE_OPTIONS: "", NODE_PATH: "/unselected-module-path" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.equal(child.signal, null);
  assert.doesNotMatch(child.stdout + child.stderr, /UNEXPECTED_NETWORK_OR_CHILD|selected-secret-canary|unselected-secret-canary/);
  assert.deepEqual(JSON.parse(child.stdout), { schema: "paperclip.kimi.metadata.v1", status: "failed",
    code: "KIMI_INSTALLATION_INVALID", message: process.versions.node === "24.21.0" || node === pinnedNode
      ? "Install the current verified Kimi Code runtime in this execution environment."
      : "Kimi metadata verification requires the pinned Node runtime.", promptSent: false });

  const withoutAdmission = spawnSync(node, ["--require", preload, entry], {
    env: { KIMI_API_KEY: "selected-secret-canary", PAPERCLIP_KIMI_PROBE_MODEL: "selected-model",
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: root, PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST: manifest },
    encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(withoutAdmission.error); assert.equal(withoutAdmission.status, 1);
  if (process.versions.node === "24.21.0" || node === pinnedNode) {
    assert.equal(JSON.parse(withoutAdmission.stdout).code,
      profile.qualificationStatus === "pending" ? "KIMI_QUALIFICATION_REQUIRED" : "KIMI_INSTALLATION_INVALID");
  }
  assert.doesNotMatch(withoutAdmission.stdout + withoutAdmission.stderr, /UNEXPECTED_NETWORK_OR_CHILD|selected-secret-canary/);

  if (profile.qualificationStatus !== "pending") {
    const formerAdmission = spawnSync(node, ["--require", preload, entry], {
      env: { KIMI_API_KEY: "selected-secret-canary", PAPERCLIP_KIMI_PROBE_MODEL: "selected-model",
        PAPERCLIP_ACPX_CANDIDATE_ADMISSION: JSON.stringify(admission),
        PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: root, PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST: manifest,
        HOME: "/private/unselected-home", HTTPS_PROXY: "http://127.0.0.1:9", ANTHROPIC_API_KEY: "unselected-secret-canary" },
      encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(formerAdmission.error); assert.equal(formerAdmission.status, 1); assert.equal(formerAdmission.signal, null);
    assert.deepEqual(JSON.parse(formerAdmission.stdout), { schema: "paperclip.kimi.metadata.v1", status: "failed",
      code: "KIMI_REQUEST_FAILED", message: "Kimi Code metadata verification failed.", promptSent: false });
    assert.doesNotMatch(formerAdmission.stdout + formerAdmission.stderr, /UNEXPECTED_NETWORK_OR_CHILD|selected-secret-canary|unselected-secret-canary/);
  }

  for (const layout of ["runner", "server"]) {
    const packageDirectory = join(root, layout);
    const outputRoot = layout === "server" ? join(packageDirectory, "dist/vendor/paperclip-runner") : join(packageDirectory, "dist");
    const helper = join(outputRoot, "drivers/acpx/kimi-metadata-probe.js");
    const cli = join(outputRoot, "cli/kimi-metadata-probe.cjs");
    await mkdir(dirname(cli), { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), '{"type":"module"}');
    await writeFile(cli, bytes);
    await build({ entryPoints: [join(packageRoot, "src/drivers/acpx/kimi-metadata-probe.ts")], outfile: helper,
      bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
    const api = await import(pathToFileURL(helper).href);
    assert.equal(await api.kimiMetadataProbeDigest(), sha(bytes), `${layout} fixed artifact`);
    await writeFile(cli, "different artifact bytes");
    assert.equal(await api.kimiMetadataProbeDigest(), sha("different artifact bytes"), `${layout} digest is fresh`);
    await rm(cli);
    await symlink(entry, cli);
    await assert.rejects(api.kimiMetadataProbeDigest(), /ELOOP|symbolic/i);
  }
});
