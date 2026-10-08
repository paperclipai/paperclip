import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

function job(workflow, name) {
  return workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z_]+:\n/)[0] ?? '';
}
function condition(block, needs, github = {}, inputs = {}, isCancelled = false) {
  const expression = block.match(/    if: >-\n((?:      .+\n)+)/)?.[1]?.trim();
  assert.ok(expression, 'Routing must use an explicit condition, including skipped ancestors');
  return Function('needs', 'github', 'inputs', 'cancelled', `return (${expression})`)(needs, github, inputs, () => isCancelled);
}

test('release producer mode validates immutable data inputs and adds only the missing native target jobs', () => {
  const workflow = readWorkflow('release-verify.yml');
  assert.match(workflow, /runner_assets_only:[\s\S]*?default: false/);
  for (const name of ['runner_chaos_evals', 'typecheck', 'general_tests', 'serialized_tests', 'runner_workflow_evals', 'verify_paperclip_runner', 'build']) {
    // The default source gate keeps all its prior checks. Producer-only mode
    // must not create a second broad suite or repeat paid eval authorization.
    assert.match(job(workflow, name), /if: \$\{\{ !inputs\.runner_assets_only \}\}/, name);
  }
  const request = job(workflow, 'runner_release_request');
  assert.doesNotMatch(request, /uses: actions\/checkout|secrets\./);
  const validation = request.split('        run: |\n')[1];
  assert.ok(validation);
  const source = 'a'.repeat(40), image = `ghcr.io/paperclipai/paperclip@sha256:${'b'.repeat(64)}`;
  for (const [SOURCE_SHA, IMAGE_DIGEST, expected] of [
    [source, '', 0], [source, image, 0], ['master', image, 1], ['', image, 1],
    [source, 'ghcr.io/paperclipai/paperclip:latest', 1], [source, image.replace('paperclipai', 'other'), 1],
  ]) {
    const result = spawnSync('bash', ['-c', validation], { env: { ...process.env, SOURCE_SHA, IMAGE_DIGEST }, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
  }
  for (const name of ['runner_release_binaries', 'runner_release_pack']) {
    const producer = job(workflow, name);
    assert.match(producer, /needs: runner_release_request/);
    assert.match(producer, /contents: read/);
    assert.doesNotMatch(producer, /secrets\.|contents: write|id-token: write|packages: write|--push|--password/);
    assert.match(producer, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/);
  }
  const binaries = job(workflow, 'runner_release_binaries');
  assert.deepEqual([...binaries.matchAll(/- target: (.+)/g)].map(match => match[1]), ['darwin-arm64', 'darwin-x64']);
  assert.match(binaries, /cargo build --release.*--locked/);
  assert.match(binaries, /record-binary/);
  const pack = job(workflow, 'runner_release_pack');
  assert.match(pack, /docker pull "\$IMAGE_DIGEST"/);
  assert.match(pack, /--target runner-provider-pack/);
  assert.match(pack, /docker cp "\$owner:\$pack_path"/);
  assert.match(pack, /daemon_path=\/app\/server\/dist\/vendor\/paperclip-runner\/bin\/paperclip-runnerd/);
  assert.match(pack, /--entrypoint "\$daemon_path" "\$image" --build-metadata/);
  assert.match(pack, /docker cp "\$owner:\$daemon_path"/);
  assert.match(pack, /timeout 30s docker start --attach "\$owner"/);
  assert.match(pack, /record-image-binary/);
  assert.match(pack, /trap 'docker rm -f "\$owner"/);
  const helper = readFileSync(path.join(repoRoot, 'scripts/release-runner-artifacts.mjs'), 'utf8');
  assert.match(helper, /stage-release-runner-binaries\.mjs/);
  assert.equal((helper.match(/execFileSync\(process\.execPath/g) ?? []).length, 1, 'Only the existing assembler owns staging');
});

test('channel assembly routing preserves skipped promotions and blocks incomplete data before publishers', () => {
  const workflow = readWorkflow('release.yml');
  const skipped = () => ({ result: 'skipped', outputs: {} });
  const base = () => Object.fromEntries(['verify_canary', 'select_nightly', 'select_beta', 'verify_beta_candidate', 'preflight_stable', 'verify_stable'].map(name => [name, skipped()]));
  const pin = job(workflow, 'pin_runner_release_source');
  assert.equal(condition(pin, base(), { event_name: 'workflow_dispatch' }), false);
  for (const [name, extra, event] of [
    ['verify_canary', {}, 'push'], ['select_nightly', { proceed: 'true' }, 'schedule'],
    ['select_beta', { mode: 'promote' }, 'workflow_dispatch'],
  ]) {
    const needs = base(); needs[name] = { result: 'success', outputs: extra };
    assert.equal(condition(pin, needs, { event_name: event }), true, `${name} with unrelated skipped gates`);
    assert.equal(condition(pin, needs, { event_name: event }, {}, true), false);
  }
  const stable = base(); stable.preflight_stable.result = 'success'; stable.verify_stable.result = 'success';
  assert.equal(condition(pin, stable, { event_name: 'workflow_dispatch' }), true);
  stable.verify_stable.result = 'failure';
  assert.equal(condition(pin, stable, { event_name: 'workflow_dispatch' }), false);
  assert.match(pin, /git show "\$source_sha:scripts\/release\.sh" \| grep -F 'PAPERCLIP_RELEASE_RUNNER_ASSETS'/);
  assert.match(pin, /git cat-file -e "\$source_sha:scripts\/release-runner-artifacts\.mjs"/);

  const ready = { verify_canary: { result: 'success' },
    select_nightly: { result: 'success', outputs: { proceed: 'true' } }, smoke_nightly: { result: 'success' },
    select_beta: { result: 'success', outputs: { mode: 'promote' } }, verify_beta_candidate: skipped(),
    verify_stable: { result: 'success' },
    pin_runner_release_source: { result: 'success', outputs: { required: 'true' } }, release_runner_assets: { result: 'success' } };
  for (const [name, github, inputs] of [
    ['publish_canary', { event_name: 'push' }, {}], ['publish_nightly', { event_name: 'schedule' }, {}],
    ['publish_beta', { event_name: 'workflow_dispatch' }, {}],
    ['preview_stable', { event_name: 'workflow_dispatch' }, { channel: 'stable', dry_run: true }],
    ['publish_stable', { event_name: 'workflow_dispatch' }, { channel: 'stable', dry_run: false }],
  ]) {
    const block = job(workflow, name);
    assert.equal(condition(block, ready, github, inputs), true, name);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.equal(condition(block, { ...ready, release_runner_assets: { result } }, github, inputs), false, `${name}/${result}`);
    }
    const older = { ...ready, pin_runner_release_source: { result: 'success', outputs: { required: 'false' } }, release_runner_assets: skipped() };
    assert.equal(condition(block, older, github, inputs), true, `${name} older promoted contract`);
    assert.match(block, /working-directory: source/);
    const validation = block.match(/name: Validate runner data against[\s\S]*?(?=\n      - name:)/)?.[0];
    assert.ok(validation);
    assert.match(validation, /node "\$GITHUB_WORKSPACE\/trusted\/scripts\/release-runner-artifacts\.mjs" unpack/);
    assert.match(validation, /"\$RUNNER_TEMP\/runner-release-assets" "\$GITHUB_WORKSPACE\/source"/);
    assert.doesNotMatch(validation, /node scripts\//, 'Credentialed publishers may consume only trusted transfer tooling');
  }
  const release = readFileSync(path.join(repoRoot, 'scripts/release.sh'), 'utf8');
  assert.ok(release.indexOf('pnpm build\n# Production publication') < release.indexOf('PAPERCLIP_RELEASE_RUNNER_ASSETS/bin'));
  assert.ok(release.indexOf('PAPERCLIP_RELEASE_RUNNER_ASSETS/bin') < release.indexOf('node "$REPO_ROOT/scripts/build-standalone-public-packages.mjs"'));
  assert.match(release, /elif \[ "\$dry_run" = false \]; then\n\s+release_fail/);
});

test('premerge qualification consumes one Linux-produced assembled npm graph on all three existing targets', () => {
  const workflow = readWorkflow('release-smoke.yml');
  const producer = job(workflow, 'runner_release_assets');
  assert.match(producer, /qualification_source_sha != '' && inputs\.qualification_image_digest != ''/);
  assert.match(producer, /runner_assets_only: true/);
  assert.match(producer, /runner_image_digest: \$\{\{ inputs\.qualification_image_digest \}\}/);
  const smoke = job(workflow, 'smoke');
  assert.match(smoke, /inputs\.qualification_source_sha == '' && inputs\.qualification_image_digest == ''/);
  assert.ok(smoke.indexOf('Validate and materialize the exact-source release data') < smoke.indexOf('Qualify exact-source installed browser entry'));
  assert.match(smoke, /PAPERCLIP_PUBLIC_PACK_OUTPUT:/);
  assert.match(smoke, /steps\.pack_transfer\.outputs\.artifact-id != ''/);
  assert.match(smoke, /id: pack_transfer\n\s+if: \$\{\{ !cancelled\(\) && steps\.pack_identity\.outputs\.artifact_name != '' \}\}/);
  const mac = job(workflow, 'smoke_macos');
  assert.deepEqual([...mac.matchAll(/- target: (.+)/g)].map(match => match[1]), ['darwin-arm64', 'darwin-x64']);
  assert.match(mac, /needs\.smoke\.outputs\.packed_artifact/);
  assert.match(mac, /--consume-pack "\$RUNNER_TEMP\/runner-public-pack"/);
  assert.match(mac, /PAPERCLIP_PUBLIC_PACK_REQUIRE_LOCK_PROVENANCE: "1"/);
  assert.doesNotMatch(mac, /pnpm build|npm pack|secrets\./);
});

test("provider-free release qualification validates paired immutable inputs before checkout", () => {
  const workflow = readWorkflow("release-smoke.yml");
  const validation = workflow.match(/name: Validate paired immutable qualification inputs[\s\S]*?run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(validation);
  const source = "a".repeat(40), image = `ghcr.io/paperclipai/paperclip@sha256:${"b".repeat(64)}`;
  for (const [SOURCE_SHA, IMAGE_DIGEST, expected] of [
    ["", "", 0], [source, image, 0], [source, "", 1], ["", image, 1], ["master", image, 1],
    [source, "ghcr.io/paperclipai/paperclip:latest", 1], [source, image.replace("paperclipai", "other"), 1],
  ]) {
    const result = spawnSync("bash", ["-c", validation], { env: { ...process.env, SOURCE_SHA, IMAGE_DIGEST }, encoding: "utf8" });
    assert.equal(result.status, expected, `${SOURCE_SHA}/${IMAGE_DIGEST}: ${result.stderr}`);
  }
  const smoke = workflow.split("\n  smoke:\n")[1];
  assert.ok(smoke.indexOf("Validate paired immutable qualification inputs") < smoke.indexOf("Checkout repository"));
  assert.match(smoke, /ref: \$\{\{ inputs\.qualification_source_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test("provider-free qualification reuses the installed browser oracle and preserves published smoke", () => {
  const workflow = readWorkflow("release-smoke.yml");
  const service = workflow.split("\n  smoke_service:\n")[1].split("\n  smoke:\n")[0];
  assert.doesNotMatch(service.split("steps:")[0], /qualification_source_sha == ''/);
  assert.ok(service.indexOf("Validate paired immutable qualification inputs") < service.indexOf("Checkout repository"));
  assert.match(service, /ref: \$\{\{ inputs\.qualification_source_sha \|\| github\.sha \}\}/);
  const bootstrap = service.match(/name: Prepare the exact candidate CLI source bootstrap[\s\S]*?(?=\n      - name:)/)?.[0];
  assert.ok(bootstrap);
  const sourceCheck = bootstrap.indexOf('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
  const sourceLock = bootstrap.indexOf('sha256sum pnpm-lock.yaml > "$RUNNER_TEMP/service-source-qualification/source-lock.sha256"');
  const resolveLock = bootstrap.indexOf("pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile");
  const buildLock = bootstrap.indexOf('sha256sum pnpm-lock.yaml > "$RUNNER_TEMP/service-source-qualification/build-lock.sha256"');
  const frozenInstall = bootstrap.indexOf("pnpm install --frozen-lockfile");
  assert.ok(sourceCheck >= 0 && sourceCheck < sourceLock && sourceLock < resolveLock && resolveLock < buildLock && buildLock < frozenInstall,
    "Exact-source qualification must record the committed and CI-generated lock before its frozen install");
  assert.match(bootstrap, /source-sha\.txt/);
  assert.match(bootstrap, /bootstrap-lock-resolution\.log/);
  assert.match(bootstrap, /cli\/node_modules\/tsx\/dist\/cli\.mjs/);
  assert.match(bootstrap, /cli\/src\/index\.ts/);
  assert.match(bootstrap, /bootstrap\.mjs" --help/);
  assert.match(service, /PAPERCLIPAI_CLI_PATH: \$\{\{ runner\.temp \}\}\/service-source-qualification\/bootstrap\.mjs/);
  assert.doesNotMatch(bootstrap, /cli\/dist\/index\.js|pnpm --filter paperclipai build/);
  assert.match(service, /SERVICE_QUALIFICATION_RECEIPT:/);
  assert.match(workflow, /name: Launch Docker smoke harness\n\s+if: inputs\.qualification_source_sha == ''/);
  assert.match(workflow, /name: Run release smoke Playwright suite\n\s+if: inputs\.qualification_source_sha == ''/);
  assert.match(workflow, /PAPERCLIP_PUBLIC_INSTALL_BROWSER_SMOKE: "1"/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/);
  assert.match(workflow, /node scripts\/verify-grok-npm-install\.mjs/);
  assert.match(workflow, /installed-cli-probe\.mjs --standard-image "\$SOURCE_SHA" "\$IMAGE_DIGEST"/);
  const imageStep = workflow.match(/name: Qualify immutable image default startup and UI bytes[\s\S]*?(?=\n      - name:)/)?.[0];
  assert.ok(imageStep);
  assert.match(imageStep, /!cancelled\(\)/);
  const evidenceDirectoryIndex = imageStep.indexOf('mkdir -p "$RUNNER_TEMP/source-qualification"');
  assert.ok(evidenceDirectoryIndex >= 0 && evidenceDirectoryIndex < imageStep.indexOf('node tests/release-smoke/installed-cli-probe.mjs'),
    "Image evidence directory must be created independently before output redirection");
  assert.match(workflow, /name: Upload provider-free qualification evidence\n\s+if: always\(\) && inputs\.qualification_source_sha != ''/);
  assert.match(workflow, /timeout-minutes: 45/);
});

test('qualification retains both lock graphs and rejects changes during frozen install, build, or packing', () => {
  const workflow = readWorkflow('release-smoke.yml');
  const install = workflow.match(/name: Install exact candidate dependencies with lock evidence[\s\S]*?run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  const build = workflow.match(/name: Qualify exact-source installed browser entry[\s\S]*?run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  const bootstrap = workflow.match(/name: Prepare the exact candidate CLI source bootstrap[\s\S]*?run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1]?.split('          # The raw workspace CLI bundle')[0];
  assert.ok(install && build && bootstrap);
  assert.match(workflow, /name: Install dependencies\n\s+if: inputs\.qualification_source_sha == ''\n\s+run: pnpm install --no-frozen-lockfile/);
  const sourceRevision = 'a'.repeat(40), committed = "lockfileVersion: '9.0'\nimporters: {}\n";
  const resolved = "lockfileVersion: '9.0'\nimporters:\n  server:\n    dependencies:\n      compression:\n        specifier: ^1.8.2\n        version: 1.8.2\n";
  for (const [service, mutation] of [[true, ''], [true, 'frozen'], [false, ''], [false, 'frozen'], [false, 'build'], [false, 'pack'], [false, 'source']]) {
    const root = mkdtempSync(path.join(tmpdir(), 'paperclip-lock-qualification-test-'));
    try {
      const bin = path.join(root, 'bin'), temporary = path.join(root, 'artifacts');
      mkdirSync(bin); mkdirSync(temporary);
      const source = path.join(root, 'committed-lock.yaml');
      writeFileSync(source, committed);
      writeFileSync(path.join(root, 'pnpm-lock.yaml'), mutation === 'source' ? 'changed before resolution\n' : committed);
      const directory = path.join(temporary, service ? 'service-source-qualification' : 'source-qualification');
      const executable = (name, code) => writeFileSync(path.join(bin, name), `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
      executable('git', `import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
        const args=process.argv.slice(2);
        if(args.join(' ')==='rev-parse HEAD')console.log(process.env.SOURCE_SHA);
        else if(args[0]==='show' && args[1]===process.env.SOURCE_SHA+':pnpm-lock.yaml')process.stdout.write(readFileSync(process.env.FIXTURE_SOURCE_LOCK));
        else if(args.join(' ')==='diff -- pnpm-lock.yaml'){
          const diff=spawnSync('diff',['-u',process.env.FIXTURE_SOURCE_LOCK,'pnpm-lock.yaml'],{encoding:'utf8'});
          if(diff.error)throw diff.error;if(diff.status>1)process.exit(diff.status);process.stdout.write(diff.stdout);
        }else process.exit(64);`);
      executable('pnpm', `import {appendFileSync,writeFileSync} from 'node:fs';
        const args=process.argv.slice(2);appendFileSync('commands.jsonl',JSON.stringify(args)+'\\n');
        if(args.join(' ')==='install --resolution-only --ignore-scripts --no-frozen-lockfile')writeFileSync('pnpm-lock.yaml',${JSON.stringify(resolved)});
        else if(args.join(' ')==='install --frozen-lockfile'){if(process.env.FIXTURE_MUTATION==='frozen')appendFileSync('pnpm-lock.yaml','# changed by install\\n');}
        else if(args.join(' ')==='build'){if(process.env.FIXTURE_MUTATION==='build')appendFileSync('pnpm-lock.yaml','# changed by build\\n');}
        else process.exit(65);`);
      executable('node', `import {appendFileSync,writeFileSync} from 'node:fs';
        if(process.argv.slice(2).join(' ')!=='scripts/verify-grok-npm-install.mjs')process.exit(66);
        writeFileSync('pack-invoked','true');if(process.env.FIXTURE_MUTATION==='pack')appendFileSync('pnpm-lock.yaml','# changed by packing\\n');`);
      const result = spawnSync('bash', ['-c', service ? bootstrap : `${install}\n${build}`], {
        cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '',
          PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: temporary, SOURCE_SHA: sourceRevision,
          FIXTURE_SOURCE_LOCK: source, FIXTURE_MUTATION: mutation },
      });
      assert.equal(result.status === 0, mutation === '', `${service ? 'service' : 'public'}/${mutation}: ${result.stderr}`);
      assert.equal(readFileSync(path.join(directory, 'source-pnpm-lock.yaml'), 'utf8'), committed);
      if (mutation === 'source') {
        assert.equal(existsSync(path.join(root, 'commands.jsonl')), false, 'A modified source lock must fail before resolution');
        continue;
      }
      assert.equal(readFileSync(path.join(directory, 'build-pnpm-lock.yaml'), 'utf8'), resolved);
      assert.match(readFileSync(path.join(directory, 'lock-resolution.patch'), 'utf8'), /\+\s+specifier: \^1\.8\.2/);
      for (const kind of ['source', 'build']) {
        const retained = path.join(directory, `${kind}-pnpm-lock.yaml`);
        const expected = spawnSync('sha256sum', [retained], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
        assert.equal(readFileSync(path.join(directory, `${kind}-lock.sha256`), 'utf8').split(/\s+/)[0], expected);
      }
      const commands = readFileSync(path.join(root, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(commands.slice(0, 2), [['install', '--resolution-only', '--ignore-scripts', '--no-frozen-lockfile'], ['install', '--frozen-lockfile']]);
      assert.equal(existsSync(path.join(root, 'pack-invoked')), !service && ['', 'pack'].includes(mutation),
        'A changed install/build lock must not reach the producer');
      if (mutation === '') {
        assert.equal(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'), resolved);
        assert.match(readFileSync(path.join(directory, service ? 'bootstrap-lock-preservation.log' : 'build-lock-preservation.log'), 'utf8'), /pnpm-lock.yaml: OK/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("chaos verification isolates callers that verify the same source commit", () => {
  const chaosWorkflow = readWorkflow("runner-chaos-evals.yml");
  const group = chaosWorkflow.match(/^  group: (.+)$/m)?.[1];
  assert.ok(group, "chaos verification must define its concurrency group");

  // GitHub supplies the top-level caller's workflow name to reusable calls.
  const resolveGroup = (caller, ref) => group
    .replaceAll("${{ github.workflow }}", readWorkflow(caller).match(/^name: (.+)$/m)[1])
    .replaceAll("${{ inputs.ref || github.ref }}", ref)
    .toLowerCase();
  const sha = "a".repeat(40);
  const callers = ["cloud-readiness.yml", "release.yml", "runner-chaos-evals.yml"];
  const groups = callers.map((caller) => resolveGroup(caller, sha));
  assert.equal(new Set(groups).size, callers.length,
    "Cloud readiness, Release, and standalone evals must not cancel each other");
  assert.ok(groups.every((value) => !value.includes("${{")), "resolve every group input");
  assert.notEqual(resolveGroup("cloud-readiness.yml", sha),
    resolveGroup("cloud-readiness.yml", "b".repeat(40)), "different sources remain independent");
  assert.match(chaosWorkflow, /cancel-in-progress: true/);
});

test("canary reuses exact-source proof while stable keeps full verification", () => {
  const releaseWorkflow = readWorkflow("release.yml");
  const canary = releaseWorkflow.split("  verify_canary:\n")[1].split("\n  publish_canary:")[0];
  assert.match(canary, /github\.repository == 'paperclipai\/paperclip' && github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/);
  assert.match(canary, /actions: read/);
  assert.match(canary, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(canary, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(canary, /run: node scripts\/cloud-source-verification\.mjs "\$SOURCE_SHA"/);
  assert.doesNotMatch(canary, /release-verify\.yml|continue-on-error|always\(\)/);
  const publishCanary = releaseWorkflow.split('  publish_canary:\n')[1].split('\n  smoke_canary_onboarding:')[0];
  assert.match(publishCanary, /needs: \[verify_canary, pin_runner_release_source, release_runner_assets\]/);
  assert.match(publishCanary, /needs\.verify_canary\.result == 'success'/);
  assert.match(publishCanary, /needs\.release_runner_assets\.result == 'success'/);
  // The stable lane is gated on the stable channel since the nightly lane
  // was added; a `needs:` line (for example a preflight job) may sit between
  // the gate and the delegation.
  // The stable preflight resolves source_ref to an immutable SHA exactly
  // once; verification must consume that pin, not re-resolve the ref.
  assert.match(
    releaseWorkflow,
    /verify_stable:\n\s+if: github\.event_name == 'workflow_dispatch' && inputs\.channel == 'stable'\n(?:\s+needs: [^\n]+\n)?\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ needs\.preflight_stable\.outputs\.sha \}\}/,
  );
  assert.doesNotMatch(
    releaseWorkflow,
    /verify_(?:canary|stable):[\s\S]*?pnpm test:run(?:\n|$)/,
  );
});

test("source proof requires every source check and does not wait on image publication", () => {
  const readiness = readWorkflow("cloud-readiness.yml");
  const proof = readiness.split("  source_verified:\n")[1];
  assert.match(proof, /name: Cloud source verified v1/);
  assert.match(proof, /needs: \[verify\]/);
  assert.match(proof, /node --test scripts\/cloud-source-verification.test.mjs/);
  assert.match(proof, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(proof, /always\(\)|continue-on-error|needs:.*(?:image|artifacts)/);
  assert.doesNotMatch(readiness, /^  (?:image|artifacts|ready):/m);
});

test("onboard smoke container binds beyond loopback so the mapped port is reachable", () => {
  const dockerfile = readFileSync(
    path.join(repoRoot, "docker/Dockerfile.onboard-smoke"),
    "utf8",
  );

  // `onboard --yes` without an explicit --bind prefers trusted-local
  // defaults and writes a loopback bind, which Docker port mapping cannot
  // reach. The smoke container must pin a non-loopback preset.
  assert.match(dockerfile, /onboard --yes --bind lan/);
});

test("promotion selection guards against sources that predate their channel tooling", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // Promotions run the source commit's release.sh, so selection must reject
  // sources whose tooling does not know the target channel yet.
  assert.match(
    releaseWorkflow,
    /git show "\$\{sha\}:scripts\/release\.sh" \| grep -qF 'canary\|nightly'/,
  );
  assert.match(
    releaseWorkflow,
    /git show "\$\{sha\}:scripts\/release\.sh" \| grep -qF 'canary\|nightly\|beta\|stable\)'/,
  );
});

test("candidate-branch betas are validated and fully verified before publish", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // Candidate heads are new commits: selection must pin the naming
  // convention and publication must be gated on full verification.
  assert.match(releaseWorkflow, /candidate\/beta-\*\)/);
  assert.match(
    releaseWorkflow,
    /verify_beta_candidate:\n\s+needs: select_beta\n\s+if: needs\.select_beta\.outputs\.mode == 'candidate'\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml/,
  );
  assert.match(
    releaseWorkflow,
    /needs\.verify_beta_candidate\.result == 'success'/,
  );
});

test("post-publish beta smoke survives the skipped candidate-verification ancestor", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // publish_beta's needs chain contains verify_beta_candidate, which is
  // skipped on promote-mode betas. An `if:` without a status-check function
  // gets an implicit success() that evaluates that chain transitively and
  // silently skips the smoke. The condition must stay explicit.
  assert.match(
    releaseWorkflow,
    /smoke_beta:\n\s+needs: publish_beta\n\s+if: \$\{\{ !cancelled\(\) && needs\.publish_beta\.result == 'success' && !inputs\.dry_run \}\}/,
  );
});

test("published canaries are gated by the exact-version onboarding browser smoke", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  assert.match(
    releaseWorkflow,
    /publish_canary:[\s\S]*?outputs:\n\s+canary_version: \$\{\{ steps\.canary_tag\.outputs\.version \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:\n\s+needs: publish_canary\n\s+if: needs\.publish_canary\.result == 'success'/,
  );
  assert.match(
    releaseWorkflow,
    /PAPERCLIPAI_VERSION: \$\{\{ needs\.publish_canary\.outputs\.canary_version \}\}/,
  );
  assert.match(releaseWorkflow, /test:canary-onboarding-smoke/);
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:[\s\S]*?uses: actions\/checkout@[0-9a-f]{40} # v7[\s\S]*?uses: pnpm\/action-setup@[0-9a-f]{40} # v6[\s\S]*?uses: actions\/setup-node@[0-9a-f]{40} # v7/,
  );
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:[\s\S]*?Install test dependencies\n\s+run: pnpm install --frozen-lockfile/,
  );
  assert.doesNotMatch(
    releaseWorkflow.match(
      /smoke_canary_onboarding:[\s\S]*?(?=\n  # ----- Nightly lane)/,
    )?.[0] ?? "",
    /cache: pnpm/,
  );
  assert.match(
    releaseWorkflow,
    /name: Smoke exact published canary through onboarding\n\s+env:\n\s+PAPERCLIP_CANARY_SMOKE_SERVER_LOG: \$\{\{ runner\.temp \}\}\/canary-onboarding-server\.log/,
  );
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:[\s\S]*?uses: actions\/upload-artifact@[0-9a-f]{40} # v7/,
  );
  assert.match(releaseWorkflow, /canary-onboarding-server\.log/);
  assert.match(releaseWorkflow, /tests\/canary-onboarding\/playwright-report/);
});

test("every lane's tag push degrades to recovery instructions when rejected", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // GITHUB_TOKEN may not create refs pointing at workflow-modifying commits
  // from dispatch or scheduled runs; a rejected tag push after a successful
  // npm publish must surface runbook recovery commands, not a bare error.
  const occurrences = releaseWorkflow.match(/## Tag push rejected/g) ?? [];
  assert.equal(
    occurrences.length,
    3,
    "nightly, beta, and stable each carry the recovery summary",
  );
});

test("release smoke workflow extends the container readiness budget for CI", () => {
  const smokeWorkflow = readWorkflow("release-smoke.yml");
  const harness = readFileSync(
    path.join(repoRoot, "scripts/docker-onboard-smoke.sh"),
    "utf8",
  );

  // CI containers cold-install paperclipai and embedded postgres, so the
  // workflow must extend the harness's local-default readiness budget.
  assert.match(smokeWorkflow, /SMOKE_READY_TIMEOUT_SECONDS=\d+/);
  const ciBudget = Number(
    smokeWorkflow.match(/SMOKE_READY_TIMEOUT_SECONDS=(\d+)/)[1],
  );
  assert.ok(
    ciBudget >= 300,
    `CI readiness budget ${ciBudget}s should be at least 300s`,
  );

  assert.match(
    harness,
    /SMOKE_READY_TIMEOUT_SECONDS="\$\{SMOKE_READY_TIMEOUT_SECONDS:-\d+\}"/,
  );
  assert.match(
    harness,
    /wait_for_http "\$PAPERCLIP_PUBLIC_URL\/api\/health" "\$SMOKE_READY_TIMEOUT_SECONDS" 1/,
  );
});

test("release verify workflow covers the same split test surface as stable PR verification", () => {
  const verifyWorkflow = readWorkflow("release-verify.yml");

  assert.match(verifyWorkflow, /workflow_call:/);
  assert.match(
    verifyWorkflow,
    /node \.\/scripts\/release-package-map\.mjs check/,
  );
  assert.match(verifyWorkflow, /pnpm -r typecheck/);
  assert.match(verifyWorkflow, /pnpm build/);
  const runnerScripts = JSON.parse(readFileSync(path.join(repoRoot, "packages/paperclip-runner/package.json"), "utf8")).scripts;
  const runnerChecks = [...verifyWorkflow.matchAll(/^            checks: (.+)$/gm)]
    .flatMap(([, checks]) => checks.split(" "));
  assert.deepEqual(runnerChecks, runnerScripts["check:all"].split(" && ")
    .map((command) => command.replace(/^pnpm run /, "")));
  assert.match(verifyWorkflow, /pnpm --filter @paperclipai\/paperclip-runner "\$check"/);
  assert.match(verifyWorkflow, /runner_workflow_evals:/);
  assert.match(verifyWorkflow, /runner_chaos_evals:/);
  assert.match(
    verifyWorkflow,
    /uses: \.\/\.github\/workflows\/runner-chaos-evals\.yml/,
  );
  assert.match(
    verifyWorkflow,
    /runner_workflow_evals:[\s\S]*?Install dependencies\n\s+run: pnpm install --no-frozen-lockfile[\s\S]*?Run deterministic Runner workflow scorer tests/,
  );
  assert.match(verifyWorkflow, /pnpm test:runner-workflow-evals/);

  const buildJob = verifyWorkflow.match(/  build:\n[\s\S]*?(?=\n  [A-Za-z0-9_-]+:|$)/)?.[0] ?? "";
  assert.match(buildJob, /persist-credentials: false/);
  assert.doesNotMatch(buildJob, /cache: pnpm/);

  for (const group of ["general-server-without-chat", "general-chat", "general-workspaces-a", "general-workspaces-b"]) {
    assert.match(verifyWorkflow, new RegExp(`group: ${group}`));
  }
  for (const [group, count] of [["general-server-without-chat", 10], ["general-chat", 3]]) {
    const rows = [...verifyWorkflow.matchAll(new RegExp(`group: ${group}\\n\\s+group_label: [^\\n]+\\n\\s+shard_index: (\\d+)\\n\\s+shard_count: (\\d+)`, "g"))];
    assert.deepEqual(rows.map((row) => [Number(row[1]), Number(row[2])]),
      Array.from({ length: count }, (_, index) => [index, count]));
  }
  for (const shardIndex of [0, 1, 2, 3, 4]) {
    assert.match(verifyWorkflow, new RegExp(`shard_index: ${shardIndex}[\\s\\S]*?shard_count: 5`));
  }

  // workspaces-a splits with Vitest native --shard in pr.yml; release
  // verification must keep the same two-shard coverage.
  for (const shardIndex of [0, 1]) {
    assert.match(
      verifyWorkflow,
      new RegExp(
        `group: general-workspaces-a[\\s\\S]*?shard_index: ${shardIndex}\\n\\s+shard_count: 2`,
      ),
    );
  }

  assert.match(verifyWorkflow, /pnpm test:run:general -- --group/);
  assert.match(verifyWorkflow, /pnpm test:run:serialized -- --shard-index/);
});

test("Runner eval workflows pin actions and gate paid live execution", () => {
  const actionPinWorkflows = [
    readWorkflow("release-verify.yml"),
    readWorkflow("runner-live-evals.yml"),
    readWorkflow("runner-chaos-evals.yml"),
    readWorkflow("runner-full-stack-e2e.yml"),
    readWorkflow("e2e.yml"),
    readWorkflow("runner-protocol-live-evals.yml"),
  ];

  for (const workflow of actionPinWorkflows) {
    const remoteUses = workflow
      .split("\n")
      .filter(
        (line) =>
          /^\s*(?:-\s*)?uses: /.test(line) && !line.includes("uses: ./"),
      );
    assert.ok(
      remoteUses.length > 0,
      "expected at least one remote action reference",
    );
    for (const line of remoteUses) {
      assert.match(line, /uses: [^@\s]+@[0-9a-f]{40}(?:\s+# .+)?$/);
    }
  }

  const liveWorkflow = actionPinWorkflows[1];
  assert.match(liveWorkflow, /RUNNER_LIVE_EVALS_NIGHTLY_ENABLED == 'true'/);
  assert.match(liveWorkflow, /REF: \$\{\{ github\.ref \}\}/);
  assert.match(liveWorkflow, /refs\/heads\/\$DEFAULT_BRANCH/);
  assert.match(
    liveWorkflow,
    /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  );
  assert.match(liveWorkflow, /RUNNER_E2E_ALLOWED_ACTOR_IDS/);
  assert.match(liveWorkflow, /needs: authorize/);
  assert.match(liveWorkflow, /environment:\n\s+name: runner-e2e-paid/);
  assert.match(
    liveWorkflow,
    /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/,
  );

  const paidWorkflowNames = [
    "e2e.yml",
    "runner-full-stack-e2e.yml",
    "runner-live-evals.yml",
    "runner-protocol-live-evals.yml",
  ];
  const paidWorkflowNameSet = new Set(paidWorkflowNames);
  const providerSecretReference =
    /secrets(?:\.(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY|GROK_AUTH_JSON|DAYTONA_API_KEY)\b|\[['"](?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY|GROK_AUTH_JSON|DAYTONA_API_KEY)['"]\])/g;
  for (const name of readdirSync(path.join(repoRoot, ".github/workflows"))) {
    if (!/\.ya?ml$/.test(name)) continue;
    const workflow = readWorkflow(name);
    if ([...workflow.matchAll(providerSecretReference)].length > 0) {
      assert.ok(
        paidWorkflowNameSet.has(name),
        `${name} must not receive provider credentials`,
      );
    }
  }

  for (const name of paidWorkflowNames) {
    const workflow = readWorkflow(name);
    const triggerHeader = workflow.slice(0, workflow.indexOf("\njobs:\n"));
    assert.doesNotMatch(
      triggerHeader,
      /^\s{2}(?:pull_request|pull_request_target|push|workflow_call|workflow_run):/m,
    );
    assert.match(triggerHeader, /^\s{2}workflow_dispatch:/m);
    assert.match(workflow, /^  authorize:/m);

    const jobBlocks = workflow
      .slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length)
      .split(/\n(?=  [A-Za-z0-9_-]+:\n)/);
    const providerJobs = jobBlocks.filter(
      (block) => [...block.matchAll(providerSecretReference)].length > 0,
    );
    assert.ok(providerJobs.length > 0, `${name} needs a provider-secret job`);
    for (const block of providerJobs) {
      assert.match(block, /\n    environment:\n      name: runner-e2e-paid\n/);
      assert.match(
        block,
        /\n    steps:(?: &[A-Za-z0-9_-]+)?\n(?:\s*\n)*      - name: Reauthorize[^\n]*\n/,
        `${name} must reauthorize as the first provider-job step`,
      );
      const reauthorize = block.indexOf("      - name: Reauthorize");
      assert.ok(reauthorize > 0);
      assert.ok(block.indexOf("actions/checkout@") > reauthorize);
      assert.ok(block.search(providerSecretReference) > reauthorize);
      assert.match(block, /github\.actor_id/);
      assert.match(block, /github\.triggering_actor/);
      assert.match(block, /RUNNER_E2E_ALLOWED_ACTOR_IDS/);
      assert.match(block, /refs\/heads\/\$DEFAULT_BRANCH/);
      assert.doesNotMatch(block, /^\s+cache: pnpm$/m);
    }
  }

  const fullStackWorkflow = readWorkflow("runner-full-stack-e2e.yml");
  for (const [secret, condition] of Object.entries({
    OPENAI_API_KEY: "matrix.credentialName == 'OPENAI_API_KEY'",
    ANTHROPIC_API_KEY: "matrix.credentialName == 'ANTHROPIC_API_KEY'",
    OPENROUTER_API_KEY: "matrix.credentialName == 'OPENROUTER_API_KEY'",
    DAYTONA_API_KEY: "matrix.environmentId == 'daytona'",
  })) {
    assert.ok(
      fullStackWorkflow.includes(
        `${secret}: \${{ ${condition} && secrets.${secret} || '' }}`,
      ),
      `${secret} must be scoped to only the matrix cells that require it`,
    );
  }
  const historyPublisher = fullStackWorkflow.slice(
    fullStackWorkflow.indexOf("  publish_history:"),
    fullStackWorkflow.indexOf("  pages:"),
  );
  assert.doesNotMatch(historyPublisher, /^\s+cache: pnpm$/m);

  for (const name of [
    "runner-full-stack-e2e.yml",
    "runner-live-evals.yml",
    "runner-protocol-live-evals.yml",
  ]) {
    const workflow = readWorkflow(name);
    const crons = [...workflow.matchAll(/cron:\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.equal(crons.length, 1, `${name} must have one schedule`);
    assert.match(crons[0], /^\d{1,2} \d{1,2} \* \* 0$/);
  }

  const chaosWorkflow = actionPinWorkflows[2];
  const runnerBlock = chaosWorkflow.match(
    /- name: Run Runner fault and replay suites[\s\S]*?run: \|([\s\S]*?)(?=\n\s+- name: Build server test dependencies)/,
  )?.[1];
  const serverBlock = chaosWorkflow.match(
    /- name: Run server finalization and recovery suites[\s\S]*?run: \|([\s\S]*?)(?=\n\s+- name: Upload chaos eval bundle)/,
  )?.[1];
  assert.ok(runnerBlock, "expected Runner chaos test command");
  assert.ok(serverBlock, "expected server chaos test command");
  for (const [base, block] of [
    [path.join(repoRoot, "packages/paperclip-runner"), runnerBlock],
    [path.join(repoRoot, "server"), serverBlock],
  ]) {
    const listedTestPaths =
      block.match(/src\/[A-Za-z0-9_./-]+\.test\.ts/g) ?? [];
    assert.ok(listedTestPaths.length > 0, "expected chaos workflow test paths");
    assert.equal(
      new Set(listedTestPaths).size,
      listedTestPaths.length,
      "chaos workflow test paths must be unique",
    );
    for (const testPath of listedTestPaths) {
      assert.ok(
        existsSync(path.join(base, testPath)),
        `chaos workflow test path does not exist: ${testPath}`,
      );
    }
  }
});


test("direct Grok qualification installs the pinned binary and scopes the selected credential", () => {
  const workflow = readWorkflow("runner-protocol-live-evals.yml");
  assert.ok(workflow.includes("XAI_API_KEY: ${{ matrix.credentialName == 'XAI_API_KEY' && secrets.XAI_API_KEY || '' }}"));
  assert.ok(workflow.includes("if [ -f packages/paperclip-runner/scripts/provision-grok.mjs ]; then"));
  assert.ok(workflow.indexOf("sudo node packages/paperclip-runner/scripts/provision-grok.mjs /opt/paperclip/providers/grok/1.0.13/grok") < workflow.indexOf("pnpm --filter @paperclipai/paperclip-runner deploy --prod"));
  assert.ok(workflow.includes("PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: ${{ matrix.credentialName == 'PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET' && secrets.GROK_AUTH_JSON || '' }}"));
  assert.equal((workflow.match(/secrets\.GROK_AUTH_JSON/gu) ?? []).length, 1);
});

test("direct protocol concurrency override only lowers the configured ceiling", () => {
  const workflow = readWorkflow("runner-protocol-live-evals.yml");
  const start = workflow.indexOf('          if [ -n "${REQUESTED_MAX_PARALLEL:-}" ]; then');
  const end = workflow.indexOf("          node packages/paperclip-runner/scripts/runner-protocol-eval-campaign.mjs catalog", start);
  assert.ok(start > 0 && end > start);
  const script = workflow.slice(start, end) + '\nprintf "%s" "$MAX_PARALLEL"\n';
  for (const [requested, expected] of [["", "8"], ["2", "2"], ["8", "8"], ["1", null], ["9", null], ["0", null], ["-1", null], ["2.5", null], ["garbage", null], ["9999999999999999999999", null]]) {
    const result = spawnSync("bash", ["-eu", "-c", script], {
      env: { ...process.env, MAX_PARALLEL: "8", REQUESTED_MAX_PARALLEL: requested }, encoding: "utf8",
    });
    assert.equal(result.status, expected === null ? 1 : 0, requested);
    if (expected !== null) assert.equal(result.stdout, expected);
  }
});
