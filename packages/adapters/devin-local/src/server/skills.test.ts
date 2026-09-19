import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureDevinSkillsInjected,
  listDevinSkills,
  resolveDevinSkillsHome,
  syncDevinSkills,
} from './skills.js';

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
  cwd: string,
  runtimeSkills: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkills: string[],
) {
  return {
    agentId: 'agent-1',
    companyId: 'company-1',
    adapterType: 'devin_local',
    config: {
      cwd,
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

describe('resolveDevinSkillsHome', () => {
  it('anchors at config.cwd/.devin/skills', () => {
    expect(resolveDevinSkillsHome({ cwd: '/work/agent' })).toBe(
      path.join('/work/agent', '.devin', 'skills'),
    );
  });
});

describe('listDevinSkills', () => {
  it('reports available, installed, stale, missing, and external conflict states', async () => {
    const root = await makeTempRoot();
    const reviewSource = await writeSkillSource(root, 'review');
    const paperclipSource = await writeSkillSource(root, 'paperclip');
    const staleSource = await writeSkillSource(root, 'stale');
    const missingSource = await writeSkillSource(root, 'missing');
    const conflictSource = await writeSkillSource(root, 'conflict');
    const skillsHome = path.join(root, '.devin', 'skills');
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(reviewSource, path.join(skillsHome, 'review'));
    await fs.symlink(staleSource, path.join(skillsHome, 'stale'));
    await fs.mkdir(path.join(skillsHome, 'conflict'));
    await fs.writeFile(path.join(skillsHome, 'conflict', 'SKILL.md'), 'external\n');
    await fs.mkdir(path.join(skillsHome, 'user-skill'));

    const snapshot = await listDevinSkills(
      skillCtx(
        root,
        [
          { key: 'company/review', runtimeName: 'review', source: reviewSource },
          { key: 'company/paperclip', runtimeName: 'paperclip', source: paperclipSource },
          { key: 'company/stale', runtimeName: 'stale', source: staleSource },
          { key: 'company/missing', runtimeName: 'missing', source: missingSource },
          { key: 'company/conflict', runtimeName: 'conflict', source: conflictSource },
        ],
        ['company/review', 'company/missing', 'company/conflict'],
      ),
    );

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe('persistent');
    expect(snapshot.adapterType).toBe('devin_local');

    const byKey = Object.fromEntries(snapshot.entries.map((entry) => [entry.key, entry]));
    expect(byKey['company/paperclip']).toMatchObject({
      state: 'available',
      desired: false,
      managed: false,
    });
    expect(byKey['company/review']).toMatchObject({
      state: 'installed',
      desired: true,
      managed: true,
    });
    expect(byKey['company/stale']).toMatchObject({
      state: 'stale',
      desired: false,
      managed: true,
    });
    expect(byKey['company/missing']).toMatchObject({
      state: 'missing',
      desired: true,
      managed: false,
      detail: 'Configured but not currently linked into the Devin project skills directory.',
    });
    expect(byKey['company/conflict']).toMatchObject({
      state: 'external',
      desired: true,
      managed: false,
      detail: 'Skill name is occupied by an external installation.',
    });
    expect(byKey['user-skill']).toMatchObject({
      state: 'external',
      desired: false,
      managed: false,
      detail: 'Installed outside Paperclip management.',
    });
  });
});

describe('syncDevinSkills', () => {
  it('creates links for desired skills and removes only Paperclip-managed links', async () => {
    const root = await makeTempRoot();
    const reviewSource = await writeSkillSource(root, 'review');
    const paperclipSource = await writeSkillSource(root, 'paperclip');
    const staleSource = await writeSkillSource(root, 'stale');
    const conflictSource = await writeSkillSource(root, 'conflict');
    const skillsHome = path.join(root, '.devin', 'skills');
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(staleSource, path.join(skillsHome, 'stale'));
    await fs.mkdir(path.join(skillsHome, 'conflict'));
    await fs.writeFile(path.join(skillsHome, 'conflict', 'SKILL.md'), 'external\n');
    await fs.mkdir(path.join(skillsHome, 'user-skill'));

    const snapshot = await syncDevinSkills(
      skillCtx(
        root,
        [
          { key: 'company/review', runtimeName: 'review', source: reviewSource },
          { key: 'company/paperclip', runtimeName: 'paperclip', source: paperclipSource },
          { key: 'company/stale', runtimeName: 'stale', source: staleSource },
          { key: 'company/conflict', runtimeName: 'conflict', source: conflictSource },
        ],
        ['company/review'],
      ),
      ['company/review'],
    );

    expect(snapshot.mode).toBe('persistent');
    expect(await fs.readlink(path.join(skillsHome, 'review'))).toBe(reviewSource);
    await expect(fs.lstat(path.join(skillsHome, 'stale'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await fs.lstat(path.join(skillsHome, 'conflict'))).isDirectory()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, 'user-skill'))).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(skillsHome, 'conflict', 'SKILL.md'), 'utf8')).toBe(
      'external\n',
    );
    const review = snapshot.entries.find((entry) => entry.key === 'company/review');
    expect(review).toMatchObject({ state: 'installed', desired: true, managed: true });
  });
});

