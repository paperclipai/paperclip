import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readAcpxSidecarProtocolVersion } from "./acpx-sidecar-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  await readFile(
    resolve(root, "protocol/provider-schemas/acpx-sidecar.schema.json"),
    "utf8",
  ),
);
const commands = schema.$defs.command.enum;
const events = schema.$defs.eventType.enum;
const preparationSchema = schema.$defs.providerPreparation;
const quotaCapabilitySchema = schema.$defs.builtinQuotaPoolCapability;
if (preparationSchema?.additionalProperties !== false || quotaCapabilitySchema?.additionalProperties !== false ||
    preparationSchema.properties?.schema?.const !== "paperclip.acpx-provider-preparation.v1" ||
    quotaCapabilitySchema.properties?.schema?.const !== "paperclip.native-quota-failover.v1") {
  throw new Error("ACPX provider preparation and quota capability must be versioned closed contracts");
}
// The sidecar enforces exactly the schema's closed session.open parameter set.
const openParamsSchema = schema.$defs.sessionOpenParams;
if (openParamsSchema?.additionalProperties !== false || !openParamsSchema.properties) {
  throw new Error("ACPX sidecar session.open parameters must be a closed object schema");
}
const openParams = Object.keys(openParamsSchema.properties);
const providerPolicySchema = schema.$defs.providerPolicy;
if (providerPolicySchema?.additionalProperties !== false || !providerPolicySchema.properties) {
  throw new Error("ACPX sidecar providerPolicy must be a closed object schema");
}
const providerPolicyFields = Object.keys(providerPolicySchema.properties);
const providerTurnOrigin = schema.$defs.providerTurnStarted?.properties?.origin?.const;
const providerTurnLostCode = schema.$defs.providerTurnLost?.properties?.code?.const;
if (typeof providerTurnLostCode !== "string" || schema.$defs.providerTurnLost?.additionalProperties !== false) {
  throw new Error("ACPX provider-turn loss diagnostic must be a closed object with a constant code");
}
if (typeof providerTurnOrigin !== "string" || schema.$defs.providerTurnStarted?.additionalProperties !== false) {
  throw new Error("ACPX provider-started turn payload must be a closed object with a constant origin");
}
// Mutation wins for compound provider kinds so create-target attestation and
// the normalized readOnly flag cannot disagree across the sidecar boundary.
const toolOperationPrecedence = [
  ["edit", ["edit", "write", "patch"]],
  ["read", ["read"]],
  ["search", ["search", "grep", "find"]],
  ["list", ["list", "glob"]],
];
const protocolVersion = readAcpxSidecarProtocolVersion(schema);
// The prompt-dispatch journal is a file contract between the sidecar (writer)
// and the Runner (reader after the sidecar is proven gone).
const turnDispatchJournalFile = schema.$defs.turnDispatchJournalFile?.const;
const turnDispatchRecord = schema.$defs.turnDispatchJournalRecord;
const turnDispatchSchema = turnDispatchRecord?.properties?.schema?.const;
const turnDispatchPhases = turnDispatchRecord?.properties?.phase?.enum;
if (
  typeof turnDispatchJournalFile !== "string" ||
  !/^[a-z0-9.-]+$/.test(turnDispatchJournalFile) ||
  typeof turnDispatchSchema !== "string" ||
  JSON.stringify(turnDispatchPhases) !== JSON.stringify(["received", "dispatched"]) ||
  turnDispatchRecord?.additionalProperties !== false
) {
  throw new Error("ACPX turn dispatch journal contract must declare its file, schema and closed phases");
}
const backgroundTasksSchema = schema.$defs.backgroundTasks;
const backgroundLive = backgroundTasksSchema?.properties?.live;
if (
  backgroundTasksSchema?.type !== "object" ||
  backgroundTasksSchema.additionalProperties !== false ||
  JSON.stringify(Object.keys(backgroundTasksSchema.properties ?? {})) !== JSON.stringify(["live"]) ||
  JSON.stringify(backgroundTasksSchema.required) !== JSON.stringify(["live"]) ||
  backgroundLive?.type !== "integer" ||
  backgroundLive.minimum !== 0 ||
  !Number.isSafeInteger(backgroundLive.maximum)
) {
  throw new Error("ACPX background tasks must be a closed object with one non-negative integer live count");
}
const backgroundLiveMaximum = backgroundLive.maximum;
// The Antigravity swarm turn: the provider mode, the envelope it reads and the
// one field that carries the user's request (never task.prompt).
const swarmTurn = schema.$defs.antigravitySwarmTurn;
const swarmMode = swarmTurn?.properties?.providerMode?.const;
const swarmEnvelopeSchema = swarmTurn?.properties?.envelopeSchema?.const;
const swarmRequestSchema = swarmTurn?.properties?.swarmRequest;
if (
  swarmTurn?.additionalProperties !== false ||
  typeof swarmMode !== "string" ||
  typeof swarmEnvelopeSchema !== "string" ||
  swarmRequestSchema?.type !== "string" ||
  swarmRequestSchema.minLength !== 1 ||
  !Number.isSafeInteger(swarmRequestSchema.maxLength)
) {
  throw new Error("ACPX Antigravity swarm turn must declare its mode, envelope schema and bounded request field");
}
// Run facts bound to the selected Google credential for the swarm route.
const swarmFacts = schema.$defs.antigravitySwarmCredentialFacts;
const swarmChannels = swarmFacts?.properties?.swarmChannel?.enum;
const swarmAccountPattern = swarmFacts?.properties?.accountSha256?.pattern;
if (
  swarmFacts?.additionalProperties !== false ||
  !Array.isArray(swarmChannels) || swarmChannels[0] !== "provider_default" ||
  !swarmChannels.every((value) => typeof value === "string" && /^[a-z_]+$/.test(value)) ||
  swarmFacts.properties.accountSha256.type !== "string" || swarmAccountPattern !== "^[a-f0-9]{64}$"
) {
  throw new Error("ACPX Antigravity swarm credential facts must be a closed object with a channel enum (provider_default first) and a sha256 hex account digest");
}
const quote = (value) => JSON.stringify(value);
const rustVariant = (value) =>
  value
    .split(/[._-]/)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");

