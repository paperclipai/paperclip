import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireDevinSkillLinks } from './skill-leases.js';

const readRuntimeSkillEntriesMock = vi.hoisted(() => vi.fn());

vi.mock('@paperclipai/adapter-utils/server-utils', async () => {
  const actual = await vi.importActual<
    typeof import('@paperclipai/adapter-utils/server-utils')
  >('@paperclipai/adapter-utils/server-utils');
  readRuntimeSkillEntriesMock.mockImplementation(
    actual.readPaperclipRuntimeSkillEntries,
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries: readRuntimeSkillEntriesMock,
  };
});

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devin-leases-'));
  tempRoots.push(root);
  return root;
}

async function writeSkillSource(
  root: string,
  runtimeName: string,
): Promise<string> {
  const source = path.join(root, 'runtime-skills', runtimeName);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, 'SKILL.md'),
    `---\nname: ${runtimeName}\ndescription: test\n---\n`,
    'utf8',
  );
  return source;
}

function injectConfig(
  cwd: string,
  runtimeSkills: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkills: string[],
) {
  return {
    cwd,
    paperclipRuntimeSkills: runtimeSkills,
    paperclipSkillSync: { desiredSkills },
  };
}

function leaseDirFor(cwd: string): string {
  const hash = createHash('sha256')
    .update(path.resolve(cwd))
    .digest('hex')
    .slice(0, 16);
  return path.join(os.tmpdir(), 'paperclip-devin-skill-leases', hash);
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

const noopLog = async () => {};

const spawned: ReturnType<typeof spawn>[] = [];

async function spawnLongLived(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  spawned.push(child);
  await once(child, 'spawn');
  return child;
}

let fakeHome = '';
let fakeTmp = '';

beforeEach(async () => {
  fakeHome = await makeTempRoot();
  fakeTmp = await makeTempRoot();
  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  vi.stubEnv('TMPDIR', fakeTmp);
  vi.stubEnv('TMP', fakeTmp);
  vi.stubEnv('TEMP', fakeTmp);
  expect(os.homedir()).toBe(fakeHome);
  expect(os.tmpdir()).toBe(fakeTmp);
});

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('acquireDevinSkillLinks', () => {
  it('links desired skills, writes a lease, and removes everything on release', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    const leaseDir = leaseDirFor(cwd);

    const handle = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: noopLog,
    });

    expect(await fs.readlink(path.join(skillsHome, 'review'))).toBe(reviewSource);
    const leaseNames = (await fs.readdir(leaseDir)).filter((n) =>
      n.endsWith('.json'),
    );
    expect(leaseNames).toHaveLength(1);
    const lease = JSON.parse(
      await fs.readFile(path.join(leaseDir, leaseNames[0]), 'utf8'),
    );
    expect(lease).toMatchObject({
      runId: 'run-a',
      pid: process.pid,
      links: [{ name: 'review', source: reviewSource }],
    });

    await handle.release();

    expect(await exists(path.join(skillsHome, 'review'))).toBe(false);
    expect(await exists(skillsHome)).toBe(false);
    expect(await exists(leaseDir)).toBe(false);
    // The workspace root above .devin is never touched.
    expect(await exists(path.join(cwd, '.devin'))).toBe(true);
  });

  it('keeps a shared link while another live lease holds it', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    const cfg = injectConfig(
      cwd,
      [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
      ['company/review'],
    );

    const a = await acquireDevinSkillLinks({ config: cfg, cwd, runId: 'run-a', onLog: noopLog });
    const b = await acquireDevinSkillLinks({ config: cfg, cwd, runId: 'run-b', onLog: noopLog });

    await a.release();
    expect(await fs.readlink(path.join(skillsHome, 'review'))).toBe(reviewSource);

    await b.release();
    expect(await exists(path.join(skillsHome, 'review'))).toBe(false);
    expect(await exists(skillsHome)).toBe(false);
  });

  it('removes only its own links when runs desire different skills', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const lintSource = await writeSkillSource(root, 'lint');
    const skillsHome = path.join(cwd, '.devin', 'skills');

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: noopLog,
    });
    const b = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/lint', runtimeName: 'lint', source: lintSource }],
        ['company/lint'],
      ),
      cwd,
      runId: 'run-b',
      onLog: noopLog,
    });

    await a.release();
    expect(await exists(path.join(skillsHome, 'review'))).toBe(false);
    expect(await fs.readlink(path.join(skillsHome, 'lint'))).toBe(lintSource);

    await b.release();
    expect(await exists(path.join(skillsHome, 'lint'))).toBe(false);
  });

  it('deletes stale leases and does not let their links block removal', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    const leaseDir = leaseDirFor(cwd);
    await fs.mkdir(leaseDir, { recursive: true });
    // A lease from a dead pid and one from this pid with a foreign token are
    // both stale.
    const dead = spawn(process.execPath, ['-e', '0']);
    await once(dead, 'exit');
    const staleLease = (runId: string, pid: number, token: string) =>
      fs.writeFile(
        path.join(leaseDir, `${runId}.json`),
        JSON.stringify({
          runId,
          cwd: path.resolve(cwd),
          pid,
          token,
          links: [{ name: 'review', source: reviewSource }],
          createdAt: new Date().toISOString(),
        }),
      );
    await staleLease('run-dead', dead.pid ?? 999999, 'tok');
    await staleLease('run-wrong-token', process.pid, 'not-our-token');
    // An unparseable lease file is stale too.
    await fs.writeFile(path.join(leaseDir, 'run-garbage.json'), '{nope');

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: noopLog,
    });

    expect(await fs.readdir(leaseDir)).toEqual(['run-a.json']);
    await a.release();
    expect(await exists(path.join(skillsHome, 'review'))).toBe(false);
    expect(await exists(leaseDir)).toBe(false);
  });

  it('removes an undesired leftover managed link and adopts a desired one', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const staleSource = await writeSkillSource(root, 'stale');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(staleSource, path.join(skillsHome, 'stale'));
    await fs.symlink(reviewSource, path.join(skillsHome, 'review'));

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [
          { key: 'company/review', runtimeName: 'review', source: reviewSource },
          { key: 'company/stale', runtimeName: 'stale', source: staleSource },
        ],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: noopLog,
    });

    // Undesired leftover pruned at acquire; desired leftover adopted in place.
    expect(await exists(path.join(skillsHome, 'stale'))).toBe(false);
    expect(await fs.readlink(path.join(skillsHome, 'review'))).toBe(reviewSource);

    await a.release();
    expect(await exists(path.join(skillsHome, 'review'))).toBe(false);
    expect(await exists(skillsHome)).toBe(false);
  });

  it('leaves foreign entries untouched and warns instead of linking over them', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const lintSource = await writeSkillSource(root, 'lint');
    const foreignSource = path.join(root, 'foreign');
    await fs.mkdir(foreignSource, { recursive: true });
    const skillsHome = path.join(cwd, '.devin', 'skills');
    await fs.mkdir(path.join(skillsHome, 'review'), { recursive: true });
    await fs.writeFile(path.join(skillsHome, 'review', 'SKILL.md'), 'foreign\n');
    await fs.symlink(foreignSource, path.join(skillsHome, 'lint'));
    const logs: { stream: string; chunk: string }[] = [];

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [
          { key: 'company/review', runtimeName: 'review', source: reviewSource },
          { key: 'company/lint', runtimeName: 'lint', source: lintSource },
        ],
        ['company/review', 'company/lint'],
      ),
      cwd,
      runId: 'run-a',
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });

    expect(
      logs.filter(
        (entry) =>
          entry.stream === 'stderr' &&
          entry.chunk.includes('occupied by an external installation'),
      ),
    ).toHaveLength(2);

    await a.release();
    expect(
      await fs.readFile(path.join(skillsHome, 'review', 'SKILL.md'), 'utf8'),
    ).toBe('foreign\n');
    expect(await fs.readlink(path.join(skillsHome, 'lint'))).toBe(foreignSource);
    // Foreign entries remain, so the skills dir is kept.
    expect((await fs.readdir(skillsHome)).sort()).toEqual(['lint', 'review']);
  });

  it('breaks a lock dir older than 30 s', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const leaseDir = leaseDirFor(cwd);
    const lockDir = path.join(leaseDir, '.lock');
    await fs.mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 40_000);
    await fs.utimes(lockDir, old, old);

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: noopLog,
    });
    await a.release();
  });

  it('waits for a fresh lock held by another holder', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const leaseDir = leaseDirFor(cwd);
    const lockDir = path.join(leaseDir, '.lock');
    await fs.mkdir(lockDir, { recursive: true });
    const timer = setTimeout(() => {
      void fs.rmdir(lockDir);
    }, 200);

    const started = Date.now();
    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: noopLog,
    });
    clearTimeout(timer);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await a.release();
  });

  it('falls back to run-scoped cleanup when the lease dir is unavailable', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const lintSource = await writeSkillSource(root, 'lint');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    // A regular file where the lease parent dir belongs breaks all lease IO.
    await fs.writeFile(
      path.join(os.tmpdir(), 'paperclip-devin-skill-leases'),
      'occupied',
    );
    // A pre-existing link from another run must survive our cleanup.
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(lintSource, path.join(skillsHome, 'lint'));
    const logs: { stream: string; chunk: string }[] = [];

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });

    expect(
      logs.some(
        (entry) =>
          entry.stream === 'stderr' &&
          entry.chunk.includes('Devin skill lease unavailable'),
      ),
    ).toBe(true);
    expect(await fs.readlink(path.join(skillsHome, 'review'))).toBe(reviewSource);

    await a.release();
    expect(await exists(path.join(skillsHome, 'review'))).toBe(false);
    expect(await fs.readlink(path.join(skillsHome, 'lint'))).toBe(lintSource);
  });

  it('recreates the lease dir when a concurrent release removed it before locking', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const leaseDir = leaseDirFor(cwd);
    const lockDir = path.join(leaseDir, '.lock');
    const logs: { stream: string; chunk: string }[] = [];
    const realMkdir = fs.mkdir.bind(fs);
    let triggered = false;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (p, opts) => {
      if (!triggered && String(p) === lockDir) {
        triggered = true;
        // A racing release emptied and removed the lease dir between our
        // mkdir -p and the lock attempt.
        await fs.rm(leaseDir, { recursive: true, force: true });
      }
      return realMkdir(p as string, opts as never);
    });

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });

    expect(triggered).toBe(true);
    // The leased path was used, not the fallback.
    expect(await fs.readdir(leaseDir)).toContain('run-a.json');
    expect(
      logs.some((entry) => entry.chunk.includes('lease unavailable')),
    ).toBe(false);
    await a.release();
  });

  it('keeps links created before a lease write failure and removes them at release', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    const logs: { stream: string; chunk: string }[] = [];
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (p, data, opts) => {
      if (String(p).endsWith('run-a.json')) {
        throw new Error('lease write exploded');
      }
      return realWriteFile(p as string, data as never, opts as never);
    });

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });

    expect(
      logs.some(
        (entry) =>
          entry.stream === 'stderr' &&
          entry.chunk.includes('Devin skill lease unavailable'),
      ),
    ).toBe(true);
    // The link staged under the lock stays for the run...
    expect(await fs.readlink(path.join(skillsHome, 'review'))).toBe(reviewSource);
    // ...and the fallback release removes it plus the skills dir it created.
    await a.release();
    expect(await exists(path.join(skillsHome, 'review'))).toBe(false);
    expect(await exists(skillsHome)).toBe(false);
  });

  it('never throws: a broken skill catalog yields a no-op release', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const logs: { stream: string; chunk: string }[] = [];
    readRuntimeSkillEntriesMock.mockRejectedValueOnce(
      new Error('catalog exploded'),
    );

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: 'unused' }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });

    expect(
      logs.some(
        (entry) =>
          entry.stream === 'stderr' &&
          entry.chunk.includes('Failed to stage Devin skills: catalog exploded'),
      ),
    ).toBe(true);
    await a.release();
    await a.release();
    expect(await exists(path.join(cwd, '.devin'))).toBe(false);
  });

  it('keeps links while the recorded Devin child pid is alive, even with a dead server pid', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(reviewSource, path.join(skillsHome, 'review'));
    const leaseDir = leaseDirFor(cwd);
    await fs.mkdir(leaseDir, { recursive: true });
    // Simulate a lease left by a server process that died mid-run while its
    // Devin child kept going (the server re-adopts the child on restart).
    const dead = spawn(process.execPath, ['-e', '0']);
    await once(dead, 'exit');
    const child = await spawnLongLived();
    await fs.writeFile(
      path.join(leaseDir, 'run-ghost.json'),
      JSON.stringify({
        runId: 'run-ghost',
        cwd: path.resolve(cwd),
        pid: dead.pid ?? 999999,
        token: 'dead-server-token',
        childPid: child.pid,
        links: [{ name: 'review', source: reviewSource }],
        createdAt: new Date().toISOString(),
      }),
    );

    const b = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        [],
      ),
      cwd,
      runId: 'run-b',
      onLog: noopLog,
    });
    await b.release();

    // The live child pid kept the lease live, so neither acquire's leftover
    // prune nor release removed the held link or the lease file.
    expect(await fs.readlink(path.join(skillsHome, 'review'))).toBe(reviewSource);
    expect(await exists(path.join(leaseDir, 'run-ghost.json'))).toBe(true);
  });

  it('treats a lease as stale once its recorded child pid exits', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(reviewSource, path.join(skillsHome, 'review'));
    const leaseDir = leaseDirFor(cwd);
    await fs.mkdir(leaseDir, { recursive: true });
    const child = await spawnLongLived();
    await fs.writeFile(
      path.join(leaseDir, 'run-ghost.json'),
      JSON.stringify({
        runId: 'run-ghost',
        cwd: path.resolve(cwd),
        pid: 999999,
        token: 'dead-server-token',
        childPid: child.pid,
        links: [{ name: 'review', source: reviewSource }],
        createdAt: new Date().toISOString(),
      }),
    );
    child.kill('SIGKILL');
    await once(child, 'exit');

    const c = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        [],
      ),
      cwd,
      runId: 'run-c',
      onLog: noopLog,
    });

    expect(await exists(path.join(leaseDir, 'run-ghost.json'))).toBe(false);
    expect(await exists(path.join(skillsHome, 'review'))).toBe(false);
    await c.release();
  });

  it('keeps the lease live on the owning server between attempts when the recorded child pid is dead', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    const leaseDir = leaseDirFor(cwd);

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: noopLog,
    });
    // The first Devin child exited and the retry has not spawned yet: the
    // recorded child pid is dead but the owning server is not.
    const dead = spawn(process.execPath, ['-e', '0']);
    await once(dead, 'exit');
    await a.recordChildPid(dead.pid ?? 999999);

    const b = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        [],
      ),
      cwd,
      runId: 'run-b',
      onLog: noopLog,
    });
    await b.release();

    // The owning server (this process, matching token) keeps the lease live,
    // so the link and the lease file survive another run's acquire/release.
    expect(await fs.readlink(path.join(skillsHome, 'review'))).toBe(reviewSource);
    expect(await exists(path.join(leaseDir, 'run-a.json'))).toBe(true);
    await a.release();
  });

  it('treats an orphan lease as stale when the child is dead even if its server pid was reused by a live process', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(reviewSource, path.join(skillsHome, 'review'));
    const leaseDir = leaseDirFor(cwd);
    await fs.mkdir(leaseDir, { recursive: true });
    // The Devin child is dead and the recorded server pid now belongs to an
    // unrelated live process (pid reuse after the server died).
    const dead = spawn(process.execPath, ['-e', '0']);
    await once(dead, 'exit');
    const squatter = await spawnLongLived();
    await fs.writeFile(
      path.join(leaseDir, 'run-ghost.json'),
      JSON.stringify({
        runId: 'run-ghost',
        cwd: path.resolve(cwd),
        pid: squatter.pid,
        token: 'dead-server-token',
        childPid: dead.pid ?? 999999,
        links: [{ name: 'review', source: reviewSource }],
        createdAt: new Date().toISOString(),
      }),
    );

    const b = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        [],
      ),
      cwd,
      runId: 'run-b',
      onLog: noopLog,
    });

    expect(await exists(path.join(leaseDir, 'run-ghost.json'))).toBe(false);
    expect(await exists(path.join(skillsHome, 'review'))).toBe(false);
    await b.release();
  });

  it('treats a foreign lease with no childPid as stale once it is older than 10 minutes', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(reviewSource, path.join(skillsHome, 'review'));
    const leaseDir = leaseDirFor(cwd);
    await fs.mkdir(leaseDir, { recursive: true });
    // A foreign server died before recording its child and its pid was
    // reused by an unrelated live process.
    const squatter = await spawnLongLived();
    await fs.writeFile(
      path.join(leaseDir, 'run-ghost.json'),
      JSON.stringify({
        runId: 'run-ghost',
        cwd: path.resolve(cwd),
        pid: squatter.pid,
        token: 'dead-server-token',
        links: [{ name: 'review', source: reviewSource }],
        createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      }),
    );

    const b = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        [],
      ),
      cwd,
      runId: 'run-b',
      onLog: noopLog,
    });

    expect(await exists(path.join(leaseDir, 'run-ghost.json'))).toBe(false);
    expect(await exists(path.join(skillsHome, 'review'))).toBe(false);
    await b.release();
  });

  it('keeps a fresh foreign lease with no childPid live while its server pid runs', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(reviewSource, path.join(skillsHome, 'review'));
    const leaseDir = leaseDirFor(cwd);
    await fs.mkdir(leaseDir, { recursive: true });
    const squatter = await spawnLongLived();
    await fs.writeFile(
      path.join(leaseDir, 'run-ghost.json'),
      JSON.stringify({
        runId: 'run-ghost',
        cwd: path.resolve(cwd),
        pid: squatter.pid,
        token: 'other-server-token',
        links: [{ name: 'review', source: reviewSource }],
        createdAt: new Date().toISOString(),
      }),
    );

    const b = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        [],
      ),
      cwd,
      runId: 'run-b',
      onLog: noopLog,
    });
    await b.release();

    expect(await fs.readlink(path.join(skillsHome, 'review'))).toBe(reviewSource);
    expect(await exists(path.join(leaseDir, 'run-ghost.json'))).toBe(true);
  });

  it('recordChildPid rewrites the lease under the lock and is a no-op after release', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const leaseDir = leaseDirFor(cwd);

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: noopLog,
    });
    const child = await spawnLongLived();
    await a.recordChildPid(child.pid ?? 0);
    expect(
      JSON.parse(await fs.readFile(path.join(leaseDir, 'run-a.json'), 'utf8')),
    ).toMatchObject({ childPid: child.pid });

    await a.release();
    await a.recordChildPid(4321);
    expect(await exists(leaseDir)).toBe(false);
  });

  it('release is idempotent', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(cwd, '.devin', 'skills');

    const a = await acquireDevinSkillLinks({
      config: injectConfig(
        cwd,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      cwd,
      runId: 'run-a',
      onLog: noopLog,
    });
    await a.release();
    await a.release();
    expect(await exists(skillsHome)).toBe(false);
  });
});