describe('ensureDevinSkillsInjected', () => {
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

  it('prunes a known stale link when all skills are deselected and preserves foreign entries', async () => {
    const root = await makeTempRoot();
    const staleSource = await writeSkillSource(root, 'stale');
    const skillsHome = path.join(root, '.devin', 'skills');
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(staleSource, path.join(skillsHome, 'stale'));
    await fs.mkdir(path.join(skillsHome, 'user-skill'));
    const logs: { stream: string; chunk: string }[] = [];

    await ensureDevinSkillsInjected(
      injectConfig(
        root,
        [{ key: 'company/stale', runtimeName: 'stale', source: staleSource }],
        [],
      ),
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    );

    await expect(fs.lstat(path.join(skillsHome, 'stale'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await fs.lstat(path.join(skillsHome, 'user-skill'))).isDirectory()).toBe(true);
  });

  it('warns and leaves an external directory byte-identical when a desired skill name is occupied', async () => {
    const root = await makeTempRoot();
    const conflictSource = await writeSkillSource(root, 'conflict');
    const skillsHome = path.join(root, '.devin', 'skills');
    await fs.mkdir(path.join(skillsHome, 'conflict'), { recursive: true });
    await fs.writeFile(path.join(skillsHome, 'conflict', 'SKILL.md'), 'external\n');
    const logs: { stream: string; chunk: string }[] = [];

    await ensureDevinSkillsInjected(
      injectConfig(
        root,
        [{ key: 'company/conflict', runtimeName: 'conflict', source: conflictSource }],
        ['company/conflict'],
      ),
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    );

    expect(
      logs.some(
        (entry) =>
          entry.stream === 'stderr' &&
          entry.chunk.includes('company/conflict') &&
          entry.chunk.includes('occupied by an external installation'),
      ),
    ).toBe(true);
    expect(await fs.readFile(path.join(skillsHome, 'conflict', 'SKILL.md'), 'utf8')).toBe(
      'external\n',
    );
    expect((await fs.lstat(path.join(skillsHome, 'conflict'))).isDirectory()).toBe(true);
  });

  it('does not warn when the desired skill is already linked correctly', async () => {
    const root = await makeTempRoot();
    const reviewSource = await writeSkillSource(root, 'review');
    const skillsHome = path.join(root, '.devin', 'skills');
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(reviewSource, path.join(skillsHome, 'review'));
    const logs: { stream: string; chunk: string }[] = [];

    await ensureDevinSkillsInjected(
      injectConfig(
        root,
        [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
        ['company/review'],
      ),
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    );

    expect(logs.some((entry) => entry.chunk.includes('occupied by an external installation'))).toBe(
      false,
    );
    expect(await fs.readlink(path.join(skillsHome, 'review'))).toBe(reviewSource);
  });
});

describe('skills without an explicit cwd', () => {
  function noCwdCtx(
    runtimeSkills: Array<{ key: string; runtimeName: string; source: string }>,
    desiredSkills: string[],
  ) {
    return {
      agentId: 'agent-1',
      companyId: 'company-1',
      adapterType: 'devin_local',
      config: {
        paperclipRuntimeSkills: runtimeSkills,
        paperclipSkillSync: { desiredSkills },
      },
    };
  }

  function spyFs() {
    return [
      vi.spyOn(fs, 'readdir'),
      vi.spyOn(fs, 'mkdir'),
      vi.spyOn(fs, 'symlink'),
      vi.spyOn(fs, 'readlink'),
      vi.spyOn(fs, 'unlink'),
    ];
  }

  function expectNoHomeWrites(spies: ReturnType<typeof spyFs>) {
    const homePrefix = os.homedir();
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(String(call[0]).startsWith(homePrefix)).toBe(false);
      }
    }
  }

  it('lists a configured-for-run ephemeral snapshot and never touches $HOME', async () => {
    const root = await makeTempRoot();
    const reviewSource = await writeSkillSource(root, 'review');
    const spies = spyFs();
    try {
      const snapshot = await listDevinSkills(
        noCwdCtx(
          [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
          ['company/review'],
        ),
      );
      expect(snapshot.supported).toBe(true);
      expect(snapshot.mode).toBe('ephemeral');
      const review = snapshot.entries.find((entry) => entry.key === 'company/review');
      expect(review).toMatchObject({ state: 'configured', desired: true });
      expectNoHomeWrites(spies);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('sync without an explicit cwd returns the same snapshot without writing', async () => {
    const root = await makeTempRoot();
    const reviewSource = await writeSkillSource(root, 'review');
    const spies = spyFs();
    try {
      const snapshot = await syncDevinSkills(
        noCwdCtx(
          [{ key: 'company/review', runtimeName: 'review', source: reviewSource }],
          [],
        ),
        ['company/review'],
      );
      expect(snapshot.supported).toBe(true);
      expect(snapshot.mode).toBe('ephemeral');
      const review = snapshot.entries.find((entry) => entry.key === 'company/review');
      expect(review).toMatchObject({ state: 'configured', desired: true });
      expectNoHomeWrites(spies);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
