import assert from 'node:assert/strict';

// Keep public-package lifecycle code off the verification host. Resolve and
// cache the public npm graph without scripts, then execute it offline.
export const GROK_PUBLIC_INSTALL_IMAGE =
  'node:24-trixie@sha256:be40f6a87b9b22215ddb20da0a2320a5c6d583fe3ee3b0024d9fa4f05b40c8fd';
// Complete the scripts-disabled install without resolving the graph again.
export const GROK_PUBLIC_INSTALL_LIFECYCLE = [
  'npm', 'rebuild', '--offline', '--ignore-scripts=false', '--dangerously-allow-all-scripts',
];

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
export function installedCodexProbeSource(indexPath, consumerRoot, expectedVersion) {
  return `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
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
    assert.equal(selectedMetadata.version, ${JSON.stringify(expectedVersion)} + '-' + process.platform + '-' + process.arch,
      'Selected Codex platform version must match the qualified pin');
    const version = execFileSync(command, ['--version'], { timeout: 30_000, maxBuffer: 128 * 1024, encoding: 'utf8',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', NODE_PATH: '' } }).trim();
    assert.equal(version, 'codex-cli ' + ${JSON.stringify(expectedVersion)}, 'Installed Codex version must match the qualified pin');
    const vendor = dirname(index);
    const integrityPath = join(vendor, 'drivers/acpx/installation-integrity.js');
    const profilesPath = join(vendor, 'drivers/acpx/qualified-profiles.js');
    const securityPath = join(vendor, 'drivers/codex/codex-security-config.js');
    assert.ok(contained(integrityPath) && contained(profilesPath) && contained(securityPath), 'Codex verification modules must come from the installed consumer');
    const { codexExecutableReadOnlyRoots, createIsolatedCodexAppServerArgs } = await import(pathToFileURL(securityPath).href);
    const platformRoot = realpathSync(dirname(selectedPlatformManifest));
    const nativeVendor = realpathSync(join(platformRoot, 'vendor'));
    assert.ok(contained(nativeVendor) && nativeVendor.startsWith(platformRoot + sep), 'Codex vendor resources must remain inside their installed platform package');
    const sandboxSource = { HOME: '/private-provider-home', PATH: '/usr/local/bin:/usr/bin:/bin' };
    const readRoots = codexExecutableReadOnlyRoots(sandboxSource, command);
    assert.ok(readRoots.includes(nativeVendor), 'Selected native Codex vendor directory must be readable inside its sandbox');
    assert.ok(!readRoots.includes(platformRoot) && !readRoots.includes(root) && !readRoots.includes(sandboxSource.HOME), 'Codex sandbox must not grant enclosing npm or credential-home access');
    const sandboxArgs = createIsolatedCodexAppServerArgs(sandboxSource, readRoots).join('\\n');
    assert.ok(sandboxArgs.includes(JSON.stringify(nativeVendor) + '="read"'), 'Codex sandbox configuration must retain the selected native executable resources');
    const { createAcpxPackageJsonResolver, verifyQualifiedAcpxInstallation } = await import(pathToFileURL(integrityPath).href);
    const { resolveQualifiedAcpxProfile } = await import(pathToFileURL(profilesPath).href);
    const serverRoot = resolve(vendor, '../../..');
    assert.ok(contained(serverRoot), 'Codex package authority must be the installed server');
    const installation = await verifyQualifiedAcpxInstallation(resolveQualifiedAcpxProfile('codex', 'gpt-5.4'),
      createAcpxPackageJsonResolver(serverRoot, join(serverRoot, 'package.json')));
    const lease = await installation.openCommand();
    await lease.close();
    console.log(JSON.stringify({ pinnedCodexCommandVerified: true, pinnedCodexVersion: ${JSON.stringify(expectedVersion)},
      ...provenance, codexSelectedPlatformPath: selectedPlatform.path, codexSelectedPlatformVersion: selectedMetadata.version, codexNativeSandboxResourcesVerified: true, codexQualifiedInstallationVerified: true, codexCommandLeaseVerified: true, providerCalls: 0 }));
  `;
}

export function grokConsumerDockerArgs({ assets, consumer, cache, command, uid, gid, download = false, prerequisite, temporarySizeMiB = 256, temporaryExecutable = false }) {
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
    'run', '--rm', '--platform', 'linux/amd64',
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
