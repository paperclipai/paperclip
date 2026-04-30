import { useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

type OllamaLicense = {
  license: string;
  licenseUrl?: string;
  summary: string;
  commercialUse: "allowed" | "restricted" | "prohibited" | "unknown";
};

type OllamaModel = {
  name: string;
  size?: number;
  family?: string;
  license: OllamaLicense | null;
  licenseKnown: boolean;
  acknowledged: boolean;
  blocked: boolean;
};

type HealthState = {
  status: "ok" | "degraded" | "error";
  baseUrl: string;
  modelCount: number;
  models: Array<{ name: string; size?: number; family?: string }>;
  latencyMs: number | null;
  checkedAt: string;
  lastError?: string;
};

type TestConnectionResult = {
  ok: boolean;
  status: HealthState["status"];
  latencyMs: number | null;
  modelCount: number;
  baseUrl: string;
  error: string | null;
};

function familyOf(modelName: string): string {
  return modelName.split(":")[0].toLowerCase();
}

function LicenseBadge({ license }: { license: OllamaLicense | null }) {
  if (!license) {
    return (
      <span
        title="Unknown license — adapter MUST NOT be invoked until acknowledged"
        style={{ padding: "2px 6px", borderRadius: 4, background: "#fde68a", color: "#92400e", fontSize: 12 }}
      >
        Unknown license
      </span>
    );
  }
  const color =
    license.commercialUse === "allowed"
      ? { bg: "#d1fae5", fg: "#065f46" }
      : license.commercialUse === "restricted"
      ? { bg: "#fef3c7", fg: "#92400e" }
      : { bg: "#fee2e2", fg: "#991b1b" };
  return (
    <span
      title={license.summary}
      style={{ padding: "2px 6px", borderRadius: 4, background: color.bg, color: color.fg, fontSize: 12 }}
    >
      {license.license}
    </span>
  );
}

export function SettingsPage(_props: PluginSettingsPageProps) {
  const { data: models, loading, error, refresh } = usePluginData<OllamaModel[]>("models");
  const testConnection = usePluginAction("test-connection");
  const acknowledgeLicense = usePluginAction("acknowledge-license");
  const revokeLicense = usePluginAction("revoke-license");
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [pendingFamily, setPendingFamily] = useState<string | null>(null);

  async function runTest() {
    setTesting(true);
    try {
      const result = (await testConnection()) as TestConnectionResult;
      setTestResult(result);
      refresh();
    } catch (err) {
      setTestResult({
        ok: false,
        status: "error",
        latencyMs: null,
        modelCount: 0,
        baseUrl: "",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleAcknowledge(family: string) {
    setPendingFamily(family);
    try {
      await acknowledgeLicense({ family });
      refresh();
    } finally {
      setPendingFamily(null);
    }
  }

  async function handleRevoke(family: string) {
    setPendingFamily(family);
    try {
      await revokeLicense({ family });
      refresh();
    } finally {
      setPendingFamily(null);
    }
  }

  const blockedFamilies = useMemo(() => {
    if (!models) return [];
    const families = new Map<string, OllamaModel>();
    for (const m of models) {
      if (m.blocked) families.set(familyOf(m.name), m);
    }
    return [...families.values()];
  }, [models]);

  return (
    <div style={{ display: "grid", gap: 16, padding: 16, maxWidth: 720 }}>
      <header>
        <h2 style={{ margin: 0 }}>Ollama settings</h2>
        <p style={{ margin: "4px 0 0", color: "#6b7280", fontSize: 14 }}>
          Local Ollama runtime for the <code>ollama_local</code> adapter. Review each model’s license before it can be
          invoked.
        </p>
      </header>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12 }}>
        <strong>Connection</strong>
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" onClick={() => void runTest()} disabled={testing}>
            {testing ? "Testing…" : "Test Connection"}
          </button>
          {testResult ? (
            <span style={{ fontSize: 13 }}>
              {testResult.ok ? "✓" : "✗"} {testResult.status} · {testResult.modelCount} models ·{" "}
              {testResult.latencyMs ?? "?"} ms {testResult.error ? ` · ${testResult.error}` : ""}
            </span>
          ) : null}
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12 }}>
        <strong>Models &amp; licenses</strong>
        {blockedFamilies.length > 0 ? (
          <div
            role="alert"
            style={{
              marginTop: 8,
              padding: 8,
              borderRadius: 6,
              background: "#fef3c7",
              color: "#92400e",
              fontSize: 13,
            }}
          >
            {blockedFamilies.length} model{blockedFamilies.length > 1 ? "s" : ""} are blocked until their license is
            acknowledged. Review each entry below and acknowledge the license to allow adapter invocation.
          </div>
        ) : null}
        {loading ? <div style={{ marginTop: 8 }}>Loading…</div> : null}
        {error ? <div style={{ marginTop: 8, color: "#991b1b" }}>Error: {error.message}</div> : null}
        {models ? (
          <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
            {models.map((m) => {
              const family = familyOf(m.name);
              const busy = pendingFamily === family;
              return (
                <li
                  key={m.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto auto",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 0",
                    borderBottom: "1px solid #f3f4f6",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <code>{m.name}</code>
                    {m.license?.summary ? (
                      <span style={{ color: "#6b7280", fontSize: 12 }}>{m.license.summary}</span>
                    ) : null}
                    {m.blocked ? (
                      <span style={{ color: "#991b1b", fontSize: 12, fontWeight: 500 }}>
                        Blocked — {m.licenseKnown ? "license not acknowledged" : "unknown license"}
                      </span>
                    ) : (
                      <span style={{ color: "#065f46", fontSize: 12 }}>Acknowledged — adapter may invoke</span>
                    )}
                  </div>
                  <LicenseBadge license={m.license} />
                  {m.licenseKnown ? (
                    m.acknowledged ? (
                      <button type="button" onClick={() => void handleRevoke(family)} disabled={busy}>
                        {busy ? "…" : "Revoke"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleAcknowledge(family)}
                        disabled={busy}
                        style={{ background: "#1f2937", color: "#fff", padding: "4px 10px", borderRadius: 4 }}
                      >
                        {busy ? "…" : "Acknowledge"}
                      </button>
                    )
                  ) : (
                    <span style={{ fontSize: 12, color: "#6b7280" }}>Unsupported family</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

type UsageSummary = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  events: number;
  lastEventAt: string | null;
  referenceModel: string;
  inputRatePerMTokUsd: number;
  outputRatePerMTokUsd: number;
  equivalentCostUsd: number;
};

function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data: health, loading, error } = usePluginData<HealthState>("health");
  const { data: usage } = usePluginData<UsageSummary>("usage-summary");
  const refresh = usePluginAction("refresh-health");

  if (loading) return <div>Loading Ollama health…</div>;
  if (error) return <div>Ollama: {error.message}</div>;
  if (!health) return <div>Ollama: no data yet</div>;

  const dot =
    health.status === "ok" ? "#10b981" : health.status === "degraded" ? "#f59e0b" : "#ef4444";

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-label={`status ${health.status}`}
          style={{ width: 10, height: 10, borderRadius: 5, background: dot, display: "inline-block" }}
        />
        <strong>Ollama</strong>
        <span style={{ color: "#6b7280", fontSize: 12 }}>{health.baseUrl}</span>
      </div>
      <div style={{ fontSize: 13 }}>
        {health.modelCount} models · {health.latencyMs ?? "?"} ms · checked{" "}
        {new Date(health.checkedAt).toLocaleTimeString()}
      </div>
      {health.lastError ? (
        <div style={{ color: "#991b1b", fontSize: 12 }}>Last error: {health.lastError}</div>
      ) : null}
      {usage ? (
        <div style={{ fontSize: 12, color: "#374151", borderTop: "1px solid #f3f4f6", paddingTop: 6 }}>
          <div>
            <strong>{formatUsd(usage.equivalentCostUsd)}</strong> equivalent hosted cost
          </div>
          <div style={{ color: "#6b7280" }}>
            {usage.inputTokens.toLocaleString()} in · {usage.outputTokens.toLocaleString()} out · vs{" "}
            <code>{usage.referenceModel}</code>
          </div>
        </div>
      ) : null}
      <button onClick={() => void refresh()}>Refresh</button>
    </div>
  );
}
