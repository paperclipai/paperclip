import { z } from "zod";
import {
  TAILSCALE_API_URL,
  TAILSCALE_APP_SLUG,
  TAILSCALE_AUTH_KEY_WRITE_SCOPES,
  TAILSCALE_DEFAULT_AGENT_TAG,
  TAILSCALE_DEFAULT_TAILNET,
  TAILSCALE_DEVICE_READ_SCOPES,
  TAILSCALE_TEST_KEY_EXPIRY_SECONDS,
  tailscaleScopeCovers,
  type TailscaleConnectionHealth,
  type TailscaleHealthCode,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";

/**
 * Tailscale REST boundary. The OAuth client is exchanged for a short-lived
 * API token here and only here; neither the client nor the token nor any
 * minted auth key reaches an agent runtime, the board UI, or a log line.
 *
 * Provider error bodies are `{ "message": string }` and can describe tailnet
 * names, tags, or key identifiers. They are never read into an error; failures
 * carry only the HTTP status, a fixed operation name, and a Paperclip code.
 */
export type TailscaleRequest = (url: string, init: RequestInit) => Promise<Response>;
export type TailscaleOperation = "token" | "list_devices" | "create_key" | "delete_key" | "delete_device";

export class TailscaleApiError extends HttpError {
  constructor(
    status: number,
    message: string,
    readonly code: TailscaleHealthCode,
    readonly operation: TailscaleOperation,
    readonly providerStatus: number | null = null,
    /** An earlier failure that this error supersedes, kept as secondary information. */
    readonly secondary: { code: TailscaleHealthCode; operation: TailscaleOperation; message: string } | null = null,
  ) {
    super(status, message, { code, operation, providerStatus, ...(secondary ? { secondary } : {}) });
  }

  /** Return this error carrying `earlier` as secondary information, with its message appended. */
  withSecondary(earlier: unknown): TailscaleApiError {
    if (!(earlier instanceof TailscaleApiError)) return this;
    return new TailscaleApiError(
      this.status,
      `${this.message} Also: ${earlier.message}`,
      this.code,
      this.operation,
      this.providerStatus,
      { code: earlier.code, operation: earlier.operation, message: earlier.message },
    );
  }
}

export function isTailscaleConnection(connection: { transport: string; config?: Record<string, unknown> }) {
  return connection.transport === "rest_api" && connection.config?.sourceTemplateKey === TAILSCALE_APP_SLUG;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
});
const deviceSchema = z.object({
  id: z.string().optional(),
  nodeId: z.string().optional(),
  name: z.string().optional(),
  hostname: z.string().optional(),
  addresses: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  os: z.string().optional(),
  authorized: z.boolean().optional(),
  connectedToControl: z.boolean().optional(),
  lastSeen: z.string().nullable().optional(),
  isEphemeral: z.boolean().optional(),
  sshEnabled: z.boolean().optional(),
});
export type TailscaleDevice = z.infer<typeof deviceSchema>;
const devicesSchema = z.object({ devices: z.array(deviceSchema).default([]) });
const keySchema = z.object({
  id: z.string().min(1),
  key: z.string().optional(),
  expires: z.string().optional(),
  capabilities: z
    .object({
      devices: z
        .object({
          create: z
            .object({
              reusable: z.boolean().optional(),
              ephemeral: z.boolean().optional(),
              preauthorized: z.boolean().optional(),
              tags: z.array(z.string()).optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
/** The minimum needed to delete a key whose response otherwise failed validation. */
const keyIdSchema = z.object({ id: z.string().min(1) });

export interface TailscaleCreateAuthKeyInput {
  tags: string[];
  reusable: boolean;
  ephemeral: boolean;
  preauthorized: boolean;
  expirySeconds: number;
  description: string;
}
export interface TailscaleAuthKey {
  id: string;
  /** The auth key secret. Present only on creation; never persist it in config, logs, or messages. */
  key: string | null;
  expires: string | null;
  tags: string[];
}

export interface TailscaleApiOptions {
  clientId: string;
  clientSecret: string;
  tailnet?: string;
  request?: TailscaleRequest;
  baseUrl?: string;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function failure(
  operation: TailscaleOperation,
  providerStatus: number,
  context: { tailnet: string; agentTag?: string; scopes: string[] },
): TailscaleApiError {
  const rateLimited = () =>
    new TailscaleApiError(502, "Tailscale is rate limiting this client. Try again in a minute.", "tailscale_rate_limited", operation, providerStatus);
  const clientInvalid = () =>
    new TailscaleApiError(422, "Tailscale rejected the OAuth client ID or secret. Create a new OAuth client in Tailscale and reconnect.", "tailscale_client_invalid", operation, providerStatus);
  const tailnetNotFound = () =>
    new TailscaleApiError(422, `Tailscale could not find tailnet ${context.tailnet} for this OAuth client. Use "-" for the tailnet that owns the client, or enter the tailnet name exactly.`, "tailscale_tailnet_not_found", operation, providerStatus);
  if (providerStatus === 429) return rateLimited();
  switch (operation) {
    case "token":
      if (providerStatus === 400 || providerStatus === 401 || providerStatus === 403) return clientInvalid();
      break;
    case "list_devices":
      if (providerStatus === 401) return clientInvalid();
      if (providerStatus === 403)
        return new TailscaleApiError(422, "The OAuth client cannot list devices. Create a new OAuth client that includes the devices:core scope and reconnect.", "tailscale_scope_devices_missing", operation, providerStatus);
      if (providerStatus === 404) return tailnetNotFound();
      break;
    case "create_key":
      if (providerStatus === 401) return clientInvalid();
      if (providerStatus === 404) return tailnetNotFound();
      if (providerStatus === 400 || providerStatus === 403) {
        if (context.scopes.length && !tailscaleScopeCovers(context.scopes, TAILSCALE_AUTH_KEY_WRITE_SCOPES))
          return new TailscaleApiError(422, "The OAuth client cannot create auth keys. Create a new OAuth client that includes the auth_keys scope and reconnect.", "tailscale_scope_auth_keys_missing", operation, providerStatus);
        return new TailscaleApiError(422, `The OAuth client cannot assign ${context.agentTag ?? TAILSCALE_DEFAULT_AGENT_TAG}. Add that tag to the client's auth_keys scope in Tailscale (and to tagOwners in the tailnet policy), then reconnect.`, "tailscale_tag_not_owned", operation, providerStatus);
      }
      break;
    case "delete_key":
      return new TailscaleApiError(502, `Paperclip minted a test auth key but could not delete it (HTTP ${providerStatus}). The key is ephemeral, single use, and expires in ${Math.round(TAILSCALE_TEST_KEY_EXPIRY_SECONDS / 60)} minutes. Check the OAuth client's auth_keys scope and run the check again.`, "tailscale_test_key_cleanup_failed", operation, providerStatus);
    case "delete_device":
      if (providerStatus === 401) return clientInvalid();
      if (providerStatus === 403)
        return new TailscaleApiError(422, "The OAuth client cannot delete devices. Create a new OAuth client that includes the devices:core scope and reconnect.", "tailscale_scope_devices_missing", operation, providerStatus);
      break;
  }
  return new TailscaleApiError(502, `Tailscale returned HTTP ${providerStatus} during ${operation.replace(/_/g, " ")}.`, "tailscale_request_failed", operation, providerStatus);
}

function unreachable(operation: TailscaleOperation): TailscaleApiError {
  return new TailscaleApiError(502, "Tailscale could not be reached from this Paperclip instance.", "tailscale_unreachable", operation);
}

function malformed(operation: TailscaleOperation): TailscaleApiError {
  return new TailscaleApiError(502, `Tailscale returned an unexpected response during ${operation.replace(/_/g, " ")}.`, "tailscale_request_failed", operation);
}

function truncated(operation: TailscaleOperation): TailscaleApiError {
  return new TailscaleApiError(502, `Tailscale ended the response early during ${operation.replace(/_/g, " ")}. Try again in a minute.`, "tailscale_request_failed", operation);
}

async function readJson(response: Response, operation: TailscaleOperation): Promise<unknown> {
  if (response.status === 204 || !response.body) return null;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw truncated(operation);
  }
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch {
        // A stream that fails mid-body may carry a provider message; normalize it.
        throw truncated(operation);
      }
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_RESPONSE_BYTES) throw malformed(operation);
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(parts).toString("utf8").trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw malformed(operation);
  }
}

export function tailscaleApi(options: TailscaleApiOptions) {
  const baseUrl = (options.baseUrl ?? TAILSCALE_API_URL).replace(/\/+$/, "");
  const tailnet = (options.tailnet?.trim() || TAILSCALE_DEFAULT_TAILNET).trim();
  const tailnetPath = `/tailnet/${encodeURIComponent(tailnet)}`;
  const request: TailscaleRequest = options.request
    ?? ((url, init) => guardedRemoteHttpFetch(url, init, { error: (message, code) => new HttpError(502, message, { code }) }));
  let cached: { token: string; scopes: string[]; expiresAt: number } | null = null;

  async function send(
    operation: TailscaleOperation,
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    context: { agentTag?: string; scopes: string[] },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await request(`${baseUrl}${path}`, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (error instanceof TailscaleApiError) throw error;
      // The caught error may carry a provider URL or header; never forward it.
      throw unreachable(operation);
    }
    if (!response.ok) {
      // Error bodies can name tailnets, tags, or keys. Discard them unread.
      await response.body?.cancel().catch(() => {});
      throw failure(operation, response.status, { tailnet, agentTag: context.agentTag, scopes: context.scopes });
    }
    return readJson(response, operation);
  }

  async function token(): Promise<{ accessToken: string; scopes: string[] }> {
    if (cached && cached.expiresAt > Date.now()) return { accessToken: cached.token, scopes: cached.scopes };
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.clientId,
      client_secret: options.clientSecret,
    }).toString();
    const parsed = tokenSchema.safeParse(
      await send("token", "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      }, { scopes: [] }),
    );
    if (!parsed.success) throw malformed("token");
    const scopes = (parsed.data.scope ?? "").split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
    const ttlMs = Math.max(30, Math.min(parsed.data.expires_in ?? 3600, 3600) - 60) * 1000;
    cached = { token: parsed.data.access_token, scopes, expiresAt: Date.now() + ttlMs };
    return { accessToken: cached.token, scopes };
  }

  async function authorized(operation: TailscaleOperation, path: string, method: string, body?: unknown, agentTag?: string) {
    const { accessToken, scopes } = await token();
    return send(operation, path, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { agentTag, scopes });
  }

  const api = {
    tailnet,
    token,
    async listDevices(): Promise<TailscaleDevice[]> {
      const parsed = devicesSchema.safeParse(await authorized("list_devices", `${tailnetPath}/devices?fields=all`, "GET"));
      if (!parsed.success) throw malformed("list_devices");
      return parsed.data.devices;
    },
    async createAuthKey(input: TailscaleCreateAuthKeyInput): Promise<TailscaleAuthKey> {
      const raw = await authorized("create_key", `${tailnetPath}/keys`, "POST", {
        capabilities: {
          devices: {
            create: {
              reusable: input.reusable,
              ephemeral: input.ephemeral,
              preauthorized: input.preauthorized,
              tags: input.tags,
            },
          },
        },
        expirySeconds: input.expirySeconds,
        description: input.description,
      }, input.tags[0]);
      const parsed = keySchema.safeParse(raw);
      if (!parsed.success) {
        // The key may exist even when the rest of the response is unusable.
        // Delete it when the response carries a usable id, then report the shape.
        const id = keyIdSchema.safeParse(raw);
        if (id.success) {
          try {
            await api.deleteKey(id.data.id);
          } catch (cleanup) {
            throw cleanup instanceof TailscaleApiError ? cleanup.withSecondary(malformed("create_key")) : cleanup;
          }
        }
        throw malformed("create_key");
      }
      return {
        id: parsed.data.id,
        key: parsed.data.key ?? null,
        expires: parsed.data.expires ?? null,
        tags: parsed.data.capabilities?.devices?.create?.tags ?? [],
      };
    },
    async deleteKey(keyId: string): Promise<void> {
      await authorized("delete_key", `${tailnetPath}/keys/${encodeURIComponent(keyId)}`, "DELETE");
    },
    async deleteDevice(deviceId: string): Promise<void> {
      await authorized("delete_device", `/device/${encodeURIComponent(deviceId)}`, "DELETE");
    },
    /**
     * Connection check: token exchange, device list (proves devices:core), then
     * mint and immediately delete a one-off ephemeral tagged key (proves
     * auth_keys and tag ownership). The test key is deleted even when a later
     * validation step fails. A cleanup failure is reported as the primary error
     * because an undeleted key is the operator's next concern; the validation
     * failure it superseded is kept as secondary information.
     */
    async verify(input: { agentTag?: string } = {}): Promise<TailscaleConnectionHealth> {
      const agentTag = input.agentTag?.trim() || TAILSCALE_DEFAULT_AGENT_TAG;
      const { scopes } = await token();
      if (scopes.length && !tailscaleScopeCovers(scopes, TAILSCALE_DEVICE_READ_SCOPES))
        throw failure("list_devices", 403, { tailnet, agentTag, scopes });
      if (scopes.length && !tailscaleScopeCovers(scopes, TAILSCALE_AUTH_KEY_WRITE_SCOPES))
        throw failure("create_key", 403, { tailnet, agentTag, scopes });
      const devices = await api.listDevices();
      const key = await api.createAuthKey({
        tags: [agentTag],
        reusable: false,
        ephemeral: true,
        preauthorized: true,
        expirySeconds: TAILSCALE_TEST_KEY_EXPIRY_SECONDS,
        description: "Paperclip connection check (deleted immediately)",
      });
      const validation: TailscaleApiError | null = key.tags.length && !key.tags.includes(agentTag)
        ? new TailscaleApiError(422, `Tailscale issued the test key without ${agentTag}. Add that tag to the OAuth client's auth_keys scope and reconnect.`, "tailscale_tag_not_owned", "create_key")
        : null;
      try {
        await api.deleteKey(key.id);
      } catch (cleanup) {
        throw cleanup instanceof TailscaleApiError ? cleanup.withSecondary(validation) : cleanup;
      }
      if (validation) throw validation;
      return {
        tailnet,
        scopes,
        tags: [agentTag],
        deviceCount: devices.length,
        checkedAt: new Date().toISOString(),
      };
    },
  };
  return api;
}

export function tailscaleHealthMessage(health: TailscaleConnectionHealth): string {
  const tailnet = health.tailnet === TAILSCALE_DEFAULT_TAILNET ? "the client's tailnet" : `tailnet ${health.tailnet}`;
  const scopes = health.scopes.length ? health.scopes.join(", ") : "not reported";
  return `Tailscale OAuth client is connected to ${tailnet}. Scopes: ${scopes}. Tags: ${health.tags.join(", ")}. Devices visible: ${health.deviceCount}.`;
}
