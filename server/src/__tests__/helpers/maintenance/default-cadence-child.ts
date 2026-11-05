import { installDefaultCadenceNetwork, defaultCadenceNetwork } from './default-cadence-network.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { githubFixture } from '../github-skills.js';
import type { openGitSkillSnapshot } from '../../../services/skill-source-git-snapshot.js';

// Only the remote Git download is controlled. The actual GitHub reader still
// resolves current authority before invoking this transport, and the scanner,
// package inspection, budget reservation and immutable publication stay real.
installDefaultCadenceNetwork();
const send = process.send;
if (send) process.send = function(message: unknown, ...args: unknown[]) {
  const value = message && typeof message === 'object' ? { ...message, defaultCadenceGuard: defaultCadenceNetwork() } : message;
  return Reflect.apply(send, process, [value, ...args]);
} as NonNullable<typeof process.send>;
const origin = process.env.PAPERCLIP_MAINTENANCE_GITHUB_ORIGIN;
assert(origin && new URL(origin).hostname === '127.0.0.1');
const actual = await import('../../../services/skill-source-git-snapshot.js');
const open: typeof openGitSkillSnapshot = async (input, options = {}) => {
  assert.equal(input.repositoryUrl, 'https://github.com/acme/skills');
  assert(['HEAD', 'main'].includes(input.ref) || /^[a-f0-9]{40}$/i.test(input.ref));
  options.signal?.throwIfAborted();
  options.beforeDownload?.();
  const response = await fetch(new URL('/__skill_snapshot', origin), { signal: options.signal });
  assert(response.ok);
  const snapshot = await response.json() as { commit: string; files: Record<string, string> };
  assert.match(snapshot.commit, /^[a-f0-9]{40}$/);
  if (input.commitSha) assert.equal(input.commitSha, snapshot.commit);
  return githubFixture(snapshot.files, {}, snapshot.commit).openSnapshot!(input, options);
};
mock.module(new URL('../../../services/skill-source-git-snapshot.ts', import.meta.url).href,
  { namedExports: { ...actual, openGitSkillSnapshot: open } });
assert.equal((await import('../../../services/skill-source-git-snapshot.js')).openGitSkillSnapshot, open,
  'Module loader bypassed the named external Git boundary');
await import('./server-child.js');
