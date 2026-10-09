import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { grokConsumerDockerArgs } from './grok-public-install-sandbox.mjs';

export const CURSOR_INSTALL_ACCOUNT_HOME = '/home/paperclip';

// The host UID need not exist in the pinned image. Give it a real, isolated
// account home that survives the separate installation and offline probe runs.
export function prepareCursorInstallAccount(root, uid, gid) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    throw new Error('Public-install verification requires an unprivileged host user');
  }
  const home = join(root, 'account-home');
  const passwd = join(root, 'account-passwd');
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(passwd, `root:x:0:0:root:/root:/usr/sbin/nologin\npaperclip:x:${uid}:${gid}:Paperclip verification:${CURSOR_INSTALL_ACCOUNT_HOME}:/usr/sbin/nologin\n`, { mode: 0o444, flag: 'wx' });
  return { home, passwd };
}

export function cursorConsumerDockerArgs({ account, readOnlyConsumer = false, ...options }) {
  const args = grokConsumerDockerArgs({ ...options, temporarySizeMb: 1024, command: [] });
  const image = args.pop();
  args[args.indexOf('HOME=/tmp')] = `HOME=${CURSOR_INSTALL_ACCOUNT_HOME}`;
  if (readOnlyConsumer) {
    const mount = `type=bind,src=${options.consumer},dst=/consumer`;
    args[args.indexOf(mount)] = `${mount},readonly`;
  }
  return [...args,
    '--mount', `type=bind,src=${account.passwd},dst=/etc/passwd,readonly`,
    '--mount', `type=bind,src=${account.home},dst=${CURSOR_INSTALL_ACCOUNT_HOME}`,
    image, ...options.command];
}
