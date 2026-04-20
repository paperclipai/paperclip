import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import type { PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { DEFAULT_CONFIG, PLUGIN_ID } from "../constants.js";

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  }).then(async (response) => {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  });
}

function useSettingsConfig() {
  const [configJson, setConfigJson] = useState<Record<string, unknown>>({
    ...DEFAULT_CONFIG,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    hostFetchJson<{ configJson?: Record<string, unknown> | null } | null>(`/api/plugins/${PLUGIN_ID}/config`)
      .then((result) => {
        if (cancelled) return;
        setConfigJson({ ...DEFAULT_CONFIG, ...(result?.configJson ?? {}) });
        setError(null);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(nextConfig: Record<string, unknown>) {
    setSaving(true);
    try {
      await hostFetchJson(`/api/plugins/${PLUGIN_ID}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: nextConfig }),
      });
      setConfigJson(nextConfig);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      throw nextError;
    } finally {
      setSaving(false);
    }
  }

  return { configJson, setConfigJson, loading, saving, error, save };
}

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "6px",
  fontSize: "13px",
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  fontSize: "13px",
  borderRadius: "6px",
  border: "1px solid var(--border-color, #d0d7de)",
  background: "var(--input-bg, #fff)",
  color: "var(--text-color, #1f2328)",
  width: "100%",
  boxSizing: "border-box",
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 600,
  borderRadius: "6px",
  border: "1px solid var(--border-color, #d0d7de)",
  background: "var(--button-bg, #f6f8fa)",
  color: "var(--text-color, #1f2328)",
  cursor: "pointer",
};

export function DokployMcpSettingsPage({ context }: PluginSettingsPageProps) {
  const { configJson, setConfigJson, loading, saving, error, save } = useSettingsConfig();
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  function setField(key: string, value: unknown) {
    setConfigJson((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await save(configJson);
    setSavedMessage("Saved");
    window.setTimeout(() => setSavedMessage(null), 1500);
  }

  if (loading) {
    return <div style={{ fontSize: "12px", opacity: 0.7 }}>Loading plugin config…</div>;
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "18px" }}>
      <div>
        <strong>Dokploy MCP Connection</strong>
        <div style={{ fontSize: "13px", lineHeight: 1.5, marginTop: "6px" }}>
          Configure the URL of your Dokploy MCP server. This plugin communicates with the MCP server over HTTP using
          JSON-RPC 2.0 to provide infrastructure management tools to agents.
        </div>
      </div>

      <label style={labelStyle}>
        <span>Dokploy MCP URL</span>
        <input
          type="url"
          placeholder="http://dokploy-mcp:3001/mcp"
          value={(configJson.dokployMcpUrl as string) ?? ""}
          onChange={(event) => setField("dokployMcpUrl", event.target.value)}
          style={inputStyle}
        />
        <span style={{ fontSize: "11px", opacity: 0.6 }}>
          The HTTP endpoint for the Dokploy MCP server (e.g. http://dokploy-mcp:3001/mcp)
        </span>
      </label>

      {error && (
        <div
          style={{
            color: "var(--danger-color, #cf222e)",
            fontSize: "12px",
            padding: "8px",
            borderRadius: "6px",
            background: "var(--danger-bg, #ffebe9)",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <button type="submit" disabled={saving} style={buttonStyle}>
          {saving ? "Saving…" : "Save"}
        </button>
        {savedMessage && (
          <span style={{ fontSize: "12px", color: "var(--success-color, #1a7f37)" }}>{savedMessage}</span>
        )}
      </div>

      <div style={{ marginTop: "8px" }}>
        <strong>Available Tools</strong>
        <div
          style={{
            fontSize: "12px",
            lineHeight: 1.8,
            marginTop: "6px",
            opacity: 0.8,
          }}
        >
          <div>
            <code>dokploy-get-logs</code> — Retrieve container logs
          </div>
          <div>
            <code>dokploy-list-applications</code> — List all applications
          </div>
          <div>
            <code>dokploy-get-application-status</code> — Get deployment status
          </div>
          <div>
            <code>dokploy-redeploy</code> — Trigger redeployment
          </div>
          <div>
            <code>dokploy-get-application-stats</code> — Resource usage stats
          </div>
        </div>
      </div>
    </form>
  );
}
