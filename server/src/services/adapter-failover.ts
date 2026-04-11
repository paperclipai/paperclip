import {
  parseFailoverModelList,
  type AdapterExecutionResult,
  type AdapterModel,
} from "@paperclipai/adapter-utils";

const RETRYABLE_MODEL_FAILURE_PATTERN =
  /(?:\b429\b|resource_exhausted|quota|rate[-\s]?limit|too many requests|billing details)/i;

const CROSS_ADAPTER_SAFE_CONFIG_KEYS = [
  "cwd",
  "instructionsFilePath",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "env",
  "timeoutSec",
  "graceSec",
  "extraArgs",
  "workspaceStrategy",
  "workspaceRuntime",
  "maxTurnsPerRun",
  "dangerouslySkipPermissions",
  "paperclipRuntimeSkills",
  "paperclipRuntimeServices",
  "sandbox",
  "approvalMode",
] as const;

export interface AdapterFailoverAttempt {
  adapterType: string;
  model: string | null;
  config: Record<string, unknown>;
  usesFailover: boolean;
}

export interface AdapterFailoverExecution<T> {
  attempt: AdapterFailoverAttempt;
  result: T;
}

export interface AdapterFailoverResolution {
  attempts: AdapterFailoverAttempt[];
  warnings: string[];
}

export function isRetryableAdapterFailure(
  result: Pick<AdapterExecutionResult, "errorCode" | "errorMessage" | "timedOut">,
): boolean {
  if (result.timedOut) {
    return false;
  }

  const errorCode = typeof result.errorCode === "string" ? result.errorCode : "";
  const errorMessage = typeof result.errorMessage === "string" ? result.errorMessage : "";
  return RETRYABLE_MODEL_FAILURE_PATTERN.test(`${errorCode}\n${errorMessage}`);
}

export function shouldPersistSessionForAttempt(
  attempt: AdapterFailoverAttempt,
  primaryAdapterType: string,
  primaryModel: string | null,
): boolean {
  return !attempt.usesFailover
    && attempt.adapterType === primaryAdapterType
    && attempt.model === primaryModel;
}

export function buildFailoverAdapterConfig(input: {
  primaryAdapterType: string;
  targetAdapterType: string;
  baseConfig: Record<string, unknown>;
  model: string;
}): Record<string, unknown> {
  if (input.targetAdapterType === input.primaryAdapterType) {
    return {
      ...input.baseConfig,
      model: input.model,
    };
  }

  const next: Record<string, unknown> = {};
  for (const key of CROSS_ADAPTER_SAFE_CONFIG_KEYS) {
    if (input.baseConfig[key] !== undefined) {
      next[key] = input.baseConfig[key];
    }
  }
  next.model = input.model;
  return next;
}

export async function buildAdapterFailoverPlan(input: {
  primaryAdapterType: string;
  runtimeConfig: Record<string, unknown>;
  resolveModels: (adapterType: string) => Promise<AdapterModel[]>;
  listAdapterTypes: () => string[];
}): Promise<AdapterFailoverResolution> {
  const primaryModel =
    typeof input.runtimeConfig.model === "string" && input.runtimeConfig.model.trim().length > 0
      ? input.runtimeConfig.model.trim()
      : null;
  const failoverModels = parseFailoverModelList(input.runtimeConfig.failoverModels);
  const attempts: AdapterFailoverAttempt[] = [
    {
      adapterType: input.primaryAdapterType,
      model: primaryModel,
      config: input.runtimeConfig,
      usesFailover: false,
    },
  ];
  const warnings: string[] = [];

  if (failoverModels.length === 0) {
    return { attempts, warnings };
  }

  const adapterTypes = input.listAdapterTypes();
  const modelCache = new Map<string, AdapterModel[]>();

  const getModels = async (adapterType: string) => {
    if (!modelCache.has(adapterType)) {
      modelCache.set(adapterType, await input.resolveModels(adapterType));
    }
    return modelCache.get(adapterType) ?? [];
  };

  const primaryModels = await getModels(input.primaryAdapterType);

  for (const failoverModel of failoverModels) {
    if (failoverModel === primaryModel) {
      continue;
    }

    let targetAdapterType: string | null =
      primaryModels.some((entry) => entry.id === failoverModel) ? input.primaryAdapterType : null;

    if (!targetAdapterType) {
      for (const adapterType of adapterTypes) {
        if (adapterType === input.primaryAdapterType) continue;
        const models = await getModels(adapterType);
        if (models.some((entry) => entry.id === failoverModel)) {
          targetAdapterType = adapterType;
          break;
        }
      }
    }

    if (!targetAdapterType) {
      warnings.push(`No adapter model catalog matched failover model "${failoverModel}".`);
      continue;
    }

    attempts.push({
      adapterType: targetAdapterType,
      model: failoverModel,
      config: buildFailoverAdapterConfig({
        primaryAdapterType: input.primaryAdapterType,
        targetAdapterType,
        baseConfig: input.runtimeConfig,
        model: failoverModel,
      }),
      usesFailover: true,
    });
  }

  return { attempts, warnings };
}

export async function executeWithAdapterFailover<T extends AdapterExecutionResult>(input: {
  attempts: AdapterFailoverAttempt[];
  executeAttempt: (attempt: AdapterFailoverAttempt) => Promise<T>;
  onFailover?: (current: AdapterFailoverExecution<T>, nextAttempt: AdapterFailoverAttempt) => Promise<void> | void;
}): Promise<{
  attempt: AdapterFailoverAttempt;
  result: T;
  trail: Array<AdapterFailoverExecution<T>>;
}> {
  const trail: Array<AdapterFailoverExecution<T>> = [];

  for (let index = 0; index < input.attempts.length; index += 1) {
    const attempt = input.attempts[index]!;
    const result = await input.executeAttempt(attempt);
    trail.push({ attempt, result });

    const nextAttempt = input.attempts[index + 1];
    if (!nextAttempt || !attempt.usesFailover && !isRetryableAdapterFailure(result)) {
      return { attempt, result, trail };
    }

    if (nextAttempt && isRetryableAdapterFailure(result)) {
      await input.onFailover?.({ attempt, result }, nextAttempt);
      continue;
    }

    return { attempt, result, trail };
  }

  throw new Error("Adapter failover plan contained no attempts");
}
