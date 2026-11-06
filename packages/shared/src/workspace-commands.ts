import type { WorkspaceCommandDefinition, WorkspaceRuntimeService } from "./types/workspace-runtime.js";
import { forceLoopbackBindInCommand } from "./runtime-exposure/loopback-bind.js";

type WorkspaceRuntimeServiceMatchCandidate =
  & Pick<WorkspaceRuntimeService, "configIndex" | "serviceName" | "command" | "cwd">
  & Pick<Partial<WorkspaceRuntimeService>, "exposure" | "port">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readConfiguredPort(value: unknown): number | null {
  if (isRecord(value) && value.type === "auto") return null;
  const candidate = isRecord(value) ? value.value : value;
  return typeof candidate === "number"
    && Number.isInteger(candidate)
    && candidate > 0
    && candidate <= 65_535
    ? candidate
    : null;
}

function slugify(value: string | null | undefined) {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : null;
}

function deriveWorkspaceCommandId(input: {
  kind: WorkspaceCommandDefinition["kind"];
  explicitId: string | null;
  name: string;
  index: number;
}) {
  const explicitId = slugify(input.explicitId);
  if (explicitId) return explicitId;
  const nameSlug = slugify(input.name);
  return nameSlug ? `${input.kind}:${nameSlug}` : `${input.kind}:${input.index + 1}`;
}

function buildWorkspaceCommandDefinition(input: {
  entry: Record<string, unknown>;
  kind: WorkspaceCommandDefinition["kind"];
  sourceKey: WorkspaceCommandDefinition["source"]["key"];
  sourceIndex: number;
  serviceIndex: number | null;
  fallbackName: string;
}): WorkspaceCommandDefinition {
  return {
    id: deriveWorkspaceCommandId({
      kind: input.kind,
      explicitId: readNonEmptyString(input.entry.id),
      name:
        readNonEmptyString(input.entry.name)
        ?? readNonEmptyString(input.entry.label)
        ?? readNonEmptyString(input.entry.title)
        ?? input.fallbackName,
      index: input.sourceIndex,
    }),
    name:
      readNonEmptyString(input.entry.name)
      ?? readNonEmptyString(input.entry.label)
      ?? readNonEmptyString(input.entry.title)
      ?? input.fallbackName,
    kind: input.kind,
    command: readNonEmptyString(input.entry.command),
    cwd: readNonEmptyString(input.entry.cwd),
    port: readConfiguredPort(input.entry.port),
    lifecycle:
      input.kind === "service"
        ? input.entry.lifecycle === "ephemeral"
          ? "ephemeral"
          : "shared"
        : null,
    serviceIndex: input.serviceIndex,
    disabledReason: readNonEmptyString(input.entry.disabledReason),
    rawConfig: { ...input.entry },
    source: {
      type: "paperclip",
      key: input.sourceKey,
      index: input.sourceIndex,
    },
  };
}

function uniqueWorkspaceCommandId(
  seen: Set<string>,
  commandId: string,
  sourceKey: WorkspaceCommandDefinition["source"]["key"],
  sourceIndex: number,
) {
  if (!seen.has(commandId)) {
    seen.add(commandId);
    return commandId;
  }
  const fallbackId = `${commandId}-${sourceKey}-${sourceIndex + 1}`;
  seen.add(fallbackId);
  return fallbackId;
}

function readCommandEntries(
  workspaceRuntime: Record<string, unknown> | null | undefined,
  key: "commands" | "services" | "jobs",
) {
  const raw = workspaceRuntime?.[key];
  return Array.isArray(raw) ? raw.filter((entry): entry is Record<string, unknown> => isRecord(entry)) : [];
}

export function listWorkspaceCommandDefinitions(
  workspaceRuntime: Record<string, unknown> | null | undefined,
): WorkspaceCommandDefinition[] {
  if (!workspaceRuntime) return [];

  const commandEntries = readCommandEntries(workspaceRuntime, "commands");
  const seenIds = new Set<string>();
  let nextServiceIndex = 0;

  const finalize = (command: WorkspaceCommandDefinition) => ({
    ...command,
    id: uniqueWorkspaceCommandId(seenIds, command.id, command.source.key, command.source.index),
  });

  if (commandEntries.length > 0) {
    return commandEntries.map((entry, index) =>
      finalize(buildWorkspaceCommandDefinition({
        entry,
        kind: entry.kind === "job" ? "job" : "service",
        sourceKey: "commands",
        sourceIndex: index,
        serviceIndex: entry.kind === "job" ? null : nextServiceIndex++,
        fallbackName: entry.kind === "job" ? `Job ${index + 1}` : `Service ${index + 1}`,
      })));
  }

  const serviceDefinitions = readCommandEntries(workspaceRuntime, "services").map((entry, index) =>
    finalize(buildWorkspaceCommandDefinition({
      entry,
      kind: "service",
      sourceKey: "services",
      sourceIndex: index,
      serviceIndex: nextServiceIndex++,
      fallbackName: `Service ${index + 1}`,
    })));
  const jobDefinitions = readCommandEntries(workspaceRuntime, "jobs").map((entry, index) =>
    finalize(buildWorkspaceCommandDefinition({
      entry,
      kind: "job",
      sourceKey: "jobs",
      sourceIndex: index,
      serviceIndex: null,
      fallbackName: `Job ${index + 1}`,
    })));

  return [...serviceDefinitions, ...jobDefinitions];
}

