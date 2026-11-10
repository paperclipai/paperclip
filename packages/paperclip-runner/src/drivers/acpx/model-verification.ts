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
  const providerModel = profile.reportedModelId;
  let status = await control.getStatus();
  if (status.models?.currentModelId !== providerModel) {
    if (!control.setModel) {
      throw acpxModelVerificationError(
        "ACPX_MODEL_SELECTION_UNAVAILABLE",
        "ACPX agent cannot verify the requested model through ACP config options",
      );
    }
    // Catalogs may be incomplete. Let the provider accept or reject the exact ID.
    try {
      await control.setModel(providerModel);
    } catch (error) {
      // The provider answered the selection of a model it does not advertise with
      // an ACP error: it rejected that model. Name it as such so the task asks the
      // user to choose a model. Transport failures and an advertised model's
      // rejection keep their original error.
      const advertised = status.models?.availableModelIds ?? [];
      if (!advertised.includes(providerModel) && acpErrorResponse(error)) {
        throw Object.assign(
          new Error(`ACP agent rejected the requested model ${requestedModel}`, { cause: error }),
          { code: "ACP_MODEL_UNSUPPORTED", retryable: false },
        );
      }
      throw error;
    }
    status = await control.getStatus();
  }
  if (status.models?.currentModelId !== providerModel) {
    throw acpxModelVerificationError(
      "ACPX_EFFECTIVE_MODEL_MISMATCH",
      `ACPX effective model mismatch: requested ${requestedModel}, expected ACP selector ${providerModel}, received ${status.models?.currentModelId ?? "unverified"}`,
    );
  }
  return normalizeVerifiedModelStatus(status, profile);
}

/** A JSON-RPC error response from the ACP agent, found on the error or its causes. */
function acpErrorResponse(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;
  const entry = error as Record<string, unknown>;
  if (typeof entry.code === "number" && Number.isInteger(entry.code) && typeof entry.message === "string") return true;
  return ["acp", "cause", "error"].some(key => acpErrorResponse(entry[key], depth + 1));
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
