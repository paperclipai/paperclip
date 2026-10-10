import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillSourcesApi } from './skillSources';
import { tenantSessionRecovery } from '@/lib/tenant-session-recovery';
import type { SkillSourceDiscovery, SkillSourceDiscoveryEvent } from '@paperclipai/shared';

const input = { repositoryUrl: 'https://github.com/acme/skills' };
const discovery: SkillSourceDiscovery = { repositoryId: '1', ...input, fullName: 'acme/skills', trackingRef: 'main', commitSha: 'a'.repeat(40), candidates: [], warnings: [] };
const candidate = { type: 'candidate' as const, candidate: { path: 'one/SKILL.md', name: 'Résumé', description: null, fileCount: 3, error: null } };
function response(events: SkillSourceDiscoveryEvent[], byteByByte = false) {
  const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event) + '\n').join(''));
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    if (byteByByte) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } });
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('live skill source discovery', () => {
  it('decodes split UTF-8 and NDJSON frames and returns only the completed discovery', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([candidate, { type: 'complete', discovery }], true));
    vi.stubGlobal('fetch', fetchMock);
    const updates = vi.fn();
    expect(await skillSourcesApi.discoverStream('company-1', input, updates)).toEqual(discovery);
    expect(updates).toHaveBeenCalledExactlyOnceWith(candidate);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/companies/company-1/skill-sources/discover');
    expect(init.credentials).toBe('include');
    expect(init.headers.get('Accept')).toBe('application/x-ndjson');
    expect(init.headers.get('Content-Type')).toBe('application/json');
  });
  it('does not accept partial candidates when the connection closes without a complete frame', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([candidate])));
    const updates = vi.fn();
    await expect(skillSourcesApi.discoverStream('company-1', input, updates)).rejects.toThrow('scan interrupted');
    expect(updates).toHaveBeenCalledWith(candidate);
  });
  it('surfaces an in-stream provider error after partial progress', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([candidate, { type: 'error', error: 'Reconnect GitHub', status: 403 }])));
    await expect(skillSourcesApi.discoverStream('company-1', input, vi.fn())).rejects.toMatchObject({ message: 'Reconnect GitHub', status: 403 });
  });
  it('preserves normal HTTP authorization and session recovery handling', async () => {
    const recover = vi.spyOn(tenantSessionRecovery, 'recoverIfNeeded').mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Company access denied' }, { status: 403 })));
    await expect(skillSourcesApi.discoverStream('company-2', input, vi.fn())).rejects.toMatchObject({ status: 403, message: 'Company access denied' });
    expect(recover).toHaveBeenCalledWith(403, { error: 'Company access denied' });
  });
  it('passes cancellation to fetch and stops consuming events once aborted', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(response([candidate]));
    vi.stubGlobal('fetch', fetchMock);
    const updates = vi.fn(() => controller.abort());
    await expect(skillSourcesApi.discoverStream('company-1', input, updates, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0]![1].signal).toBe(controller.signal);
  });
});
