import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPullRequestFiles } from '../fetch-pr-files.mjs';

test('fetchAllPullRequestFiles: returns a single short page', async () => {
  const seenPaths = [];
  const files = await fetchAllPullRequestFiles(async (path) => {
    seenPaths.push(path);
    return [{ filename: 'src/only.ts' }];
  }, 'paperclipai/paperclip', 6469, 'token');

  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/pulls/6469/files?per_page=100&page=1',
  ]);
  assert.equal(files.length, 1);
});

test('fetchAllPullRequestFiles: keeps fetching when a page is full', async () => {
  const seenPaths = [];
  const files = await fetchAllPullRequestFiles(async (path) => {
    seenPaths.push(path);
    const page = Number(new URL(`https://github.com${path}`).searchParams.get('page'));
    if (page === 1) {
      return Array.from({ length: 100 }, (_, index) => ({
        filename: `src/file-${index + 1}.ts`,
      }));
    }
    return [{ filename: 'src/file-101.ts' }];
  }, 'paperclipai/paperclip', 6469, 'token');

  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/pulls/6469/files?per_page=100&page=1',
    '/repos/paperclipai/paperclip/pulls/6469/files?per_page=100&page=2',
  ]);
  assert.equal(files.length, 101);
  assert.equal(files.at(-1)?.filename, 'src/file-101.ts');
});
