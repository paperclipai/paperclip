import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// Keep public-package lifecycle code off the verification host. Resolve and
// cache the public npm graph without scripts, then execute it offline.
export const GROK_PUBLIC_INSTALL_IMAGE =
  'node:24-trixie@sha256:be40f6a87b9b22215ddb20da0a2320a5c6d583fe3ee3b0024d9fa4f05b40c8fd';
// Complete the scripts-disabled install without resolving the graph again.
export const GROK_PUBLIC_INSTALL_LIFECYCLE = [
  'npm', 'rebuild', '--offline', '--ignore-scripts=false', '--dangerously-allow-all-scripts',
];
// The cold Intel consumer parses the same large local release tarballs before
// any lifecycle hook. Give only this initial phase one fixed diagnostic budget.
export const MAC_PUBLIC_INSTALL_INITIAL_TIMEOUT_MS = 480_000;

// The source lock may legitimately precede changed PR manifests. Preserve the
// actual resolved producer graph separately from the isolated npm consumer lock.
export function publicPackProducerLock({ sourceRevision, sourceLock, buildLock }) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/, 'Producer lock requires the exact source revision');
  for (const bytes of [sourceLock, buildLock]) assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0, 'Producer lock requires retained lock bytes');
  const record = (name, bytes) => ({ name, sha256: createHash('sha256').update(bytes).digest('hex') });
  return { sourceRevision,
    sourceLock: record('producer-source-pnpm-lock.yaml', sourceLock),
    buildLock: record('producer-build-pnpm-lock.yaml', buildLock) };
}

export function verifyPublicPackProducerLock({ receipt, directory, sourceRevision, sourceLock, required = false }) {
  assert.equal(receipt.sourceRevision, sourceRevision, 'The producer lock source must match this consumer');
  const provenance = receipt.producerLock;
  if (provenance === undefined) {
    assert.equal(required, false, 'Public package qualification requires retained producer lock provenance');
    return undefined; // Older v1 archives remain consumable without claiming lock verification.
  }
  assert.equal(provenance.sourceRevision, sourceRevision, 'The producer lock source must match this consumer');
  const bytes = {};
  for (const [field, name] of [['sourceLock', 'producer-source-pnpm-lock.yaml'], ['buildLock', 'producer-build-pnpm-lock.yaml']]) {
    assert.equal(provenance[field]?.name, name, 'Producer lock must use the retained lock filename');
    assert.match(provenance[field].sha256, /^[a-f0-9]{64}$/, 'Invalid producer lock checksum');
    const path = join(directory, name);
    assert.ok(lstatSync(path).isFile(), 'Producer lock must be a retained regular file');
    bytes[field] = readFileSync(path);
    assert.ok(bytes[field].length > 0, 'Producer lock requires retained lock bytes');
    assert.equal(createHash('sha256').update(bytes[field]).digest('hex'), provenance[field].sha256, 'Transferred producer lock checksum mismatch');
  }
  assert.ok(bytes.sourceLock.equals(sourceLock), 'The producer source lock must match the committed source revision');
  return provenance;
}

export function assertMacDeveloperRoot(developerRoot) {
  assert.ok(typeof developerRoot === 'string' && resolve(developerRoot) === developerRoot &&
    /^(?:\/Applications\/[^/]+\.app\/Contents\/Developer|\/Library\/Developer\/CommandLineTools)$/.test(developerRoot) &&
    !/[\n\r\0]/.test(developerRoot), 'Lifecycle requires the exact selected Apple developer directory');
}

