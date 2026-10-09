import type { ComposioAppAccount, ComposioAppSetupResult } from "@paperclipai/shared";
import { extractRemoteMcpPending } from "./remote-mcp-pending.js";
import { unprocessable } from "../errors.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function payloadsFrom(response: unknown) {
  const root = record(response);
  const result = record(root?.result) ?? root;
  const payloads = [result, record(result?.structuredContent)];
  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      const block = record(item);
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      try { payloads.push(record(JSON.parse(block.text))); } catch { /* Plain text is not proof. */ }
    }
  }
  if (root?.error || result?.isError === true || payloads.some(p => p?.successful === false || p?.success === false || p?.error)) {
    throw unprocessable("Composio could not configure this app. Check the app in Composio and try again.");
  }
  return payloads;
}

/** Retain only account identity and status, never raw provider results or credentials. */
export function composioAppAccounts(response: unknown, toolkit: string): ComposioAppAccount[] | undefined {
  const accounts = new Map<string, ComposioAppAccount>();
  let observed = false;
  let incomplete = false;
  let visited = 0;
  function visit(value: unknown, matched: boolean, depth: number) {
    if (++visited > 20_000 || depth > 12) { incomplete = true; return; }
    if (Array.isArray(value)) { value.forEach(item => visit(item, matched, depth + 1)); return; }
    const entry = record(value);
    if (!entry) return;
    const named = entry.toolkit ?? entry.toolkit_name ?? entry.toolkit_slug;
    const selected = matched || named === toolkit || record(named)?.slug === toolkit;
    if (selected && (entry.error || entry.success === false || entry.successful === false)) {
      throw unprocessable("Composio could not check this app. Refresh its accounts before trying again.");
    }
    if (selected && Array.isArray(entry.accounts)) {
      observed = true;
      for (const item of entry.accounts) {
        const account = record(item);
        const id = account?.id ?? account?.account_id ?? account?.connected_account_id;
        if (typeof id !== "string" || !id || id.length > 200) { incomplete = true; continue; }
        accounts.set(id, { id, alias: typeof account?.alias === "string" ? account.alias.slice(0, 100) : null,
          status: typeof account?.status === "string" ? account.status.toUpperCase().slice(0, 40) : "UNKNOWN",
          isDefault: account?.is_default === true || account?.isDefault === true });
      }
    }
    for (const [key, child] of Object.entries(entry)) visit(child, selected || key === toolkit, depth + 1);
  }
  payloadsFrom(response).forEach(payload => visit(payload, false, 0));
  return observed && !incomplete ? [...accounts.values()] : undefined;
}

/** Only the requested toolkit can establish success; other accounts are unrelated. */
export function composioAppSetupResult(response: unknown, toolkit: string): ComposioAppSetupResult {
  const payloads = payloadsFrom(response);
  let connected = false;
  let visited = 0;
  const visit = (value: unknown, matched: boolean, depth: number) => {
    if (++visited > 20_000 || depth > 12) return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, matched, depth + 1)); return; }
    const entry = record(value);
    if (!entry) return;
    const named = entry.toolkit ?? entry.toolkit_name ?? entry.toolkit_slug ?? entry.name;
    const selected = matched || named === toolkit || record(named)?.slug === toolkit;
    if (selected && (typeof entry.status === "string" && entry.status.toUpperCase() === "ACTIVE" || entry.connected === true)) connected = true;
    for (const [key, child] of Object.entries(entry)) visit(child, selected || key === toolkit, depth + 1);
  };
  payloads.forEach(payload => visit(payload, false, 0));
  if (connected) return { status: "connected" };
  const url = extractRemoteMcpPending(response, "composio", "COMPOSIO_MANAGE_CONNECTIONS")?.links[0]?.url;
  return url ? { status: "authorization_required", authorizationUrl: url } : { status: "not_connected" };
}