const typescript = `// Generated by scripts/generate-acpx-sidecar-contract.mjs. Do not edit.\n\nexport const GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION = ${protocolVersion} as const;\nexport const GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE = ${quote(turnDispatchJournalFile)};\nexport const GENERATED_ACPX_TURN_DISPATCH_SCHEMA = ${quote(turnDispatchSchema)};\nexport const GENERATED_ACPX_PROVIDER_TURN_ORIGIN = ${quote(providerTurnOrigin)};\nexport const GENERATED_ACPX_PROVIDER_TURN_LOST_CODE = ${quote(providerTurnLostCode)};\nexport const GENERATED_ACPX_SIDECAR_COMMANDS = [\n${commands.map((value) => `  ${quote(value)},`).join("\n")}\n] as const;\nexport type GeneratedAcpxSidecarCommand =\n  (typeof GENERATED_ACPX_SIDECAR_COMMANDS)[number];\n\nexport const GENERATED_ACPX_SIDECAR_EVENT_TYPES = [\n${events.map((value) => `  ${quote(value)},`).join("\n")}\n] as const;\nexport type GeneratedAcpxSidecarEventType =\n  (typeof GENERATED_ACPX_SIDECAR_EVENT_TYPES)[number];\n\nexport const GENERATED_ACPX_SIDECAR_OPEN_PARAMS = [\n${openParams.map((value) => `  ${quote(value)},`).join("\n")}\n] as const;\n\nexport const GENERATED_ACPX_SIDECAR_PROVIDER_POLICY_FIELDS = [\n${providerPolicyFields.map((value) => `  ${quote(value)},`).join("\n")}\n] as const;\n\nexport const GENERATED_ACPX_BACKGROUND_TASKS_MAX_LIVE = ${backgroundLiveMaximum};\n\nexport const GENERATED_ANTIGRAVITY_SWARM_PROVIDER_MODE = ${quote(swarmMode)};\nexport const GENERATED_ANTIGRAVITY_SWARM_ENVELOPE_SCHEMA = ${quote(swarmEnvelopeSchema)};\nexport const GENERATED_ANTIGRAVITY_SWARM_REQUEST_FIELD = "swarmRequest";\nexport const GENERATED_ANTIGRAVITY_SWARM_REQUEST_MAX_CHARS = ${swarmRequestSchema.maxLength};\nexport const GENERATED_ANTIGRAVITY_SWARM_CREDENTIAL_FACTS_FIELD = "paperclip";\nexport const GENERATED_ANTIGRAVITY_SWARM_CHANNELS = [${swarmChannels.map(quote).join(", ")}] as const;\nexport type GeneratedAntigravitySwarmChannel = (typeof GENERATED_ANTIGRAVITY_SWARM_CHANNELS)[number];\nexport const GENERATED_ANTIGRAVITY_SWARM_DEFAULT_CHANNEL = ${quote(swarmChannels[0])};\nexport const GENERATED_ANTIGRAVITY_SWARM_ACCOUNT_SHA256_PATTERN = /${swarmAccountPattern}/;\n\nexport type GeneratedAntigravitySwarmCredentialFacts = { swarmChannel?: GeneratedAntigravitySwarmChannel; accountSha256?: string };\n\n/** The closed facts, or null when the value is not exactly that shape. */\nexport function readGeneratedAntigravitySwarmCredentialFacts(value: unknown): GeneratedAntigravitySwarmCredentialFacts | null {\n  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;\n  const facts = value as Record<string, unknown>;\n  if (Object.keys(facts).some((key) => key !== "swarmChannel" && key !== "accountSha256")) return null;\n  if (facts.swarmChannel !== undefined && !(GENERATED_ANTIGRAVITY_SWARM_CHANNELS as readonly unknown[]).includes(facts.swarmChannel)) return null;\n  if (facts.accountSha256 !== undefined && (typeof facts.accountSha256 !== "string" || !GENERATED_ANTIGRAVITY_SWARM_ACCOUNT_SHA256_PATTERN.test(facts.accountSha256))) return null;\n  return { ...(facts.swarmChannel === undefined ? {} : { swarmChannel: facts.swarmChannel as GeneratedAntigravitySwarmChannel }), ...(facts.accountSha256 === undefined ? {} : { accountSha256: facts.accountSha256 as string }) };\n}\n\nexport type GeneratedAcpxBackgroundTasks = { live: number };\n\nexport function readGeneratedAcpxBackgroundTasks(value: unknown): GeneratedAcpxBackgroundTasks | null {\n  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;\n  const keys = Object.keys(value);\n  const live = (value as Record<string, unknown>).live;\n  if (keys.length !== 1 || keys[0] !== "live" || typeof live !== "number" || !Number.isInteger(live)) return null;\n  return live >= 0 && live <= GENERATED_ACPX_BACKGROUND_TASKS_MAX_LIVE ? { live } : null;\n}\n\nexport type GeneratedAcpxToolOperation =\n  | "read"\n  | "search"\n  | "list"\n  | "edit"\n  | "execute"\n  | "unknown";\n\nexport const GENERATED_ACPX_TOOL_OPERATION_PRECEDENCE = [\n${toolOperationPrecedence.map(([operation, tokens]) => `  { operation: ${quote(operation)}, tokens: [${tokens.map(quote).join(", ")}] },`).join("\n")}\n] as const;\n\nexport function classifyGeneratedAcpxToolOperation(\n  toolKind: unknown,\n  toolTitle: unknown,\n): GeneratedAcpxToolOperation {\n  const candidate =\n    typeof toolKind === "string" && toolKind\n      ? toolKind\n      : typeof toolTitle === "string"\n        ? toolTitle\n        : "";\n  const normalized = candidate.slice(0, 240).toLowerCase();\n  for (const { operation, tokens } of GENERATED_ACPX_TOOL_OPERATION_PRECEDENCE) {\n    if (tokens.some((token) => normalized.includes(token))) return operation;\n  }\n  return normalized ? "execute" : "unknown";\n}\n`;
const rust = `// Generated by scripts/generate-acpx-sidecar-contract.mjs. Do not edit.\n\npub const GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION: u64 = ${protocolVersion};\npub const GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE: &str = ${quote(turnDispatchJournalFile)};\npub const GENERATED_ACPX_TURN_DISPATCH_SCHEMA: &str = ${quote(turnDispatchSchema)};\npub const GENERATED_ACPX_PROVIDER_TURN_ORIGIN: &str = ${quote(providerTurnOrigin)};\npub const GENERATED_ACPX_PROVIDER_TURN_LOST_CODE: &str = ${quote(providerTurnLostCode)};\npub const GENERATED_ACPX_BACKGROUND_TASKS_MAX_LIVE: u64 = ${backgroundLiveMaximum};\n\npub fn read_generated_acpx_background_tasks(value: &serde_json::Value) -> Option<u64> {\n    let tasks = value.as_object()?;\n    if tasks.len() != 1 {\n        return None;\n    }\n    tasks\n        .get("live")?\n        .as_u64()\n        .filter(|live| *live <= GENERATED_ACPX_BACKGROUND_TASKS_MAX_LIVE)\n}\n\npub const GENERATED_ACPX_TOOL_OPERATION_PRECEDENCE: &[(&str, &[&str])] = &[\n${toolOperationPrecedence.map(([operation, tokens]) => `    (${quote(operation)}, &[${tokens.map(quote).join(", ")}]),`).join("\n")}\n];\n\npub fn classify_generated_acpx_tool_operation(kind: &str, title: &str) -> &'static str {\n    let kind = kind.to_ascii_lowercase();\n    let title = title.to_ascii_lowercase();\n    let candidate = if kind.is_empty() { &title } else { &kind };\n    for (operation, tokens) in GENERATED_ACPX_TOOL_OPERATION_PRECEDENCE {\n        if tokens.iter().any(|token| candidate.contains(token)) {\n            return operation;\n        }\n    }\n    if candidate.is_empty() {\n        "unknown"\n    } else {\n        "execute"\n    }\n}\n\n#[derive(Clone, Copy, Debug, PartialEq, Eq)]\npub enum GeneratedAcpxSidecarCommand {\n${commands.map((value) => `    ${rustVariant(value)},`).join("\n")}\n}\n\nimpl GeneratedAcpxSidecarCommand {\n    pub const fn as_str(self) -> &'static str {\n        match self {\n${commands.map((value) => `            Self::${rustVariant(value)} => ${quote(value)},`).join("\n")}\n        }\n    }\n}\n\n#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]\npub enum GeneratedAcpxSidecarEventType {\n${events.map((value) => `    #[serde(rename = ${quote(value)})]\n    ${rustVariant(value)},`).join("\n")}\n}\n`;

