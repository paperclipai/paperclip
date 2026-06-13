import React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Types (mirrored from worker for UI use)
// ---------------------------------------------------------------------------

type SurfaceName = "meta" | "nav" | "hero" | "main" | "cta" | "footer" | "embeds";
type SurfaceStatus = "translated" | "partial" | "still_english" | "empty";

type SurfaceResult = {
  surface: SurfaceName;
  english_likelihood: number;
  status: SurfaceStatus;
  evidence: string[];
};

type PageResult = {
  locale: string;
  path: string;
  weightedScore: number;
  still_english_flag: boolean;
  langAttr: string | null;
  surfaces: SurfaceResult[];
  scannedAt: string;
};

type LocaleSummary = {
  locale: string;
  pageCount: number;
  flaggedCount: number;
  averageScore: number;
  minScore: number;
};

type ParityReport = {
  scannedAt: string | null;
  pages: PageResult[];
  summary: LocaleSummary[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreColor(score: number): string {
  if (score >= 0.8) return "#34c759";
  if (score >= 0.5) return "#ff9500";
  return "#ff3b30";
}

function scoreBar(score: number): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          height: 8,
          width: 80,
          background: "#e5e5ea",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.round(score * 100)}%`,
            background: scoreColor(score),
            borderRadius: 4,
          }}
        />
      </div>
      <span style={{ fontSize: 12, color: "#3c3c43" }}>{Math.round(score * 100)}%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function I18nParitySidebar(): React.ReactElement {
  const { data, loading, error } = usePluginData<ParityReport>("i18n-parity-report");

  if (loading) return <div style={styles.sidebar}>Loading…</div>;
  if (error) return <div style={styles.sidebar}>Error: {String(error)}</div>;
  if (!data || !data.scannedAt) {
    return (
      <div style={styles.sidebar}>
        <p style={styles.sidebarHint}>No scan data yet.</p>
        <p style={styles.sidebarHint}>Run the <strong>run-scan</strong> tool to populate.</p>
      </div>
    );
  }

  const flagged = data.summary.filter((s) => s.flaggedCount > 0);
  return (
    <div style={styles.sidebar}>
      <div style={styles.sidebarTitle}>i18n Parity</div>
      <div style={styles.sidebarMeta}>Last scan: {new Date(data.scannedAt).toLocaleDateString()}</div>
      {data.summary.map((s) => (
        <div key={s.locale} style={styles.sidebarRow}>
          <span style={styles.sidebarLocale}>{s.locale}</span>
          {scoreBar(s.averageScore)}
          {s.flaggedCount > 0 && (
            <span style={styles.badge}>{s.flaggedCount}</span>
          )}
        </div>
      ))}
      {flagged.length === 0 && (
        <p style={{ ...styles.sidebarHint, color: "#34c759" }}>All locales above threshold ✓</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full page report
// ---------------------------------------------------------------------------

export function I18nParityPage(): React.ReactElement {
  const { data, loading, error } = usePluginData<ParityReport>("i18n-parity-report");
  const [selectedLocale, setSelectedLocale] = React.useState<string | null>(null);

  if (loading) return <div style={styles.page}>Loading…</div>;
  if (error) return <div style={styles.page}>Error: {String(error)}</div>;
  if (!data || !data.scannedAt) {
    return (
      <div style={styles.page}>
        <h2 style={styles.pageTitle}>i18n Parity Report</h2>
        <p>No scan data available. Run the <code>run-scan</code> tool first.</p>
      </div>
    );
  }

  const localeList = data.summary.map((s) => s.locale);
  const activeSummary = data.summary.find((s) => s.locale === selectedLocale) ?? data.summary[0];
  const activeLocale = activeSummary?.locale ?? null;
  const activePages = data.pages.filter((p) => p.locale === activeLocale);

  return (
    <div style={styles.page}>
      <h2 style={styles.pageTitle}>i18n Parity Report</h2>
      <p style={styles.pageMeta}>
        Scanned {data.pages.length} pages across {data.summary.length} locale(s) ·{" "}
        {new Date(data.scannedAt).toLocaleString()}
      </p>

      {/* Locale selector */}
      <div style={styles.localeTabs}>
        {localeList.map((locale) => {
          const sum = data.summary.find((s) => s.locale === locale)!;
          return (
            <button
              key={locale}
              onClick={() => setSelectedLocale(locale)}
              style={{
                ...styles.localeTab,
                ...(locale === (selectedLocale ?? localeList[0])
                  ? styles.localeTabActive
                  : {}),
              }}
            >
              {locale}
              {sum.flaggedCount > 0 && (
                <span style={styles.tabBadge}>{sum.flaggedCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Summary for active locale */}
      {activeSummary && (
        <div style={styles.summaryCard}>
          <div style={styles.summaryRow}>
            <span>Average score</span>
            {scoreBar(activeSummary.averageScore)}
          </div>
          <div style={styles.summaryRow}>
            <span>Min score</span>
            {scoreBar(activeSummary.minScore)}
          </div>
          <div style={styles.summaryRow}>
            <span>Flagged pages</span>
            <strong style={{ color: activeSummary.flaggedCount > 0 ? "#ff3b30" : "#34c759" }}>
              {activeSummary.flaggedCount} / {activeSummary.pageCount}
            </strong>
          </div>
        </div>
      )}

      {/* Page list */}
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Page</th>
            <th style={styles.th}>Score</th>
            <th style={styles.th}>Lang attr</th>
            <th style={styles.th}>Flag</th>
          </tr>
        </thead>
        <tbody>
          {activePages.map((page) => (
            <tr key={`${page.locale}/${page.path}`} style={styles.tr}>
              <td style={styles.td}><code>{page.path}</code></td>
              <td style={styles.td}>{scoreBar(page.weightedScore)}</td>
              <td style={styles.td}>{page.langAttr ?? "—"}</td>
              <td style={styles.td}>
                {page.still_english_flag ? (
                  <span style={{ color: "#ff3b30" }}>⚠ still english</span>
                ) : (
                  <span style={{ color: "#34c759" }}>✓</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Widget
// ---------------------------------------------------------------------------

export function I18nParityWidget(): React.ReactElement {
  const { data, loading, error } = usePluginData<ParityReport>("i18n-parity-report");

  if (loading) return <div style={styles.widget}>Loading…</div>;
  if (error) return <div style={styles.widget}>Error loading parity data</div>;
  if (!data || !data.scannedAt) {
    return (
      <div style={styles.widget}>
        <div style={styles.widgetTitle}>i18n Parity</div>
        <p style={styles.widgetHint}>No data — run <code>run-scan</code></p>
      </div>
    );
  }

  const totalPages = data.pages.length;
  const flaggedPages = data.pages.filter((p) => p.still_english_flag).length;
  const overallAvg =
    data.summary.length > 0
      ? data.summary.reduce((a, b) => a + b.averageScore, 0) / data.summary.length
      : 0;

  return (
    <div style={styles.widget}>
      <div style={styles.widgetTitle}>i18n Parity</div>
      <div style={styles.widgetStats}>
        <div style={styles.widgetStat}>
          <div style={styles.widgetStatValue}>{Math.round(overallAvg * 100)}%</div>
          <div style={styles.widgetStatLabel}>Avg parity</div>
        </div>
        <div style={styles.widgetStat}>
          <div style={{ ...styles.widgetStatValue, color: flaggedPages > 0 ? "#ff3b30" : "#34c759" }}>
            {flaggedPages}
          </div>
          <div style={styles.widgetStatLabel}>Flagged pages</div>
        </div>
        <div style={styles.widgetStat}>
          <div style={styles.widgetStatValue}>{data.summary.length}</div>
          <div style={styles.widgetStatLabel}>Locales</div>
        </div>
      </div>
      <div style={styles.widgetMeta}>
        {totalPages} pages · {new Date(data.scannedAt).toLocaleDateString()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    padding: "12px 16px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: 13,
  },
  sidebarTitle: {
    fontWeight: 600,
    fontSize: 14,
    marginBottom: 4,
  },
  sidebarMeta: {
    color: "#8e8e93",
    fontSize: 11,
    marginBottom: 8,
  },
  sidebarRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 0",
    borderBottom: "1px solid #f2f2f7",
  },
  sidebarLocale: {
    width: 40,
    fontWeight: 500,
    flexShrink: 0,
  },
  sidebarHint: {
    color: "#8e8e93",
    fontSize: 12,
  },
  badge: {
    background: "#ff3b30",
    color: "#fff",
    borderRadius: 8,
    padding: "1px 6px",
    fontSize: 11,
    fontWeight: 600,
    marginLeft: "auto",
  },
  page: {
    padding: "24px 32px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    maxWidth: 900,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: 700,
    marginBottom: 4,
  },
  pageMeta: {
    color: "#8e8e93",
    fontSize: 13,
    marginBottom: 20,
  },
  localeTabs: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 16,
  },
  localeTab: {
    padding: "4px 12px",
    border: "1px solid #e5e5ea",
    borderRadius: 100,
    background: "#f2f2f7",
    cursor: "pointer",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  localeTabActive: {
    background: "#000",
    color: "#fff",
    borderColor: "#000",
  },
  tabBadge: {
    background: "#ff3b30",
    color: "#fff",
    borderRadius: 8,
    padding: "0px 5px",
    fontSize: 10,
    fontWeight: 700,
  },
  summaryCard: {
    border: "1px solid #e5e5ea",
    borderRadius: 12,
    padding: "12px 16px",
    marginBottom: 20,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  summaryRow: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    fontSize: 13,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  },
  th: {
    textAlign: "left",
    padding: "6px 12px",
    borderBottom: "2px solid #e5e5ea",
    color: "#3c3c43",
    fontWeight: 600,
  },
  tr: {
    borderBottom: "1px solid #f2f2f7",
  },
  td: {
    padding: "6px 12px",
    verticalAlign: "middle",
  },
  widget: {
    padding: "16px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  widgetTitle: {
    fontWeight: 700,
    fontSize: 15,
    marginBottom: 12,
  },
  widgetStats: {
    display: "flex",
    gap: 16,
    marginBottom: 8,
  },
  widgetStat: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flex: 1,
  },
  widgetStatValue: {
    fontSize: 24,
    fontWeight: 700,
    lineHeight: 1.1,
  },
  widgetStatLabel: {
    fontSize: 11,
    color: "#8e8e93",
    marginTop: 2,
  },
  widgetHint: {
    color: "#8e8e93",
    fontSize: 12,
  },
  widgetMeta: {
    color: "#8e8e93",
    fontSize: 11,
    marginTop: 4,
  },
};
