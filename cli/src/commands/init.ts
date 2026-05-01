/**
 * paperclipai init — interview-first onboarding wizard
 *
 * Replaces configuration-first onboarding with a short interview that detects
 * the user's environment, asks 3–4 questions, and bootstraps a working
 * Paperclip instance with a real first task in under 5 minutes.
 *
 * Supports --template solo-dev for zero-questions quickstart.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { printPaperclipCliBanner } from "../utils/banner.js";
import { detectAvailableRuntimes, type DetectedRuntime } from "../utils/detect-runtimes.js";
import { configExists } from "../config/store.js";
import { resolveConfigPath } from "../config/store.js";
import { onboard } from "./onboard.js";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type OnboardingUseCase = "startup" | "agency" | "internal_team" | "personal";
export type CompanySource = "new" | "existing";
export type DeployProfile = "local_solo" | "shared_private" | "shared_public";
export type AutonomyMode = "hands_on" | "hybrid" | "full_auto";

export interface OnboardingProfile {
  useCase: OnboardingUseCase;
  companySource: CompanySource;
  deployProfile: DeployProfile;
  autonomyMode: AutonomyMode;
  primaryRuntime: DetectedRuntime | null;
}

export type InitTemplate = "solo-dev" | null;

type InitOptions = {
  config?: string;
  dataDir?: string;
  template?: string;
  yes?: boolean;
  run?: boolean;
};

// ────────────────────────────────────────────────────────────────────────────
// Template presets
// ────────────────────────────────────────────────────────────────────────────

const SOLO_DEV_PRESET: Omit<OnboardingProfile, "primaryRuntime"> = {
  useCase: "personal",
  companySource: "new",
  deployProfile: "local_solo",
  autonomyMode: "full_auto",
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function mapDeployProfileToOnboardArgs(profile: OnboardingProfile): {
  deploymentMode: string;
  deploymentExposure: string;
} {
  switch (profile.deployProfile) {
    case "local_solo":
      return { deploymentMode: "local_trusted", deploymentExposure: "private" };
    case "shared_private":
      return { deploymentMode: "authenticated", deploymentExposure: "private" };
    case "shared_public":
      return { deploymentMode: "authenticated", deploymentExposure: "public" };
  }
}

function buildLlmHandoffPrompt(profile: OnboardingProfile, baseUrl: string): string {
  const runtimeLabel = profile.primaryRuntime?.label ?? "your agent runtime";
  const useCaseLabels: Record<OnboardingUseCase, string> = {
    startup: "an early-stage startup",
    agency: "an agency or service team",
    internal_team: "an internal engineering team",
    personal: "a personal / solo project",
  };
  const autonomyLabels: Record<AutonomyMode, string> = {
    hands_on: "hands-on (human reviews most decisions)",
    hybrid: "hybrid (agents act, human approves key decisions)",
    full_auto: "full-auto (agents run autonomously within budget)",
  };

  return [
    `# Paperclip Setup Handoff`,
    ``,
    `You are helping set up a new Paperclip instance at ${baseUrl}.`,
    `The user completed the interview wizard with these answers:`,
    ``,
    `- Use case: ${useCaseLabels[profile.useCase]}`,
    `- Company: ${profile.companySource === "new" ? "new (to be created)" : "existing"}`,
    `- Deployment: ${profile.deployProfile.replace(/_/g, " ")}`,
    `- Autonomy: ${autonomyLabels[profile.autonomyMode]}`,
    `- Primary runtime: ${runtimeLabel}`,
    ``,
    `## Your tasks`,
    ``,
    `1. Create a new company with a fitting name for the use case above.`,
    `2. Create a company goal that reflects what the user is building.`,
    `3. Hire a CEO agent (adapter: ${profile.primaryRuntime?.type ?? "claude_local"}).`,
    `4. Hire a founding engineer agent to handle technical work.`,
    `5. Create a first task assigned to the CEO: "Define company roadmap and hire first team".`,
    ``,
    `Use the Paperclip API at ${baseUrl}/api. Board auth is handled by your local session.`,
    ``,
    `Paperclip skill docs: run \`paperclipai help\` or check ~/.claude/skills/paperclip/.`,
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Interview
// ────────────────────────────────────────────────────────────────────────────

async function runInterview(availableRuntimes: DetectedRuntime[]): Promise<OnboardingProfile | null> {
  const useCase = await p.select({
    message: "What are you building?",
    options: [
      { value: "startup", label: "Startup", hint: "Product or company in early stages" },
      { value: "agency", label: "Agency / service team", hint: "Client work or a service business" },
      { value: "internal_team", label: "Internal team", hint: "Tools, infra, or ops for a larger org" },
      { value: "personal", label: "Personal project", hint: "Solo exploration or personal tooling" },
    ],
    initialValue: "startup",
  });
  if (p.isCancel(useCase)) return null;

  const companySource = await p.select({
    message: "Is this a new Paperclip company or an existing one?",
    options: [
      { value: "new", label: "New company", hint: "I'm starting fresh" },
      { value: "existing", label: "Existing company", hint: "The company already exists in Paperclip" },
    ],
    initialValue: "new",
  });
  if (p.isCancel(companySource)) return null;

  const deployProfile = await p.select({
    message: "How are you running Paperclip?",
    options: [
      {
        value: "local_solo",
        label: "Local solo",
        hint: "One machine, just me — recommended for getting started",
      },
      {
        value: "shared_private",
        label: "Shared private",
        hint: "My team on a private network (login required)",
      },
      {
        value: "shared_public",
        label: "Public cloud",
        hint: "Publicly accessible deployment",
      },
    ],
    initialValue: "local_solo",
  });
  if (p.isCancel(deployProfile)) return null;

  const autonomyMode = await p.select({
    message: "How much autonomy should your agents have?",
    options: [
      {
        value: "full_auto",
        label: "Full auto",
        hint: "Agents run independently within budget limits",
      },
      {
        value: "hybrid",
        label: "Hybrid",
        hint: "Agents act; I approve key decisions and hires",
      },
      {
        value: "hands_on",
        label: "Hands-on",
        hint: "I review most agent actions",
      },
    ],
    initialValue: "full_auto",
  });
  if (p.isCancel(autonomyMode)) return null;

  // Pick primary runtime
  let primaryRuntime: DetectedRuntime | null = null;
  if (availableRuntimes.length === 0) {
    p.log.warn(
      "No agent runtimes detected. Install Claude Code, Codex, or another supported runtime before hiring agents.",
    );
  } else if (availableRuntimes.length === 1) {
    primaryRuntime = availableRuntimes[0]!;
    p.log.info(`Using detected runtime: ${pc.cyan(primaryRuntime.label)}`);
  } else {
    const runtimeChoice = await p.select({
      message: "Which agent runtime should be used for your first agents?",
      options: availableRuntimes.map((r) => ({
        value: r.type,
        label: r.label,
        hint: r.version ?? "detected",
      })),
      initialValue: availableRuntimes[0]!.type,
    });
    if (p.isCancel(runtimeChoice)) return null;
    primaryRuntime = availableRuntimes.find((r) => r.type === (runtimeChoice as string)) ?? null;
  }

  return {
    useCase: useCase as OnboardingUseCase,
    companySource: companySource as CompanySource,
    deployProfile: deployProfile as DeployProfile,
    autonomyMode: autonomyMode as AutonomyMode,
    primaryRuntime,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Main command
// ────────────────────────────────────────────────────────────────────────────

export async function initCommand(opts: InitOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclipai init ")));

  // ── Template shortcut ────────────────────────────────────────────────────
  const template = (opts.template?.toLowerCase() ?? null) as InitTemplate | null;
  const isTemplateMode = template !== null;

  if (isTemplateMode && template !== "solo-dev") {
    p.log.error(`Unknown template: ${pc.yellow(template)}. Available templates: ${pc.cyan("solo-dev")}`);
    process.exit(1);
  }

  if (template === "solo-dev") {
    p.log.message(pc.dim("Template: solo-dev — applying preset (local solo, full auto, new company)"));
  }

  // ── Runtime detection ────────────────────────────────────────────────────
  const detectSpinner = p.spinner();
  detectSpinner.start("Detecting installed agent runtimes…");
  let availableRuntimes: DetectedRuntime[] = [];
  try {
    availableRuntimes = await detectAvailableRuntimes();
    if (availableRuntimes.length > 0) {
      detectSpinner.stop(
        `Detected: ${availableRuntimes.map((r) => pc.cyan(r.label)).join(", ")}`,
      );
    } else {
      detectSpinner.stop(pc.yellow("No agent runtimes detected — you can install one later"));
    }
  } catch {
    detectSpinner.stop(pc.yellow("Runtime detection failed — continuing without it"));
  }

  // ── Existing config check ────────────────────────────────────────────────
  if (configExists(opts.config)) {
    p.log.message(
      pc.dim(
        "Existing Paperclip config detected. `paperclipai init` will hand off to `paperclipai onboard` to preserve it.",
      ),
    );
    await onboard({ config: opts.config, run: opts.run, yes: opts.yes });
    return;
  }

  // ── Build onboarding profile ─────────────────────────────────────────────
  let profile: OnboardingProfile;

  if (template === "solo-dev") {
    const primaryRuntime = availableRuntimes[0] ?? null;
    profile = { ...SOLO_DEV_PRESET, primaryRuntime };
    p.log.message(
      primaryRuntime
        ? pc.dim(`Primary runtime: ${primaryRuntime.label}`)
        : pc.yellow("No runtime detected — skipping runtime selection"),
    );
  } else if (opts.yes) {
    const primaryRuntime = availableRuntimes[0] ?? null;
    profile = { ...SOLO_DEV_PRESET, primaryRuntime };
    p.log.message(pc.dim("`--yes` set: using solo-dev defaults."));
  } else {
    p.log.message(
      pc.dim(
        "Answer a few questions to get the right setup for your situation. (Use --template solo-dev to skip.)",
      ),
    );
    const interviewed = await runInterview(availableRuntimes);
    if (!interviewed) {
      p.cancel("Setup cancelled.");
      return;
    }
    profile = interviewed;
  }

  // ── Show profile summary ─────────────────────────────────────────────────
  const { deploymentMode, deploymentExposure } = mapDeployProfileToOnboardArgs(profile);

  p.note(
    [
      `Use case:   ${profile.useCase.replace(/_/g, " ")}`,
      `Company:    ${profile.companySource}`,
      `Deploy:     ${profile.deployProfile.replace(/_/g, " ")}`,
      `Autonomy:   ${profile.autonomyMode.replace(/_/g, " ")}`,
      `Runtime:    ${profile.primaryRuntime?.label ?? "(none detected)"}`,
    ].join("\n"),
    "Your onboarding profile",
  );

  // ── Configure server environment for onboard ─────────────────────────────
  process.env.PAPERCLIP_DEPLOYMENT_MODE = deploymentMode;
  process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = deploymentExposure;

  // ── Hand off to onboard for infrastructure setup ─────────────────────────
  p.log.step("Setting up Paperclip infrastructure…");
  await onboard({
    config: opts.config,
    run: false,
    yes: true,
    invokedByRun: true,
  });

  // ── Generate LLM handoff prompt ──────────────────────────────────────────
  const configPath = resolveConfigPath(opts.config);
  const baseUrl = `http://127.0.0.1:3100`;
  const handoffPrompt = buildLlmHandoffPrompt(profile, baseUrl);

  // Write onboarding.txt next to config
  const { join, dirname } = await import("node:path");
  const handoffPath = join(dirname(configPath), "onboarding.txt");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(handoffPath, handoffPrompt, "utf8");
    p.log.success(`LLM handoff prompt written to ${pc.dim(handoffPath)}`);
  } catch {
    p.log.warn("Could not write onboarding.txt — continuing");
  }

  // ── Print next steps ──────────────────────────────────────────────────────
  const runtimeHint = profile.primaryRuntime?.command ?? "claude";
  p.note(
    [
      `1. Start Paperclip:          ${pc.cyan("paperclipai run")}`,
      `2. Open the UI:              ${pc.cyan("http://127.0.0.1:3100")}`,
      `3. Complete setup with ${runtimeHint}: ${pc.cyan(`cat ${handoffPath} | ${runtimeHint}`)}`,
      ``,
      pc.dim("Or open the handoff prompt in your agent runtime of choice to"),
      pc.dim("create your first company, agents, and task automatically."),
    ].join("\n"),
    "Next steps",
  );

  // ── Auto-start if --run or --yes ─────────────────────────────────────────
  let shouldRun = opts.run === true;
  if (!shouldRun && !isTemplateMode && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const confirm = await p.confirm({
      message: "Start Paperclip now?",
      initialValue: true,
    });
    if (!p.isCancel(confirm)) shouldRun = confirm;
  }

  if (shouldRun) {
    process.env.PAPERCLIP_OPEN_ON_LISTEN = "true";
    const { runCommand } = await import("./run.js");
    await runCommand({ config: opts.config, repair: true, yes: true });
    return;
  }

  p.outro(pc.green("You're all set! Run `paperclipai run` to start."));
}
