import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import type {
  CompanySecret,
  CompanySecretProviderConfig,
  RemoteSecretImportCandidate,
  RemoteSecretImportPreviewResult,
  RemoteSecretImportResult,
  RemoteSecretImportRowResult,
} from "@paperclipai/shared";
import { ApiError } from "../../api/client";
import {
  secretsApi,
  type RemoteImportInput,
  type RemoteImportSelectionInput,
} from "../../api/secrets";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "../../lib/utils";
import { describeError } from "@/api/errors";

type Step = "select" | "review" | "result";

interface ImportFromVaultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  providerConfigs: CompanySecretProviderConfig[];
  existingSecrets: CompanySecret[];
  initialProviderConfigId?: string | null;
  onImportComplete?: (result: RemoteSecretImportResult) => void;
  onManageVaults?: () => void;
}

interface DraftSelection {
  candidate: RemoteSecretImportCandidate;
  name: string;
  key: string;
  description: string;
}

const KEY_PATTERN = /^[a-z0-9_.-]+$/;
const PAGE_SIZE = 50;

function isAwsSelectable(config: CompanySecretProviderConfig) {
  if (config.provider !== "aws_secrets_manager") return false;
  return config.status === "ready" || config.status === "warning";
}

function eligibleVaults(configs: CompanySecretProviderConfig[]): CompanySecretProviderConfig[] {
  return configs.filter(isAwsSelectable);
}

function pickDefaultVault(
  configs: CompanySecretProviderConfig[],
  preferredId?: string | null,
): string | null {
  const eligible = eligibleVaults(configs);
  if (eligible.length === 0) return null;
  if (preferredId && eligible.some((vault) => vault.id === preferredId)) {
    return preferredId;
  }
  return (eligible.find((vault) => vault.isDefault) ?? eligible[0]).id;
}

function awsVaultOptions(configs: CompanySecretProviderConfig[]): CompanySecretProviderConfig[] {
  return configs.filter((vault) => vault.provider === "aws_secrets_manager");
}

