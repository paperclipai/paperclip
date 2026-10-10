import type { ProjectRepositoryOptions, SkillSourceFilePreview, SkillSourcePreviewRequest, SkillSource, SkillSourceCreateRequest, SkillSourceDiscovery, SkillSourceDiscoveryRequest, SkillSourceRefreshResult, SkillSourceSelectionRequest, SkillSourceScanUpdate, SkillSourceDiscoveryEvent } from '@paperclipai/shared';
import { api, ApiError, requestResponse } from './client';
const base = (companyId: string) => `/companies/${companyId}/skill-sources`;
export const skillSourcesApi = {
  list: (companyId: string) => api.get<SkillSource[]>(base(companyId)),
  repositories: (companyId: string) => api.get<ProjectRepositoryOptions>(`${base(companyId)}/repositories`),
  discover: (companyId: string, input: SkillSourceDiscoveryRequest) => api.post<SkillSourceDiscovery>(`${base(companyId)}/discover`, input),
  discoverStream: async (companyId: string, input: SkillSourceDiscoveryRequest, onProgress: (event: SkillSourceScanUpdate) => void, signal?: AbortSignal): Promise<SkillSourceDiscovery> => {
    const response = await requestResponse(`${base(companyId)}/discover`, {
      method: 'POST', body: JSON.stringify(input), headers: { Accept: 'application/x-ndjson' }, signal,
    });
    if (!response.body || !response.headers.get('Content-Type')?.includes('application/x-ndjson')) throw new Error('Live scan unavailable. Refresh the page and try again.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        signal?.throwIfAborted();
        const { value, done } = await reader.read();
        signal?.throwIfAborted();
        buffer += decoder.decode(value, { stream: !done });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          signal?.throwIfAborted();
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line) as SkillSourceDiscoveryEvent;
          if (event.type === 'error') throw new ApiError(event.error, event.status, event);
          if (event.type === 'complete') return event.discovery;
          if (event.type === 'progress' || event.type === 'candidate') onProgress(event);
          else throw new Error('Unexpected repository scan response. Try again.');
        }
        if (done) throw new Error('Repository scan interrupted. Try again.');
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  },
  preview: (companyId: string, input: SkillSourcePreviewRequest, signal?: AbortSignal) => api.post<SkillSourceFilePreview>(`${base(companyId)}/preview`, input, { signal }),
  create: (companyId: string, input: SkillSourceCreateRequest) => api.post<SkillSourceRefreshResult>(base(companyId), input),
  select: (companyId: string, id: string, input: SkillSourceSelectionRequest) => api.patch<SkillSourceRefreshResult>(`${base(companyId)}/${id}`, input),
  refresh: (companyId: string, id: string) => api.post<SkillSourceRefreshResult>(`${base(companyId)}/${id}/refresh`, {}),
  disconnect: (companyId: string, id: string) => api.delete<SkillSource>(`${base(companyId)}/${id}`),
};
