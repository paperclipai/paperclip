import fs from "node:fs";
import path from "node:path";

// Preflight tunables from the agent-budgeting policy §4.1 / §9. These are
// config-driven and portable (no company-specific values baked in): defaults
// match the policy, and an operator overrides them per-cluster via
// config/agent-budgeting.yaml (resolved through PAPERCLIP_BUDGETING_CONFIG or the
// repo config dir) or the PAPERCLIP_BUDGETING_* env vars. The full per-company
// override merge (policy §9) lands with the runtime gate (ELI-77); this loader
// covers the cluster-default surface the lifecycle endpoints need today.

export interface PreflightConfig {
  // Adapter MUST preflight at/above this estimated micro cost (§4.1).
  estimateThresholdMicros: number;
  // Adapter SHOULD preflight when the binding cap is at/above this percent.
  criticalPreflightPercent: number;
  // Wall-clock budget for a single preflight cap evaluation (§4.1 acceptance).
  evaluationBudgetMillis: number;
  // What preflight returns when the evaluation exceeds its budget.
  evaluationTimeoutAction: "allow_with_metric" | "deny";
}

export interface EnforcementConfig {
  // Billing code applied to auto-created Budget gate issues (§7.2, §9).
  budgetGateBillingCode: string;
  // Master switch for the ELI-77 gate auto-creation behavior (default on for policy).
  autoCreateBudgetGateIssue: boolean;
  // Grace minutes for in-flight work when pause/hard_stop fires.
  defaultGraceMinutes: number;
}

export const DEFAULT_PREFLIGHT_CONFIG: PreflightConfig = {
  estimateThresholdMicros: 50_000,
  criticalPreflightPercent: 80,
  evaluationBudgetMillis: 50,
  evaluationTimeoutAction: "allow_with_metric",
};

function coerceNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function coerceTimeoutAction(
  value: unknown,
  fallback: PreflightConfig["evaluationTimeoutAction"],
): PreflightConfig["evaluationTimeoutAction"] {
  return value === "deny" || value === "allow_with_metric" ? value : fallback;
}

// Minimal extractor for the `preflight:` block of config/agent-budgeting.yaml.
// Avoids a YAML dependency in the server by reading the flat scalar keys the
// policy defines; anything it cannot parse falls back to the policy default.
function readPreflightYamlBlock(text: string): Partial<Record<string, string>> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let inPreflight = false;
  for (const line of lines) {
    if (/^preflight:\s*$/.test(line)) {
      inPreflight = true;
      continue;
    }
    if (inPreflight) {
      // A non-indented, non-comment line ends the block.
      if (/^\S/.test(line) && !/^\s*#/.test(line)) break;
      const m = /^\s+([A-Za-z0-9_]+):\s*([^#]+?)\s*(?:#.*)?$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

function resolveConfigPath(): string | null {
  const explicit = process.env.PAPERCLIP_BUDGETING_CONFIG;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    path.join(process.cwd(), "config", "agent-budgeting.yaml"),
    path.join(process.cwd(), "..", "config", "agent-budgeting.yaml"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function loadPreflightConfig(): PreflightConfig {
  const cfg: PreflightConfig = { ...DEFAULT_PREFLIGHT_CONFIG };

  const configPath = resolveConfigPath();
  if (configPath) {
    try {
      const block = readPreflightYamlBlock(fs.readFileSync(configPath, "utf-8"));
      cfg.estimateThresholdMicros = coerceNumber(block.estimateThresholdMicros, cfg.estimateThresholdMicros);
      cfg.criticalPreflightPercent = coerceNumber(block.criticalAtPercent, cfg.criticalPreflightPercent);
      cfg.evaluationBudgetMillis = coerceNumber(block.evaluationBudgetMillis, cfg.evaluationBudgetMillis);
      cfg.evaluationTimeoutAction = coerceTimeoutAction(block.evaluationTimeoutAction, cfg.evaluationTimeoutAction);
    } catch {
      // Fall back to defaults on any read/parse failure — fail-open to the
      // conservative policy defaults rather than crash the lifecycle endpoints.
    }
  }

  // Env overrides win last (operator escape hatch / tests).
  cfg.estimateThresholdMicros = coerceNumber(
    process.env.PAPERCLIP_BUDGETING_ESTIMATE_THRESHOLD_MICROS,
    cfg.estimateThresholdMicros,
  );
  cfg.evaluationBudgetMillis = coerceNumber(
    process.env.PAPERCLIP_BUDGETING_EVAL_BUDGET_MS,
    cfg.evaluationBudgetMillis,
  );
  cfg.evaluationTimeoutAction = coerceTimeoutAction(
    process.env.PAPERCLIP_BUDGETING_EVAL_TIMEOUT_ACTION,
    cfg.evaluationTimeoutAction,
  );

  return cfg;
}

export const DEFAULT_ENFORCEMENT_CONFIG: EnforcementConfig = {
  budgetGateBillingCode: "governance/budget",
  autoCreateBudgetGateIssue: true,
  defaultGraceMinutes: 5,
};

function readEnforcementYamlBlock(text: string): Partial<Record<string, string>> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let inEnforcement = false;
  for (const line of lines) {
    if (/^enforcement:\s*$/.test(line)) {
      inEnforcement = true;
      continue;
    }
    if (inEnforcement) {
      if (/^\S/.test(line) && !/^\s*#/.test(line)) break;
      const m = /^\s+([A-Za-z0-9_]+):\s*([^#]+?)\s*(?:#.*)?$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return fallback;
}

export function loadEnforcementConfig(): EnforcementConfig {
  const cfg: EnforcementConfig = { ...DEFAULT_ENFORCEMENT_CONFIG };

  const configPath = resolveConfigPath();
  if (configPath) {
    try {
      const block = readEnforcementYamlBlock(fs.readFileSync(configPath, "utf-8"));
      if (block.budgetGateBillingCode) cfg.budgetGateBillingCode = block.budgetGateBillingCode;
      cfg.autoCreateBudgetGateIssue = coerceBool(block.autoCreateBudgetGateIssue, cfg.autoCreateBudgetGateIssue);
      cfg.defaultGraceMinutes = coerceNumber(block.defaultGraceMinutes, cfg.defaultGraceMinutes);
    } catch {
      // fall back to defaults (conservative policy)
    }
  }

  // Env overrides (rare, for tests/operators)
  if (process.env.PAPERCLIP_BUDGET_GATE_BILLING_CODE) {
    cfg.budgetGateBillingCode = process.env.PAPERCLIP_BUDGET_GATE_BILLING_CODE;
  }
  cfg.autoCreateBudgetGateIssue = coerceBool(
    process.env.PAPERCLIP_BUDGET_AUTO_GATE,
    cfg.autoCreateBudgetGateIssue,
  );

  return cfg;
}
