import { useEffect, useMemo, useRef, useState } from "react";
import type { AdapterModel } from "../../api/agents";
import {
  isFusionModelId,
  fusionSelectionError,
} from "@paperclipai/adapter-devin-local/ui";
import { Button } from "@/components/ui/button";
import { Field } from "../../components/agent-config-primitives";
import {
  ModelDropdown,
  type ModelDropdownProps,
} from "../../components/ModelDropdown";
import {
  changeFusionFilter,
  devinModelView,
  fillFixedFusionFilters,
  filterFusionModels,
  fusionComponents,
  fusionCostSummary,
  fusionFilterOptions,
  fusionFiltersComplete,
  fusionFiltersForModel,
  fusionRates,
  isFusionOption,
  type DevinModelDraftStatus,
  type FusionFilterKey,
  type FusionFilters,
} from "./model-selection";

export interface DevinModelPickerProps extends ModelDropdownProps {
  scopeKey: string;
  catalogState: "loading" | "ready" | "error";
  catalogError?: string | null;
  customCommand?: boolean;
  onDraftStatusChange: (status: DevinModelDraftStatus) => void;
}

const controlClass =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring";

const FIELD_LABELS: Record<FusionFilterKey, string> = {
  orchestratorModel: "Orchestrator model",
  orchestratorEffort: "Orchestrator effort",
  workerModel: "Worker model",
  workerEffort: "Worker effort",
};

const FILTER_ORDER: FusionFilterKey[] = [
  "orchestratorModel",
  "orchestratorEffort",
  "workerModel",
  "workerEffort",
];

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 10,
});

function formatRate(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? usd.format(value)
    : "Unknown";
}

interface Draft {
  view: "default" | "single" | "fusion";
  filters: FusionFilters;
  selectedUid: string | null;
  pending: boolean;
  message: string | null;
}

export function DevinModelPicker(props: DevinModelPickerProps) {
  return <DevinModelPickerInner key={props.scopeKey} {...props} />;
}

function effortOptionLabel(option: { id: string; label: string }): string {
  return option.id.startsWith("unspecified:")
    ? "Not specified by catalog"
    : option.label;
}

