const DEFAULT_COMPOSIO_API_BASE_URL = "https://backend.composio.dev/api/v3.1";

export class ComposioApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ComposioApiError";
  }
}

export type ComposioPage<T> = {
  items: T[];
  next_cursor?: string | null;
  total_pages?: number;
  current_page?: number;
  total_items?: number;
};

export type ComposioToolkit = {
  slug: string;
  name: string;
  type?: string;
  auth_schemes?: string[];
  composio_managed_auth_schemes?: string[];
  no_auth?: boolean;
  auth_guide_url?: string | null;
  meta?: {
    description?: string | null;
    logo?: string | null;
    app_url?: string | null;
    tools_count?: number;
    triggers_count?: number;
    version?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type ComposioAuthConfig = {
  id: string;
  uuid?: string;
  name?: string;
  auth_scheme: string;
  is_composio_managed: boolean;
  status?: string;
  toolkit: { slug: string; logo?: string | null; auth_guide_url?: string | null; auth_hint_url?: string | null };
  [key: string]: unknown;
};

export type ComposioConnectLink = {
  link_token: string;
  redirect_url: string;
  expires_at: string;
  connected_account_id?: string | null;
  [key: string]: unknown;
};

export type ComposioConnectedAccount = {
  id: string;
  user_id: string;
  status: string;
  status_reason?: string | null;
  is_disabled?: boolean;
  toolkit: { slug: string };
  auth_config: { id: string; auth_scheme: string; is_composio_managed: boolean; is_disabled?: boolean };
  [key: string]: unknown;
};

export type ComposioSession = {
  session_id: string;
  mcp: { type?: string; url: string; headers?: Record<string, string> };
  config?: Record<string, unknown>;
  config_version?: number;
  warnings?: Array<{ code: string; message: string }>;
  [key: string]: unknown;
};

export type ComposioListOptions = { cursor?: string; limit?: number };
export type ComposioSessionOptions = {
  mcp: true;
  toolkits?: string[];
  tools?: Record<string, { enable: string[] }>;
  authConfigs?: Record<string, string>;
  connectedAccounts?: Record<string, string[]>;
};

export interface ComposioClient {
  validateApiKey(): Promise<void>;
  listToolkits(options?: ComposioListOptions): Promise<ComposioPage<ComposioToolkit>>;
  listAuthConfigs(options?: ComposioListOptions & { toolkitSlugs?: string[]; showDisabled?: boolean }): Promise<ComposioPage<ComposioAuthConfig>>;
  createConnectLink(input: { authConfigId: string; userId: string; alias?: string; callbackUrl?: string }): Promise<ComposioConnectLink>;
  listConnectedAccounts(options?: ComposioListOptions & { toolkitSlugs?: string[]; statuses?: string[]; userIds?: string[]; authConfigIds?: string[] }): Promise<ComposioPage<ComposioConnectedAccount>>;
  createSession(userId: string, options: ComposioSessionOptions): Promise<ComposioSession>;
  resumeSession(sessionId: string, options: { mcp: true }): Promise<ComposioSession>;
}

type ComposioClientOptions = { apiKey: string; baseUrl?: string; fetch?: typeof globalThis.fetch };

function appendQuery(url: URL, key: string, value: string | number | boolean | undefined) {
  if (value !== undefined) url.searchParams.append(key, String(value));
}

function appendQueryList(url: URL, key: string, values: string[] | undefined) {
  for (const value of values ?? []) url.searchParams.append(key, value);
}

function errorMessage(status: number): string {
  if (status === 401 || status === 403) return "Composio rejected the API key.";
  if (status === 429) return "Composio rate-limited the request. Try again shortly.";
  return `Composio request failed with HTTP ${status}.`;
}

export function createComposioClient(options: ComposioClientOptions): ComposioClient {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("A Composio API key is required.");
  const baseUrl = (options.baseUrl ?? DEFAULT_COMPOSIO_API_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function request<T>(path: string, init: RequestInit = {}, query?: (url: URL) => void): Promise<T> {
    const url = new URL(`${baseUrl}/${path.replace(/^\/+/, "")}`);
    query?.(url);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          accept: "application/json",
          "x-api-key": apiKey,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new ComposioApiError("Could not reach Composio.", 0);
    }
    if (!response.ok) throw new ComposioApiError(errorMessage(response.status), response.status);
    try {
      return await response.json() as T;
    } catch {
      throw new ComposioApiError("Composio returned an invalid response.", response.status);
    }
  }

  return {
    async validateApiKey() {
      await this.listToolkits({ limit: 1 });
    },
    listToolkits(options = {}) {
      return request<ComposioPage<ComposioToolkit>>("toolkits", {}, (url) => {
        appendQuery(url, "cursor", options.cursor);
        appendQuery(url, "limit", options.limit);
      });
    },
    listAuthConfigs(options = {}) {
      return request<ComposioPage<ComposioAuthConfig>>("auth_configs", {}, (url) => {
        appendQuery(url, "cursor", options.cursor);
        appendQuery(url, "limit", options.limit);
        appendQuery(url, "show_disabled", options.showDisabled);
        appendQuery(url, "toolkit_slug", options.toolkitSlugs?.join(","));
      });
    },
    createConnectLink(input) {
      return request<ComposioConnectLink>("connected_accounts/link", {
        method: "POST",
        body: JSON.stringify({
          auth_config_id: input.authConfigId,
          user_id: input.userId,
          ...(input.alias ? { alias: input.alias } : {}),
          ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
        }),
      });
    },
    listConnectedAccounts(options = {}) {
      return request<ComposioPage<ComposioConnectedAccount>>("connected_accounts", {}, (url) => {
        appendQuery(url, "cursor", options.cursor);
        appendQuery(url, "limit", options.limit);
        appendQueryList(url, "toolkit_slugs", options.toolkitSlugs);
        appendQueryList(url, "statuses", options.statuses);
        appendQueryList(url, "user_ids", options.userIds);
        appendQueryList(url, "auth_config_ids", options.authConfigIds);
      });
    },
    createSession(userId, options) {
      return request<ComposioSession>("tool_router/session", {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          ...(options.toolkits ? { toolkits: { enabled: options.toolkits } } : {}),
          ...(options.tools ? { tools: options.tools } : {}),
          ...(options.authConfigs ? { auth_configs: options.authConfigs } : {}),
          ...(options.connectedAccounts ? { connected_accounts: options.connectedAccounts } : {}),
        }),
      });
    },
    resumeSession(sessionId, _options) {
      return request<ComposioSession>(`tool_router/session/${encodeURIComponent(sessionId)}/attach`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
  };
}
