import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Keep public-package lifecycle code off the verification host. Resolve and
// cache the public npm graph without scripts, then execute it offline.
export const GROK_PUBLIC_INSTALL_IMAGE =
  'node:24-trixie@sha256:be40f6a87b9b22215ddb20da0a2320a5c6d583fe3ee3b0024d9fa4f05b40c8fd';
// Complete the scripts-disabled install without resolving the graph again.
export const GROK_PUBLIC_INSTALL_LIFECYCLE = [
  'npm', 'rebuild', '--offline', '--ignore-scripts=false', '--dangerously-allow-all-scripts',
];

export function runMacInitialInstallWithDiagnostics(install, { sourceRevision, platform, architecture, cacheDirectory, receiptPath }) {
  const started = performance.now();
  try {
    return install();
  } catch (error) {
    try {
      const phases = new Set(['npm', 'load', 'config', 'command', 'idealTree', 'reify', 'build', 'extract', 'unpack', 'fetch', 'audit', 'cache', 'arborist', 'metavuln']);
      const operations = new Set(['load', 'install', 'init', 'userRequests', 'buildDeps', 'inflate', 'fixDepFlags', 'diffTrees', 'loadTrees', 'retireShallow', 'markDeleted', 'loadBundles', 'unpack', 'unretire', 'build', 'trash', 'save', 'audit', 'manifest', 'failed']);
      const safePhase = value => {
        const [phase, detail] = value.split(':');
        return phases.has(phase) ? phase + (operations.has(detail) ? ':' + detail : '') : null;
      };
      const tails = [];
      try {
        const logs = join(cacheDirectory, '_logs');
        assert.equal(realpathSync(logs), logs);
        for (const name of readdirSync(logs).filter(name => /^[0-9TZ_.:-]+-(?:debug-\d+\.log|timing\.json)$/.test(name)).sort().slice(-2)) {
          const file = join(logs, name);
          if (!lstatSync(file).isFile()) continue;
          const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = fstatSync(fd);
            assert.ok(stat.isFile());
            const size = stat.size;
            const bytes = Buffer.alloc(Math.min(size, 16 * 1024));
            const length = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
            const text = bytes.subarray(0, length).toString('utf8');
            const entries = [];
            if (name.endsWith('-timing.json')) {
              if (size > bytes.length) continue;
              const timing = JSON.parse(text);
              for (const [key, duration] of Object.entries(timing.timers ?? {})) {
                const phase = safePhase(key);
                if (phase && Number.isFinite(duration) && duration >= 0) entries.push({ phase, durationMilliseconds: duration });
              }
            } else {
              for (const line of text.split('\n')) {
                const match = line.match(/^\d+\s+(timing|silly|verbose|http)\s+(\S+)(?:\s+(\S+))?/);
                if (!match) continue;
                const phase = safePhase(match[2]);
                if (!phase) continue;
                const entry = { level: match[1], phase };
                if (operations.has(match[3])) entry.operation = match[3];
                const duration = line.match(/^\d+\s+timing\s+\S+\s+Completed in (\d{1,10})ms\s*$/);
                if (duration) entry.durationMilliseconds = Number(duration[1]);
                if (match[1] === 'http') {
                  const response = line.match(/^\d+\s+http\s+fetch\s+(GET|POST|PUT|DELETE|HEAD)\s+(\d{3})\s+/);
                  if (response) {
                    entry.method = response[1]; entry.status = Number(response[2]);
                    const fetched = line.match(/\s(\d{1,10})ms(?:\s+\(cache (?:hit|miss|revalidated|updated)\))?\s*$/);
                    if (fetched) entry.durationMilliseconds = Number(fetched[1]);
                  }
                }
                entries.push(entry);
              }
            }
            tails.push({ kind: name.endsWith('-timing.json') ? 'npm-timing' : 'npm-debug', truncated: size > bytes.length || entries.length > 32, entries: entries.slice(-32) });
          } finally { closeSync(fd); }
        }
      } catch {}
      const codes = new Set(['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'ENOBUFS', 'EIO', 'EPIPE', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']);
      const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGSEGV', 'SIGBUS']);
      writeFileSync(receiptPath, JSON.stringify({ schema: 'paperclip.runner.mac-public-install-failure.v1',
        sourceRevision, platform, architecture, phase: 'initial-npm-install', outcome: 'FAILED', qualified: false,
        runtimeNotAttempted: true, providerCalls: 0, elapsedMilliseconds: Math.round(performance.now() - started), timeoutMilliseconds: 600000,
        error: { code: codes.has(error?.code) ? error.code : null, status: Number.isInteger(error?.status) ? error.status : null,
          signal: signals.has(error?.signal) ? error.signal : null, errno: Number.isInteger(error?.errno) ? error.errno : null },
        npmDiagnosticTail: tails }, null, 2) + '\n');
    } catch {}
    throw error;
  }
}

