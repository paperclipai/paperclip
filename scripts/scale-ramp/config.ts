import path from "node:path";
import { parseArgs } from "node:util";
import { resolveTarget, type Target } from "./guard.ts";

export const DEFAULT_STEPS = [10, 50, 100, 200, 500, 1_000];
export const QUALIFIED_OPENCODE_MODEL = "openrouter/deepseek/deepseek-v4-flash-0731";
export const TOKEN_ENV = "PAPERCLIP_SCALE_TOKEN";
export const FALLBACK_TOKEN_ENV = "PAPERCLIP_HOSTED_TOKEN";
export const RESULTS_ROOT = path.join(import.meta.dirname, "results");

export type Mode = "run" | "dry-run" | "cleanup";

export interface Step {
  index: number;
  concurrency: number;
  holdMs: number;
}

export interface Thresholds {
  boardP90Ms: number;
  queueWaitP95Ms: number;
  firstActivityP95Ms: number;
  minConcurrencyRatio: number;
  maxEventLoopUtilization: number;
  runEventLatenessP99Ms: number;
  agentApiPreHandlerP99Ms: number;
}

export interface Pricing {
  modelUsdPerTask: number;
  sandboxUsdPerHour: number;
}

export interface AgentProfile {
  provider: string;
  model: string;
  credentialKey: string | null;
  providerSecretId: string | null;
  adapterOverrides: Record<string, unknown>;
}

export interface Options {
  mode: Mode;
  target: Target;
  label: string;
  outDir: string;
  steps: Step[];
  drainMs: number;
  pollMs: number;
  boardProbeMs: number;
  taskMinutes: number;
  startTimeoutMs: number;
  agentReadyTimeoutMs: number;
  maxTasks: number | null;
  companyId: string | null;
  environmentId: string | null;
  yes: boolean;
  confirmSpendUsd: number | null;
  spendThresholdUsd: number;
  eventSamplePerStep: number;
  thresholds: Thresholds;
  pricing: Pricing;
  profile: AgentProfile;
  metricsUrl: string | null;
}

export interface Secrets {
  token: string | null;
  credential: string | null;
  metricsToken: string | null;
}

const LABEL = /^scale-[a-z0-9-]{3,40}$/;

function number(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
  return value;
}

export function parseSteps(raw: string, holdMs: number): Step[] {
  const values = raw.split(",").map(part => part.trim()).filter(Boolean).map(part => {
    if (!/^[0-9]+$/.test(part)) throw new Error(`--steps takes whole numbers separated by commas, not "${part}"`);
    return Number(part);
  });
  if (!values.length) throw new Error("--steps needs at least one step");
  values.forEach((value, index) => {
    if (value < 1 || value > 5_000) throw new Error("each step must be from 1 to 5000 agents");
    if (index > 0 && value <= values[index - 1]!) throw new Error("--steps must increase");
  });
  return values.map((concurrency, index) => ({ index, concurrency, holdMs }));
}

export function defaultLabel(now: number, random: () => number = Math.random): string {
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, "").toLowerCase();
  return `scale-${stamp}-${Math.floor(random() * 0xffff).toString(16).padStart(4, "0")}`;
}

export function readSecrets(env: NodeJS.ProcessEnv, credentialKey: string | null): Secrets {
  const pick = (value: string | undefined) => value?.trim() ? value.trim() : null;
  return {
    token: pick(env[TOKEN_ENV]) ?? pick(env[FALLBACK_TOKEN_ENV]),
    credential: credentialKey ? pick(env[credentialKey]) : null,
    metricsToken: pick(env.PAPERCLIP_SCALE_METRICS_TOKEN),
  };
}

export function metricsCredential(options: Pick<Options, "metricsUrl" | "target">, secrets: Secrets): string | null {
  if (secrets.metricsToken) return secrets.metricsToken;
  if (!options.metricsUrl) return null;
  try {
    return new URL(options.metricsUrl).origin === options.target.baseUrl ? secrets.token : null;
  } catch {
    return null;
  }
}

