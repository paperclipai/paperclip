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
    await control.setModel(providerModel);
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

export interface AcpxEffectiveModelGate {
  /** Start fresh state for a new provider connection. */
  connect(): void;
  observe(direction: "inbound" | "outbound", message: unknown): void;
  /** Throws unless the provider last reported the expected model. */
  assertActive(): void;
}

const SESSION_OPENS = new Set(["session/new", "session/load", "session/resume"]);
const MODEL_CONTROLS = new Set(["session/set_config_option", "session/set_model"]);

/**
 * Admission verifies the model on the connection it opens, but a cold prompt
 * turn reconnects and loads the session again. ACPX replays the selected
 * model after that load without checking what the provider acknowledged, so
 * this gate reads the provider's own reports from the wire and refuses the
 * prompt (ACPX calls assertActive just before writing it) unless the latest
 * report is the expected model. A load that reports no model leaves the model
 * unverified until a later acknowledgement does.
 */
export function createAcpxEffectiveModelGate(expectedModel: string): AcpxEffectiveModelGate {
  const pending = new Map<string | number, { method: string; value?: unknown }>();
  let current: string | undefined;
  let opened = false;
  return {
    connect() {
      pending.clear();
      current = undefined;
      opened = false;
    },
    observe(direction, message) {
      const value = record(message);
      const id = value.id;
      if (direction === "outbound") {
        if ((typeof id !== "string" && typeof id !== "number") || typeof value.method !== "string") return;
        if (!SESSION_OPENS.has(value.method) && !MODEL_CONTROLS.has(value.method)) return;
        const params = record(value.params);
        if (pending.size < 128) pending.set(id, { method: value.method, value: params.modelId ?? (params.configId === "model" ? params.value : undefined) });
        return;
      }
      if (value.method === "session/update") {
        const update = record(record(value.params).update);
        if (update.sessionUpdate === "config_option_update") {
          const reported = modelFromConfigOptions(update.configOptions);
          if (reported !== undefined) current = reported;
        }
        return;
      }
      if (value.method !== undefined || (typeof id !== "string" && typeof id !== "number")) return;
      const request = pending.get(id);
      pending.delete(id);
      if (!request || value.error !== undefined) return;
      const result = record(value.result);
      const reported = modelFromConfigOptions(result.configOptions) ?? stringValue(record(result.models).currentModelId);
      if (SESSION_OPENS.has(request.method)) {
        opened = true;
        current = reported;
      } else if (reported !== undefined) {
        current = reported;
      } else if (request.method === "session/set_model" && typeof request.value === "string") {
        // The legacy setter has no acknowledgement body; success applies it.
        current = request.value;
      }
    },
    assertActive() {
      if (!opened || current === expectedModel) return;
      throw acpxModelVerificationError(
        "ACPX_EFFECTIVE_MODEL_MISMATCH",
        `ACPX effective model mismatch: expected ACP selector ${expectedModel}, received ${current ?? "unverified"}`,
      );
    },
  };
}

function modelFromConfigOptions(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const option = value.map(record).find(entry => entry.id === "model" || entry.category === "model");
  return option ? stringValue(option.currentValue) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
