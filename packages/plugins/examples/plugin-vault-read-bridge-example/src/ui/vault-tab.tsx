import {
  type PluginDetailTabProps,
  type PluginProjectSidebarItemProps,
} from "@paperclipai/plugin-sdk/ui";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

const PLUGIN_KEY = "paperclip.vault-read-bridge-example";
const TAB_SLOT_ID = "vault-tab";

interface VaultViewNote {
  relativePath: string;
  title: string;
  score: number;
  frontmatterProject: string | null;
  mtimeMs: number | null;
  sizeBytes: number | null;
}

interface VaultViewResponse {
  notes: VaultViewNote[];
  redactedCount: number;
  errors: string[];
}

interface VaultBodyResponse {
  body: string | null;
  redacted: boolean;
  error: string | null;
}

interface VaultHealthResponse {
  reachable: boolean;
}

interface PluginConfig {
  showSidebarLink?: boolean;
}

function formatMtime(mtimeMs: number | null): string {
  if (mtimeMs === null) return "unknown";
  return new Date(mtimeMs).toISOString();
}

export function VaultTab({ context }: PluginDetailTabProps) {
  const companyId = context.companyId;
  const projectId = context.entityId;

  const { data: healthData } = usePluginData<VaultHealthResponse>("vault-health", {
    companyId,
  });
  const { data: viewData, loading, error } = usePluginData<VaultViewResponse>(
    "vault-project-view",
    { projectId, companyId },
  );

  // We deliberately fetch the first matching note's body on demand
  // only — the bridge never pre-loads bodies.
  const firstNote = viewData?.notes[0] ?? null;
  const { data: bodyData, loading: bodyLoading } = usePluginData<VaultBodyResponse>(
    "vault-note-body",
    firstNote ? { companyId, relativePath: firstNote.relativePath } : {},
  );

  const reachable = healthData?.reachable === true;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">Vault</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Read-only mirror of the local Obsidian vault. The vault is the operator's human-controlled truth; Paperclip never edits it.
        </p>
        <p
          className="mt-2 text-xs"
          aria-label={reachable ? "Vault reachable" : "Vault not reachable"}
          data-testid="vault-reachable"
        >
          <span className="font-medium">Vault status:</span>{" "}
          {reachable ? (
            <span className="text-emerald-700">reachable</span>
          ) : (
            <span className="text-muted-foreground">not configured</span>
          )}
          {viewData?.redactedCount ? (
            <span className="ml-2 text-muted-foreground">
              ({viewData.redactedCount} redaction rule{viewData.redactedCount === 1 ? "" : "s"})
            </span>
          ) : null}
        </p>
      </div>

      {!reachable ? (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          The vault root has not been configured for this company. Ask the operator to point the plugin at a local Obsidian vault root.
        </div>
      ) : loading ? (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Loading vault view\u2026
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Failed to load vault view: {error.message}
        </div>
      ) : !viewData || viewData.notes.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          No vault notes are currently relevant to this project. The bridge only lists notes whose frontmatter
          <code className="mx-1 rounded bg-muted px-1 py-0.5">project:</code> tag matches the project slug, that live under
          <code className="mx-1 rounded bg-muted px-1 py-0.5">30-Products/&lt;slug&gt;/</code>, or that are referenced from
          <code className="mx-1 rounded bg-muted px-1 py-0.5">70-Reviews-and-Scorecards/</code> /
          <code className="mx-1 rounded bg-muted px-1 py-0.5">60-Portfolio-Decisions/</code>.
        </div>
      ) : (
        <div className="space-y-4" data-testid="vault-view-container">
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {viewData.notes.map((note) => (
              <li key={note.relativePath} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{note.title}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{note.relativePath}</p>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    <p>score {note.score}</p>
                    <p>{formatMtime(note.mtimeMs)}</p>
                  </div>
                </div>
                {note.frontmatterProject ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    project: <span className="font-mono">{note.frontmatterProject}</span>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {firstNote ? (
            <div
              className="rounded-lg border border-border bg-card p-4"
              data-testid="vault-note-body"
            >
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>Preview: {firstNote.title}</span>
                {bodyData?.redacted ? <span className="text-amber-700">[redacted]</span> : null}
              </div>
              {bodyLoading ? (
                <p className="text-sm text-muted-foreground">Loading body\u2026</p>
              ) : bodyData?.body ? (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs text-foreground">
                  {bodyData.body}
                </pre>
              ) : bodyData?.error ? (
                <p className="text-sm text-destructive">{bodyData.error}</p>
              ) : (
                <p className="text-sm text-muted-foreground">(empty)</p>
              )}
            </div>
          ) : null}

          {viewData.errors.length > 0 ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              <p className="font-medium">Vault read warnings:</p>
              <ul className="ml-4 list-disc">
                {viewData.errors.slice(0, 5).map((msg, idx) => (
                  <li key={idx}>{msg}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Optional per-project sidebar link. Honours the
 * `showSidebarLink` operator config; hidden by default.
 */
export function VaultLink({ context }: PluginProjectSidebarItemProps) {
  const companyId = context.companyId;
  const { data } = usePluginData<PluginConfig>("plugin-config", { companyId });
  const showSidebarLink = data?.showSidebarLink === true;
  if (!showSidebarLink) return null;

  const projectId = context.entityId;
  const projectRef =
    "projectRef" in context && typeof (context as { projectRef?: unknown }).projectRef === "string"
      ? ((context as { projectRef: string }).projectRef)
      : projectId;
  const prefix = context.companyPrefix ? `/${context.companyPrefix}` : "";
  const tabValue = `plugin:${PLUGIN_KEY}:${TAB_SLOT_ID}`;
  const href = `${prefix}/projects/${projectRef}?tab=${encodeURIComponent(tabValue)}`;

  return (
    <a
      href={href}
      className="block px-3 py-1 text-[12px] truncate text-muted-foreground hover:text-foreground hover:bg-accent/50"
    >
      Vault
    </a>
  );
}
