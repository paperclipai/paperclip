import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDevinSkills, syncDevinSkills } from './skills.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devin-skills-'));
  tempRoots.push(root);
  return root;
}

async function writeSkillSource(root: string, runtimeName: string): Promise<string> {
  const source = path.join(root, 'runtime-skills', runtimeName);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, 'SKILL.md'),
    `---\nname: ${runtimeName}\ndescription: test\n---\n`,
    'utf8',
  );
  return source;
}

function skillCtx(
  cwd: string | undefined,
  runtimeSkills: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkills: string[],
) {
  return {
    agentId: 'agent-1',
    companyId: 'company-1',
    adapterType: 'devin_local',
    config: {
      ...(cwd ? { cwd } : {}),
      paperclipRuntimeSkills: runtimeSkills,
      paperclipSkillSync: { desiredSkills },
    },
  };
}

let fakeHome = '';

beforeEach(async () => {
  fakeHome = await makeTempRoot();
  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  expect(os.homedir()).toBe(fakeHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('listDevinSkills', () => {
  it('reports a configured-for-run ephemeral snapshot and creates nothing on disk', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const paperclipSource = await writeSkillSource(root, 'paperclip');

    const snapshot = await listDevinSkills(
      skillCtx(
        cwd,
        [
          { key: 'company/review', runtimeName: 'review', source: reviewSource },
          { key: 'company/paperclip', runtimeName: 'paperclip', source: paperclipSource },
        ],
        ['company/review'],
      ),
    );

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe('ephemeral');
    expect(snapshot.adapterType).toBe('devin_local');
    const byKey = Object.fromEntries(snapshot.entries.map((entry) => [entry.key, entry]));
    expect(byKey['company/review']).toMatchObject({
      state: 'configured',
      desired: true,
      managed: true,
      detail:
        'Linked into the run working directory at run start and removed when the run ends.',
    });
    expect(byKey['company/paperclip']).toMatchObject({
      state: 'available',
      desired: false,
    });
    // Nothing was staged: list/sync never touch the working directory.
    await expect(fs.lstat(path.join(cwd, '.devin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('syncDevinSkills', () => {
  it('returns the ephemeral snapshot with the merged desired set and writes nothing', async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const reviewSource = await writeSkillSource(root, 'review');
    const paperclipSource = await writeSkillSource(root, 'paperclip');
    const mkdirSpy = vi.spyOn(fs, 'mkdir');
    const symlinkSpy = vi.spyOn(fs, 'symlink');
    const unlinkSpy = vi.spyOn(fs, 'unlink');

    try {
      const snapshot = await syncDevinSkills(
        skillCtx(
          cwd,
          [
            { key: 'company/review', runtimeName: 'review', source: reviewSource },
            { key: 'company/paperclip', runtimeName: 'paperclip', source: paperclipSource },
          ],
          [],
        ),
        ['company/review'],
      );

      expect(snapshot.supported).toBe(true);
      expect(snapshot.mode).toBe('ephemeral');
      const review = snapshot.entries.find((entry) => entry.key === 'company/review');
      expect(review).toMatchObject({ state: 'configured', desired: true });
      for (const spy of [mkdirSpy, symlinkSpy, unlinkSpy]) {
        for (const call of spy.mock.calls) {
          expect(String(call[0]).startsWith(cwd)).toBe(false);
          expect(String(call[0]).startsWith(fakeHome)).toBe(false);
        }
      }
      await expect(fs.lstat(path.join(cwd, '.devin'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('marks deselected skills as not desired in the snapshot', async () => {
    const root = await makeTempRoot();
    const reviewSource = await writeSkillSource(root, 'review');

    const snapshot = await syncDevinSkills(
      skillCtx(
        undefined,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      [],
    );

    const review = snapshot.entries.find((entry) => entry.key === 'company/review');
    expect(review).toMatchObject({ state: 'available', desired: false });
  });
});
