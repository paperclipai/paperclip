type DiagnosticLevel = "info" | "error";
type MetadataValue = string | number | boolean | null;
type Metadata = Record<string, MetadataValue>;

interface DiagnosticsContext {
  companyId?: string;
  agentId?: string;
  runId?: string;
  issueId?: string;
  issueIdentifier?: string;
}

interface RedactedContext {
  companyId?: string;
  agentId?: string;
  runId?: string;
  issueId?: string;
  issueIdentifier?: string;
}

export interface DiagnosticsBreadcrumb {
  timestamp: string;
  event: string;
  level: DiagnosticLevel;
  context: RedactedContext;
  metadata?: Metadata;
}

export interface DiagnosticsError {
  id: string;
  timestamp: string;
  name: string;
  message: string;
  stack?: string;
  context: RedactedContext;
  metadata?: Metadata;
}

export interface DiagnosticsSnapshot {
  generatedAt: string;
  sessionId: string;
  context: RedactedContext;
  breadcrumbs: DiagnosticsBreadcrumb[];
  errors: DiagnosticsError[];
}

const MAX_BREADCRUMBS = 200;
const MAX_ERRORS = 50;

let sessionId = createSessionId();
let activeContext: RedactedContext = {};
let breadcrumbs: DiagnosticsBreadcrumb[] = [];
let errors: DiagnosticsError[] = [];

function createSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function redactId(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return "***";
  }

  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function toRedactedContext(context: DiagnosticsContext): RedactedContext {
  return {
    companyId: redactId(context.companyId),
    agentId: redactId(context.agentId),
    runId: redactId(context.runId),
    issueId: redactId(context.issueId),
    issueIdentifier: redactId(context.issueIdentifier),
  };
}

function toMetadataValue(value: unknown): MetadataValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.slice(0, 240);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  return String(value).slice(0, 240);
}

function normalizeMetadata(metadata?: Record<string, unknown>): Metadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const normalized: Metadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    normalized[key] = toMetadataValue(value);
  }
  return normalized;
}

function pushBreadcrumb(entry: DiagnosticsBreadcrumb): void {
  breadcrumbs = [...breadcrumbs, entry].slice(-MAX_BREADCRUMBS);
}

function pushError(entry: DiagnosticsError): void {
  errors = [...errors, entry].slice(-MAX_ERRORS);
}

function toErrorDetails(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "Unknown error",
      stack: error.stack,
    };
  }

  return {
    name: "NonErrorThrow",
    message: String(error),
  };
}

export function resetDiagnosticsSession(context: DiagnosticsContext = {}): void {
  sessionId = createSessionId();
  activeContext = toRedactedContext(context);
  breadcrumbs = [];
  errors = [];

  addDiagnosticsBreadcrumb("diagnostics_session_started", {
    metadata: {
      sessionId,
    },
  });
}

export function setDiagnosticsContext(context: DiagnosticsContext): void {
  activeContext = {
    ...activeContext,
    ...toRedactedContext(context),
  };
}

interface BreadcrumbOptions {
  level?: DiagnosticLevel;
  metadata?: Record<string, unknown>;
  context?: DiagnosticsContext;
}

export function addDiagnosticsBreadcrumb(event: string, options?: BreadcrumbOptions): void {
  const nextContext = options?.context
    ? {
        ...activeContext,
        ...toRedactedContext(options.context),
      }
    : activeContext;

  pushBreadcrumb({
    timestamp: new Date().toISOString(),
    event,
    level: options?.level ?? "info",
    context: nextContext,
    metadata: normalizeMetadata(options?.metadata),
  });
}

interface ErrorOptions {
  metadata?: Record<string, unknown>;
  context?: DiagnosticsContext;
}

export function recordDiagnosticsError(error: unknown, options?: ErrorOptions): DiagnosticsError {
  const details = toErrorDetails(error);
  const errorId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const context = options?.context
    ? {
        ...activeContext,
        ...toRedactedContext(options.context),
      }
    : activeContext;

  const entry: DiagnosticsError = {
    id: errorId,
    timestamp: new Date().toISOString(),
    name: details.name,
    message: details.message,
    stack: details.stack,
    context,
    metadata: normalizeMetadata(options?.metadata),
  };

  pushError(entry);
  addDiagnosticsBreadcrumb("error_recorded", {
    level: "error",
    metadata: {
      errorId,
      errorName: details.name,
      operation: options?.metadata?.operation,
    },
  });

  return entry;
}

export function getDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    sessionId,
    context: activeContext,
    breadcrumbs,
    errors,
  };
}

export function getDiagnosticsSnapshotText(): string {
  return JSON.stringify(getDiagnosticsSnapshot(), null, 2);
}