export function discoverMacPublicInstallToolchain() {
  const developerRoot = realpathSync(execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 10_000 }).trim());
  assertMacDeveloperRoot(developerRoot);
  const metadata = args => execFileSync('/usr/bin/xcrun', args, {
    env: { PATH: '/usr/bin:/bin', DEVELOPER_DIR: developerRoot }, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 }).trim();
  const toolchain = { developerRoot, compiler: metadata(['--find', 'clang']), cxx: metadata(['--find', 'clang++']),
    python: metadata(['--find', 'python3']), sdk: metadata(['--sdk', 'macosx', '--show-sdk-path']), sdkVersion: metadata(['--sdk', 'macosx', '--show-sdk-version']) };
  for (const field of ['compiler', 'cxx', 'python', 'sdk']) {
    const path = toolchain[field];
    assert.ok(isAbsolute(path) && resolve(path) === path && realpathSync(path).startsWith(`${developerRoot}/`),
      `Selected Apple ${field} must belong to ${developerRoot}: ${path}`);
    if (field === 'sdk') assert.ok(statSync(path).isDirectory(), `Selected macOS SDK directory is missing: ${path}`);
    else accessSync(path, constants.X_OK);
  }
  assert.match(toolchain.sdkVersion, /^\d+\.\d+(?:\.\d+)?$/, `Invalid selected macOS SDK version: ${toolchain.sdkVersion}`);
  const sdkSettingsPath = join(toolchain.sdk, 'SDKSettings.json');
  assert.equal(JSON.parse(readFileSync(sdkSettingsPath, 'utf8')).Version, toolchain.sdkVersion,
    `Selected SDK settings must match xcrun's version: ${sdkSettingsPath}`);
  // Keep clang++'s selected path: resolving its symlink to clang would change
  // argv[0] and the compiler's default C++ linking behavior.
  return toolchain;
}

// setup-node installs the official distribution. Copy only its matching
// headers into owned state so node-gyp cannot fetch them during offline hooks.
export function prepareMacPublicInstallNodeHeaders({ nodeExecutable, nodeVersion, destination }) {
  assert.ok(isAbsolute(destination) && resolve(destination) === destination && destination !== '/', 'Node headers require an owned destination');
  const source = join(dirname(dirname(realpathSync(nodeExecutable))), 'include/node');
  const versionPath = join(source, 'node_version.h');
  assert.ok(existsSync(versionPath), `Selected Node distribution is missing offline headers: ${versionPath}`);
  const versionHeader = readFileSync(versionPath, 'utf8');
  const version = ['MAJOR', 'MINOR', 'PATCH'].map(part => {
    const match = versionHeader.match(new RegExp(`^#define NODE_${part}_VERSION\\s+(\\d+)\\s*$`, 'm'));
    assert.ok(match, `Invalid Node ${part.toLowerCase()} version header: ${versionPath}`);
    return match[1];
  }).join('.');
  assert.equal(`v${version}`, nodeVersion, `Selected Node headers must match ${nodeVersion}: ${versionPath}`);
  for (const file of ['config.gypi', 'common.gypi']) assert.ok(existsSync(join(source, file)), `Missing offline Node build header: ${join(source, file)}`);
  assert.equal(existsSync(destination), false, 'Node header staging must use a new owned directory');
  mkdirSync(destination);
  cpSync(source, join(destination, 'include/node'), { recursive: true });
  return { source, destination, version: `v${version}`, resolution: 'matching selected setup-node distribution; no download' };
}

// Retain phase timings from the beginning of a failed install without adding
// raw log bodies, registry URLs, package paths, or npm metadata to diagnostics.
function collectNpmTimings(value, source, timings) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  const text = bytes.subarray(0, 1024 * 1024).toString('utf8');
  const add = (rawPhase, durationMs) => {
    const phase = rawPhase.startsWith('reifyNode:') ? 'reifyNode'
      : rawPhase.startsWith('idealTree:node_modules/') ? 'idealTree:nodeModules'
      : rawPhase === 'idealTree:#root' ? 'idealTree:root' : rawPhase;
    if (!/^(?:npm|config|arborist|idealTree|reify|reifyNode|build|command)(?::[A-Za-z][A-Za-z0-9]*)*$/.test(phase) ||
      !Number.isSafeInteger(durationMs) || durationMs < 0) return;
    const key = `${source}/${phase}`, prior = timings.get(key);
    timings.set(key, prior ? { ...prior, completedCount: prior.completedCount + 1,
      totalMs: prior.totalMs + durationMs, maximumMs: Math.max(prior.maximumMs, durationMs) }
      : { source, phase, completedCount: 1, totalMs: durationMs, maximumMs: durationMs });
  };
  for (const match of text.matchAll(/^(?:\d+\s+)?(?:npm\s+)?timing (\S+) Completed in (\d+)ms\s*$/gm)) add(match[1], Number(match[2]));
  if (text.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(text);
      for (const [phase, duration] of Object.entries(data.timers ?? {})) add(phase, duration);
    } catch { /* A bounded prefix of a larger timing JSON is not complete evidence. */ }
  }
}

