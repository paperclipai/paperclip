import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cursorConsumerDockerArgs, prepareCursorInstallAccount } from '../cursor-public-install-sandbox.mjs';

const values = (args, flag) => args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);
test('setup and offline admission share a real unprivileged account and persistent home', () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-install-account-'));
  try {
    const account = prepareCursorInstallAccount(root, 1001, 1001);
    assert.match(readFileSync(account.passwd, 'utf8'), /paperclip:x:1001:1001:Paperclip verification:\/home\/paperclip:/);
    assert.equal(statSync(account.home).mode & 0o777, 0o700);
    for (const download of [true, false]) {
      const args = cursorConsumerDockerArgs({ account, assets: '/assets', consumer: '/consumer', cache: '/cache', uid: 1001, gid: 1001, command: ['node', '/packages/probe.mjs'], download, readOnlyConsumer: true });
      assert.deepEqual(values(args, '--user'), ['1001:1001']);
      assert.deepEqual(values(args, '--network'), [download ? 'bridge' : 'none']);
      assert.ok(args.includes('--read-only'));
      assert.ok(values(args, '--env').includes('HOME=/home/paperclip'));
      assert.ok(values(args, '--mount').includes('type=bind,src=/consumer,dst=/consumer,readonly'));
      assert.ok(values(args, '--mount').includes(`type=bind,src=${account.passwd},dst=/etc/passwd,readonly`));
      assert.ok(values(args, '--mount').includes(`type=bind,src=${account.home},dst=/home/paperclip`));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an invalid account is rejected before writing a passwd file', () => {
  for (const uid of [0, -1, '1001', undefined]) {
    assert.throws(() => prepareCursorInstallAccount('/does-not-exist', uid, 1001), /unprivileged/);
  }
});
