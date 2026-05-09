import type { IssueWorkProduct } from "@paperclipai/shared";

function metadataRecord(product: IssueWorkProduct): Record<string, unknown> {
  return product.metadata && typeof product.metadata === "object" && !Array.isArray(product.metadata)
    ? product.metadata
    : {};
}

function metadataString(metadata: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function metadataArrayCount(metadata: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) return value.length;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function productTimestamp(product: IssueWorkProduct): number {
  const value = product.updatedAt instanceof Date
    ? product.updatedAt.getTime()
    : new Date(product.updatedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function isHermesKanbanProduct(product: IssueWorkProduct): boolean {
  return product.provider === "hermes-kanban";
}

export function sortIssueWorkProductsForDisplay(products: IssueWorkProduct[]): IssueWorkProduct[] {
  return [...products].sort((a, b) => {
    const aHermes = isHermesKanbanProduct(a) ? 0 : 1;
    const bHermes = isHermesKanbanProduct(b) ? 0 : 1;
    if (aHermes !== bHermes) return aHermes - bHermes;
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return productTimestamp(b) - productTimestamp(a);
  });
}

export function getHermesExecutionDetails(product: IssueWorkProduct): {
  rootTaskId: string | null;
  childTaskCount: number | null;
  statusSummary: string | null;
} {
  const metadata = metadataRecord(product);
  return {
    rootTaskId: metadataString(metadata, "rootTaskId", "root_task_id", "hermesRootTaskId"),
    childTaskCount: metadataArrayCount(metadata, "childTaskIds", "child_task_ids", "hermesChildTaskIds", "childTaskCount"),
    statusSummary: metadataString(metadata, "statusSummary", "status_summary", "lastStatusSummary"),
  };
}

function providerLabel(provider: string): string {
  if (provider === "hermes-kanban") return "Hermes Kanban";
  return provider.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function WorkProductCard({ product }: { product: IssueWorkProduct }) {
  const details = getHermesExecutionDetails(product);
  const isHermes = isHermesKanbanProduct(product);
  const summary = details.statusSummary ?? product.summary;

  return (
    <article
      className={
        isHermes
          ? "border border-[var(--border-visible)] bg-[color-mix(in_srgb,var(--foreground)_5%,var(--card))] p-3"
          : "border border-[color-mix(in_srgb,var(--border-visible)_32%,transparent)] bg-[color-mix(in_srgb,var(--accent)_18%,var(--card))] p-3"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                isHermes
                  ? "border-l-[3px] border-[var(--event-accent)] bg-[color-mix(in_srgb,var(--foreground)_7%,var(--background))] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-display)]"
                  : "border border-[color-mix(in_srgb,var(--border-visible)_38%,transparent)] bg-background px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-display)]"
              }
            >
              {providerLabel(product.provider)}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              {product.type.replace(/_/g, " ")}
            </span>
            {product.isPrimary && (
              <span className="border-l-[3px] border-[var(--status-live-border)] bg-[color-mix(in_srgb,var(--foreground)_6%,var(--card))] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-display)]">
                Primary
              </span>
            )}
          </div>
          {product.url ? (
            <a
              href={product.url}
              target="_blank"
              rel="noreferrer"
              className="block truncate font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--text-display)] hover:underline"
              title={product.url}
            >
              {product.title}
            </a>
          ) : (
            <p className="truncate font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--text-display)]">{product.title}</p>
          )}
          {summary && <p className="text-xs leading-5 text-muted-foreground">{summary}</p>}
        </div>
        <span className="shrink-0 border-l-[3px] border-[var(--border-visible)] bg-[color-mix(in_srgb,var(--foreground)_5%,var(--card))] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-display)]">
          {statusLabel(product.status)}
        </span>
      </div>

      {(details.rootTaskId || details.childTaskCount !== null || product.externalId) && (
        <dl className="mt-3 grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          {details.rootTaskId && (
            <div>
              <dt className="font-mono uppercase tracking-[0.18em] text-[10px]">Root task</dt>
              <dd className="font-mono text-foreground">{details.rootTaskId}</dd>
            </div>
          )}
          {details.childTaskCount !== null && (
            <div>
              <dt className="font-mono uppercase tracking-[0.18em] text-[10px]">Child tasks</dt>
              <dd className="font-mono text-foreground">{details.childTaskCount}</dd>
            </div>
          )}
          {product.externalId && (
            <div>
              <dt className="font-mono uppercase tracking-[0.18em] text-[10px]">External ID</dt>
              <dd className="font-mono text-foreground">{product.externalId}</dd>
            </div>
          )}
        </dl>
      )}
    </article>
  );
}

export function IssueWorkProductsSection({ products }: { products: IssueWorkProduct[] }) {
  const sortedProducts = sortIssueWorkProductsForDisplay(products);
  const hermesCount = sortedProducts.filter(isHermesKanbanProduct).length;
  const hermesReadout = `${hermesCount} Hermes`;

  return (
    <section
      data-hermes-execution-panel="true"
      className="space-y-3 border border-[var(--border-visible)] bg-[color-mix(in_srgb,var(--accent)_20%,var(--card))] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Execution surface</span>
          <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--text-display)]">Hermes execution</h3>
          <p className="text-xs text-muted-foreground">
            Kanban, Conductor, and artifact links attached to this issue.
          </p>
        </div>
        {hermesCount > 0 && (
          <span
            data-hermes-execution-readout={hermesReadout}
            className="border-l-[3px] border-[var(--event-accent)] bg-[color-mix(in_srgb,var(--foreground)_5%,var(--card))] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-display)]"
          >
            {hermesReadout}
          </span>
        )}
      </div>

      {sortedProducts.length === 0 ? (
        <p className="border border-dashed border-[color-mix(in_srgb,var(--border-visible)_38%,transparent)] p-3 text-xs text-muted-foreground">
          No Hermes execution links yet. Launch Hermes Kanban for this issue to attach board, root task, and status roll-up links here.
        </p>
      ) : (
        <div className="space-y-2">
          {sortedProducts.map((product) => (
            <WorkProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </section>
  );
}
