import { buildHermesRuntimeSkillPrompt } from "../server/src/adapters/registry.js";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:3100";
const DEFAULT_AGENT_ID = "2da2f7bc-9c09-4270-afa3-d62b4097f859";

function argValue(name: string, fallback: string) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function argFlag(name: string) {
  return process.argv.includes(`--${name}`);
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

type SkillsResponse = {
  adapterType: string;
  supported: boolean;
  desiredSkills: string[];
  entries: Array<{
    key: string;
    runtimeName: string;
    desired?: boolean;
    state?: string;
    sourcePath?: string | null;
    required?: boolean;
    requiredReason?: string | null;
  }>;
  warnings?: string[];
};

async function main() {
  const baseUrl = argValue("base-url", process.env.PAPERCLIP_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const agentId = argValue("agent-id", process.env.HERMES_SANDBOX_AGENT_ID ?? DEFAULT_AGENT_ID);

  const health = await getJson<Record<string, unknown>>(`${baseUrl}/api/health`);
  if (health.status !== "ok") fail("Backend health is not ok.");

  const agent = await getJson<AgentResponse>(`${baseUrl}/api/agents/${agentId}`);
  if (agent.adapterType !== "hermes_local") fail(`Agent adapter is ${agent.adapterType}, expected hermes_local.`);
  if (agent.status !== "paused") fail(`Agent status is ${agent.status}, expected paused before authorization.`);
  if (agent.pauseReason !== "manual") fail(`Agent pauseReason is ${agent.pauseReason ?? "none"}, expected manual.`);

  const heartbeat = asRecord(agent.runtimeConfig?.heartbeat);
  if (heartbeat.enabled !== false) fail("Agent heartbeat is not explicitly disabled.");

  const skills = await getJson<SkillsResponse>(`${baseUrl}/api/agents/${agentId}/skills`);
  if (!skills.supported) fail("Hermes skills snapshot is not supported.");
  if (skills.adapterType !== "hermes_local") fail(`Skills adapter is ${skills.adapterType}, expected hermes_local.`);
  if (skills.warnings && skills.warnings.length > 0) fail(`Skills snapshot has warnings: ${skills.warnings.join("; ")}`);

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
  const includeSkillInstructions = argFlag("proof");
  const prompt = buildHermesRuntimeSkillPrompt(
    {
      ...agent.adapterConfig,
      paperclipRuntimeSkills: runtimeSkills,
    },
    { includeSkillInstructions },
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
  if (includeSkillInstructions && includesHiddenSkillMarker) fail("Proof prompt hides detailed skill instructions.");
  if (!includeSkillInstructions && !includesHiddenSkillMarker) fail("Ordinary prompt does not show that detailed skill instructions are hidden.");
  if (!includeSkillInstructions && includesFullSkillBodies) fail("Ordinary prompt includes full SKILL.md instructions.");
  if (includeSkillInstructions && !includesFullSkillBodies) fail("Proof prompt does not include full SKILL.md instructions.");

  const promptTemplate = typeof agent.adapterConfig.promptTemplate === "string" ? agent.adapterConfig.promptTemplate : "";
  const injectionTarget = promptTemplate.trim().length > 0
    ? "taskBody (custom promptTemplate moved into task body; Paperclip issue context fallback enabled)"
    : "taskBody (Paperclip issue context fallback enabled)";

  console.log("Hermes runtime skill prompt read-only preflight");
  console.log(`  Backend: OK (${baseUrl})`);
  console.log(`  Agent: ${agent.name} (${agent.status}/${agent.pauseReason})`);
  console.log(`  Injection target: ${injectionTarget}`);
  console.log(`  Desired skills: ${desired.length}`);
  console.log(`  Detailed skill instructions: ${includeSkillInstructions ? "included for proof check" : "hidden for ordinary task check"}`);
  for (const key of desired) {
    console.log(`    OK ${key}`);
  }
  console.log("  Prompt markers: OK");
  console.log("  Result: READY FOR NEXT SANDBOX/TEST AUTHORIZATION");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
