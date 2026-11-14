import type { RunnerApi } from "./api.js";
import type { ChatFlowInput, ChatRun } from "./chat-flow.js";

export interface OwnedChatRunEvidenceObserver {
  readonly companyId: string;
  readonly origin: string;
  listRuns(): Promise<ChatRun[]>;
  get<T>(path: string): Promise<T>;
  getRunObservation<T>(path: string): Promise<T>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** The caller freezes a genuine owner's separate authenticated client before
 * changing the product actor. The returned interface exposes no mutation API. */
export function createOwnedChatRunEvidenceObserver(api: Pick<RunnerApi, "baseURL" | "get" | "getRunObservation">, companyId: string): OwnedChatRunEvidenceObserver {
  if (!uuid.test(companyId)) throw new Error("Run evidence observer requires the owned company identity");
  const origin = new URL(api.baseURL).origin;
  if (origin !== api.baseURL) throw new Error("Run evidence observer requires an exact API origin");
  const known = new Set<string>();
  async function read<T>(path: string): Promise<T> {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) throw new Error("Run evidence observer escaped its origin");
    const match = /^\/api\/heartbeat-runs\/([^/]+)(?:\/(events|log))?$/.exec(url.pathname);
    if (!match || !uuid.test(match[1]!) || !known.has(match[1]!)) throw new Error("Run evidence requires an independently listed owned run");
    const kind = match[2];
    const keys = [...url.searchParams.keys()];
    const allowed = !kind ? !url.search : kind === "events"
      ? keys.length === 2 && keys.every(key => ["afterSeq", "limit"].includes(key)) && /^\d+$/.test(url.searchParams.get("afterSeq") ?? "") && /^[1-9]\d*$/.test(url.searchParams.get("limit") ?? "")
      : keys.length === 1 && url.searchParams.get("limitBytes") === "1048576";
    if (!allowed) throw new Error("Run evidence observer rejected an unauthorized path or query");
    const value = kind === "log" ? await api.get<T>(url.pathname + url.search) : await api.getRunObservation<T>(url.pathname + url.search);
    if (!kind) {
      const row = value as ChatRun;
      if (row.id !== match[1] || row.companyId !== companyId) throw new Error("Run evidence detail does not match its owned list identity");
    }
    return value;
  }
  return Object.freeze({ companyId, origin, get: read, getRunObservation: read,
    async listRuns() {
      const rows = await api.getRunObservation<ChatRun[]>(`/api/companies/${companyId}/heartbeat-runs?limit=100`);
      if (!Array.isArray(rows) || rows.some(row => !uuid.test(row.id) || row.companyId !== companyId) || new Set(rows.map(row => row.id)).size !== rows.length)
        throw new Error("Run evidence list contains foreign, invalid or duplicate run identities");
      known.clear(); for (const row of rows) known.add(row.id);
      return Promise.all(rows.map(row => read<ChatRun>(`/api/heartbeat-runs/${row.id}`)));
    },
  });
}

/** This exceptional independent observer belongs to precisely one privacy case.
 * Ordinary product calls always continue using input.api's actual human actor. */
export function chatRunEvidenceApi(input: Pick<ChatFlowInput, "api" | "execution" | "fixtures" | "ownedRunEvidenceObserver">): Pick<RunnerApi, "get" | "getRunObservation"> {
  const observer = input.ownedRunEvidenceObserver;
  if (!observer) return input.api;
  if (input.execution.suite.id !== "chat-features" || input.execution.task.id !== "activity.agent-feedback"
    || observer.companyId !== input.fixtures.company.id || observer.origin !== input.api.baseURL)
    throw new Error("Independent run evidence observer is outside its exact approved scenario/company/origin");
  return observer;
}

export async function readChatRuns(input: Pick<ChatFlowInput, "api" | "execution" | "fixtures" | "ownedRunEvidenceObserver">): Promise<ChatRun[]> {
  const api = chatRunEvidenceApi(input);
  if (input.ownedRunEvidenceObserver) return input.ownedRunEvidenceObserver.listRuns();
  const rows = await api.getRunObservation<ChatRun[]>(`/api/companies/${input.fixtures.company.id}/heartbeat-runs?limit=100`);
  return Promise.all(rows.map(row => api.getRunObservation<ChatRun>(`/api/heartbeat-runs/${row.id}`)));
}
