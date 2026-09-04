import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
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

afterEach(async () => {
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
