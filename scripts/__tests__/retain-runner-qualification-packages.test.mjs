import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { retainRunnerQualificationPackages } from '../retain-runner-qualification-packages.mjs';

test('retention preserves public archives and runs the normal plugin prepack without modifying source', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualification-retention-test-'));
  const sourceRevision = '1'.repeat(40), releaseVersion = '0.0.0-qualification.test';
  const put = (relative, content) => {
    const file = join(root, relative); mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content); return file;
  };
  const json = (relative, value) => put(relative, JSON.stringify(value));
  try {
    json('server/dist/build-info.json', { commit: sourceRevision });
    const originalPlugin = JSON.parse(readFileSync(new URL('../../packages/plugins/sandbox-providers/daytona/package.json', import.meta.url)));
    const pluginManifest = json('packages/plugins/sandbox-providers/daytona/package.json', originalPlugin);
    put('packages/plugins/sandbox-providers/daytona/dist/index.js', 'export const retained = true;\n');
    json('packages/plugins/sdk/package.json', { name: '@paperclipai/plugin-sdk', version: '0.3.1' });
    put('scripts/generate-plugin-package-json.mjs', readFileSync(new URL('../generate-plugin-package-json.mjs', import.meta.url)));
    json('packages/paperclip-runner/package.json', { name: '@paperclipai/paperclip-runner', version: '0.0.0', private: true, files: ['dist'] });
    put('packages/paperclip-runner/dist/cli/eval-session.js', 'export const evaluation = true;\n');
    const publicArchives = ['@paperclipai/server', 'paperclipai', '@paperclipai/plugin-sdk'].map((name, i) => ({ name, file: put(`public-${i}.tgz`, `unchanged archive ${name}`) }));
    const output = join(root, 'retained');
    const result = retainRunnerQualificationPackages({ repo: root, output, sourceRevision, releaseVersion, publicArchives });
    assert.equal(result.archives.length, 5);
    for (const archive of result.archives) assert.equal(createHash('sha256').update(readFileSync(join(output, archive.file))).digest('hex'), archive.sha256);
    for (const archive of publicArchives) assert.deepEqual(readFileSync(join(output, archive.file.split('/').at(-1))), readFileSync(archive.file));
    const plugin = result.archives.find(a => a.name === '@paperclipai/plugin-daytona');
    const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', join(output, plugin.file), 'package/package.json']));
    assert.equal(packedManifest.dependencies['@paperclipai/plugin-sdk'], releaseVersion);
    assert.equal(packedManifest.exports['.'].import, './dist/index.js');
    assert.equal(execFileSync('tar', ['-xOf', join(output, plugin.file), 'package/dist/index.js'], { encoding: 'utf8' }), 'export const retained = true;\n');
    assert.deepEqual(JSON.parse(readFileSync(pluginManifest)), originalPlugin);
    assert.equal(existsSync(join(root, 'packages/plugins/sandbox-providers/daytona/package.dev.json')), false);
    assert.throws(() => retainRunnerQualificationPackages({ repo: root, output, sourceRevision, releaseVersion, publicArchives }), /Never replace/);
    assert.throws(() => retainRunnerQualificationPackages({ repo: root, output: join(root, 'wrong-source'), sourceRevision: '2'.repeat(40), releaseVersion, publicArchives }));
    assert.equal(existsSync(join(root, 'wrong-source')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
