import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { checkOAuthEndpointUrl, type ToolUpstreamPending } from "@paperclipai/shared";

/** Recognize provider handoffs before ordinary result redaction removes auth
 * URLs. These links are navigation targets, never credentials or fetch targets.
 * Keep this separate from result/audit storage; never replay the original call. */
export function extractRemoteMcpPending(value: unknown, provider?: string | null): ToolUpstreamPending | null {
  const links = new Map<string, { url: string; host: string; elicitationId?: string }>();
  let expiresAt: string | undefined;
  let message: string | undefined;
  let requestedSchema: Record<string, unknown> | undefined;
  let executionId: string | undefined;
  let elicitationId: string | undefined;
  let approval = false;
  let pending = false;
  let visited = 0;
  const providerHandoffs = provider === "arcade" || provider === "composio" || provider === "executor";
  const addLink = (url: unknown, id?: string) => {
    const checked = checkOAuthEndpointUrl(url);
    if (checked.ok && links.size < 8) {
      links.set(checked.url, { url: checked.url, host: checked.host, ...(id ? { elicitationId: id } : {}) });
      if (id && !elicitationId) elicitationId = id;
    }
  };
  const visit = (item: unknown, depth: number) => {
    if (depth > 10 || ++visited > 500) return;
    if (typeof item === "string") {
      if (item.length < 512_000 && /^[\s]*[\[{]/.test(item)) {
        try { visit(JSON.parse(item), depth + 1); } catch { /* Plain text is not a structured handoff. */ }
      }
      return;
    }
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { for (const child of item.slice(0, 100)) visit(child, depth + 1); return; }
    const record = item as Record<string, unknown>;
    if (record.mode === "url" && typeof record.elicitationId === "string") {
      pending = true;
      addLink(record.url, record.elicitationId.slice(0, 512));
    }
    if (providerHandoffs) {
      for (const key of ["authorization_url", "redirect_url", "approval_url"]) {
        if (typeof record[key] === "string" && record[key]) { pending = true; addLink(record[key]); }
      }
      const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
      if (["requires_approval", "awaiting_approval", "pending_approval", "suspended", "waiting_for_interaction"].includes(status)) { pending = true; approval = true; }
      if (provider === "executor" && status === "waiting_for_interaction") {
        if (typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt))) expiresAt = record.expiresAt;
        const interaction = record.interaction as Record<string, unknown> | undefined;
        if (interaction && typeof interaction === "object") {
          if (typeof interaction.message === "string") message = redactSensitiveText(interaction.message).slice(0, 4000);
          if (interaction.requestedSchema && typeof interaction.requestedSchema === "object" && !Array.isArray(interaction.requestedSchema)) {
            requestedSchema = redactEventPayload(interaction.requestedSchema as Record<string, unknown>) ?? undefined;
          }
          if (interaction.kind === "url") addLink(interaction.url);
        }
      }
      const id = record.executionId ?? record.execution_id;
      if (typeof id === "string") executionId = id.slice(0, 512);
      if (record.approval_url) approval = true;
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(value, 0);
  if (!pending) return null;
  return {
    kind: approval ? "approval" : "authorization",
    links: [...links.values()],
    ...(expiresAt ? { expiresAt } : {}),
    ...(message ? { message } : {}),
    ...(requestedSchema ? { requestedSchema } : {}),
    ...(executionId ? { executionId } : {}),
    ...(elicitationId ? { elicitationId } : {}),
    ...(provider === "executor" && executionId ? { resumeTool: "resume" } : {}),
  };
}