function DevinModelPickerInner({
  models,
  value,
  onChange,
  open,
  onOpenChange,
  allowDefault,
  required,
  groupByProvider,
  creatable,
  detectedModel,
  detectedModelCandidates,
  onDetectModel,
  onRefreshModels,
  refreshingModels,
  detectModelLabel,
  emptyDetectHint,
  defaultLabel,
  scopeKey,
  catalogState,
  catalogError,
  customCommand,
  onDraftStatusChange,
}: DevinModelPickerProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [comboOpen, setComboOpen] = useState(false);
  const [asyncError, setAsyncError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const revisionRef = useRef(0);
  const detectRequestRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const scopeRef = useRef(scopeKey);
  const lastSelectedRef = useRef<{ id: string; entry: AdapterModel } | null>(
    null,
  );
  const lastStatusRef = useRef<DevinModelDraftStatus | null>(null);
  const previousValueRef = useRef(value);
  const lastEmittedRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    scopeRef.current = scopeKey;
  }, [scopeKey]);
  useEffect(() => {
    if (previousValueRef.current === value) return;
    previousValueRef.current = value;
    if (lastEmittedRef.current === value) {
      lastEmittedRef.current = null;
      return;
    }
    lastEmittedRef.current = null;
    revisionRef.current += 1;
    setDraft(null);
  }, [value]);

  const snapshot =
    lastSelectedRef.current && lastSelectedRef.current.id === value
      ? lastSelectedRef.current.entry
      : undefined;
  let canonicalView = devinModelView(value, models);
  if (
    canonicalView === "single" &&
    snapshot &&
    isFusionOption(snapshot)
  ) {
    canonicalView = "fusion";
  }
  const canonicalEntry =
    (value ? models.find((m) => m.id === value) : undefined) ?? snapshot;
  const canonicalFusionUid =
    canonicalEntry && isFusionOption(canonicalEntry)
      ? canonicalEntry.id
      : isFusionModelId(value)
        ? value
        : null;
  const canonicalFilters = useMemo(
    () => fusionFiltersForModel(canonicalEntry),
    [canonicalEntry],
  );

  const view = draft?.view ?? canonicalView;
  const filters = draft?.filters ?? canonicalFilters;
  const selectedUid =
    view === "fusion" ? (draft ? draft.selectedUid : canonicalFusionUid) : null;

  const selectedEntry = selectedUid
    ? models.find((m) => m.id === selectedUid)
    : undefined;
  if (selectedUid && selectedEntry) {
    lastSelectedRef.current = { id: selectedUid, entry: selectedEntry };
  }
  const shownEntry =
    selectedEntry ??
    (selectedUid && lastSelectedRef.current?.id === selectedUid
      ? lastSelectedRef.current.entry
      : undefined);
  const selectedComponents = shownEntry ? fusionComponents(shownEntry) : null;
  const shownRates = shownEntry ? fusionRates(shownEntry) : null;
  const shownCostSummary = shownEntry ? fusionCostSummary(shownEntry) : null;

  const structuredCandidates = useMemo(
    () => filterFusionModels(models, filters),
    [models, filters],
  );
  const opaqueOptions = useMemo(
    () => models.filter((m) => isFusionOption(m) && !fusionComponents(m)),
    [models],
  );
  const comboModels = useMemo(() => {
    const seen = new Set<string>();
    const list: AdapterModel[] = [];
    for (const m of [...structuredCandidates, ...opaqueOptions]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      list.push(m);
    }
    return list;
  }, [structuredCandidates, opaqueOptions]);

  const pending = draft?.pending ?? false;

  const status: DevinModelDraftStatus = useMemo(() => {
    const pristine =
      draft === null ||
      (draft.view === canonicalView &&
        draft.selectedUid === canonicalFusionUid &&
        !draft.pending &&
        JSON.stringify(draft.filters) === JSON.stringify(canonicalFilters));
    return {
      view,
      dirty: !pristine,
      pending,
      message: draft?.message ?? null,
    };
  }, [draft, view, pending, canonicalView, canonicalFusionUid, canonicalFilters]);

  useEffect(() => {
    const previous = lastStatusRef.current;
    if (
      previous &&
      previous.view === status.view &&
      previous.dirty === status.dirty &&
      previous.pending === status.pending &&
      previous.message === status.message
    ) {
      return;
    }
    lastStatusRef.current = status;
    onDraftStatusChange(status);
  }, [status, onDraftStatusChange]);

  const valueError =
    fusionSelectionError(value) ??
    (view === "fusion" && selectedUid !== null
      ? fusionSelectionError(selectedUid)
      : null);

  function bumpRevision() {
    revisionRef.current += 1;
  }

  function emit(uid: string) {
    lastEmittedRef.current = uid;
    onChange(uid);
  }

  function fieldOptions(field: FusionFilterKey) {
    return fusionFilterOptions(models, filters, field);
  }

  function applyFilterChange(field: FusionFilterKey, nextValue: string) {
    bumpRevision();
    setAsyncError(null);
    const changed = changeFusionFilter(models, filters, field, nextValue);
    const nextFilters = fillFixedFusionFilters(models, changed.filters);
    const cleared = new Set<FusionFilterKey>(changed.cleared);
    for (const later of FILTER_ORDER.slice(FILTER_ORDER.indexOf(field) + 1)) {
      if (nextFilters[later] === undefined) continue;
      const prefixFilters = Object.fromEntries(
        FILTER_ORDER.slice(0, FILTER_ORDER.indexOf(later) + 1).flatMap((key) =>
          nextFilters[key] === undefined ? [] : [[key, nextFilters[key]]],
        ),
      );
      if (filterFusionModels(models, prefixFilters).length === 0) {
        delete nextFilters[later];
        cleared.add(later);
      }
    }
    const message = cleared.size
      ? `Cleared ${FILTER_ORDER.filter((key) => cleared.has(key))
          .map((key) => FIELD_LABELS[key])
          .join(", ")}.`
      : null;
    const nextCandidates = filterFusionModels(models, nextFilters);
    const complete = fusionFiltersComplete(nextFilters);
    let nextSelected = selectedUid;
    const structuredFiltering = Object.keys(nextFilters).length > 0;
    const selectedIsOpaque =
      nextSelected !== null &&
      !(selectedEntry && fusionComponents(selectedEntry));
    if (selectedIsOpaque && structuredFiltering) {
      nextSelected = null;
    } else if (
      nextSelected !== null &&
      (!complete || !nextCandidates.some((m) => m.id === nextSelected))
    ) {
      nextSelected = null;
    }
    if (complete && nextCandidates.length === 1) {
      const uid = nextCandidates[0]!.id;
      setDraft({
        view: "fusion",
        filters: nextFilters,
        selectedUid: uid,
        pending: false,
        message,
      });
      emit(uid);
      return;
    }
    setDraft({
      view: "fusion",
      filters: nextFilters,
      selectedUid: nextSelected,
      pending: nextSelected === null,
      message,
    });
  }

  function adoptUid(uid: string) {
    bumpRevision();
    setAsyncError(null);
    const entry = models.find((m) => m.id === uid);
    if (fusionSelectionError(uid)) {
      setDraft({
        view: "fusion",
        filters: {},
        selectedUid: uid || null,
        pending: true,
        message: null,
      });
      emit(uid);
      return;
    }
    if (isFusionModelId(uid) || (entry && isFusionOption(entry))) {
      setDraft({
        view: "fusion",
        filters: fusionFiltersForModel(entry),
        selectedUid: uid || null,
        pending: false,
        message: null,
      });
    } else {
      setDraft(null);
    }
    emit(uid);
  }

  function isCurrent(scope: string, revision: number) {
    return (
      mountedRef.current &&
      scopeRef.current === scope &&
      revisionRef.current === revision
    );
  }

  async function handleDetect() {
    if (!onDetectModel) return;
    bumpRevision();
    setAsyncError(null);
    setDetecting(true);
    const requestId = ++detectRequestRef.current;
    const scope = scopeRef.current;
    const revision = revisionRef.current;
    try {
      const result = await onDetectModel();
      if (!isCurrent(scope, revision)) return;
      if (result) adoptUid(result);
    } catch (error) {
      if (isCurrent(scope, revision)) {
        setAsyncError(
          error instanceof Error ? error.message : "Could not detect the model.",
        );
      }
    } finally {
      if (mountedRef.current && detectRequestRef.current === requestId) {
        setDetecting(false);
      }
    }
  }

  async function handleRefresh() {
    if (!onRefreshModels) return;
    bumpRevision();
    setAsyncError(null);
    setRefreshing(true);
    const requestId = ++refreshRequestRef.current;
    const scope = scopeRef.current;
    const revision = revisionRef.current;
    try {
      await onRefreshModels();
    } catch (error) {
      if (isCurrent(scope, revision)) {
        setAsyncError(
          error instanceof Error ? error.message : "Could not refresh models.",
        );
      }
    } finally {
      if (mountedRef.current && refreshRequestRef.current === requestId) {
        setRefreshing(false);
      }
    }
  }

  function renderFilterSelect(field: FusionFilterKey) {
    const options = fieldOptions(field);
    const fixedSingle =
      options.length === 1 &&
      (options[0]!.id.startsWith("fixed:") ||
        options[0]!.id.startsWith("unspecified:"));
    const pairedModel: FusionFilterKey | null =
      field === "orchestratorEffort"
        ? "orchestratorModel"
        : field === "workerEffort"
          ? "workerModel"
          : null;
    const renderedFixed =
      fixedSingle && (!pairedModel || filters[pairedModel] !== undefined)
        ? options[0]!.id
        : undefined;
    return (
      <Field key={field} label={FIELD_LABELS[field]}>
        <select
          aria-label={FIELD_LABELS[field]}
          className={controlClass}
          value={filters[field] ?? renderedFixed ?? ""}
          disabled={fixedSingle}
          onChange={(event) => applyFilterChange(field, event.target.value)}
        >
          <option value="">{`Select ${FIELD_LABELS[field].toLowerCase()}`}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {effortOptionLabel(option)}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <Field label="Strategy">
        <select
          aria-label="Strategy"
          className={controlClass}
          value={!allowDefault && view === "default" ? "" : view}
          onChange={(event) => {
            bumpRevision();
            setAsyncError(null);
            const next = event.target.value as "default" | "single" | "fusion";
            if (next === "default") {
              setDraft(null);
              emit("");
              return;
            }
            if (next === canonicalView) {
              setDraft(null);
              return;
            }
            setDraft({
              view: next,
              filters: {},
              selectedUid: null,
              pending: true,
              message: null,
            });
          }}
        >
          {!allowDefault && view === "default" && (
            <option value="" disabled>
              Select a strategy
            </option>
          )}
          {allowDefault && <option value="default">CLI default</option>}
          <option value="single">Single model</option>
          <option value="fusion">Fusion</option>
        </select>
      </Field>

      {(onDetectModel || onRefreshModels) && (
        <div className="flex flex-wrap gap-2">
          {onDetectModel && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={detecting}
              onClick={() => void handleDetect()}
            >
              {detecting ? "Detecting…" : (detectModelLabel ?? "Detect model")}
            </Button>
          )}
          {onRefreshModels && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={refreshing || refreshingModels}
              onClick={() => void handleRefresh()}
            >
              {refreshing || refreshingModels
                ? "Refreshing…"
                : "Refresh models"}
            </Button>
          )}
        </div>
      )}

      {view === "default" && allowDefault !== false && (
        <p className="text-xs text-muted-foreground">
          Uses the Devin CLI configuration, which may itself select Fusion.
        </p>
      )}

      {view === "single" && (
        <ModelDropdown
          models={models.filter((m) => !isFusionOption(m))}
          value={canonicalFusionUid ? "" : value}
          onChange={(id) => {
            bumpRevision();
            setAsyncError(null);
            if (fusionSelectionError(id)) {
              setDraft({
                view: "fusion",
                filters: {},
                selectedUid: id,
                pending: true,
                message: null,
              });
            } else {
              setDraft(null);
            }
            emit(id);
          }}
          open={open}
          onOpenChange={onOpenChange}
          allowDefault={allowDefault}
          required={required}
          groupByProvider={groupByProvider}
          creatable={creatable}
          detectedModel={detectedModel}
          detectedModelCandidates={detectedModelCandidates}
          detectModelLabel={detectModelLabel}
          emptyDetectHint={emptyDetectHint}
          defaultLabel={defaultLabel}
        />
      )}

      {view === "fusion" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-3">
              {(["orchestratorModel", "orchestratorEffort"] as const).map(
                renderFilterSelect,
              )}
            </div>
            <div className="min-w-0 space-y-3">
              {(["workerModel", "workerEffort"] as const).map(
                renderFilterSelect,
              )}
            </div>
          </div>

          <ModelDropdown
            models={comboModels}
            value={selectedUid ?? ""}
            onChange={adoptUid}
            open={comboOpen}
            onOpenChange={setComboOpen}
            allowDefault={false}
            required={required}
            groupByProvider={false}
            creatable={creatable}
            label="Combination"
            hint="The exact Fusion combination to run. Opaque entries remain selectable when structured details are unavailable."
          />

          {selectedUid && (
            <div className="space-y-2 rounded-md border border-border p-3 text-xs">
              {selectedComponents ? (
                <dl className="space-y-1">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Orchestrator</dt>
                    <dd>
                      {selectedComponents.orchestrator.modelLabel}
                      {" · "}
                      {selectedComponents.orchestrator.effortLabel}
                      {selectedComponents.orchestrator.modifiers.length > 0 &&
                        ` · ${selectedComponents.orchestrator.modifiers.join(", ")}`}
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Worker</dt>
                    <dd>
                      {selectedComponents.worker.modelLabel}
                      {" · "}
                      {selectedComponents.worker.effortLabel}
                      {selectedComponents.worker.modifiers.length > 0 &&
                        ` · ${selectedComponents.worker.modifiers.join(", ")}`}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="break-words">{shownEntry?.label ?? selectedUid}</p>
              )}
              <p className="break-words text-muted-foreground">
                {shownEntry?.label ?? selectedUid}
              </p>
              {!selectedEntry && (
                <p className="text-muted-foreground">
                  This model ID is not in the current catalog; availability is
                  unverified.
                </p>
              )}
              {selectedUid && !selectedComponents && (
                <p className="text-muted-foreground">
                  Structured orchestrator and worker metadata is unavailable for
                  this entry; it remains selectable as an exact model ID.
                </p>
              )}
              <details>
                <summary>Exact model ID</summary>
                <code className="break-all font-mono text-xs">
                  {selectedUid}
                </code>
              </details>
              {shownEntry?.fusion != null && (
                <dl className="space-y-1">
                  {(["orchestrator", "worker"] as const).map((role) => {
                    const rates = shownRates?.[role] ?? {
                      inputPerMillion: null,
                      cachedInputPerMillion: null,
                      outputPerMillion: null,
                    };
                    return (
                      <div key={role}>
                        <dt className="text-muted-foreground">
                          {role === "orchestrator" ? "Orchestrator" : "Worker"}{" "}
                          rates (per 1M tokens)
                        </dt>
                        <dd>
                          Input {formatRate(rates.inputPerMillion)} · Cached{" "}
                          {formatRate(rates.cachedInputPerMillion)} · Output{" "}
                          {formatRate(rates.outputPerMillion)}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
              {shownCostSummary && (
                <p className="break-words text-muted-foreground">
                  {shownCostSummary}
                </p>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Fusion run-cost reporting may exclude worker usage. These are
            published token rates, not a verified total run cost.
          </p>
        </>
      )}

      {catalogState === "loading" && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading models…
        </p>
      )}
      {catalogState === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {catalogError ??
            "Could not load models. Retry or enter a model ID manually."}
        </p>
      )}
      {asyncError && (
        <p role="alert" className="text-xs text-destructive">
          {asyncError}
        </p>
      )}
      {valueError && (
        <p role="alert" className="text-xs text-destructive">
          {valueError}
        </p>
      )}
      {status.pending && (
        <p role="status" className="text-xs text-muted-foreground">
          {status.message ?? "Complete the model selection before continuing."}
        </p>
      )}
      {!status.pending && status.message && (
        <p role="status" className="text-xs text-muted-foreground">
          {status.message}
        </p>
      )}
      {customCommand && (
        <p className="text-xs text-muted-foreground">
          This catalog comes from the server&apos;s default Devin CLI. Your
          custom command may offer different models.
        </p>
      )}
      {view === "fusion" &&
        comboModels.length === 0 &&
        catalogState === "ready" && (
          <p className="text-xs text-muted-foreground">
            No Fusion combinations were discovered. You can still enter an exact
            model ID manually.
          </p>
        )}
    </div>
  );
}