// Preserve evidence before the consumer's finally removes its isolated npm
// cache. In particular, a timed-out install may have no child stdout/stderr.
export function runMacPublicInstallPhase({ stage, command, args, cwd, env, cache, timeout = 180_000, log = console.error }) {
  const limit = stage === 'scripts-disabled-install' ? MAC_PUBLIC_INSTALL_INITIAL_TIMEOUT_MS : 180_000;
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= limit, 'Mac install phase must retain its bounded timeout');
  const started = Date.now();
  const emit = details => log(JSON.stringify({ stage, timeoutMs: timeout, elapsedMs: Date.now() - started, ...details }));
  emit({ status: 'started' });
  try {
    const output = execFileSync(command, args, { cwd, env, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024, timeout });
    emit({ status: 'passed' });
    return output;
  } catch (error) {
    const tail = value => Buffer.from(value ?? '').subarray(-16 * 1024).toString('utf8');
    const timings = new Map();
    collectNpmTimings(error.stdout, 'stdout', timings);
    collectNpmTimings(error.stderr, 'stderr', timings);
    emit({ status: 'failed', code: error.code ?? null, exitCode: error.status ?? null, signal: error.signal ?? null,
      stdout: tail(error.stdout), stderr: tail(error.stderr) });
    const logs = join(cache, '_logs');
    try { if (existsSync(logs)) {
      const files = readdirSync(logs, { withFileTypes: true }).filter(item => item.isFile() && /(?:-debug-\d+\.log|-timing\.json)$/.test(item.name))
        .map(item => item.name).sort().slice(-4);
      for (const name of files) {
        const path = join(logs, name);
        // npm owns these paths, but a hook must not substitute an outside file.
        if (!realpathSync(path).startsWith(`${realpathSync(cache)}/`)) continue;
        const fd = openSync(path, 'r');
        try {
          const size = fstatSync(fd).size, tailLength = Math.min(size, 16 * 1024);
          // Inspect at most 1 MiB per owned log, including its existing tail.
          const headLength = Math.min(size, 1024 * 1024 - (size > 1024 * 1024 ? tailLength : 0));
          const head = Buffer.alloc(headLength); readSync(fd, head, 0, head.length, 0);
          collectNpmTimings(head, name, timings);
          let bytes = head.subarray(Math.max(0, head.length - tailLength));
          if (size > headLength) {
            bytes = Buffer.alloc(tailLength); readSync(fd, bytes, 0, bytes.length, size - bytes.length);
            collectNpmTimings(bytes, name, timings);
          }
          emit({ status: 'npm-diagnostic', name, bytes: size, tail: bytes.toString('utf8') });
        } finally { closeSync(fd); }
      }
    } } catch (diagnosticError) { emit({ status: 'npm-diagnostic-unavailable', code: diagnosticError.code ?? null }); }
    if (timings.size) {
      const summary = { stage, timeoutMs: timeout, elapsedMs: Date.now() - started,
        status: 'npm-timing-summary', inspectedBytesPerLogLimit: 1024 * 1024,
        timings: [], truncated: false };
      for (const timing of timings.values()) {
        summary.timings.push(timing);
        if (Buffer.byteLength(JSON.stringify(summary)) > 16 * 1024 - 32) {
          summary.timings.pop(); summary.truncated = true; break;
        }
      }
      const encoded = JSON.stringify(summary);
      if (Buffer.byteLength(encoded) <= 16 * 1024) log(encoded);
    }
    throw error;
  }
}

