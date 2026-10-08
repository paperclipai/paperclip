// Runs inside the existing clean public-install consumer, with no checkout.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Verify only the daemon the installed production resolver selects. */
export async function inspectInstalledDaemon({ server, sourceRevision, commandPath = process.env.PATH, allowHostOnlyDaemon = false }) {
  assert.ok(isAbsolute(server) && resolve(server) === server && server !== '/', 'Invalid installed server directory');
  const installed = join(server, 'dist/vendor/paperclip-runner'), target = `${process.platform}-${process.arch}`;
  const builtSource = JSON.parse(readFileSync(join(server, 'dist/build-info.json'), 'utf8')).commit;
  const source = sourceRevision ?? builtSource;
  assert.match(source ?? '', /^[a-f0-9]{40}$/, 'Installed daemon requires exact source provenance');
  assert.equal(builtSource, source, 'Installed daemon graph source mismatch');
  const { resolvePackagedRunnerBinary, runnerBinaryTarget } = await import(pathToFileURL(join(installed, 'live/runner-binary.js')).href);
  const executable = resolvePackagedRunnerBinary(installed);
  assert.ok(executable, 'The installed graph must contain its native daemon; no ambient fallback is accepted');
  const manifestPath = join(installed, 'bin/release-manifest.json');
  let manifest;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.schema, 'paperclip.runner.release-binaries.v1');
    assert.equal(manifest.sourceRevision, source, 'Installed daemon manifest source mismatch');
    assert.deepEqual(Object.keys(manifest.platforms ?? {}).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64']);
    const artifact = manifest.platforms[target];
    assert.equal(artifact?.path, `${target}/paperclip-runnerd`, 'Installed daemon manifest target path mismatch');
    assert.equal(executable, join(installed, 'bin', artifact.path), 'The production resolver must select the release-manifest artifact');
    assert.match(artifact.sha256 ?? '', /^sha256:[a-f0-9]{64}$/);
  } else {
    assert.equal(allowHostOnlyDaemon, true, 'Public npm qualification requires the complete daemon release manifest');
    assert.equal(executable, join(installed, 'bin/paperclip-runnerd'), 'Host-only source installs must use their built packaged daemon');
  }
  const stat = lstatSync(executable);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Installed daemon must be a regular owned package file');
  assert.equal(realpathSync(executable), executable, 'Installed daemon cannot resolve outside its consumer graph');
  accessSync(executable, constants.X_OK);
  const bytes = readFileSync(executable), digest = `sha256:${sha256(bytes)}`;
  assert.equal(runnerBinaryTarget(bytes), target, 'Installed daemon architecture mismatch');
  if (manifest) assert.equal(manifest.platforms[target].sha256, digest, 'Installed daemon digest mismatch');
  const raw = JSON.parse(execFileSync(executable, ['--build-metadata'], { cwd: server,
    env: { PATH: commandPath ?? '/usr/bin:/bin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
    encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024 }));
  assert.equal(`sha256:${sha256(readFileSync(executable))}`, digest, 'Installed daemon changed during its metadata probe');
  const { parsePaperclipRunnerdBuildMetadata } = await import(pathToFileURL(join(installed, 'evals/runnerd-artifact.js')).href);
  const { PAPERCLIP_RUNNER_BUILD_METADATA: expected } = await import(pathToFileURL(join(installed, 'evals/build-metadata.js')).href);
  const metadata = parsePaperclipRunnerdBuildMetadata(raw);
  for (const [field, contract] of [['binaryContractVersion', 'runnerdArtifact'], ['nativeExecutionVersion', 'nativeExecution'], ['harnessDriverVersion', 'harnessDriver']]) {
    assert.equal(metadata[field], expected.contracts[contract], `Installed daemon incompatible ${field}`);
  }
  assert.equal(metadata.prp.name, expected.prp.name);
  assert.ok(metadata.prp.minimumVersion <= expected.prp.minimumVersion && metadata.prp.maximumVersion >= expected.prp.maximumVersion,
    'Installed daemon protocol does not cover the installed package');
  for (const [field, required] of [['durableSessionCapabilities', ['unlimited_runtime', 'connection_lease_renewal']],
    ['prpTransportModes', ['dial_ws_loopback', 'dial_wss', 'listen_ws']]]) {
    assert.ok(Array.isArray(raw[field]) && required.every(capability => raw[field].includes(capability)), `Installed daemon missing ${field}`);
  }
  return { executable, target, sourceRevision: source, sha256: digest, buildMetadata: raw,
    resolution: 'production installed packaged resolver', manifestVerified: Boolean(manifest), hostOnlySourceInstall: !manifest,
    architectureVerified: true, compatibilityPassed: true, metadataProbePassed: true, providerCalls: 0 };
}

