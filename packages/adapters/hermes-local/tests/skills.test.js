import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listHermesSkills, syncHermesSkills } from '../src/server/skills.js';

async function createSkillDir(root, relativeDir, description) {
  const dir = path.join(root, relativeDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${path.basename(relativeDir)}`,
      `description: ${description}`,
      '---',
      '',
      `# ${path.basename(relativeDir)}`,
      '',
      description,
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

test('syncHermesSkills installs bundled Paperclip companion skills into Hermes home', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-skills-bundled-'));
  try {
    const snapshot = await syncHermesSkills(
      { config: { env: { HERMES_HOME: tmp } } },
      [],
    );
    const installed = path.join(tmp, 'skills', 'paperclip', 'paperclip-api', 'SKILL.md');
    const content = await fs.readFile(installed, 'utf8');
    assert.match(content, /paperclip-api/);
    assert.ok(snapshot.entries.some((entry) => entry.key === 'paperclip-api' && entry.state === 'installed'));
    assert.ok(snapshot.desiredSkills.includes('paperclip-api'));
    assert.ok(snapshot.desiredSkills.includes('paperclip-approvals'));
    assert.ok(snapshot.desiredSkills.includes('paperclip-runtime'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('syncHermesSkills installs Paperclip runtime skills under Hermes-friendly names', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-skills-runtime-'));
  const skillSource = await createSkillDir(tmp, 'runtime-src/brainstorming-source', 'Imported from Paperclip.');

  try {
    const snapshot = await syncHermesSkills(
      {
        config: {
          env: { HERMES_HOME: tmp },
          paperclipRuntimeSkills: [
            {
              key: 'company/company-1/brainstorming',
              runtimeName: 'brainstorming--deadbeef',
              source: skillSource,
            },
          ],
        },
      },
      ['company/company-1/brainstorming'],
    );

    const installed = path.join(tmp, 'skills', 'company', 'brainstorming', 'SKILL.md');
    const content = await fs.readFile(installed, 'utf8');
    assert.match(content, /Imported from Paperclip/);

    const entry = snapshot.entries.find((item) => item.key === 'company/company-1/brainstorming');
    assert.equal(entry?.runtimeName, 'brainstorming');
    assert.equal(entry?.state, 'installed');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('syncHermesSkills falls back to hashed runtime names when a native Hermes skill already owns the friendly name', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-skills-conflict-'));
  const nativeSkill = path.join(tmp, 'skills', 'native', 'brainstorming');
  const importedSkill = await createSkillDir(tmp, 'runtime-src/brainstorming-source', 'Managed Paperclip version.');
  await createSkillDir(tmp, 'skills/native/brainstorming', 'Native Hermes version.');

  try {
    const snapshot = await syncHermesSkills(
      {
        config: {
          env: { HERMES_HOME: tmp },
          paperclipRuntimeSkills: [
            {
              key: 'company/company-1/brainstorming',
              runtimeName: 'brainstorming--deadbeef',
              source: importedSkill,
            },
          ],
        },
      },
      ['company/company-1/brainstorming'],
    );

    const managedEntry = snapshot.entries.find((item) => item.key === 'company/company-1/brainstorming');
    assert.equal(managedEntry?.runtimeName, 'brainstorming--deadbeef');
    assert.equal(managedEntry?.state, 'installed');
    assert.equal(await fs.stat(path.join(nativeSkill, 'SKILL.md')).then(() => true).catch(() => false), true);
    assert.equal(
      await fs.stat(path.join(tmp, 'skills', 'company', 'brainstorming--deadbeef', 'SKILL.md')).then(() => true).catch(() => false),
      true,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('listHermesSkills keeps native Hermes skills visible alongside Paperclip-managed entries', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-skills-list-'));
  await createSkillDir(tmp, 'skills/native/hermes-native-test', 'Native Hermes skill.');

  try {
    const snapshot = await listHermesSkills({ config: { env: { HERMES_HOME: tmp } } });
    const nativeEntry = snapshot.entries.find((entry) => entry.key === 'hermes-native-test');
    assert.equal(nativeEntry?.origin, 'user_installed');
    assert.equal(nativeEntry?.state, 'installed');
    assert.equal(nativeEntry?.readOnly, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
