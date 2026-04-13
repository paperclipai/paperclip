import { logger } from "./middleware/logger.js";

/**
 * Auto-seed research plugin secrets from environment variables.
 *
 * Reads FRED_API_KEY, TAVILY_API_KEY, and SEC_EDGAR_USER_AGENT from
 * process.env. If present, creates corresponding Paperclip secrets
 * (idempotent — skips if they already exist) and saves the research
 * plugin instance config with the secret refs.
 *
 * Called at startup (may no-op if no companies exist yet) and again
 * after company creation so secrets are available immediately.
 */
export async function autoSeedResearchSecrets() {
  const fredKey = process.env.FRED_API_KEY?.trim();
  const secEdgarAgent = process.env.SEC_EDGAR_USER_AGENT?.trim();
  const alpacaKeyId = process.env.ALPACA_API_KEY_ID?.trim();
  const alpacaSecret = process.env.ALPACA_SECRET_KEY?.trim();

  // Only proceed if at least one key is set
  if (!fredKey && !secEdgarAgent && !alpacaKeyId) return;

  const port = process.env.PAPERCLIP_LISTEN_PORT || process.env.PORT || "3100";
  const baseUrl = `http://127.0.0.1:${port}`;

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) },
    });
    const text = await res.text();
    let body: any;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    return body;
  };

  // Find the research + secrets plugins and a company
  const plugins = await api("/api/plugins") as Array<{ id: string; pluginKey: string; status: string }>;
  const research = plugins.find((p) => p.pluginKey === "paperclip-plugin-research");
  const secrets = plugins.find((p) => p.pluginKey === "lucitra.plugin-secrets");
  if (!research || !secrets) {
    logger.debug("auto-seed research: research or secrets plugin not ready yet");
    return;
  }

  const companies = await api("/api/companies") as Array<{ id: string; name?: string }>;
  if (!companies.length) return;

  // Seed secrets into ALL companies so the UI sees them regardless of
  // which company is active.  Returns the first company's secret IDs
  // for use in plugin config (config is per-plugin, not per-company).
  const secretIdsByName: Record<string, string> = {};

  for (const company of companies) {
    const listResp = await api(`/api/plugins/${secrets.id}/data/list-secrets`, {
      method: "POST",
      body: JSON.stringify({ companyId: company.id, params: { companyId: company.id } }),
    });
    const existingArr = (() => {
      const data = listResp?.data ?? listResp ?? [];
      return Array.isArray(data) ? data : (data.secrets ?? []);
    })() as Array<{ id: string; name: string }>;
    const findExisting = (name: string) => existingArr.find((s) => s?.name === name);

    const createSecret = async (name: string, value: string): Promise<string> => {
      const existing = findExisting(name);
      if (existing) {
        if (!secretIdsByName[name]) secretIdsByName[name] = existing.id;
        return existing.id;
      }
      const resp = await api(`/api/plugins/${secrets.id}/actions/create-secret`, {
        method: "POST",
        body: JSON.stringify({
          companyId: company.id,
          params: { companyId: company.id, name, value, provider: "local_encrypted" },
        }),
      });
      const created = resp?.data ?? resp;
      const id = created?.id ?? created?.secret?.id;
      if (id && !secretIdsByName[name]) secretIdsByName[name] = id;
      return id;
    };

    // Create secrets for this company
    if (alpacaKeyId) await createSecret("market-data-alpaca-key-id", alpacaKeyId);
    if (alpacaSecret) await createSecret("market-data-alpaca-secret", alpacaSecret);
    if (fredKey) await createSecret("research-fred-api-key", fredKey);

    logger.info({ companyId: company.id }, "auto-seed: secrets seeded for company");
  } // end for-each company

  // Build research plugin config using the first company's secret IDs
  const configJson: Record<string, unknown> = {};
  if (secretIdsByName["research-fred-api-key"]) {
    configJson.fredApiKeyRef = secretIdsByName["research-fred-api-key"];
  }
  if (secEdgarAgent) {
    configJson.secEdgarUserAgent = secEdgarAgent;
  }

  // Save research plugin config
  if (Object.keys(configJson).length > 0) {
    await api(`/api/plugins/${research.id}/config`, {
      method: "POST",
      body: JSON.stringify({ configJson }),
    });
    logger.info({ keys: Object.keys(configJson) }, "auto-seed research: config saved");
  }

  // Save market-data plugin config (Alpaca key+secret — Yahoo + Frankfurter need no keys)
  const marketDataConfig: Record<string, unknown> = {};
  if (secretIdsByName["market-data-alpaca-key-id"]) {
    marketDataConfig.alpacaKeyIdRef = secretIdsByName["market-data-alpaca-key-id"];
  }
  if (secretIdsByName["market-data-alpaca-secret"]) {
    marketDataConfig.alpacaSecretRef = secretIdsByName["market-data-alpaca-secret"];
  }
  if (Object.keys(marketDataConfig).length > 0) {
    const marketData = plugins.find((p) => p.pluginKey === "paperclip-plugin-market-data");
    if (marketData) {
      await api(`/api/plugins/${marketData.id}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: marketDataConfig }),
      });
      logger.info({ keys: Object.keys(marketDataConfig) }, "auto-seed market-data: config saved");
    }
  }
}
