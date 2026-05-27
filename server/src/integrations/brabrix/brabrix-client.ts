import { logger } from "../../middleware/logger.js";
import { resolveBrabrixConfig, type BrabrixConfig, type BrabrixReadyConfig } from "./brabrix-config.js";
import type {
  AgentRun,
  AgentRunStatus,
  BrabrixCompleteTaskInput,
  BrabrixProjectContext,
  BrabrixSendRunLogsInput,
  BrabrixTask,
  ProjectContext,
  SkillContext,
} from "./brabrix-types.js";

type BrabrixEndpointName = keyof BrabrixReadyConfig["endpoints"];
type BrabrixHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type BrabrixTaskPriority = NonNullable<BrabrixTask["priority"]>;

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = ["queued", "running", "completed", "failed", "canceled"];
const BRABRIX_TASK_PRIORITIES: readonly BrabrixTaskPriority[] = ["low", "medium", "high", "critical"];

export class BrabrixHttpError extends Error {
  constructor(
    message: string,
    readonly details: {
      action: string;
      endpoint: BrabrixEndpointName;
      method: BrabrixHttpMethod;
      status?: number;
      responseBody?: string;
      retryable: boolean;
      attempt: number;
      maxAttempts: number;
      url: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "BrabrixHttpError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isAgentRunStatus(value: string): value is AgentRunStatus {
  return AGENT_RUN_STATUSES.includes(value as AgentRunStatus);
}

function isBrabrixTaskPriority(value: string): value is BrabrixTaskPriority {
  return BRABRIX_TASK_PRIORITIES.includes(value as BrabrixTaskPriority);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asNonEmptyString(entry))
    .filter((entry): entry is string => entry !== null);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function readFirstNonEmptyString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asNonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function readFirstStringList(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const values = toStringList(record[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function normalizeSkillContext(value: unknown): SkillContext | null {
  if (!isRecord(value)) return null;
  const skillKey = asNonEmptyString(value.skillKey) ?? asNonEmptyString(value.key);
  const name = asNonEmptyString(value.name) ?? skillKey;
  if (!skillKey || !name) return null;
  return {
    skillKey,
    name,
    version: asNonEmptyString(value.version),
    provider: asNonEmptyString(value.provider),
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

function normalizeAgentRun(value: unknown): AgentRun | null {
  if (!isRecord(value)) return null;
  const runId = asNonEmptyString(value.runId) ?? asNonEmptyString(value.id);
  const agentId = asNonEmptyString(value.agentId);
  const provider = asNonEmptyString(value.provider);
  const status = asNonEmptyString(value.status);
  if (!runId || !agentId || !provider || !status) return null;
  if (!isAgentRunStatus(status)) return null;
  return {
    runId,
    agentId,
    provider,
    status,
    startedAt: asNonEmptyString(value.startedAt),
    finishedAt: asNonEmptyString(value.finishedAt),
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

function normalizeProjectContext(value: unknown, fallbackProjectId: string): ProjectContext | null {
  if (!isRecord(value)) return null;
  const projectId = asNonEmptyString(value.projectId) ?? asNonEmptyString(value.id) ?? fallbackProjectId;
  if (!projectId) return null;

  const skillsRaw = Array.isArray(value.skills)
    ? value.skills
    : Array.isArray(value.skillContext)
      ? value.skillContext
      : [];
  const skills = skillsRaw
    .map(normalizeSkillContext)
    .filter((entry): entry is SkillContext => entry !== null);

  const providers = Array.isArray(value.providers)
    ? value.providers
      .map((provider) => asNonEmptyString(provider))
      .filter((provider): provider is string => provider !== null)
    : undefined;

  return {
    projectId,
    name: asNonEmptyString(value.name) ?? projectId,
    description: asNonEmptyString(value.description),
    skills,
    providers,
    defaultProvider: asNonEmptyString(value.defaultProvider),
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

function normalizeTask(value: unknown): BrabrixTask | null {
  if (!isRecord(value)) return null;
  const payload = isRecord(value.payload) ? value.payload : null;
  const metadata = isRecord(value.metadata) ? value.metadata : null;
  const context = isRecord(value.context)
    ? value.context
    : payload && isRecord(payload.context)
      ? payload.context
      : null;

  const taskId = asNonEmptyString(value.taskId) ?? asNonEmptyString(value.id);
  if (!taskId) return null;
  const title = asNonEmptyString(value.title) ?? asNonEmptyString(value.name) ?? taskId;

  const priorityRaw = asNonEmptyString(value.priority);
  const priority = priorityRaw && isBrabrixTaskPriority(priorityRaw) ? priorityRaw : null;

  const skillsRaw = Array.isArray(value.skillContext)
    ? value.skillContext
    : Array.isArray(value.skills)
      ? value.skills
      : [];
  const skillContext = skillsRaw
    .map(normalizeSkillContext)
    .filter((entry): entry is SkillContext => entry !== null);

  const stack = uniqueStrings([
    ...toStringList(value.stack),
    ...(payload ? readFirstStringList(payload, ["stack", "techStack"]) : []),
    ...(metadata ? readFirstStringList(metadata, ["stack", "techStack"]) : []),
    ...(context ? readFirstStringList(context, ["stack", "techStack"]) : []),
  ]);

  const projectRules = uniqueStrings([
    ...toStringList(value.projectRules),
    ...(payload ? readFirstStringList(payload, ["projectRules", "rules"]) : []),
    ...(metadata ? readFirstStringList(metadata, ["projectRules", "rules"]) : []),
    ...(context ? readFirstStringList(context, ["projectRules", "rules"]) : []),
  ]);

  const acceptanceCriteria = uniqueStrings([
    ...toStringList(value.acceptanceCriteria),
    ...(payload ? readFirstStringList(payload, ["acceptanceCriteria", "acceptance_criteria"]) : []),
    ...(metadata ? readFirstStringList(metadata, ["acceptanceCriteria", "acceptance_criteria"]) : []),
    ...(context ? readFirstStringList(context, ["acceptanceCriteria", "acceptance_criteria"]) : []),
  ]);

  return {
    taskId,
    title,
    description: asNonEmptyString(value.description),
    projectId: asNonEmptyString(value.projectId),
    priority,
    agentTypeHint:
      asNonEmptyString(value.agentTypeHint)
      ?? asNonEmptyString(value.agentProfile)
      ?? asNonEmptyString(value.agentType)
      ?? (payload ? readFirstNonEmptyString(payload, ["agentTypeHint", "agentProfile", "agentType"]) : null),
    prd:
      asNonEmptyString(value.prd)
      ?? asNonEmptyString(value.productRequirementDocument)
      ?? (payload ? readFirstNonEmptyString(payload, ["prd", "productRequirementDocument", "productRequirements"]) : null)
      ?? (context ? readFirstNonEmptyString(context, ["prd", "productRequirementDocument", "productRequirements"]) : null),
    technicalSpec:
      asNonEmptyString(value.technicalSpec)
      ?? asNonEmptyString(value.techSpec)
      ?? asNonEmptyString(value.spec)
      ?? (payload ? readFirstNonEmptyString(payload, ["technicalSpec", "techSpec", "spec", "technicalSpecification"]) : null)
      ?? (context ? readFirstNonEmptyString(context, ["technicalSpec", "techSpec", "spec", "technicalSpecification"]) : null),
    stack,
    projectRules,
    acceptanceCriteria,
    skillContext,
    suggestedRun: normalizeAgentRun(value.suggestedRun ?? value.run ?? value.agentRun),
    payload: payload ?? undefined,
    metadata: metadata ?? undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateForLog(value: string | undefined, maxLength = 500): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

function normalizeAuthToken(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

function isBrabrixApiKeyToken(token: string): boolean {
  return token.startsWith("bbx_");
}

function resolveBrabrixAuthMode(token: string): "x-api-key" | "bearer" {
  return isBrabrixApiKeyToken(token) ? "x-api-key" : "bearer";
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

function applyPathParams(template: string, pathParams: Record<string, string | null | undefined>): string {
  return template.replaceAll(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = pathParams[key];
    if (!value) throw new Error(`Missing path parameter "${key}" for endpoint template "${template}"`);
    return encodeURIComponent(value);
  });
}

function withQueryString(url: string, query: Record<string, string | number | boolean | null | undefined>): string {
  const parsed = new URL(url);
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === null || rawValue === undefined) continue;
    parsed.searchParams.set(key, String(rawValue));
  }
  return parsed.toString();
}

function extractProjectContextPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (isRecord(payload.projectContext)) return payload.projectContext;
  if (isRecord(payload.context)) return payload.context;
  if (isRecord(payload.data) && isRecord(payload.data.projectContext)) return payload.data.projectContext;
  return payload;
}

function extractNextTaskPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (isRecord(payload.task)) return payload.task;
  if (isRecord(payload.nextTask)) return payload.nextTask;
  if (isRecord(payload.data) && isRecord(payload.data.task)) return payload.data.task;
  if (isRecord(payload.data) && isRecord(payload.data.nextTask)) return payload.data.nextTask;
  return payload;
}

export class BrabrixClient {
  private readonly log = logger.child({ service: "brabrix-client" });

  constructor(
    private readonly config: BrabrixConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private resolveReadyConfig(): BrabrixReadyConfig {
    const resolved = resolveBrabrixConfig(this.config);
    if (!resolved) {
      throw new Error(
        "Brabrix integration is not fully configured. Set BRABRIX_AGENT_TOKEN and BRABRIX_PROJECT_ID (optionally override BRABRIX_*_ENDPOINT variables).",
      );
    }
    return resolved;
  }

  private resolveEndpointUrl(
    endpointTemplate: string,
    readyConfig: BrabrixReadyConfig,
    pathParams: Record<string, string | null | undefined>,
  ): string {
    const resolvedTemplate = applyPathParams(endpointTemplate, pathParams);
    if (/^https?:\/\//i.test(resolvedTemplate)) return resolvedTemplate;
    if (!readyConfig.apiUrl) {
      throw new Error(
        `Relative endpoint template "${endpointTemplate}" requires BRABRIX_API_URL to be set.`,
      );
    }
    const normalizedPath = resolvedTemplate.startsWith("/") ? resolvedTemplate : `/${resolvedTemplate}`;
    return new URL(normalizedPath, readyConfig.apiUrl).toString();
  }

  private buildHeaders(
    readyConfig: BrabrixReadyConfig,
    hasBody: boolean,
  ): Record<string, string> {
    const normalizedToken = normalizeAuthToken(readyConfig.agentToken);
    const headers: Record<string, string> = {
      accept: "application/json",
    };

    if (hasBody) {
      headers["content-type"] = "application/json";
    }

    if (resolveBrabrixAuthMode(normalizedToken) === "x-api-key") {
      headers["x-api-key"] = normalizedToken;
    } else {
      headers.authorization = `Bearer ${normalizedToken}`;
    }

    if (readyConfig.provider) {
      headers["x-brabrix-provider"] = readyConfig.provider;
    }
    if (readyConfig.agentId) {
      headers["x-brabrix-agent-id"] = readyConfig.agentId;
    }

    return headers;
  }

  private async request<T>(input: {
    action: string;
    endpoint: BrabrixEndpointName;
    method: BrabrixHttpMethod;
    body?: unknown;
    pathParams?: Record<string, string | null | undefined>;
    query?: Record<string, string | number | boolean | null | undefined>;
  }): Promise<T | null> {
    const readyConfig = this.resolveReadyConfig();
    const authMode = resolveBrabrixAuthMode(normalizeAuthToken(readyConfig.agentToken));
    const maxAttempts = Math.max(1, readyConfig.maxRetries + 1);
    const endpointTemplate = readyConfig.endpoints[input.endpoint];
    const urlWithoutQuery = this.resolveEndpointUrl(
      endpointTemplate,
      readyConfig,
      input.pathParams ?? { projectId: readyConfig.projectId },
    );
    const url = input.query ? withQueryString(urlWithoutQuery, input.query) : urlWithoutQuery;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), readyConfig.timeoutMs);
      try {
        const response = await this.fetcher(url, {
          method: input.method,
          headers: this.buildHeaders(readyConfig, input.body !== undefined),
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const responseBody = truncateForLog(await response.text().catch(() => ""));
          throw new BrabrixHttpError(
            `Brabrix HTTP ${input.method} ${input.endpoint} failed with status ${response.status}`,
            {
              action: input.action,
              endpoint: input.endpoint,
              method: input.method,
              status: response.status,
              responseBody,
              retryable: isRetryableStatus(response.status),
              attempt,
              maxAttempts,
              url,
            },
          );
        }

        if (response.status === 204) return null;
        const bodyText = await response.text();
        if (!bodyText.trim()) return null;
        return JSON.parse(bodyText) as T;
      } catch (error) {
        const knownError = error instanceof BrabrixHttpError
          ? error
          : new BrabrixHttpError(
              `Brabrix HTTP ${input.method} ${input.endpoint} failed: ${error instanceof Error ? error.message : String(error)}`,
              {
                action: input.action,
                endpoint: input.endpoint,
                method: input.method,
                retryable: true,
                attempt,
                maxAttempts,
                url,
                cause: error,
              },
            );

        const durationMs = Date.now() - startedAt;
        const shouldRetry = knownError.details.retryable && attempt < maxAttempts;
        this.log.warn(
          {
            action: input.action,
            endpoint: input.endpoint,
            method: input.method,
            status: knownError.details.status,
            attempt,
            maxAttempts,
            retrying: shouldRetry,
            retryDelayMs: shouldRetry ? readyConfig.retryDelayMs * attempt : 0,
            durationMs,
            authMode,
            url,
            responseBody: knownError.details.responseBody,
            err: knownError.details.cause ?? knownError,
          },
          "brabrix request failed",
        );

        if (!shouldRetry) throw knownError;

        const delayMs = readyConfig.retryDelayMs * attempt;
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    return null;
  }

  async getProjectContext(): Promise<BrabrixProjectContext | null> {
    const readyConfig = this.resolveReadyConfig();
    const endpointTemplate = readyConfig.endpoints.projectContext;
    const projectIdInPath = endpointTemplate.includes("{projectId}");
    const payload = await this.request<unknown>({
      action: "getProjectContext",
      endpoint: "projectContext",
      method: "GET",
      pathParams: {
        projectId: readyConfig.projectId,
        agentId: readyConfig.agentId,
      },
      query: projectIdInPath
        ? undefined
        : {
            projectId: readyConfig.projectId,
          },
    });

    const context = normalizeProjectContext(extractProjectContextPayload(payload), readyConfig.projectId);
    this.log.info(
      {
        projectId: readyConfig.projectId,
        provider: readyConfig.provider,
        hasProjectContext: context !== null,
      },
      "brabrix project context loaded",
    );
    return context;
  }

  async getNextTask(): Promise<BrabrixTask | null> {
    const readyConfig = this.resolveReadyConfig();
    const endpointTemplate = readyConfig.endpoints.nextTask;
    const projectIdInPath = endpointTemplate.includes("{projectId}");
    const payload = await this.request<unknown>({
      action: "getNextTask",
      endpoint: "nextTask",
      method: "GET",
      pathParams: {
        projectId: readyConfig.projectId,
        agentId: readyConfig.agentId,
      },
      query: projectIdInPath
        ? undefined
        : {
            projectId: readyConfig.projectId,
          },
    });

    const task = normalizeTask(extractNextTaskPayload(payload));
    this.log.info(
      {
        projectId: readyConfig.projectId,
        provider: readyConfig.provider,
        taskId: task?.taskId ?? null,
      },
      "brabrix next task fetched",
    );
    return task;
  }

  async sendRunLogs(input: BrabrixSendRunLogsInput): Promise<void> {
    const readyConfig = this.resolveReadyConfig();
    const runId = input.runId ?? input.agentRun?.runId ?? null;
    await this.request<unknown>({
      action: "sendRunLogs",
      endpoint: "sendRunLogs",
      method: "POST",
      pathParams: {
        projectId: readyConfig.projectId,
        taskId: input.taskId ?? null,
        runId,
      },
      body: {
        projectId: readyConfig.projectId,
        provider: readyConfig.provider,
        taskId: input.taskId ?? null,
        runId,
        agentRun: input.agentRun ?? null,
        context: input.context ?? null,
        logs: input.logs,
      },
    });

    this.log.info(
      {
        projectId: readyConfig.projectId,
        taskId: input.taskId ?? null,
        runId,
        logCount: input.logs.length,
      },
      "brabrix run logs sent",
    );
  }

  async completeTask(input: BrabrixCompleteTaskInput): Promise<void> {
    const readyConfig = this.resolveReadyConfig();
    const runId = input.runId ?? input.agentRun?.runId ?? null;
    await this.request<unknown>({
      action: "completeTask",
      endpoint: "completeTask",
      method: "POST",
      pathParams: {
        projectId: readyConfig.projectId,
        taskId: input.taskId,
        runId,
      },
      body: {
        projectId: readyConfig.projectId,
        provider: readyConfig.provider,
        taskId: input.taskId,
        runId,
        agentRun: input.agentRun ?? null,
        status: input.status,
        summary: input.summary ?? null,
        output: input.output ?? null,
      },
    });

    this.log.info(
      {
        projectId: readyConfig.projectId,
        taskId: input.taskId,
        runId,
        status: input.status,
      },
      "brabrix task completed",
    );
  }
}