/** Probe the commands this installed runtime can use, without authentication or prompts. */
export async function inspectInstalledProviderReadiness({ server, commandPath = process.env.PATH, sourceRevision, allowHostOnlyDaemon = false }) {
  assert.ok(isAbsolute(server) && resolve(server) === server && server !== '/', 'Invalid installed server directory');
  const failures = [], readiness = { providerCalls: 0 };
  try { readiness.runnerd = await inspectInstalledDaemon({ server, commandPath, sourceRevision, allowHostOnlyDaemon }); }
  catch (error) { failures.push(`Runner daemon: ${error.message}`); }
  try {
    assert.ok(typeof commandPath === 'string' && commandPath.length > 0, 'Codex requires the runtime PATH');
    const installed = join(server, 'dist/vendor/paperclip-runner');
    // Login imports this public boundary. A working deep driver alone cannot
    // prove that the shipped server can load the exported login resolver.
    const { resolvePinnedCodexCommand } = await import(pathToFileURL(join(installed, 'index.js')).href);
    assert.equal(typeof resolvePinnedCodexCommand, 'function', 'Installed public runner entry point must export the qualified Codex login resolver');
    const { QUALIFIED_ACPX_PROFILES } = await import(pathToFileURL(join(installed, 'drivers/acpx/qualified-profiles.js')).href);
    const executable = resolvePinnedCodexCommand();
    const version = execFileSync(executable, ['--version'], { cwd: server,
      env: { PATH: commandPath, ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 }).trim();
    const versionMatch = version.match(/^codex(?:-cli)? (\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/);
    assert.ok(versionMatch, 'Codex did not return its CLI version');
    assert.equal(versionMatch[1], QUALIFIED_ACPX_PROFILES.codex.agentRuntimeVersion, 'Installed Codex executable must match its qualification pin');
    readiness.codex = { command: 'codex', executable, version, resolution: 'qualified installed public runtime entry point',
      publicEntryPointVerified: true, loginCommandResolved: true, versionProbePassed: true };
  } catch (error) { failures.push(`Codex: ${error.message}`); }
  try {
    const { resolvePinnedClaudeCommand } = await import(pathToFileURL(join(server, 'dist/vendor/paperclip-runner/index.js')).href);
    assert.equal(typeof resolvePinnedClaudeCommand, 'function', 'Installed public runner entry point must export the qualified Claude login resolver');
    const executable = await resolvePinnedClaudeCommand();
    assert.ok(isAbsolute(executable) && realpathSync(executable) === executable && lstatSync(executable).isFile(),
      'The qualified Claude login resolver must select a regular installed executable');
    accessSync(executable, constants.X_OK);
    const installed = join(server, 'dist/vendor/paperclip-runner/drivers/acpx');
    const { createAcpxPackageJsonResolver, verifyQualifiedAcpxInstallation } = await import(pathToFileURL(join(installed, 'installation-integrity.js')).href);
    const { resolveQualifiedAcpxProfile } = await import(pathToFileURL(join(installed, 'qualified-profiles.js')).href);
    const model = 'claude-sonnet-5';
    const profile = resolveQualifiedAcpxProfile('claude', model);
    // The vendored production sidecar binds package authority to serverRoot.
    // An unbound probe could borrow a hoisted package the real launch rejects.
    const installation = await verifyQualifiedAcpxInstallation(profile,
      createAcpxPackageJsonResolver(server, join(server, 'package.json')));
    const lease = await installation.openCommand();
    await lease.close();
    readiness.claude = { agentServerPackage: profile.agentServerPackage, agentServerVersion: profile.agentServerVersion,
      agentRuntimePackage: profile.agentRuntimePackage, agentRuntimeVersion: profile.agentRuntimeVersion,
      commandDigest: profile.commandDigest, packageAuthority: server, executable,
      publicEntryPointVerified: true, loginCommandResolved: true,
      installationIntegrityPassed: true, commandLeasePassed: true };
  } catch (error) { failures.push(`Claude: ${error.message}`); }
  try {
    const { resolvePinnedOpenCodeCommand } = await import(pathToFileURL(join(server, 'dist/vendor/paperclip-runner/index.js')).href);
    assert.equal(typeof resolvePinnedOpenCodeCommand, 'function', 'Installed public runner entry point must export the packaged OpenCode command resolver');
    const dependencyVersion = JSON.parse(readFileSync(join(server, 'package.json'), 'utf8')).dependencies?.['opencode-ai'];
    assert.match(dependencyVersion ?? '', /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/, 'Installed server must declare its exact OpenCode dependency');
    const executable = resolvePinnedOpenCodeCommand();
    const version = execFileSync(executable, ['--version'], { cwd: server,
      env: { PATH: commandPath, ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 }).trim();
    const versionMatch = version.match(/^(?:opencode(?:-cli)? )?(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/);
    assert.ok(versionMatch, 'OpenCode did not return its CLI version');
    assert.equal(versionMatch[1], dependencyVersion, 'Installed OpenCode executable must match the server dependency pin');
    readiness.opencode = { executable, version, dependencyVersion, resolution: 'packaged public runtime entry point',
      publicEntryPointVerified: true, packagedCommandResolved: true, versionProbePassed: true };
  } catch (error) { failures.push(`OpenCode: ${error.message}`); }
  if (failures.length) {
    const error = new Error(`Installed provider readiness failed: ${failures.join('; ')}`);
    error.providerReadiness = { ...readiness, failures };
    throw error;
  }
  return readiness;
}

export function inspectManagedServiceInstall({ sourceRevision, manifestPath, shimPath }) {
  assert.match(sourceRevision ?? '', /^[a-f0-9]{40}$/, 'Service qualification requires a full source SHA');
  for (const path of [manifestPath, shimPath]) {
    assert.ok(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path !== '/', 'Service qualification requires absolute managed paths');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.source, 'git', 'Service qualification must use the supported git installer');
  assert.equal(manifest.repo, 'paperclipai/paperclip');
  assert.equal(manifest.sha, sourceRevision, 'The managed install must record the requested source');
  assert.equal(manifest.ref, sourceRevision, 'The managed install must use an immutable ref');
  const payload = join(dirname(manifestPath), 'installs/git', sourceRevision.slice(0, 12));
  assert.equal(manifest.payloadPath, payload, 'The managed payload must belong to this exact install store');
  assert.equal(realpathSync(payload), payload, 'The managed payload cannot resolve into a checkout');
  assert.equal(realpathSync(join(dirname(manifestPath), 'current')), payload, 'The managed current link must activate the requested payload');
  accessSync(shimPath, constants.X_OK);
  const shim = readFileSync(shimPath, 'utf8');
  assert.ok(shim.includes('# paperclipai managed install shim v1'), 'The service must use a real managed shim');
  assert.ok(shim.includes(join(dirname(manifestPath), 'current/node_modules/paperclipai/dist/index.js')), 'The shim must execute this managed store');
  const cli = join(payload, 'node_modules/paperclipai/dist/index.js');
  const server = join(payload, 'node_modules/@paperclipai/server');
  assert.equal(realpathSync(cli), cli);
  assert.equal(realpathSync(server), server);
  assert.equal(JSON.parse(readFileSync(join(server, 'dist/build-info.json'), 'utf8')).commit, sourceRevision);
  assert.equal(execFileSync(shimPath, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim(), manifest.version);
  return { cli, server, cliVersion: manifest.version, cliSha256: sha256(readFileSync(cli)),
    managedShimPassed: true, managedInstallSource: manifest.source, managedInstallCommit: manifest.sha };
}

async function inspectManagedService(sourceRevision, manifestPath, shimPath, runtimeInfoPath, pid, base) {
  const installed = inspectManagedServiceInstall({ sourceRevision, manifestPath, shimPath });
  installedProbePaths({ base });
  assert.match(pid ?? '', /^[1-9]\d*$/, 'Service qualification requires the actual systemd MainPID');
  const servicePid = Number(pid);
  assert.ok(Number.isSafeInteger(servicePid));
  const runtime = JSON.parse(readFileSync(runtimeInfoPath, 'utf8'));
  assert.equal(runtime.schemaVersion, 1);
  assert.equal(runtime.instanceId, 'default');
  assert.equal(runtime.pid, servicePid, 'The runtime must belong to the active systemd service');
  assert.equal(runtime.port, Number(new URL(base).port));
  assert.equal(runtime.host, '127.0.0.1');
  // Only PATH is extracted from this owned, credential-free fixture process;
  // checking the invoking shell's PATH could conceal a broken service setup.
  const commandPath = readFileSync(`/proc/${servicePid}/environ`, 'utf8').split('\0').find(entry => entry.startsWith('PATH='))?.slice(5);
  const ui = await inspectInstalledUi({ base, server: installed.server, sourceRevision });
  const providerReadiness = await inspectInstalledProviderReadiness({ server: installed.server, commandPath, sourceRevision, allowHostOnlyDaemon: true });
  return { schema: 'paperclip.managed-service.startup.v1', ...installed, ...ui, providerReadiness,
    activeServicePidBound: true, providerCalls: 0,
    scope: 'Supported exact git install, real managed shim, systemd startup, UI bytes, and provider-free dependency readiness; authentication and tasks remain separate.' };
}

export function installedProbePaths(input = {}) {
  const paths = { consumer: '/consumer', dataDirectory: '/tmp/paperclip-installed-smoke',
    readyPath: '/tmp/paperclip-installed-smoke-ready.json', base: 'http://127.0.0.1:3100', ...input };
  assert.ok(Object.keys(input).every(key => ['consumer', 'dataDirectory', 'readyPath', 'base'].includes(key)), 'Unknown installed probe path option');
  for (const key of ['consumer', 'dataDirectory', 'readyPath']) {
    assert.ok(typeof paths[key] === 'string' && isAbsolute(paths[key]) && resolve(paths[key]) === paths[key] && paths[key] !== '/', `Invalid installed probe ${key}`);
  }
  const base = new URL(paths.base);
  assert.ok(base.protocol === 'http:' && base.hostname === '127.0.0.1' && Number(base.port) >= 1024
    && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Installed probe requires an explicit loopback URL');
  return paths;
}

export function installedProbeMode(mode, sourceRevision) {
  assert.ok(mode === undefined || ['offline', 'browser', 'host-source', 'browser-host-source'].includes(mode), 'Invalid installed probe mode');
  const allowHostOnlyDaemon = mode === 'host-source' || mode === 'browser-host-source';
  // The source control is separate from assembled public-package acceptance.
  // inspectInstalledDaemon additionally binds this SHA to installed build-info
  // and still verifies the selected binary, platform and metadata contracts.
  if (allowHostOnlyDaemon) assert.match(sourceRevision ?? '', /^[a-f0-9]{40}$/, 'Host-source qualification requires an exact source receipt');
  return { browser: mode === 'browser' || mode === 'browser-host-source', allowHostOnlyDaemon,
    qualificationScope: allowHostOnlyDaemon ? 'exact-source host-only packaging control' : 'assembled public npm package' };
}

/** Real HTTP and installed-byte checks shared by the finite release fixture. */
export async function inspectInstalledUi({ base, server, uiDirectory = join(server, 'ui-dist'), sourceRevision, timeoutMs = 90_000, assertRunning = () => {} }) {
  assert.ok(isAbsolute(uiDirectory) && resolve(uiDirectory) === uiDirectory && uiDirectory !== '/', 'Invalid installed UI directory');
  const deadline = Date.now() + timeoutMs;
  let health;
  while (Date.now() < deadline) {
    assertRunning();
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(Math.min(2_000, timeoutMs)) });
      if (response.ok) {
        health = await response.json();
        // The startup endpoint returns HTTP 200 while recovery is still
        // running. Wait for product readiness before checking installed bytes.
        if (health?.status === 'ok') break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, Math.min(250, timeoutMs)));
  }
  assert.equal(health?.status, 'ok', 'Installed CLI server did not become ready');
  assert.equal(health.commit, sourceRevision, 'The serving commit must match the packaged source');
  const response = await fetch(`${base}/onboarding`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /id="root"/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(assets.some(path => path.endsWith('.js')), 'Installed UI must reference its bundled JavaScript');
  const checkedAssets = [];
  for (const path of new Set(assets)) {
    assert.ok(!path.includes('..'));
    const asset = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(asset.status, 200, `Installed UI asset ${path}`);
    const bytes = Buffer.from(await asset.arrayBuffer());
    const digest = sha256(bytes);
    assert.equal(digest, sha256(readFileSync(`${uiDirectory}${path}`)), `Served UI asset ${path} must be the installed file`);
    checkedAssets.push({ path, sha256: digest, bytes: bytes.length });
  }
  return { servingCommit: health.commit, installedUiAssetsPassed: true, assets: checkedAssets };
}

export function standardImageRequest(sourceRevision, image) {
  assert.match(sourceRevision ?? '', /^[a-f0-9]{40}$/, 'Image qualification requires a full source SHA');
  assert.match(image ?? '', /^ghcr\.io\/paperclipai\/paperclip@sha256:[a-f0-9]{64}$/, 'Image qualification requires an immutable public Core digest');
  return { sourceRevision, image };
}

export function assertStandardImageIdentity(request, metadata) {
  assert.equal(metadata.Os, 'linux');
  assert.equal(metadata.Architecture, 'amd64', 'This hosted image check qualifies Linux amd64 only');
  assert.ok(metadata.RepoDigests?.includes(request.image), 'Pulled image must match the requested digest');
  assert.equal(metadata.Config?.Labels?.['org.opencontainers.image.revision'], request.sourceRevision, 'Image label must match the requested source');
}

export function standardImageDockerArgs({ sourceRevision, image, owner, probePath, authSecret }) {
  standardImageRequest(sourceRevision, image);
  assert.match(owner ?? '', /^paperclip-public-install-image-[a-z0-9-]+$/);
  assert.ok(isAbsolute(probePath) && resolve(probePath) === probePath && probePath !== '/');
  assert.match(authSecret ?? '', /^[a-f0-9]{64}$/);
  // No command or entrypoint override: start the image exactly as shipped.
  // The supported entrypoint prepares embedded Postgres library aliases in its
  // image filesystem. Preserve that normal writable layer without host mounts.
  return ['run', '--detach', '--name', owner,
    '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '3g',
    '--tmpfs', '/paperclip:rw,nosuid,nodev,size=1024m,mode=700,uid=1000,gid=1000',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount', `type=bind,src=${probePath},dst=/qa/installed-cli-probe.mjs,readonly`,
    '--env', `BETTER_AUTH_SECRET=${authSecret}`, '--env', 'PAPERCLIP_TELEMETRY_DISABLED=1',
    '--env', 'PAPERCLIP_UPDATE_CHECK=0', '--env', 'PAPERCLIP_OPEN_ON_LISTEN=false', image];
}

function runStandardImageSmoke(sourceRevision, image) {
  const request = standardImageRequest(sourceRevision, image);
  assert.equal(process.platform, 'linux', 'Run image qualification on the existing hosted Linux executor');
  const root = mkdtempSync(join(tmpdir(), 'paperclip-image-startup-'));
  const dockerConfig = join(root, 'docker-config'); mkdirSync(dockerConfig);
  const env = { ...process.env, DOCKER_CONFIG: dockerConfig };
  const docker = (args, timeout = 30_000) => execFileSync('docker', args, { env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  const owner = `paperclip-public-install-image-${process.pid}-${Date.now()}`;
  const authSecret = randomBytes(32).toString('hex');
  let attempted = false, receipt;
  try {
    docker(['pull', image], 240_000);
    const [metadata] = JSON.parse(docker(['image', 'inspect', image]));
    assertStandardImageIdentity(request, metadata);
    attempted = true;
    docker(standardImageDockerArgs({ ...request, owner, probePath: fileURLToPath(import.meta.url), authSecret }));
    const inspected = JSON.parse(docker(['exec', owner, 'node', '/qa/installed-cli-probe.mjs', '--inspect-standard-image', sourceRevision, image], 135_000).trim());
    receipt = { schema: 'paperclip.standard-image.startup.v1', ...request, ...inspected,
      normalEntrypointAndCommand: true, network: 'none', runtimeUid: 1000, providerCalls: 0,
      scope: 'Immutable image default startup and served UI bytes; provider authentication and tasks are separate.' };
  } catch (error) {
    if (attempted) {
      try { console.error(docker(['logs', owner]).replaceAll(authSecret, '[fixture-auth-secret]').replace(/pcp_bootstrap_[a-zA-Z0-9]+/g, '[fixture-invite]').slice(-12_000)); } catch {}
    }
    throw error;
  } finally {
    try {
      if (attempted) {
        try { docker(['rm', '--force', owner]); }
        catch (error) { assert.match(String(error.stderr ?? ''), /no such (?:object|container)/i, 'Owned image fixture removal failed'); }
        // An unavailable daemon is not evidence of successful cleanup.
        try { docker(['inspect', owner]); assert.fail('Owned image fixture still exists'); }
        catch (error) {
          assert.match(String(error.stderr ?? ''), /no such (?:object|container)/i, 'Owned image cleanup must be confirmed by the available daemon');
        }
        if (receipt) receipt.ownedContainerAbsent = true;
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify(receipt));
}

async function run() {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === '--inspect-service') {
    assert.equal(arguments_.length, 7, 'Invalid managed service probe arguments');
    console.log(JSON.stringify(await inspectManagedService(...arguments_.slice(1))));
    return;
  }
  const [version, sourceRevision, mode, pathsFile, ...extraArguments] = arguments_;
  if (version === '--standard-image' || version === '--inspect-standard-image') {
    assert.ok(!pathsFile && !extraArguments.length, 'Invalid image probe arguments');
    standardImageRequest(sourceRevision, mode);
    if (version === '--standard-image') return runStandardImageSmoke(sourceRevision, mode);
    const server = '/app/server';
    assert.equal(JSON.parse(readFileSync(`${server}/dist/build-info.json`, 'utf8')).commit, sourceRevision);
    const uiDirectory = ['/app/server/ui-dist', '/app/ui/dist'].find(path => existsSync(join(path, 'index.html')));
    assert.ok(uiDirectory, 'The standard image must contain its production UI');
    const ui = await inspectInstalledUi({ base: 'http://127.0.0.1:3100', server, uiDirectory, sourceRevision });
    const providerReadiness = await inspectInstalledProviderReadiness({ server, sourceRevision, allowHostOnlyDaemon: true });
    console.log(JSON.stringify({ ...ui, providerReadiness }));
    return;
  }
  assert.ok(!extraArguments.length, 'Invalid installed probe arguments');
  const { browser, allowHostOnlyDaemon, qualificationScope } = installedProbeMode(mode, sourceRevision);
  const paths = installedProbePaths(pathsFile ? JSON.parse(readFileSync(pathsFile, 'utf8')) : {});
  const cli = join(paths.consumer, 'node_modules/paperclipai/dist/index.js');
  const server = join(paths.consumer, 'node_modules/@paperclipai/server');
  assert.equal(realpathSync(cli), cli, 'The installed CLI cannot resolve into a checkout');
  assert.equal(realpathSync(server), server, 'The installed server cannot resolve into a checkout');
  assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 30_000 }).trim(), version);
  assert.equal(JSON.parse(readFileSync(`${server}/dist/build-info.json`, 'utf8')).commit, sourceRevision);
  let output = '';
  const child = spawn(process.execPath, [cli, 'onboard', '--yes', '--data-dir', paths.dataDirectory,
    ...(browser ? ['--bind', 'lan'] : [])], { cwd: paths.consumer, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: new URL(paths.base).port, ...(pathsFile ? { HOST: '127.0.0.1' } : {}) } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-64 * 1024); });
  const exited = once(child, 'exit');
  void exited.catch(() => undefined);
  const exitObserved = exited.then(() => true);
  const signalOwned = signal => {
    try { if (child.pid) process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const waitForExit = async timeoutMs => {
    let timer;
    try { return await Promise.race([exitObserved, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
  let receipt;
  try {
    const ui = await inspectInstalledUi({ base: paths.base, server, sourceRevision,
      assertRunning: () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error('Installed CLI exited before its server became ready'); } });
    const providerReadiness = await inspectInstalledProviderReadiness({ server, sourceRevision, allowHostOnlyDaemon });
    receipt = { cliVersion: version, cliSha256: sha256(readFileSync(cli)), installedCliStartupPassed: true,
      qualificationScope, ...ui, providerReadiness, providerCalls: 0 };
    if (browser) {
      const invitePath = output.match(/\/invite\/(pcp_bootstrap_[a-zA-Z0-9]+)/)?.[0];
      assert.ok(invitePath, 'The ordinary installed CLI must offer its bootstrap invite');
      // This private fixture token never appears in the public receipt or logs.
      writeFileSync(paths.readyPath, JSON.stringify({ receipt, invitePath }), { mode: 0o600 });
      let stop;
      const stopping = new Promise(resolve => { stop = resolve; });
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      await Promise.race([stopping, exited.then(() => { throw new Error('Installed CLI server exited during its browser smoke'); })]);
    }
  } catch (error) {
    const sanitized = output.replace(/pcp_bootstrap_[a-zA-Z0-9]+/g, '[fixture-invite]').slice(-12_000);
    console.error(sanitized);
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      signalOwned('SIGTERM');
      if (!await waitForExit(8_000)) {
        signalOwned('SIGKILL');
        assert.ok(await waitForExit(2_000), 'Installed CLI process exit could not be confirmed');
      }
    }
  }
  console.log(JSON.stringify(receipt));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { await run(); }
  catch (error) {
    if (error.providerReadiness) console.error(JSON.stringify({ providerReadiness: error.providerReadiness }));
    throw error;
  }
}
