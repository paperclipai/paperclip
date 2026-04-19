import { usePluginAction, usePluginData, usePluginToast, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import React, { useCallback, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SyncHealth {
  status: "configured" | "unconfigured";
  lastSync: {
    lastSyncAt: string;
    issueCount: number;
    goalCount: number;
  } | null;
  vaultPath: string;
  gitRemoteUrl: string | null;
  syncEntities: string[];
}

interface SyncResult {
  success: boolean;
  issuesSynced: number;
  goalsSynced: number;
  filesWritten: number;
  gitCommitted: boolean;
  gitPushed: boolean;
  error?: string;
  syncedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Shared styles                                                      */
/* ------------------------------------------------------------------ */

const styles = {
  container: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: "13px",
    lineHeight: "1.5",
    color: "#e0e0e0",
  } as React.CSSProperties,
  card: {
    background: "#1e1e2e",
    borderRadius: "8px",
    padding: "16px",
    border: "1px solid #333",
  } as React.CSSProperties,
  heading: {
    margin: "0 0 12px 0",
    fontSize: "15px",
    fontWeight: 600,
    color: "#fff",
  } as React.CSSProperties,
  label: {
    display: "block",
    fontSize: "12px",
    color: "#888",
    marginBottom: "2px",
  } as React.CSSProperties,
  value: {
    fontSize: "13px",
    color: "#ccc",
  } as React.CSSProperties,
  button: {
    background: "#4c6ef5",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    padding: "6px 14px",
    fontSize: "12px",
    cursor: "pointer",
  } as React.CSSProperties,
  buttonDisabled: {
    background: "#555",
    cursor: "not-allowed",
  } as React.CSSProperties,
  badge: (color: string) =>
    ({
      display: "inline-block",
      fontSize: "11px",
      padding: "2px 8px",
      borderRadius: "4px",
      background: color,
      color: "#fff",
    }) as React.CSSProperties,
  row: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
    marginBottom: "8px",
  } as React.CSSProperties,
};

/* ------------------------------------------------------------------ */
/*  Dashboard Widget                                                   */
/* ------------------------------------------------------------------ */

export function ObsidianDashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error, refresh } = usePluginData<SyncHealth>("sync-health", { companyId: context.companyId });
  const triggerSync = usePluginAction("trigger-sync");
  const toast = usePluginToast();
  const [syncing, setSyncing] = useState(false);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = (await triggerSync({
        companyId: context.companyId,
      })) as SyncResult;
      if (result.success) {
        toast({
          title: `Synced ${result.issuesSynced} issues, ${result.goalsSynced} goals`,
        });
      } else {
        toast({ title: `Sync failed: ${result.error}`, tone: "error" });
      }
      refresh();
    } catch (err) {
      toast({ title: "Sync failed", tone: "error" });
    } finally {
      setSyncing(false);
    }
  }, [triggerSync, context.companyId, toast, refresh]);

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>Loading sync status...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>Error: {error.message}</div>
      </div>
    );
  }

  const statusColor = data?.status === "configured" ? "#2ea043" : "#888";

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h3 style={styles.heading}>Obsidian Vault Sync</h3>

        <div style={styles.row}>
          <span style={styles.badge(statusColor)}>{data?.status ?? "unknown"}</span>
          {data?.syncEntities?.map((e) => (
            <span key={e} style={styles.badge("#4c6ef5")}>
              {e}
            </span>
          ))}
        </div>

        {data?.lastSync ? (
          <div style={{ marginBottom: "8px" }}>
            <span style={styles.label}>Last sync</span>
            <span style={styles.value}>
              {new Date(data.lastSync.lastSyncAt).toLocaleString()} — {data.lastSync.issueCount} issues,{" "}
              {data.lastSync.goalCount} goals
            </span>
          </div>
        ) : (
          <div style={{ marginBottom: "8px", color: "#888" }}>No sync recorded yet.</div>
        )}

        {data?.vaultPath && (
          <div style={{ marginBottom: "8px" }}>
            <span style={styles.label}>Vault</span>
            <span style={styles.value}>{data.vaultPath}</span>
          </div>
        )}

        <button
          style={{
            ...styles.button,
            ...(syncing ? styles.buttonDisabled : {}),
          }}
          disabled={syncing || data?.status !== "configured"}
          onClick={handleSync}
        >
          {syncing ? "Syncing..." : "Sync Now"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Settings Page                                                      */
/* ------------------------------------------------------------------ */

export function ObsidianSettingsPage({ context }: PluginWidgetProps) {
  const { data, loading, refresh } = usePluginData<SyncHealth>("sync-health", {
    companyId: context.companyId,
  });

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>Loading...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h3 style={styles.heading}>Obsidian Vault Sync — Settings</h3>
        <p style={{ color: "#aaa", margin: "0 0 16px 0" }}>
          Configure vault path and sync options using the instance config form above. This page shows the current sync
          status.
        </p>

        <div style={{ marginBottom: "12px" }}>
          <span style={styles.label}>Status</span>
          <span style={styles.badge(data?.status === "configured" ? "#2ea043" : "#888")}>
            {data?.status ?? "unknown"}
          </span>
        </div>

        {data?.vaultPath && (
          <div style={{ marginBottom: "12px" }}>
            <span style={styles.label}>Vault Path</span>
            <span style={styles.value}>{data.vaultPath}</span>
          </div>
        )}

        {data?.gitRemoteUrl && (
          <div style={{ marginBottom: "12px" }}>
            <span style={styles.label}>Git Remote</span>
            <span style={styles.value}>{data.gitRemoteUrl}</span>
          </div>
        )}

        {data?.lastSync && (
          <div style={{ marginBottom: "12px" }}>
            <span style={styles.label}>Last Sync</span>
            <span style={styles.value}>
              {new Date(data.lastSync.lastSyncAt).toLocaleString()} — {data.lastSync.issueCount} issues,{" "}
              {data.lastSync.goalCount} goals
            </span>
          </div>
        )}

        <div style={{ marginBottom: "12px" }}>
          <span style={styles.label}>Sync Entities</span>
          <div style={styles.row}>
            {data?.syncEntities?.map((e) => (
              <span key={e} style={styles.badge("#4c6ef5")}>
                {e}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
