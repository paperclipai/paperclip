import type { CSSProperties } from "react";
import { useState, useMemo } from "react";
import {
  usePluginData,
  usePluginAction,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";
import type {
  PluginPageProps,
  PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { DATA_KEYS, ACTION_KEYS } from "../constants.js";

interface DirectoryEntry {
  name: string;
  packageName: string;
  description: string;
  author: string;
  category: string;
  source?: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  example: "#6366f1",
  notifications: "#f59e0b",
  monitoring: "#10b981",
  integrations: "#3b82f6",
  utilities: "#8b5cf6",
  workspace: "#ec4899",
  automation: "#14b8a6",
  connector: "#f97316",
};

const styles = {
  container: {
    padding: "24px",
    maxWidth: "960px",
    margin: "0 auto",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  title: { fontSize: "20px", fontWeight: 600, margin: "0 0 4px 0" },
  subtitle: { fontSize: "13px", opacity: 0.6, margin: "0 0 24px 0" },
  searchInput: {
    width: "100%",
    padding: "8px 12px",
    fontSize: "14px",
    border: "1px solid rgba(128, 128, 128, 0.3)",
    borderRadius: "6px",
    background: "transparent",
    color: "inherit",
    outline: "none",
    marginBottom: "16px",
    boxSizing: "border-box" as const,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "12px",
  },
  card: {
    border: "1px solid rgba(128, 128, 128, 0.2)",
    borderRadius: "8px",
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  pluginName: { fontSize: "15px", fontWeight: 600, margin: 0 },
  description: {
    fontSize: "13px",
    opacity: 0.7,
    margin: 0,
    lineHeight: 1.4,
  },
  cardFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: "auto",
    paddingTop: "8px",
  },
  author: { fontSize: "12px", opacity: 0.5 },
  installButton: {
    fontSize: "13px",
    padding: "6px 14px",
    borderRadius: "6px",
    border: "none",
    background: "#6366f1",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 500,
  },
  disabledButton: {
    fontSize: "13px",
    padding: "6px 14px",
    borderRadius: "6px",
    border: "none",
    background: "rgba(128, 128, 128, 0.2)",
    color: "rgba(128, 128, 128, 0.5)",
    cursor: "not-allowed",
    fontWeight: 500,
  },
  installedBadge: {
    fontSize: "12px",
    padding: "4px 10px",
    borderRadius: "6px",
    background: "rgba(16, 185, 129, 0.15)",
    color: "#10b981",
    fontWeight: 500,
  },
  sourceLink: {
    fontSize: "12px",
    opacity: 0.5,
    textDecoration: "none",
    color: "inherit",
  },
  empty: {
    textAlign: "center" as const,
    padding: "48px 0",
    opacity: 0.5,
    fontSize: "14px",
  },
} satisfies Record<string, CSSProperties>;

function categoryBadge(color: string): CSSProperties {
  return {
    fontSize: "11px",
    padding: "2px 8px",
    borderRadius: "12px",
    background: color + "20",
    color,
    fontWeight: 500,
    whiteSpace: "nowrap",
  };
}

function PluginCard({
  entry,
  isInstalled,
  installing,
  onInstall,
}: {
  entry: DirectoryEntry;
  isInstalled: boolean;
  installing: boolean;
  onInstall: (pkg: string) => void;
}) {
  const color = CATEGORY_COLORS[entry.category] ?? "#6b7280";
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <h3 style={styles.pluginName}>{entry.name}</h3>
        {entry.category && (
          <span style={categoryBadge(color)}>{entry.category}</span>
        )}
      </div>
      <p style={styles.description}>{entry.description}</p>
      <div style={styles.cardFooter}>
        <span style={styles.author}>by {entry.author}</span>
        {isInstalled ? (
          <span style={styles.installedBadge}>Installed</span>
        ) : (
          <button
            style={installing ? styles.disabledButton : styles.installButton}
            disabled={installing}
            onClick={() => onInstall(entry.packageName)}
          >
            {installing ? "Installing..." : "Install"}
          </button>
        )}
      </div>
      {entry.source && (
        <a
          href={entry.source}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.sourceLink}
        >
          View source
        </a>
      )}
    </div>
  );
}

export function PluginDirectoryPage({ context }: PluginPageProps) {
  const directoryQuery = usePluginData<DirectoryEntry[]>(DATA_KEYS.directory);
  const installAction = usePluginAction(ACTION_KEYS.install);
  const toast = usePluginToast();
  const [search, setSearch] = useState("");
  const [installingPkg, setInstallingPkg] = useState<string | null>(null);
  const [justInstalled, setJustInstalled] = useState<string[]>([]);

  const entries = directoryQuery.data ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.category?.toLowerCase().includes(q) ||
        e.author?.toLowerCase().includes(q)
    );
  }, [entries, search]);

  async function handleInstall(packageName: string) {
    setInstallingPkg(packageName);
    try {
      await installAction({ packageName });
      setJustInstalled((prev) => [...prev, packageName]);
      toast({ title: `Installed ${packageName}`, tone: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: "Install failed", body: msg, tone: "error" });
    } finally {
      setInstallingPkg(null);
    }
  }

  if (directoryQuery.loading) {
    return (
      <div style={styles.container}>
        <p>Loading directory...</p>
      </div>
    );
  }

  if (directoryQuery.error) {
    return (
      <div style={styles.container}>
        <p>Failed to load directory: {directoryQuery.error.message}</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Plugin Directory</h2>
      <p style={styles.subtitle}>
        {entries.length} plugins available. Install plugins to extend Paperclip.
      </p>
      <input
        type="text"
        placeholder="Search plugins..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={styles.searchInput}
      />
      {filtered.length === 0 ? (
        <div style={styles.empty}>
          {search
            ? `No plugins matching "${search}"`
            : "No plugins in the directory yet."}
        </div>
      ) : (
        <div style={styles.grid}>
          {filtered.map((entry) => (
            <PluginCard
              key={entry.packageName}
              entry={entry}
              isInstalled={justInstalled.includes(entry.packageName)}
              installing={installingPkg === entry.packageName}
              onInstall={handleInstall}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function PluginDirectorySidebarLink({ context }: PluginSidebarProps) {
  return <span>Plugin Directory</span>;
}
