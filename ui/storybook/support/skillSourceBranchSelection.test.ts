// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { skillSourcesApi } from '@/api/skillSources';
import { COMPANY_ID } from '../fixtures/githubSkillSources';
import { installBranchSelectionFixtures } from './skillSourceBranchSelection';

it('requires the newly returned revision before the concurrent-update journey can save', async () => {
  const client = new QueryClient();
  const fixture = installBranchSelectionFixtures('save-conflict', client);
  try {
    const [source] = await skillSourcesApi.list(COMPANY_ID);
    const input = { revision: source!.revision, trackingRef: 'develop' };
    await expect(skillSourcesApi.settings(COMPANY_ID, source!.id, input)).rejects.toMatchObject({ status: 409 });
    const [updated] = await skillSourcesApi.list(COMPANY_ID);
    expect(updated!.revision).toBeGreaterThan(source!.revision);
    await expect(skillSourcesApi.settings(COMPANY_ID, source!.id, input)).rejects.toMatchObject({ status: 409 });
    const saved = await skillSourcesApi.settings(COMPANY_ID, source!.id, { ...input, revision: updated!.revision });
    expect(saved.trackingRef).toBe('develop');
    expect(saved.revision).toBeGreaterThan(updated!.revision);
  } finally {
    fixture.cleanup(); client.clear();
  }
});
