// EspoCRM connector — the single surface through which the CK workforce reads and writes Espo.
// Full CRUD over ANY entity (Lead/Contact/Account/Opportunity/Email/Meeting/Call/Task/Case/
// KnowledgeBaseArticle/Campaign/MassEmail/TargetList/Webhook/Document/...), plus relationship
// link/unlink. One place to enforce the rule that matters: this connector NEVER triggers an
// outward send — drafting and CRM writes only; sending stays human-gated (see REV-LOOP-01).
//
// Auth is an Espo API key (X-Api-Key). The key is a secret-ref resolved by the worker via
// ctx.secrets.resolve(); it is passed in here already-resolved and is never logged.

export interface EspoConfig {
  baseUrl: string; // e.g. http://127.0.0.1:8085/api/v1
  apiKey: string;
}

export interface EspoListResult<T = Record<string, unknown>> {
  total: number;
  list: T[];
}

type Where = Array<{ type: string; attribute?: string; value?: unknown }>;

// Entity actions that constitute an OUTWARD SEND. The connector refuses these by design;
// sending is performed only after Alan's approval, by a dedicated gated effector — never here.
// sendInvitations: creating a Meeting record is internal (Alan's calendar), but emailing the
// invitation to attendees is an outward send — same gate as everything else.
const FORBIDDEN_SEND_ACTIONS = new Set(["send", "sendTest", "sendTestEmail", "sendInvitations"]);

export class Espo {
  private base: string;
  private key: string;
  constructor(cfg: EspoConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.key = cfg.apiKey;
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(this.base + path, {
      method,
      headers: { "X-Api-Key": this.key, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      // never include the body we sent (may contain PII) or the key; surface status + Espo's reason
      const reason = res.headers.get("X-Status-Reason") || text.slice(0, 240);
      throw new Error(`Espo ${method} ${path} -> ${res.status} ${reason}`);
    }
    return text ? JSON.parse(text) : {};
  }

  private guard(path: string) {
    const action = path.split("?")[0].split("/").filter(Boolean).pop() || "";
    if (FORBIDDEN_SEND_ACTIONS.has(action)) {
      throw new Error(`Espo connector refuses outward-send action "${action}" — sends are human-gated.`);
    }
  }

  // ---- generic CRUD ----
  async list<T = Record<string, unknown>>(
    entity: string,
    opts: { where?: Where; select?: string[]; orderBy?: string; order?: "asc" | "desc"; maxSize?: number; offset?: number } = {},
  ): Promise<EspoListResult<T>> {
    const q = new URLSearchParams();
    if (opts.select) q.set("select", opts.select.join(","));
    if (opts.orderBy) q.set("orderBy", opts.orderBy);
    if (opts.order) q.set("order", opts.order);
    q.set("maxSize", String(Math.min(opts.maxSize ?? 50, 200))); // Espo hard-caps at 200
    if (opts.offset) q.set("offset", String(opts.offset));
    (opts.where || []).forEach((w, i) => {
      q.set(`where[${i}][type]`, w.type);
      if (w.attribute !== undefined) q.set(`where[${i}][attribute]`, w.attribute);
      if (w.value !== undefined) q.set(`where[${i}][value]`, String(w.value));
    });
    return this.req("GET", `/${entity}?${q.toString()}`);
  }

  async get<T = Record<string, unknown>>(entity: string, id: string): Promise<T> {
    return this.req("GET", `/${entity}/${id}`);
  }

  async create<T = Record<string, unknown>>(entity: string, attrs: Record<string, unknown>): Promise<T> {
    return this.req("POST", `/${entity}`, attrs);
  }

  async update<T = Record<string, unknown>>(entity: string, id: string, attrs: Record<string, unknown>): Promise<T> {
    return this.req("PUT", `/${entity}/${id}`, attrs);
  }

  async remove(entity: string, id: string): Promise<void> {
    await this.req("DELETE", `/${entity}/${id}`);
  }

  // ---- relationships ----
  async link(entity: string, id: string, relation: string, targetIds: string | string[]): Promise<void> {
    const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
    await this.req("POST", `/${entity}/${id}/${relation}`, { ids });
  }
  async unlink(entity: string, id: string, relation: string, targetId: string): Promise<void> {
    await this.req("DELETE", `/${entity}/${id}/${relation}?id=${encodeURIComponent(targetId)}`);
  }
  async related<T = Record<string, unknown>>(entity: string, id: string, relation: string, maxSize = 50): Promise<EspoListResult<T>> {
    return this.req("GET", `/${entity}/${id}/${relation}?maxSize=${Math.min(maxSize, 200)}`);
  }

  // Set an Email's parent (e.g. attach an inbound email to its Account/Lead). Used by the Ingestor.
  async setEmailParent(emailId: string, parentType: string, parentId: string): Promise<void> {
    await this.update("Email", emailId, { parentType, parentId });
  }

  // ---- introspection: which entities exist & which are reachable with this key ----
  async metadata(): Promise<any> {
    return this.req("GET", "/Metadata");
  }
  async entityTypes(): Promise<string[]> {
    const meta = await this.metadata();
    return Object.entries(meta.scopes || {})
      .filter(([, s]: any) => s && s.entity)
      .map(([name]) => name)
      .sort();
  }
  async reachable(types: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of types) {
      try {
        await this.list(t, { maxSize: 1 });
        out[t] = 200;
      } catch (e) {
        const m = String(e).match(/-> (\d{3})/);
        out[t] = m ? Number(m[1]) : 0;
      }
    }
    return out;
  }

  // Explicit, intentional escape hatch for callers that need a raw call the helpers don't cover.
  // Still routed through the send-guard.
  async raw(method: string, path: string, body?: unknown): Promise<any> {
    this.guard(path);
    return this.req(method, path, body);
  }
}