export function macNodeHeadersDirectory(nodeExecutable, nodeVersion) {
  assert.match(nodeVersion, /^\d+\.\d+\.\d+$/, 'Executing Node must have an exact release version');
  const executable = realpathSync(nodeExecutable);
  assert.equal(basename(executable), 'node', 'Node SDK must belong to the executing Node binary');
  assert.ok(statSync(executable).isFile(), 'Executing Node must be a regular file');
  const prefix = realpathSync(join(dirname(executable), '..'));
  const include = join(prefix, 'include/node');
  for (const name of ['node.h', 'node_version.h']) {
    const header = join(include, name);
    assert.equal(realpathSync(header), header, 'Node SDK headers must remain inside the executing Node prefix');
    assert.ok(statSync(header).isFile(), 'Node SDK headers must be regular files');
  }
  assert.match(readFileSync(join(include, 'node.h'), 'utf8'), /#\s*include\s+"node_version\.h"/, 'Node SDK must include its version header');
  const versionHeader = readFileSync(join(include, 'node_version.h'), 'utf8');
  const versions = ['MAJOR', 'MINOR', 'PATCH'].map(part => {
    const matches = [...versionHeader.matchAll(new RegExp('^#\\s*define\\s+NODE_' + part + '_VERSION\\s+(\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1, 'Node SDK must declare one ' + part.toLowerCase() + ' version');
    return matches[0][1];
  });
  assert.equal(versions.join('.'), nodeVersion, 'Node SDK version must match the executing Node');
  return prefix;
}

// Inspect the actual npm archive, independently of the staging helper.
export function assertNoBundledCodexPayloads(entries) {
  assert.ok(Array.isArray(entries) && entries.length > 0, 'Packed package must have tar members');
  for (const entry of entries) {
    assert.equal(typeof entry, 'string');
    assert.ok(!entry.startsWith('/') && !entry.split('/').includes('..'), 'Tar member must remain inside the package');
    assert.doesNotMatch(entry, /(?:^|\/)node_modules\/@openai\/codex-(?:linux|darwin|win32)-(?:x64|arm64)(?:\/|$)/,
      'Paperclip tarballs must not bundle Codex platform packages');
    assert.doesNotMatch(entry, /(?:^|\/)node_modules\/@openai\/codex\/vendor(?:\/|$)/,
      'Paperclip tarballs must not bundle the Codex wrapper vendor payload');
    if (!entry.endsWith('/')) assert.doesNotMatch(entry, /(?:^|\/)codex(?:\.exe)?$/,
      'Paperclip tarballs must not bundle native Codex executables');
  }
}

// Verify every host payload against its own official npm provenance, including
// independent legacy closures. The selected native runtime is pinned below.
export function assertInstalledCodexPlatformProvenance(lock, installed, target) {
  assert.match(target, /^(linux|darwin|win32)-(x64|arm64)$/);
  assert.ok(Array.isArray(installed) && installed.length > 0, 'Consumer must install its host Codex platform package');
  const alias = `@openai/codex-${target}`;
  for (const { path, manifest } of installed) {
    assert.ok(path.endsWith(`/node_modules/${alias}`) || path === `node_modules/${alias}`,
      'Consumer must contain only the host Codex platform payload');
    const version = manifest.version;
    assert.ok(typeof version === 'string' && version.endsWith('-' + target)
      && /^\d+\.\d+\.\d+$/.test(version.slice(0, -target.length - 1)), 'Installed Codex platform must declare an exact host version');
    assert.ok([alias, '@openai/codex'].includes(manifest.name), 'Installed Codex platform package identity must match its alias');
    const [os, cpu] = target.split('-');
    assert.deepEqual(manifest.os, [os]);
    assert.deepEqual(manifest.cpu, [cpu]);
    const entry = lock.packages?.[path];
    assert.ok(entry, 'Installed Codex platform must have a consumer lock entry');
    assert.notEqual(entry.inBundle, true, 'Codex platform package must be downloaded, not bundled');
    assert.notEqual(entry.link, true, 'Codex platform package must not be a local link');
    assert.equal(entry.version, version, 'Consumer lock must pin the host Codex platform version');
    const url = new URL(entry.resolved);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.host, 'registry.npmjs.org', 'Codex platform must resolve from official npm');
    assert.equal(url.username + url.password + url.search + url.hash, '', 'Codex npm URL must not have credentials or modifiers');
    assert.equal(decodeURIComponent(url.pathname), `/@openai/codex/-/codex-${version}.tgz`, 'Codex platform must use its exact official npm tarball');
    assert.match(entry.integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'Codex platform must have npm integrity');
    assert.equal(Buffer.from(entry.integrity.slice(7), 'base64').length, 64, 'Codex npm integrity must be a SHA-512 digest');
  }
  return { codexConsumerHostOnly: true, codexConsumerPlatform: target, codexPlatformPackageSource: 'official npm',
    codexPlatformPackages: installed.map(({ path, manifest }) => ({ path, name: manifest.name, version: manifest.version,
      resolved: lock.packages[path].resolved, integrity: lock.packages[path].integrity, inBundle: false })) };
}

// Execute this in the existing offline public consumer, never in the checkout.
// The public index and returned command must both come from the installed graph.
export function installedClaudeProbeSource(indexPath) {
  return `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    assert.equal(process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT, undefined);
    assert.equal(process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST, undefined);
    const { probeAcpxClaudeInstallation } = await import(pathToFileURL(${JSON.stringify(indexPath)}).href);
    await probeAcpxClaudeInstallation('claude-opus-5-5');
    console.log(JSON.stringify({ schema: 'paperclip.claude-installed-admission.v1',
      platform: process.platform, architecture: process.arch, model: 'claude-opus-5-5',
      packageIntegrityAndNoFollowLease: 'passed', defaultPackageAuthority: true, providerCalls: 0 }));
  `;
}

export function installedCodexProbeSource(indexPath, consumerRoot, expectedVersion, { nativeCodex = false } = {}) {
  return `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { createHash } from 'node:crypto';
    import { createRequire } from 'node:module';
    import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
    import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = realpathSync(${JSON.stringify(consumerRoot)});
    const contained = path => { const value = relative(root, realpathSync(path)); return value !== '' && value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value); };
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const installed = [], pending = [join(root, 'node_modules')];
    let visited = 0;
    while (pending.length) {
      const directory = pending.pop();
      assert.ok(contained(directory), 'Installed dependency directory must remain in the consumer');
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
        const namespace = join(directory, entry.name);
        const packages = entry.name.startsWith('@') ? readdirSync(namespace, { withFileTypes: true })
          .filter(value => value.isDirectory() || value.isSymbolicLink()).map(value => join(namespace, value.name)) : [namespace];
        for (const packageRoot of packages) {
          assert.ok(++visited <= 10000 && contained(packageRoot), 'Installed dependency graph must be bounded and contained');
          const path = relative(root, packageRoot).split(sep).join('/');
          if (${/(?:^|\/)node_modules\/@openai\/codex-(?:linux|darwin|win32)-(?:x64|arm64)$/.toString()}.test(path)) {
            let manifest;
            try { manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')); }
            catch (error) {
              if (error.code !== 'ENOENT') throw error;
              const contents = readdirSync(packageRoot), slot = lstatSync(packageRoot);
              assert.ok(slot.isDirectory() && !slot.isSymbolicLink() && contents.length === 0,
                'Codex optional slot without a manifest must be an empty regular directory; found ' +
                JSON.stringify(contents.sort().slice(0, 16).map(name => name.slice(0, 256))));
              // npm can leave an empty nested optional slot while hoisting the
              // actual host payload. Its real lock and manifest still qualify below.
              continue;
            }
            installed.push({ path, manifest });
          }
          const nested = join(packageRoot, 'node_modules');
          if (existsSync(nested)) pending.push(nested);
        }
      }
    }
    const provenance = (${assertInstalledCodexPlatformProvenance.toString()})(lock, installed, process.platform + '-' + process.arch);
    const index = ${JSON.stringify(indexPath)};
    assert.ok(contained(index), 'Codex public index must be installed in the consumer');
    const { resolvePinnedCodexCommand } = await import(pathToFileURL(index).href);
    assert.equal(typeof resolvePinnedCodexCommand, 'function', 'Installed public index must export the pinned Codex resolver');
    const command = resolvePinnedCodexCommand();
    assert.ok(isAbsolute(command) && contained(command), 'Pinned Codex must resolve inside the installed consumer');
    assert.ok(statSync(command).isFile(), 'Pinned Codex must be a regular executable');
    accessSync(command, constants.X_OK);
    const selectedPlatformManifest = realpathSync(createRequire(command).resolve('@openai/codex-' + process.platform + '-' + process.arch + '/package.json'));
    const selectedPlatform = installed.find(({ path }) => realpathSync(join(root, path, 'package.json')) === selectedPlatformManifest);
    assert.ok(selectedPlatform, 'Codex wrapper must resolve an official host platform package from its installed graph');
    const selectedMetadata = JSON.parse(readFileSync(selectedPlatformManifest, 'utf8'));
    assert.deepEqual(selectedMetadata, selectedPlatform.manifest, 'Selected Codex platform metadata must match its scanned provenance');
    ${nativeCodex ? '' : `assert.equal(selectedMetadata.version, ${JSON.stringify(expectedVersion)} + '-' + process.platform + '-' + process.arch,
      'Selected Codex platform version must match the qualified pin');`}
    const version = execFileSync(command, ['--version'], { timeout: 30_000, maxBuffer: 128 * 1024, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: '' } }).trim();
    ${nativeCodex ? "assert.match(version, /^codex-cli /, 'Installed official Codex command must execute');" : `assert.equal(version, 'codex-cli ' + ${JSON.stringify(expectedVersion)}, 'Installed Codex version must match the qualified pin');`}
    const vendor = dirname(index);
    const integrityPath = join(vendor, 'drivers/acpx/installation-integrity.js');
    const profilesPath = join(vendor, 'drivers/acpx/qualified-profiles.js');
    const securityPath = join(vendor, 'drivers/codex/codex-security-config.js');
    assert.ok(contained(integrityPath) && contained(profilesPath) && contained(securityPath), 'Codex verification modules must come from the installed consumer');
    const { codexExecutableReadOnlyRoots, createIsolatedCodexAppServerArgs } = await import(pathToFileURL(securityPath).href);
    const platformRoot = realpathSync(dirname(selectedPlatformManifest));
    const nativeVendor = realpathSync(join(platformRoot, 'vendor'));
    assert.ok(contained(nativeVendor) && nativeVendor.startsWith(platformRoot + sep), 'Codex vendor resources must remain inside their installed platform package');
    const triple = { 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
      'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
      'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' }[process.platform + '-' + process.arch];
    assert.ok(triple, 'Codex native payload requires a known host target');
    const nativeName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const nativeCandidates = ['bin', 'codex'].map(directory => join(nativeVendor, triple, directory, nativeName)).filter(existsSync);
    assert.equal(nativeCandidates.length, 1, 'Selected official Codex platform must contain one native executable');
    const nativeExecutable = realpathSync(nativeCandidates[0]);
    const nativeStat = lstatSync(nativeCandidates[0]);
    assert.ok(nativeExecutable.startsWith(nativeVendor + sep) && nativeStat.isFile() && !nativeStat.isSymbolicLink()
      && nativeStat.size >= 20 && nativeStat.size <= 512 * 1024 * 1024, 'Codex native executable must be a bounded regular file in its selected platform package');
    accessSync(nativeExecutable, constants.X_OK);
    const nativeBytes = readFileSync(nativeExecutable);
    const { runnerBinaryTarget } = await import(pathToFileURL(join(vendor, 'live/runner-binary.js')).href);
    assert.equal(runnerBinaryTarget(nativeBytes), process.platform + '-' + process.arch, 'Codex native executable must match the actual host architecture');
    const sandboxSource = { HOME: '/private-provider-home', PATH: '/usr/local/bin:/usr/bin:/bin' };
    const readRoots = codexExecutableReadOnlyRoots(sandboxSource, command);
    assert.ok(readRoots.includes(nativeVendor), 'Selected native Codex vendor directory must be readable inside its sandbox');
    assert.ok(!readRoots.includes(platformRoot) && !readRoots.includes(root) && !readRoots.includes(sandboxSource.HOME), 'Codex sandbox must not grant enclosing npm or credential-home access');
    const sandboxArgs = createIsolatedCodexAppServerArgs(sandboxSource, readRoots).join('\\n');
    assert.ok(sandboxArgs.includes(JSON.stringify(nativeVendor) + '="read"'), 'Codex sandbox configuration must retain the selected native executable resources');
    ${nativeCodex ? '' : `const { createAcpxPackageJsonResolver, verifyQualifiedAcpxInstallation } = await import(pathToFileURL(integrityPath).href);
    const { resolveQualifiedAcpxProfile } = await import(pathToFileURL(profilesPath).href);
    const serverRoot = resolve(vendor, '../../..');
    assert.ok(contained(serverRoot), 'Codex package authority must be the installed server');
    const installation = await verifyQualifiedAcpxInstallation(resolveQualifiedAcpxProfile('codex', 'gpt-5.4'),
      createAcpxPackageJsonResolver(serverRoot, join(serverRoot, 'package.json')));
    const lease = await installation.openCommand();
    await lease.close();`}
    console.log(JSON.stringify({ pinnedCodexCommandVerified: true, installedCodexVersion: version,
      codexCommandSha256: createHash('sha256').update(readFileSync(command)).digest('hex'),
      codexNativeExecutableSha256: createHash('sha256').update(nativeBytes).digest('hex'),
      codexNativeExecutablePath: relative(root, nativeExecutable).split(sep).join('/'),
      ...provenance, codexSelectedPlatformPath: selectedPlatform.path, codexSelectedPlatformVersion: selectedMetadata.version,
      codexNativeSandboxResourcesVerified: true,
      ${nativeCodex ? '' : `pinnedCodexVersion: ${JSON.stringify(expectedVersion)}, codexQualifiedInstallationVerified: true, codexCommandLeaseVerified: true,`}
      providerCalls: 0 }));
  `;
}

export function assertInstalledNativeConsumerContinuity(before, after) {
  for (const field of ['lockSha256', 'runnerSha256', 'codexCommandSha256', 'codexNativeExecutableSha256']) {
    if (!/^[a-f0-9]{64}$/.test(before[field]) || before[field] !== after[field]) {
      throw new Error(`Installed native host startup changed ${field}`);
    }
  }
}

export function installedDaemonProbeSource(outputRoot, consumerRoot, sourceRevision) {
  return `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { execFileSync } from 'node:child_process';
    import { readFileSync, realpathSync } from 'node:fs';
    import { isAbsolute, join, relative, sep } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = realpathSync(${JSON.stringify(consumerRoot)}), output = realpathSync(${JSON.stringify(outputRoot)});
    const inside = path => { const value = relative(root, realpathSync(path)); return value !== '' && value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value); };
    assert.ok(inside(output));
    const { defaultCapabilityRunnerdBinary } = await import(pathToFileURL(join(output, 'live/runnerd-codex-transport.js')).href);
    const { runnerBinaryTarget } = await import(pathToFileURL(join(output, 'live/runner-binary.js')).href);
    const { parsePaperclipRunnerdBuildMetadata } = await import(pathToFileURL(join(output, 'evals/runnerd-artifact.js')).href);
    const { PAPERCLIP_RUNNER_BUILD_METADATA: expected } = await import(pathToFileURL(join(output, 'evals/build-metadata.js')).href);
    const manifest = JSON.parse(readFileSync(join(output, 'bin/release-manifest.json'), 'utf8'));
    const targets = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
    assert.equal(manifest.schema, 'paperclip.runner.release-binaries.v1');
    assert.equal(manifest.sourceRevision, ${JSON.stringify(sourceRevision)});
    assert.deepEqual(Object.keys(manifest.platforms).sort(), targets.sort());
    for (const target of targets) {
      const record = manifest.platforms[target];
      assert.equal(record.path, target + '/paperclip-runnerd');
      const file = join(output, 'bin', record.path); assert.ok(inside(file));
      const bytes = readFileSync(file);
      assert.equal(runnerBinaryTarget(bytes), target);
      assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), record.sha256);
    }
    const target = process.platform + '-' + process.arch, selected = defaultCapabilityRunnerdBinary();
    assert.ok(inside(selected));
    assert.equal(realpathSync(selected), realpathSync(join(output, 'bin', manifest.platforms[target].path)), 'Production must select the packaged host daemon');
    const metadata = parsePaperclipRunnerdBuildMetadata(JSON.parse(execFileSync(selected, ['--build-metadata'], {
      timeout: 15000, maxBuffer: 64 * 1024, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: '' },
    })));
    assert.equal(metadata.binaryContractVersion, expected.contracts.runnerdArtifact);
    assert.equal(metadata.nativeExecutionVersion, expected.contracts.nativeExecution);
    assert.equal(metadata.harnessDriverVersion, expected.contracts.harnessDriver);
    assert.equal(metadata.prp.name, expected.prp.name);
    assert.ok(metadata.prp.minimumVersion <= expected.prp.maximumVersion && metadata.prp.maximumVersion >= expected.prp.minimumVersion);
    console.log(JSON.stringify({ installedRunnerDaemonVerified: true, target, sourceRevision: manifest.sourceRevision,
      sha256: manifest.platforms[target].sha256, buildMetadata: metadata, providerCalls: 0 }));
  `;
}

export function macPublicInstallLifecycleProfile(ownedRoot) {
  if (!ownedRoot.startsWith('/') || ownedRoot.includes('\0')) throw new Error('Mac lifecycle requires an absolute owned root');
  return `(version 1)\n(allow default)\n(deny network*)\n(deny file-write* (require-all (require-not (subpath ${JSON.stringify(ownedRoot)})) (require-not (literal "/dev/null"))))\n`;
}

export function macInstalledStartupProbeSource(consumerRoot, serverRoot, runnerDigest, helperPath) {
  if (!/^sha256:[a-f0-9]{64}$/.test(runnerDigest)) throw new Error('Installed Mac startup requires the verified SHA-256 manifest identity');
  return `import { probeInstalledCodexStartup } from ${JSON.stringify(helperPath)};
    console.log(JSON.stringify(await probeInstalledCodexStartup({consumerRoot:${JSON.stringify(consumerRoot)},
      serverRoot:${JSON.stringify(serverRoot)},expectedRunnerSha256:${JSON.stringify(runnerDigest.slice(7))}})));`;
}

export function grokConsumerDockerArgs({ assets, consumer, cache, command, uid, gid, download = false, prerequisite, temporarySizeMiB = 256, temporaryExecutable = false, platform = 'linux/amd64' }) {
  if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('Public-install verification requires a supported native Linux platform');
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    throw new Error('Public-install verification requires an unprivileged host user');
  }
  if (!Number.isSafeInteger(temporarySizeMiB) || temporarySizeMiB < 256 || temporarySizeMiB > 2048) {
    throw new Error('Public-install temporary storage must be bounded between 256 and 2048 MiB');
  }
  if (typeof temporaryExecutable !== 'boolean' || (temporaryExecutable && download)) {
    throw new Error('Executable runtime snapshots require an offline verification sandbox');
  }
  return [
    'run', '--rm', '--platform', platform,
    '--user', `${uid}:${gid}`, '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '3g',
    '--network', download ? 'bridge' : 'none',
    '--tmpfs', `/tmp:rw,nosuid,nodev,${temporaryExecutable ? 'exec' : 'noexec'},size=${temporarySizeMiB}m,mode=1777`,
    '--env', 'HOME=/tmp', '--env', 'npm_config_cache=/cache',
    '--env', 'npm_config_nodedir=/usr/local',
    '--env', 'npm_config_audit=false', '--env', 'npm_config_fund=false',
    '--env', `npm_config_ignore_scripts=${download ? 'true' : 'false'}`,
    '--mount', `type=bind,src=${assets},dst=/packages,readonly`,
    '--mount', `type=bind,src=${consumer},dst=/consumer`,
    '--mount', `type=bind,src=${cache},dst=/cache`,
    ...(prerequisite ? ['--mount', `type=bind,src=${prerequisite},dst=/opt/paperclip/providers/grok/1.0.13/grok,readonly`] : []),
    '--workdir', '/consumer', GROK_PUBLIC_INSTALL_IMAGE, ...command,
  ];
}
