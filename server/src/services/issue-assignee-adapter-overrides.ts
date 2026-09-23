import { unprocessable } from "../errors.js";

type AdapterModel = { id: string; label: string };

export function assertKnownIssueAssigneeAdapterModel(
  adapterType: string,
  overrides: unknown,
  models: AdapterModel[],
): void {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return;
  }

  const adapterConfig = (overrides as Record<string, unknown>).adapterConfig;
  if (!adapterConfig || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) {
    return;
  }

  const rawModel = (adapterConfig as Record<string, unknown>).model;
  if (rawModel === undefined) return;
  if (typeof rawModel !== "string" || rawModel.trim() === "") {
    throw unprocessable("Issue assignee adapter override model must be a non-empty string.", {
      code: "issue_assignee_adapter_model_invalid",
      adapterType,
    });
  }

  if (models.length === 0 || models.some((candidate) => candidate.id === rawModel)) {
    return;
  }

  throw unprocessable(
    `Model "${rawModel}" is not available for adapter ${adapterType}.`,
    {
      code: "issue_assignee_adapter_model_unknown",
      adapterType,
      model: rawModel,
      availableModelIds: models.map((candidate) => candidate.id),
    },
  );
}
