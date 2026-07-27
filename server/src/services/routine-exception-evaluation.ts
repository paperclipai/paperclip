import crypto from "node:crypto";
import {
  routineExceptionEvaluationInputV1Schema,
  routineExceptionEvaluationResultV1Schema,
  type RoutineExceptionEvaluationInputV1,
  type RoutineExceptionEvaluationResultV1,
} from "@paperclipai/shared";
import {
  evaluatePolApprovalReleaseV1,
  POL_APPROVAL_RELEASE_CAPABILITIES,
} from "./routine-exception-evaluators/pol-approval-release-v1.js";
import {
  evaluatePolRuntimeSourceOfTruthV1,
  POL_RUNTIME_SOURCE_OF_TRUTH_CAPABILITIES,
} from "./routine-exception-evaluators/pol-runtime-source-of-truth-v1.js";

const MAX_CANONICAL_RESULT_BYTES = 64 * 1024;

export type RoutineExceptionCapabilityBroker = {
  invoke(capabilityId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
};

type EvaluatorHandler = (input: RoutineExceptionEvaluationInputV1, deps: {
  capabilityBroker: RoutineExceptionCapabilityBroker;
  signal: AbortSignal;
}) => Promise<RoutineExceptionEvaluationResultV1>;

type EvaluatorRegistration = {
  evaluatorId: "pol.runtime-source-of-truth.v1" | "pol.approval-release.v1";
  implementationVersion: string;
  evaluatorContractVersion: string;
  inputSchemaVersion: 1;
  timeoutMs: number;
  totalTimeoutMs: number;
  retryDelayMs: number;
  maxAttempts: 2;
  capabilityIds: readonly string[];
  configKeys: readonly string[];
  handler: EvaluatorHandler;
};

export type RoutineExceptionEvaluationProvenance = {
  evaluatorId: string;
  evaluatorContractVersion: string;
  implementationVersion: string;
  serverCommit: string;
  implementationDigest: string;
  bindingDigest: string;
  capabilityIdsUsed: string[];
  attemptCount: number;
  startedAt: string;
  completedAt: string;
};

export type RoutineExceptionEvaluation = {
  result: RoutineExceptionEvaluationResultV1;
  provenance: RoutineExceptionEvaluationProvenance;
};

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validateTypedConfig(
  config: Record<string, unknown>,
  allowedKeys: readonly string[],
) {
  const allowed = new Set(allowedKeys);
  for (const [key, value] of Object.entries(config)) {
    if (!allowed.has(key)) throw new Error(`EVALUATOR_CONFIG_INVALID: unknown key ${key}`);
    const primitive = value === null || ["string", "number", "boolean"].includes(typeof value);
    const secretRef =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 1 &&
      typeof (value as Record<string, unknown>).secretRef === "string";
    if (!primitive && !secretRef) {
      throw new Error(`EVALUATOR_CONFIG_INVALID: invalid value for ${key}`);
    }
  }
}

function unverified(
  code: string,
  affectedResource: string,
  summary: string,
): RoutineExceptionEvaluationResultV1 {
  return {
    schemaVersion: 1,
    outcome: "UNVERIFIABLE",
    severity: "high",
    rootCauseCode: code,
    affectedResource,
    summary,
    evidence: [],
    recoveredFingerprints: [],
    closureCandidates: [],
    retryClass: "NONE",
  };
}

function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("EVALUATOR_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
    operation(controller.signal).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export class RoutineExceptionEvaluatorRegistry {
  readonly #entries = new Map<string, Readonly<EvaluatorRegistration>>();
  readonly #capabilityBroker: RoutineExceptionCapabilityBroker;
  readonly #serverCommit: string;

  constructor(input: {
    capabilityBroker: RoutineExceptionCapabilityBroker;
    serverCommit?: string;
  }) {
    this.#capabilityBroker = input.capabilityBroker;
    this.#serverCommit = input.serverCommit?.trim() || process.env.PAPERCLIP_BUILD_SHA?.trim() || "unknown";
  }

  register(entry: EvaluatorRegistration) {
    if (this.#entries.has(entry.evaluatorId)) throw new Error(`Evaluator already registered: ${entry.evaluatorId}`);
    this.#entries.set(entry.evaluatorId, Object.freeze({ ...entry, capabilityIds: Object.freeze([...entry.capabilityIds]) }));
    return this;
  }

  has(evaluatorId: string) {
    return this.#entries.has(evaluatorId);
  }

  async evaluate(inputValue: unknown): Promise<RoutineExceptionEvaluation> {
    const startedAt = new Date();
    const parsedInput = routineExceptionEvaluationInputV1Schema.safeParse(inputValue);
    if (!parsedInput.success) {
      throw new Error(`RESULT_INPUT_SCHEMA_INVALID: ${parsedInput.error.message}`);
    }
    const input = parsedInput.data;
    const entry = this.#entries.get(input.binding.evaluatorId);
    if (!entry) throw new Error(`UNKNOWN_EVALUATOR: ${input.binding.evaluatorId}`);
    if (input.run.companyId !== input.binding.companyId || input.run.routineId !== input.binding.routineId) {
      throw new Error("BINDING_IDENTITY_MISMATCH");
    }
    if (input.run.routineRevisionId !== input.binding.routineRevisionId) {
      throw new Error("ROUTINE_REVISION_MISMATCH");
    }
    if (
      input.binding.inputSchemaVersion !== entry.inputSchemaVersion ||
      input.binding.evaluatorContractVersion !== entry.evaluatorContractVersion
    ) {
      throw new Error("EVALUATOR_VERSION_MISMATCH");
    }
    validateTypedConfig(input.binding.typedConfig, entry.configKeys);
    const declared = new Set(input.binding.allowedCapabilityIds);
    if (input.binding.allowedCapabilityIds.some((capabilityId) => !entry.capabilityIds.includes(capabilityId))) {
      throw new Error("CAPABILITY_DENIED");
    }

    const used = new Set<string>();
    const scopedBroker: RoutineExceptionCapabilityBroker = {
      invoke: async (capabilityId, capabilityInput, signal) => {
        if (!declared.has(capabilityId) || !entry.capabilityIds.includes(capabilityId)) {
          throw new Error("CAPABILITY_DENIED");
        }
        used.add(capabilityId);
        return this.#capabilityBroker.invoke(capabilityId, capabilityInput, signal);
      },
    };

    let attemptCount = 0;
    let result: RoutineExceptionEvaluationResultV1 | null = null;
    const totalDeadline = startedAt.getTime() + entry.totalTimeoutMs;
    while (attemptCount < entry.maxAttempts && Date.now() < totalDeadline) {
      attemptCount += 1;
      try {
        const timeoutMs = Math.min(entry.timeoutMs, Math.max(1, totalDeadline - Date.now()));
        const raw = await withTimeout(
          (signal) => entry.handler(input, { capabilityBroker: scopedBroker, signal }),
          timeoutMs,
        );
        const parsed = routineExceptionEvaluationResultV1Schema.safeParse(raw);
        if (!parsed.success) {
          result = unverified("RESULT_SCHEMA_INVALID", "evaluator-result", parsed.error.message.slice(0, 2_000));
          break;
        }
        const canonicalResult = canonicalize(parsed.data);
        if (Buffer.byteLength(canonicalResult, "utf8") > MAX_CANONICAL_RESULT_BYTES) {
          result = unverified("RESULT_SIZE_EXCEEDED", parsed.data.affectedResource, "Evaluator result exceeded 64 KiB");
          break;
        }
        result = parsed.data;
        if (result.retryClass !== "TRANSIENT_READ" || attemptCount >= entry.maxAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, entry.retryDelayMs));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message === "EVALUATOR_TIMEOUT"
          ? "EVALUATOR_TIMEOUT"
          : message === "CAPABILITY_DENIED"
            ? "CAPABILITY_DENIED"
            : "EVALUATOR_CRASH";
        result = unverified(code, "evaluator-runtime", message.slice(0, 2_000));
        break;
      }
    }
    result ??= unverified("EVALUATOR_TIMEOUT", "evaluator-runtime", "Evaluator total deadline exhausted");

    const completedAt = new Date();
    return {
      result,
      provenance: {
        evaluatorId: entry.evaluatorId,
        evaluatorContractVersion: entry.evaluatorContractVersion,
        implementationVersion: entry.implementationVersion,
        serverCommit: this.#serverCommit,
        implementationDigest: sha256(entry.handler.toString()),
        bindingDigest: sha256(canonicalize(input.binding)),
        capabilityIdsUsed: [...used].sort(),
        attemptCount,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      },
    };
  }
}

export function createRoutineExceptionEvaluatorRegistry(input: {
  capabilityBroker: RoutineExceptionCapabilityBroker;
  serverCommit?: string;
}) {
  return new RoutineExceptionEvaluatorRegistry(input)
    .register({
      evaluatorId: "pol.runtime-source-of-truth.v1",
      implementationVersion: "1",
      evaluatorContractVersion: "pol.runtime-source-of-truth.v1",
      inputSchemaVersion: 1,
      timeoutMs: 40_000,
      totalTimeoutMs: 90_000,
      retryDelayMs: 250,
      maxAttempts: 2,
      capabilityIds: POL_RUNTIME_SOURCE_OF_TRUTH_CAPABILITIES,
      configKeys: [
        "runtimeBaseBindingId",
        "serviceBindingId",
        "databaseSecretRef",
        "classifierDigest",
        "pythonExecutableId",
      ],
      handler: evaluatePolRuntimeSourceOfTruthV1,
    })
    .register({
      evaluatorId: "pol.approval-release.v1",
      implementationVersion: "1",
      evaluatorContractVersion: "pol.approval-release.v1",
      inputSchemaVersion: 1,
      timeoutMs: 110_000,
      totalTimeoutMs: 240_000,
      retryDelayMs: 500,
      maxAttempts: 2,
      capabilityIds: POL_APPROVAL_RELEASE_CAPABILITIES,
      configKeys: [
        "approvalId",
        "prNumber",
        "runtimeBaseBindingId",
        "githubSecretRef",
        "pythonExecutableId",
      ],
      handler: evaluatePolApprovalReleaseV1,
    });
}

export function createDenyAllRoutineExceptionCapabilityBroker(): RoutineExceptionCapabilityBroker {
  return {
    invoke: async () => {
      throw new Error("CAPABILITY_DENIED");
    },
  };
}

export function createRoutineExceptionFingerprint(input: {
  evaluatorId: string;
  evaluatorContractVersion: string;
  rootCauseCode: string;
  affectedResource: string;
}) {
  return sha256(canonicalize({
    evaluatorId: input.evaluatorId,
    evaluatorContractVersion: input.evaluatorContractVersion,
    rootCauseCode: input.rootCauseCode,
    affectedResource: input.affectedResource,
  }));
}

export function createRoutineExceptionEvidenceDigest(
  result: RoutineExceptionEvaluationResultV1,
) {
  return sha256(canonicalize(result.evidence));
}
