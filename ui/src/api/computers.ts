import type { ComputerViewer, TaskComputer } from "@paperclipai/shared";
import { api } from "./client";

const path = (issueId: string) => `/issues/${encodeURIComponent(issueId)}/computer`;
export const computersApi = {
  get: (issueId: string) => api.get<TaskComputer | null>(path(issueId), { cache: "no-store" }),
  connect: (issueId: string, environmentId: string) =>
    api.post<ComputerViewer>(`${path(issueId)}/connect`, { environmentId }),
  presence: (issueId: string, environmentId: string, owner: ComputerViewer["owner"]) =>
    api.post<ComputerViewer>(`${path(issueId)}/presence`, { environmentId, owner }),
  disconnect: (issueId: string, environmentId: string, owner: ComputerViewer["owner"]) =>
    api.post<void>(`${path(issueId)}/disconnect`, { environmentId, owner }),
  preview: (issueId: string, environmentId: string, port: number) =>
    api.post<{ url: string }>(`${path(issueId)}/preview`, { environmentId, port }),
};
