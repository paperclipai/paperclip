#!/usr/bin/env node
// Public npm graph + explicit setup only. No credentials, inference, publication,
// checkout mount, candidate overrides, or native Cursor assets in the tarballs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { materializePublishManifest, prepareBundledPackage } from './prepare-bundled-package.mjs';
import { GROK_PUBLIC_INSTALL_LIFECYCLE, GROK_PUBLIC_INSTALL_IMAGE } from './grok-public-install-sandbox.mjs';
import { cursorConsumerDockerArgs, prepareCursorInstallAccount } from './cursor-public-install-sandbox.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'paperclip-cursor-public-install-'));
console.log(`Verification evidence: ${root}`);
const env = { ...process.env, NODE_PATH: '', PAPERCLIP_RELEASE_REUSE_UI_DIST: '1', npm_config_ignore_scripts: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
for (const key of Object.keys(env)) if (/^(OPENAI|ANTHROPIC|OPENROUTER|DAYTONA|XAI|GROK|CURSOR|COPILOT|GITHUB|GH)(_|$)/.test(key) || /CANDIDATE/.test(key)) delete env[key];
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, env, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
const sourceRevision = run('git', ['rev-parse', 'HEAD'], repo).toString().trim();
const releaseBinaries = JSON.parse(readFileSync(join(repo, 'server/dist/vendor/paperclip-runner/bin/release-manifest.json'), 'utf8'));
assert.equal(releaseBinaries.schema, 'paperclip.runner.release-binaries.v1');
assert.match(releaseBinaries.sourceRevision, /^[a-f0-9]{40}$/);
run('git', ['merge-base', '--is-ancestor', releaseBinaries.sourceRevision, sourceRevision], repo);
// Controller and TypeScript admission may follow a frozen daemon. Keep its
// exact provenance and require the Rust sources and protocol to remain identical.
run('git', ['diff', '--quiet', releaseBinaries.sourceRevision, sourceRevision, '--', 'packages/paperclip-runner/runner', 'packages/paperclip-runner/protocol'], repo);
assert.deepEqual(Object.keys(releaseBinaries.platforms).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64']);
assert.equal(releaseBinaries.remoteProviderPack?.target, 'linux-x64', 'Release assembly must include the expected ordinary Daytona image pack');
const releaseVersion = `0.0.0-cursor-verify.${sourceRevision.slice(0, 12)}`;
const listing = run(process.execPath, [join(repo, 'scripts/release-package-map.mjs'), 'list'], repo).toString().trim().split('\n').map(line => line.split('\t'));
const packages = new Map(listing.map(([dir, name]) => [name, {dir, manifest: JSON.parse(readFileSync(join(repo, dir, 'package.json')))}]));
const cliManifestPath = join(repo, 'cli/package.json'); const original = readFileSync(cliManifestPath);
const generatedManifest = join(root, 'cli-manifest.json');
run(process.execPath, [join(repo, 'scripts/generate-npm-package-json.mjs'), '--output', generatedManifest], repo);
const publishedCli = JSON.parse(readFileSync(generatedManifest));
publishedCli.dependencies['@paperclipai/server'] = releaseVersion;
packages.set('paperclipai', { dir: 'cli', manifest: publishedCli });
const needed = new Set();
function visit(name) {
 if (needed.has(name)) return;
 const entry = packages.get(name); assert.ok(entry, `Missing public package ${name}`); needed.add(name);
 for (const [dependency, version] of Object.entries({...entry.manifest.dependencies, ...entry.manifest.optionalDependencies})) if (version.startsWith('workspace:') || dependency === '@paperclipai/server' && name === 'paperclipai') visit(dependency);
}
visit('paperclipai');
// Run after the candidate build, including its required standalone adapters.
for (const name of needed) assert.ok(existsSync(join(repo, packages.get(name).dir, 'dist')), `Missing built public package ${name}`);
run('bash', [join(repo, 'scripts/prepare-server-ui-dist.sh')], repo);
const assets = join(root, 'assets'); const consumer = join(root, 'consumer'); const cache = join(root, 'cache');
for (const path of [assets, consumer, cache]) mkdirSync(path, { mode: 0o755 });
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
for (const [index, name] of [...needed].entries()) {
 const { dir, manifest } = packages.get(name); const staged = join(root, `source-${index}`); const target = join(root, `package-${index}`); mkdirSync(staged);
 for (const file of manifest.files ?? ['dist']) {
  const skills = file === 'skills' && ['server', 'packages/adapters/claude-local', 'packages/adapters/codex-local'].includes(dir);
  if (file === 'skills' && !skills && !existsSync(join(repo,dir,file))) continue;
  cpSync(skills ? join(repo,'skills') : join(repo,dir,file), join(staged,file), { recursive: true });
 }
 const releaseManifest = { ...manifest, version: releaseVersion };
 writeFileSync(join(staged,'package.json'), JSON.stringify(releaseManifest));
 if ((manifest.bundleDependencies ?? manifest.bundledDependencies ?? []).length) prepareBundledPackage(staged,target);
 else { cpSync(staged,target,{recursive:true}); writeFileSync(join(target,'package.json'),JSON.stringify(materializePublishManifest(releaseManifest))); }
 run('npm',['pack','--ignore-scripts','--pack-destination',assets],target);
 console.log(`Packed ${name}`);
}
const sentinelSource = join(root,'lifecycle-sentinel'); mkdirSync(sentinelSource);
writeFileSync(join(sentinelSource,'package.json'), JSON.stringify({name:'paperclip-verification-lifecycle-sentinel',version:'1.0.0',private:true,scripts:{postinstall:'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\', \'ok\')"'}}));
run('npm',['pack','--ignore-scripts','--pack-destination',assets],sentinelSource);
for (const file of readdirSync(assets)) chmodSync(join(assets,file),0o644);
const account = prepareCursorInstallAccount(root, process.getuid(), process.getgid());
const isolated = (command, options={}) => run('docker',cursorConsumerDockerArgs({assets,consumer,cache,account,uid:process.getuid(),gid:process.getgid(),command,...options}));
isolated(['npm','install','--ignore-scripts','--omit=dev',...readdirSync(assets).filter(f=>f.endsWith('.tgz')).map(f=>`/packages/${f}`)],{download:true});
const sentinel = join(consumer,'node_modules/paperclip-verification-lifecycle-sentinel/lifecycle-ran');
assert.equal(existsSync(sentinel),false);
const lock = readFileSync(join(consumer,'package-lock.json'),'utf8');
// Ordinary npm hooks may fetch platform dependency assets (e.g. esbuild).
// Cursor itself must still remain absent until its explicit setup command.
isolated(GROK_PUBLIC_INSTALL_LIFECYCLE, { download: true });
assert.equal(readFileSync(sentinel,'utf8'),'ok'); assert.equal(readFileSync(join(consumer,'package-lock.json'),'utf8'),lock);
const installedRunner = join(consumer,'node_modules/@paperclipai/server/dist/vendor/paperclip-runner');
assert.equal(existsSync(join(installedRunner,'provider-assets/cursor')),false,'npm must never download Cursor');
assert.equal(existsSync(join(account.home,'.paperclip/runtimes/cursor')),false,'npm must not provision the account runtime cache');
const setupOutput = isolated(['node','node_modules/paperclipai/dist/index.js','runtime','setup','cursor'],{download:true,readOnlyConsumer:true}).toString();
console.log(setupOutput.trim());
assert.match(setupOutput,/Verified Cursor 2026\.09\.26-dd393fe \(linux-x64\), paperclip-cursor-usage-v4/);
const probe = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { defaultCapabilityRunnerdBinary } from '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/live/runnerd-codex-transport.js';
import { resolvePaperclipRunnerBinary } from '/consumer/node_modules/@paperclipai/server/dist/services/native-runtime/native-codex-runner.js';
import { requireServerAdapter } from '/consumer/node_modules/@paperclipai/server/dist/adapters/registry.js';
import { runnerBinaryTarget } from '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/live/runner-binary.js';
import { bundledRemoteRunnerBinary, bundledRemoteProviderPackManifestPath } from '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/live/bundled-remote-provider-pack.js';
import { verifyAcpxProfileInstallation } from '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/profile-installation.js';
import { resolveQualifiedAcpxProfile } from '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/qualified-profiles.js';
import { CURSOR_DISTRIBUTION_PINS } from '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/generated-profiles.js';
const profile = resolveQualifiedAcpxProfile('cursor', 'gpt-5.6-luna[context=272k,reasoning=medium,fast=false]');
const installation = await verifyAcpxProfileInstallation(profile);
assert.equal(userInfo().homedir, '/home/paperclip');
assert.equal(installation.agentServerPackageJsonPath,join(userInfo().homedir,'.paperclip/runtimes/cursor/linux-x64',CURSOR_DISTRIBUTION_PINS['linux-x64'].closureSha256,'.paperclip-cursor-closure.json'));
assert.equal(installation.agentRuntimePackageJsonPath,null);
assert.equal(installation.commandDigest,profile.commandDigest);
await (await installation.openCommand()).close();
const readiness = await requireServerAdapter('paperclip_runner').testEnvironment({ companyId: 'installation-probe', adapterType: 'paperclip_runner', config: { provider: 'acpx', acpxAgent: 'cursor', model: profile.reportedModelId } });
assert.equal(readiness.status, 'pass', JSON.stringify(readiness));
assert.equal(readiness.checks[0]?.code, 'acpx_runtime_ready');
const binaryRoot = '/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/bin';
const manifest = JSON.parse(readFileSync(binaryRoot + '/release-manifest.json', 'utf8'));
assert.equal(manifest.schema, 'paperclip.runner.release-binaries.v1');
assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64']);
for (const [target, artifact] of Object.entries(manifest.platforms)) {
  assert.equal(artifact.path, target + '/paperclip-runnerd');
  const bytes = readFileSync(binaryRoot + '/' + artifact.path);
  assert.equal(runnerBinaryTarget(bytes), target);
  assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
}
const binary = defaultCapabilityRunnerdBinary();
assert.equal(binary, binaryRoot + '/linux-x64/paperclip-runnerd');
assert.equal(resolvePaperclipRunnerBinary(), binary, 'The installed server must use the same verified platform daemon');
assert.equal(bundledRemoteRunnerBinary(), binary);
const remotePack = JSON.parse(readFileSync(bundledRemoteProviderPackManifestPath(), 'utf8'));
assert.equal(remotePack.digest, manifest.remoteProviderPack.digest);
assert.equal(remotePack.payload.providers.cursor.qualification, 'qualified');
const metadata = JSON.parse(execFileSync(binary, ['--build-metadata'], { encoding: 'utf8' }));
assert.equal(metadata.schema, 'paperclip-runner/runnerd-build-metadata/v1');
assert.equal(metadata.binaryContractVersion, 2);
console.log('All three packaged daemon identities verified; the ordinary installed resolver launched Linux x64');
console.log('Installed Cursor closure and command lease verified without credentials or candidate overrides');`;
writeFileSync(join(assets,'probe.mjs'),probe,{mode:0o644});
console.log(isolated(['node','/packages/probe.mjs'],{readOnlyConsumer:true}).toString().trim());
assert.equal(existsSync(join(installedRunner,'provider-assets/cursor')),false,'explicit setup must leave the read-only npm package unchanged');
for (const name of needed) assert.equal(JSON.parse(readFileSync(join(consumer,'node_modules',name,'package.json'))).version,releaseVersion);
const report = {schema:'paperclip.cursor.public-npm-install.v1',sourceRevision,releaseVersion,consumerImage:GROK_PUBLIC_INSTALL_IMAGE,packageCount:needed.size,sourceCliManifestPreserved:readFileSync(cliManifestPath).equals(original),lifecycleScriptsEnabled:true,lifecycleSentinelVerified:true,lifecycleNetwork:'bridge',consumerLockPreserved:true,npmProvisionedCursor:false,publicSetupCommand:true,readOnlyConsumer:true,accountCacheVerified:true,pinnedClosureVerified:true,packagedDaemonTargetsVerified:['darwin-arm64','darwin-x64','linux-x64'],releaseBinaries,ordinaryInstalledDaemonLaunched:true,providerCalls:0};
writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report));
