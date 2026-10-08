import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Pins the wiring that makes the background-service smoke an effective gate.
// The service leg exists because v2026.824.0 shipped a service install that
// crash-looped on a missing shim while the Docker smoke stayed green; these
// assertions keep the job from being silently disconnected or weakened.

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "service-onboard-smoke.sh");
const script = readFileSync(scriptPath, "utf8");
const smokeWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "release-smoke.yml"), "utf8");
const releaseWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

test("smoke script is executable and parses", () => {
  accessSync(scriptPath, constants.X_OK);
  execFileSync("bash", ["-n", scriptPath]);
});

test("smoke script keeps its load-bearing assertions", () => {
  assert.match(script, /^set -euo pipefail$/m);
  // Onboards the published artifact with the service leg forced on.
  assert.match(script, /onboard --yes --install-service/);
  // Fails when the shim never materialized.
  assert.match(script, /no executable shim at .*after onboarding/);
  // Fails when the unit dies instead of serving.
  assert.match(script, /entered the failed state/);
  // Fails when health answers but the service is not what is serving --
  // the exact signature of the v2026.824.0 defect.
  assert.match(script, /something other than the service is serving/);
  // Refuses to smoke over a real install unless forced.
  assert.match(script, /SMOKE_FORCE/);
});

test("release-smoke workflow runs the service leg against the input version", () => {
  assert.match(smokeWorkflow, /^  smoke_service:$/m);
  assert.match(smokeWorkflow, /scripts\/service-onboard-smoke\.sh/);
  const serviceJob = smokeWorkflow.split(/^  smoke:$/m)[0];
  assert.match(serviceJob, /PAPERCLIPAI_VERSION: \$\{\{ inputs\.paperclip_version \}\}/);
  // Diagnostics must survive the run: cleanup stays off in CI and the
  // artifact name cannot collide with the Docker job's upload.
  assert.match(serviceJob, /SMOKE_CLEANUP: "false"/);
  assert.match(serviceJob, /\$\{\{ inputs\.artifact_name \}\}-service/);
  assert.match(serviceJob, /name: Remove the owned smoke service after diagnostics/);
  assert.match(serviceJob, /service-smoke-owned/);
  assert.match(serviceJob, /! systemctl --user is-active --quiet paperclipai\.service/);
  assert.match(serviceJob, /! systemctl --user cat paperclipai\.service/);
});

