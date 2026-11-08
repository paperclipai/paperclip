import { t as translateAgentPage, useTranslation } from "@/i18n";
import {
  SMOKE_RUN_STEP_PATHS,
  type SmokeRun,
  type SmokeRunStep,
  type SmokeRunStepPath,
  type SmokeRunStepStatus,
} from "@paperclipai/shared";

/**
 * Pure matrix/health helpers for the Smoke Lab tab (PAP-13347 / S2, plan §D3).
 * Kept free of React so the cell/health logic is unit-testable on its own.
 *
 * The integration matrix is the plan §3 table: rows are the seven paths
 * (P1–P7), columns are the PAP-12373 governed lifecycle. Each recorded step
 * carries a free-form `scenarioStep` string owned by the S4 catalog; we fold it
 * onto a canonical lifecycle stage by keyword so the matrix stays a stable
 * 7×8 grid no matter how S4 words its steps. Raw `scenarioStep` values are
 * always shown verbatim in the run drill-down, so nothing is hidden.
 */

export const SMOKE_PATH_LABELS: Record<SmokeRunStepPath, { title: string; detail: string }> = {
  P1: { get title() { return translateAgentPage("agents:remote_http_oauth"); }, get detail() { return translateAgentPage("agents:http_mcp_fixture_behind_the_fake_oauth_provider"); } },
  P2: { get title() { return translateAgentPage("agents:remote_http_api_key"); }, get detail() { return translateAgentPage("agents:http_mcp_fixture_with_a_static_bearer_key"); } },
  P3: { get title() { return translateAgentPage("agents:local_stdio_template"); }, get detail() { return translateAgentPage("agents:stdio_fixture_via_the_runtime_supervisor"); } },
  P4: { get title() { return translateAgentPage("agents:plugin_integration"); }, get detail() { return translateAgentPage("agents:plugin_provided_catalog_entry_install_flow"); } },
  P5: { get title() { return translateAgentPage("agents:paste_a_config_import"); }, get detail() { return translateAgentPage("agents:prosumer_import_via_advanced_setup"); } },
  P6: { get title() { return translateAgentPage("agents:token_broker_gateway"); }, get detail() { return translateAgentPage("agents:run_scoped_connection_token_ttl_scope_checks"); } },
  P7: { get title() { return translateAgentPage("agents:governance_surfaces"); }, get detail() { return translateAgentPage("agents:profiles_ask_first_rules_quarantine"); } },
};

export interface LifecycleStage {
  key: string;
  label: string;
  /** Keywords (lowercased) that fold a `scenarioStep` onto this stage. */
  match: string[];
}

/** The PAP-12373 governed lifecycle, in order (plan §3). */
export const LIFECYCLE_STAGES: LifecycleStage[] = [
  { key: "connect", get label() { return translateAgentPage("agents:connect"); }, match: ["connect", "oauth", "login", "auth"] },
  { key: "discover", get label() { return translateAgentPage("agents:discover_catalog"); }, match: ["discover", "catalog", "list-tools"] },
  { key: "read", get label() { return translateAgentPage("agents:allowed_read"); }, match: ["read", "allowed"] },
  { key: "write", get label() { return translateAgentPage("agents:ask_first_write"); }, match: ["write", "approve", "ask-first", "askfirst", "review"] },
  { key: "deny", get label() { return translateAgentPage("agents:denied_call"); }, match: ["deny", "denied", "block", "forbidden"] },
  { key: "quarantine", get label() { return translateAgentPage("agents:schema_change_quarantine"); }, match: ["quarantine", "schema"] },
  { key: "revoke", get label() { return translateAgentPage("agents:revoke"); }, match: ["revoke"] },
  { key: "audit", get label() { return translateAgentPage("agents:audit_evidence"); }, match: ["audit", "activity", "evidence"] },
];

/** Fold a free-form scenario step onto a canonical lifecycle stage, or null. */
export function matchLifecycleStage(scenarioStep: string): string | null {
  const s = scenarioStep.toLowerCase();
  for (const stage of LIFECYCLE_STAGES) {
    if (stage.match.some((kw) => s.includes(kw))) return stage.key;
  }
  return null;
}

export type CellStatus = SmokeRunStepStatus | "not-run";

function stepTime(step: SmokeRunStep): number {
  const raw = step.updatedAt ?? step.createdAt;
  const t = new Date(raw as string | Date).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Latest status per (path, stage) cell across the given steps. Later steps win
 * so a matrix always reflects the most recent attempt at each cell.
 */
export function buildSmokeMatrix(steps: SmokeRunStep[]): Map<string, { status: CellStatus; step: SmokeRunStep }> {
  const cells = new Map<string, { status: CellStatus; step: SmokeRunStep }>();
  const ordered = [...steps].sort((a, b) => stepTime(a) - stepTime(b));
  for (const step of ordered) {
    const stage = matchLifecycleStage(step.scenarioStep);
    if (!stage) continue;
    cells.set(`${step.path}::${stage}`, { status: step.status, step });
  }
  return cells;
}

export function cellKey(path: SmokeRunStepPath, stageKey: string): string {
  return `${path}::${stageKey}`;
}

export const SMOKE_PATHS = SMOKE_RUN_STEP_PATHS;

export type SmokeHealth = "green" | "amber" | "red" | "unknown";

/** Overall traffic-light for a run: red on any failure, amber if unfinished/empty. */
export function runHealth(run: SmokeRun | undefined, steps: SmokeRunStep[]): SmokeHealth {
  if (!run) return "unknown";
  if (run.status === "failed") return "red";
  if (steps.some((s) => s.status === "fail")) return "red";
  if (run.summary.partial === true) return "amber";
  if (run.status === "cancelled") return "amber";
  if (run.status === "running") return "amber";
  if (steps.length === 0) return "amber";
  return "green";
}

/** Paths with at least one failing step in the given run. */
export function failingPaths(steps: SmokeRunStep[]): SmokeRunStepPath[] {
  const failed = new Set<SmokeRunStepPath>();
  for (const step of steps) {
    if (step.status === "fail") failed.add(step.path);
  }
  return SMOKE_RUN_STEP_PATHS.filter((p) => failed.has(p));
}
