import type { WorkspaceCommandDefinition, WorkspaceRuntimeService } from "./types/workspace-runtime.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  command: Pick<WorkspaceCommandDefinition, "serviceIndex" | "name" | "command" | "cwd">,
  runtimeService: Pick<WorkspaceRuntimeService, "configIndex" | "serviceName" | "command" | "cwd">,
) {
  if (command.serviceIndex !== null && runtimeService.configIndex !== null && runtimeService.configIndex !== undefined) {
    return runtimeService.configIndex === command.serviceIndex ? 100 : -1;
  }

  let score = 0;
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
  T extends Pick<WorkspaceRuntimeService, "configIndex" | "serviceName" | "command" | "cwd">,
>(
  command: Pick<WorkspaceCommandDefinition, "serviceIndex" | "name" | "command" | "cwd">,
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