test("service-only dispatch preserves default full-matrix gates and always validates service inputs", () => {
  const dispatch = smokeWorkflow.split("  workflow_call:")[0], call = smokeWorkflow.split("  workflow_call:")[1].split("permissions:")[0];
  for (const trigger of [dispatch, call])assert.match(trigger, /service_only:\n(?:        description:[^\n]*\n)?        required: false\n        default: false\n        type: boolean/);
  const job = name => smokeWorkflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, "m"))?.[1];
  const condition = name => {
    const body = job(name);assert.ok(body);
    const match = body.match(/^    if: (.*)(?:\n((?:      [^\n]*\n)+))?/m);assert.ok(match);
    return match[1] === ">-" ? match[2].trim().replace(/\s+/g, " ") : match[1];
  };
  const assetIf=condition("runner_release_assets"), smokeIf=condition("smoke"), macIf=condition("smoke_macos");
  assert.equal(assetIf, "inputs.service_only != true && inputs.qualification_source_sha != '' && inputs.qualification_image_digest != ''");
  assert.equal(smokeIf, "!cancelled() && inputs.service_only != true && ((inputs.qualification_source_sha == '' && inputs.qualification_image_digest == '') || needs.runner_release_assets.result == 'success')");
  assert.equal(macIf, "!cancelled() && inputs.service_only != true && inputs.qualification_source_sha != '' && needs.runner_release_assets.result == 'success' && needs.smoke.outputs.packed_artifact != ''");
  // Evaluate the actual bounded boolean expressions after pinning their complete shape above.
  const enabled = (expression, inputs, result = "success", packed = "qualified-pack") => Function("inputs", "needs", "cancelled", `return (${expression});`)(inputs,{runner_release_assets:{result},smoke:{outputs:{packed_artifact:packed}}},()=>false);
  for (const service_only of [undefined, false, true]) {
    for (const qualified of [false, true]) {
      const inputs = { service_only, qualification_source_sha:qualified?"a".repeat(40):"", qualification_image_digest:qualified?"ghcr.io/paperclipai/paperclip@sha256:"+"b".repeat(64):"" };
      assert.equal(enabled(assetIf,inputs), service_only!==true&&qualified);
      assert.equal(enabled(smokeIf,inputs), service_only!==true);
      assert.equal(enabled(macIf,inputs), service_only!==true&&qualified);
      assert.equal(enabled(smokeIf,inputs,"failure"), service_only!==true&&!qualified);
      assert.equal(enabled(macIf,inputs,"success",""), false);
    }
  }
  const serviceJob=job("smoke_service");assert.ok(serviceJob);
  assert.doesNotMatch(serviceJob,/^    (if|needs):/m,"Service-only must not depend on skipped native/image producer jobs");
  assert.match(serviceJob,/name: Validate paired immutable qualification inputs[\s\S]*?\[\[ "\$SOURCE_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]/);
  assert.match(serviceJob,/\[\[ "\$IMAGE_DIGEST" =~ \^ghcr/);
  assert.ok(serviceJob.indexOf("Validate paired immutable qualification inputs")<serviceJob.indexOf("Checkout repository"));
});

test("source service qualification keeps the supported installer and real managed-shim path", () => {
  const serviceJob = smokeWorkflow.split(/^  smoke:$/m)[0];
  assert.match(serviceJob, /ref: \$\{\{ inputs\.qualification_source_sha \|\| github\.sha \}\}/);
  assert.match(serviceJob, /cli\/node_modules\/tsx\/dist\/cli\.mjs/);
  assert.match(serviceJob, /cli\/src\/index\.ts/);
  assert.match(serviceJob, /PAPERCLIPAI_CLI_PATH: \$\{\{ runner\.temp \}\}\/service-source-qualification\/bootstrap\.mjs/);
  assert.doesNotMatch(serviceJob, /cli\/dist\/index\.js|pnpm --filter paperclipai build/);
  assert.doesNotMatch(serviceJob, /secrets\./);
  assert.match(script, /PAPERCLIP_HOME="\$DATA_DIR" PAPERCLIP_BUILD_COMMIT="\$SOURCE_SHA"/);
  assert.match(script, /install --repo paperclipai\/paperclip --ref "\$SOURCE_SHA" --yes/);
  assert.match(script, /onboard_command=\("\$SHIM_PATH"\)/);
  assert.match(script, /--inspect-service "\$SOURCE_SHA"/);
  assert.match(script, /--property=MainPID --value/);
  assert.match(script, /instances\/default\/runtime-info\.json/);
  assert.doesNotMatch(script, /writeManagedShim|\.managed-install|source.*payload.*cp/);
});

test("source service bootstrap loads with every workspace dist module unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-service-source-bootstrap-"));
  try {
    const generator = smokeWorkflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)?.[1];
    assert.ok(generator, "The workflow must prepare its owned source bootstrap");
    // Reject compiled workspace modules rather than relying on this checkout's
    // build outputs. External npm dependencies retain their real install graph.
    const loader = join(root, "source-only.mjs");
    writeFileSync(loader, `import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
const workspaces = ${JSON.stringify([realpathSync(repoRoot) + "/", realpathSync(root) + "/"])};
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (result.url.startsWith("file:")) {
    const file = fileURLToPath(result.url);
    const workspace = workspaces.find(root => file.startsWith(root));
    const relative = workspace && file.slice(workspace.length);
    if (relative && !relative.includes("node_modules/") && relative.split("/").includes("dist")) {
      throw new Error("SOURCE_BOOTSTRAP_REQUIRES_WORKSPACE_DIST: " + file);
    }
  }
  return result;
}});
`, { mode: 0o600 });
    const env = { ...process.env, GITHUB_WORKSPACE: repoRoot, RUNNER_TEMP: root,
      PAPERCLIP_TELEMETRY_DISABLED: "1", NODE_PATH: "", NODE_OPTIONS: `--import=${pathToFileURL(loader).href}` };
    const control = join(root, "dist", "must-not-load.mjs");
    mkdirSync(join(root, "dist"));
    writeFileSync(control, "throw new Error('Compiled workspace code executed');\n");
    const rejected = spawnSync(process.execPath, ["--input-type=module", "--eval",
      `await import(${JSON.stringify(pathToFileURL(control).href)})`], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /SOURCE_BOOTSTRAP_REQUIRES_WORKSPACE_DIST/);
    const directory = join(root, "service-source-qualification");
    mkdirSync(directory, { recursive: true });
    execFileSync(process.execPath, ["--input-type=module"], { input: generator, env, timeout: 10_000 });
    const help = execFileSync(process.execPath, [join(directory, "bootstrap.mjs"), "--help"],
      { env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.match(help, /Usage:/);
    assert.match(help, /install/);
    // An install subcommand help flag must reach the real CLI unchanged.
    const installHelp = execFileSync(process.execPath, [join(directory, "bootstrap.mjs"), "install", "--help"],
      { env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.match(installHelp, /--repo/);
    assert.match(installHelp, /--ref/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed source qualification cannot run or clean up an existing shim", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-service-input-test-"));
  const shim = join(root, "paperclipai"), invoked = join(root, "invoked");
  try {
    writeFileSync(shim, `#!/bin/sh\ntouch "${invoked}"\n`, { mode: 0o755 });
    for (const [SOURCE_SHA, PAPERCLIPAI_CLI_PATH, message] of [
      ["master", shim, /full source SHA/],
      ["a".repeat(40), "relative-cli.js", /candidate CLI bootstrap/],
      ["a".repeat(40), join(root, "missing-cli.js"), /candidate CLI bootstrap/],
    ]) {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf8",
        env: { ...process.env, SOURCE_SHA, PAPERCLIPAI_CLI_PATH, PAPERCLIP_SHIM_PATH: shim,
          DATA_DIR: join(root, "data"), SMOKE_CLEANUP: "true" } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.equal(existsSync(invoked), false, "Refusing malformed input must not uninstall a preexisting service");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function withServiceCleanupFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "paperclip-owned-service-cleanup-"));
  const home = join(root, "user home"), runnerTemp = join(root, "runner temp");
  const bin = join(root, "bin"), shim = join(home, ".local", "bin", "paperclipai");
  const calls = join(root, "shim-calls.jsonl"), active = join(root, "active"), installed = join(root, "installed");
  const marker = join(runnerTemp, "service-smoke-owned"), data = join(runnerTemp, "service-smoke-data");
  for (const directory of [bin, join(home, ".local", "bin"), runnerTemp, data]) mkdirSync(directory, { recursive: true });
  const shimBody = `#!${process.execPath}
import { appendFileSync, rmSync } from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({args,paperclipHome:process.env.PAPERCLIP_HOME,home:process.env.HOME,instanceEnv:process.env.PAPERCLIP_INSTANCE_ID})+'\\n');
if(args.includes('--data-dir')){console.error("error: unknown option '--data-dir'");process.exit(1);}
if(JSON.stringify(args)!==JSON.stringify(['service','uninstall','--instance','default']))throw new Error('Unexpected service cleanup arguments');
if(process.env.PAPERCLIP_HOME!==process.env.FIXTURE_DATA)throw new Error('Cleanup did not propagate the exact owned data home');
if(process.env.FIXTURE_KEEP_UNIT!=='true'){rmSync(process.env.FIXTURE_ACTIVE,{force:true});rmSync(process.env.FIXTURE_INSTALLED,{force:true});}
`;
  const executable = (name, body) => writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  executable("systemctl", `import {existsSync,rmSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('show-environment'))process.exit(process.env.FIXTURE_NO_BUS==='true'?1:0);
if(args.includes('cat'))process.exit(existsSync(process.env.FIXTURE_INSTALLED)?0:1);
if(args.includes('is-active')){const live=existsSync(process.env.FIXTURE_ACTIVE);if(!args.includes('--quiet'))console.log(live?'active':'inactive');process.exit(live?0:1);}
if(args.includes('stop')){rmSync(process.env.FIXTURE_ACTIVE,{force:true});process.exit(0);}
throw new Error('Unexpected fake systemctl invocation');
`);
  executable("curl", "process.exit(0);\n"); // No socket or HTTP request: only shell wiring is exercised.
  executable("timeout", `import {spawnSync} from 'node:child_process';const r=spawnSync(process.argv[3],process.argv.slice(4),{stdio:'inherit',env:process.env});if(r.error)throw r.error;process.exit(r.status??1);\n`);
  executable("npx", `import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);if(!args.includes('onboard')||!args.includes('--install-service'))throw new Error('Only fake onboarding is allowed');
writeFileSync(process.env.PAPERCLIP_SHIM_PATH,${JSON.stringify(shimBody)},{mode:0o755});writeFileSync(process.env.FIXTURE_ACTIVE,'owned');writeFileSync(process.env.FIXTURE_INSTALLED,'owned');
`);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: home, RUNNER_TEMP: runnerTemp,
    PAPERCLIP_HOME: join(root, "unrelated ambient data"), PAPERCLIP_INSTANCE_ID: "unrelated-instance",
    PAPERCLIP_SHIM_PATH: shim, DATA_DIR: data, SERVICE_SMOKE_OWNERSHIP_FILE: marker,
    SOURCE_SHA: "", PAPERCLIPAI_CLI_PATH: "", SMOKE_CLEANUP: "true", SMOKE_FORCE: "false",
    SMOKE_READY_TIMEOUT_SECONDS: "1", FIXTURE_CALLS: calls, FIXTURE_ACTIVE: active,
    FIXTURE_INSTALLED: installed, FIXTURE_DATA: data };
  const fixture = { env, home, data, marker, installed, active, calls, runnerTemp,
    readCalls: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [],
    prepareUnit: (ownedMarker) => { writeFileSync(shim, shimBody, { mode: 0o755 });writeFileSync(active, "owned");writeFileSync(installed, "owned");if(ownedMarker !== undefined)writeFileSync(marker, ownedMarker); } };
  try { callback(fixture); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("EXIT cleanup uses the supported uninstall command and exact owned home", () => {
  withServiceCleanupFixture(fixture => {
    const result = spawnSync("bash", [scriptPath], { env: fixture.env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(fixture.installed), false, "The owned unit must be removed, not merely stopped after a swallowed parser error");
    assert.equal(existsSync(fixture.active), false);
    const calls = fixture.readCalls();assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["service", "uninstall", "--instance", "default"]);
    assert.equal(calls[0].paperclipHome, fixture.data);assert.equal(calls[0].home, fixture.home);
    assert.equal(calls[0].instanceEnv, "unrelated-instance", "Explicit default must select only paperclipai.service despite ambient instance selection");
    assert.equal(readFileSync(fixture.marker, "utf8").trim(), "paperclipai.service");
  });
});

test("always workflow cleanup uses owned home and refuses absent or foreign markers", () => {
  const body = smokeWorkflow.match(/name: Remove the owned smoke service after diagnostics\n[\s\S]*?run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(body);const cleanup = body.replace(/^ {10}/gm, "");
  for (const [marker, noBus, keepUnit] of [[undefined, false, false], ["another-instance.service\n", false, false], ["paperclipai.service\n", true, false], ["paperclipai.service\n", false, true], ["paperclipai.service\n", false, false]]) {
    withServiceCleanupFixture(fixture => {
      fixture.prepareUnit(marker);
      const result = spawnSync("bash", ["-c", cleanup], { env: { ...fixture.env, FIXTURE_NO_BUS:String(noBus), FIXTURE_KEEP_UNIT:String(keepUnit) }, encoding: "utf8", timeout: 10_000 });
      if (marker !== "paperclipai.service\n" || noBus) {
        assert.equal(fixture.readCalls().length, 0, `No valid owned marker and user bus means no service action (marker=${JSON.stringify(marker)}, noBus=${noBus}, status=${result.status}, stderr=${result.stderr})`);
        assert.equal(existsSync(fixture.installed), true);assert.equal(existsSync(fixture.active), true);
        if (marker === undefined)assert.equal(result.status, 0);else assert.notEqual(result.status, 0);
        assert.equal(existsSync(join(fixture.runnerTemp, "service-cleanup.json")), false, "Never certify cleanup without owned-unit removal");
      } else if (keepUnit) {
        assert.notEqual(result.status, 0, "A surviving owned unit must fail cleanup even when uninstall exits zero");
        assert.equal(fixture.readCalls().length, 1);assert.equal(existsSync(fixture.active), true);assert.equal(existsSync(fixture.installed), true);
        assert.equal(existsSync(join(fixture.runnerTemp, "service-cleanup.json")), false, "Never report absence after a successful-but-incomplete uninstall");
      } else {
        assert.equal(result.status, 0, result.stderr);assert.equal(existsSync(fixture.installed), false);assert.equal(existsSync(fixture.active), false);
        const calls = fixture.readCalls();assert.equal(calls.length, 1);assert.deepEqual(calls[0].args, ["service", "uninstall", "--instance", "default"]);
        assert.equal(calls[0].paperclipHome, fixture.data);assert.equal(calls[0].home, fixture.home);
        assert.deepEqual(JSON.parse(readFileSync(join(fixture.runnerTemp, "service-cleanup.json"), "utf8")), { ownedServiceAbsent: true, providerCalls: 0 });
      }
    });
  }
});

test("nightly and beta smokes still route through the reusable workflow", () => {
  const calls = releaseWorkflow.match(/uses: \.\/\.github\/workflows\/release-smoke\.yml/g) ?? [];
  assert.ok(calls.length >= 2, "smoke_nightly and smoke_beta must call release-smoke.yml so smoke_service gates them");
});
