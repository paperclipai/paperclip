import {
  appleAdapterAccountMetadataSchema,
  appleAdapterBoundaryOptionsSchema,
  appleAdapterDeviceMetadataSchema,
  appleAdapterLookupInputSchema,
  type AppleAdapterAccountMetadata,
  type AppleAdapterBoundaryOptions,
  type AppleAdapterDeviceMetadata,
  type AppleAdapterLookupInput,
  type ResolvedAppleAdapterBoundaryOptions,
} from "@paperclipai/shared";

export type AppleAdapterErrorCode = "timeout" | "transient_failure" | "permanent_failure";

export class AppleAdapterError extends Error {
  readonly code: AppleAdapterErrorCode;
  readonly transient: boolean;
  readonly attempt: number | null;
  readonly cause: unknown;

  constructor(
    message: string,
    options: {
      code: AppleAdapterErrorCode;
      transient?: boolean;
      attempt?: number | null;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "AppleAdapterError";
    this.code = options.code;
    this.transient = options.transient ?? (options.code === "timeout" || options.code === "transient_failure");
    this.attempt = options.attempt ?? null;
    this.cause = options.cause;
  }
}

export interface AppleAdapterOperationContext {
  signal: AbortSignal;
  attempt: number;
}

export interface AppleAdapterTransport {
  getAccountMetadata(
    input: AppleAdapterLookupInput,
    context: AppleAdapterOperationContext,
  ): Promise<AppleAdapterAccountMetadata>;
  listDeviceMetadata(
    input: AppleAdapterLookupInput,
    context: AppleAdapterOperationContext,
  ): Promise<AppleAdapterDeviceMetadata[]>;
}

export interface AppleAdapter {
  getAccountMetadata(
    input: AppleAdapterLookupInput,
    options?: AppleAdapterBoundaryOptions,
  ): Promise<AppleAdapterAccountMetadata>;
  listDeviceMetadata(
    input: AppleAdapterLookupInput,
    options?: AppleAdapterBoundaryOptions,
  ): Promise<AppleAdapterDeviceMetadata[]>;
}

export interface MockAppleAdapterOptions {
  account?: Partial<AppleAdapterAccountMetadata>;
  devices?: Array<Partial<AppleAdapterDeviceMetadata>>;
  transientFailuresBeforeSuccess?: number | Partial<Record<keyof AppleAdapterTransport, number>>;
  latencyMs?: number;
  now?: () => Date;
}

const DEFAULT_ACCOUNT_ID = "mock-apple-account";
const DEFAULT_FETCHED_AT = "2026-01-01T00:00:00.000Z";

function resolveBoundaryOptions(options: AppleAdapterBoundaryOptions | undefined): ResolvedAppleAdapterBoundaryOptions {
  return appleAdapterBoundaryOptionsSchema.parse(options ?? {});
}

function isTransientError(err: unknown): boolean {
  return err instanceof AppleAdapterError ? err.transient : false;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (context: { signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  const timeoutError = () => new AppleAdapterError(`Apple adapter operation timed out after ${timeoutMs}ms.`, {
    code: "timeout",
    transient: true,
  });
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(timeoutError());
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      run({ signal: controller.signal }).catch((err) => {
        if (controller.signal.aborted) {
          throw new AppleAdapterError(`Apple adapter operation timed out after ${timeoutMs}ms.`, {
            code: "timeout",
            transient: true,
            cause: err,
          });
        }
        throw err;
      }),
      timeoutPromise,
    ]);
  } catch (err) {
    if (controller.signal.aborted) {
      if (err instanceof AppleAdapterError && err.code === "timeout") throw err;
      throw timeoutError();
    }
    throw err;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  }
}

async function executeWithBoundary<T>(
  options: AppleAdapterBoundaryOptions | undefined,
  operation: (context: AppleAdapterOperationContext) => Promise<T>,
): Promise<T> {
  const resolved = resolveBoundaryOptions(options);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= resolved.retry.maxAttempts; attempt += 1) {
    try {
      return await withTimeout(resolved.timeoutMs, ({ signal }) => operation({ signal, attempt }));
    } catch (err) {
      lastError = err;
      if (!isTransientError(err) || attempt >= resolved.retry.maxAttempts) break;
      await delay(resolved.retry.baseDelayMs * attempt);
    }
  }

  if (lastError instanceof AppleAdapterError) {
    throw new AppleAdapterError(lastError.message, {
      code: lastError.code,
      transient: lastError.transient,
      attempt: lastError.attempt,
      cause: lastError.cause,
    });
  }

  throw new AppleAdapterError("Apple adapter operation failed.", {
    code: "permanent_failure",
    transient: false,
    cause: lastError,
  });
}

