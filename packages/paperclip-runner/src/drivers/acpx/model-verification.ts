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
    throw new Error("ACPX agent cannot verify its effective model");
  }
  const requestedModel = profile.qualificationModel;
  let status = await control.getStatus();
  const mustSelectCanonical =
    profile.reportedModelId !== requestedModel ||
    status.models?.currentModelId !== requestedModel;
  if (mustSelectCanonical) {
    if (!control.setModel) {
      throw new Error(
        "ACPX agent cannot verify its canonical model through ACP config options",
      );
    }
    await control.setModel(requestedModel);
    status = await control.getStatus();
  }
  if (status.models?.currentModelId !== profile.reportedModelId) {
    throw new Error(
      `ACPX effective model mismatch: requested ${requestedModel}, expected ACP selector ${profile.reportedModelId}, received ${status.models?.currentModelId ?? "unverified"}`,
    );
  }
  return normalizeQualifiedModelStatus(status, profile);
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
