/**
 * Tool-specific output filters (TypeScript equivalent of jq filters).
 *
 * Each filter takes a parsed JSON value and extracts the most relevant fields,
 * returning a condensed Record or null if extraction fails.
 */

type FilterFn = (data: unknown) => Record<string, unknown> | null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

function safeNumber(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// kubectl get pods — extract name, status, restarts
// ---------------------------------------------------------------------------
const kubectlGetPodsFilter: FilterFn = (data) => {
  if (!isRecord(data) || !Array.isArray(data.items)) return null;
  const pods = (data.items as unknown[]).slice(0, 20).map((item) => {
    if (!isRecord(item)) return null;
    const meta = isRecord(item.metadata) ? item.metadata : {};
    const status = isRecord(item.status) ? item.status : {};
    const containers = Array.isArray(status.containerStatuses) ? status.containerStatuses : [];
    const firstContainer = isRecord(containers[0]) ? containers[0] : {};
    return {
      name: safeString(meta.name),
      phase: safeString(status.phase),
      restarts: safeNumber(firstContainer.restartCount),
    };
  }).filter(Boolean);
  return { pods, count: data.items.length };
};

// ---------------------------------------------------------------------------
// npm list / npm ls — extract dependency tree
// ---------------------------------------------------------------------------
const npmListFilter: FilterFn = (data) => {
  if (!isRecord(data)) return null;
  const deps = isRecord(data.dependencies) ? data.dependencies : {};
  const keys = Object.keys(deps).slice(0, 30);
  return {
    name: safeString(data.name),
    version: safeString(data.version),
    topDependencies: keys,
    depCount: Object.keys(deps).length,
  };
};

// ---------------------------------------------------------------------------
// terraform plan output (JSON format)
// ---------------------------------------------------------------------------
const terraformPlanFilter: FilterFn = (data) => {
  if (!isRecord(data)) return null;
  const changes = isRecord(data.resource_changes)
    ? data.resource_changes
    : Array.isArray(data.resource_changes)
      ? {}
      : {};
  const summary = isRecord(data.proposed_unknown) ? {} : {};
  const outputChanges = isRecord(data.output_changes) ? data.output_changes : {};

  let adds = 0, updates = 0, deletes = 0;
  const resourceList = Array.isArray(data.resource_changes) ? data.resource_changes : Object.values(changes);
  for (const r of resourceList) {
    if (!isRecord(r)) continue;
    const actions = isRecord(r.change) && Array.isArray((r.change as Record<string, unknown>).actions)
      ? (r.change as Record<string, unknown>).actions as string[]
      : [];
    if (actions.includes("create")) adds++;
    else if (actions.includes("update")) updates++;
    else if (actions.includes("delete")) deletes++;
  }

  return {
    adds,
    updates,
    deletes,
    outputChanges: Object.keys(outputChanges),
    formatVersion: safeString(data.format_version),
    terraformVersion: safeString(data.terraform_version),
  };
};

// ---------------------------------------------------------------------------
// git log (JSON format from --format=json — not standard, but for --format=%H%n)
// We handle plain git log output in the regex layer instead.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// docker ps JSON output
// ---------------------------------------------------------------------------
const dockerPsFilter: FilterFn = (data) => {
  if (!Array.isArray(data)) return null;
  const containers = data.slice(0, 20).map((item) => {
    if (!isRecord(item)) return null;
    return {
      id: safeString(item.ID).slice(0, 12),
      image: safeString(item.Image),
      status: safeString(item.Status),
      name: safeString(item.Names),
    };
  }).filter(Boolean);
  return { containers, count: data.length };
};

// ---------------------------------------------------------------------------
// Filter registry — keyed by tool name or command pattern
// ---------------------------------------------------------------------------

export interface ToolFilter {
  /** Matches if the tool name OR (for Bash tools) the command starts with this prefix. */
  commandPrefix: string;
  filter: FilterFn;
}

export const TOOL_FILTERS: ToolFilter[] = [
  { commandPrefix: "kubectl get pods", filter: kubectlGetPodsFilter },
  { commandPrefix: "kubectl get pod", filter: kubectlGetPodsFilter },
  { commandPrefix: "npm list", filter: npmListFilter },
  { commandPrefix: "npm ls", filter: npmListFilter },
  { commandPrefix: "terraform plan", filter: terraformPlanFilter },
  { commandPrefix: "terraform show", filter: terraformPlanFilter },
  { commandPrefix: "docker ps", filter: dockerPsFilter },
];

/**
 * Try to apply a tool-specific filter to parsed JSON output.
 * Returns extracted fields or null if no filter matches or extraction fails.
 */
export function applyToolFilter(
  toolName: string,
  command: string,
  parsedOutput: unknown,
): Record<string, unknown> | null {
  const key = `${toolName}:${command}`.toLowerCase();
  for (const { commandPrefix, filter } of TOOL_FILTERS) {
    if (key.includes(commandPrefix.toLowerCase()) || command.toLowerCase().startsWith(commandPrefix.toLowerCase())) {
      try {
        return filter(parsedOutput);
      } catch {
        return null;
      }
    }
  }
  return null;
}