export function createAppleAdapter(transport: AppleAdapterTransport): AppleAdapter {
  return {
    getAccountMetadata(input, options) {
      const parsedInput = appleAdapterLookupInputSchema.parse(input);
      return executeWithBoundary(options, async (context) =>
        appleAdapterAccountMetadataSchema.parse(await transport.getAccountMetadata(parsedInput, context))
      );
    },
    listDeviceMetadata(input, options) {
      const parsedInput = appleAdapterLookupInputSchema.parse(input);
      return executeWithBoundary(options, async (context) =>
        (await transport.listDeviceMetadata(parsedInput, context)).map((device) =>
          appleAdapterDeviceMetadataSchema.parse(device)
        )
      );
    },
  };
}

function failureBudget(
  value: MockAppleAdapterOptions["transientFailuresBeforeSuccess"],
  operation: keyof AppleAdapterTransport,
): number {
  if (typeof value === "number") return Math.max(0, value);
  const operationBudget = value?.[operation];
  return typeof operationBudget === "number" ? Math.max(0, operationBudget) : 0;
}

async function simulateLatency(latencyMs: number, signal: AbortSignal): Promise<void> {
  if (latencyMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, latencyMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new AppleAdapterError("Apple adapter mock operation was aborted.", {
        code: "timeout",
        transient: true,
      }));
    }, { once: true });
  });
}

export function createMockAppleAdapter(options: MockAppleAdapterOptions = {}): AppleAdapter {
  const attempts: Record<keyof AppleAdapterTransport, number> = {
    getAccountMetadata: 0,
    listDeviceMetadata: 0,
  };
  const fetchedAt = () => options.now?.().toISOString() ?? DEFAULT_FETCHED_AT;
  const latencyMs = Math.max(0, options.latencyMs ?? 0);

  const maybeFailTransiently = (operation: keyof AppleAdapterTransport): void => {
    attempts[operation] += 1;
    if (attempts[operation] <= failureBudget(options.transientFailuresBeforeSuccess, operation)) {
      throw new AppleAdapterError(`Mock Apple adapter transient failure in ${operation}.`, {
        code: "transient_failure",
        transient: true,
        attempt: attempts[operation],
      });
    }
  };

  const transport: AppleAdapterTransport = {
    async getAccountMetadata(_input, context) {
      maybeFailTransiently("getAccountMetadata");
      await simulateLatency(latencyMs, context.signal);
      return appleAdapterAccountMetadataSchema.parse({
        accountId: DEFAULT_ACCOUNT_ID,
        displayName: "Mock Apple Developer",
        primaryEmail: "developer@example.invalid",
        teamId: "MOCKTEAM1",
        teamName: "Mock Apple Team",
        region: "US",
        fetchedAt: fetchedAt(),
        ...options.account,
      });
    },
    async listDeviceMetadata(_input, context) {
      maybeFailTransiently("listDeviceMetadata");
      await simulateLatency(latencyMs, context.signal);
      const devices = options.devices ?? [
        {
          deviceId: "mock-device-iphone",
          name: "Mock iPhone",
          platform: "ios",
          model: "iPhone",
          osVersion: "18.0",
          serialNumberLast4: "A1B2",
          lastSeenAt: fetchedAt(),
        },
        {
          deviceId: "mock-device-mac",
          name: "Mock Mac",
          platform: "macos",
          model: "Mac",
          osVersion: "15.0",
          serialNumberLast4: "C3D4",
          lastSeenAt: fetchedAt(),
        },
      ];
      return devices.map((device) =>
        appleAdapterDeviceMetadataSchema.parse({
          fetchedAt: fetchedAt(),
          ...device,
        })
      );
    },
  };

  return createAppleAdapter(transport);
}
