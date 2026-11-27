// Retain normal build/pack outputs for installed Product E2E and Runner evals.
// This runs only after the clean public installation and Pi admission pass.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export function retainRunnerQualificationPackages({ repo, output, sourceRevision, releaseVersion, publicArchives, env = process.env }) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(JSON.parse(readFileSync(join(repo, 'server/dist/build-info.json'))).commit, sourceRevision);
  assert.ok(publicArchives.some(a => a.name === '@paperclipai/server'));
  assert.ok(publicArchives.some(a => a.name === 'paperclipai'));
  assert.ok(publicArchives.some(a => a.name === '@paperclipai/plugin-sdk'));
  assert.equal(new Set(publicArchives.map(a => a.name)).size, publicArchives.length);
  output = resolve(output);
  assert.ok(!existsSync(output), 'Never replace retained qualification packages');
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), 'paperclip-qualification-pack-'));
  const archives = [];
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const retain = (name, file) => {
    const destination = join(output, basename(file));
    assert.ok(!existsSync(destination), 'Duplicate archive filename');
    cpSync(file, destination);
    archives.push({ name, file: basename(file), sha256: hash(destination) });
  };
  const pack = (directory, name, ignoreScripts) => {
    const previous = new Set(readdirSync(staging));
    execFileSync('npm', ['pack', ...(ignoreScripts ? ['--ignore-scripts'] : []), '--pack-destination', staging], {
      cwd: directory, env: { ...env, npm_config_cache: join(staging, 'npm-cache'), npm_config_ignore_scripts: String(ignoreScripts) }, maxBuffer: 32 * 1024 * 1024,
    });
    const files = readdirSync(staging).filter(file => file.endsWith('.tgz') && !previous.has(file));
    assert.equal(files.length, 1);
    retain(name, join(staging, files[0]));
  };
  try {
    for (const archive of publicArchives) retain(archive.name, archive.file);
    // Match the plugin's normal release prepack. Its source manifest omits
    // the SDK dependency; the hook adds the publishable SDK version.
    const pluginRelative = 'packages/plugins/sandbox-providers/daytona';
    const plugin = join(staging, pluginRelative);
    mkdirSync(plugin, { recursive: true });
    cpSync(join(repo, pluginRelative, 'dist'), join(plugin, 'dist'), { recursive: true });
    const pluginManifest = JSON.parse(readFileSync(join(repo, pluginRelative, 'package.json')));
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ ...pluginManifest, version: releaseVersion }));
    mkdirSync(join(staging, 'scripts'));
    cpSync(join(repo, 'scripts/generate-plugin-package-json.mjs'), join(staging, 'scripts/generate-plugin-package-json.mjs'));
    mkdirSync(join(staging, 'packages/plugins/sdk'), { recursive: true });
    const sdk = JSON.parse(readFileSync(join(repo, 'packages/plugins/sdk/package.json')));
    writeFileSync(join(staging, 'packages/plugins/sdk/package.json'), JSON.stringify({ ...sdk, version: releaseVersion }));
    pack(plugin, pluginManifest.name, false);
    // The separate private eval SDK is already built by pnpm build. Packing
    // it does not substitute for the public server's packaged runner.
    const runner = join(staging, 'runner');
    mkdirSync(runner);
    const runnerManifest = JSON.parse(readFileSync(join(repo, 'packages/paperclip-runner/package.json')));
    for (const file of runnerManifest.files) {
      const input = join(repo, 'packages/paperclip-runner', file);
      if (existsSync(input)) cpSync(input, join(runner, file), { recursive: true });
    }
    assert.ok(existsSync(join(runner, 'dist/cli/eval-session.js')));
    writeFileSync(join(runner, 'package.json'), JSON.stringify(runnerManifest));
    pack(runner, runnerManifest.name, true);
    assert.equal(new Set(archives.map(a => a.name)).size, archives.length);
    const receipt = { schema: 'paperclip.runner.qualification-packages/v1', sourceRevision, releaseVersion, publicInstallationVerified: true, piAdmissionVerified: true, providerCalls: 0, archives };
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
