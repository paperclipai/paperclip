import {
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginSettingsPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { useEffect, useMemo, useState } from "react";
import { ACTION_KEYS, DATA_KEYS, DEFAULT_CONFIG, PLUGIN_ID } from "../constants.js";
import type { IssueMemoryStatusData, SetupStatusData } from "../types.js";

const sectionStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  padding: "1rem",
};

const cardStyle: React.CSSProperties = {
  border: "1px solid rgba(148, 163, 184, 0.35)",
  borderRadius: "12px",
  padding: "0.875rem",
  display: "grid",
  gap: "0.5rem",
  background: "rgba(15, 23, 42, 0.02)",
};

const heroStyle: React.CSSProperties = {
  ...cardStyle,
  gap: "0.65rem",
  background: "linear-gradient(135deg, rgba(14, 116, 144, 0.09), rgba(15, 23, 42, 0.03))",
};

const buttonStyle: React.CSSProperties = {
  width: "fit-content",
  border: "1px solid rgba(15, 23, 42, 0.15)",
  borderRadius: "999px",
  padding: "0.45rem 0.8rem",
  background: "white",
  cursor: "pointer",
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#0f172a",
  color: "white",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid rgba(15, 23, 42, 0.12)",
  borderRadius: "10px",
  padding: "0.7rem 0.8rem",
  fontSize: "0.92rem",
  background: "white",
};

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.4rem",
  fontSize: "0.9rem",
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.9rem",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
};

const statusPillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  borderRadius: "999px",
  padding: "0.25rem 0.65rem",
  fontSize: "0.82rem",
  border: "1px solid rgba(15, 23, 42, 0.1)",
  background: "rgba(255, 255, 255, 0.8)",
};

type SettingsConfig = {
  honchoApiBaseUrl: string;
  honchoApiKeySecretRef: string;
  workspacePrefix: string;
  syncIssueComments: boolean;
  syncIssueDocuments: boolean;
  enablePeerChat: boolean;
};

type SettingsConnectionState = {
  ok: boolean;
  workspaceId: string | null;
  at: string | null;
} | null;

type SetupProgressState = {
  settingsSaved: boolean;
  configValidated: boolean;
  connectionSucceeded: boolean;
  backfillCompleted: boolean;
};

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
    return await response.json() as T;
  });
}

function normalizeSettingsConfig(configJson: Record<string, unknown> | null | undefined): SettingsConfig {
  const source = configJson ?? {};
  return {
    honchoApiBaseUrl: typeof source.honchoApiBaseUrl === "string" ? source.honchoApiBaseUrl : DEFAULT_CONFIG.honchoApiBaseUrl,
    honchoApiKeySecretRef: typeof source.honchoApiKeySecretRef === "string" ? source.honchoApiKeySecretRef : DEFAULT_CONFIG.honchoApiKeySecretRef,
    workspacePrefix: typeof source.workspacePrefix === "string" ? source.workspacePrefix : DEFAULT_CONFIG.workspacePrefix,
    syncIssueComments: typeof source.syncIssueComments === "boolean" ? source.syncIssueComments : DEFAULT_CONFIG.syncIssueComments,
    syncIssueDocuments: typeof source.syncIssueDocuments === "boolean" ? source.syncIssueDocuments : DEFAULT_CONFIG.syncIssueDocuments,
    enablePeerChat: typeof source.enablePeerChat === "boolean" ? source.enablePeerChat : DEFAULT_CONFIG.enablePeerChat,
  };
}

function useSettingsConfig() {
  const [configJson, setConfigJson] = useState<SettingsConfig>({ ...DEFAULT_CONFIG });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    hostFetchJson<{ configJson?: Record<string, unknown> | null } | null>(`/api/plugins/${PLUGIN_ID}/config`)
      .then((result) => {
        if (cancelled) return;
        setConfigJson(normalizeSettingsConfig(result?.configJson));
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

  async function save(nextConfig: SettingsConfig) {
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

  async function test(nextConfig: SettingsConfig) {
    return await hostFetchJson<{ valid: boolean; message?: string }>(`/api/plugins/${PLUGIN_ID}/config/test`, {
      method: "POST",
      body: JSON.stringify({ configJson: nextConfig }),
    });
  }

  return {
    configJson,
    setConfigJson,
    loading,
    saving,
    error,
    save,
    test,
  };
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "0.75rem", alignItems: "start" }}>
      <div style={{ fontSize: "0.85rem", color: "#475569" }}>{label}</div>
      <div style={{ fontSize: "0.92rem" }}>{value}</div>
    </div>
  );
}

