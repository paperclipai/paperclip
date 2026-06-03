import type { PendingApproval } from "../types.js";
import type { BridgeStore, MirrorMapping } from "./types.js";

export interface CouchResponse { status: number; body: unknown; }
export interface CouchHttp { request(method: string, path: string, body?: unknown): Promise<CouchResponse>; }

/**
 * CouchDB-backed BridgeStore. Deterministic doc ids, Mango-free GET/PUT by id.
 * Doc ids: cursor `cursor:<linkId>:<issueId>`, mapping `map:<sourceItemId>`,
 * approval `appr:<approvalId>`. Each write does GET (capture _rev) then PUT.
 */
export class CouchStore implements BridgeStore {
  constructor(private http: CouchHttp, private db: string) {}
  private p(id: string) { return `/${this.db}/${encodeURIComponent(id)}`; }

  async ensure(): Promise<void> {
    const res = await this.http.request("PUT", `/${this.db}`);
    if (res.status >= 400 && res.status !== 412) throw new Error(`couch ensure failed: ${res.status}`);
  }
  private async get<T>(id: string): Promise<(T & { _rev?: string }) | null> {
    const res = await this.http.request("GET", this.p(id));
    if (res.status === 404) return null;
    if (res.status >= 400) throw new Error(`couch get ${id}: ${res.status}`);
    return res.body as T & { _rev?: string };
  }
  private async put(id: string, doc: Record<string, unknown>): Promise<void> {
    const existing = await this.get<Record<string, unknown>>(id);
    const body = existing?._rev ? { ...doc, _id: id, _rev: existing._rev } : { ...doc, _id: id };
    const res = await this.http.request("PUT", this.p(id), body);
    if (res.status >= 400) throw new Error(`couch put ${id}: ${res.status}`);
  }

  async getCursor(linkId: string, issueId: string) {
    const d = await this.get<{ ts: string }>(`cursor:${linkId}:${issueId}`);
    return d?.ts ?? null;
  }
  async setCursor(linkId: string, issueId: string, ts: string) { await this.put(`cursor:${linkId}:${issueId}`, { ts }); }
  async putMapping(m: MirrorMapping) { await this.put(`map:${m.sourceItemId}`, { ...m }); }
  async findMappingBySource(sourceItemId: string) { return await this.get<MirrorMapping>(`map:${sourceItemId}`); }
  async putPendingApproval(p: PendingApproval) { await this.put(`appr:${p.approvalId}`, { ...p }); }
  async getPendingApproval(approvalId: string) { return await this.get<PendingApproval>(`appr:${approvalId}`); }
  async setApprovalState(approvalId: string, state: "approved" | "rejected") {
    const a = await this.get<PendingApproval>(`appr:${approvalId}`);
    if (a) await this.put(`appr:${approvalId}`, { ...a, state });
  }
}