export function listWorkspaceServiceCommandDefinitions(
  workspaceRuntime: Record<string, unknown> | null | undefined,
) {
  return listWorkspaceCommandDefinitions(workspaceRuntime).filter((command) => command.kind === "service");
}

export function findWorkspaceCommandDefinition(
  workspaceRuntime: Record<string, unknown> | null | undefined,
  workspaceCommandId: string | null | undefined,
) {
  const normalizedId = readNonEmptyString(workspaceCommandId);
  if (!normalizedId) return null;
  return listWorkspaceCommandDefinitions(workspaceRuntime).find((command) => command.id === normalizedId) ?? null;
}

export function scoreWorkspaceRuntimeServiceMatch(
  command: Pick<WorkspaceCommandDefinition, "serviceIndex" | "name" | "command" | "cwd" | "port">,
  runtimeService: WorkspaceRuntimeServiceMatchCandidate,
) {
  const exposedCommandMatches = Boolean(
    command.command
    && runtimeService.command
    && runtimeService.exposure?.provider === "tailscale_https"
    && runtimeService.command === forceLoopbackBindInCommand(command.command),
  );
  if (
    command.command
    && runtimeService.command
    && runtimeService.command !== command.command
    && !exposedCommandMatches
  ) {
    return -1;
  }

  if (command.port !== null && runtimeService.port != null && runtimeService.port !== command.port) {
    return -1;
  }

  if (command.serviceIndex !== null && runtimeService.configIndex !== null && runtimeService.configIndex !== undefined) {
    if (runtimeService.configIndex !== command.serviceIndex) return -1;
    return 100 + (command.port !== null && runtimeService.port === command.port ? 8 : 0);
  }

  let score = 0;
  if (command.port !== null && runtimeService.port === command.port) score += 8;
  if (runtimeService.serviceName === command.name) score += 4;
  if ((runtimeService.command ?? null) === (command.command ?? null)) score += 4;
  if (
    command.cwd
    && runtimeService.cwd
    && (runtimeService.cwd === command.cwd || runtimeService.cwd.endsWith(`/${command.cwd}`))
  ) {
    score += 2;
  }
  return score;
}

export function matchWorkspaceRuntimeServiceToCommand<
  T extends WorkspaceRuntimeServiceMatchCandidate,
