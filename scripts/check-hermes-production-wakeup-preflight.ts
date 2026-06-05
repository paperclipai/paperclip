import { buildHermesRuntimeSkillPrompt } from "../server/src/adapters/registry.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_BASE_URL = "http://127.0.0.1:3100";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : null;
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function configuredHermesCommand(agent: AgentResponse): string {
  const fromHermesCommand = asString(agent.adapterConfig.hermesCommand).trim();
  if (fromHermesCommand.length > 0) return fromHermesCommand;
  const fromCommand = asString(agent.adapterConfig.command).trim();
  if (fromCommand.length > 0) return fromCommand;
  return "hermes";
}

function commandLooksResolvable(command: string): boolean {
  if (!command) return false;
  if (path.isAbsolute(command)) return fs.existsSync(command);
  if (/[\\/]/.test(command)) {
    return fs.existsSync(path.resolve(process.cwd(), command)) || fs.existsSync(path.resolve(process.cwd(), "..", command));
  }
  try {
    const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
    execFileSync(lookupCommand, [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function requireConcreteId(value: string | null, label: string): string {
  if (!value) fail(`Missing ${label}. Use --${label}=...`);
  if (/^\[[^\]]+\]$/.test(value) || value.includes("[") || value.includes("]")) {
    fail(`${label} is still a placeholder (${value}). Replace it with a real issue or agent id.`);
  }
  return value;
}

function requiresRuntimeCapabilityProof(text: string): boolean {
  return /PAPERCLIP_RUNTIME_CAPABILITY_KEYS|Paperclip runtime capability keys|runtime capability keys|runtime skill keys|exact runtime skill keys|exact keys proof|capability-key proof/i.test(text);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

type AgentResponse = {
  id: string;
  name: string;
  status: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  pauseReason?: string | null;
};

type IssueResponse = {
  id: string;
  publicId?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  companyId?: string | null;
  assigneeAgentId?: string | null;
  checkoutRunId?: string | null;
  executionRunId?: string | null;
};

type SkillsResponse = {
  adapterType: string;
  supported: boolean;
  desiredSkills: string[];
  entries: Array<{
    key: string;
    runtimeName: string;
    state?: string;
    sourcePath?: string | null;
    required?: boolean;
    requiredReason?: string | null;
  }>;
  warnings?: string[];
};

async function main() {
  const baseUrl = (argValue("base-url") ?? process.env.PAPERCLIP_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const issueId = requireConcreteId(argValue("issue-id"), "issue-id");
  const agentId = requireConcreteId(argValue("agent-id"), "agent-id");

  const health = await getJson<Record<string, unknown>>(`${baseUrl}/api/health`);
  if (health.status !== "ok") fail("Backend health is not ok.");

  const agent = await getJson<AgentResponse>(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}`);
  if (agent.adapterType !== "hermes_local") fail(`Agent adapter is ${agent.adapterType}, expected hermes_local.`);
  if (agent.status !== "paused") fail(`Agent status is ${agent.status}, expected paused before authorization.`);
  if (agent.pauseReason !== "manual") fail(`Agent pauseReason is ${agent.pauseReason ?? "none"}, expected manual.`);

  const heartbeat = asRecord(agent.runtimeConfig?.heartbeat);
  if (heartbeat.enabled !== false) fail("Agent heartbeat is not explicitly disabled.");

  const issue = await getJson<IssueResponse>(`${baseUrl}/api/issues/${encodeURIComponent(issueId)}`);
  if (issue.assigneeAgentId && issue.assigneeAgentId !== agent.id) {
    fail(`Issue assigneeAgentId is ${issue.assigneeAgentId}, expected ${agent.id}.`);
  }
  if (issue.checkoutRunId) fail(`Issue has checkoutRunId=${issue.checkoutRunId}; clear it before production wake-up.`);
  if (issue.executionRunId) fail(`Issue has executionRunId=${issue.executionRunId}; clear it before production wake-up.`);

  const activeRun = await getJson<unknown>(`${baseUrl}/api/issues/${encodeURIComponent(issue.id)}/active-run`);
  if (activeRun !== null) fail("Issue has an active run. Do not wake Hermes.");

  const liveRuns = await getJson<unknown[]>(`${baseUrl}/api/issues/${encodeURIComponent(issue.id)}/live-runs`);
  if (liveRuns.length > 0) fail(`Issue has ${liveRuns.length} live run(s). Do not wake Hermes.`);

  const skills = await getJson<SkillsResponse>(`${baseUrl}/api/agents/${encodeURIComponent(agent.id)}/skills`);
  if (!skills.supported) fail("Hermes skills snapshot is not supported.");
  if (skills.adapterType !== "hermes_local") fail(`Skills adapter is ${skills.adapterType}, expected hermes_local.`);
  if (skills.warnings && skills.warnings.length > 0) fail(`Skills snapshot has warnings: ${skills.warnings.join("; ")}`);

  const command = configuredHermesCommand(agent);
  if (!commandLooksResolvable(command)) {
    fail(`Hermes command is not resolvable before wake-up: ${command}. Configure the target agent command/bridge first.`);
  }

  const desiredFromConfig = asStringArray(asRecord(agent.adapterConfig.paperclipSkillSync).desiredSkills);
  const desired = desiredFromConfig.length > 0 ? desiredFromConfig : asStringArray(skills.desiredSkills);
  if (desired.length === 0) fail("No desired Paperclip runtime capability keys were found for this agent.");

  const entriesByKey = new Map(skills.entries.map((entry) => [entry.key, entry]));
  const missing = desired.filter((key) => !entriesByKey.has(key));
  if (missing.length > 0) fail(`Desired skills are missing from runtime entries: ${missing.join(", ")}`);

  const notConfigured = desired.filter((key) => entriesByKey.get(key)?.state !== "configured");
  if (notConfigured.length > 0) fail(`Desired skills are not configured: ${notConfigured.join(", ")}`);

  const runtimeSkills = skills.entries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    source: entry.sourcePath,
    required: entry.required === true,
    requiredReason: entry.requiredReason ?? null,
  }));
  const runtimeCapabilityProofRequired = requiresRuntimeCapabilityProof(
    [issue.title ?? "", issue.description ?? ""].join("\n\n"),
  );
  const prompt = buildHermesRuntimeSkillPrompt(
    {
      ...agent.adapterConfig,
      paperclipRuntimeSkills: runtimeSkills,
    },
    { includeSkillInstructions: runtimeCapabilityProofRequired },
  );

  if (!prompt.includes("## Paperclip Runtime Capability Keys")) fail("Prompt is missing Paperclip Runtime Capability Keys heading.");
  if (!prompt.includes("If, and only if, the assigned issue explicitly asks")) fail("Prompt is missing conditional capability proof requirement.");
  if (!prompt.includes("PAPERCLIP_RUNTIME_CAPABILITY_KEYS")) fail("Prompt is missing machine-readable runtime capability key line.");

  const missingInPrompt = desired.filter((key) => !prompt.includes(`- key: ${key}`));
  if (missingInPrompt.length > 0) fail(`Prompt is missing exact desired keys: ${missingInPrompt.join(", ")}`);

  const includesHiddenSkillMarker = prompt.includes("Detailed skill instructions are hidden for this ordinary task");
  const includesFullSkillBodies = runtimeSkills.some((entry) => {
    if (!entry.source) return false;
    const skillPath = path.join(entry.source, "SKILL.md");
    try {
      const body = fs.readFileSync(skillPath, "utf8").trim();
      const sample = body.slice(0, 160).trim();
      return sample.length > 0 && prompt.includes(sample);
    } catch {
      return false;
    }
  });
  if (runtimeCapabilityProofRequired && includesHiddenSkillMarker) {
    fail("Proof task prompt hides detailed skill instructions.");
  }
  if (!runtimeCapabilityProofRequired && !includesHiddenSkillMarker) {
    fail("Ordinary task prompt does not show that detailed skill instructions are hidden.");
  }
  if (!runtimeCapabilityProofRequired && includesFullSkillBodies) {
    fail("Ordinary task prompt includes full SKILL.md instructions; this can override the issue deliverable.");
  }
  if (runtimeCapabilityProofRequired && !includesFullSkillBodies) {
    fail("Proof task prompt does not include full SKILL.md instructions.");
  }

  console.log("Hermes production wake-up read-only preflight");
  console.log(`  Backend: OK (${baseUrl})`);
  console.log(`  Issue: ${issue.publicId ?? issue.id} ${asString(issue.title) ? `- ${issue.title}` : ""}`);
  console.log(`  Issue status: ${issue.status ?? "unknown"}`);
  console.log(`  Agent: ${agent.name} (${agent.status}/${agent.pauseReason})`);
  console.log(`  Hermes command: OK (${command})`);
  console.log(`  Heartbeat scheduler: disabled for target agent`);
  console.log("  Issue active run: none");
  console.log("  Issue live runs: none");
  console.log(`  Desired runtime capability keys: ${desired.length}`);
  console.log(`  Runtime capability proof required by issue text: ${runtimeCapabilityProofRequired ? "yes" : "no"}`);
  console.log(`  Detailed skill instructions: ${runtimeCapabilityProofRequired ? "included for proof task" : "hidden for ordinary task"}`);
  console.log("  Prompt markers: OK");
  console.log("  Result: READY FOR ONE-TIME PRODUCTION AUTHORIZATION TEMPLATE REVIEW ONLY");
  console.log("");
  console.log("Authorization still required. A valid authorization must replace [ISSUE] and [AGENT] with concrete values.");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
