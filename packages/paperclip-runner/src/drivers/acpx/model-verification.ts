import type { QualifiedAcpxProfile } from "./qualified-profiles.js";

export interface AcpxModelStatus {
  models?: {
    currentModelId?: string;
    availableModelIds?: readonly string[];
  };
  [key: string]: unknown;
}

export interface AcpxModelControl {
  getStatus?: () => Promise<AcpxModelStatus>;
  setModel?: (model: string) => Promise<void>;
}

export function needsAdvertisedCursorModel(profile: QualifiedAcpxProfile): boolean {
  return profile.agent === "cursor" && !profile.reportedModelId.includes("[");
}

/** Cursor's CLI lists base names; ACP advertises selectors including settings. */
export function resolveAdvertisedAcpxModel(
  profile: QualifiedAcpxProfile,
  status: AcpxModelStatus,
): string {
  const requested = profile.reportedModelId;
  if (!needsAdvertisedCursorModel(profile)) return requested;
  const advertised = Array.from(new Set([
    ...(status.models?.availableModelIds ?? []),
    ...(status.models?.currentModelId ? [status.models.currentModelId] : []),
  ]));
  if (advertised.includes(requested)) return requested;
  const candidates = advertised.filter(model =>
    model.startsWith(`${requested}[`) && model.endsWith("]"),
  );
  if (candidates.length === 1) return candidates[0]!;
  throw acpxModelVerificationError(
    candidates.length > 1 ? "ACPX_MODEL_SELECTION_AMBIGUOUS" : "ACPX_MODEL_SELECTION_UNAVAILABLE",
    candidates.length > 1
      ? `Cursor advertises multiple selectors for model ${requested}; choose an explicit full model ID`
      : `Cursor does not advertise model ${requested}; choose an available model or an explicit full model ID`,
  );
}

/**
 * Select and verify the exact requested model before a billable prompt can be
 * accepted. A provider selector is normalized only after ACP reports it.
 */
export async function requireVerifiedAcpxModel(
  control: AcpxModelControl,
  profile: QualifiedAcpxProfile,
): Promise<AcpxModelStatus> {
  if (!control.getStatus) {
    throw acpxModelVerificationError(
      "ACPX_MODEL_STATUS_UNAVAILABLE",
      "ACPX agent cannot verify its effective model",
    );
  }
  const requestedModel = profile.qualificationModel;
  let status = await control.getStatus();
  const providerModel = resolveAdvertisedAcpxModel(profile, status);
  if (status.models?.currentModelId !== providerModel) {
    if (!control.setModel) {
      throw acpxModelVerificationError(
        "ACPX_MODEL_SELECTION_UNAVAILABLE",
        "ACPX agent cannot verify the requested model through ACP config options",
      );
    }
    // Catalogs may be incomplete. Let the provider accept or reject the exact ID.
    await control.setModel(providerModel);
    status = await control.getStatus();
  }
  if (status.models?.currentModelId !== providerModel) {
    throw acpxModelVerificationError(
      "ACPX_EFFECTIVE_MODEL_MISMATCH",
      `ACPX effective model mismatch: requested ${requestedModel}, expected ACP selector ${providerModel}, received ${status.models?.currentModelId ?? "unverified"}`,
    );
  }
  return normalizeVerifiedModelStatus(status, { ...profile, reportedModelId: providerModel });
}

function acpxModelVerificationError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function normalizeVerifiedModelStatus(
  status: AcpxModelStatus,
  profile: QualifiedAcpxProfile,
): AcpxModelStatus {
  const available = status.models?.availableModelIds ?? [];
  const normalizedAvailable = Array.from(
    new Set(
      available.map((modelId) =>
        modelId === profile.reportedModelId
          ? profile.qualificationModel
          : modelId,
      ),
    ),
  );
  if (!normalizedAvailable.includes(profile.qualificationModel)) {
    normalizedAvailable.push(profile.qualificationModel);
  }
  return {
    ...status,
    models: {
      ...status.models,
      currentModelId: profile.qualificationModel,
      availableModelIds: normalizedAvailable,
    },
  };
}