// Only the hosted Mac deferred lifecycle uses this policy. The scripts-disabled
// download and later loopback startup remain separate phases. Fail closed if
// sandbox-exec is unavailable; npm's offline flag alone is not OS isolation.
export function macPublicInstallLifecyclePolicy({ ownedRoot, npmRoot, developerRoot }) {
  for (const path of [ownedRoot, npmRoot]) {
    if (typeof path !== 'string' || !path.startsWith('/') || path === '/' || path.split('/').includes('..') ||
      /[\n\r\0]/.test(path)) throw new Error('Lifecycle sandbox requires absolute owned/runtime paths');
  }
  if (developerRoot !== undefined) assertMacDeveloperRoot(developerRoot);
  const owned = JSON.stringify(ownedRoot), npm = JSON.stringify(npmRoot);
  // Apple's make shim invokes xcodebuild, whose runtime frameworks live beside
  // Contents/Developer. Bind reads to this selected app's framework directory;
  // Command Line Tools has no corresponding app framework dependency.
  const appFrameworks = developerRoot?.startsWith('/Applications/')
    ? ['Frameworks', 'SharedFrameworks'].map(name => join(dirname(developerRoot), name)) : [];
  return `(version 1)
(deny default)
(deny network*)
(allow process-exec)
(allow process-fork)
(allow sysctl-read)
(allow file-read-metadata)
; Apple's dyld-support.sb requires libignition to open this exact directory
; as an openat root. A literal does not grant reads of its children.
(allow file-read-data file-test-existence (literal "/"))
(allow file-read-data (subpath ${owned}) (subpath ${npm})
  ${developerRoot === undefined ? '' : `(subpath ${JSON.stringify(developerRoot)})`}
  ${appFrameworks.map(path => `(subpath ${JSON.stringify(path)})`).join('\n  ')}
  (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library/Apple")
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write* (subpath ${owned}) (literal "/dev/null"))
`;
}

export function grokConsumerDockerArgs({ assets, consumer, cache, command, uid, gid, download = false, prerequisite, temporarySizeMb = 256, runtimeSmoke = false, browserNetwork, containerName }) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    throw new Error('Public-install verification requires an unprivileged host user');
  }
  if (!Number.isSafeInteger(temporarySizeMb) || temporarySizeMb < 256 || temporarySizeMb > 2048) throw new Error('Invalid bounded public-install temporary size');
  if (runtimeSmoke && (download || uid !== 1000 || gid !== 1000)) throw new Error('Runtime smoke requires the pinned unprivileged node user and an installed graph');
  if (containerName && (!runtimeSmoke || !/^paperclip-public-install-[a-z0-9-]+$/.test(containerName))) throw new Error('Runtime smoke requires its owned container');
  if (browserNetwork && (!runtimeSmoke || !containerName ||
      !/^paperclip-public-install-[a-z0-9-]+$/.test(browserNetwork))) throw new Error('Browser smoke requires its owned network and container');
  return [
    'run', '--rm', '--platform', 'linux/amd64',
    '--user', `${uid}:${gid}`, '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '3g',
    '--network', browserNetwork ?? (download ? 'bridge' : 'none'),
    ...(containerName ? ['--name', containerName] : []),
    ...(browserNetwork ? ['--detach', '--publish', '127.0.0.1::3100'] : []),
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${temporarySizeMb}m,mode=1777`,
    '--env', 'HOME=/tmp', '--env', 'npm_config_cache=/cache',
    '--env', 'npm_config_nodedir=/usr/local',
    '--env', 'npm_config_audit=false', '--env', 'npm_config_fund=false',
    '--env', `npm_config_ignore_scripts=${download ? 'true' : 'false'}`,
    ...(runtimeSmoke ? ['--env', 'PAPERCLIP_OPEN_ON_LISTEN=false', '--env', 'PAPERCLIP_TELEMETRY_DISABLED=1', '--env', 'PAPERCLIP_UPDATE_CHECK=0'] : []),
    '--mount', `type=bind,src=${assets},dst=/packages,readonly`,
    '--mount', `type=bind,src=${consumer},dst=/consumer${runtimeSmoke ? ',readonly' : ''}`,
    '--mount', `type=bind,src=${cache},dst=/cache`,
    ...(prerequisite ? ['--mount', `type=bind,src=${prerequisite},dst=/opt/paperclip/providers/grok/1.0.13/grok,readonly`] : []),
    '--workdir', '/consumer', GROK_PUBLIC_INSTALL_IMAGE, ...command,
  ];
}
