// LET-515 — Inline MCP catalog picker for the EAOS onboarding "Next steps"
// panel. Replaces the disabled "Pick later" CTA on the MCP card.
//
// Surface contract:
//   - Renders a small list of allowlisted catalog entries fetched from the
//     canonical GET /companies/:cid/mcp-catalog endpoint. Only `verified/`
//     entries are surfaced because the server filters non-allowlisted entries
//     out before they reach the wire.
//   - Selecting an entry stages a server-side preview via POST .../preview.
//     The picker never accepts raw secret values; the only inputs are env-style
//     secret *names* (e.g. `GITHUB_TOKEN`). A client-side gate rejects pasted
//     values before they reach the network so a misuse cannot surface in logs
//     even momentarily.
//   - The result is read-only: blockers, tool list, and a `Preview only — no
//     apply` notice. The actual install path remains the per-agent
//     capability-apply approval card.
//
// Safety:
//   - No raw token / API key fields. Inputs accept name-shaped strings only.
//   - The error path NEVER echoes a rejected paste back to the user — the
//     message is generic ("looks like a raw secret") so a copy/paste accident
//     cannot land in a screen-recording or session-replay capture.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Lock, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { redactSecretLikeText } from "../secret-redact";
import {
  McpCatalogApiError,
  assertSecretRefName,
  mcpCatalogApi,
  type McpCatalogListEntry,
  type McpCatalogPreviewResult,
} from "@/api/mcpCatalog";

export interface EaosMcpPickerProps {
  readonly fetchList?: (companyId: string) => Promise<{ entries: ReadonlyArray<McpCatalogListEntry> }>;
  readonly previewInstall?: (companyId: string, body: { catalogId: string; namedSecretRefs?: string[] }) => Promise<McpCatalogPreviewResult>;
}

export function EaosMcpPicker(props: EaosMcpPickerProps = {}) {
  const { selectedCompanyId } = useCompany();
  const [selected, setSelected] = useState<string | null>(null);
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [draftRefName, setDraftRefName] = useState("");
  const [preview, setPreview] = useState<McpCatalogPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const fetchList = props.fetchList ?? mcpCatalogApi.list;
  const previewInstall = props.previewInstall ?? mcpCatalogApi.preview;

  const listQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.mcpCatalog.list(selectedCompanyId)
      : ["mcp-catalog", "__no-company__", "list"],
    queryFn: () => fetchList(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const entries = useMemo<ReadonlyArray<McpCatalogListEntry>>(
    () => listQuery.data?.entries ?? [],
    [listQuery.data],
  );
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.catalogId === selected) ?? null,
    [entries, selected],
  );

  function resetSelection() {
    setSelected(null);
    setPreview(null);
    setPreviewError(null);
    setSecretInputs({});
    setDraftRefName("");
  }

  async function runPreview(catalogId: string, suppliedRefs: string[]) {
    if (!selectedCompanyId) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const result = await previewInstall(selectedCompanyId, {
        catalogId,
        namedSecretRefs: suppliedRefs,
      });
      setPreview(result);
    } catch (err) {
      const message =
        err instanceof McpCatalogApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not stage preview.";
      // Never echo a possibly-pasted raw secret in the visible error.
      setPreviewError(redactSecretLikeText(message));
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }

  function handleSelect(entry: McpCatalogListEntry) {
    setSelected(entry.catalogId);
    setPreview(null);
    setPreviewError(null);
    setSecretInputs({});
    setDraftRefName("");
    void runPreview(entry.catalogId, []);
  }

  function handleAddSecretRef() {
    const name = draftRefName.trim();
    if (!selectedEntry) return;
    try {
      assertSecretRefName(name);
    } catch (err) {
      const message =
        err instanceof McpCatalogApiError ? err.message : "Invalid secret reference name.";
      setPreviewError(redactSecretLikeText(message));
      // Wipe the draft so the offending value cannot remain in the DOM.
      setDraftRefName("");
      return;
    }
    const next = { ...secretInputs, [name]: name };
    setSecretInputs(next);
    setDraftRefName("");
    void runPreview(selectedEntry.catalogId, Object.values(next));
  }

  function handleRemoveSecretRef(name: string) {
    if (!selectedEntry) return;
    const next = { ...secretInputs };
    delete next[name];
    setSecretInputs(next);
    void runPreview(selectedEntry.catalogId, Object.values(next));
  }

  if (!selectedCompanyId) {
    return (
      <p
        className="rounded-md border border-dashed border-border bg-background p-3 text-[11px] text-muted-foreground"
        data-testid="eaos-onboarding-mcp-picker-no-company"
      >
        Select a company to browse the verified MCP catalog.
      </p>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-3"
      data-testid="eaos-onboarding-mcp-picker"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="h-4 w-4 text-foreground" />
          <span className="font-medium text-foreground">Verified catalog</span>
          <span>· preview only · no raw secrets</span>
        </div>
        {selected ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={resetSelection}
            data-testid="eaos-onboarding-mcp-picker-reset"
          >
            Back to list
          </Button>
        ) : null}
      </header>

      {!selected ? (
        <CatalogList
          entries={entries}
          loading={listQuery.isLoading}
          error={listQuery.isError ? readErrorMessage(listQuery.error) : null}
          onSelect={handleSelect}
        />
      ) : selectedEntry ? (
        <PreviewPanel
          entry={selectedEntry}
          previewing={previewing}
          preview={preview}
          error={previewError}
          suppliedRefs={Object.values(secretInputs)}
          draftRefName={draftRefName}
          onDraftRefNameChange={setDraftRefName}
          onAddSecretRef={handleAddSecretRef}
          onRemoveSecretRef={handleRemoveSecretRef}
        />
      ) : null}
    </div>
  );
}

