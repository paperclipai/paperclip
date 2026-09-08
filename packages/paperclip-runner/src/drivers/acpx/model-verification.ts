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
 * Select and verify the exact qualified model before a billable prompt can be
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
        "ACPX agent cannot verify its qualified model through ACP config options",
      );
    }
    // The caller-facing model is already pinned by resolveQualifiedAcpxProfile.
    // Select the immutable ACP-facing identifier from that same profile: some
    // providers expose a stable selector (for example Claude's `sonnet`) while
    // Paperclip publishes the canonical model name after verification.
    await control.setModel(providerModel);
    status = await control.getStatus();
  }
  if (status.models?.currentModelId !== providerModel) {
    throw acpxModelVerificationError(
      "ACPX_EFFECTIVE_MODEL_MISMATCH",
      `ACPX effective model mismatch: requested ${requestedModel}, expected ACP selector ${providerModel}, received ${status.models?.currentModelId ?? "unverified"}`,
    );
  }
  return normalizeQualifiedModelStatus(status, profile);
}

function acpxModelVerificationError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function normalizeQualifiedModelStatus(
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
