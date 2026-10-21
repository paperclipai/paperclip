import { describe, expect, it, vi } from 'vitest';
import { skillSourceSettingsSchema } from '@paperclipai/shared';
import { listSkillSourceBranches } from '../services/skill-source-branches.js';

const source = { fullName: 'acme/skills', repositoryId: '42' };
function reader(branches: unknown, defaultBranch = 'master', id = 42) {
  return vi.fn(async (request: string) => request === '/repos/acme/skills' ? { id, default_branch: defaultBranch } : branches);
}
describe('skill source branch discovery', () => {
  it('includes the default even when it is outside the bounded first page', async () => {
    const read = reader(Array.from({ length: 100 }, (_, index) => ({ name: `feature/${index}` })));
    const result = await listSkillSourceBranches(source, read);
    expect(result.branches).toHaveLength(101);
    expect(result.branches[0]).toEqual({ name: 'master', isDefault: true });
    expect(result.truncated).toBe(true);
    expect(read).toHaveBeenLastCalledWith('/repos/acme/skills/branches?per_page=100&page=1', undefined);
  });
  it('deduplicates branch names and preserves case and slashes', async () => {
    expect(await listSkillSourceBranches(source, reader([{ name: 'master' }, { name: 'feature/New' }, { name: 'feature/New' }]))).toEqual({
      defaultBranch: 'master', branches: [{ name: 'master', isDefault: true }, { name: 'feature/New', isDefault: false }], truncated: false,
    });
  });
  it('stops before listing when the repository identity changed', async () => {
    const read = reader([], 'master', 99);
    await expect(listSkillSourceBranches(source, read)).rejects.toMatchObject({ status: 409 });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([{ value: null }, { value: {} }, { value: [{ name: 42 }] }, { value: [{ name: 'bad\0branch' }] }])('rejects malformed provider lists without returning their contents', async ({ value }) => {
    await expect(listSkillSourceBranches(source, reader(value))).rejects.toMatchObject({ status: 422, message: 'GitHub returned an invalid branch list. Try again.' });
  });
  it('accepts a typed ref and the existing HEAD alias but rejects empty and control-character values', () => {
    expect(skillSourceSettingsSchema.parse({ revision: 2, trackingRef: ' feature/New ' }).trackingRef).toBe('feature/New');
    expect(skillSourceSettingsSchema.parse({ revision: 2, trackingRef: 'HEAD' }).trackingRef).toBe('HEAD');
    for (const trackingRef of ['', ' ', 'bad\0ref', 'bad\nref']) expect(skillSourceSettingsSchema.safeParse({ revision: 2, trackingRef }).success).toBe(false);
  });
});