function ChecklistItem({ item }: { item: SetupStatusData["checklist"][number] }) {
  return (
    <div style={{ ...cardStyle, gap: "0.35rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span style={{
          display: "inline-flex",
          width: "0.7rem",
          height: "0.7rem",
          borderRadius: "999px",
          background: item.done ? "#059669" : "#d97706",
        }}
        />
        <strong style={{ fontSize: "0.95rem" }}>{item.label}</strong>
      </div>
      <div style={{ color: "#475569", fontSize: "0.88rem", lineHeight: 1.45 }}>{item.detail}</div>
    </div>
  );
}

function StatusPill({ label, done }: { label: string; done: boolean }) {
  return (
    <span style={{
      ...statusPillStyle,
      color: done ? "#065f46" : "#92400e",
      borderColor: done ? "rgba(5, 150, 105, 0.25)" : "rgba(217, 119, 6, 0.25)",
      background: done ? "rgba(236, 253, 245, 0.9)" : "rgba(255, 251, 235, 0.95)",
    }}
    >
      <span style={{
        display: "inline-flex",
        width: "0.55rem",
        height: "0.55rem",
        borderRadius: "999px",
        background: done ? "#059669" : "#d97706",
      }}
      />
      {label}
    </span>
  );
}

function SetupSummaryCard({ data }: { data: SetupStatusData }) {
  const companyStatus = data.companyStatus;
  return (
    <div style={cardStyle}>
      <strong>Readiness</strong>
      <Row label="Config valid" value={data.validation.ok ? "Yes" : "No"} />
      <Row label="Workspace prefix" value={data.config.workspacePrefix} />
      <Row label="Sync enabled" value={data.syncEnabled ? "Yes" : "No"} />
      <Row label="Last company backfill" value={companyStatus?.lastBackfillAt ?? "Not run yet"} />
      <Row label="Latest company error" value={companyStatus?.lastError?.message ?? "None"} />
    </div>
  );
}

export function HonchoDashboardWidget({ context }: PluginWidgetProps) {
  const setupStatus = usePluginData<SetupStatusData>(DATA_KEYS.setupStatus, {
    companyId: context.companyId,
  });

  if (setupStatus.loading) {
    return <div style={sectionStyle}>Loading Honcho status…</div>;
  }
  if (setupStatus.error) {
    return <div style={sectionStyle}>Plugin error: {setupStatus.error.message}</div>;
  }
  if (!setupStatus.data) {
    return <div style={sectionStyle}>No Honcho status available.</div>;
  }

  const readyCount = setupStatus.data.checklist.filter((item) => item.done).length;
  return (
    <div style={sectionStyle}>
      <div style={heroStyle}>
        <strong>Honcho Memory</strong>
        <div style={{ color: "#475569", fontSize: "0.9rem" }}>
          {readyCount}/{setupStatus.data.checklist.length} onboarding checks complete for this company.
        </div>
      </div>
      <SetupSummaryCard data={setupStatus.data} />
    </div>
  );
}