function CatalogList({
  entries,
  loading,
  error,
  onSelect,
}: {
  entries: ReadonlyArray<McpCatalogListEntry>;
  loading: boolean;
  error: string | null;
  onSelect: (entry: McpCatalogListEntry) => void;
}) {
  if (loading) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground"
        data-testid="eaos-onboarding-mcp-picker-loading"
      >
        Loading verified catalog…
      </p>
    );
  }
  if (error) {
    return (
      <p
        role="alert"
        className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
        data-testid="eaos-onboarding-mcp-picker-error"
      >
        {error}
      </p>
    );
  }
  if (entries.length === 0) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="eaos-onboarding-mcp-picker-empty"
      >
        No verified catalog entries are available.
      </p>
    );
  }
  return (
    <ul
      className="grid grid-cols-1 gap-2"
      data-testid="eaos-onboarding-mcp-picker-list"
    >
      {entries.map((entry) => (
        <li
          key={entry.catalogId}
          className="flex flex-col gap-1 rounded-md border border-border bg-background p-2"
          data-testid="eaos-onboarding-mcp-picker-entry"
          data-catalog-id={entry.catalogId}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium text-foreground">
                {redactSecretLikeText(entry.server.title)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {redactSecretLikeText(entry.catalogId)}
                {" · "}
                {entry.server.transport}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="eaos-onboarding-mcp-picker-entry-preview"
              onClick={() => onSelect(entry)}
            >
              Preview
            </Button>
          </div>
          {entry.server.description ? (
            <p className="text-[11px] text-muted-foreground">
              {redactSecretLikeText(entry.server.description)}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PreviewPanel({
  entry,
  preview,
  previewing,
  error,
  suppliedRefs,
  draftRefName,
  onDraftRefNameChange,
  onAddSecretRef,
  onRemoveSecretRef,
}: {
  entry: McpCatalogListEntry;
  preview: McpCatalogPreviewResult | null;
  previewing: boolean;
  error: string | null;
  suppliedRefs: ReadonlyArray<string>;
  draftRefName: string;
  onDraftRefNameChange: (next: string) => void;
  onAddSecretRef: () => void;
  onRemoveSecretRef: (name: string) => void;
}) {
  const requiredNames = preview?.server.requiredSecretNames ?? entry.server.requiredSecretNames;
  const blockers = preview?.preview.blockers ?? entry.preview.blockers;
  const missingRefs = preview?.missingRequiredSecretRefs ?? requiredNames;

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="eaos-onboarding-mcp-picker-preview"
      data-catalog-id={entry.catalogId}
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">
          {redactSecretLikeText(entry.server.title)}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {redactSecretLikeText(entry.catalogId)}
          {" · "}
          {entry.server.transport}
          {" · "}
          provider <span className="font-mono">{entry.server.provider}</span>
        </p>
        {entry.server.description ? (
          <p className="text-[11px] text-muted-foreground">
            {redactSecretLikeText(entry.server.description)}
          </p>
        ) : null}
      </div>

      <div
        className="flex items-center gap-2 rounded-md border border-dashed border-border bg-background p-2 text-[11px] text-muted-foreground"
        data-testid="eaos-onboarding-mcp-picker-preview-banner"
      >
        <Lock aria-hidden="true" className="h-4 w-4 text-foreground" />
        <span>
          <span className="font-medium text-foreground">Preview only.</span>{" "}
          The picker stages a fail-closed check (catalog allowlist + SSRF + named
          secret refs). Apply happens later, in a per-agent approval card.
        </span>
      </div>

      <SecretRefsEditor
        requiredNames={requiredNames}
        suppliedRefs={suppliedRefs}
        missingRefs={missingRefs}
        draftRefName={draftRefName}
        onDraftRefNameChange={onDraftRefNameChange}
        onAddSecretRef={onAddSecretRef}
        onRemoveSecretRef={onRemoveSecretRef}
      />

      <Blockers blockers={blockers} />

      <ToolList toolNames={entry.server.toolNames} />

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
          data-testid="eaos-onboarding-mcp-picker-preview-error"
        >
          {error}
        </p>
      ) : null}
      {previewing ? (
        <p
          role="status"
          aria-live="polite"
          className="text-[11px] text-muted-foreground"
          data-testid="eaos-onboarding-mcp-picker-preview-loading"
        >
          Staging preview…
        </p>
      ) : null}
    </div>
  );
}

function SecretRefsEditor({
  requiredNames,
  suppliedRefs,
  missingRefs,
  draftRefName,
  onDraftRefNameChange,
  onAddSecretRef,
  onRemoveSecretRef,
}: {
  requiredNames: ReadonlyArray<string>;
  suppliedRefs: ReadonlyArray<string>;
  missingRefs: ReadonlyArray<string>;
  draftRefName: string;
  onDraftRefNameChange: (next: string) => void;
  onAddSecretRef: () => void;
  onRemoveSecretRef: (name: string) => void;
}) {
  return (
    <section
      aria-label="Named secret references"
      className="flex flex-col gap-1.5"
      data-testid="eaos-onboarding-mcp-picker-secret-refs"
    >
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-medium text-foreground">Named secret references</p>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          names only · no values
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Picker accepts env-style identifiers (e.g.{" "}
        <span className="font-mono">GITHUB_TOKEN</span>). Values stay in the secrets vault
        and are resolved at apply time.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-label="Add a named secret reference"
          placeholder="EXAMPLE_TOKEN"
          value={draftRefName}
          onChange={(event) => onDraftRefNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAddSecretRef();
            }
          }}
          data-testid="eaos-onboarding-mcp-picker-secret-input"
          className="w-48 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="eaos-onboarding-mcp-picker-secret-add"
          onClick={onAddSecretRef}
          disabled={draftRefName.trim().length === 0}
        >
          Add reference
        </Button>
      </div>
      {suppliedRefs.length > 0 ? (
        <ul
          className="flex flex-wrap items-center gap-1.5"
          data-testid="eaos-onboarding-mcp-picker-secret-supplied"
        >
          {suppliedRefs.map((name) => (
            <li
              key={name}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
              data-testid="eaos-onboarding-mcp-picker-secret-chip"
            >
              <span className="font-mono">{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() => onRemoveSecretRef(name)}
                className="rounded p-0.5 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {requiredNames.length > 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="eaos-onboarding-mcp-picker-required">
          Required:{" "}
          {requiredNames.map((name, index) => (
            <span key={name}>
              <span className="font-mono">{name}</span>
              {missingRefs.includes(name) ? (
                <span className="ml-0.5 inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-400">
                  <AlertTriangle aria-hidden="true" className="h-3 w-3" />
                  missing
                </span>
              ) : (
                <span className="ml-0.5 inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 aria-hidden="true" className="h-3 w-3" />
                  supplied
                </span>
              )}
              {index < requiredNames.length - 1 ? <span>, </span> : null}
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}

function Blockers({ blockers }: { blockers: ReadonlyArray<string> }) {
  if (blockers.length === 0) {
    return (
      <p
        className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400"
        data-testid="eaos-onboarding-mcp-picker-blockers-clear"
      >
        <CheckCircle2 aria-hidden="true" className="h-3 w-3" />
        No catalog-level blockers.
      </p>
    );
  }
  return (
    <ul
      className="flex flex-col gap-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      data-testid="eaos-onboarding-mcp-picker-blockers"
    >
      {blockers.map((blocker) => (
        <li key={blocker} className="inline-flex items-center gap-1">
          <AlertTriangle aria-hidden="true" className="h-3 w-3" />
          <span>{redactSecretLikeText(blocker)}</span>
        </li>
      ))}
    </ul>
  );
}

function ToolList({ toolNames }: { toolNames: ReadonlyArray<string> }) {
  if (toolNames.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Catalog tools"
      className="flex flex-col gap-1"
      data-testid="eaos-onboarding-mcp-picker-tools"
    >
      <p className="text-xs font-medium text-foreground">Tools surfaced</p>
      <ul className="flex flex-wrap gap-1">
        {toolNames.map((name) => (
          <li
            key={name}
            className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            <span className="font-mono">{name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Could not load verified catalog.";
}