function adapterOverrides(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PAPERCLIP_SCALE_ADAPTER_CONFIG must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PAPERCLIP_SCALE_ADAPTER_CONFIG must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv, now: number, random?: () => number): Options {
  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    strict: true,
    options: {
      "base-url": { type: "string" },
      "target-kind": { type: "string" },
      "allow-shared-staging": { type: "boolean" },
      "allow-production-host": { type: "string" },
      steps: { type: "string" },
      "hold-minutes": { type: "string" },
      "drain-minutes": { type: "string" },
      "poll-seconds": { type: "string" },
      "board-probe-seconds": { type: "string" },
      "task-minutes": { type: "string" },
      "start-timeout-minutes": { type: "string" },
      "agent-ready-minutes": { type: "string" },
      "max-tasks": { type: "string" },
      company: { type: "string" },
      environment: { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean" },
      "cleanup-only": { type: "string" },
      yes: { type: "boolean" },
      "confirm-spend": { type: "string" },
      "spend-threshold-usd": { type: "string" },
      "event-sample": { type: "string" },
      "max-queue-wait-p95-seconds": { type: "string" },
      "max-first-activity-p95-seconds": { type: "string" },
      "min-concurrency-ratio": { type: "string" },
    },
  });
  if (values["dry-run"] && values["cleanup-only"]) throw new Error("--dry-run and --cleanup-only exclude each other");
  const mode: Mode = values["cleanup-only"] ? "cleanup" : values["dry-run"] ? "dry-run" : "run";
  const target = resolveTarget({
    baseUrl: values["base-url"] ?? env.PAPERCLIP_SCALE_BASE_URL,
    kind: values["target-kind"],
    allowSharedStaging: values["allow-shared-staging"] === true,
    allowProductionHost: values["allow-production-host"],
  });
  const label = values["cleanup-only"] ?? values.label ?? defaultLabel(now, random);
  if (!LABEL.test(label)) throw new Error("The run id must look like scale-<3 to 40 lowercase letters, digits or dashes>");
  const holdMs = number(values["hold-minutes"], "--hold-minutes", 10, 1, 240) * 60_000;
  const credentialKey = env.PAPERCLIP_SCALE_CREDENTIAL_KEY === "" ? null : env.PAPERCLIP_SCALE_CREDENTIAL_KEY ?? "OPENROUTER_API_KEY";
  const confirmSpend = values["confirm-spend"];
  return {
    mode,
    target,
    label,
    outDir: path.resolve(values.out ?? env.PAPERCLIP_SCALE_RESULTS_DIR ?? RESULTS_ROOT, label),
    steps: parseSteps(values.steps ?? DEFAULT_STEPS.join(","), holdMs),
    drainMs: number(values["drain-minutes"], "--drain-minutes", 15, 0, 240) * 60_000,
    pollMs: number(values["poll-seconds"], "--poll-seconds", 15, 1, 300) * 1_000,
    boardProbeMs: number(values["board-probe-seconds"], "--board-probe-seconds", 10, 1, 300) * 1_000,
    taskMinutes: number(values["task-minutes"], "--task-minutes", 3, 0.5, 120),
    startTimeoutMs: number(values["start-timeout-minutes"], "--start-timeout-minutes", 5, 1, 60) * 60_000,
    agentReadyTimeoutMs: number(values["agent-ready-minutes"], "--agent-ready-minutes", 10, 1, 60) * 60_000,
    maxTasks: values["max-tasks"] === undefined ? null : number(values["max-tasks"], "--max-tasks", 0, 1, 1_000_000),
    companyId: values.company ?? env.PAPERCLIP_SCALE_COMPANY_ID ?? null,
    environmentId: values.environment ?? env.PAPERCLIP_SCALE_ENVIRONMENT_ID ?? null,
    yes: values.yes === true,
    confirmSpendUsd: confirmSpend === undefined ? null : number(confirmSpend, "--confirm-spend", 0, 0, 1_000_000),
    spendThresholdUsd: number(values["spend-threshold-usd"], "--spend-threshold-usd", 5, 0, 1_000_000),
    eventSamplePerStep: number(values["event-sample"], "--event-sample", 50, 0, 10_000),
    thresholds: {
      boardP90Ms: 500,
      queueWaitP95Ms: number(values["max-queue-wait-p95-seconds"], "--max-queue-wait-p95-seconds", 60, 1, 3_600) * 1_000,
      firstActivityP95Ms: number(values["max-first-activity-p95-seconds"], "--max-first-activity-p95-seconds", 60, 1, 3_600) * 1_000,
      minConcurrencyRatio: number(values["min-concurrency-ratio"], "--min-concurrency-ratio", 0.9, 0.1, 1),
      maxEventLoopUtilization: 0.6,
      runEventLatenessP99Ms: 1_000,
      agentApiPreHandlerP99Ms: 100,
    },
    pricing: {
      modelUsdPerTask: number(env.PAPERCLIP_SCALE_MODEL_USD_PER_TASK, "PAPERCLIP_SCALE_MODEL_USD_PER_TASK", 0.02, 0, 100),
      sandboxUsdPerHour: number(env.PAPERCLIP_SCALE_SANDBOX_USD_PER_HOUR, "PAPERCLIP_SCALE_SANDBOX_USD_PER_HOUR", 0.1, 0, 100),
    },
    profile: {
      provider: env.PAPERCLIP_SCALE_PROVIDER ?? "opencode",
      model: env.PAPERCLIP_SCALE_MODEL ?? QUALIFIED_OPENCODE_MODEL,
      credentialKey,
      providerSecretId: env.PAPERCLIP_SCALE_PROVIDER_SECRET_ID ?? null,
      adapterOverrides: adapterOverrides(env.PAPERCLIP_SCALE_ADAPTER_CONFIG),
    },
    metricsUrl: env.PAPERCLIP_SCALE_METRICS_URL ?? null,
  };
}