export function HonchoSettingsPage({ context }: PluginSettingsPageProps) {
  const { configJson, setConfigJson, loading, saving, error, save, test } = useSettingsConfig();
  const setupStatus = usePluginData<SetupStatusData>(DATA_KEYS.setupStatus, {
    companyId: context.companyId,
  });
  const testConnection = usePluginAction(ACTION_KEYS.testConnection);
  const backfillCompany = usePluginAction(ACTION_KEYS.backfillCompany);
  const [formMessage, setFormMessage] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [connectionState, setConnectionState] = useState<SettingsConnectionState>(null);
  const [busyAction, setBusyAction] = useState<"initialize" | "test" | "backfill" | null>(null);
  const [setupProgress, setSetupProgress] = useState<SetupProgressState>({
    settingsSaved: false,
    configValidated: false,
    connectionSucceeded: false,
    backfillCompleted: false,
  });

  const nextSteps = useMemo(() => {
    return setupStatus.data?.checklist.filter((item) => !item.done).map((item) => item.label) ?? [];
  }, [setupStatus.data]);

  if (loading) {
    return <div style={sectionStyle}>Loading Honcho settings…</div>;
  }

  async function saveSettings() {
    try {
      await save(configJson);
      setSetupProgress((current) => ({ ...current, settingsSaved: true }));
      setFormMessage({ tone: "success", text: "Settings saved." });
      setupStatus.refresh();
    } catch (nextError) {
      setFormMessage({ tone: "error", text: nextError instanceof Error ? nextError.message : String(nextError) });
    }
  }

  async function validateSettings() {
    try {
      const result = await test(configJson);
      setSetupProgress((current) => ({ ...current, configValidated: Boolean(result.valid) }));
      setFormMessage({
        tone: result.valid ? "success" : "error",
        text: result.message ?? (result.valid ? "Configuration is valid." : "Configuration is invalid."),
      });
    } catch (nextError) {
      setFormMessage({ tone: "error", text: nextError instanceof Error ? nextError.message : String(nextError) });
    }
  }

  async function runConnectionTest() {
    setBusyAction("test");
    try {
      const result = await testConnection();
      setSetupProgress((current) => ({ ...current, connectionSucceeded: Boolean((result as Record<string, unknown>).ok) }));
      setConnectionState({
        ok: Boolean((result as Record<string, unknown>).ok),
        workspaceId: typeof (result as Record<string, unknown>).workspaceId === "string" ? (result as Record<string, unknown>).workspaceId as string : null,
        at: typeof (result as Record<string, unknown>).at === "string" ? (result as Record<string, unknown>).at as string : null,
      });
      setFormMessage({ tone: "success", text: "Honcho connection succeeded." });
    } catch (nextError) {
      setSetupProgress((current) => ({ ...current, connectionSucceeded: false }));
      setConnectionState({ ok: false, workspaceId: null, at: null });
      setFormMessage({ tone: "error", text: nextError instanceof Error ? nextError.message : String(nextError) });
    } finally {
      setBusyAction(null);
    }
  }

  async function runBackfill() {
    if (!context.companyId) {
      setFormMessage({ tone: "error", text: "Select a company before running backfill." });
      return;
    }
    setBusyAction("backfill");
    try {
      await backfillCompany({ companyId: context.companyId });
      setSetupProgress((current) => ({ ...current, backfillCompleted: true }));
      setFormMessage({ tone: "success", text: "Backfill started and completed for the current company." });
      setupStatus.refresh();
    } catch (nextError) {
      setSetupProgress((current) => ({ ...current, backfillCompleted: false }));
      setFormMessage({ tone: "error", text: nextError instanceof Error ? nextError.message : String(nextError) });
    } finally {
      setBusyAction(null);
    }
  }

  async function saveAndInitialize() {
    if (!context.companyId) {
      setFormMessage({ tone: "error", text: "Select a company before running setup." });
      return;
    }
    setBusyAction("initialize");
    try {
      await save(configJson);
      const validation = await test(configJson);
      if (!validation.valid) {
        setSetupProgress((current) => ({
          ...current,
          settingsSaved: true,
          configValidated: false,
          connectionSucceeded: false,
          backfillCompleted: false,
        }));
        setFormMessage({
          tone: "error",
          text: validation.message ?? "Configuration is invalid.",
        });
        return;
      }

      const connection = await testConnection();
      await backfillCompany({ companyId: context.companyId });

      setSetupProgress({
        settingsSaved: true,
        configValidated: true,
        connectionSucceeded: Boolean((connection as Record<string, unknown>).ok),
        backfillCompleted: true,
      });
      setConnectionState({
        ok: Boolean((connection as Record<string, unknown>).ok),
        workspaceId: typeof (connection as Record<string, unknown>).workspaceId === "string"
          ? (connection as Record<string, unknown>).workspaceId as string
          : null,
        at: typeof (connection as Record<string, unknown>).at === "string"
          ? (connection as Record<string, unknown>).at as string
          : null,
      });
      setFormMessage({ tone: "success", text: "Honcho setup completed for the current company." });
      setupStatus.refresh();
    } catch (nextError) {
      setFormMessage({ tone: "error", text: nextError instanceof Error ? nextError.message : String(nextError) });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div style={sectionStyle}>
      <div style={heroStyle}>
        <strong>Honcho Setup</strong>
        <div style={{ color: "#475569", fontSize: "0.92rem", lineHeight: 1.45 }}>
          Configure the Honcho API connection, validate the plugin configuration, and run an initial company backfill without leaving Paperclip.
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <StatusPill label="Settings saved" done={setupProgress.settingsSaved} />
          <StatusPill label="Config valid" done={setupProgress.configValidated} />
          <StatusPill label="Connection ready" done={setupProgress.connectionSucceeded} />
          <StatusPill label="Backfill complete" done={setupProgress.backfillCompleted || Boolean(setupStatus.data?.companyStatus?.lastBackfillAt)} />
        </div>
      </div>

      <div style={gridStyle}>
        <div style={cardStyle}>
          <label style={labelStyle}>
            <span>Honcho API base URL</span>
            <input
              style={inputStyle}
              value={configJson.honchoApiBaseUrl}
              onChange={(event) => setConfigJson((current) => ({ ...current, honchoApiBaseUrl: event.target.value }))}
              placeholder="https://api.honcho.dev"
            />
          </label>
          <label style={labelStyle}>
            <span>Honcho API key secret reference</span>
            <input
              style={inputStyle}
              value={configJson.honchoApiKeySecretRef}
              onChange={(event) => setConfigJson((current) => ({ ...current, honchoApiKeySecretRef: event.target.value }))}
              placeholder="HONCHO_API_KEY"
            />
          </label>
          <label style={labelStyle}>
            <span>Workspace prefix</span>
            <input
              style={inputStyle}
              value={configJson.workspacePrefix}
              onChange={(event) => setConfigJson((current) => ({ ...current, workspacePrefix: event.target.value }))}
              placeholder="paperclip"
            />
          </label>
        </div>

        <div style={cardStyle}>
          <label style={{ ...labelStyle, gridAutoFlow: "column", justifyContent: "start", alignItems: "center", gap: "0.6rem" }}>
            <input
              type="checkbox"
              checked={configJson.syncIssueComments}
              onChange={(event) => setConfigJson((current) => ({ ...current, syncIssueComments: event.target.checked }))}
            />
            <span>Sync issue comments</span>
          </label>
          <label style={{ ...labelStyle, gridAutoFlow: "column", justifyContent: "start", alignItems: "center", gap: "0.6rem" }}>
            <input
              type="checkbox"
              checked={configJson.syncIssueDocuments}
              onChange={(event) => setConfigJson((current) => ({ ...current, syncIssueDocuments: event.target.checked }))}
            />
            <span>Sync issue documents</span>
          </label>
          <label style={{ ...labelStyle, gridAutoFlow: "column", justifyContent: "start", alignItems: "center", gap: "0.6rem" }}>
            <input
              type="checkbox"
              checked={configJson.enablePeerChat}
              onChange={(event) => setConfigJson((current) => ({ ...current, enablePeerChat: event.target.checked }))}
            />
            <span>Enable peer chat tool</span>
          </label>
          <div style={{ color: "#475569", fontSize: "0.86rem", lineHeight: 1.45 }}>
            Comments-only sync is the safest starting point. Enable document sync after the connection is validated.
          </div>
        </div>
      </div>

      {formMessage ? (
        <div style={{
          ...cardStyle,
          borderColor: formMessage.tone === "error" ? "rgba(153, 27, 27, 0.35)" : formMessage.tone === "success" ? "rgba(5, 150, 105, 0.35)" : "rgba(14, 116, 144, 0.35)",
          color: formMessage.tone === "error" ? "#991b1b" : "#0f172a",
        }}
        >
          {formMessage.text}
        </div>
      ) : null}

      {error ? <div style={{ ...cardStyle, color: "#991b1b" }}>Config error: {error}</div> : null}

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => void saveAndInitialize()}
          disabled={busyAction === "initialize" || saving}
        >
          {busyAction === "initialize" ? "Initializing…" : "Save And Initialize"}
        </button>
        <button type="button" style={primaryButtonStyle} onClick={() => void saveSettings()} disabled={saving}>
          {saving ? "Saving…" : "Save Settings"}
        </button>
        <button type="button" style={buttonStyle} onClick={() => void validateSettings()}>
          Validate Config
        </button>
        <button type="button" style={buttonStyle} onClick={() => void runConnectionTest()} disabled={busyAction === "test"}>
          {busyAction === "test" ? "Testing…" : "Test Connection"}
        </button>
        <button type="button" style={buttonStyle} onClick={() => void runBackfill()} disabled={busyAction === "backfill"}>
          {busyAction === "backfill" ? "Backfilling…" : "Backfill Current Company"}
        </button>
      </div>

      {connectionState ? (
        <div style={cardStyle}>
          <strong>Connection Result</strong>
          <Row label="Status" value={connectionState.ok ? "Connected" : "Failed"} />
          <Row label="Workspace returned" value={connectionState.workspaceId ?? "None"} />
          <Row label="Checked at" value={connectionState.at ?? "Unknown"} />
        </div>
      ) : null}

      {setupStatus.loading ? (
        <div style={cardStyle}>Loading readiness status…</div>
      ) : setupStatus.error ? (
        <div style={{ ...cardStyle, color: "#991b1b" }}>Setup status error: {setupStatus.error.message}</div>
      ) : setupStatus.data ? (
        <>
          <SetupSummaryCard data={setupStatus.data} />
          <div style={gridStyle}>
            {setupStatus.data.checklist.map((item) => <ChecklistItem key={item.key} item={item} />)}
          </div>
        </>
      ) : null}

      <div style={cardStyle}>
        <strong>Suggested Setup Order</strong>
        <ol style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.35rem", color: "#475569" }}>
          <li>Create a Paperclip secret containing the Honcho API key.</li>
          <li>Either use Save And Initialize, or run Save Settings, Validate Config, Test Connection, and Backfill Current Company manually.</li>
          <li>Confirm the readiness checklist shows the company as backfilled.</li>
        </ol>
        {nextSteps.length > 0 ? (
          <div style={{ fontSize: "0.86rem", color: "#475569" }}>
            Remaining setup items: {nextSteps.join(", ")}.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function HonchoIssueMemoryTab({ context }: PluginDetailTabProps) {
  const status = usePluginData<IssueMemoryStatusData>(DATA_KEYS.issueStatus, {
    issueId: context.entityId,
    companyId: context.companyId,
  });
  const resyncIssue = usePluginAction(ACTION_KEYS.resyncIssue);
  const testConnection = usePluginAction(ACTION_KEYS.testConnection);

  if (status.loading) {
    return <div style={sectionStyle}>Loading memory status…</div>;
  }

  if (status.error) {
    return <div style={sectionStyle}>Plugin error: {status.error.message}</div>;
  }

  const data = status.data;
  if (!data) {
    return <div style={sectionStyle}>No memory status available.</div>;
  }

  return (
    <div style={sectionStyle}>
      <div style={cardStyle}>
        <strong>Honcho Memory</strong>
        <div style={{ color: "#475569", fontSize: "0.9rem" }}>
          Sync status and memory preview for this issue.
        </div>
      </div>

      <div style={cardStyle}>
        <Row label="Issue" value={data.issueIdentifier ?? data.issueId} />
        <Row label="Sync enabled" value={data.syncEnabled ? "Yes" : "No"} />
        <Row label="Last synced comment" value={data.lastSyncedCommentId ?? "Not synced yet"} />
        <Row label="Last synced at" value={data.lastSyncedCommentCreatedAt ?? "Never"} />
        <Row label="Last append" value={data.latestAppendAt ?? "Never"} />
        <Row label="Replay requested" value={data.replayRequestedAt ?? "No"} />
        <Row label="Replay in progress" value={data.replayInProgress ? "Yes" : "No"} />
        <Row
          label="Document sync"
          value={
            data.config.syncIssueDocuments
              ? `Enabled (${data.lastSyncedDocumentRevisionKey ?? "no revision synced"})`
              : "Disabled"
          }
        />
        <Row
          label="Peer chat tool"
          value={data.config.enablePeerChat ? "Enabled" : "Disabled"}
        />
      </div>

      <div style={cardStyle}>
        <strong>Context Preview</strong>
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
          {data.contextPreview ?? "No Honcho context fetched yet."}
        </div>
        <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
          Preview refreshed: {data.contextFetchedAt ?? "Never"}
        </div>
      </div>

      <div style={cardStyle}>
        <strong>Latest Error</strong>
        <div style={{ color: data.lastError ? "#991b1b" : "#64748b", whiteSpace: "pre-wrap" }}>
          {data.lastError
            ? `${data.lastError.message}${data.lastError.at ? `\n${data.lastError.at}` : ""}`
            : "No sync errors recorded."}
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            if (!context.companyId) return;
            void resyncIssue({ issueId: context.entityId, companyId: context.companyId }).catch(console.error);
          }}
        >
          Resync Issue
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            void testConnection().catch(console.error);
          }}
        >
          Test Connection
        </button>
      </div>
    </div>
  );
}
