import { ApiError, api } from "./client";

/** Aligns with `/tmp/laminarize_paperclip_acl_plan.md` company-scoped routes. */
export type AgentAclPermission = "assign" | "comment";

export interface AgentPermissionGrantRow {
  id: string;
  granteeId: string;
  agentId: string;
  permission: AgentAclPermission;
}

export interface AgentPermissionDefaults {
  assignDefault: boolean;
  commentDefault: boolean;
}

function pickString(obj: Record<string, unknown>, camel: string, snake: string): string | undefined {
  const a = obj[camel];
  const b = obj[snake];
  if (typeof a === "string" && a) return a;
  if (typeof b === "string" && b) return b;
  return undefined;
}

function mapGrantRow(raw: unknown): AgentPermissionGrantRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = pickString(o, "id", "id");
  const granteeId = pickString(o, "granteeId", "grantee_id");
  const agentId = pickString(o, "agentId", "agent_id");
  const permRaw = o.permission;
  const permission =
    permRaw === "assign" || permRaw === "comment" ? permRaw : null;
  if (!id || !granteeId || !agentId || !permission) return null;
  return { id, granteeId, agentId, permission };
}

export function normalizeGrantsPayload(data: unknown): AgentPermissionGrantRow[] {
  if (Array.isArray(data)) {
    return data.map(mapGrantRow).filter((g): g is AgentPermissionGrantRow => g !== null);
  }
  if (data && typeof data === "object" && "grants" in data) {
    const g = (data as { grants?: unknown }).grants;
    if (Array.isArray(g)) {
      return g.map(mapGrantRow).filter((row): row is AgentPermissionGrantRow => row !== null);
    }
  }
  return [];
}

function mapDefaultsPayload(data: unknown): AgentPermissionDefaults | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const assign =
    typeof o.assignDefault === "boolean"
      ? o.assignDefault
      : typeof o.assign_default === "boolean"
        ? o.assign_default
        : undefined;
  const comment =
    typeof o.commentDefault === "boolean"
      ? o.commentDefault
      : typeof o.comment_default === "boolean"
        ? o.comment_default
        : undefined;
  if (typeof assign !== "boolean" || typeof comment !== "boolean") return null;
  return { assignDefault: assign, commentDefault: comment };
}

export const agentPermissionsApi = {
  listByGrantee(companyId: string, granteeId: string) {
    const path = `/companies/${encodeURIComponent(companyId)}/agent-permission-grants?granteeId=${encodeURIComponent(granteeId)}`;
    return api.get<unknown>(path).then(normalizeGrantsPayload);
  },

  create(
    companyId: string,
    body: { granteeId: string; agentId: string; permission: AgentAclPermission },
  ) {
    return api.post<unknown>(`/companies/${encodeURIComponent(companyId)}/agent-permission-grants`, body);
  },

  remove(companyId: string, grantId: string) {
    return api.delete<void>(
      `/companies/${encodeURIComponent(companyId)}/agent-permission-grants/${encodeURIComponent(grantId)}`,
    );
  },

  /**
   * Returns `null` when the defaults row is missing (404). Callers that need to
   * distinguish “API not deployed” from “loaded defaults” should use
   * `getDefaultsResult` instead.
   */
  async getDefaults(companyId: string): Promise<AgentPermissionDefaults | null> {
    const r = await agentPermissionsApi.getDefaultsResult(companyId);
    return r.kind === "ok" ? r.defaults : null;
  },

  async getDefaultsResult(
    companyId: string,
  ): Promise<
    | { kind: "ok"; defaults: AgentPermissionDefaults }
    | { kind: "not_found" }
    | { kind: "invalid" }
  > {
    try {
      const raw = await api.get<unknown>(
        `/companies/${encodeURIComponent(companyId)}/agent-permission-defaults`,
      );
      const defaults = mapDefaultsPayload(raw);
      if (!defaults) return { kind: "invalid" };
      return { kind: "ok", defaults };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return { kind: "not_found" };
      throw e;
    }
  },

  patchDefaults(companyId: string, patch: { assignDefault?: boolean; commentDefault?: boolean }) {
    return api
      .patch<unknown>(`/companies/${encodeURIComponent(companyId)}/agent-permission-defaults`, patch)
      .then((raw) => mapDefaultsPayload(raw));
  },
};
