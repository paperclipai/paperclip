import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDependencies, resolveBaseRef } from '../check-pr-dependencies.mjs';

test('resolveBaseRef: returns the explicit base ref without making API calls', async () => {
  const baseRef = await resolveBaseRef(async () => {
    throw new Error('should not fetch');
  }, 'token', 'paperclipai/paperclip', 6469, 'release/1.2');

  assert.equal(baseRef, 'release/1.2');
});

test('resolveBaseRef: falls back to the PR base ref', async () => {
  const seenPaths = [];
  const baseRef = await resolveBaseRef(async (path) => {
    seenPaths.push(path);
    return { base: { ref: 'main' } };
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(baseRef, 'main');
  assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/pulls/6469']);
});

test('checkDependencies: compares package files against the resolved base ref instead of master', async () => {
  const seenPaths = [];
  const result = await checkDependencies(
    [{ filename: 'packages/foo/package.json', status: 'modified' }],
    'token',
    'paperclipai/paperclip',
    6469,
    'release/1.2',
    async (path) => {
      seenPaths.push(path);

      if (path.includes('ref=release%2F1.2')) {
        return {
          content: Buffer.from(JSON.stringify({
            dependencies: { existing: '^1.0.0' },
          })).toString('base64'),
        };
      }

      if (path.includes('ref=refs%2Fpull%2F6469%2Fhead')) {
        return {
          content: Buffer.from(JSON.stringify({
            dependencies: {
              existing: '^1.0.0',
              added: '^2.0.0',
            },
          })).toString('base64'),
        };
      }

      throw new Error(`Unexpected path: ${path}`);
    }
  );

  assert.equal(result.passed, true);
  assert.equal(result.informational.length, 1);
  assert.match(result.informational[0], /`added`/);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/contents/packages/foo/package.json?ref=release%2F1.2',
    '/repos/paperclipai/paperclip/contents/packages/foo/package.json?ref=refs%2Fpull%2F6469%2Fhead',
  ]);
});