// Classification must inspect the same complete provider value in both
// languages. Display-field truncation happens only after operation selection.
const typescriptWithAsciiLowercase = typescript.replace(
  "export function classifyGeneratedAcpxToolOperation(",
  `function lowercaseGeneratedAcpxAscii(value: string): string {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );
}

export function classifyGeneratedAcpxToolOperation(`,
);
if (typescriptWithAsciiLowercase === typescript) {
  throw new Error("generated TypeScript ACPX classifier export drifted");
}
const typescriptClassifier = typescriptWithAsciiLowercase.replace(
  "candidate.slice(0, 240).toLowerCase()",
  "lowercaseGeneratedAcpxAscii(candidate)",
);
if (typescriptClassifier === typescriptWithAsciiLowercase) {
  throw new Error("generated TypeScript ACPX classifier template drifted");
}

const outputs = [
  [
    resolve(root, "src/drivers/acpx/generated-sidecar-contract.ts"),
    typescriptClassifier + `\nexport const GENERATED_ACPX_PROVIDER_PREPARATION_SCHEMA = ${quote(preparationSchema.properties.schema.const)} as const;\nexport const GENERATED_ACPX_QUOTA_CAPABILITY_SCHEMA = ${quote(quotaCapabilitySchema.properties.schema.const)} as const;\n`,
  ],
  [
    resolve(
      root,
      "runner/crates/runner-core/src/generated_acpx_sidecar_contract.rs",
    ),
    rust + `\npub const GENERATED_ACPX_PROVIDER_PREPARATION_SCHEMA: &str =\n    ${quote(preparationSchema.properties.schema.const)};\npub const GENERATED_ACPX_QUOTA_CAPABILITY_SCHEMA: &str = ${quote(quotaCapabilitySchema.properties.schema.const)};\n`,
  ],
];
if (process.argv.includes("--check")) {
  const stale = [];
  for (const [path, content] of outputs)
    if ((await readFile(path, "utf8").catch(() => "")) !== content)
      stale.push(path);
  if (stale.length > 0) {
    process.stderr.write(
      `Generated ACPX sidecar contracts are stale: ${stale.join(", ")}\n`,
    );
    process.exitCode = 1;
  } else
    process.stdout.write(
      "Generated TypeScript/Rust ACPX sidecar contracts match the schema.\n",
    );
} else {
  await Promise.all(outputs.map(([path, content]) => writeFile(path, content)));
  process.stdout.write("Generated TypeScript/Rust ACPX sidecar contracts.\n");
}
