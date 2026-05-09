import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { buildCliCommandLabel } from "./command-label.js";
import { resolveDefaultCliAuthPath } from "../config/home.js";

type RequestedAccess = "operator" | "instance_admin_required";

interface OperatorAuthCredential {
  apiBase: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  userId?: string | null;
}

interface OperatorAuthStore {
  version: 1;
  credentials: Record<string, OperatorAuthCredential>;
}

interface CreateChallengeResponse {
  id: string;
  token: string;
  operatorApiToken: string;
  approvalPath: string;
  approvalUrl: string | null;
  pollPath: string;
  expiresAt: string;
  suggestedPollIntervalMs: number;
}

interface ChallengeStatusResponse {
  id: string;
  status: "pending" | "approved" | "cancelled" | "expired";
  command: string;
  clientName: string | null;
  requestedAccess: RequestedAccess;
  requestedCompanyId: string | null;
  requestedCompanyName: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string;
  approvedByUser: { id: string; name: string; email: string } | null;
}

function defaultOperatorAuthStore(): OperatorAuthStore {
  return {
    version: 1,
    credentials: {},
  };
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeApiBase(apiBase: string): string {
  return apiBase.trim().replace(/\/+$/, "");
}

export function resolveOperatorAuthStorePath(overridePath?: string): string {
  if (overridePath?.trim()) return path.resolve(overridePath.trim());
  if (process.env.PAPERCLIP_AUTH_STORE?.trim()) return path.resolve(process.env.PAPERCLIP_AUTH_STORE.trim());
  return resolveDefaultCliAuthPath();
}

export function readOperatorAuthStore(storePath?: string): OperatorAuthStore {
  const filePath = resolveOperatorAuthStorePath(storePath);
  if (!fs.existsSync(filePath)) return defaultOperatorAuthStore();

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<OperatorAuthStore> | null;
  const credentials = raw?.credentials && typeof raw.credentials === "object" ? raw.credentials : {};
  const normalized: Record<string, OperatorAuthCredential> = {};

  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as unknown as Record<string, unknown>;
    const apiBase = toStringOrNull(record.apiBase);
    const token = toStringOrNull(record.token);
    const createdAt = toStringOrNull(record.createdAt);
    const updatedAt = toStringOrNull(record.updatedAt);
    if (!apiBase || !token || !createdAt || !updatedAt) continue;
    normalized[normalizeApiBase(key)] = {
      apiBase,
      token,
      createdAt,
      updatedAt,
      userId: toStringOrNull(record.userId),
    };
  }

  return {
    version: 1,
    credentials: normalized,
  };
}

export function writeOperatorAuthStore(store: OperatorAuthStore, storePath?: string): void {
  const filePath = resolveOperatorAuthStorePath(storePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function getStoredOperatorCredential(apiBase: string, storePath?: string): OperatorAuthCredential | null {
  const store = readOperatorAuthStore(storePath);
  return store.credentials[normalizeApiBase(apiBase)] ?? null;
}

export function setStoredOperatorCredential(input: {
  apiBase: string;
  token: string;
  userId?: string | null;
  storePath?: string;
}): OperatorAuthCredential {
  const normalizedApiBase = normalizeApiBase(input.apiBase);
  const store = readOperatorAuthStore(input.storePath);
  const now = new Date().toISOString();
  const existing = store.credentials[normalizedApiBase];
  const credential: OperatorAuthCredential = {
    apiBase: normalizedApiBase,
    token: input.token.trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    userId: input.userId ?? existing?.userId ?? null,
  };
  store.credentials[normalizedApiBase] = credential;
  writeOperatorAuthStore(store, input.storePath);
  return credential;
}

export function removeStoredOperatorCredential(apiBase: string, storePath?: string): boolean {
  const normalizedApiBase = normalizeApiBase(apiBase);
  const store = readOperatorAuthStore(storePath);
  if (!store.credentials[normalizedApiBase]) return false;
  delete store.credentials[normalizedApiBase];
  writeOperatorAuthStore(store, storePath);
  return true;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export function openUrl(url: string): boolean {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    }
    if (platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    }
    const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function loginOperatorCli(params: {
  apiBase: string;
  requestedAccess: RequestedAccess;
  requestedCompanyId?: string | null;
  clientName?: string | null;
  command?: string;
  storePath?: string;
  print?: boolean;
}): Promise<{ token: string; approvalUrl: string; userId?: string | null }> {
  const apiBase = normalizeApiBase(params.apiBase);
  const createUrl = `${apiBase}/api/cli-auth/challenges`;
  const command = params.command?.trim() || buildCliCommandLabel();

  const challenge = await requestJson<CreateChallengeResponse>(createUrl, {
    method: "POST",
    body: JSON.stringify({
      command,
      clientName: params.clientName?.trim() || "paperclipai cli",
      requestedAccess: params.requestedAccess,
      requestedCompanyId: params.requestedCompanyId?.trim() || null,
    }),
  });

  const approvalUrl = challenge.approvalUrl ?? `${apiBase}${challenge.approvalPath}`;
  if (params.print !== false) {
    console.error(pc.bold("Operator authentication required"));
    console.error(`Open this URL in your browser to approve CLI access:\n${approvalUrl}`);
  }

  const opened = openUrl(approvalUrl);
  if (params.print !== false && opened) {
    console.error(pc.dim("Opened the approval page in your browser."));
  }

  const expiresAtMs = Date.parse(challenge.expiresAt);
  const pollMs = Math.max(500, challenge.suggestedPollIntervalMs || 1000);

  while (Number.isFinite(expiresAtMs) ? Date.now() < expiresAtMs : true) {
    const status = await requestJson<ChallengeStatusResponse>(
      `${apiBase}/api${challenge.pollPath}?token=${encodeURIComponent(challenge.token)}`,
    );

    if (status.status === "approved") {
      const me = await requestJson<{ userId: string; user?: { id: string } | null }>(
        `${apiBase}/api/cli-auth/me`,
        {
          headers: {
            authorization: `Bearer ${challenge.operatorApiToken}`,
          },
        },
      );
      setStoredOperatorCredential({
        apiBase,
        token: challenge.operatorApiToken,
        userId: me.userId ?? me.user?.id ?? null,
        storePath: params.storePath,
      });
      return {
        token: challenge.operatorApiToken,
        approvalUrl,
        userId: me.userId ?? me.user?.id ?? null,
      };
    }

    if (status.status === "cancelled") {
      throw new Error("CLI auth challenge was cancelled.");
    }
    if (status.status === "expired") {
      throw new Error("CLI auth challenge expired before approval.");
    }

    await sleep(pollMs);
  }

  throw new Error("CLI auth challenge expired before approval.");
}

export async function revokeStoredOperatorCredential(params: {
  apiBase: string;
  token: string;
}): Promise<void> {
  const apiBase = normalizeApiBase(params.apiBase);
  await requestJson<{ revoked: boolean }>(`${apiBase}/api/cli-auth/revoke-current`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({}),
  });
}
