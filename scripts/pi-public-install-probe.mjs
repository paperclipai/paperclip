#!/usr/bin/env node
// Run in a credential-free public npm consumer after `paperclipai runtime setup pi`.
// Use the server's normal packaged daemon resolver; never submit a prompt.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function verifyPiPackagedDaemon(server, daemon, target, runnerBinaryTarget) {
  assert.match(target, /^(?:linux|darwin)-(?:x64|arm64)$/);
  const output = join(server, 'dist/vendor/paperclip-runner'), manifestPath = join(output, 'bin/release-manifest.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let expectedPath = join(output, 'bin/paperclip-runnerd');
  if (manifest !== undefined) {
    assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Release manifest must be an object');
    assert.equal(await realpath(manifestPath), manifestPath, 'Release manifest must remain inside the installed package');
    assert.equal(manifest.schema, 'paperclip.runner.release-binaries.v1');
    assert.match(manifest.sourceRevision, /^[a-f0-9]{40}$/);
    const build = JSON.parse(await readFile(join(server, 'dist/build-info.json'), 'utf8'));
    assert.equal(manifest.sourceRevision, build.commit, 'Packaged daemon source must match the installed server build');
    const artifact = manifest.platforms?.[target];
    assert.equal(artifact?.path, `${target}/paperclip-runnerd`, 'Packaged daemon must use the known host target path');
    assert.match(artifact.sha256, /^sha256:[a-f0-9]{64}$/);
    expectedPath = join(output, 'bin', artifact.path);
    assert.equal(await realpath(daemon), expectedPath, 'Production must select the installed host daemon');
    assert.equal(await realpath(expectedPath), expectedPath, 'Packaged daemon cannot escape through a symlink');
    const bytes = await readFile(expectedPath);
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.sha256);
    assert.equal(runnerBinaryTarget(bytes), target);
  } else {
    assert.equal(await realpath(daemon), expectedPath);
    assert.equal(runnerBinaryTarget(await readFile(expectedPath)), target);
  }
}

async function main() {

const [serverDirectory, ...extra] = process.argv.slice(2);
assert.ok(serverDirectory && extra.length === 0, 'Usage: pi-public-install-probe.mjs INSTALLED_SERVER_ROOT');
for (const key of Object.keys(process.env)) {
  assert.ok(!/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key), `Unexpected credential variable: ${key}`);
}
assert.equal(process.env.PAPERCLIP_RUNNER_BINARY, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.NODE_PATH, undefined);
const server = await realpath(serverDirectory);
assert.equal(JSON.parse(await readFile(join(server, 'package.json'), 'utf8')).name, '@paperclipai/server');
const { resolvePaperclipRunnerBinary } = await import(pathToFileURL(join(server, 'dist/services/native-runtime/native-codex-runner.js')));
const { createCapabilityRunnerdCodexTransport } = await import(pathToFileURL(join(server, 'dist/vendor/paperclip-runner/live/runnerd-codex-transport.js')));
const { QUALIFIED_ACPX_PROFILES } = await import(pathToFileURL(join(server, 'dist/vendor/paperclip-runner/drivers/acpx/qualified-profiles.js')));
assert.equal(QUALIFIED_ACPX_PROFILES.pi.agentProfileVersion, 36);
assert.equal(QUALIFIED_ACPX_PROFILES.pi.commandDigest, 'sha256:faafb66c09c1efc7eb4eda6baaa5813c975e8a992f9cd333687695aa5522d7dc');
assert.equal(Object.hasOwn(QUALIFIED_ACPX_PROFILES.pi, 'qualificationModel'), false);
assert.equal(Object.hasOwn(QUALIFIED_ACPX_PROFILES.pi, 'reportedModelId'), false);
const daemon = resolvePaperclipRunnerBinary();
const { runnerBinaryTarget } = await import(pathToFileURL(join(server, 'dist/vendor/paperclip-runner/live/runner-binary.js')));
await verifyPiPackagedDaemon(server, daemon, `${process.platform}-${process.arch}`, runnerBinaryTarget);
const root = await mkdtemp(join(tmpdir(), 'pi-public-install-probe-'));
const evidence = [];
const started = performance.now();
const watchdog = setTimeout(() => { console.error('Pi public-install probe exceeded its cleanup deadline'); process.exit(1); }, 85_000);
let bundle;
let failure;
let settledMs;
try {
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  bundle = createCapabilityRunnerdCodexTransport({
    provider: 'acpx', acpxAgent: 'pi', piThinkingLevel: 'low', acpxPermissionMode: 'deny-all',
    runnerBinary: daemon, stateDirectory: join(root, 'state'),
    environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    onEvidence: value => evidence.push(value),
  });
  try {
    await bundle.transport.request('initialize', { clientInfo: { name: 'pi-public-install-verification', version: '1' } });
    await bundle.transport.request('thread/start', {
      cwd: workspace, model: 'openrouter/deepseek/deepseek-v4-flash-0731',
      baseInstructions: 'Credential-free admission probe. No prompt is submitted.',
      permissions: 'paperclip-runner-workspace-read-only', dynamicTools: [],
    });
  } catch (error) { failure = String(error); }
  settledMs = Math.round(performance.now() - started);
  await bundle.transport.close();
  assert.match(failure ?? '', /session\.open failed/);
  assert.match(failure, /retryable=false, classification=session_ensure_failed/);
  assert.doesNotMatch(failure, /timed out/);
  assert.ok(settledMs < 60_000, `Pi admission took ${settledMs} ms`);
  assert.ok(evidence.some(item => item.runnerExited === true && item.runnerExitCode === 0));
  for (const item of evidence) assert.deepEqual(item.childEnvironmentKeys, ['LANG', 'PATH']);
  const state = JSON.parse(await readFile(join(root, 'state/runner/acpx-provider-state.json'), 'utf8'));
  assert.equal(state.descriptor.agent, 'pi');
  assert.equal(state.descriptor.agentRuntimeVersion, '1.0.0');
  assert.equal(state.descriptor.piThinkingLevel, 'low');
  assert.equal(state.activeTurnId, null);
  assert.equal(state.identity, null);
  assert.equal(state.providerExitUnconfirmed, false);
  console.log(JSON.stringify({ schema: 'paperclip.pi.public-npm-install.v1', target: `${process.platform}-${process.arch}`, normalPackagedDaemon: true, exactPiProfile: QUALIFIED_ACPX_PROFILES.pi.agentProfileVersion, runtime: '1.0.0', credentials: 'none', promptCalls: 0, settledMs, cleanRunnerExit: true }));
} finally {
  try { await bundle?.transport.close(); }
  finally { clearTimeout(watchdog); await rm(root, { recursive: true, force: true }); }
}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
