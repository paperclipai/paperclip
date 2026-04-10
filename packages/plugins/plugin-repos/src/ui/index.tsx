import { usePluginData, useHostContext, type PluginPageProps, type PluginSidebarProps, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { ReposData, EnrichedRepo } from "../worker.js";
import { PAGE_ROUTE } from "../constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hostPath(companyPrefix: string | null | undefined, suffix: string): string {
  return companyPrefix ? `/${companyPrefix}${suffix}` : suffix;
}

function reposPagePath(companyPrefix: string | null | undefined): string {
  return hostPath(companyPrefix, `/${PAGE_ROUTE}`);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function useReposData() {
  return usePluginData<ReposData>("repos");
}

// ---------------------------------------------------------------------------
// Stack badge
// ---------------------------------------------------------------------------

function StackBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
        background: "var(--color-accent, #f0f0f0)",
        color: "var(--color-foreground, #333)",
        marginRight: 4,
        marginBottom: 2,
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Repo row (used on full page)
// ---------------------------------------------------------------------------

function RepoRow({ repo }: { repo: EnrichedRepo }) {
  const ctx = useHostContext();
  return (
    <tr
      style={{
        borderBottom: "1px solid var(--color-border, #e5e5e5)",
        verticalAlign: "top",
      }}
    >
      {/* Name + description */}
      <td style={{ padding: "12px 8px 12px 0", minWidth: 160 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <a
            href={repo.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontWeight: 600, fontSize: 14, color: "var(--color-foreground)" }}
          >
            {repo.name}
          </a>
          {!repo.isCloned && (
            <span
              title="Not yet cloned locally"
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "#fef3c7",
                color: "#92400e",
                fontWeight: 500,
              }}
            >
              not cloned
            </span>
          )}
        </div>
        {repo.description && (
          <div style={{ fontSize: 12, color: "var(--color-muted-foreground, #888)", marginTop: 2 }}>
            {repo.description}
          </div>
        )}
        <div style={{ marginTop: 4 }}>
          {(repo.stack ?? []).map((s) => (
            <StackBadge key={s} label={s} />
          ))}
        </div>
      </td>

      {/* Branch */}
      <td style={{ padding: "12px 8px", whiteSpace: "nowrap", fontSize: 13 }}>
        <code style={{ fontSize: 12 }}>{repo.defaultBranch}</code>
      </td>

      {/* Last push */}
      <td style={{ padding: "12px 8px", whiteSpace: "nowrap", fontSize: 13, color: "var(--color-muted-foreground, #888)" }}>
        {formatDate(repo.githubStats?.lastCommitDate)}
      </td>

      {/* Open PRs */}
      <td style={{ padding: "12px 8px", textAlign: "center", fontSize: 13 }}>
        {repo.githubStats != null ? (
          <a
            href={`${repo.githubUrl}/pulls`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontWeight: 600,
              color: repo.githubStats.openPRs > 0 ? "var(--color-foreground)" : "var(--color-muted-foreground, #888)",
            }}
          >
            {repo.githubStats.openPRs}
          </a>
        ) : (
          <span style={{ color: "var(--color-muted-foreground, #888)" }}>—</span>
        )}
      </td>

      {/* Active worktrees */}
      <td style={{ padding: "12px 8px", textAlign: "center", fontSize: 13 }}>
        {(repo.activeWorktrees ?? []).length > 0 ? (
          <span title={(repo.activeWorktrees ?? []).map((w) => w.branch).join(", ")}>
            {(repo.activeWorktrees ?? []).length}
          </span>
        ) : (
          <span style={{ color: "var(--color-muted-foreground, #888)" }}>0</span>
        )}
      </td>

      {/* Deploy link */}
      <td style={{ padding: "12px 0 12px 8px", whiteSpace: "nowrap", fontSize: 13 }}>
        {repo.deployUrl ? (
          <a
            href={repo.deployUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--color-primary, #2563eb)", fontSize: 12 }}
          >
            Live ↗
          </a>
        ) : (
          <span style={{ color: "var(--color-muted-foreground, #888)", fontSize: 12 }}>—</span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget
// ---------------------------------------------------------------------------

export function ReposDashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = useReposData();
  const href = reposPagePath(context.companyPrefix);

  if (loading) {
    return (
      <section aria-label="Repos widget" style={{ padding: "12px 0" }}>
        <div style={{ fontSize: 13, color: "var(--color-muted-foreground, #888)" }}>Loading repos…</div>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section aria-label="Repos widget" style={{ padding: "12px 0" }}>
        <div style={{ fontSize: 13, color: "var(--color-destructive, #dc2626)" }}>
          {error?.message ?? "Registry unavailable"}
        </div>
      </section>
    );
  }

  const totalPRs = data.repos.reduce((sum, r) => sum + (r.githubStats?.openPRs ?? 0), 0);
  const activeWorktrees = data.repos.reduce((sum, r) => sum + (r.activeWorktrees?.length ?? 0), 0);

  return (
    <section aria-label="Repos widget">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>Repos</strong>
        <a href={href} style={{ fontSize: 12, color: "var(--color-primary, #2563eb)" }}>
          View all →
        </a>
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{data.repos.length}</div>
          <div style={{ fontSize: 11, color: "var(--color-muted-foreground, #888)", marginTop: 2 }}>repos</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{totalPRs}</div>
          <div style={{ fontSize: 11, color: "var(--color-muted-foreground, #888)", marginTop: 2 }}>open PRs</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{activeWorktrees}</div>
          <div style={{ fontSize: 11, color: "var(--color-muted-foreground, #888)", marginTop: 2 }}>worktrees</div>
        </div>
      </div>

      {/* Mini repo list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {data.repos.map((repo) => (
          <div key={repo.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <a
              href={repo.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 13, fontWeight: 500, color: "var(--color-foreground)" }}
            >
              {repo.name}
            </a>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {repo.isCloned && (
                <span style={{ fontSize: 10, color: "#16a34a", fontWeight: 500 }}>✓ cloned</span>
              )}
              {repo.deployUrl && (
                <a
                  href={repo.deployUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11, color: "var(--color-primary, #2563eb)" }}
                >
                  live ↗
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sidebar link
// ---------------------------------------------------------------------------

export function ReposSidebarLink({ context }: PluginSidebarProps) {
  const href = reposPagePath(context.companyPrefix);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <span className="relative shrink-0">
        {/* Code/fork icon */}
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="6" cy="18" r="2" />
          <path d="M6 8v8" />
          <path d="M18 8v2a4 4 0 0 1-4 4H6" />
        </svg>
      </span>
      <span>Repos</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Full page
// ---------------------------------------------------------------------------

export function ReposPage({ context }: PluginPageProps) {
  const { data, loading, error } = useReposData();

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1000 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Repositories</h1>
        <p style={{ fontSize: 13, color: "var(--color-muted-foreground, #888)" }}>
          All Darwin code repositories. Registry at <code style={{ fontSize: 12 }}>/home/r1kon/repos/registry.json</code>.
        </p>
      </div>

      {loading && (
        <div style={{ fontSize: 14, color: "var(--color-muted-foreground, #888)" }}>Loading…</div>
      )}

      {error && (
        <div
          style={{
            padding: "12px 16px",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            color: "#dc2626",
            fontSize: 13,
          }}
        >
          {error.message}
        </div>
      )}

      {data && (
        <>
          {/* Summary bar */}
          <div
            style={{
              display: "flex",
              gap: 24,
              marginBottom: 20,
              padding: "12px 16px",
              background: "var(--color-accent, #f9f9f9)",
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            <span><strong>{data.repos.length}</strong> repos</span>
            <span><strong>{data.repos.filter((r) => r.isCloned).length}</strong> cloned locally</span>
            <span><strong>{data.repos.reduce((s, r) => s + (r.githubStats?.openPRs ?? 0), 0)}</strong> open PRs</span>
            <span><strong>{data.repos.reduce((s, r) => s + (r.activeWorktrees?.length ?? 0), 0)}</strong> active worktrees</span>
            <span style={{ marginLeft: "auto", color: "var(--color-muted-foreground, #888)" }}>
              Updated {formatDate(data.fetchedAt)}
            </span>
          </div>

          {/* Table */}
          {data.repos.length === 0 ? (
            <div style={{ fontSize: 14, color: "var(--color-muted-foreground, #888)", padding: "32px 0", textAlign: "center" }}>
              No repos in registry yet.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--color-border, #e5e5e5)" }}>
                    <th style={{ textAlign: "left", padding: "8px 8px 8px 0", fontWeight: 600, fontSize: 12, color: "var(--color-muted-foreground, #888)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Repo
                    </th>
                    <th style={{ textAlign: "left", padding: "8px", fontWeight: 600, fontSize: 12, color: "var(--color-muted-foreground, #888)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Branch
                    </th>
                    <th style={{ textAlign: "left", padding: "8px", fontWeight: 600, fontSize: 12, color: "var(--color-muted-foreground, #888)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Last Push
                    </th>
                    <th style={{ textAlign: "center", padding: "8px", fontWeight: 600, fontSize: 12, color: "var(--color-muted-foreground, #888)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      PRs
                    </th>
                    <th style={{ textAlign: "center", padding: "8px", fontWeight: 600, fontSize: 12, color: "var(--color-muted-foreground, #888)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Worktrees
                    </th>
                    <th style={{ textAlign: "left", padding: "8px 0 8px 8px", fontWeight: 600, fontSize: 12, color: "var(--color-muted-foreground, #888)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Deploy
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.repos.map((repo) => (
                    <RepoRow key={repo.name} repo={repo} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* No GitHub token note */}
          {data.repos.some((r) => r.githubStats == null) && (
            <div
              style={{
                marginTop: 16,
                padding: "10px 14px",
                background: "var(--color-accent, #f9f9f9)",
                borderRadius: 6,
                fontSize: 12,
                color: "var(--color-muted-foreground, #888)",
              }}
            >
              GitHub stats (PRs, last push) are unavailable — add a <strong>GITHUB_TOKEN</strong> secret and set it as the plugin's <em>GitHub Token Secret Ref</em> to enable live data.
            </div>
          )}

          {/* Worktree convention reminder */}
          <div
            style={{
              marginTop: 16,
              padding: "10px 14px",
              background: "var(--color-accent, #f9f9f9)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--color-muted-foreground, #888)",
            }}
          >
            <strong>Editing workflow:</strong> Agents use worktrees at <code>/home/r1kon/repos/&#123;repo&#125;-&#123;ISSUE-ID&#125;/</code> and open PRs on branch <code>feature/&#123;ISSUE-ID&#125;-slug</code>.
          </div>
        </>
      )}
    </div>
  );
}
