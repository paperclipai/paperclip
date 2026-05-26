import { spawn } from "node:child_process";
import type {
  OnboardingAdapterOptionsResponse,
  OnboardingRecommendationRequest,
  OnboardingRecommendationResponse,
  OnboardingScanResponse,
} from "@paperclipai/shared";
import {
  onboardingRecommendationResponseSchema,
} from "@paperclipai/shared";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { parseCodexJsonl } from "@paperclipai/adapter-codex-local/server";
import { models as claudeModels } from "@paperclipai/adapter-claude-local";
import { models as codexModels } from "@paperclipai/adapter-codex-local";
import { listAdapterModels } from "../adapters/index.js";

const AGY_LOCAL_MODEL = "gemini-3.5-flash";
const AI_RECOMMENDATION_TIMEOUT_MS = 25_000;

function titleCaseProjectName(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "New Company";
  return normalized
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function workspaceName(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized ? `${normalized}-core` : "primary-workspace";
}

function hasAnyStack(scan: OnboardingScanResponse, stacks: string[]): boolean {
  return stacks.some((stack) => scan.detectedStacks.includes(stack));
}

function recommendMcps(scan: OnboardingScanResponse): OnboardingRecommendationResponse["proposedMcps"] {
  const mcps: OnboardingRecommendationResponse["proposedMcps"] = [
    { name: "github-mcp-server", status: "recommended" },
  ];
  if (hasAnyStack(scan, ["react", "next", "vite"])) {
    mcps.push({ name: "browser-devtools", status: "optional" });
  }
  return mcps;
}

function localAuthChecks(): OnboardingRecommendationResponse["proposedLocalAuthChecks"] {
  return [
    {
      adapterType: "claude_local",
      provider: "anthropic",
      label: "Claude Code",
      authMethod: "local_oauth",
      required: true,
      quotaPolicy: "known",
      setupHint: "Use the existing Claude Code login on this machine. Run `claude login` if the connection is missing.",
    },
    {
      adapterType: "codex_local",
      provider: "openai",
      label: "Codex",
      authMethod: "local_oauth",
      required: true,
      quotaPolicy: "known",
      setupHint: "Use the existing Codex login on this machine. Run `codex login` if the connection is missing.",
    },
    {
      adapterType: "agy_local",
      provider: "google",
      label: "Antigravity",
      authMethod: "local_oauth",
      required: true,
      quotaPolicy: "warn_unknown",
      setupHint:
        "Use the existing Google/Antigravity login on this machine. Run `agy` once if Google sign-in is required.",
    },
  ];
}

function optionalSecrets(scan: OnboardingScanResponse): OnboardingRecommendationResponse["proposedOptionalSecrets"] {
  const secrets: OnboardingRecommendationResponse["proposedOptionalSecrets"] = [
    {
      key: "GITHUB_TOKEN",
      label: "GitHub token",
      category: "source_control",
      status: "recommended",
      storageProvider: "local_encrypted",
      requiredForOnboarding: false,
      reason: "Use only when agents need to call GitHub APIs for issues, pull requests, checks, or release automation.",
      setupHint: "Configure later in Company settings -> Secrets with the local encrypted provider.",
    },
    {
      key: "PROJECT_RUNTIME_ENV",
      label: "Project runtime environment",
      category: "runtime_env",
      status: "recommended",
      storageProvider: "local_encrypted",
      requiredForOnboarding: false,
      reason: "Store application-specific service credentials needed to run local tests, builds, or smoke checks.",
      setupHint: "Add individual runtime keys after onboarding, then bind them to agent or project environment variables.",
    },
    {
      key: "DEPLOYMENT_TOKEN",
      label: "Deployment token",
      category: "deployment",
      status: "optional",
      storageProvider: "local_encrypted",
      requiredForOnboarding: false,
      reason: "Use only after the team decides which preview or production deployment target Paperclip should operate.",
      setupHint: "Configure after the starter audit identifies the deployment provider and minimum required token scope.",
    },
  ];

  if (hasAnyStack(scan, ["node", "typescript", "react", "next", "vite"])) {
    secrets.push({
      key: "WEBHOOK_SIGNING_SECRET",
      label: "Webhook signing secret",
      category: "webhook",
      status: "optional",
      storageProvider: "local_encrypted",
      requiredForOnboarding: false,
      reason: "Useful for local webhook or integration tests when the app verifies inbound webhook signatures.",
      setupHint: "Create only if the audit finds webhook handlers or integration callbacks that need signed requests.",
    });
  }

  return secrets;
}

function fallbackAdapterOptions(): OnboardingAdapterOptionsResponse["adapters"] {
  return [
    {
      adapterType: "claude_local",
      provider: "anthropic",
      label: "Claude Code",
      description: "Planning, governance, writing, and operating decisions through the local Claude session.",
      authLabel: "Use existing Claude login",
      quotaPolicy: "known",
      lockedModel: null,
      models: claudeModels,
    },
    {
      adapterType: "codex_local",
      provider: "openai",
      label: "Codex",
      description: "Engineering implementation and codebase diagnostics through the local Codex session.",
      authLabel: "Use existing Codex login",
      quotaPolicy: "known",
      lockedModel: null,
      models: codexModels,
    },
    {
      adapterType: "agy_local",
      provider: "google",
      label: "Antigravity",
      description: "Research and broad repo exploration through the local Antigravity session.",
      authLabel: "Use existing Google/Antigravity login",
      quotaPolicy: "warn_unknown",
      lockedModel: AGY_LOCAL_MODEL,
      models: [{ id: AGY_LOCAL_MODEL, label: "Gemini 3.5 Flash" }],
    },
  ];
}

export async function getOnboardingAdapterOptions(): Promise<OnboardingAdapterOptionsResponse> {
  const fallback = fallbackAdapterOptions();
  const adapters = await Promise.all(
    fallback.map(async (option) => {
      try {
        const models = await listAdapterModels(option.adapterType);
        return {
          ...option,
          models: option.lockedModel
            ? option.models
            : models.length > 0
              ? models
              : option.models,
        };
      } catch {
        return option;
      }
    }),
  );
  return { adapters };
}

function starterIssueFor(input: OnboardingRecommendationRequest): OnboardingRecommendationResponse["proposedStarterIssue"] {
  const scan = input.scanSummary;
  if (scan.repoKind === "empty") {
    const goal = input.userGoals.trim();
    return {
      title: goal ? "Design the First Approved Product Scaffold" : "Create Approved Scaffold Plan",
      description:
        `Design a build-ready architecture for the empty workspace at ${scan.displayPath}. ` +
        (goal ? `Use this operator focus as the north star: ${goal}. ` : "") +
        "Produce a concise product shape, technical stack recommendation, file/module plan, risk list, and implementation waves. Do not write scaffold files until the plan is approved.",
      assigneeRole: "governance",
    };
  }

  const stackSummary = scan.detectedStacks.length > 0
    ? ` Detected stack: ${scan.detectedStacks.join(", ")}.`
    : "";
  const goalSummary = input.userGoals.trim()
    ? ` Operator goal: ${input.userGoals.trim()}`
    : "";
  return {
    title: "Run Codebase Health Audit and Diagnostics",
    description:
      `Audit the repository at ${scan.displayPath}.${stackSummary}${goalSummary} ` +
      "Build a repo-grounded diagnostics packet for the first MVP implementation wave: current architecture, startup path, failing or missing checks, security-sensitive risks, UX gaps, stale setup docs, and the safest next tasks. " +
      "Return exact file/command evidence, separate confirmed facts from assumptions, and produce a prioritized implementation plan without making code changes.",
    assigneeRole: hasAnyStack(scan, ["node", "typescript", "react", "next", "go", "rust"]) ? "engineer" : "researcher",
  };
}

function deterministicRecommendation(
  input: OnboardingRecommendationRequest,
  options: OnboardingAdapterOptionsResponse["adapters"] = fallbackAdapterOptions(),
  warnings: string[] = [],
): OnboardingRecommendationResponse {
  const scan = input.scanSummary;
  const projectName = scan.boundedSanitizedSummary.projectName;
  const companyBaseName = titleCaseProjectName(projectName);
  const cwd = scan.displayPath.startsWith("~") ? scan.displayPath : scan.displayPath;
  const engineeringRole = hasAnyStack(scan, ["node", "typescript", "react", "next", "go", "rust"])
    ? "engineer"
    : "implementation";

  return {
    recommendationSource: "deterministic",
    recommendationWarnings: warnings,
    proposedCompany: {
      name: `${companyBaseName} Company`,
      description: scan.repoKind === "empty"
        ? `Design and launch ${companyBaseName} from a clean local workspace, starting with an approved architecture and implementation plan.`
        : `Stabilize ${companyBaseName} into a functional MVP by auditing the existing codebase, prioritizing the first implementation wave, and coordinating the local agent squad against concrete evidence.`,
    },
    proposedSquads: [
      {
        name: "CEO",
        role: "governance",
        adapterType: "claude_local",
        model: null,
        permissions: { canCreateAgents: true },
      },
      {
        name: "Engineering Lead",
        role: engineeringRole,
        adapterType: "codex_local",
        model: DEFAULT_CODEX_LOCAL_MODEL,
        permissions: { canCreateIssues: true },
      },
      {
        name: "Research & Insights Lead",
        role: "researcher",
        adapterType: "agy_local",
        model: AGY_LOCAL_MODEL,
        permissions: {},
      },
    ],
    proposedMcps: recommendMcps(scan),
    proposedRequiredSecrets: [],
    proposedOptionalSecrets: optionalSecrets(scan),
    proposedLocalAuthChecks: localAuthChecks(),
    adapterOptions: options,
    proposedProjectWorkspace: {
      name: workspaceName(projectName),
      cwd,
    },
    proposedStarterIssue: starterIssueFor(input),
  };
}

export function recommendOnboardingSetup(input: OnboardingRecommendationRequest): OnboardingRecommendationResponse {
  return deterministicRecommendation(input);
}

function aiRecommendationsEnabled(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  const raw = process.env.PAPERCLIP_ONBOARDING_AI_RECOMMENDATIONS;
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function promptForAiRecommendation(input: OnboardingRecommendationRequest): string {
  const scan = input.scanSummary;
  const safePayload = {
    repoKind: scan.repoKind,
    displayPath: scan.displayPath,
    counts: scan.counts,
    detectedStacks: scan.detectedStacks,
    packageManagers: scan.packageManagers,
    safeManifestIndicators: scan.safeManifestIndicators,
    warnings: scan.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
    boundedSanitizedSummary: scan.boundedSanitizedSummary,
    userGoals: input.userGoals.trim(),
  };

  return [
    "You are the Paperclip first-run onboarding coordinator.",
    "Use only the safe bounded scan summary below. You do not have raw source files.",
    "Return strict JSON only. No markdown. No prose outside JSON.",
    "The JSON shape must be:",
    `{"companyName":string,"operatingFocus":string,"starterIssueTitle":string,"starterIssueDescription":string,"squads":[{"name":string,"role":"governance"|"engineer"|"researcher","adapterType":"claude_local"|"codex_local"|"agy_local","model":string|null}]}`,
    "Constraints:",
    "- Company name should be specific and not generic unless the repo name is generic.",
    "- Operating focus should be actionable and tailored to the repo/user goal.",
    "- Starter issue must be a codebase audit/diagnostics task for brownfield/large repos and a scaffold planning task for empty repos.",
    "- Keep exactly three squads: governance, engineer, researcher.",
    "- Do not ask for provider API keys for Claude, Codex, or Antigravity; Paperclip uses local OAuth sessions for those adapters.",
    "- Project/runtime secrets are optional after company creation and must not block onboarding.",
    `- agy_local must use model ${AGY_LOCAL_MODEL}.`,
    `- codex_local should use ${DEFAULT_CODEX_LOCAL_MODEL}.`,
    "- claude_local model may be null.",
    "",
    JSON.stringify(safePayload, null, 2),
  ].join("\n");
}

function extractFromCodexJsonl(text: string): unknown | null {
  let eventCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (
        typeof event === "object" &&
        event !== null &&
        !Array.isArray(event) &&
        typeof (event as Record<string, unknown>).type === "string"
      ) {
        eventCount += 1;
      }
    } catch {
      return null;
    }
  }
  if (eventCount === 0) return null;

  const parsed = parseCodexJsonl(text);
  if (!parsed.summary) {
    throw new Error(parsed.errorMessage || "Codex recommendation JSONL did not contain an assistant message");
  }
  return extractJsonObject(parsed.summary);
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const codexJsonl = extractFromCodexJsonl(trimmed);
  if (codexJsonl !== null) return codexJsonl;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with extraction below.
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue with balanced extraction below.
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("Codex recommendation did not contain JSON");
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function applyAiPatch(
  fallback: OnboardingRecommendationResponse,
  raw: unknown,
): OnboardingRecommendationResponse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Codex recommendation JSON was not an object");
  }
  const record = raw as Record<string, unknown>;
  const companyName = readString(record, "companyName");
  const operatingFocus = readString(record, "operatingFocus");
  const starterIssueTitle = readString(record, "starterIssueTitle");
  const starterIssueDescription = readString(record, "starterIssueDescription");
  const aiSquads = Array.isArray(record.squads) ? record.squads : [];
  const patchedSquads = fallback.proposedSquads.map((squad) => {
    const match = aiSquads.find((entry): entry is Record<string, unknown> => {
      return typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.role === squad.role;
    });
    if (!match) return squad;
    const adapterType = match.adapterType;
    const model = typeof match.model === "string" ? match.model.trim() : null;
    if (adapterType !== "claude_local" && adapterType !== "codex_local" && adapterType !== "agy_local") return squad;
    return {
      ...squad,
      name: readString(match, "name") ?? squad.name,
      adapterType,
      model: adapterType === "agy_local" ? AGY_LOCAL_MODEL : adapterType === "codex_local" ? (model || DEFAULT_CODEX_LOCAL_MODEL) : model,
    };
  });

  return onboardingRecommendationResponseSchema.parse({
    ...fallback,
    recommendationSource: "ai",
    recommendationWarnings: fallback.recommendationWarnings,
    proposedCompany: {
      name: companyName ?? fallback.proposedCompany.name,
      description: operatingFocus ?? fallback.proposedCompany.description,
    },
    proposedSquads: patchedSquads,
    proposedStarterIssue: {
      ...fallback.proposedStarterIssue,
      title: starterIssueTitle ?? fallback.proposedStarterIssue.title,
      description: starterIssueDescription ?? fallback.proposedStarterIssue.description,
    },
  });
}

async function runCodexAiRecommendation(input: OnboardingRecommendationRequest): Promise<unknown> {
  const prompt = promptForAiRecommendation(input);
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--json", "-"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex recommendation timed out after ${Math.round(AI_RECOMMENDATION_TIMEOUT_MS / 1000)}s`));
    }, AI_RECOMMENDATION_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Codex recommendation exited with code ${code}`));
        return;
      }
      try {
        resolve(extractJsonObject(stdout));
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(prompt);
  });
}

export async function recommendOnboardingSetupWithAi(
  input: OnboardingRecommendationRequest,
): Promise<OnboardingRecommendationResponse> {
  const options = (await getOnboardingAdapterOptions()).adapters;
  const fallback = deterministicRecommendation(input, options);
  if (!aiRecommendationsEnabled()) return fallback;

  try {
    return applyAiPatch(fallback, await runCodexAiRecommendation(input));
  } catch (err) {
    return {
      ...fallback,
      recommendationWarnings: [
        ...fallback.recommendationWarnings,
        `AI recommendation unavailable; using deterministic fallback. ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}