function formatRelativeShort(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return date.toLocaleDateString();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function readableErrorMessage(error: unknown): string {
  return describeError(error).body;
}

function apiErrorCode(error: ApiError): string | null {
  const body = error.body;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  const details = record.details;
  if (details && typeof details === "object") {
    const code = (details as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function isPermissionError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (apiErrorCode(error) === "access_denied") return true;
  if (error.status === 401 || error.status === 403) return true;
  const message = error.message.toLowerCase(); // query-error-ok: classifies the failure, nothing is rendered here
  return (
    message.includes("accessdenied") ||
    message.includes("access denied") ||
    message.includes("not authorized")
  );
}

function isThrottlingError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (apiErrorCode(error) === "throttled") return true;
  const message = error.message.toLowerCase(); // query-error-ok: classifies the failure, nothing is rendered here
  return message.includes("throttl") || message.includes("toomanyrequests");
}

function buildDraft(candidate: RemoteSecretImportCandidate): DraftSelection {
  return {
    candidate,
    name: candidate.name,
    key: candidate.key,
    description: "",
  };
}

function safeImportProviderMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const safe: Record<string, unknown> = {};
  for (const key of ["createdDate", "lastAccessedDate", "lastChangedDate", "deletedDate"]) {
    const value = metadata[key];
    if (typeof value === "string" || value === null) safe[key] = value;
  }
  for (const key of ["hasDescription", "hasKmsKey", "tagCount"]) {
    const value = metadata[key];
    if (typeof value === "boolean" || typeof value === "number") safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

interface DraftError {
  field: "name" | "key" | "description";
  message: string;
}

function validateDraftRow(
  draft: DraftSelection,
  existing: CompanySecret[],
  otherDrafts: DraftSelection[],
): DraftError | null {
  if (!draft.name.trim()) return { field: "name", message: "Give it a name." };
  if (draft.name.length > 160) {
    return { field: "name", message: "Use 160 characters or fewer for the name." };
  }
  if (!draft.key.trim()) return { field: "key", message: "Give it a key." };
  if (!KEY_PATTERN.test(draft.key)) {
    return {
      field: "key",
      message: "Keys use lowercase letters, numbers, dots, underscores and hyphens.",
    };
  }
  if (draft.key.length > 120) {
    return { field: "key", message: "Use 120 characters or fewer for the key." };
  }
  if (draft.description.length > 500) {
    return {
      field: "description",
      message: "Use 500 characters or fewer for the description.",
    };
  }

  const lowerName = draft.name.trim().toLowerCase();
  const lowerKey = draft.key.trim().toLowerCase();

  for (const existingSecret of existing) {
    if (existingSecret.name.trim().toLowerCase() === lowerName) {
      return { field: "name", message: "A Paperclip secret already uses this name." };
    }
    if (existingSecret.key.trim().toLowerCase() === lowerKey) {
      return { field: "key", message: "A Paperclip secret already uses this key." };
    }
  }

  for (const other of otherDrafts) {
    if (other === draft) continue;
    if (other.name.trim().toLowerCase() === lowerName) {
      return { field: "name", message: "Another secret in this import has the same name." };
    }
    if (other.key.trim().toLowerCase() === lowerKey) {
      return { field: "key", message: "Another secret in this import has the same key." };
    }
  }

  return null;
}

function secretNoun(count: number) {
  return count === 1 ? "secret" : "secrets";
}

const DEFAULT_FAILURE_REASON = "Paperclip could not link this secret.";

function normalizeDraftKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

interface PreviewState {
  candidates: RemoteSecretImportCandidate[];
  nextToken: string | null;
}

const EMPTY_PREVIEW: PreviewState = { candidates: [], nextToken: null };

export function ImportFromVaultDialog({
  open,
  onOpenChange,
  companyId,
  providerConfigs,
  existingSecrets,
  initialProviderConfigId,
  onImportComplete,
  onManageVaults,
}: ImportFromVaultDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToastActions();
  const awsVaults = useMemo(() => awsVaultOptions(providerConfigs), [providerConfigs]);
  const eligible = useMemo(() => eligibleVaults(providerConfigs), [providerConfigs]);
  const noEligibleVaults = eligible.length === 0;

  const [step, setStep] = useState<Step>("select");
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const debouncedQuery = useDebounced(searchInput.trim(), 250);

  const [preview, setPreview] = useState<PreviewState>(EMPTY_PREVIEW);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [showOnlySelected, setShowOnlySelected] = useState(false);

  const [selection, setSelection] = useState<Map<string, DraftSelection>>(new Map());
  const [importResult, setImportResult] = useState<RemoteSecretImportResult | null>(null);
  // Rows that finished (imported or skipped) across every attempt in this session.
  const [completedRows, setCompletedRows] = useState<RemoteSecretImportRowResult[]>([]);
  // Why each remaining row failed on the last attempt, by external reference.
  const [failures, setFailures] = useState<Map<string, string>>(new Map());
  // True after the primary button was pressed while the step could not proceed.
  const [attempted, setAttempted] = useState(false);

  // Reset state on open transition.
  useEffect(() => {
    if (!open) return;
    setStep("select");
    setSearchInput("");
    setPreview(EMPTY_PREVIEW);
    setPreviewError(null);
    setSelection(new Map());
    setImportResult(null);
    setCompletedRows([]);
    setFailures(new Map());
    setAttempted(false);
    setShowOnlySelected(false);
    const next = pickDefaultVault(providerConfigs, initialProviderConfigId);
    setVaultId(next);
    // We deliberately depend only on open so that re-opens reset the dialog;
    // providerConfigs changes during a session are handled by next preview fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const requestIdRef = useRef(0);

  // Run preview when vault or query changes (only on step "select").
  useEffect(() => {
    if (!open || step !== "select" || !vaultId) return;
    let cancelled = false;
    const requestId = ++requestIdRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(EMPTY_PREVIEW);
    secretsApi
      .remoteImportPreview(companyId, {
        providerConfigId: vaultId,
        query: debouncedQuery || null,
        nextToken: null,
        pageSize: PAGE_SIZE,
      })
      .then((result: RemoteSecretImportPreviewResult) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setPreview({
          candidates: result.candidates,
          nextToken: result.nextToken,
        });
      })
      .catch((error) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setPreviewError(error);
      })
      .finally(() => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, step, vaultId, debouncedQuery, companyId]);

  // When the vault changes, drop any selection (they're scoped to a vault).
  useEffect(() => {
    setSelection(new Map());
    setShowOnlySelected(false);
  }, [vaultId]);

  const visibleCandidates = useMemo<RemoteSecretImportCandidate[]>(() => {
    if (!showOnlySelected) return preview.candidates;
    return preview.candidates.filter((candidate) => selection.has(candidate.externalRef));
  }, [preview.candidates, selection, showOnlySelected]);

  const selectableInLoaded = useMemo(
    () => preview.candidates.filter((c) => c.importable),
    [preview.candidates],
  );

  const selectableLoadedCount = selectableInLoaded.length;
  const selectedLoadedCount = selectableInLoaded.filter((c) =>
    selection.has(c.externalRef),
  ).length;

  const headerCheckboxState: boolean | "indeterminate" =
    selectableLoadedCount === 0
      ? false
      : selectedLoadedCount === 0
        ? false
        : selectedLoadedCount === selectableLoadedCount
          ? true
          : "indeterminate";

  const totalSelected = selection.size;
  const selectedNotVisible = useMemo(() => {
    if (!debouncedQuery) return 0;
    let count = 0;
    for (const ref of selection.keys()) {
      if (!preview.candidates.some((c) => c.externalRef === ref)) count += 1;
    }
    return count;
  }, [selection, preview.candidates, debouncedQuery]);

  const draftList = useMemo(() => Array.from(selection.values()), [selection]);

  const reviewErrors = useMemo<Map<string, DraftError>>(() => {
    const errors = new Map<string, DraftError>();
    for (const draft of draftList) {
      const error = validateDraftRow(draft, existingSecrets, draftList);
      if (error) errors.set(draft.candidate.externalRef, error);
    }
    return errors;
  }, [draftList, existingSecrets]);

  const blockedReviewCount = reviewErrors.size;
  const vaultName =
    awsVaults.find((vault) => vault.id === vaultId)?.displayName ?? "your vault";

  const importMutation = useMutation({
    mutationFn: (input: RemoteImportInput) => secretsApi.remoteImport(companyId, input),
    onSuccess: (result) => {
      const failedRows = result.results.filter((row) => row.status === "error");
      const failedRefs = new Set(failedRows.map((row) => row.externalRef));
      setImportResult(result);
      setCompletedRows((prev) => [
        ...prev,
        ...result.results.filter((row) => row.status !== "error"),
      ]);
      setFailures(
        new Map(failedRows.map((row) => [row.externalRef, row.reason ?? DEFAULT_FAILURE_REASON])),
      );
      // Finished rows leave the list; the ones that failed stay to be fixed and retried.
      setSelection((prev) => {
        const next = new Map<string, DraftSelection>();
        for (const [ref, draft] of prev) {
          if (failedRefs.has(ref)) next.set(ref, draft);
        }
        return next;
      });
      setAttempted(false);
      setStep(failedRows.length > 0 ? "review" : "result");
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      onImportComplete?.(result);
      if (result.errorCount === draftList.length && result.errorCount > 0) {
        toast.pushToast({
          title: "Import failed",
          body: `No secrets were imported from ${vaultName}.`,
          tone: "error",
        });
      } else {
        toast.pushToast({
          title: result.errorCount > 0 ? "Some secrets were not imported" : "Import complete",
          body: `${result.importedCount} imported · ${result.skippedCount} already in Paperclip · ${result.errorCount} failed`,
          tone: result.errorCount > 0 ? "warn" : "success",
        });
      }
    },
    onError: (error) => {
      toast.pushToast({
        title: "Import failed",
        body: readableErrorMessage(error),
        tone: "error",
      });
    },
  });

  function handleVaultChange(nextId: string) {
    setVaultId(nextId);
    setSearchInput("");
  }

  function handleRefresh() {
    if (!vaultId || step !== "select") return;
    const requestId = ++requestIdRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    secretsApi
      .remoteImportPreview(companyId, {
        providerConfigId: vaultId,
        query: debouncedQuery || null,
        nextToken: null,
        pageSize: PAGE_SIZE,
      })
      .then((result) => {
        if (requestId !== requestIdRef.current) return;
        setPreview({ candidates: result.candidates, nextToken: result.nextToken });
      })
      .catch((error) => {
        if (requestId !== requestIdRef.current) return;
        setPreviewError(error);
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setPreviewLoading(false);
      });
  }

  function handleLoadMore() {
    if (!vaultId || !preview.nextToken || pageLoading) return;
    setPageLoading(true);
    secretsApi
      .remoteImportPreview(companyId, {
        providerConfigId: vaultId,
        query: debouncedQuery || null,
        nextToken: preview.nextToken,
        pageSize: PAGE_SIZE,
      })
      .then((result) => {
        setPreview((prev) => {
          const seen = new Set(prev.candidates.map((c) => c.externalRef));
          const merged = [...prev.candidates];
          for (const candidate of result.candidates) {
            if (!seen.has(candidate.externalRef)) merged.push(candidate);
          }
          return { candidates: merged, nextToken: result.nextToken };
        });
      })
      .catch((error) => {
        toast.pushToast({
          title: "Could not load more secrets",
          body: readableErrorMessage(error),
          tone: "error",
        });
      })
      .finally(() => setPageLoading(false));
  }

  function toggleRow(candidate: RemoteSecretImportCandidate) {
    if (!candidate.importable) return;
    setSelection((prev) => {
      const next = new Map(prev);
      if (next.has(candidate.externalRef)) {
        next.delete(candidate.externalRef);
      } else {
        next.set(candidate.externalRef, buildDraft(candidate));
      }
      return next;
    });
  }

  function toggleAllLoaded() {
    setSelection((prev) => {
      const next = new Map(prev);
      const allSelected = selectableInLoaded.every((c) => next.has(c.externalRef));
      if (allSelected) {
        for (const candidate of selectableInLoaded) {
          next.delete(candidate.externalRef);
        }
      } else {
        for (const candidate of selectableInLoaded) {
          if (!next.has(candidate.externalRef)) {
            next.set(candidate.externalRef, buildDraft(candidate));
          }
        }
      }
      return next;
    });
  }

  function updateDraft(externalRef: string, patch: Partial<DraftSelection>) {
    setSelection((prev) => {
      const next = new Map(prev);
      const existing = next.get(externalRef);
      if (!existing) return prev;
      next.set(externalRef, { ...existing, ...patch });
      return next;
    });
  }

  function removeDraft(externalRef: string) {
    setSelection((prev) => {
      const next = new Map(prev);
      next.delete(externalRef);
      return next;
    });
  }

  function handleClose(force = false) {
    if (importMutation.isPending) return;
    if (!force && step !== "result" && selection.size > 0 && !importResult) {
      const ok = window.confirm(
        `Discard ${selection.size} pending import${selection.size === 1 ? "" : "s"}?`,
      );
      if (!ok) return;
    }
    onOpenChange(false);
  }

  function handleContinue() {
    if (totalSelected === 0) {
      setAttempted(true);
      return;
    }
    setAttempted(false);
    setStep("review");
  }

  function handleSubmitImport() {
    if (!vaultId || importMutation.isPending) return;
    if (draftList.length === 0) return;
    if (blockedReviewCount > 0) {
      setAttempted(true);
      return;
    }
    setAttempted(false);
    const items: RemoteImportSelectionInput[] = draftList.map((draft) => ({
      externalRef: draft.candidate.externalRef,
      name: draft.name.trim(),
      key: draft.key.trim(),
      description: draft.description.trim() || null,
      providerVersionRef: draft.candidate.providerVersionRef,
      providerMetadata: safeImportProviderMetadata(draft.candidate.providerMetadata),
    }));
    importMutation.mutate({ providerConfigId: vaultId, secrets: items });
  }

  const importing = importMutation.isPending;
  // After an attempt left failures behind, the naming step becomes the place to fix and retry them.
  const retrying = step === "review" && importResult !== null;
  const importedTotal = completedRows.filter((row) => row.status === "imported").length;

  const title =
    step === "select"
      ? "Import secrets from a vault"
      : step === "review"
        ? `Name ${draftList.length} ${secretNoun(draftList.length)}`
        : importedTotal > 0
          ? `${importedTotal} ${secretNoun(importedTotal)} imported`
          : "Nothing new was imported";
  const description =
    step === "select"
      ? "Paperclip links to the secrets you pick. Their values stay in your vault."
      : step === "review"
        ? "These are the names your team and agents will see in Paperclip."
        : importedTotal > 0
          ? "They are linked to your vault and ready to use."
          : "These secrets were already in Paperclip.";

  const blockedMessage =
    !attempted || importing
      ? null
      : step === "select" && totalSelected === 0 && !noEligibleVaults
        ? "Select at least one secret to import."
        : step === "review" && blockedReviewCount > 0
          ? `Fix the ${blockedReviewCount} ${secretNoun(blockedReviewCount)} marked above, then import.`
          : null;

  const showContinue =
    step === "select" && !noEligibleVaults && !(Boolean(previewError) && totalSelected === 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
        } else {
          handleClose();
        }
      }}
    >
      <DialogContent
        className="flex max-h-(--sz-85vh) flex-col gap-4 overflow-hidden p-5 sm:max-w-2xl sm:p-6"
        data-testid="import-from-vault-dialog"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4" aria-live="polite">
          {step === "select" && (
            <SelectStep
              eligible={eligible}
              hasOtherVaults={awsVaults.length > 0}
              vaultId={vaultId}
              vaultName={vaultName}
              onVaultChange={handleVaultChange}
              searchInput={searchInput}
              onSearchInput={setSearchInput}
              debouncedQuery={debouncedQuery}
              onRefresh={handleRefresh}
              previewLoading={previewLoading}
              pageLoading={pageLoading}
              previewError={previewError}
              candidates={preview.candidates}
              visibleCandidates={visibleCandidates}
              selectableInLoaded={selectableInLoaded}
              selection={selection}
              toggleRow={toggleRow}
              toggleAllLoaded={toggleAllLoaded}
              headerCheckboxState={headerCheckboxState}
              hasNextPage={Boolean(preview.nextToken)}
              onLoadMore={handleLoadMore}
              showOnlySelected={showOnlySelected}
              onShowOnlySelectedChange={setShowOnlySelected}
              selectedNotVisible={selectedNotVisible}
              noEligibleVaults={noEligibleVaults}
              onManageVaults={onManageVaults}
            />
          )}
          {step === "review" && (
            <ReviewStep
              drafts={draftList}
              reviewErrors={reviewErrors}
              failures={failures}
              completedRows={completedRows}
              retrying={retrying}
              updateDraft={updateDraft}
              removeDraft={removeDraft}
              importing={importing}
            />
          )}
          {step === "result" && <ResultList rows={completedRows} />}
        </div>

        {blockedMessage && (
          <p role="alert" className="text-sm text-destructive" data-testid="import-blocked-message">
            {blockedMessage}
          </p>
        )}

        <footer
          className={cn(
            "flex items-center gap-3",
            step === "result" ? "justify-end" : "justify-between",
          )}
        >
          {step === "select" && (
            <Button type="button" variant="ghost" onClick={() => handleClose()}>
              Cancel
            </Button>
          )}
          {step === "review" &&
            (retrying ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleClose(true)}
                disabled={importing}
              >
                Close
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setAttempted(false);
                  setStep("select");
                }}
                disabled={importing}
              >
                Back
              </Button>
            ))}
          {showContinue && (
            <Button type="button" onClick={handleContinue}>
              {totalSelected > 0 ? `Continue with ${totalSelected}` : "Continue"}
            </Button>
          )}
          {step === "review" && draftList.length > 0 && (
            <Button type="button" onClick={handleSubmitImport} disabled={importing}>
              {importing && <Loader2 className="animate-spin" aria-hidden />}
              {importing
                ? "Importing…"
                : retrying
                  ? "Try again"
                  : `Import ${draftList.length} ${secretNoun(draftList.length)}`}
            </Button>
          )}
          {step === "result" && (
            <Button type="button" onClick={() => handleClose(true)}>
              Done
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}

const linkClass = "underline underline-offset-4 hover:text-foreground";

interface SelectStepProps {
  eligible: CompanySecretProviderConfig[];
  hasOtherVaults: boolean;
  vaultId: string | null;
  vaultName: string;
  onVaultChange: (id: string) => void;
  searchInput: string;
  onSearchInput: (value: string) => void;
  debouncedQuery: string;
  onRefresh: () => void;
  previewLoading: boolean;
  pageLoading: boolean;
  previewError: unknown;
  candidates: RemoteSecretImportCandidate[];
  visibleCandidates: RemoteSecretImportCandidate[];
  selectableInLoaded: RemoteSecretImportCandidate[];
  selection: Map<string, DraftSelection>;
  toggleRow: (candidate: RemoteSecretImportCandidate) => void;
  toggleAllLoaded: () => void;
  headerCheckboxState: boolean | "indeterminate";
  hasNextPage: boolean;
  onLoadMore: () => void;
  showOnlySelected: boolean;
  onShowOnlySelectedChange: (value: boolean) => void;
  selectedNotVisible: number;
  noEligibleVaults: boolean;
  onManageVaults?: () => void;
}

function SelectStep(props: SelectStepProps) {
  const {
    eligible,
    hasOtherVaults,
    vaultId,
    vaultName,
    onVaultChange,
    searchInput,
    onSearchInput,
    debouncedQuery,
    onRefresh,
    previewLoading,
    pageLoading,
    previewError,
    candidates,
    visibleCandidates,
    selectableInLoaded,
    selection,
    toggleRow,
    toggleAllLoaded,
    headerCheckboxState,
    hasNextPage,
    onLoadMore,
    showOnlySelected,
    onShowOnlySelectedChange,
    selectedNotVisible,
    noEligibleVaults,
    onManageVaults,
  } = props;

  if (noEligibleVaults) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="select-empty-vaults">
        {hasOtherVaults
          ? "None of your vaults is ready to import from yet."
          : "No vault is connected yet."}{" "}
        {onManageVaults && (
          <button type="button" className={linkClass} onClick={onManageVaults}>
            {hasOtherVaults ? "Check them in Vaults" : "Connect one in Vaults"}
          </button>
        )}
      </p>
    );
  }

  const showSearchSpinner = previewLoading && Boolean(debouncedQuery);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {eligible.length === 1 && (
          <span className="shrink-0 text-sm text-muted-foreground" data-testid="vault-static-label">
            {eligible[0].displayName}
          </span>
        )}
        {eligible.length > 1 && (
          <Select value={vaultId ?? undefined} onValueChange={onVaultChange}>
            <SelectTrigger aria-label="Vault">
              <SelectValue placeholder="Choose a vault" />
            </SelectTrigger>
            <SelectContent>
              {eligible.map((vault) => (
                <SelectItem key={vault.id} value={vault.id}>
                  {vault.displayName}
                  {vault.isDefault ? " · default" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="relative min-w-48 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchInput}
            onChange={(event) => onSearchInput(event.target.value)}
            placeholder="Search by name"
            className="pl-9 pr-9"
            aria-label="Search the vault"
            data-testid="vault-search"
          />
          {showSearchSpinner && (
            <Loader2
              className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
              aria-hidden
            />
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          onClick={onRefresh}
          disabled={previewLoading || !vaultId}
          aria-label="Refresh the list"
        >
          <RefreshCw className={cn(previewLoading && "animate-spin")} aria-hidden />
        </Button>
      </div>

      {selectedNotVisible > 0 && (
        <p className="text-xs text-muted-foreground">
          {selection.size} selected. {selectedNotVisible} {selectedNotVisible === 1 ? "is" : "are"}{" "}
          hidden by this search.{" "}
          <button
            type="button"
            className={linkClass}
            onClick={() => onShowOnlySelectedChange(!showOnlySelected)}
          >
            {showOnlySelected ? "Show all" : "Show selected"}
          </button>
        </p>
      )}

      {previewError ? (
        <PreviewError error={previewError} onRetry={onRefresh} onManageVaults={onManageVaults} />
      ) : previewLoading && candidates.length === 0 ? (
        <SkeletonRows rows={8} />
      ) : candidates.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {debouncedQuery
            ? `Nothing in ${vaultName} matches “${debouncedQuery}”.`
            : `Paperclip can't see any secrets in ${vaultName}.`}
        </p>
      ) : (
        <div
          className="flex min-h-0 flex-col overflow-y-auto border-y border-border"
          data-testid="vault-list-scroll"
        >
          <div className="flex items-center gap-3 border-b border-border px-2 py-2 text-xs font-medium text-muted-foreground">
            <Checkbox
              checked={headerCheckboxState}
              onCheckedChange={() => toggleAllLoaded()}
              aria-label={hasNextPage ? "Select all loaded so far" : "Select all"}
              disabled={selectableInLoaded.length === 0}
              data-testid="vault-select-all"
            />
            <span className="min-w-0 flex-1 truncate">Secret in {vaultName}</span>
            <span className="w-24">Last changed</span>
          </div>
          <ul className="divide-y divide-border" data-testid="vault-list">
            {visibleCandidates.map((candidate) => {
              const isSelected = selection.has(candidate.externalRef);
              const meta = (candidate.providerMetadata ?? {}) as Record<string, unknown>;
              const lastChanged =
                typeof meta.lastChangedAt === "string"
                  ? meta.lastChangedAt
                  : typeof meta.lastChangedDate === "string"
                    ? meta.lastChangedDate
                    : null;
              const conflictNote =
                candidate.status === "conflict" ? candidate.conflicts[0]?.message : undefined;
              return (
                <li
                  key={candidate.externalRef}
                  className={cn(
                    "flex items-center gap-3 px-2 py-2.5",
                    candidate.importable
                      ? "cursor-pointer hover:bg-accent/50"
                      : "text-muted-foreground",
                  )}
                  onClick={() => toggleRow(candidate)}
                  data-testid={`vault-row-${candidate.externalRef}`}
                  data-row-state={candidate.status}
                >
                  <span className="flex" onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleRow(candidate)}
                      disabled={!candidate.importable}
                      aria-label={candidate.remoteName}
                    />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-mono text-sm">{candidate.remoteName}</span>
                    {conflictNote && (
                      <span className="text-xs text-muted-foreground">{conflictNote}</span>
                    )}
                  </span>
                  {!candidate.importable && (
                    <span className="shrink-0 text-xs">Already in Paperclip</span>
                  )}
                  <span className="w-24 shrink-0 text-sm tabular-nums text-muted-foreground">
                    {formatRelativeShort(lastChanged)}
                  </span>
                </li>
              );
            })}
          </ul>
          {pageLoading && <SkeletonRows rows={4} />}
          {hasNextPage && (
            <div className="flex items-center justify-between gap-3 border-t border-border px-2 py-2 text-xs text-muted-foreground">
              <span>{candidates.length} shown so far</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onLoadMore}
                disabled={pageLoading}
                data-testid="vault-load-more"
              >
                {pageLoading && <Loader2 className="animate-spin" aria-hidden />}
                {pageLoading ? "Loading…" : `Load ${PAGE_SIZE} more`}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function PreviewError({
  error,
  onRetry,
  onManageVaults,
}: {
  error: unknown;
  onRetry: () => void;
  onManageVaults?: () => void;
}) {
  const isPermission = isPermissionError(error);
  const isThrottling = isThrottlingError(error);
  return (
    <div role="alert" className="flex flex-col gap-2" data-testid="preview-error-banner">
      <p className="flex items-start gap-2 text-sm text-destructive">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          {isPermission
            ? "AWS denied access. Paperclip's role can't list the secrets in this vault."
            : isThrottling
              ? "AWS is limiting requests right now. Wait a moment, then try again."
              : "Paperclip couldn't load the secrets in this vault."}{" "}
          {isPermission && onManageVaults && (
            <button type="button" className="underline underline-offset-4" onClick={onManageVaults}>
              Fix it in Vaults
            </button>
          )}
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        {isPermission ? (
          <>
            The role needs the <code className="font-mono">secretsmanager:ListSecrets</code>{" "}
            permission.{" "}
            <a
              href="https://docs.aws.amazon.com/service-authorization/latest/reference/list_awssecretsmanager.html"
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              AWS permission reference
            </a>
          </>
        ) : (
          readableErrorMessage(error)
        )}
      </p>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-1.5 py-2">
      {Array.from({ length: rows }).map((_, idx) => (
        <Skeleton key={idx} className="h-8 w-full" />
      ))}
    </div>
  );
}

interface ReviewStepProps {
  drafts: DraftSelection[];
  reviewErrors: Map<string, DraftError>;
  failures: Map<string, string>;
  completedRows: RemoteSecretImportRowResult[];
  retrying: boolean;
  updateDraft: (externalRef: string, patch: Partial<DraftSelection>) => void;
  removeDraft: (externalRef: string) => void;
  importing: boolean;
}

function ReviewStep({
  drafts,
  reviewErrors,
  failures,
  completedRows,
  retrying,
  updateDraft,
  removeDraft,
  importing,
}: ReviewStepProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);

  const importedCount = completedRows.filter((row) => row.status === "imported").length;
  const skippedCount = completedRows.length - importedCount;
  const failedCount = drafts.filter((draft) => failures.has(draft.candidate.externalRef)).length;

  return (
    <>
      {retrying && (
        <p
          role="alert"
          className="flex items-start gap-2 text-sm text-destructive"
          data-testid="result-summary"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {importedCount} imported.{" "}
            {skippedCount > 0 && `${skippedCount} already in Paperclip. `}
            {failedCount > 0 &&
              `${failedCount} could not be linked and ${failedCount === 1 ? "is" : "are"} listed below.`}
          </span>
        </p>
      )}

      {drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {retrying
            ? "Nothing left to import."
            : "Nothing left to import. Go back to choose secrets."}
        </p>
      ) : (
        <>
          <button
            type="button"
            className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((current) => !current)}
            data-testid="review-details-toggle"
          >
            <ChevronRight
              className={cn(
                "size-4 transition-transform motion-reduce:transition-none",
                detailsOpen && "rotate-90",
              )}
              aria-hidden
            />
            Keys and descriptions
          </button>
          <ul
            className="flex min-h-0 flex-col divide-y divide-border overflow-y-auto border-y border-border"
            data-testid="review-list"
          >
            {drafts.map((draft) => {
              const ref = draft.candidate.externalRef;
              const remoteName = draft.candidate.remoteName;
              // A validation message for this row, written by this dialog (not an API error).
              const rowProblem = reviewErrors.get(ref);
              const failure = failures.get(ref);
              // A row whose problem is in a tucked-away field always shows that field.
              const showDetails = detailsOpen || (rowProblem !== undefined && rowProblem.field !== "name");
              return (
                <li
                  key={ref}
                  className="flex flex-col gap-1.5 px-2 py-3"
                  data-testid={`review-row-${ref}`}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                        {remoteName}
                      </span>
                      <Input
                        value={draft.name}
                        onChange={(e) => updateDraft(ref, { name: e.target.value })}
                        className="sm:w-64"
                        spellCheck={false}
                        autoComplete="off"
                        aria-label={`Name for ${remoteName}`}
                        aria-invalid={rowProblem?.field === "name"}
                        disabled={importing}
                        data-testid={`review-name-${ref}`}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground"
                      onClick={() => removeDraft(ref)}
                      aria-label={`Leave out ${remoteName}`}
                      disabled={importing}
                    >
                      <X aria-hidden />
                    </Button>
                  </div>
                  {showDetails && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Key
                        <Input
                          value={draft.key}
                          onChange={(e) => updateDraft(ref, { key: e.target.value })}
                          onBlur={(e) =>
                            updateDraft(ref, { key: normalizeDraftKey(e.target.value) })
                          }
                          className="font-mono text-foreground"
                          spellCheck={false}
                          autoComplete="off"
                          aria-invalid={rowProblem?.field === "key"}
                          disabled={importing}
                          data-testid={`review-key-${ref}`}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Description (optional)
                        <Input
                          value={draft.description}
                          onChange={(e) => updateDraft(ref, { description: e.target.value })}
                          className="text-foreground"
                          autoComplete="off"
                          aria-invalid={rowProblem?.field === "description"}
                          disabled={importing}
                          data-testid={`review-description-${ref}`}
                        />
                      </label>
                    </div>
                  )}
                  {rowProblem && (
                    <p
                      role="alert"
                      className="text-xs text-destructive"
                      data-testid={`review-error-${ref}`}
                    >
                      {rowProblem.message}
                    </p>
                  )}
                  {failure && (
                    <p className="text-xs text-destructive" data-testid={`review-failure-${ref}`}>
                      {failure}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {retrying && completedRows.length > 0 && (
        <>
          <button
            type="button"
            className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((current) => !current)}
            data-testid="result-done-toggle"
          >
            <ChevronRight
              className={cn(
                "size-4 transition-transform motion-reduce:transition-none",
                doneOpen && "rotate-90",
              )}
              aria-hidden
            />
            {completedRows.length === 1 ? "The 1 that is done" : `The ${completedRows.length} that are done`}
          </button>
          {doneOpen && <ResultList rows={completedRows} />}
        </>
      )}
    </>
  );
}

/** Rows that need no more attention: imported, or skipped because Paperclip already had them. */
function ResultList({ rows }: { rows: RemoteSecretImportRowResult[] }) {
  return (
    <ul
      className="flex min-h-0 flex-col divide-y divide-border overflow-y-auto border-y border-border"
      data-testid="result-list"
    >
      {rows.map((row) => (
        <li
          key={row.externalRef}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-2 py-2.5"
          data-testid={`result-row-${row.externalRef}`}
          data-row-status={row.status}
        >
          <span className="text-sm">{row.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {row.key}
          </span>
          <span className="text-xs text-muted-foreground">
            {row.status === "imported" ? "Imported" : (row.reason ?? "Already in Paperclip")}
          </span>
        </li>
      ))}
    </ul>
  );
}
