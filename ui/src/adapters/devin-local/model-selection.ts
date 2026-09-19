import type { AdapterModel } from "../../api/agents";
import type {
  AdapterModelFusionComponent,
} from "@paperclipai/adapter-utils";
import {
  isFusionModelId,
  fusionSelectionError,
} from "@paperclipai/adapter-devin-local/ui";

export interface DevinModelDraftStatus {
  view: "default" | "single" | "fusion";
  dirty: boolean;
  pending: boolean;
  message: string | null;
}

export type FusionFilterKey =
  | "orchestratorModel"
  | "orchestratorEffort"
  | "workerModel"
  | "workerEffort";

export type FusionFilters = Partial<Record<FusionFilterKey, string>>;

const fields: FusionFilterKey[] = [
  "orchestratorModel",
  "orchestratorEffort",
  "workerModel",
  "workerEffort",
];

export function devinModelActionError(
  model: string,
  draft: DevinModelDraftStatus,
): string | null {
  return (
    fusionSelectionError(model) ??
    (draft.pending
      ? (draft.message ?? "Complete the model selection before continuing.")
      : null)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isComponent(value: unknown): value is AdapterModelFusionComponent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const component = value as Record<string, unknown>;
  return (
    isNonEmptyString(component.id) &&
    isNonEmptyString(component.modelKey) &&
    isNonEmptyString(component.modelLabel) &&
    isNonEmptyString(component.effortKey) &&
    isNonEmptyString(component.effortLabel) &&
    (component.effortSource === "uid" ||
      component.effortSource === "label_fixed" ||
      component.effortSource === "unspecified") &&
    isNonEmptyString(component.label) &&
    Array.isArray(component.modifiers) &&
    component.modifiers.every((modifier) => typeof modifier === "string")
  );
}

export function fusionComponents(
  model: AdapterModel,
): { orchestrator: AdapterModelFusionComponent; worker: AdapterModelFusionComponent } | null {
  const fusion = model.fusion;
  if (
    !fusion ||
    fusion.version !== 1 ||
    fusion.kind !== "fusion" ||
    !fusion.components
  ) {
    return null;
  }
  const { orchestrator, worker } = fusion.components;
  if (!isComponent(orchestrator) || !isComponent(worker)) return null;
  return { orchestrator, worker };
}

export function isFusionOption(model: AdapterModel): boolean {
  return isFusionModelId(model.id) || model.fusion != null;
}

export type FusionRoleRates = {
  inputPerMillion: number | null;
  cachedInputPerMillion: number | null;
  outputPerMillion: number | null;
};

function isRateSlot(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function isRoleRates(value: unknown): value is FusionRoleRates {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const rates = value as Record<string, unknown>;
  return (
    isRateSlot(rates.inputPerMillion) &&
    isRateSlot(rates.cachedInputPerMillion) &&
    isRateSlot(rates.outputPerMillion)
  );
}

export function fusionRates(
  model: AdapterModel,
): { orchestrator: FusionRoleRates; worker: FusionRoleRates } | null {
  const fusion = model.fusion;
  if (!fusion || fusion.version !== 1 || fusion.kind !== "fusion") return null;
  const rates = fusion.rates;
  if (
    typeof rates !== "object" ||
    rates === null ||
    Array.isArray(rates) ||
    !isRoleRates(rates.orchestrator) ||
    !isRoleRates(rates.worker)
  ) {
    return null;
  }
  return rates;
}

export function fusionCostSummary(model: AdapterModel): string | null {
  const fusion = model.fusion;
  if (!fusion || fusion.version !== 1 || fusion.kind !== "fusion") return null;
  return typeof fusion.costSummary === "string" ? fusion.costSummary : null;
}

function componentValue(
  components: { orchestrator: AdapterModelFusionComponent; worker: AdapterModelFusionComponent },
  field: FusionFilterKey,
): string {
  switch (field) {
    case "orchestratorModel":
      return components.orchestrator.modelKey;
    case "orchestratorEffort":
      return components.orchestrator.effortKey;
    case "workerModel":
      return components.worker.modelKey;
    case "workerEffort":
      return components.worker.effortKey;
  }
}

function componentLabel(
  components: { orchestrator: AdapterModelFusionComponent; worker: AdapterModelFusionComponent },
  field: FusionFilterKey,
): string {
  switch (field) {
    case "orchestratorModel":
      return components.orchestrator.modelLabel;
    case "orchestratorEffort":
      return components.orchestrator.effortLabel;
    case "workerModel":
      return components.worker.modelLabel;
    case "workerEffort":
      return components.worker.effortLabel;
  }
}

function matches(
  model: AdapterModel,
  filters: FusionFilters,
  through?: FusionFilterKey,
): boolean {
  const components = fusionComponents(model);
  if (!components) return false;
  const limit = through ? fields.indexOf(through) : fields.length - 1;
  for (let index = 0; index <= limit; index += 1) {
    const field = fields[index]!;
    const expected = filters[field];
    if (expected === undefined) continue;
    if (componentValue(components, field) !== expected) return false;
  }
  return true;
}

export function filterFusionModels(
  models: readonly AdapterModel[],
  filters: FusionFilters,
): AdapterModel[] {
  return models.filter((model) => isFusionOption(model) && matches(model, filters));
}

export function fusionFilterOptions(
  models: readonly AdapterModel[],
  filters: FusionFilters,
  field: FusionFilterKey,
): Array<{ id: string; label: string }> {
  const preceding = fields.slice(0, fields.indexOf(field));
  const labelsById = new Map<string, Set<string>>();
  for (const model of models) {
    if (!isFusionOption(model)) continue;
    const components = fusionComponents(model);
    if (!components) continue;
    if (
      !preceding.every(
        (key) =>
          filters[key] === undefined ||
          componentValue(components, key) === filters[key],
      )
    ) {
      continue;
    }
    const id = componentValue(components, field);
    const label = componentLabel(components, field);
    const seen = labelsById.get(id) ?? new Set<string>();
    seen.add(label);
    labelsById.set(id, seen);
  }
  return [...labelsById.entries()]
    .map(([id, labels]) => ({
      id,
      label: labels.size === 1 ? [...labels][0]! : id,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function changeFusionFilter(
  models: readonly AdapterModel[],
  filters: FusionFilters,
  field: FusionFilterKey,
  value: string,
): { filters: FusionFilters; cleared: FusionFilterKey[] } {
  const next: FusionFilters = { ...filters };
  if (value) next[field] = value;
  else delete next[field];
  const cleared: FusionFilterKey[] = [];
  for (const later of fields.slice(fields.indexOf(field) + 1)) {
    if (next[later] === undefined) continue;
    const preserved = models.some(
      (model) => isFusionOption(model) && matches(model, next, later),
    );
    if (!preserved) {
      delete next[later];
      cleared.push(later);
    }
  }
  return { filters: next, cleared };
}

export function fillFixedFusionFilters(
  models: readonly AdapterModel[],
  filters: FusionFilters,
): FusionFilters {
  const next: FusionFilters = { ...filters };
  for (const field of fields) {
    if (next[field] !== undefined) continue;
    const modelField: FusionFilterKey =
      field === "orchestratorEffort"
        ? "orchestratorModel"
        : field === "workerEffort"
          ? "workerModel"
          : field;
    if (modelField === field) continue;
    if (next[modelField] === undefined) continue;
    const options = fusionFilterOptions(models, next, field);
    if (
      options.length === 1 &&
      (options[0]!.id.startsWith("fixed:") ||
        options[0]!.id.startsWith("unspecified:"))
    ) {
      next[field] = options[0]!.id;
    }
  }
  return next;
}

export function fusionFiltersComplete(filters: FusionFilters): boolean {
  return fields.every((field) => filters[field] !== undefined);
}

export function fusionFiltersForModel(model: AdapterModel | undefined): FusionFilters {
  const components = model ? fusionComponents(model) : null;
  if (!components) return {};
  return {
    orchestratorModel: components.orchestrator.modelKey,
    orchestratorEffort: components.orchestrator.effortKey,
    workerModel: components.worker.modelKey,
    workerEffort: components.worker.effortKey,
  };
}

export function devinModelView(
  model: string,
  models: readonly AdapterModel[],
): "default" | "single" | "fusion" {
  if (!model) return "default";
  if (isFusionModelId(model)) return "fusion";
  const entry = models.find((candidate) => candidate.id === model);
  if (entry && isFusionOption(entry)) return "fusion";
  return "single";
}
