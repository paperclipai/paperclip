export interface ServedModelProvenance {
  declaredModel: string | null;
  servedModel: string;
  guardFindings: Array<{
    code: "served_model_drift";
    declaredModel: string;
    servedModel: string;
  }>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Records provider-reported model identity and flags a declared/served mismatch. */
export function buildServedModelProvenance(input: {
  declaredModel: unknown;
  servedModel: unknown;
}): ServedModelProvenance {
  const declaredModel = nonEmptyString(input.declaredModel);
  const servedModel = nonEmptyString(input.servedModel) ?? "unknown";
  const drifted = declaredModel !== null && servedModel !== "unknown" && servedModel !== declaredModel;
  return {
    declaredModel,
    servedModel,
    guardFindings: drifted
      ? [{ code: "served_model_drift", declaredModel, servedModel }]
      : [],
  };
}