>(
  command: Pick<WorkspaceCommandDefinition, "serviceIndex" | "name" | "command" | "cwd" | "port">,
  runtimeServices: T[] | null | undefined,
) {
  let bestMatch: T | null = null;
  let bestScore = -1;

  for (const runtimeService of runtimeServices ?? []) {
    const score = scoreWorkspaceRuntimeServiceMatch(command, runtimeService);
    if (score > bestScore) {
      bestMatch = runtimeService;
      bestScore = score;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

/**
 * Resolves what a stop (or the stop half of a restart) may touch. A request
 * that names one service, by runtime service id, workspace command, or
 * service index, must stop only that service: `runtimeServiceId` is its
 * running instance, or null when it has none, so nothing is stopped. A
 * request with no target stops every service (`scope: "all"`).
 */
function normalizePosixPath(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * Resolves a configured service cwd against the workspace cwd the way the
 * start path does, defaulting to the workspace root. Returns null for a cwd
 * that cannot be resolved here, such as a template or a home-relative path.
 */
function resolveConfiguredServiceCwd(configuredCwd: string | null, workspaceCwd: string | null | undefined) {
  const cwd = configuredCwd ?? ".";
  if (cwd.includes("{{") || cwd.startsWith("~")) return null;
  if (cwd.startsWith("/")) return normalizePosixPath(cwd);
  if (!workspaceCwd) return null;
  return normalizePosixPath(`${workspaceCwd}/${cwd}`);
}

function resolveExpectedServiceCwd<T>(
  command: WorkspaceCommandDefinition,
  runtimeService: T,
  input: {
    workspaceCwd?: string | null;
    resolveServiceCwd?: (command: WorkspaceCommandDefinition, runtimeService: T) => string | null;
  },
) {
  if (!input.resolveServiceCwd) return resolveConfiguredServiceCwd(command.cwd, input.workspaceCwd);
  try {
    return input.resolveServiceCwd(command, runtimeService);
  } catch {
    return null;
  }
}

function sameCwd(left: string, right: string) {
  return (normalizePosixPath(left) ?? left) === (normalizePosixPath(right) ?? right);
}

function runtimeServiceNameForCommand(command: Pick<WorkspaceCommandDefinition, "rawConfig">) {
  const rawName = command.rawConfig.name;
  return typeof rawName === "string" && rawName.length > 0 ? rawName : "service";
}

export function resolveRuntimeServiceStopTarget<T extends WorkspaceRuntimeServiceMatchCandidate & { id: string }>(input: {
  workspaceRuntime: Record<string, unknown> | null | undefined;
  runtimeServiceId: string | null | undefined;
  serviceIndex: number | null | undefined;
  runtimeServices: T[] | null | undefined;
  workspaceCwd?: string | null;
  /**
   * Resolves the cwd a configured service runs in when started as the given
   * running instance (for example with its assigned port), exactly as the
   * start path does. Servers pass this so `~` and templated cwds compare
   * correctly; without it, only plain and workspace-relative cwds can be
   * compared.
   */
  resolveServiceCwd?: (command: WorkspaceCommandDefinition, runtimeService: T) => string | null;
}): { scope: "all" } | { scope: "one"; runtimeServiceId: string | null } {
  if (input.runtimeServiceId) return { scope: "one", runtimeServiceId: input.runtimeServiceId };
  if (input.serviceIndex === null || input.serviceIndex === undefined) return { scope: "all" };
  // Stopping is destructive, so a shared command alone is not enough: the
  // running instance must carry the name the start path gives this service
  // (its raw `name`, or "service" when it has none). When that name does not identify one configured service,
  // the instance must also run in the resolved configured cwd, which defaults
  // to the workspace root, and no other service with that name may match it.
  // Otherwise another service could be stopped.
  const serviceCommands = listWorkspaceServiceCommandDefinitions(input.workspaceRuntime);
  const command = serviceCommands.find((entry) => entry.serviceIndex === input.serviceIndex);
  if (!command) return { scope: "one", runtimeServiceId: null };
  const runtimeName = runtimeServiceNameForCommand(command);
  const otherCommandsWithName = serviceCommands.filter((entry) =>
    entry.serviceIndex !== command.serviceIndex && runtimeServiceNameForCommand(entry) === runtimeName,
  );
  // Whether starting `entry` could have produced `service`: the command and a
  // fixed port must agree, an auto port is always assigned, and the cwd must
  // resolve to the one the instance runs in.
  const couldHaveStarted = (entry: WorkspaceCommandDefinition, service: T) => {
    if (!service.cwd || scoreWorkspaceRuntimeServiceMatch(entry, { ...service, configIndex: null }) < 0) return false;
    if (isRecord(entry.rawConfig.port) && entry.rawConfig.port.type === "auto" && service.port == null) return false;
    const expectedCwd = resolveExpectedServiceCwd(entry, service, input);
    return Boolean(expectedCwd && sameCwd(service.cwd, expectedCwd));
  };
  // A running instance's `configIndex` is not stored: read models infer it
  // with a matcher that accepts a shared command, so it is not trusted here.
  const candidates = (input.runtimeServices ?? []).filter((service) => {
    if (service.serviceName !== runtimeName) return false;
    if (otherCommandsWithName.length === 0) return true;
    // When another configured service could also have started this instance
    // (for example it differs only in env), the match is ambiguous, so leave
    // the instance alone.
    return couldHaveStarted(command, service)
      && !otherCommandsWithName.some((entry) => couldHaveStarted(entry, service));
  });
  const runtimeService = matchWorkspaceRuntimeServiceToCommand(
    command,
    candidates.map((service) => ({ ...service, configIndex: null })),
  );
  return { scope: "one", runtimeServiceId: runtimeService?.id ?? null };
}

const ACTIVE_RUNTIME_SERVICE_STATUSES = new Set(["provisioning", "starting", "running"]);

/**
 * Counts the runtime services that are still active after a stop resolved by
 * `resolveRuntimeServiceStopTarget`. Services that were already stopped are
 * not counted.
 */
export function countRuntimeServicesActiveAfterStop(
  runtimeServices: Array<{ id: string; status?: string | null }> | null | undefined,
  stopTarget: { scope: "all" } | { scope: "one"; runtimeServiceId: string | null },
): number {
  if (stopTarget.scope === "all") return 0;
  return (runtimeServices ?? []).filter((service) =>
    service.id !== stopTarget.runtimeServiceId
    && ACTIVE_RUNTIME_SERVICE_STATUSES.has(service.status ?? ""),
  ).length;
}
